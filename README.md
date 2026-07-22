# Planory

시간 블록·마감·뽀모도로·집중 시간 기록·메모까지 한 화면에서 다루는 개인용 Windows/macOS 데스크톱 앱.

![Windows/macOS](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![Latest](https://img.shields.io/github/v/release/isopha2003/plan-partner-web)

## 주요 기능

- **캘린더 & 시간 블록**: 일/주/월 뷰, 드래그로 블록 이동·리사이즈, 15분 스냅
- **반복 규칙**: 매일/매주 반복, N회 또는 종료일까지
- **뽀모도로 타이머**: 집중/휴식 자동 사이클, OS 네이티브 알림, 데스크톱 어디에서나 떠 있는 얇은 타이머 위젯
- **집중 시간 기록**: 세션 단위 기록, 활동 기록 캘린더에서 히트맵/스트릭/목표 달성일 확인
- **마감 작업**: 시간 블록과 분리된 D-day 관리
- **메모**: 폴더 · 카테고리 · 마크다운 프리뷰 · 사용자 지정 정렬
- **하루 1회 자동 백업 + 수동 백업**: `%APPDATA%/com.isopha.planpartner/backups/`
- **자동 업데이터**: GitHub Releases에서 서명된 인스톨러 자동 감지 · 설치 · 재시작

## 설치

[Releases](https://github.com/isopha2003/plan-partner-web/releases/latest)에서 자기 OS에 맞는 파일 받기.

| OS | 파일 |
|----|------|
| Windows (권장) | `Planory_x.y.z_x64-setup.exe` |
| Windows (MSI) | `Planory_x.y.z_x64_en-US.msi` |
| macOS | `Planory_x.y.z_universal.dmg` |

설치 후 시작 메뉴 / Launchpad에서 실행. 첫 실행 시 자동 백업 디렉토리와 DB 파일이 생성됩니다.

## 데이터

전부 로컬 SQLite에만 저장되고 인터넷/서버는 필요 없습니다.

- **Windows**: `%APPDATA%\com.isopha.planpartner\planner.db`
- **macOS**: `~/Library/Application Support/com.isopha.planpartner/planner.db`

같은 위치 `backups/` 폴더에 `planner-YYYYMMDD-HHMMSS-ms.db` 스냅샷이 하루 1회 자동 저장 (최근 10개 유지).

기기 이동은 이 파일을 복사해 넣으면 됩니다.

## 개발

```bash
# 의존성 설치
npm ci

# 개발 서버 (핫리로드 + 데스크톱 창)
npm run tauri dev

# 프로덕션 빌드 (로컬 테스트용, 릴리즈는 CI가 담당)
npm run tauri build
```

Rust toolchain(stable) + Node 20 필요.

## 릴리즈

`v` 접두어 태그 push로 [GitHub Actions](https://github.com/isopha2003/plan-partner-web/actions)가 Windows/macOS 인스톨러를 빌드 · 서명 · 업로드합니다.

```bash
npm version patch -m "chore(release): v%s"   # 또는 minor / major
git push --follow-tags
```

빌드에 필요한 secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## 기술 스택

- **프론트**: React + Vite + TypeScript + Tailwind + shadcn/ui
- **데스크톱**: Tauri v2 (Rust)
- **저장소**: SQLite (`tauri-plugin-sql`)
- **자동 업데이트**: `tauri-plugin-updater` (minisign 서명)
- **알림/파일/다이얼로그**: `tauri-plugin-notification` / `-fs` / `-dialog`

## 라이선스

Private repository. 개인 사용 목적.
