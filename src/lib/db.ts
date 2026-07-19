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

// 최초 실행 시 넣는 시드 블록 템플릿 (Supabase 0002_seed_templates.sql과 동일)
const SEED_TEMPLATES: { title: string; color: string; tags: string[] }[] = [
  { title: "운영체제 공부", color: "#6B9B37", tags: ["공부"] },
  { title: "알고리즘 풀기", color: "#5B7EA8", tags: ["공부"] },
  { title: "React 개발", color: "#7B5EA7", tags: ["개발"] },
  { title: "저녁 운동", color: "#D4622A", tags: ["운동"] },
  { title: "독서", color: "#8B6E4E", tags: ["루틴"] },
  { title: "글쓰기", color: "#4E8B6E", tags: ["루틴"] },
];

let dbPromise: Promise<Database> | null = null;

// 첫 호출 시 DB 파일 열고 스키마/시드 실행, 이후 호출은 같은 인스턴스 반환
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load("sqlite:planner.db");
      // 스키마 안에 여러 문장이 있으므로 execute를 여러 번 호출
      for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.execute(stmt);
      }
      // 시드 — 템플릿이 하나도 없을 때만 넣음 (재실행 안전)
      const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM block_templates");
      if (rows[0]?.n === 0) {
        for (const t of SEED_TEMPLATES) {
          await db.execute(
            "INSERT INTO block_templates (id, title, color, tags) VALUES (?, ?, ?, ?)",
            [crypto.randomUUID(), t.title, t.color, JSON.stringify(t.tags)]
          );
        }
      }
      return db;
    })();
  }
  return dbPromise;
}
