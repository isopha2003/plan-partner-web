# CLAUDE.md

이 프로젝트(생활 플래너 웹)에서 작업할 때 아래 규칙을 따를 것.

## 참고 문서

- `figma-prd.md` — 웹 버전 기능/화면 정의 (Figma 디자인 전달용으로 작성했으나 개발 기준 문서로도 사용)
- `supabase/migrations/` — DB 스키마

## 프로젝트 배경

- 피그마 AI(Figma Make)로 생성된 React+Vite+Tailwind+shadcn 코드베이스를 출발점으로 시작함 (`src/app/App.tsx`)
- 원본 앱 기획(`D:\plan_partner_project`, Flutter 기준)과는 별개의 독립 프로젝트 — 웹으로 먼저 출시하는 것이 목표
- 백엔드는 Supabase 사용 (Postgres). 현재는 로그인 없이 단일 사용자로 운영 — 각 테이블에 `user_id` 컬럼은 미리 넣어뒀지만 RLS는 아직 비활성 상태. 나중에 인증을 추가할 때 RLS 정책도 같이 켤 것

## Git / GitHub 규칙

- 의미 있는 작업 단위(기능 하나, 버그 수정 하나)가 끝날 때마다 자동으로 커밋하고 push할 것 — 사용자에게 매번 확인받지 않음
- 커밋 메시지는 **Conventional Commits** 형식 사용: `접두사: 설명`
  - `feat:` 새 기능 추가
  - `fix:` 버그 수정
  - `refactor:` 동작은 그대로, 코드 구조만 변경
  - `docs:` 문서 수정 (md 파일 등)
  - `style:` 포맷팅 등 동작에 영향 없는 변경
  - `chore:` 패키지 설치, 설정 파일, DB 마이그레이션 등
- 설명 부분은 한국어로 간결하게 작성 (예: `feat: 타이머 3-state 자동정지 로직 구현`)
- 저장소: https://github.com/isopha2003/plan-partner-web (비공개)
