// 백업 및 JSON 내보내기/가져오기
//
// - 자동 백업: 앱 시작 시 하루 1회, SQLite `VACUUM INTO`로 DB를 %APPDATA%/…/backups/에
//   타임스탬프 이름으로 스냅샷. 열린 상태에서도 안전한 일관 복사본이 만들어짐.
//   최근 10개만 유지하고 나머지는 삭제(rotate).
// - JSON 내보내기: 모든 테이블을 읽어 스키마 버전을 붙여 파일 저장.
// - JSON 가져오기: 파일을 파싱해 버전 확인 후 트랜잭션 안에서 모든 테이블을 지우고 다시 채움.

import { getDb } from "./db";
import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, remove, writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { save, open } from "@tauri-apps/plugin-dialog";

const BACKUP_DIR_NAME = "backups";
const BACKUP_KEEP = 10;
const LAST_BACKUP_KEY = "last_auto_backup_ts";
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EXPORT_SCHEMA_VERSION = 1;
// export/import 대상 테이블 — 스키마 순서상 FK 부모가 먼저 오도록 정렬(가져오기 시 삽입 순서로 사용).
const TABLES = [
  "block_templates",
  "note_folders",
  "blocks",
  "checklist_items",
  "deadlines",
  "todos",
  "schedule_templates",
  "timer_sessions",
  "notes",
] as const;

type TableName = typeof TABLES[number];

// 각 테이블별로 허용하는 컬럼 화이트리스트 — db.ts의 SCHEMA와 일치해야 함.
// import 시 백업 파일에서 온 임의의 키를 SQL에 그대로 넣지 않도록 이 목록으로 교차 필터.
// (개인용 로컬 앱이라 위험도는 낮지만, 손상·조작된 백업 파일로 스키마 이상 상태에
//  빠지는 걸 근본적으로 차단.)
const TABLE_COLUMNS: Record<TableName, readonly string[]> = {
  block_templates: ["id", "title", "color", "tags", "created_at"],
  note_folders:    ["id", "name", "color", "sort_order", "created_at"],
  blocks:          ["id", "template_id", "parent_block_id", "title", "color", "date", "start_time", "end_time", "completed", "completed_at", "memo", "next_block_id", "repeat_group_id", "repeat_rule", "created_at"],
  checklist_items: ["id", "block_id", "parent_item_id", "text", "completed", "sort_order", "created_at"],
  deadlines:       ["id", "title", "due_date", "completed", "completed_at", "created_at"],
  todos:           ["id", "title", "date", "end_date", "completed", "completed_at", "sort_order", "created_at"],
  schedule_templates: ["id", "name", "blocks", "created_at"],
  timer_sessions:  ["id", "date", "started_at", "ended_at", "end_reason", "created_at"],
  notes:           ["id", "title", "content", "category", "folder_id", "sort_order", "is_draft", "created_at", "updated_at"],
};

// 백업 파일명 타임스탬프. ms 까지 붙여 같은 초 안에 두 번 눌러도 파일명이 겹치지 않게.
// VACUUM INTO는 대상 파일이 이미 있으면 실패하므로 초 단위 해상도만으론 rapid click 시
// 충돌이 남 → ms 자리로 확실히 유니크하게 만듦.
function tsStamp(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ms}`;
}

async function ensureBackupDir(): Promise<string> {
  const base = await appDataDir();
  const dir = await join(base, BACKUP_DIR_NAME);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

// SQLite의 VACUUM INTO는 열린 DB에서도 안전한 일관 스냅샷을 만들어준다.
// 파일 존재 시 실패하므로 타임스탬프로 유니크하게 만듦.
async function writeBackupSnapshot(): Promise<string> {
  const dir = await ensureBackupDir();
  const path = await join(dir, `planner-${tsStamp()}.db`);
  const db = await getDb();
  // 경로에 backslash가 있으면 SQLite 문자열 리터럴에서 이스케이프 문제가 생기므로 forward slash로.
  const sqlPath = path.replace(/\\/g, "/").replace(/'/g, "''");
  await db.execute(`VACUUM INTO '${sqlPath}'`);
  return path;
}

async function rotateBackups(): Promise<void> {
  const dir = await ensureBackupDir();
  const entries = await readDir(dir);
  const files = entries
    .filter(e => e.isFile && e.name.startsWith("planner-") && e.name.endsWith(".db"))
    .map(e => e.name)
    .sort(); // 이름에 시간이 들어있어 사전순 = 시간순
  const toRemove = files.slice(0, Math.max(0, files.length - BACKUP_KEEP));
  for (const name of toRemove) {
    try { await remove(await join(dir, name)); } catch (e) { console.warn("backup rotate remove failed", name, e); }
  }
}

export async function createBackupNow(): Promise<string> {
  const path = await writeBackupSnapshot();
  try { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch {}
  await rotateBackups();
  return path;
}

// 앱 시작 시 호출. 마지막 백업이 24h 미만이면 스킵. 실패는 조용히 무시(사용자 흐름 방해 X).
export async function runAutoBackupIfNeeded(): Promise<void> {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    const last = raw ? Number(raw) : 0;
    if (Number.isFinite(last) && Date.now() - last < AUTO_BACKUP_INTERVAL_MS) return;
    await createBackupNow();
  } catch (e) {
    console.error("auto backup failed", e);
  }
}

export function getLastBackupTimestamp(): number | null {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

// ── JSON 내보내기/가져오기 ─────────────────────────────────────

async function dumpAllTables(): Promise<Record<TableName, any[]>> {
  const db = await getDb();
  const out = {} as Record<TableName, any[]>;
  for (const table of TABLES) {
    out[table] = await db.select<any[]>(`SELECT * FROM ${table}`);
  }
  return out;
}

export async function exportToJson(): Promise<string | null> {
  const suggested = `plan-partner-${tsStamp()}.json`;
  const path = await save({
    defaultPath: suggested,
    filters: [{ name: "Planory 백업", extensions: ["json"] }],
  });
  if (!path) return null;
  const data = await dumpAllTables();
  const payload = {
    schema: "plan-partner-export",
    version: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables: data,
  };
  await writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

// 파일 열기 → 파싱 → 검증 → 트랜잭션으로 전체 교체. 실패 시 예외를 던져 호출자가 사용자에게 알림.
export async function importFromJson(): Promise<{ path: string } | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "Planory 백업", extensions: ["json"] }],
  });
  if (!picked || Array.isArray(picked)) return null;

  const text = await readTextFile(picked as string);
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("JSON 파일을 파싱할 수 없어요."); }

  if (parsed?.schema !== "plan-partner-export") throw new Error("Planory 백업 파일이 아니에요.");
  if (parsed?.version !== EXPORT_SCHEMA_VERSION) throw new Error(`지원하지 않는 백업 버전(${parsed?.version})이에요.`);
  const tables = parsed?.tables;
  if (!tables || typeof tables !== "object") throw new Error("파일 내용이 손상되었어요.");
  for (const t of TABLES) {
    if (!Array.isArray(tables[t])) throw new Error(`테이블 '${t}' 데이터가 없어요.`);
  }

  // 가져오기 직전에 안전망 백업 한 번 더 만들어둠 — 잘못된 파일로 덮어써도 되돌릴 수 있게.
  try { await createBackupNow(); } catch (e) { console.warn("pre-import backup failed", e); }

  const db = await getDb();
  // 자식 → 부모 순서로 지우고, 부모 → 자식 순서로 채운다.
  const deleteOrder = [...TABLES].reverse();
  // 임포트 동안에는 FK 제약을 잠시 꺼둔다. blocks.next_block_id 나 checklist_items.parent_item_id
  // 처럼 같은 테이블 안에서 서로를 가리키는 self-ref가 있어서, 부모 → 자식 삽입 순서를
  // 지켜도 같은 테이블 내부 순서에 따라 FK 위반이 나올 수 있음. 예전엔 wipe(DELETE) 는
  // 이미 커밋된 뒤 INSERT 가 FK로 실패해 사용자 DB가 통째로 비어버리는 시나리오가 있었음.
  // 임포트 직전에 pre-import 백업이 이미 만들어져 있으니 사용자 데이터는 안전.
  // 참고: tauri-plugin-sql 의 커넥션 풀이 여러 커넥션을 쓰는 상황에서는 이 PRAGMA 가 이 순간
  // 사용한 커넥션에만 적용될 수 있음. 그래도 대다수 순차 실행 경로에서는 같은 커넥션이
  // 재사용되므로 실전 방어에는 충분.
  try { await db.execute("PRAGMA foreign_keys = OFF"); } catch {}
  await db.execute("BEGIN TRANSACTION");
  try {
    for (const t of deleteOrder) {
      await db.execute(`DELETE FROM ${t}`);
    }
    for (const t of TABLES) {
      const rows = tables[t] as any[];
      if (rows.length === 0) continue;
      // 화이트리스트로 필터 — 백업 파일 rows[0]에 있는 키 중 스키마에 실제 존재하는
      // 것만 사용. 알 수 없는 컬럼이 있어도 조용히 버림(엄격 매칭보다 관대한 편이
      // 스키마 진화 시 유리 — 예전 백업을 새 앱에서 여전히 복원 가능).
      const allowed = TABLE_COLUMNS[t];
      const cols = Object.keys(rows[0]).filter(c => allowed.includes(c));
      if (cols.length === 0) continue;
      const placeholders = cols.map(() => "?").join(", ");
      const colList = cols.join(", ");
      const stmt = `INSERT INTO ${t} (${colList}) VALUES (${placeholders})`;
      for (const row of rows) {
        const vals = cols.map(c => row[c] ?? null);
        await db.execute(stmt, vals);
      }
    }
    await db.execute("COMMIT");
  } catch (e) {
    try { await db.execute("ROLLBACK"); } catch {}
    throw e;
  } finally {
    try { await db.execute("PRAGMA foreign_keys = ON"); } catch {}
  }

  return { path: picked as string };
}
