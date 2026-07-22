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
// created_at/updated_at은 ALTER 시 non-constant default(datetime('now'))를 못 붙이므로
// nullable로 추가하고 아래에서 백필. updated_at은 이론상 항상 존재했지만, 훨씬 오래된
// (id, content)만 있던 흔적을 만나면 fetch ORDER BY updated_at부터 터져서 노트 전체가
// 안 열리는 캐스케이드가 나므로 안전망으로 함께 시도.
const NOTE_UPGRADES = [
  "ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN folder_id TEXT",
  "ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE notes ADD COLUMN created_at TEXT",
  "ALTER TABLE notes ADD COLUMN updated_at TEXT",
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
      // 0) 외래키 제약 활성화 — 기본 OFF라 켜지 않으면 스키마의 ON DELETE CASCADE/SET NULL이
      //    전부 no-op. 폴더/템플릿/부모블록을 지워도 자식 로우가 그대로 남아 UI에 고아 상태로
      //    표시되거나(예: folder_id가 죽은 폴더를 가리키는 노트가 모든 뷰에서 안 보임) 이후
      //    삽입에서 이상 상태가 됨. 켜기만 해도 이후 삭제부터 제대로 동작.
      //    (기존에 이미 남은 고아는 SQLite가 후속 수정 시에만 체크하므로 즉시 실패하지 않음.)
      try { await db.execute("PRAGMA foreign_keys = ON"); }
      catch (e) { console.error("PRAGMA foreign_keys ON failed", e); }
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
      try {
        // updated_at ALTER는 nullable로 붙였으니(NOT NULL 제약 없음) 방금 새로 추가된
        // 경우엔 값이 NULL. 정렬 안정성을 위해 created_at 값이나 현재 시각으로 채움.
        await db.execute("UPDATE notes SET updated_at = COALESCE(created_at, datetime('now')) WHERE updated_at IS NULL");
      } catch { /* fresh install: notes 아직 없음 */ }
      // 2) 테이블/인덱스 생성 (IF NOT EXISTS이라 재실행 안전).
      //    개별 statement 실패는 여기서 삼키고 콘솔에만 남김 — 예전엔 이 루프가 통째로
      //    throw하면 dbPromise 전체가 rejected로 캐시됐다가 리셋되고, 이후 UI에서 어떤
      //    DB 호출을 하든 즉시 실패해 "블록 추가/삭제/저장 실패" 토스트가 연쇄 발생.
      //    실제로는 이미 만들어져 있는 테이블/인덱스가 대부분이라 idempotent 하고,
      //    한 문장이 이상하다고 나머지까지 못 만드는 건 손해가 큼.
      for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) {
        try { await db.execute(stmt); }
        catch (e) { console.error("schema stmt failed", stmt.slice(0, 80), e); }
      }
      return db;
    })();
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
  }
  return dbPromise;
}
