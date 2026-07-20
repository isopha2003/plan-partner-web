import Database from "@tauri-apps/plugin-sql";

// 로컬 SQLite 저장소 — Tauri의 앱 데이터 디렉토리 안에 저장됨.
// - Windows: %APPDATA%/com.isopha.planpartner/planner.db
// - macOS: ~/Library/Application Support/com.isopha.planpartner/planner.db
// 사용자 컴퓨터에만 존재하는 개인 파일이라 인터넷/서버가 전혀 필요 없음.
//
// 스키마 대응: supabase/migrations/0001_init.sql을 SQLite 타입으로 옮김.
// - uuid → TEXT (crypto.randomUUID로 앱에서 생성)
// - jsonb, text[] → TEXT (JSON.stringify로 직렬화)
// - boolean → INTEGER (0/1)
// - timestamptz, date, time → TEXT (ISO/HH:MM:SS 문자열)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS block_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  template_id TEXT REFERENCES block_templates(id) ON DELETE SET NULL,
  parent_block_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  color TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  memo TEXT NOT NULL DEFAULT '',
  next_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  repeat_group_id TEXT,
  repeat_rule TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  parent_item_id TEXT REFERENCES checklist_items(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deadlines (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedule_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timer_sessions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('manual', 'auto', 'ongoing')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS blocks_date_idx ON blocks (date);
CREATE INDEX IF NOT EXISTS blocks_parent_idx ON blocks (parent_block_id);
CREATE INDEX IF NOT EXISTS checklist_items_block_idx ON checklist_items (block_id);
CREATE INDEX IF NOT EXISTS deadlines_due_date_idx ON deadlines (due_date);
CREATE INDEX IF NOT EXISTS timer_sessions_date_idx ON timer_sessions (date);
`;

let dbPromise: Promise<Database> | null = null;

// 첫 호출 시 DB 파일 열고 스키마 초기화, 이후 호출은 같은 인스턴스 반환.
// 시드 데이터는 넣지 않음 — 첫 실행은 완전히 빈 상태에서 시작
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load("sqlite:planner.db");
      for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.execute(stmt);
      }
      return db;
    })();
  }
  return dbPromise;
}
