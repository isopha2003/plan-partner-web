import { getDb } from "./db";

// ── DB row <-> app-shape mapping helpers ───────────────────────────
// SQLite stores start_time/end_time as "HH:MM:SS" strings, tags/repeat_rule as JSON strings,
// booleans as 0/1 INTEGERs. The UI works with separate startH/startM/endH/endM numbers,
// boolean flags, and parsed JSON objects.
const parseTime = (t: string) => {
  // 손상된 값이 들어오더라도 NaN이 UI로 흘러가지 않게 방어(NaN 시간은 폭 계산·비교
  // 어디에서도 정상적으로 처리되지 않아 캘린더가 조용히 깨짐).
  const [h, m] = (t || "").split(":").map(Number);
  return {
    h: Number.isFinite(h) ? h : 0,
    m: Number.isFinite(m) ? m : 0,
  };
};
const toTime = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const uuid = () => crypto.randomUUID();
// 손상된 JSON을 만나도 전체 fetch가 무너지지 않도록 방어. 예전엔 tags/repeat_rule의
// JSON이 하나라도 깨져 있으면 JSON.parse가 throw해 fetchTemplates/fetchBlocks 전체가
// 실패하면서 로드 에러 화면이 뜨고 앱을 못 쓰게 되던 문제. 손상된 값은 조용히
// null/빈배열로 폴백해 최대한 부분 로드라도 되게 함.
const jsonOrNull = (s: any) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};
const jsonOrEmpty = (s: any) => {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

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

// 블록 템플릿 삭제 — 이 템플릿으로 만들어진 기존 블록은 그대로 남고 template_id만
// NULL이 됨(스키마의 ON DELETE SET NULL). 즉 캘린더에 이미 놓인 블록은 사라지지 않고,
// 태그 조인만 끊어져 template.tags 자동 상속이 없어질 뿐.
export async function deleteTemplateRow(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM block_templates WHERE id = ?", [id]);
}

// 캘린더에서 자동 생성된 템플릿의 이름/색을 나중에 사용자가 블록 제목을 바꾸면
// 함께 갱신할 때 사용. 사용자가 수동으로 만든 템플릿에도 호환됨.
export async function updateTemplateRow(id: string, changes: { title?: string; color?: string; tags?: string[] }) {
  const db = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  if (changes.title !== undefined) { sets.push("title = ?"); vals.push(changes.title); }
  if (changes.color !== undefined) { sets.push("color = ?"); vals.push(changes.color); }
  if (changes.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(changes.tags)); }
  if (sets.length === 0) return;
  vals.push(id);
  await db.execute(`UPDATE block_templates SET ${sets.join(", ")} WHERE id = ?`, vals);
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
  // 시/분은 반드시 짝으로 와야 함 — 한쪽만 오면 toTime이 "HH:undefined:00" 같은
   // 깨진 문자열을 만들고 그 값이 그대로 DB에 저장되면 다음 fetch에서 parseTime이
   // 조용히 0분으로 폴백해 캘린더 배치가 어긋남. 명시적으로 거부.
  if (changes.startH !== undefined || changes.startM !== undefined) {
    if (changes.startH === undefined || changes.startM === undefined) {
      throw new Error("patchBlock: startH와 startM은 반드시 함께 전달해야 함");
    }
    push("start_time", toTime(changes.startH, changes.startM));
  }
  if (changes.endH !== undefined || changes.endM !== undefined) {
    if (changes.endH === undefined || changes.endM === undefined) {
      throw new Error("patchBlock: endH와 endM은 반드시 함께 전달해야 함");
    }
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
  // 캘린더에서 자동 생성된 블록이 뒤늦게 템플릿과 연결될 때 patchBlock으로도 저장이
  // 되어야 함(예전엔 여기서 처리를 안 해서 DB에는 template_id가 NULL로 남아 재시작 후
  // 태그 상속이 끊기던 문제가 있었음).
  if (changes.templateId !== undefined) push("template_id", changes.templateId ?? null);

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

// 같은 반복 그룹의 origin(=사용자가 편집 중인 블록)을 제외한 모든 인스턴스 삭제.
// setBlockRepeat가 규칙을 재저장할 때 사용 — 예전엔 이 정리 없이 새 인스턴스만 insert해서
// 이전 규칙으로 만든 인스턴스가 DB에 그대로 남아 refetch 시 새/구 인스턴스가 함께 나타남.
export async function deleteRepeatInstancesExceptOrigin(repeatGroupId: string, originId: string) {
  const db = await getDb();
  await db.execute(
    "DELETE FROM blocks WHERE repeat_group_id = ? AND id != ?",
    [repeatGroupId, originId]
  );
}

export async function insertBlocksBulk(blocks: any[]) {
  if (blocks.length === 0) return [];
  const db = await getDb();
  const ids: string[] = [];
  // 예전엔 BEGIN TRANSACTION / COMMIT 로 감쌌지만, tauri-plugin-sql 의 커넥션 풀이 여러
  // 커넥션을 쓰기 때문에 트랜잭션이 실제로는 걸리지 않고 오히려 BEGIN 이 잡아둔 커넥션의
  // write-lock 이 길게 유지돼 동시 다른 write 가 "database is locked" 로 실패했음
  // (예: "일정 템플릿 적용" 중 자동 저장이 겹칠 때). 개별 INSERT 로 전환 — 각 INSERT 는
  // SQLite 의 암시적 자동 커밋 트랜잭션이라 원자성은 유지되고, 여러 INSERT 사이 다른
  // write 가 끼어들어도 조금씩 순차 진행. 중간 실패는 호출자가 refetch 로 화해.
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

export async function deleteDeadlineRow(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM deadlines WHERE id = ?", [id]);
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

// ── notes (자유 메모) ─────────────────────────────────────────────
export interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  folderId: string | null;
  sortOrder: number;
  // "새 메모" 직후 아직 사용자가 "저장" 버튼으로 확정하지 않은 상태 = draft.
  // draft 노트는 임시 저장 탭에서만 노출되고, 일반 리스트/폴더 뷰에선 숨김.
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToNote(r: any): Note {
  return {
    id: r.id,
    title: r.title ?? "",
    content: r.content ?? "",
    category: r.category ?? "",
    folderId: r.folder_id ?? null,
    sortOrder: r.sort_order ?? 0,
    isDraft: !!r.is_draft,
    createdAt: r.created_at ?? r.updated_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}

export async function fetchNotes(): Promise<Note[]> {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM notes ORDER BY sort_order, updated_at DESC");
  return rows.map(rowToNote);
}

export async function createNote(n: { title?: string; content?: string; category?: string; folderId?: string | null; isDraft?: boolean }): Promise<Note> {
  const db = await getDb();
  const id = uuid();
  const now = new Date().toISOString();
  // 새 노트는 맨 앞(sort_order 최소값 - 1)에 놓아 리스트 상단에 뜨게 함
  const rows = await db.select<any[]>("SELECT MIN(sort_order) AS m FROM notes");
  const sortOrder = (rows[0]?.m ?? 0) - 1;
  // "새 메모" UI에서 오는 노트는 기본적으로 draft(=사용자가 아직 저장 확정 안 함).
  // 명시적으로 isDraft:false를 넘긴 경우(예: 다른 경로로 즉시 확정 저장)만 non-draft.
  const isDraft = n.isDraft !== false;
  await db.execute(
    `INSERT INTO notes (id, title, content, category, folder_id, sort_order, is_draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, n.title ?? "", n.content ?? "", n.category ?? "", n.folderId ?? null, sortOrder, isDraft ? 1 : 0, now, now]
  );
  return { id, title: n.title ?? "", content: n.content ?? "", category: n.category ?? "", folderId: n.folderId ?? null, sortOrder, isDraft, createdAt: now, updatedAt: now };
}

export async function updateNote(id: string, changes: { title?: string; content?: string; category?: string; folderId?: string | null; isDraft?: boolean }): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, v: any) => { sets.push(`${col} = ?`); vals.push(v); };
  if (changes.title !== undefined) push("title", changes.title);
  if (changes.content !== undefined) push("content", changes.content);
  if (changes.category !== undefined) push("category", changes.category);
  if (changes.folderId !== undefined) push("folder_id", changes.folderId ?? null);
  if (changes.isDraft !== undefined) push("is_draft", changes.isDraft ? 1 : 0);
  push("updated_at", new Date().toISOString());
  vals.push(id);
  await db.execute(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function deleteNote(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM notes WHERE id = ?", [id]);
}

export async function moveNoteToFolder(id: string, folderId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ?",
    [folderId, new Date().toISOString(), id]
  );
}

// 사용자 지정 순서 저장 — orderedIds의 인덱스를 그대로 sort_order로 부여.
// 이전엔 BEGIN TRANSACTION 으로 감쌌지만 tauri-plugin-sql 풀이 여러 커넥션을 써서 실제
// 트랜잭션이 안 걸리는 반면, BEGIN 이 잡은 write-lock 때문에 동시 다른 write 가
// "database is locked" 로 실패했음. 개별 UPDATE 로 전환. 중간에 하나 실패해도 나머지는
// 반영되고 사용자 순서는 부분적으로만 유지 — 다음 로드 때 이상하지만 데이터 유실은 아님.
export async function reorderNotes(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const db = await getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await db.execute("UPDATE notes SET sort_order = ? WHERE id = ?", [i, orderedIds[i]]);
  }
}

// ── note_folders (메모 폴더) ──────────────────────────────────────
export interface NoteFolder {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
}

export async function fetchNoteFolders(): Promise<NoteFolder[]> {
  const db = await getDb();
  const rows = await db.select<any[]>("SELECT * FROM note_folders ORDER BY sort_order, created_at");
  return rows.map(r => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order ?? 0 }));
}

export async function createFolder(f: { name: string; color: string }): Promise<NoteFolder> {
  const db = await getDb();
  const id = uuid();
  const rows = await db.select<any[]>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM note_folders");
  const sortOrder = rows[0]?.n ?? 0;
  await db.execute(
    "INSERT INTO note_folders (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
    [id, f.name, f.color, sortOrder]
  );
  return { id, name: f.name, color: f.color, sortOrder };
}

export async function updateFolder(id: string, changes: { name?: string; color?: string }): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  if (changes.name !== undefined) { sets.push("name = ?"); vals.push(changes.name); }
  if (changes.color !== undefined) { sets.push("color = ?"); vals.push(changes.color); }
  if (sets.length === 0) return;
  vals.push(id);
  await db.execute(`UPDATE note_folders SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function deleteFolder(id: string): Promise<void> {
  const db = await getDb();
  // ON DELETE SET NULL로 소속 노트는 루트(폴더 없음)로 빠짐
  await db.execute("DELETE FROM note_folders WHERE id = ?", [id]);
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
