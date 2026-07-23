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
  -- 'time' = 시간대별 블록 템플릿(기본, 드래그해서 시간표에 배치),
  -- 'todo' = 시간대 없이 할 일 목록에 놓을 일정 템플릿.
  kind TEXT NOT NULL DEFAULT 'time',
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

-- Todos — 시간이 지정되지 않은 날짜별 할 일. 마감(deadline)은 데드라인 카운트다운 성격이
-- 강하고 시간 블록(blocks)은 특정 시간대 점유가 필요하지만, todo는 그 사이 — "이 날 하기로 한
-- 것" 이라는 가벼운 체크박스 아이템. end_date 로 다중일 확장(향후).
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  end_date TEXT,
  color TEXT NOT NULL DEFAULT '#5AA9E6',
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS todos_date_idx ON todos (date);

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

// 기존 설치에서 block_templates 에 kind 컬럼을 사후 추가. 이미 있으면 조용히 실패.
const BLOCK_TEMPLATE_UPGRADES = [
  "ALTER TABLE block_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'time'",
];

// todos 에 color 컬럼 사후 추가 — 시간 블록과 같은 스트라이프 UI 를 위해 색상 필요.
const TODO_UPGRADES = [
  "ALTER TABLE todos ADD COLUMN color TEXT NOT NULL DEFAULT '#5AA9E6'",
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
      // 0) SQLite 동시성/일관성 프래그마.
      //    - journal_mode=WAL: DB 파일 레벨 설정이라 한 번만 켜두면 이후 모든 커넥션이 WAL로
      //      동작. 리더가 라이터를 막지 않아 UI가 백그라운드 저장 중에도 자유롭게 SELECT.
      //    - busy_timeout=5000: 라이터-라이터 충돌 시 즉시 SQLITE_BUSY(code 5, "database is
      //      locked") 로 실패하지 말고 최대 5초까지 자동 대기 후 재시도. tauri-plugin-sql의
      //      커넥션 풀이 여러 커넥션을 쓰기 때문에 BEGIN 이 걸린 커넥션과 다른 커넥션이
      //      동시에 쓰기를 시도하면 예전엔 "database is locked" 로 즉사했음(예: "일정 템플릿
      //      적용" 중 자동 저장이 겹칠 때). WAL은 DB 지속 설정이라 확실히 반영되지만,
      //      busy_timeout은 per-connection이라 이 커넥션에만 걸림 — 그래도 없는 것보단 나음.
      //    - foreign_keys=ON: 스키마의 ON DELETE CASCADE/SET NULL을 실제로 동작시킴. 기본이
      //      OFF라 켜지 않으면 폴더/템플릿/부모블록 삭제 시 자식 로우가 그대로 남아 유령됨.
      //      per-connection 이라는 한계가 있지만 대부분 순차 실행 경로에서는 같은 커넥션이
      //      재사용되므로 실전 방어에 충분. (기존 고아는 후속 수정 시에만 체크되어 즉사 X.)
      try { await db.execute("PRAGMA journal_mode = WAL"); }
      catch (e) { console.error("PRAGMA journal_mode WAL failed", e); }
      try { await db.execute("PRAGMA busy_timeout = 5000"); }
      catch (e) { console.error("PRAGMA busy_timeout failed", e); }
      try { await db.execute("PRAGMA foreign_keys = ON"); }
      catch (e) { console.error("PRAGMA foreign_keys ON failed", e); }
      // 1) 구버전 notes 테이블이 있으면 먼저 컬럼 업그레이드. SCHEMA의 CREATE INDEX가
      //    notes(folder_id)를 참조하므로, 인덱스 생성 전에 folder_id가 있어야 함.
      //    새 DB면 notes 테이블이 아직 없어 각 ALTER가 조용히 실패(무시)하고,
      //    이후 SCHEMA의 CREATE TABLE이 전체 컬럼을 갖춘 채 만든다.
      for (const stmt of NOTE_UPGRADES) {
        try { await db.execute(stmt); } catch { /* column/table already exists or not yet created */ }
      }
      for (const stmt of BLOCK_TEMPLATE_UPGRADES) {
        try { await db.execute(stmt); } catch { /* column/table already exists or not yet created */ }
      }
      for (const stmt of TODO_UPGRADES) {
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
