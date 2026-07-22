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

-- 메모 폴더 — 색상 있는 보관 통. 메모가 folder_id로 소속됨(0~1개, 플랫 1단계).
CREATE TABLE IF NOT EXISTS note_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 자유 메모 — 제목 + 마크다운 내용 + 자유 텍스트 카테고리 + 소속 폴더.
-- sort_order로 사용자 지정 순서 저장(정렬 모드가 custom일 때 사용).
-- is_draft: "새 메모"로 만들어져 아직 사용자가 "저장" 버튼으로 확정하지 않은 상태.
-- 뒤로가기(자동저장)로 나가면 draft로 남아 별도 "임시 저장" 탭에서만 노출.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  folder_id TEXT REFERENCES note_folders(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS blocks_date_idx ON blocks (date);
CREATE INDEX IF NOT EXISTS blocks_parent_idx ON blocks (parent_block_id);
CREATE INDEX IF NOT EXISTS checklist_items_block_idx ON checklist_items (block_id);
CREATE INDEX IF NOT EXISTS deadlines_due_date_idx ON deadlines (due_date);
CREATE INDEX IF NOT EXISTS timer_sessions_date_idx ON timer_sessions (date);
CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes (folder_id);
`;

// 이미 구버전 notes 테이블(단일 main 노트, id/content/updated_at만)이 있던 설치를 위한
// 방어적 컬럼 추가. 각 ALTER는 컬럼이 이미 있으면 에러가 나므로 개별 try/catch로 무시.
// created_at은 ALTER 시 non-constant default(datetime('now'))를 못 붙이므로 nullable로 추가.
const NOTE_UPGRADES = [
  "ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN folder_id TEXT",
  "ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE notes ADD COLUMN created_at TEXT",
  "ALTER TABLE notes ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0",
];

let dbPromise: Promise<Database> | null = null;

// 첫 호출 시 DB 파일 열고 스키마 초기화, 이후 호출은 같은 인스턴스 반환.
// 시드 데이터는 넣지 않음 — 첫 실행은 완전히 빈 상태에서 시작.
// 실패 시 dbPromise를 null로 리셋 — 안 그러면 rejected promise가 영구 캐시돼서
// 첫 시도 실패 후 다시는 DB 접근이 안 됨(모든 호출이 캐시된 실패 promise를 그대로 반환).
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    const p: Promise<Database> = (async () => {
      const db = await Database.load("sqlite:planner.db");
      // 1) 구버전 notes 테이블이 있으면 먼저 컬럼 업그레이드. SCHEMA의 CREATE INDEX가
      //    notes(folder_id)를 참조하므로, 인덱스 생성 전에 folder_id가 있어야 함.
      //    새 DB면 notes 테이블이 아직 없어 각 ALTER가 조용히 실패(무시)하고,
      //    이후 SCHEMA의 CREATE TABLE이 전체 컬럼을 갖춘 채 만든다.
      for (const stmt of NOTE_UPGRADES) {
        try { await db.execute(stmt); } catch { /* column/table already exists or not yet created */ }
      }
      try {
        await db.execute("UPDATE notes SET created_at = updated_at WHERE created_at IS NULL");
      } catch { /* fresh install: notes 아직 없음 */ }
      // 2) 테이블/인덱스 생성 (IF NOT EXISTS이라 재실행 안전)
      for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.execute(stmt);
      }
      return db;
    })();
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
  }
  return dbPromise;
}
