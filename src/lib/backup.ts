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
  "schedule_templates",
  "timer_sessions",
  "notes",
] as const;

type TableName = typeof TABLES[number];

function tsStamp(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
    filters: [{ name: "생활 플래너 백업", extensions: ["json"] }],
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
    filters: [{ name: "생활 플래너 백업", extensions: ["json"] }],
  });
  if (!picked || Array.isArray(picked)) return null;

  const text = await readTextFile(picked as string);
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("JSON 파일을 파싱할 수 없어요."); }

  if (parsed?.schema !== "plan-partner-export") throw new Error("생활 플래너 백업 파일이 아니에요.");
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
  await db.execute("BEGIN TRANSACTION");
  try {
    for (const t of deleteOrder) {
      await db.execute(`DELETE FROM ${t}`);
    }
    for (const t of TABLES) {
      const rows = tables[t] as any[];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
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
  }

  return { path: picked as string };
}
