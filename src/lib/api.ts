import { getDb } from "./db";

// ── DB row <-> app-shape mapping helpers ───────────────────────────
// SQLite stores start_time/end_time as "HH:MM:SS" strings, tags/repeat_rule as JSON strings,
// booleans as 0/1 INTEGERs. The UI works with separate startH/startM/endH/endM numbers,
// boolean flags, and parsed JSON objects.
const parseTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return { h, m };
};
const toTime = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const uuid = () => crypto.randomUUID();
const jsonOrNull = (s: any) => (s ? JSON.parse(s) : null);
const jsonOrEmpty = (s: any) => (s ? JSON.parse(s) : []);

export function rowToBlock(row: any) {
  const start = parseTime(row.start_time);
  const end = parseTime(row.end_time);
  return {
    id: row.id,
    templateId: row.template_id ?? undefined,
    title: row.title,
    color: row.color,
    startH: start.h,
    startM: start.m,
    endH: end.h,
    endM: end.m,
    completed: !!row.completed,
    tags: row._template_tags ? jsonOrEmpty(row._template_tags) : [],
    memo: row.memo ?? "",
    date: row.date,
    repeatGroupId: row.repeat_group_id ?? undefined,
    repeat: jsonOrNull(row.repeat_rule) ?? undefined,
    parentBlockId: row.parent_block_id ?? undefined,
    nextBlockId: row.next_block_id ?? undefined,
  };
}

// ── block_templates ─────────────────────────────────────────────
export async function fetchTemplates() {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM block_templates ORDER BY created_at");
  return rows.map(t => ({ id: t.id, title: t.title, color: t.color, tags: jsonOrEmpty(t.tags) }));
}

export async function createTemplate(t: { title: string; color: string; tags: string[] }) {
  const db = await getDb();
  const id = uuid();
  await db.execute(
    "INSERT INTO block_templates (id, title, color, tags) VALUES (?, ?, ?, ?)",
    [id, t.title, t.color, JSON.stringify(t.tags)]
  );
  return { id, title: t.title, color: t.color, tags: t.tags };
}

// ── blocks ──────────────────────────────────────────────────────
// SELECT 시 template의 tags를 함께 조인해서 UI가 그대로 쓸 수 있게 함
const BLOCK_SELECT = `
  SELECT b.*, t.tags AS _template_tags
  FROM blocks b
  LEFT JOIN block_templates t ON b.template_id = t.id
`;

export async function fetchBlocks() {
  const db = await getDb();
  const rows = await db.select<any[]>(BLOCK_SELECT);
  return rows.map(rowToBlock);
}

async function selectBlockById(id: string) {
  const db = await getDb();
  const rows = await db.select<any[]>(`${BLOCK_SELECT} WHERE b.id = ?`, [id]);
  return rows[0] ? rowToBlock(rows[0]) : null;
}

export async function insertBlock(block: any) {
  const db = await getDb();
  const id = uuid();
  await db.execute(
    `INSERT INTO blocks (
      id, template_id, parent_block_id, title, color, date, start_time, end_time,
      completed, completed_at, memo, next_block_id, repeat_group_id, repeat_rule
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      block.templateId ?? null,
      block.parentBlockId ?? null,
      block.title,
      block.color,
      block.date,
      toTime(block.startH, block.startM),
      toTime(block.endH, block.endM),
      block.completed ? 1 : 0,
      block.completed ? new Date().toISOString() : null,
      block.memo ?? "",
      block.nextBlockId ?? null,
      block.repeatGroupId ?? null,
      block.repeat ? JSON.stringify(block.repeat) : null,
    ]
  );
  const inserted = await selectBlockById(id);
  return inserted ?? { ...block, id, tags: block.tags ?? [] };
}

export async function patchBlock(id: string, changes: any) {
  const db = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, v: any) => { sets.push(`${col} = ?`); vals.push(v); };

  if (changes.title !== undefined) push("title", changes.title);
  if (changes.color !== undefined) push("color", changes.color);
  if (changes.date !== undefined) push("date", changes.date);
  if (changes.startH !== undefined || changes.startM !== undefined) {
    push("start_time", toTime(changes.startH, changes.startM));
  }
  if (changes.endH !== undefined || changes.endM !== undefined) {
    push("end_time", toTime(changes.endH, changes.endM));
  }
  if (changes.completed !== undefined) {
    push("completed", changes.completed ? 1 : 0);
    push("completed_at", changes.completed ? new Date().toISOString() : null);
  }
  if (changes.memo !== undefined) push("memo", changes.memo);
  if (changes.repeatGroupId !== undefined) push("repeat_group_id", changes.repeatGroupId ?? null);
  if (changes.repeat !== undefined) push("repeat_rule", changes.repeat ? JSON.stringify(changes.repeat) : null);
  if (changes.nextBlockId !== undefined) push("next_block_id", changes.nextBlockId ?? null);

  if (sets.length === 0) return;
  vals.push(id);
  await db.execute(`UPDATE blocks SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function deleteBlockRow(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM blocks WHERE id = ?", [id]);
}

export async function deleteBlocksByRepeatGroup(repeatGroupId: string, fromDate: string) {
  const db = await getDb();
  await db.execute(
    "DELETE FROM blocks WHERE repeat_group_id = ? AND date >= ?",
    [repeatGroupId, fromDate]
  );
}

export async function insertBlocksBulk(blocks: any[]) {
  if (blocks.length === 0) return [];
  const db = await getDb();
  const ids: string[] = [];
  // SQLite는 multi-row INSERT를 지원하지만 tauri-plugin-sql의 파라미터 바인딩과 잘 안 맞아서
  // 안전하게 한 건씩 처리 — 개인 앱 규모에선 성능 영향 무시할 만함
  for (const block of blocks) {
    const id = uuid();
    ids.push(id);
    await db.execute(
      `INSERT INTO blocks (
        id, template_id, parent_block_id, title, color, date, start_time, end_time,
        completed, completed_at, memo, next_block_id, repeat_group_id, repeat_rule
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        block.templateId ?? null,
        block.parentBlockId ?? null,
        block.title,
        block.color,
        block.date,
        toTime(block.startH, block.startM),
        toTime(block.endH, block.endM),
        block.completed ? 1 : 0,
        block.completed ? new Date().toISOString() : null,
        block.memo ?? "",
        block.nextBlockId ?? null,
        block.repeatGroupId ?? null,
        block.repeat ? JSON.stringify(block.repeat) : null,
      ]
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.select<any[]>(`${BLOCK_SELECT} WHERE b.id IN (${placeholders})`, ids);
  return rows.map(rowToBlock);
}

// ── deadlines ───────────────────────────────────────────────────
export async function fetchDeadlines() {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM deadlines ORDER BY due_date");
  return rows.map(d => ({ id: d.id, title: d.title, dueDate: d.due_date, completed: !!d.completed }));
}

export async function createDeadline(d: { title: string; dueDate: string }) {
  const db = await getDb();
  const id = uuid();
  await db.execute(
    "INSERT INTO deadlines (id, title, due_date) VALUES (?, ?, ?)",
    [id, d.title, d.dueDate]
  );
  return { id, title: d.title, dueDate: d.dueDate, completed: false };
}

export async function toggleDeadlineRow(id: string, completed: boolean) {
  const db = await getDb();
  await db.execute(
    "UPDATE deadlines SET completed = ?, completed_at = ? WHERE id = ?",
    [completed ? 1 : 0, completed ? new Date().toISOString() : null, id]
  );
}

// ── schedule_templates ─────────────────────────────────────────
export async function fetchScheduleTemplates() {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM schedule_templates ORDER BY created_at");
  return rows.map(t => ({ id: t.id, name: t.name, blocks: JSON.parse(t.blocks) }));
}

export async function createScheduleTemplateRow(name: string, blocks: any[]) {
  const db = await getDb();
  const id = uuid();
  await db.execute(
    "INSERT INTO schedule_templates (id, name, blocks) VALUES (?, ?, ?)",
    [id, name, JSON.stringify(blocks)]
  );
  return { id, name, blocks };
}

export async function deleteScheduleTemplateRow(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM schedule_templates WHERE id = ?", [id]);
}

// ── timer_sessions ──────────────────────────────────────────────
// 한 "세션"은 하나의 연속된 실행 구간. 사용자가 정지 버튼을 누르거나(end_reason: "manual"),
// 뽀모도로 phase 전환 시(역시 "manual"로 마감), 자정 롤오버 등으로 자동 마감됨("auto").
// 세션 끝과 다음 세션 시작 사이의 공백이 "휴식" 구간.
export async function fetchTodaySessions(date: string) {
  const db = await getDb();
  const rows = await db.select<any[]>(
    "SELECT * FROM timer_sessions WHERE date = ? ORDER BY started_at",
    [date]
  );
  return rows.map(s => ({
    id: s.id,
    date: s.date,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    endReason: s.end_reason as "manual" | "auto" | "ongoing",
  }));
}

export async function startTimerSession(date: string) {
  const db = await getDb();
  const id = uuid();
  const startedAt = new Date().toISOString();
  await db.execute(
    "INSERT INTO timer_sessions (id, date, started_at, end_reason) VALUES (?, ?, ?, 'ongoing')",
    [id, date, startedAt]
  );
  return { id, date, startedAt, endedAt: null, endReason: "ongoing" as const };
}

export async function endTimerSession(id: string, endReason: "manual" | "auto") {
  const db = await getDb();
  await db.execute(
    "UPDATE timer_sessions SET ended_at = ?, end_reason = ? WHERE id = ?",
    [new Date().toISOString(), endReason, id]
  );
}

// 특정 날짜의 모든 세션을 통째로 삭제 — 오늘 기록 초기화 기능이 호출
export async function deleteTodaySessions(date: string) {
  const db = await getDb();
  await db.execute("DELETE FROM timer_sessions WHERE date = ?", [date]);
}

// 지금까지 종료된 모든 세션을 날짜별로 집계 (초 단위). 캘린더/통계에서 과거 날짜의
// 집중 시간을 표시할 때 사용. julianday 차이로 세션당 지속 시간을 초로 뽑고 date로 그룹.
// 오늘 진행 중인 세션은 UI에서 실시간 timerSec으로 별도 처리되므로 여기서는 종료된 것만.
export async function fetchFocusSecByDate(): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT date, SUM((julianday(ended_at) - julianday(started_at)) * 86400) AS focus_sec
       FROM timer_sessions
      WHERE ended_at IS NOT NULL
      GROUP BY date`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.date] = Math.max(0, Math.round(Number(r.focus_sec) || 0));
  return out;
}

// ── checklist_items (체크리스트형 자식 — 무제한 중첩) ─────────────
export async function fetchChecklistItems(blockId: string) {
  const db = await getDb();
  const rows = await db.select<any[]>(
    "SELECT * FROM checklist_items WHERE block_id = ? ORDER BY created_at",
    [blockId]
  );
  return rows.map(r => ({
    id: r.id,
    blockId: r.block_id,
    parentItemId: r.parent_item_id ?? undefined,
    text: r.text,
    completed: !!r.completed,
    sortOrder: r.sort_order,
  }));
}

export async function createChecklistItem(blockId: string, text: string, parentItemId?: string) {
  const db = await getDb();
  const id = uuid();
  await db.execute(
    "INSERT INTO checklist_items (id, block_id, parent_item_id, text) VALUES (?, ?, ?, ?)",
    [id, blockId, parentItemId ?? null, text]
  );
  return { id, blockId, parentItemId, text, completed: false, sortOrder: 0 };
}

export async function toggleChecklistItemRow(id: string, completed: boolean) {
  const db = await getDb();
  await db.execute(
    "UPDATE checklist_items SET completed = ? WHERE id = ?",
    [completed ? 1 : 0, id]
  );
}

export async function deleteChecklistItemRow(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM checklist_items WHERE id = ?", [id]);
}
