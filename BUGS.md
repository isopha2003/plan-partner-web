# 앱 패키징 전 버그 리스트

앱을 데스크톱 앱으로 배포하기 전에 정리해야 할 버그 목록.
치명도 순으로 정렬됨.

> **상태(2026-07-22)**: #1~#11 모두 수정·커밋 완료. 남은 배포 blocker 없음.

---

## 🔴 치명 — 유저가 확실히 손해 보는 버그

### 1. 활동 기록 캘린더가 2026년 7월에 고정됨
- **위치**: `src/app/App.tsx:2260-2261`
- **증상**: `GrassSection`의 `viewYear`/`viewMonth`가 하드코드 (`2026`, `6`).
  피그마 초기 코드가 그대로 남음. 2026년 8월만 돼도 활동 기록 탭이 열릴 때마다 계속 "2026년 7월"이 보임.
- **재현**: 시스템 시각을 2026-08-01 이후로 바꾸고 앱 실행 → 활동 기록 탭.
- **수정 방향**: `new Date()`에서 현재 연/월을 읽어 초기값으로 사용.
  ```ts
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  ```

### 2. "방치 알림" 설정이 완전히 죽어있음
- **위치**: `src/app/App.tsx:261-262`, `3384-3403`
- **증상**: `abandonOn`/`abandonMin` state와 설정 UI(토글/시간 입력)는 있지만,
  실제로 이 값을 읽어 알림을 발송하는 코드가 코드베이스 어디에도 없음.
  유저가 토글 켜고 임계 시간 설정해도 아무 일도 안 일어남.
- **확인 방법**: `grep -r "abandon" src/`로 실사용처가 UI뿐임을 확인 가능.
- **수정 방향**: 두 가지 중 선택
  - (a) 설정 UI를 일단 숨김/제거 (기능 미구현)
  - (b) 수동 정지 후 `abandonMin`분 지나면 `sendNotification`으로 브라우저 알림 발송하는 effect 추가

### 3. 뽀모도로/방치 설정이 앱 재시작 시 초기화됨
- **위치**: `src/app/App.tsx:258-262`
- **증상**: `darkMode`나 팔레트 색상은 localStorage로 유지되는데
  `pomodoroOn`/`pomWork`/`pomBreak`/`abandonOn`/`abandonMin`은 저장 안 됨.
  앱을 껐다 켜면 매번 뽀모도로 꺼짐 · 25/5분 초기값으로 복귀.
- **수정 방향**: `darkMode`와 같은 패턴으로 `useState` 초기값을 localStorage에서 읽고,
  변경 시 저장하는 `useEffect` 추가.

---

## 🟡 중간 — 특정 조건에서 데이터 이상

### 4. 타이머 시작 rapid-click 시 세션 leak
- **위치**: `src/app/App.tsx:303-312` (`startSession`)
- **증상**: 재진입 가드 없음. 시작 버튼을 빠르게 두 번 누르거나 메인 창/뜬 창에서
  동시에 시작 요청이 들어오면 `startTimerSession` INSERT가 두 번 발생.
  `currentSessionIdRef`엔 뒤에 온 세션만 남고, 앞 세션은 `end_reason='ongoing'`으로
  DB에 orphan됨. 다음 앱 재시작 때 `stale` 로직이 auto 종료해주긴 하지만
  그때까지 통계에 안 잡힘.
- **수정 방향**: 백업/업데이트 버튼(`SettingsSection`)에 붙였던 `useRef` 기반
  재진입 가드 패턴을 `startSession`/`endSession`에도 적용.

### 5. DB 초기화 실패 캐시
- **위치**: `src/lib/db.ts:117-142`
- **증상**: `dbPromise`가 module-scoped라 첫 `getDb()`가 rejected되면
  그 rejected promise가 캐시돼서 이후 모든 DB 호출이 영구히 실패함.
- **수정 방향**: `.catch(e => { dbPromise = null; throw e; })`로 실패 시
  캐시 리셋. 다음 호출 시 재시도 가능.

### 6. JSON import — 컬럼명 화이트리스트 없음
- **위치**: `src/lib/backup.ts:167-171`
- **증상**: `cols = Object.keys(rows[0])`을 그대로 SQL 문자열에 삽입.
  개인용 로컬 파일 임포트라 악의적 시나리오는 낮지만, 손상/조작된 백업
  파일을 열면 스키마 이상 상태로 진입 가능.
- **수정 방향**: 테이블별로 알려진 컬럼 세트를 상수로 정의하고
  `Object.keys(rows[0])` 결과를 그 세트로 교차 필터링.

---

## 🟢 자잘함 (배포 blocker는 아님)

### 7. 뜬 타이머 창이 닫혀 있어도 매초 브로드캐스트
- **위치**: `src/app/App.tsx:344-348`
- **증상**: `emit("timer:state", ...)`이 창 상태와 무관하게 매초 발화.
  성능/배터리는 미미하게 낭비.
- **수정 방향**: `useTimerWindow`의 `isOpen` 값을 App으로 끌어와 조건부 emit.

### 8. 자정 롤오버 effect가 `[timerState]` 의존
- **위치**: `src/app/App.tsx:386`
- **증상**: `useEffect(..., [timerState])`라 timerState 바뀔 때마다
  30초 인터벌이 재시작됨. 자정 근처에서 최악 30초 지연 가능.
- **수정 방향**: interval을 `[]` deps로 분리하고 콜백 안에서 ref로 timerState 읽기.

### 9. 뽀모도로 focus phase 자동 종료가 `end_reason='manual'`로 저장
- **위치**: `src/app/App.tsx:420`
- **증상**: semantic 어긋남 — 히스토리 팝오버에서 "수동 정지" 아이콘(■)이 뜸.
- **수정 방향**: `"auto"`로 저장하거나, 새로운 enum 값(`"pomodoro"`)을 도입.
  후자는 스키마 마이그레이션 필요.

### 10. `useTimerWindow` cleanup race
- **위치**: `src/app/useTimerWindow.ts:47-55`
- **증상**: effect가 unmount될 때 `onCloseRequested` 프로미스가 아직
  resolve되지 않았다면 unlisten이 안 됨. 메인 창은 사실상 unmount 안 되므로 무해.
- **수정 방향**: cleanup에서 promise를 await하고 unlisten 호출.

### 11. daily 반복 인스턴스가 endDate 지나도 loop 계속
- **위치**: `src/app/App.tsx:517-522`
- **증상**: `endType === "date"`인 경우 dateStr > endDate 시 인스턴스만 push 안 하고
  loop는 14일 끝까지 돌아감. 결과는 정상, 성능만 낭비.
- **수정 방향**: `if (dateStr > repeat.endDate) break;` 로 early exit.

---

## 우선순위

**앱 배포 전 반드시**: 1, 2, 3
→ 유저가 앱 켜자마자 알아채는 종류.

**여유 되면**: 4, 5
→ 데이터 관련 안전성.

**나중에**: 6~11
→ 극한 조건 or 성능 자잘함.
