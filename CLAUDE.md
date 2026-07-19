# CLAUDE.md

이 프로젝트(생활 플래너)에서 작업할 때 아래 규칙을 따를 것.

## 참고 문서

- `figma-prd.md` — 초기 기능/화면 정의 (Figma 디자인 전달용으로 작성했으나 개발 기준 문서로도 사용). 그동안 개발 방향이 웹 → 데스크톱 앱으로 바뀌면서 알림/저장 방식 등 일부 항목은 실제 구현과 차이가 있으니 최신 상태는 코드를 우선 참고할 것
- `src/lib/db.ts` — SQLite 스키마 정의 및 시드 데이터

## 프로젝트 배경

- 피그마 AI(Figma Make)로 생성된 React+Vite+Tailwind+shadcn 코드베이스를 출발점으로 시작함 (`src/app/App.tsx`)
- 원본 앱 기획(`D:\plan_partner_project`, Flutter 기준)과는 별개의 독립 프로젝트
- **Tauri 기반 데스크톱 앱**(Windows/Mac). 초기엔 웹 배포를 목표로 시작했으나 테두리 없는 항상-위-떠 있는 타이머 위젯 같은 요구를 브라우저 샌드박스에서 처리할 수 없어 Tauri로 전환. 웹 배포는 포기함
- 데이터는 **로컬 SQLite**에 저장 — `tauri-plugin-sql`을 통해 사용자 컴퓨터의 앱 데이터 디렉토리(`%APPDATA%/com.isopha.planpartner/planner.db`)에만 존재. 인터넷/서버 완전 불필요, 단일 사용자용
- 프론트엔드는 `src/lib/api.ts`가 `db.execute`/`db.select`를 감싼 함수들로 데이터 계층을 담당 — UI 코드는 이 API의 시그니처만 알면 됨

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
