-- 생활 플래너 초기 스키마
-- 지금은 로그인 없이 단일 사용자로 운영 (user_id 컬럼은 나중에 인증 추가할 때 대비해 미리 넣어둠, 지금은 전부 null 허용)
-- RLS는 아직 켜지 않음 — 인증을 붙이는 시점에 정책과 함께 활성화할 것

create extension if not exists "pgcrypto";

-- 블록 템플릿: 재사용 가능한 활동 정의
create table block_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text not null,
  color text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- 블록(타임블록) 인스턴스 — 최상위 블록과, 1단계까지만 허용되는 독립 타임블록형 자식을 모두 포함
-- parent_block_id가 null이면 최상위, 아니면 자식(1단계 제약은 애플리케이션 레벨에서 검증)
create table blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  template_id uuid references block_templates(id) on delete set null,
  parent_block_id uuid references blocks(id) on delete cascade,
  title text not null,
  color text not null,
  date date not null,
  start_time time not null,
  end_time time not null,
  completed boolean not null default false,
  completed_at timestamptz,
  memo text not null default '',
  next_block_id uuid references blocks(id) on delete set null,
  repeat_group_id uuid,
  repeat_rule jsonb,
  created_at timestamptz not null default now()
);

-- 체크리스트형 자식 — 무제한 중첩 (parent_item_id로 자기 자신을 참조)
create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  block_id uuid not null references blocks(id) on delete cascade,
  parent_item_id uuid references checklist_items(id) on delete cascade,
  text text not null,
  completed boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 마감 작업 (시간대 없이 날짜만)
create table deadlines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text not null,
  due_date date not null,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 하루/주 일정 템플릿 (스냅샷 복제용)
create table schedule_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  name text not null,
  blocks jsonb not null,
  created_at timestamptz not null default now()
);

-- 전역 타이머 세션 기록 (집중/휴식 구간 계산용)
create table timer_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  date date not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('manual', 'auto', 'ongoing')),
  created_at timestamptz not null default now()
);

-- 하루 목표 집중 시간 (하이브리드: 자동 제안값을 사용자가 덮어쓸 수 있음)
create table daily_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  date date not null,
  goal_minutes int not null,
  is_manual_override boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- 설정 (사용자당 한 행)
create table settings (
  user_id uuid primary key default gen_random_uuid(),
  pomodoro_on boolean not null default false,
  pomodoro_work_min int not null default 25,
  pomodoro_break_min int not null default 5,
  abandon_alert_min int not null default 15,
  updated_at timestamptz not null default now()
);

create index blocks_date_idx on blocks (date);
create index blocks_parent_idx on blocks (parent_block_id);
create index checklist_items_block_idx on checklist_items (block_id);
create index deadlines_due_date_idx on deadlines (due_date);
create index timer_sessions_date_idx on timer_sessions (date);
