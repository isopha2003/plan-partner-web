import React, { useState, useEffect, useRef } from "react";
import {
  CheckCircle2, Circle, Clock, Play, Pause,
  Plus, X, ChevronLeft, ChevronRight, List, Grid3x3,
  BarChart2, Settings, Calendar, Target, Flame, FileText,
  Edit3, Check, AlertCircle, Info, PictureInPicture2 as PictureInPicture,
  Folder, FolderPlus, MoreVertical, ArrowLeft, ArrowUpDown, Trash2,
  Minus, Square, Copy,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  fetchTemplates, createTemplate, deleteTemplateRow, updateTemplateRow, fetchBlocks, insertBlock, patchBlock, deleteBlockRow,
  deleteBlocksByRepeatGroup as apiDeleteRepeatGroup, deleteRepeatInstancesExceptOrigin, insertBlocksBulk,
  fetchDeadlines, createDeadline, toggleDeadlineRow, deleteDeadlineRow,
  fetchScheduleTemplates, createScheduleTemplateRow, deleteScheduleTemplateRow,
  fetchTodaySessions, startTimerSession, endTimerSession, deleteTodaySessions, fetchFocusSecByDate,
  fetchChecklistItems, createChecklistItem, toggleChecklistItemRow, deleteChecklistItemRow,
  fetchNotes, createNote, updateNote, deleteNote, moveNoteToFolder, reorderNotes,
  fetchNoteFolders, createFolder, updateFolder, deleteFolder,
  type Note, type NoteFolder,
} from "../lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type TimerState, fmtSec } from "../lib/timer";
import { runAutoBackupIfNeeded, createBackupNow, getLastBackupTimestamp } from "../lib/backup";
import { checkForUpdate, installUpdate, type UpdateCheckResult } from "../lib/updater";
import { notifyError } from "../lib/notify";
import { Toaster } from "./components/ui/sonner";
import { emit, listen } from "@tauri-apps/api/event";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useTimerWindow } from "./useTimerWindow";

// ── Types ──────────────────────────────────────────────────────────
interface Block {
  id: string;
  templateId?: string;
  parentBlockId?: string;
  title: string;
  color: string;
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  completed: boolean;
  tags: string[];
  memo: string;
  date: string;
  repeat?: BlockRepeat;
  repeatGroupId?: string;
  nextBlockId?: string;
}

interface Deadline {
  id: string;
  title: string;
  dueDate: string;
  completed: boolean;
}

interface Template {
  id: string;
  title: string;
  color: string;
  tags: string[];
}

interface BlockRepeat {
  type: "daily" | "weekly";
  days: number[];        // 0–6 (Sun–Sat) for weekly
  endType: "none" | "count" | "date";
  endCount: number;
  endDate: string;       // ISO date string
}

interface ScheduleTemplate {
  id: string;
  name: string;
  blocks: Pick<Block, "title" | "color" | "startH" | "startM" | "endH" | "endM" | "tags" | "memo">[];
}

interface TimerSession {
  id: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  endReason: "manual" | "auto" | "ongoing";
}

interface ChecklistItemT {
  id: string;
  blockId: string;
  parentItemId?: string;
  text: string;
  completed: boolean;
  sortOrder: number;
}

type Section = "today" | "calendar" | "deadlines" | "grass" | "memo" | "settings";

// ── Helpers ────────────────────────────────────────────────────────
// Local calendar date -> "YYYY-MM-DD", WITHOUT going through UTC (unlike .toISOString().slice(0,10),
// which rolls back to the previous day for any positive UTC offset — e.g. Asia/Seoul UTC+9 turns
// local midnight July 1st into "2026-06-30". This reads the local Y/M/D components directly.
const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// "YYYY-MM-DD" -> local Date at that day's midnight. `new Date("YYYY-MM-DD")` parses the string
// as UTC per spec, which is the mirror-image bug of toDateStr above (this direction bites
// negative-UTC-offset users). Building via the (y, m, d) constructor form is always local.
const parseLocalDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
// 두 로컬 날짜(자정) 사이의 정수 일수 차이. Date.UTC로 각 날짜를 timezone-agnostic한 UTC
// 자정으로 변환해 뺀 뒤 86400000으로 나눔 — 이렇게 하면 DST 전환(하루가 23h 또는 25h)이
// 있는 지역에서도 항상 정확한 정수 일수가 나옴. 예전엔 `(t2 - t1) / 86400000`을
// Math.ceil해서 DST fall-back 시 "내일" 마감이 D-2로 표시되는 등 오차가 생겼음.
const daysBetween = (a: Date, b: Date) => {
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((aUTC - bUTC) / 86400000);
};
// 자정 롤오버: 아래 세 값은 컴포넌트들이 프op이 아니라 모듈 전역 변수로 직접 참조하고 있어서
// (예: TodaySection 안에서 `TODAY_STR` 그대로 사용), `let`로 두고 재할당하면 다음 렌더링부터
// 모든 곳에서 자동으로 새 값을 읽게 됨. 실제로 리렌더를 발생시키는 건 App()의 tick 로직.
let TODAY_STR = toDateStr(new Date());

const fmt2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (h: number, m: number) => `${fmt2(h)}:${fmt2(m)}`;
const durMin = (b: Block) => (b.endH * 60 + b.endM) - (b.startH * 60 + b.startM);
const DAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
const MONTHS_KO = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
let TODAY_DATE = parseLocalDate(TODAY_STR);

// 두 음(A5→E6) 상승 chime — Web Audio로 코드에서 직접 생성해 파일/OS 사운드 설정에
// 의존하지 않고 확실히 재생. 사용자 클릭으로 뽀모도로가 시작된 뒤에만 호출되므로
// autoplay 정책에 걸리지 않음.
function playChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const play = (freq: number, start: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(0.35, now + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.start(now + start);
      o.stop(now + start + dur);
    };
    play(880, 0, 0.18);      // A5
    play(1320, 0.14, 0.28);  // E6
    setTimeout(() => { try { ctx.close(); } catch {} }, 800);
  } catch (e) { console.error(e); }
}

// 뽀모도로 phase 전환 시 OS 네이티브 알림 발송 + chime 재생 — 알림 권한 없으면 텍스트는
// 조용히 스킵하되 사운드는 재생 (사운드는 앱 자체 재생이라 권한 무관).
async function notifyPomodoro(title: string, body: string) {
  playChime();
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    sendNotification({ title, body });
  } catch (e) { console.error(e); }
}

// 실제 날짜가 바뀌었으면 위 세 변수를 갱신하고 true를 반환 (안 바뀌었으면 false)
function syncTodayIfChanged(): boolean {
  const real = toDateStr(new Date());
  if (real === TODAY_STR) return false;
  TODAY_STR = real;
  TODAY_DATE = parseLocalDate(TODAY_STR);
  return true;
}

// localStorage에 JSON으로 값을 저장/복원하는 useState 래퍼. darkMode/팔레트 색상처럼
// 재시작 후에도 유지돼야 하는 설정에 사용. 파싱 실패나 저장 실패는 조용히 무시하고
// 초기값으로 폴백 — 개인용 앱이라 스토리지 격리 이슈까지 방어할 필요는 없음.
function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {}
    return initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

// ── App ────────────────────────────────────────────────────────────
export default function App() {
  const [section, setSection] = useState<Section>("today");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [scheduleTemplates, setScheduleTemplates] = useState<ScheduleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  // 캘린더 클릭으로 방금 만들어진 블록 id — 상세 패널이 제목 편집 모드로 자동 진입하고,
  // 이 블록의 제목이 처음 저장될 때 매칭 템플릿을 좌측 사이드바에 자동 추가하는 트리거로 씀.
  const [justCreatedBlockId, setJustCreatedBlockId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [tpls, blks, dls, sts] = await Promise.all([
          fetchTemplates(), fetchBlocks(), fetchDeadlines(), fetchScheduleTemplates(),
        ]);
        setTemplates(tpls);
        setBlocks(blks);
        setDeadlines(dls);
        setScheduleTemplates(sts);
      } catch (e: any) {
        setLoadError(e.message ?? "데이터를 불러오지 못했어요");
      } finally {
        setLoading(false);
      }
    })();
    // 하루 1회 자동 백업 (백그라운드 실행, 실패는 조용히 무시)
    runAutoBackupIfNeeded();
  }, []);

  // Global timer — single, app-wide. "자동 일시정지"는 사용자가 누르는 버튼이 아니라
  // 브라우저 탭 가시성(Page Visibility API)에 의해서만 진입/해제되는 상태.
  const [timerState, setTimerState] = useState<TimerState>("stopped");
  const [timerSec, setTimerSec] = useState(0);
  const [sessions, setSessions] = useState<TimerSession[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  // 과거 날짜별 누적 집중 시간(초) — 캘린더 히트맵에서 어제 이전 집중 시간을 표시할 때 사용.
  // 오늘은 실시간 timerSec을 별도로 쓰므로 여기엔 굳이 반영 안 함(포함되어도 무해).
  const [focusSecByDate, setFocusSecByDate] = useState<Record<string, number>>({});

  // 다크 모드 — localStorage에 저장해 재시작 시에도 유지. 첫 실행 기본값은 라이트.
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem("theme") === "dark"; } catch { return false; }
  });

  // 블록/템플릿 색상 팔레트 — 프리셋에서 시작해 사용자가 +로 커스텀 색 추가, X로 삭제 가능.
  // localStorage에 저장해 다음 실행에도 유지.
  const [paletteColors, setPaletteColors] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(BLOCK_PALETTE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) return parsed;
      }
    } catch {}
    return DEFAULT_BLOCK_COLORS;
  });
  const addPaletteColor = (color: string) => {
    setPaletteColors(prev => {
      const c = color.toLowerCase();
      if (prev.some(x => x.toLowerCase() === c)) return prev;
      const next = [...prev, color];
      try { localStorage.setItem(BLOCK_PALETTE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const removePaletteColor = (color: string) => {
    setPaletteColors(prev => {
      const c = color.toLowerCase();
      const next = prev.filter(x => x.toLowerCase() !== c);
      try { localStorage.setItem(BLOCK_PALETTE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add("dark");
    else root.classList.remove("dark");
    try { localStorage.setItem("theme", darkMode ? "dark" : "light"); } catch {}
  }, [darkMode]);

  // Pomodoro / settings — timer effect들이 이 상태를 참조하므로 반드시 그 앞에서 선언돼야 함.
  // localStorage에 저장해 재시작 시에도 유지 — 예전엔 매번 초기값(꺼짐/25/5/꺼짐/15)로
  // 리셋돼서 유저가 앱 켤 때마다 다시 켜야 했음.
  const [pomodoroOn, setPomodoroOn] = usePersistedState("settings_pomodoro_on", false);
  const [pomWork, setPomWork] = usePersistedState("settings_pom_work", 25);
  const [pomBreak, setPomBreak] = usePersistedState("settings_pom_break", 5);
  const [abandonOn, setAbandonOn] = usePersistedState("settings_abandon_on", false);
  const [abandonMin, setAbandonMin] = usePersistedState("settings_abandon_min", 15);

  // 뽀모도로 사이클 상태 — timerState="running"이고 pomodoroOn=true일 때만 의미
  // pomPhase: 지금 집중 중인지 휴식 중인지. pomPhaseSec: 현재 phase에서 흐른 초.
  // 휴식 중일 때는 timerSec/Supabase focus 세션 모두 정지, phase만 카운트업.
  const [pomPhase, setPomPhase] = useState<"focus" | "break">("focus");
  const [pomPhaseSec, setPomPhaseSec] = useState(0);

  // 뽀모도로 or 방치 알림 켤 때 알림 권한 요청 — 이미 허용돼 있으면 no-op
  useEffect(() => {
    if (!pomodoroOn && !abandonOn) return;
    (async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch (e) { console.error(e); }
    })();
  }, [pomodoroOn, abandonOn]);

  // 뽀모도로가 켜진 채 휴식 phase에 진입해 있으면 currentSessionIdRef=null(집중 세션 종료됨).
  // 이 상태에서 사용자가 뽀모도로를 끄면 tick effect는 timerSec를 다시 증가시키지만 열린
  // DB 세션이 없어서 그 시간이 재시작 후 완전히 사라지는 데이터 유실 버그가 있었음.
  // pom을 끄는 순간 focus로 되돌리고 새 세션을 시작해 시간이 계속 기록되게 함.
  useEffect(() => {
    if (pomodoroOn) return;
    if (timerState !== "running") return;
    if (pomPhase !== "break") return;
    setPomPhase("focus");
    setPomPhaseSec(0);
    if (!currentSessionIdRef.current && !timerActionBusyRef.current) {
      (async () => {
        try {
          const session = await startTimerSession(TODAY_STR);
          currentSessionIdRef.current = session.id;
          setSessions(s => [...s, session]);
        } catch (e) { notifyError("타이머 세션 시작 실패")(e); }
      })();
    }
  }, [pomodoroOn, timerState, pomPhase]);

  // 방치 알림 — 타이머가 수동 정지된 상태(stopped)로 abandonMin분 유지되면 1회 알림.
  // running/auto-paused로 전환되면 취소, 다시 stopped로 진입할 때마다 새로 카운트 시작.
  useEffect(() => {
    if (!abandonOn) return;
    if (timerState !== "stopped") return;
    const id = window.setTimeout(async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) return;
        sendNotification({ title: "타이머가 멈춰 있어요", body: `${abandonMin}분 동안 아무 활동도 없어요. 다시 시작할까요?` });
      } catch (e) { console.error(e); }
    }, abandonMin * 60 * 1000);
    return () => window.clearTimeout(id);
  }, [abandonOn, abandonMin, timerState]);

  useEffect(() => {
    (async () => {
      try {
        let today = await fetchTodaySessions(TODAY_STR);
        // 지난번에 탭이 그냥 닫혀서 정상 종료 못 한 세션(ongoing)이 있으면 지금 시점으로 마감 처리
        const stale = today.filter(s => s.endReason === "ongoing");
        for (const s of stale) {
          await endTimerSession(s.id, "auto");
        }
        if (stale.length) today = await fetchTodaySessions(TODAY_STR);
        setSessions(today);
        const totalSec = today.reduce((sum, s) => {
          if (!s.endedAt) return sum;
          return sum + Math.max(0, Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000));
        }, 0);
        setTimerSec(totalSec);
        // 과거 날짜별 집중 시간 집계 로드
        setFocusSecByDate(await fetchFocusSecByDate());
      } catch (e) {
        // 조용히 삼키면 활동 기록 화면이 이유 없이 텅 비어 유저가 원인을 알 수 없음.
        notifyError("타이머 기록 불러오기 실패")(e);
      }
    })();
  }, []);

  // 재진입 가드 — 시작/정지 버튼을 rapid-click하거나 메인창/뜬창에서 같은 액션이
  // 동시에 들어오면 startTimerSession/endTimerSession이 중복 발화해 orphan 세션이
  // 남거나 currentSessionIdRef를 덮어써 첫 세션을 영구히 놓치는 버그가 있었음.
  // React setState는 배치되므로 setTimerState 직후에도 다음 호출은 여전히 이전 값을
  // 보므로, 동기적으로 검사 가능한 ref 게이트로 in-flight를 잠금.
  const timerActionBusyRef = useRef(false);

  const startSession = async () => {
    if (timerActionBusyRef.current) return;
    if (timerState === "running") return;
    timerActionBusyRef.current = true;
    setTimerState("running");
    setPomPhase("focus");
    setPomPhaseSec(0);
    try {
      const session = await startTimerSession(TODAY_STR);
      currentSessionIdRef.current = session.id;
      setSessions(s => [...s, session]);
    } catch (e) {
      // DB 실패를 조용히 삼키면 timerState는 running인데 currentSessionIdRef는 null이라
      // 유저는 타이머가 도는 것처럼 보이지만 실제 집중 시간이 기록되지 않는 데이터 유실이
      // 발생함. 상태를 되돌리고 사용자에게 알림.
      setTimerState("stopped");
      notifyError("타이머 시작 실패")(e);
    }
    finally { timerActionBusyRef.current = false; }
  };

  const endSession = async (reason: "manual" | "auto") => {
    if (timerActionBusyRef.current) return;
    // running/auto-paused 이외 상태에서 온 정지 요청은 무시(이미 stopped라면 no-op).
    if (timerState !== "running" && timerState !== "auto-paused") return;
    timerActionBusyRef.current = true;
    setTimerState(reason === "manual" ? "stopped" : "auto-paused");
    setPomPhase("focus");
    setPomPhaseSec(0);
    const sid = currentSessionIdRef.current;
    currentSessionIdRef.current = null;
    if (!sid) { timerActionBusyRef.current = false; return; }
    try {
      await endTimerSession(sid, reason);
      setSessions(s => s.map(x => x.id === sid ? { ...x, endedAt: new Date().toISOString(), endReason: reason } : x));
    } catch (e) {
      // 세션이 DB에서 'ongoing' 상태로 남게 되지만 다음 앱 시작 시 stale 정리가 자동으로
      // 마감해줌. 사용자에게는 알림만 표시.
      notifyError("타이머 정지 저장 실패")(e);
    }
    finally { timerActionBusyRef.current = false; }
  };

  // 오늘 타이머 기록을 통째로 초기화 — 실행 중이면 먼저 정지시키고, Supabase의 오늘 세션들도
  // 전부 지움. 사용자가 히스토리 팝오버 안의 "초기화" 버튼을 누를 때만 트리거됨.
  const resetTodayTimer = async () => {
    setTimerState("stopped");
    setPomPhase("focus");
    setPomPhaseSec(0);
    currentSessionIdRef.current = null;
    setSessions([]);
    setTimerSec(0);
    try {
      await deleteTodaySessions(TODAY_STR);
    } catch (e) {
      // 조용히 삼키면 로컬 UI는 초기화된 것처럼 보이지만 DB에는 오늘 세션이 그대로 남아
      // 다음 실행 시 되살아남. 사용자에게 알려서 재시도 유도.
      notifyError("타이머 기록 초기화 실패")(e);
    }
  };

  // 타이머 시작/정지는 오직 사용자가 버튼을 눌러서만 발생 — 창 포커스 등 자동 트리거 없음
  // (예전에는 창 포커스 이탈 시 자동 일시정지했지만 의도치 않게 끊기는 문제로 비활성화)

  // 뜬 타이머 창(별도 webview) 상태 훅을 여기서 관리 — GlobalTimer 내부에서 관리하면
  // 아래 브로드캐스트 effect가 창 오픈 여부를 알 수 없어 항상 매초 emit해야 했음.
  // 이제 창이 닫혀 있을 때는 emit 자체를 스킵.
  const floatWin = useTimerWindow();

  // 뜬 타이머 창(별도 webview)과의 상태 동기화 — 창이 열려 있을 때만 매초 브로드캐스트.
  useEffect(() => {
    if (!floatWin.isOpen) return;
    const pomPhaseRemainSec = Math.max(0, (pomPhase === "focus" ? pomWork : pomBreak) * 60 - pomPhaseSec);
    emit("timer:state", { timerState, timerSec, pomodoroOn, pomPhase, pomPhaseRemainSec });
  }, [floatWin.isOpen, timerState, timerSec, pomodoroOn, pomPhase, pomPhaseSec, pomWork, pomBreak]);

  // 뜬 타이머 창에서 온 시작/정지 요청 처리 — DB 쓰기는 항상 이 메인 창에서만 발생.
  //
  // 반드시 ref로 최신 startSession/endSession을 참조해야 함.
  // 예전엔 listen 콜백 안에서 startSession/endSession을 직접 호출했는데, 이 effect의 deps가
  // []라 마운트 시점의 함수(=마운트 시점의 timerState="stopped"를 클로저로 캡처)가 영구히
  // 잡혀 있었음. 결과적으로:
  //  - 뜬 창의 정지 버튼: endSession 안의 `if (timerState !== "running" && ...) return;`가
  //    캡처된 "stopped"를 보고 항상 early return → 정지 자체가 안 됨.
  //  - 뜬 창의 시작 버튼: 이미 running 상태여도 startSession의 `if (timerState === "running") return;`
  //    가드가 캡처된 "stopped"를 보고 통과 → 중복 세션 생성 가능.
  const startSessionRef = useRef<() => void>();
  const endSessionRef = useRef<(reason: "manual" | "auto") => void>();
  startSessionRef.current = startSession;
  endSessionRef.current = endSession;
  useEffect(() => {
    const unlisten = listen<{ type: "start" | "stop" }>("timer:action", (e) => {
      if (e.payload.type === "start") startSessionRef.current?.();
      else endSessionRef.current?.("manual");
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 자정 롤오버 — 탭을 안 닫고 자정을 넘기면 TODAY_STR이 그대로 어제로 남아있던 버그.
  // 30초마다 실제 날짜와 비교해서, 바뀌었으면 (1) 실행 중이던 세션을 어제 날짜로 마감하고
  // 실행 중이었다면 오늘 날짜로 새 세션을 이어서 시작 (2) 오늘의 세션/누적시간을 새로 불러옴
  // (3) dayTick을 올려서 TODAY_STR을 직접 참조하는 모든 컴포넌트를 리렌더시킴.
  //
  // deps는 빈 배열 — 예전엔 [timerState]라 시작/정지할 때마다 30초 인터벌이 재시작돼서
  // 자정 근처에 시작/정지가 잦으면 최악 30초 지연 가능성이 있었음. 인터벌은 마운트 시
  // 한 번만 걸고, 콜백 안에서 필요한 값(timerState)은 ref로 읽음.
  const [, setDayTick] = useState(0);
  const timerStateRef = useRef(timerState);
  useEffect(() => { timerStateRef.current = timerState; }, [timerState]);
  useEffect(() => {
    const id = setInterval(async () => {
      if (!syncTodayIfChanged()) return;
      const wasRunning = timerStateRef.current === "running";
      const sid = currentSessionIdRef.current;
      currentSessionIdRef.current = null;
      try {
        if (sid) await endTimerSession(sid, "auto");
        if (wasRunning) {
          const session = await startTimerSession(TODAY_STR);
          currentSessionIdRef.current = session.id;
          setSessions([session]);
        } else {
          setSessions(await fetchTodaySessions(TODAY_STR));
        }
        setTimerSec(0);
        // 어제 세션이 방금 마감돼 어제 집중 시간이 확정됐으니 히트맵 값도 갱신
        setFocusSecByDate(await fetchFocusSecByDate());
      } catch (e) {
        // 자정 롤오버 중 DB 오류가 나면 세션이 날짜 경계에 걸린 채 남고 집중 통계가
        // 어긋나므로 사용자에게 알림.
        notifyError("자정 롤오버 처리 실패")(e);
      }
      setDayTick(t => t + 1);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Calendar UI state
  const [calView, setCalView] = useState<"day" | "week" | "month">("week");
  const [calMode, setCalMode] = useState<"grid" | "list">("grid");
  const [templateOpen, setTemplateOpen] = useState(true);

  useEffect(() => {
    if (timerState !== "running") return;
    const id = setInterval(() => {
      // 뽀모도로 휴식 중이면 누적 집중 시간(timerSec)은 늘리지 않고 phase 시간만 늘림
      if (pomodoroOn && pomPhase === "break") {
        setPomPhaseSec(s => s + 1);
      } else {
        setTimerSec(s => s + 1);
        if (pomodoroOn) setPomPhaseSec(s => s + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timerState, pomodoroOn, pomPhase]);

  // 뽀모도로 phase 전환 — 집중이 pomWork분 지나면 자동으로 휴식, 휴식이 pomBreak분 지나면
  // 자동으로 다시 집중. 집중 종료 시 Supabase focus 세션 마감, 휴식 종료 시 새 세션 시작.
  //
  // 재진입 가드(pomTransitionBusyRef): endTimerSession/startTimerSession이 1초를 넘기면
  // 그 사이 tick effect가 pomPhaseSec를 target+1로 밀어 이 effect가 재발화 → 같은 phase에서
  // 두 번 마감/시작해 orphan 세션이 생기던 문제. React setState는 배치돼서 setPomPhase(0) 직전에
  // 재실행되면 여전히 이전 phase/pomPhaseSec를 보므로 ref로 동기 게이트.
  const pomTransitionBusyRef = useRef(false);
  useEffect(() => {
    if (!pomodoroOn || timerState !== "running") return;
    const targetSec = (pomPhase === "focus" ? pomWork : pomBreak) * 60;
    if (pomPhaseSec < targetSec) return;
    if (pomTransitionBusyRef.current) return;
    pomTransitionBusyRef.current = true;

    (async () => {
      try {
        if (pomPhase === "focus") {
          const sid = currentSessionIdRef.current;
          currentSessionIdRef.current = null;
          if (sid) {
            try {
              // 뽀모도로 자동 phase 전환은 사용자 수동 정지가 아니므로 "auto"로 마감.
              // (히스토리 팝오버가 "manual"(■)로 표시하던 semantic 어긋남을 바로잡음)
              await endTimerSession(sid, "auto");
              setSessions(s => s.map(x => x.id === sid ? { ...x, endedAt: new Date().toISOString(), endReason: "auto" } : x));
            } catch (e) { console.error(e); }
          }
          setPomPhase("break");
          setPomPhaseSec(0);
          notifyPomodoro("집중 완료", `${pomBreak}분 쉬어요`);
        } else {
          try {
            const session = await startTimerSession(TODAY_STR);
            currentSessionIdRef.current = session.id;
            setSessions(s => [...s, session]);
          } catch (e) { console.error(e); }
          setPomPhase("focus");
          setPomPhaseSec(0);
          notifyPomodoro("휴식 완료", `다시 ${pomWork}분 집중해요`);
        }
      } finally {
        pomTransitionBusyRef.current = false;
      }
    })();
  }, [pomPhaseSec, pomPhase, pomodoroOn, timerState, pomWork, pomBreak]);

  const toggleBlock = (id: string) => {
    const target = blocks.find(b => b.id === id);
    if (!target) return;
    const completed = !target.completed;
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, completed } : b));
    patchBlock(id, { completed }).catch(notifyError("완료 상태 저장 실패"));
  };

  // Optimistic insert: shows instantly with a temp id, then swapped for the real DB row.
  // openInline은 캘린더 클릭으로 만든 이름 없는 블록 — 상세 패널을 곧바로 띄우고 제목 편집에
  // 포커스를 주며, 매칭 템플릿을 즉시 사이드바에 자동 추가함(justCreatedBlockId로 추적해서
  // 나중에 사용자가 제목을 바꾸면 그 템플릿의 이름도 함께 갱신). 예전엔 제목이 저장되는
  // 시점에만 템플릿을 만들어서, 사용자가 이름을 안 바꾸고 그대로 두면 캘린더 위에만 남고
  // 사이드바에 등록되지 않아 다음 날짜에 재사용할 수 없던 문제 수정.
  // 이 경로에선 낙관적 temp id 없이 DB 저장을 기다렸다가 진짜 id로 시작 — 안 그러면 temp→real
  // 스왑 시 상세 패널(key={id})이 리마운트되며 사용자가 입력 중이던 제목이 날아감.
  const addBlock = (block: Block, options?: { select?: boolean; openInline?: boolean }) => {
    if (options?.select || options?.openInline) {
      insertBlock(block)
        .then(async real => {
          setBlocks(bs => [...bs, real]);
          if (options.openInline) {
            // 매칭 템플릿을 먼저 만들어 templateId까지 붙인 뒤에 상세 패널을 오픈.
            // 이렇게 하면 사용자가 초 단위로 빠르게 제목을 입력해도, onTitleSave가
            // 실행되는 시점에 selectedBlock.templateId가 이미 세팅돼 있어서 rename
            // 브랜치로 들어가고 중복 템플릿이 생성되지 않음.
            try {
              const tpl = await createTemplate({ title: real.title, color: real.color, tags: real.tags ?? [] });
              setTemplates(ts => [...ts, tpl]);
              const linked = { ...real, templateId: tpl.id };
              setBlocks(bs => bs.map(b => b.id === real.id ? linked : b));
              setSelectedBlock(linked);
              setJustCreatedBlockId(real.id);
              patchBlock(real.id, { templateId: tpl.id }).catch(notifyError("템플릿 연결 저장 실패"));
            } catch (e) {
              // 템플릿 생성이 실패해도 블록 자체는 정상이므로 패널은 그대로 열어줌.
              notifyError("템플릿 자동 생성 실패")(e);
              setSelectedBlock(real);
              setJustCreatedBlockId(real.id);
            }
          } else {
            setSelectedBlock(real);
          }
        })
        .catch(notifyError("블록 추가 실패"));
      return;
    }
    const tempId = `temp-${Date.now()}`;
    setBlocks(bs => [...bs, { ...block, id: tempId }]);
    insertBlock(block)
      .then(real => setBlocks(bs => bs.map(b => (b.id === tempId ? real : b))))
      .catch(e => { setBlocks(bs => bs.filter(b => b.id !== tempId)); notifyError("블록 추가 실패")(e); });
  };

  // Local-only update — used for high-frequency visual feedback (e.g. resize drag) where
  // hitting the DB on every mousemove would be wasteful. Persisted separately on drag-end.
  const updateBlockLocal = (id: string, changes: Partial<Block>) =>
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, ...changes } : b));

  const updateBlock = (id: string, changes: Partial<Block>) => {
    updateBlockLocal(id, changes);
    patchBlock(id, changes).catch(notifyError("블록 저장 실패"));
  };

  const deleteBlock = (id: string) => {
    setBlocks(bs => bs.filter(b => b.id !== id));
    setSelectedBlock(prev => prev?.id === id ? null : prev);
    deleteBlockRow(id).catch(notifyError("블록 삭제 실패"));
  };

  const deleteRepeatGroup = (id: string, fromDate: string) => {
    const block = blocks.find(b => b.id === id);
    const groupId = block?.repeatGroupId;
    if (!groupId) {
      setBlocks(bs => bs.filter(b => b.id !== id));
      deleteBlockRow(id).catch(notifyError("블록 삭제 실패"));
    } else {
      setBlocks(bs => bs.filter(b => !(b.repeatGroupId === groupId && b.date >= fromDate)));
      apiDeleteRepeatGroup(groupId, fromDate).catch(notifyError("반복 블록 삭제 실패"));
    }
    setSelectedBlock(null);
  };

  // Generate repeat instances for a block.
  // pushInstance는 endDate 초과 시 인스턴스만 스킵 → 이걸로 loop가 자동 멈추진 않으므로
  // daily/weekly 루프도 endDate 초과를 감지해서 early break해야 함(안 하면 daily는 14일,
  // weekly는 8주까지 무의미하게 loop만 돌아감).
  const generateRepeatInstances = (block: Block, repeat: BlockRepeat): Block[] => {
    const instances: Block[] = [];
    const groupId = block.repeatGroupId || `rg-${block.id}`;
    const origin = parseLocalDate(block.date);
    const dur = (block.endH * 60 + block.endM) - (block.startH * 60 + block.startM);

    const pushInstance = (d: Date, idx: number) => {
      const dateStr = toDateStr(d);
      if (repeat.endType === "date" && dateStr > repeat.endDate) return;
      instances.push({
        ...block, id: `b-${Date.now()}-${idx}`,
        date: dateStr, completed: false,
        repeatGroupId: groupId, repeat,
      });
    };

    // 종료 조건별 상한:
    //  - count: 요청한 횟수를 정확히 채우도록 상한 계산
    //  - date : 종료 날짜까지 실제 커버할 수 있도록 상한 크게(내부 early break가 종료일에서 끊음)
    //  - none : 앞으로 보여줄 기본 롤링 윈도우(daily 14일 / weekly 8주)
    // 예전엔 daily/weekly 모두 상한이 14일 / 8주로 고정돼서, 사용자가 '30회 반복' 이나
    // '3개월 후까지'를 골라도 그 안에서만 인스턴스가 만들어지고 나머지가 소리 없이 잘리는
    // 문제가 있었음.
    if (repeat.type === "daily") {
      const maxDays = repeat.endType === "count"
        ? repeat.endCount
        : repeat.endType === "date"
          ? 365
          : 14;
      for (let i = 1; i <= maxDays && (repeat.endType !== "count" || instances.length < repeat.endCount); i++) {
        const d = new Date(origin); d.setDate(origin.getDate() + i);
        if (repeat.endType === "date" && toDateStr(d) > repeat.endDate) break;
        pushInstance(d, i);
      }
    } else {
      const daysPerWeek = Math.max(1, repeat.days.length);
      const maxWeeks = repeat.endType === "count"
        ? Math.ceil(repeat.endCount / daysPerWeek)
        : repeat.endType === "date"
          ? 53
          : 8;
      let count = 0;
      for (let week = 1; week <= maxWeeks; week++) {
        for (const day of repeat.days.slice().sort()) {
          if (repeat.endType === "count" && count >= repeat.endCount) break;
          const d = new Date(origin);
          const diff = (day - origin.getDay() + 7) % 7 || 7;
          d.setDate(origin.getDate() + diff + (week - 1) * 7);
          if (repeat.endType === "date" && toDateStr(d) > repeat.endDate) return instances;
          pushInstance(d, count++);
        }
      }
    }
    return instances;
  };

  const refetchBlocks = async () => {
    try { setBlocks(await fetchBlocks()); } catch (e) { console.error(e); }
  };

  const setBlockRepeat = (id: string, repeat: BlockRepeat) => {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    const groupId = `rg-${id}`;
    const updated = { ...block, repeat, repeatGroupId: groupId };
    const instances = generateRepeatInstances(updated, repeat);

    // optimistic: show immediately with temp ids, then reconcile against the DB
    setBlocks(bs => {
      const filtered = bs.filter(b => b.repeatGroupId !== groupId || b.id === id);
      return [...filtered.map(b => (b.id === id ? updated : b)), ...instances];
    });

    (async () => {
      try {
        await patchBlock(id, { repeat, repeatGroupId: groupId });
        // 재저장 시 이전 규칙으로 만든 인스턴스가 DB에 남아있으면 새/구가 섞이므로 먼저 정리.
        // origin은 유지하고 그룹의 나머지만 삭제한 뒤 새 인스턴스를 insert.
        await deleteRepeatInstancesExceptOrigin(groupId, id);
        if (instances.length) await insertBlocksBulk(instances);
        await refetchBlocks();
      } catch (e) {
        // 조용히 삼키면 patchBlock만 성공하고 insertBlocksBulk가 실패한 경우 원본에는
        // 반복 규칙이 저장됐지만 인스턴스는 생성되지 않아 사용자가 이유를 알기 어려움.
        notifyError("반복 저장 실패")(e);
        // 낙관적으로 추가한 temp instance들이 로컬 상태에 유령 블록으로 남지 않도록 DB와 동기화.
        try { await refetchBlocks(); } catch {}
      }
    })();
  };

  const saveScheduleTemplate = (name: string, date: string) => {
    const dayBlocks = blocks.filter(b => b.date === date && !b.parentBlockId);
    if (!dayBlocks.length) return;
    const blocksSnapshot = dayBlocks.map(b => ({ title: b.title, color: b.color, startH: b.startH, startM: b.startM, endH: b.endH, endM: b.endM, tags: b.tags, memo: b.memo }));
    const tempId = `temp-${Date.now()}`;
    setScheduleTemplates(ts => [...ts, { id: tempId, name, blocks: blocksSnapshot }]);
    createScheduleTemplateRow(name, blocksSnapshot)
      .then(real => setScheduleTemplates(ts => ts.map(t => (t.id === tempId ? real : t))))
      .catch(e => {
        setScheduleTemplates(ts => ts.filter(t => t.id !== tempId));
        // 저장 실패를 조용히 롤백만 하면 사용자는 '저장'을 눌렀는데도 목록에서 사라져
        // 원인을 알 수 없음.
        notifyError("일정 템플릿 저장 실패")(e);
      });
  };

  const applyScheduleTemplate = (templateId: string, targetDate: string) => {
    const tpl = scheduleTemplates.find(t => t.id === templateId);
    if (!tpl) return;
    const existing = blocks.filter(b => b.date === targetDate && !b.parentBlockId);
    const newBlocks = tpl.blocks
      .filter(tb => !existing.some(b => tb.startH * 60 + tb.startM < b.endH * 60 + b.endM && tb.endH * 60 + tb.endM > b.startH * 60 + b.startM))
      .map((tb, i) => ({ ...tb, id: `temp-tpl-${Date.now()}-${i}`, date: targetDate, completed: false }));
    if (!newBlocks.length) return;
    setBlocks(bs => [...bs, ...newBlocks]);
    insertBlocksBulk(newBlocks)
      .then(() => refetchBlocks())
      .catch(async (e) => {
        notifyError("일정 템플릿 적용 실패")(e);
        // 낙관적으로 추가한 temp-tpl 블록이 로컬 상태에 남지 않도록 DB와 동기화.
        try { await refetchBlocks(); } catch {}
      });
  };

  const deleteScheduleTemplate = (id: string) => {
    setScheduleTemplates(ts => ts.filter(t => t.id !== id));
    deleteScheduleTemplateRow(id).catch(notifyError("일정 템플릿 삭제 실패"));
  };

  const toggleDeadline = (id: string) => {
    const target = deadlines.find(d => d.id === id);
    if (!target) return;
    const completed = !target.completed;
    setDeadlines(ds => ds.map(d => d.id === id ? { ...d, completed } : d));
    toggleDeadlineRow(id, completed).catch(notifyError("마감 저장 실패"));
  };

  const deleteDeadline = (id: string) => {
    setDeadlines(ds => ds.filter(d => d.id !== id));
    deleteDeadlineRow(id).catch(notifyError("마감 삭제 실패"));
  };

  const addTemplate = (t: { title: string; color: string; tags: string[] }) => {
    const tempId = `temp-${Date.now()}`;
    setTemplates(ts => [...ts, { id: tempId, ...t }]);
    createTemplate(t)
      .then(real => setTemplates(ts => ts.map(x => (x.id === tempId ? real : x))))
      .catch(e => { setTemplates(ts => ts.filter(x => x.id !== tempId)); notifyError("블록 템플릿 추가 실패")(e); });
  };

  // 템플릿 삭제 — 이미 이 템플릿으로 만들어진 블록은 그대로 두고 template_id만 NULL로 끊김.
  const deleteTemplate = (id: string) => {
    setTemplates(ts => ts.filter(x => x.id !== id));
    setBlocks(bs => bs.map(b => b.templateId === id ? { ...b, templateId: undefined } : b));
    deleteTemplateRow(id).catch(notifyError("블록 템플릿 삭제 실패"));
  };

  const addDeadline = (d: { title: string; dueDate: string }) => {
    const tempId = `temp-${Date.now()}`;
    setDeadlines(ds => [...ds, { id: tempId, title: d.title, dueDate: d.dueDate, completed: false }]);
    createDeadline(d)
      .then(real => setDeadlines(ds => ds.map(x => (x.id === tempId ? real : x))))
      .catch(e => { setDeadlines(ds => ds.filter(x => x.id !== tempId)); notifyError("마감 추가 실패")(e); });
  };

  const todayBlocks = blocks.filter(b => b.date === TODAY_STR && !b.parentBlockId);
  const completedCount = todayBlocks.filter(b => b.completed).length;
  const completionRate = todayBlocks.length > 0 ? Math.round((completedCount / todayBlocks.length) * 100) : 0;
  const totalPlanMin = todayBlocks.reduce((s, b) => s + durMin(b), 0);

  const navItems: { id: Section; label: string; Icon: React.FC<{ size: number }> }[] = [
    { id: "today", label: "오늘", Icon: Clock },
    { id: "calendar", label: "캘린더", Icon: Calendar },
    { id: "deadlines", label: "마감 작업", Icon: Target },
    { id: "grass", label: "활동 기록 & 통계", Icon: BarChart2 },
    { id: "memo", label: "메모", Icon: FileText },
    { id: "settings", label: "설정", Icon: Settings },
  ];

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground text-sm">
        불러오는 중...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm">
        <div className="text-center">
          <div className="text-destructive font-medium mb-1">데이터를 불러오지 못했어요</div>
          <div className="text-muted-foreground text-xs">{loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">

      {/* ── Unified header: 앱 이름·날짜 + 타이머 + 달성률 + 창 컨트롤을 한 줄에 통합.
             decorations:false 상태에서 OS 크롬 대체 겸용 — 빈 영역 드래그로 창 이동,
             드래그 리전 위에서 더블클릭하면 최대화 토글(Windows 표준 동작). ── */}
      <header
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) return;
          const win = getCurrentWindow();
          win.isMaximized().then(m => (m ? win.unmaximize() : win.maximize())).catch(() => {});
        }}
        className="flex items-stretch h-14 border-b border-border bg-card flex-shrink-0"
      >
        {/* Left: 앱 아이덴티티 */}
        <div data-tauri-drag-region className="flex items-center gap-3 pl-4 pr-3 flex-shrink-0">
          <div data-tauri-drag-region className="flex items-center gap-2 pointer-events-none">
            <PlanoryMark size={16} />
            <span className="text-[13px] font-semibold tracking-tight text-foreground/85">Planory</span>
          </div>
        </div>

        {/* Center: 타이머 위젯 + 컴팩트 달성률 배지.
             달성률은 원래 오른쪽 별도 블록에 있었는데 타이머 옆으로 옮겨 시선 이동을 줄임. */}
        <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
          <GlobalTimer
            timerState={timerState}
            timerSec={timerSec}
            sessions={sessions}
            onStart={startSession}
            onManualStop={() => endSession("manual")}
            onReset={resetTodayTimer}
            pomodoroOn={pomodoroOn}
            pomPhase={pomPhase}
            pomPhaseRemainSec={Math.max(0, (pomPhase === "focus" ? pomWork : pomBreak) * 60 - pomPhaseSec)}
            floatWin={floatWin}
          />
          <div
            title="오늘 달성률"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/40 border border-border"
          >
            <CircleProgress value={completionRate} size={16} strokeWidth={2.5} />
            <span className="text-[11px] font-medium tabular-nums text-foreground/85">{completionRate}%</span>
          </div>
        </div>

        {/* Right: 창 컨트롤(min/max/close). Fitts's law상 오른쪽 모서리에 딱 붙어야 클릭이 편하므로
            여기엔 padding을 두지 않음. */}
        <div className="flex items-stretch flex-shrink-0">
          <WindowControls />
        </div>
      </header>

      {/* ── Body (sidebar + main + panel) ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Sidebar */}
        <nav className="w-48 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col py-4">
          <div className="flex flex-col gap-0.5 px-2">
            {navItems.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all ${
                  section === id
                    ? "bg-primary text-primary-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-hidden flex min-w-0">
          {section === "today" && (
            <TodaySection
              blocks={todayBlocks}
              deadlines={deadlines.filter(d => !d.completed)}
              completionRate={completionRate}
              onToggle={toggleBlock}
              onToggleDeadline={toggleDeadline}
              onSelect={setSelectedBlock}
              onGoToCalendar={() => setSection("calendar")}
            />
          )}
          {section === "calendar" && (
            <CalendarSection
              blocks={blocks}
              deadlines={deadlines}
              templates={templates}
              calView={calView}
              setCalView={setCalView}
              calMode={calMode}
              setCalMode={setCalMode}
              templateOpen={templateOpen}
              setTemplateOpen={setTemplateOpen}
              onSelect={setSelectedBlock}
              onToggle={toggleBlock}
              onToggleDeadline={toggleDeadline}
              onAddBlock={addBlock}
              onUpdateBlock={updateBlock}
              onUpdateBlockLocal={updateBlockLocal}
              onDeleteBlock={deleteBlock}
              scheduleTemplates={scheduleTemplates}
              onSaveTemplate={saveScheduleTemplate}
              onApplyTemplate={applyScheduleTemplate}
              onDeleteTemplate={deleteScheduleTemplate}
              onAddTemplate={addTemplate}
              onDeleteBlockTemplate={deleteTemplate}
              paletteColors={paletteColors}
              onAddPaletteColor={addPaletteColor}
              onRemovePaletteColor={removePaletteColor}
            />
          )}
          {section === "deadlines" && (
            <DeadlinesSection deadlines={deadlines} onToggle={toggleDeadline} onAddDeadline={addDeadline} onDelete={deleteDeadline} />
          )}
          {section === "grass" && (
            <GrassSection
              completionRate={completionRate}
              blocks={blocks.filter(b => !b.parentBlockId)}
              timerSec={timerSec}
              totalPlanMin={totalPlanMin}
              focusSecByDate={focusSecByDate}
            />
          )}
          {section === "memo" && <MemoSection />}
          {section === "settings" && (
            <SettingsSection
              pomodoroOn={pomodoroOn} setPomodoroOn={setPomodoroOn}
              pomWork={pomWork} setPomWork={setPomWork}
              pomBreak={pomBreak} setPomBreak={setPomBreak}
              abandonOn={abandonOn} setAbandonOn={setAbandonOn}
              abandonMin={abandonMin} setAbandonMin={setAbandonMin}
              darkMode={darkMode} setDarkMode={setDarkMode}
            />
          )}
        </main>

        {/* Block detail side panel — no timer */}
        {selectedBlock && (
          <BlockDetailPanel
            key={selectedBlock.id}
            block={selectedBlock}
            initialEditTitle={selectedBlock.id === justCreatedBlockId}
            childBlocks={blocks.filter(b => b.parentBlockId === selectedBlock.id)}
            templates={templates}
            sameDayBlocks={blocks.filter(b => b.date === selectedBlock.date && !b.parentBlockId && b.id !== selectedBlock.id)}
            onClose={() => setSelectedBlock(null)}
            onToggle={() => {
              toggleBlock(selectedBlock.id);
              setSelectedBlock({ ...selectedBlock, completed: !selectedBlock.completed });
            }}
            onDelete={() => deleteBlock(selectedBlock.id)}
            onDeleteRepeatGroup={(fromDate) => deleteRepeatGroup(selectedBlock.id, fromDate)}
            onSetRepeat={(repeat) => setBlockRepeat(selectedBlock.id, repeat)}
            onMemoSave={(memo) => {
              updateBlock(selectedBlock.id, { memo });
              setSelectedBlock({ ...selectedBlock, memo });
            }}
            onColorSave={(color) => {
              const wasJustCreated = selectedBlock.id === justCreatedBlockId;
              updateBlock(selectedBlock.id, { color });
              setSelectedBlock({ ...selectedBlock, color });
              // 방금 만든 블록의 자동 템플릿은 아직 사용자가 다듬는 중이므로 색도 함께 동기화.
              // 안 그러면 유저가 색을 바꿔도 사이드바 템플릿은 원본 색이라 나중에 드래그하면
              // 자기가 지정한 색이 아닌 원본 색으로 블록이 생성돼 헷갈림.
              if (wasJustCreated && selectedBlock.templateId) {
                const tplId = selectedBlock.templateId;
                setTemplates(ts => ts.map(t => t.id === tplId ? { ...t, color } : t));
                updateTemplateRow(tplId, { color }).catch(notifyError("템플릿 색 저장 실패"));
              }
            }}
            paletteColors={paletteColors}
            onAddPaletteColor={addPaletteColor}
            onRemovePaletteColor={removePaletteColor}
            onTitleSave={(title) => {
              const wasJustCreated = selectedBlock.id === justCreatedBlockId;
              updateBlock(selectedBlock.id, { title });
              setSelectedBlock({ ...selectedBlock, title });
              // 캘린더에서 방금 만든 블록은 addBlock(openInline)에서 매칭 템플릿이 이미
              // 만들어져 templateId로 연결돼 있음. 이 경우 그 템플릿 이름도 함께 갱신.
              // 예외 대비로 만약 아직 연결이 없다면 여기서 만들어줌(레거시 데이터/실패 복구).
              if (wasJustCreated) {
                const tplId = selectedBlock.templateId;
                if (tplId) {
                  setTemplates(ts => ts.map(t => t.id === tplId ? { ...t, title } : t));
                  updateTemplateRow(tplId, { title }).catch(notifyError("템플릿 이름 저장 실패"));
                } else {
                  createTemplate({ title, color: selectedBlock.color, tags: selectedBlock.tags })
                    .then(tpl => {
                      setTemplates(ts => [...ts, tpl]);
                      updateBlock(selectedBlock.id, { templateId: tpl.id });
                      setSelectedBlock(prev => (prev && prev.id === selectedBlock.id ? { ...prev, templateId: tpl.id } : prev));
                    })
                    .catch(notifyError("템플릿 자동 생성 실패"));
                }
                setJustCreatedBlockId(prev => (prev === selectedBlock.id ? null : prev));
              }
            }}
            onSelectChild={setSelectedBlock}
            onToggleChild={toggleBlock}
            onDeleteChild={deleteBlock}
            onAddTimeblockChild={(child) => addBlock({
              id: `b-${Date.now()}`,
              parentBlockId: selectedBlock.id,
              date: selectedBlock.date,
              completed: false,
              memo: "",
              ...child,
            })}
            onGoToParent={() => {
              const parent = blocks.find(b => b.id === selectedBlock.parentBlockId);
              if (parent) setSelectedBlock(parent);
            }}
            onSetNextBlock={(nextBlockId) => {
              // null은 "연결 해제"라는 의미 있는 값이라 undefined(patchBlock이 "건드리지 않음"으로
              // 해석)로 뭉개면 안 됨 — 그대로 넘겨야 DB에서도 실제로 지워짐
              updateBlock(selectedBlock.id, { nextBlockId } as Partial<Block>);
              setSelectedBlock({ ...selectedBlock, nextBlockId: nextBlockId ?? undefined });
            }}
          />
        )}
      </div>
      <AppTooltipRoot />
      <Toaster position="bottom-right" duration={4000} />
    </div>
  );
}

// ── Window controls (Tauri decorations:false 상태에서 min/max/close 대체) ────
// 통합 헤더의 우측 끝에 붙어 창 오른쪽 모서리에 딱 닿음(Windows Fitts's law상 클릭 편의).
// 최대화 상태는 win.onResized로 감지해 아이콘을 restore-down으로 바꿈.
function WindowControls() {
  const [isMax, setIsMax] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMax).catch(() => {});
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    win.onResized(() => { win.isMaximized().then(setIsMax).catch(() => {}); })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const toggleMax = async () => {
    const win = getCurrentWindow();
    try {
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } catch (e) { console.error("최대화 토글 실패", e); }
  };

  const btnBase = "h-full w-11 flex items-center justify-center transition-colors text-muted-foreground";

  return (
    <div className="flex items-stretch h-full">
      <button
        onClick={() => getCurrentWindow().minimize().catch(e => console.error("최소화 실패", e))}
        className={`${btnBase} hover:bg-muted`}
        aria-label="최소화"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={toggleMax}
        className={`${btnBase} hover:bg-muted`}
        aria-label={isMax ? "이전 크기로" : "최대화"}
      >
        {isMax ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        onClick={() => getCurrentWindow().close().catch(e => console.error("닫기 실패", e))}
        className={`${btnBase} hover:bg-destructive hover:text-destructive-foreground`}
        aria-label="닫기"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Planory 브랜드 마크 ─────────────────────────────────────────────
// 3-pill 계단 = 오늘까지 쌓여 온 기록(plan+history). 좌상단 앱 아이덴티티와
// Tauri 패키지 아이콘(src-tauri/icons/planory-source.svg)의 축소판.
// 앱 아이콘 원본은 여백이 큰 512×512 타일이라 그대로 작게 그리면 알약이 너무 작게 보임.
// 헤더에선 타일 배경을 빼고 알약 3개 주변만 잘라낸 뷰박스로 그려서 텍스트 높이에 맞춰
// 시각적으로 균형 잡히게 함. size는 세로 높이 기준.
function PlanoryMark({ size = 20 }: { size?: number }) {
  const contentAspect = 272 / 114;
  return (
    <svg
      width={Math.round(size * contentAspect)}
      height={size}
      viewBox="120 195 272 114"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="128" y="283" width="200" height="22" rx="11" ry="11" fill="#384B60" />
      <rect x="156" y="245" width="200" height="22" rx="11" ry="11" fill="#5F8FBF" />
      <rect x="184" y="207" width="200" height="22" rx="11" ry="11" fill="#BEDAFA" />
    </svg>
  );
}

// ── Global Timer Widget ────────────────────────────────────────────
// 3-state: 실행중 / 자동 일시정지 / 수동 정지. "자동 일시정지"는 버튼으로 들어가는 상태가
// 아니라 창 포커스 변화로만 진입·해제됨(App의 onFocusChanged 로직 참고) — 그래서 여기엔
// "일시정지" 버튼이 없고 시작/정지만 있음.
function GlobalTimer({
  timerState, timerSec, sessions, onStart, onManualStop, onReset,
  pomodoroOn, pomPhase, pomPhaseRemainSec, floatWin,
}: {
  timerState: TimerState;
  timerSec: number;
  sessions: TimerSession[];
  onStart: () => void;
  onManualStop: () => void;
  onReset: () => void;
  pomodoroOn: boolean;
  pomPhase: "focus" | "break";
  pomPhaseRemainSec: number;
  floatWin: ReturnType<typeof useTimerWindow>;
}) {
  const isRunning = timerState === "running";
  const isAutoPaused = timerState === "auto-paused";
  const isStopped = timerState === "stopped";
  const isBreak = pomodoroOn && isRunning && pomPhase === "break";
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 px-4 py-1.5 rounded-xl border transition-all ${
          isBreak
            ? "bg-indigo-50 border-indigo-200"
            : isRunning
            ? "bg-sky-50 border-sky-200"
            : isAutoPaused
            ? "bg-amber-50 border-amber-200"
            : "bg-muted/40 border-border"
        }`}
      >
        {/* State indicator */}
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full flex-shrink-0 ${
              isBreak ? "bg-indigo-500 animate-pulse" :
              isRunning ? "bg-sky-500 animate-pulse" :
              isAutoPaused ? "bg-amber-400" :
              "bg-muted-foreground/40"
            }`}
          />
          <span
            className={`text-[11px] font-medium w-16 ${
              isBreak ? "text-indigo-700" :
              isRunning ? "text-sky-700" :
              isAutoPaused ? "text-amber-700" :
              "text-muted-foreground"
            }`}
          >
            {isBreak ? "휴식 중" : isRunning ? "집중 중" : isAutoPaused ? "자동 정지" : "정지됨"}
          </span>
        </div>

        {/* 뽀모도로 phase 남은 시간 — 활성일 때만 노출 */}
        {pomodoroOn && isRunning && (
          <span
            className={`text-[11px] tabular-nums font-medium ${isBreak ? "text-indigo-700" : "text-sky-700"}`}
            title={isBreak ? "휴식 남은 시간" : "집중 남은 시간"}
          >
            {fmtSec(pomPhaseRemainSec)}
          </span>
        )}

        {/* Timer display — click to see today's focus/rest session history */}
        <button
          onClick={() => setShowHistory(v => !v)}
          title="오늘의 집중 기록 보기"
          className={`text-xl font-medium tabular-nums w-20 text-center rounded-md hover:bg-black/5 transition-colors ${
            isRunning ? "text-sky-800" :
            isAutoPaused ? "text-amber-800" :
            "text-muted-foreground"
          }`}
                 >
          {fmtSec(timerSec)}
        </button>

        {/* Controls */}
        <div className="flex items-center gap-1">
          {isStopped && (
            <button
              onClick={onStart}
              title="타이머 시작"
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 transition-colors"
            >
              <Play size={11} fill="white" /> 시작
            </button>
          )}
          {isRunning && (
            <button
              onClick={onManualStop}
              title="정지"
              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
            >
              <Pause size={14} fill="currentColor" />
            </button>
          )}
          {isAutoPaused && (
            <>
              <button
                onClick={onStart}
                title="재시작"
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 transition-colors"
              >
                <Play size={11} fill="white" /> 재시작
              </button>
              <button
                onClick={onManualStop}
                title="정지"
                className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
              >
                <Pause size={14} fill="currentColor" />
              </button>
            </>
          )}

          {/* 다른 앱 위에서도 계속 뜨는 테두리 없는 타이머 창 */}
          <button
            onClick={() => (floatWin.isOpen ? floatWin.close() : floatWin.open())}
            title={floatWin.isOpen ? "뜬 타이머 닫기" : "다른 앱에서도 보이게 띄우기"}
            className={`p-1.5 rounded-lg transition-colors ${floatWin.isOpen ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
          >
            <PictureInPicture size={13} />
          </button>
        </div>
      </div>

      {showHistory && (
        <TimerHistoryPopover sessions={sessions} onClose={() => setShowHistory(false)} onReset={() => { onReset(); setShowHistory(false); }} />
      )}
    </div>
  );
}

// ── Timer session history popover ───────────────────────────────────
function TimerHistoryPopover({ sessions, onClose, onReset }: { sessions: TimerSession[]; onClose: () => void; onReset: () => void }) {
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const now = Date.now();
  const [confirmReset, setConfirmReset] = useState(false);

  type Segment = { type: "focus" | "rest"; startMs: number; endMs: number | null; endReason?: "manual" | "auto" | "ongoing" };
  const segments: Segment[] = [];
  sorted.forEach((s, i) => {
    const startMs = new Date(s.startedAt).getTime();
    const endMs = s.endedAt ? new Date(s.endedAt).getTime() : null;
    if (i > 0) {
      const prevEndedAt = sorted[i - 1].endedAt;
      if (prevEndedAt) {
        segments.push({ type: "rest", startMs: new Date(prevEndedAt).getTime(), endMs: startMs });
      }
    }
    segments.push({ type: "focus", startMs, endMs, endReason: s.endReason });
  });

  const fmtClock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const fmtDur = (ms: number) => {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  };

  const totalFocusMs = segments.filter(s => s.type === "focus").reduce((sum, s) => sum + ((s.endMs ?? now) - s.startMs), 0);
  const totalRestMs = segments.filter(s => s.type === "rest").reduce((sum, s) => sum + ((s.endMs ?? now) - s.startMs), 0);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-72 bg-card border border-border rounded-xl shadow-lg z-50 p-3">
        <div className="flex items-center justify-between gap-3 pb-2 mb-2 border-b border-border">
          <div>
            <div className="text-[10px] text-muted-foreground">오늘 총 집중</div>
            <div className="text-sm font-medium" >{fmtDur(totalFocusMs)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">오늘 총 휴식</div>
            <div className="text-sm font-medium" >{fmtDur(totalRestMs)}</div>
          </div>
        </div>
        {segments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-3">아직 오늘 기록이 없어요</p>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {segments.slice().reverse().map((seg, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                {seg.type === "focus" ? (
                  <span className="size-1.5 rounded-full bg-sky-500 flex-shrink-0" />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                )}
                <span className="text-muted-foreground" >
                  {fmtClock(seg.startMs)}–{seg.endMs ? fmtClock(seg.endMs) : "진행중"}
                </span>
                <span className={seg.type === "focus" ? "font-medium" : "text-muted-foreground"}>
                  {seg.type === "focus" ? "집중" : "휴식"} {fmtDur((seg.endMs ?? now) - seg.startMs)}
                </span>
                {seg.type === "focus" && seg.endReason && seg.endReason !== "ongoing" && (
                  <span title={seg.endReason === "manual" ? "수동 정지" : "자동 정지(탭 이탈)"} className="ml-auto text-[9px] text-muted-foreground/70">
                    {seg.endReason === "manual" ? "■" : "↺"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 오늘 기록 초기화 — 실수 방지를 위해 두 단계 클릭(첫 클릭 → 확인 상태, 다시 클릭 → 실행) */}
        <div className="pt-2 mt-2 border-t border-border flex items-center justify-end gap-2">
          {confirmReset ? (
            <>
              <span className="text-[10px] text-muted-foreground">정말 초기화할까요?</span>
              <button onClick={() => setConfirmReset(false)} className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded">취소</button>
              <button onClick={onReset} className="text-[10px] text-destructive font-medium hover:bg-destructive/10 px-2 py-1 rounded">초기화</button>
            </>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded"
              title="오늘 타이머 기록 전부 삭제"
            >
              오늘 기록 초기화
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Circle Progress ────────────────────────────────────────────────
function CircleProgress({ value, size, strokeWidth = 5 }: { value: number; size: number; strokeWidth?: number }) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (value / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E4EEF7" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#5AA9E6" strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.4s ease" }}
      />
    </svg>
  );
}

// ── Today Section ──────────────────────────────────────────────────
function TodaySection({
  blocks, deadlines, completionRate, onToggle, onToggleDeadline, onSelect, onGoToCalendar,
}: {
  blocks: Block[];
  deadlines: Deadline[];
  completionRate: number;
  onToggle: (id: string) => void;
  onToggleDeadline: (id: string) => void;
  onSelect: (b: Block) => void;
  onGoToCalendar: () => void;
}) {
  const sorted = [...blocks].sort((a, b) => a.startH * 60 + a.startM - (b.startH * 60 + b.startM));
  const done = blocks.filter(b => b.completed).length;
  const overdueDeadlines = deadlines.filter(d => d.dueDate < TODAY_STR);
  const todayDeadlines = deadlines.filter(d => d.dueDate === TODAY_STR);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 py-8">
        {/* 오늘 달성률은 상단 헤더 타이머 옆 배지로 대체 — 여기선 별도 요약을 두지 않음. */}

        {/* Overdue deadlines — shown inline with warning */}
        {overdueDeadlines.length > 0 && (
          <div className="mb-4 p-3 rounded-xl border border-red-200 bg-red-50/50">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle size={12} className="text-red-500" />
              <span className="text-[11px] font-semibold text-red-600 uppercase tracking-wide">지난 마감</span>
            </div>
            <div className="space-y-1.5">
              {overdueDeadlines.map(d => {
                const daysOver = Math.abs(daysBetween(parseLocalDate(d.dueDate), TODAY_DATE));
                return (
                  <div key={d.id} className="flex items-center gap-2.5">
                    <button onClick={() => onToggleDeadline(d.id)}>
                      <Circle size={16} className="text-red-400" />
                    </button>
                    <span className="text-sm flex-1 min-w-0 truncate">{d.title}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium flex-shrink-0">{daysOver}일 초과</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Today's deadlines */}
        {todayDeadlines.length > 0 && (
          <div className="mb-4 p-3 rounded-xl border border-amber-200 bg-amber-50/40">
            <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-2">오늘 마감</div>
            <div className="space-y-1.5">
              {todayDeadlines.map(d => (
                <div key={d.id} className="flex items-center gap-2.5">
                  <button onClick={() => onToggleDeadline(d.id)}>
                    <Circle size={16} className="text-amber-500" />
                  </button>
                  <span className="text-sm flex-1 min-w-0 truncate">{d.title}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium flex-shrink-0">D-0</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Block list */}
        <div className="space-y-2">
          {sorted.map(block => (
            <div
              key={block.id}
              className={`group flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all cursor-pointer ${
                block.completed
                  ? "bg-muted/30 border-transparent opacity-60"
                  : "bg-card border-border hover:shadow-sm"
              }`}
              onClick={() => onSelect(block)}
            >
              <button
                className="flex-shrink-0"
                onClick={e => { e.stopPropagation(); onToggle(block.id); }}
              >
                {block.completed
                  ? <CheckCircle2 size={19} style={{ color: block.color }} />
                  : <Circle size={19} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                }
              </button>

              <div className="w-0.5 h-9 rounded-full flex-shrink-0" style={{ backgroundColor: block.color }} />

              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium leading-snug ${block.completed ? "line-through text-muted-foreground" : ""}`}>
                  {block.title}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5" >
                  {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
                  <span className="ml-1.5 opacity-60">{durMin(block)}분</span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                {block.tags.map(tag => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{tag}</span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {blocks.length === 0 && (
          <div className="mt-10 text-center py-8">
            <div className="text-sm font-medium text-muted-foreground">오늘 계획된 활동이 없어요</div>
            <button
              onClick={onGoToCalendar}
              className="mt-3 text-xs px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              캘린더로 이동
            </button>
          </div>
        )}

        {blocks.length > 0 && done === blocks.length && (
          <div className="mt-10 text-center py-8">
            <div className="text-3xl mb-3">🎉</div>
            <div className="text-sm font-medium">오늘의 모든 계획을 완료했어요!</div>
            <div className="text-xs text-muted-foreground mt-1">수고했어요. 활동 기록에 반영됐어요.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Calendar Section ───────────────────────────────────────────────
function CalendarSection({
  blocks, deadlines, templates, calView, setCalView, calMode, setCalMode,
  templateOpen, setTemplateOpen, onSelect, onToggle, onToggleDeadline, onAddBlock, onUpdateBlock, onUpdateBlockLocal, onDeleteBlock,
  scheduleTemplates, onSaveTemplate, onApplyTemplate, onDeleteTemplate, onAddTemplate, onDeleteBlockTemplate,
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
}: {
  blocks: Block[];
  deadlines: Deadline[];
  templates: Template[];
  calView: "day" | "week" | "month";
  setCalView: (v: "day" | "week" | "month") => void;
  calMode: "grid" | "list";
  setCalMode: (m: "grid" | "list") => void;
  templateOpen: boolean;
  setTemplateOpen: (v: boolean) => void;
  onSelect: (b: Block) => void;
  onToggle: (id: string) => void;
  onToggleDeadline: (id: string) => void;
  onAddBlock: (block: Block, options?: { select?: boolean; openInline?: boolean }) => void;
  onUpdateBlock: (id: string, changes: Partial<Block>) => void;
  onUpdateBlockLocal: (id: string, changes: Partial<Block>) => void;
  onDeleteBlock: (id: string) => void;
  scheduleTemplates: ScheduleTemplate[];
  onSaveTemplate: (name: string, date: string) => void;
  onApplyTemplate: (templateId: string, targetDate: string) => void;
  onDeleteTemplate: (id: string) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[] }) => void;
  onDeleteBlockTemplate: (id: string) => void;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
}) {
  const HOUR_H = 64;
  const TOTAL_H = 24;
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // 자식 블록(독립 타임블록형)은 부모의 상세 패널 안에서만 다뤄지고, 캘린더 그리드에는
  // 최상위 블록만 표시됨 — 안 그러면 부모 시간대 안에 자식이 겹쳐 보이거나 통계가 중복 집계됨.
  const topLevelBlocks = blocks.filter(b => !b.parentBlockId);

  const [viewDate, setViewDate] = useState(TODAY_DATE);
  const [saveTplName, setSaveTplName] = useState("");
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [showTplHelp, setShowTplHelp] = useState(false);
  const [showNewTpl, setShowNewTpl] = useState(false);
  const [showTplCustomColor, setShowTplCustomColor] = useState(false);
  const [newTplTitle, setNewTplTitle] = useState("");
  const [newTplColor, setNewTplColor] = useState("#5AA9E6");
  const [newTplTags, setNewTplTags] = useState("");
  const [dragTplId, setDragTplId] = useState<string | null>(null);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragBlockOffsetMin, setDragBlockOffsetMin] = useState(0); // minutes from block top to mouse
  const [dropTarget, setDropTarget] = useState<{ dayIdx: number; startH: number; startM: number } | null>(null);
  // 마우스를 그리드에 올렸을 때 클릭하면 새 블록이 놓일 위치를 미리 보여주는 hover ghost.
  // 15분 스냅으로 startMin(분 단위)을 저장 — 정시 스냅은 UX 요청으로 해제됨.
  const [hoverSlot, setHoverSlot] = useState<{ dayIdx: number; startMin: number } | null>(null);
  const [resizing, setResizing] = useState<{
    blockId: string; edge: "top" | "bottom";
    startY: number; origStartMin: number; origEndMin: number; blockDate: string;
  } | null>(null);

  const blocksRef = useRef(topLevelBlocks);
  useEffect(() => { blocksRef.current = topLevelBlocks; }, [topLevelBlocks]);

  // The browser fires a synthetic "click" right after mouseup even when that mouseup ends a
  // resize drag (mousedown started on the resize handle, a child of the block). React's state
  // update from setResizing(null) isn't guaranteed to have committed before that click event
  // reaches the block's onClick, so checking `resizing` there is a race. A ref is synchronous
  // and immune to that timing, so use it to suppress the click for one tick after a resize ends.
  const justResizedRef = useRef(false);

  // Scroll to 7am when entering grid view
  useEffect(() => {
    if (gridScrollRef.current && calView !== "month" && calMode === "grid") {
      gridScrollRef.current.scrollTop = 7 * HOUR_H;
    }
  }, [calView, calMode]);

  // Resize mouse tracking — uses the local-only updater for live visual feedback on every
  // mousemove (hitting the DB that often would be wasteful); the final value is persisted
  // once on mouseup.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const deltaMin = Math.round(((e.clientY - resizing.startY) / HOUR_H) * 60 / 15) * 15;
      const peers = blocksRef.current.filter(b => b.id !== resizing.blockId && b.date === resizing.blockDate);
      const clash = (sMin: number, eMin: number) =>
        peers.some(b => sMin < b.endH * 60 + b.endM && eMin > b.startH * 60 + b.startM);
      if (resizing.edge === "bottom") {
        const newEnd = Math.max(resizing.origStartMin + 15, Math.min(TOTAL_H * 60, resizing.origEndMin + deltaMin));
        if (!clash(resizing.origStartMin, newEnd))
          onUpdateBlockLocal(resizing.blockId, { endH: Math.floor(newEnd / 60), endM: newEnd % 60 });
      } else {
        const newStart = Math.min(resizing.origEndMin - 15, Math.max(0, resizing.origStartMin + deltaMin));
        if (!clash(newStart, resizing.origEndMin))
          onUpdateBlockLocal(resizing.blockId, { startH: Math.floor(newStart / 60), startM: newStart % 60 });
      }
    };
    const onUp = () => {
      const final = blocksRef.current.find(b => b.id === resizing.blockId);
      if (final) onUpdateBlock(final.id, { startH: final.startH, startM: final.startM, endH: final.endH, endM: final.endM });
      setResizing(null);
      justResizedRef.current = true;
      setTimeout(() => { justResizedRef.current = false; }, 0);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizing, onUpdateBlock, onUpdateBlockLocal]);

  // Navigation helpers
  const goPrev = () => {
    const d = new Date(viewDate);
    if (calView === "day") d.setDate(d.getDate() - 1);
    else if (calView === "week") d.setDate(d.getDate() - 7);
    else d.setMonth(d.getMonth() - 1);
    setViewDate(d);
  };
  const goNext = () => {
    const d = new Date(viewDate);
    if (calView === "day") d.setDate(d.getDate() + 1);
    else if (calView === "week") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    setViewDate(d);
  };

  const getWeekDays = (date: Date) => {
    const dow = date.getDay();
    const mon = new Date(date);
    mon.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  };

  const viewDays = calView === "day" ? [viewDate] : getWeekDays(viewDate);

  const headerLabel = (() => {
    if (calView === "day") {
      return `${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월 ${viewDate.getDate()}일 ${DAYS_KO[viewDate.getDay()]}요일`;
    }
    if (calView === "week") {
      const wd = viewDays;
      const s = wd[0], e = wd[6];
      return s.getMonth() === e.getMonth()
        ? `${s.getFullYear()}년 ${s.getMonth()+1}월 ${s.getDate()}–${e.getDate()}일`
        : `${s.getMonth()+1}월 ${s.getDate()}일 – ${e.getMonth()+1}월 ${e.getDate()}일`;
    }
    return `${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월`;
  })();

  const hasOverlapForDate = (dateStr: string, startMin: number, endMin: number, excludeId?: string) =>
    topLevelBlocks.filter(b => b.date === dateStr && b.id !== excludeId)
      .some(b => startMin < b.endH * 60 + b.endM && endMin > b.startH * 60 + b.startM);

  const dragTemplate = dragTplId ? templates.find(t => t.id === dragTplId) ?? null : null;
  const dragBlock = dragBlockId ? topLevelBlocks.find(b => b.id === dragBlockId) ?? null : null;

  // ── Shared time-grid renderer (day + week) ──────────────────────
  const renderTimeGrid = (days: Date[]) => (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Day headers */}
      <div className="flex border-b border-border flex-shrink-0 bg-card">
        <div className="w-12 flex-shrink-0" />
        {days.map((day, i) => {
          const isToday = toDateStr(day) === TODAY_STR;
          const dow = day.getDay();
          return (
            <div
              key={i}
              className="flex-1 text-center py-2 min-w-0 cursor-pointer hover:bg-muted/40 transition-colors rounded-lg"
              onClick={() => { setViewDate(day); setCalView("day"); }}
              title="이 날짜 일 캘린더로 이동"
            >
              <div className={`text-[10px] ${days.length > 1 && dow === 0 ? "text-red-400" : days.length > 1 && dow === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                {DAYS_KO[dow]}
              </div>
              <div className={`inline-flex items-center justify-center w-7 h-7 mt-0.5 rounded-full text-xs font-medium ${isToday ? "bg-primary text-primary-foreground" : "text-foreground"}`}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Scrollable grid — 마감 슬롯도 이 안에 넣어야 그리드와 폭이 정확히 맞음(스크롤바 폭 이슈) */}
      <div ref={gridScrollRef} className="flex-1 overflow-auto">
        {/* 마감 슬롯 — sticky로 상단 고정, 스크롤해도 화면에 계속 보임 */}
        <div className="flex border-b border-border sticky top-0 z-20 bg-card min-h-[36px]">
          <div className="w-12 flex-shrink-0 flex items-start justify-end pt-1.5 pr-2 text-[9px] text-muted-foreground select-none">마감</div>
          {days.map((day, di) => {
            const dateStr = toDateStr(day);
            const dayDeadlines = deadlines.filter(d => d.dueDate === dateStr);
            return (
              <div key={di} className="flex-1 border-l border-border py-1 px-1 min-w-0 space-y-0.5">
                {dayDeadlines.map(d => (
                  <button
                    key={d.id}
                    onClick={e => { e.stopPropagation(); onToggleDeadline(d.id); }}
                    title={d.completed ? "완료됨 — 다시 열기" : "완료 처리"}
                    className={`w-full flex items-center gap-1 text-left text-[10px] px-1.5 py-0.5 rounded transition-colors ${d.completed ? "bg-muted/40 text-muted-foreground line-through" : "bg-red-100 text-red-700 hover:bg-red-200"}`}
                  >
                    <Target size={9} className="flex-shrink-0" />
                    <span className="truncate">{d.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        <div className="flex" style={{ height: TOTAL_H * HOUR_H }}>
          {/* Hour labels — h=0 라벨은 top clamp로 잘리지 않게 */}
          <div className="w-12 flex-shrink-0 relative select-none">
            {Array.from({ length: TOTAL_H }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted-foreground"
                style={{ top: h === 0 ? 2 : h * HOUR_H - 7 }}>
                {fmt2(h)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, di) => {
            const dateStr = toDateStr(day);
            const isToday = dateStr === TODAY_STR;
            const dayBlocks = topLevelBlocks.filter(b => b.date === dateStr);
            const isDropTarget = dropTarget?.dayIdx === di;
            const ghostStartMin = isDropTarget && dropTarget ? dropTarget.startH * 60 + dropTarget.startM : null;
            const ghostEndMin = ghostStartMin !== null ? Math.min(TOTAL_H * 60, ghostStartMin + 60) : null;
            const isGhostOverlap = ghostStartMin !== null && ghostEndMin !== null
              ? hasOverlapForDate(dateStr, ghostStartMin, ghostEndMin) : false;

            return (
              <div
                key={di}
                className={`flex-1 relative border-l border-border min-w-0 ${isToday ? "bg-sky-50/10" : ""}`}
                style={{ height: TOTAL_H * HOUR_H }}
                onClick={e => {
                  if (resizing || dragBlockId || dragTplId || justResizedRef.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const durMin = 60;
                  // 15분 스냅 — 클릭한 위치의 분을 15의 배수로 반올림
                  const rawMin = Math.max(0, Math.round(((e.clientY - rect.top) / HOUR_H) * 60 / 15) * 15);
                  const startMin = Math.min(TOTAL_H * 60 - durMin, rawMin);
                  const endMin = startMin + durMin;
                  if (hasOverlapForDate(dateStr, startMin, endMin)) return;
                  const newBlock: Block = {
                    id: `b-${Date.now()}`,
                    title: "새 블록",
                    color: "#5AA9E6",
                    startH: Math.floor(startMin / 60),
                    startM: startMin % 60,
                    endH: Math.floor(endMin / 60),
                    endM: endMin % 60,
                    completed: false,
                    tags: [],
                    memo: "",
                    date: dateStr,
                  };
                  setHoverSlot(null);
                  onAddBlock(newBlock, { openInline: true });
                }}
                onMouseMove={e => {
                  if (dragTplId || dragBlockId || resizing) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const rawMin = Math.max(0, Math.min(TOTAL_H * 60 - 15, Math.round(((e.clientY - rect.top) / HOUR_H) * 60 / 15) * 15));
                  setHoverSlot(prev => (prev?.dayIdx === di && prev.startMin === rawMin) ? prev : { dayIdx: di, startMin: rawMin });
                }}
                onMouseLeave={() => setHoverSlot(prev => (prev?.dayIdx === di ? null : prev))}
                onDragOver={e => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = dragBlockId ? "move" : "copy";
                  const rect = e.currentTarget.getBoundingClientRect();
                  const rawMin = Math.round((Math.max(0, e.clientY - rect.top) / HOUR_H) * 60 / 15) * 15;
                  // For block moves: anchor by offset so block follows mouse position
                  const anchoredMin = dragBlockId ? Math.max(0, rawMin - dragBlockOffsetMin) : rawMin;
                  const snapped = Math.round(anchoredMin / 15) * 15;
                  setDropTarget({ dayIdx: di, startH: Math.min(23, Math.floor(snapped / 60)), startM: snapped % 60 });
                }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
                onDrop={e => {
                  e.preventDefault();
                  if (!dropTarget || dropTarget.dayIdx !== di) { setDropTarget(null); setDragTplId(null); setDragBlockId(null); return; }

                  // ── Moving an existing block ──
                  const movedBlockId = e.dataTransfer.getData("blockId");
                  if (movedBlockId) {
                    const block = blocksRef.current.find(b => b.id === movedBlockId);
                    if (block) {
                      const dur = block.endH * 60 + block.endM - (block.startH * 60 + block.startM);
                      const newStart = Math.max(0, dropTarget.startH * 60 + dropTarget.startM);
                      const newEnd = Math.min(TOTAL_H * 60, newStart + dur);
                      const adjustedStart = newEnd === TOTAL_H * 60 ? TOTAL_H * 60 - dur : newStart;
                      if (!hasOverlapForDate(dateStr, adjustedStart, adjustedStart + dur, movedBlockId)) {
                        onUpdateBlock(movedBlockId, {
                          date: dateStr,
                          startH: Math.floor(adjustedStart / 60), startM: adjustedStart % 60,
                          endH: Math.floor((adjustedStart + dur) / 60), endM: (adjustedStart + dur) % 60,
                        });
                      }
                    }
                    setDropTarget(null); setDragBlockId(null); return;
                  }

                  // ── Dropping a template ──
                  const tpl = templates.find(t => t.id === e.dataTransfer.getData("templateId"));
                  if (!tpl) { setDropTarget(null); setDragTplId(null); return; }
                  const sMin = dropTarget.startH * 60 + dropTarget.startM;
                  const eMin = Math.min(TOTAL_H * 60, sMin + 60);
                  if (!hasOverlapForDate(dateStr, sMin, eMin)) {
                    onAddBlock({ id: `b-${Date.now()}`, templateId: tpl.id, title: tpl.title, color: tpl.color,
                      startH: dropTarget.startH, startM: dropTarget.startM,
                      endH: Math.floor(eMin / 60), endM: eMin % 60,
                      completed: false, tags: tpl.tags, memo: "", date: dateStr });
                  }
                  setDropTarget(null); setDragTplId(null);
                }}
              >
                {Array.from({ length: TOTAL_H }, (_, h) => (
                  <div key={h} className="absolute w-full border-t border-border/40 pointer-events-none" style={{ top: h * HOUR_H }} />
                ))}

                {/* Hover ghost — 마우스 올린 15분 스냅 위치에 새 블록이 놓일 자리 미리보기.
                    이미 블록이 있는 시간대나 드래그·리사이즈 중일 땐 숨김. */}
                {hoverSlot?.dayIdx === di && !isDropTarget && !dragBlockId && !dragTplId && !resizing
                  && !hasOverlapForDate(dateStr, hoverSlot.startMin, hoverSlot.startMin + 60) && (
                  <div
                    className="absolute left-0.5 right-0.5 rounded-lg pointer-events-none z-[6] bg-primary/5 ring-1 ring-primary/25"
                    style={{
                      top: hoverSlot.startMin / 60 * HOUR_H,
                      height: HOUR_H - 2,
                      boxShadow: "0 6px 16px -6px rgba(90, 169, 230, 0.35), 0 2px 6px -2px rgba(90, 169, 230, 0.25)",
                    }}
                  >
                    <div className="text-[10px] text-primary/70 px-1.5 pt-1 font-medium">+ 새 블록</div>
                    <div className="text-[9px] text-primary/50 px-1.5 mt-0.5">
                      {fmtTime(Math.floor(hoverSlot.startMin / 60), hoverSlot.startMin % 60)}
                      {" – "}
                      {fmtTime(Math.floor((hoverSlot.startMin + 60) / 60), (hoverSlot.startMin + 60) % 60)}
                    </div>
                  </div>
                )}

                {/* Drop ghost — template or block move */}
                {isDropTarget && ghostStartMin !== null && (dragTemplate || dragBlock) && (() => {
                  const src = dragBlock ?? dragTemplate!;
                  const ghostDur = dragBlock ? (dragBlock.endH*60+dragBlock.endM) - (dragBlock.startH*60+dragBlock.startM) : 60;
                  const gEnd = Math.min(TOTAL_H * 60, ghostStartMin + ghostDur);
                  const gTop = ghostStartMin / 60 * HOUR_H;
                  const gH = Math.max(20, (gEnd - ghostStartMin) / 60 * HOUR_H - 2);
                  const overlap = hasOverlapForDate(dateStr, ghostStartMin, gEnd, dragBlock?.id);
                  return (
                    <div className="absolute left-0.5 right-0.5 rounded-lg px-1.5 py-1 pointer-events-none border-2 border-dashed z-20"
                      style={{ top: gTop, height: gH,
                        backgroundColor: overlap ? "#ef444418" : src.color + "20",
                        borderColor: overlap ? "#ef4444" : src.color }}>
                      <div className="text-[10px] font-semibold truncate" style={{ color: overlap ? "#ef4444" : src.color }}>
                        {overlap ? "⚠ 이미 일정이 있어요" : src.title}
                      </div>
                      {!overlap && (
                        <div className="text-[9px] opacity-60 mt-0.5" style={{ color: src.color }}>
                          {fmtTime(Math.floor(ghostStartMin/60), ghostStartMin%60)} – {fmtTime(Math.floor(gEnd/60), gEnd%60)}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* 습관 스태킹 연결선 — nextBlockId로 연결된 블록끼리, 둘 다 이 날짜 컬럼에
                    있을 때만 이음. 블록(z-10)이 선 위에 그려지도록 선은 더 낮은 z-index */}
                {dayBlocks.filter(b => b.nextBlockId).map(b => {
                  const target = dayBlocks.find(t => t.id === b.nextBlockId);
                  if (!target) return null;
                  const y1 = (b.endH * 60 + b.endM) / 60 * HOUR_H;
                  const y2 = (target.startH * 60 + target.startM) / 60 * HOUR_H;
                  const top = Math.min(y1, y2);
                  const height = Math.max(2, Math.abs(y2 - y1));
                  return (
                    <div
                      key={`chain-${b.id}`}
                      className="absolute pointer-events-none z-[5]"
                      style={{ left: "50%", top, height, transform: "translateX(-50%)" }}
                      title={`${b.title} → ${target.title}`}
                    >
                      <div className="h-full border-l-2 border-dashed" style={{ borderColor: b.color }} />
                      <div className="absolute -bottom-[3px] -left-[3px] size-1.5 rotate-45" style={{ backgroundColor: b.color }} />
                    </div>
                  );
                })}

                {/* Blocks */}
                {dayBlocks.map(block => {
                  const sMin = block.startH * 60 + block.startM;
                  const eMin = block.endH * 60 + block.endM;
                  const top = sMin / 60 * HOUR_H;
                  const height = Math.max(20, (eMin - sMin) / 60 * HOUR_H - 2);
                  const isBeingDragged = dragBlockId === block.id;
                  return (
                    <div key={block.id}
                      draggable
                      onDragStart={e => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const offsetPx = e.clientY - rect.top;
                        const offsetMin = Math.round((offsetPx / HOUR_H) * 60 / 15) * 15;
                        e.dataTransfer.setData("blockId", block.id);
                        e.dataTransfer.setData("blockOffsetMin", String(offsetMin));
                        e.dataTransfer.effectAllowed = "move";
                        setDragBlockId(block.id);
                        setDragBlockOffsetMin(offsetMin);
                      }}
                      onDragEnd={() => { setDragBlockId(null); setDropTarget(null); }}
                      className={`absolute left-0.5 right-0.5 rounded-lg overflow-hidden z-10 select-none group/block ${resizing?.blockId !== block.id && !isBeingDragged ? "cursor-grab hover:brightness-95" : ""} ${isBeingDragged ? "opacity-30" : ""}`}
                      style={{ top, height, backgroundColor: block.color + "28", borderLeft: `3px solid ${block.color}`, opacity: block.completed ? 0.45 : isBeingDragged ? 0.3 : 1 }}
                      onClick={e => { if (resizing || dragBlockId || justResizedRef.current) return; e.stopPropagation(); onSelect(block); }}
                    >
                      <div className="absolute top-0 left-0 right-0 h-2.5 cursor-n-resize z-20"
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                          setResizing({ blockId: block.id, edge: "top", startY: e.clientY, origStartMin: sMin, origEndMin: eMin, blockDate: block.date }); }} />
                      <div className="px-1.5 pt-3 pb-2">
                        <div className="text-[10px] font-semibold truncate flex items-center gap-1" style={{ color: block.color }}>
                          {block.repeatGroupId && <span title="반복 일정" style={{ fontSize: 9 }}>↻</span>}
                          {block.title}
                        </div>
                        {height > 32 && (
                          <div className="text-[9px] opacity-70 mt-0.5" style={{ color: block.color }}>
                            {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
                          </div>
                        )}
                      </div>
                      {/* Delete button on hover */}
                      <button
                        onClick={e => { e.stopPropagation(); onDeleteBlock(block.id); }}
                        className="absolute top-1 right-1 size-4 rounded flex items-center justify-center opacity-0 group-hover/block:opacity-100 hover:bg-black/20 transition-opacity z-30"
                        title="블록 삭제"
                      >
                        <X size={9} style={{ color: block.color }} />
                      </button>
                      <div className="absolute bottom-0 left-0 right-0 h-2.5 cursor-s-resize z-20"
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault();
                          setResizing({ blockId: block.id, edge: "bottom", startY: e.clientY, origStartMin: sMin, origEndMin: eMin, blockDate: block.date }); }} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // ── Month grid renderer ─────────────────────────────────────────
  const renderMonthGrid = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = [
      ...Array(firstDow).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
    ];
    while (cells.length % 7 !== 0) cells.push(null);
    const totalRows = cells.length / 7;

    return (
      <div className="flex-1 overflow-auto min-w-0">
        {/* Day of week headers */}
        <div className="grid grid-cols-7 border-b border-border flex-shrink-0 bg-card sticky top-0 z-10">
          {["일","월","화","수","목","금","토"].map((d, i) => (
            <div key={d} className={`text-center text-[10px] py-2 font-medium ${i===0?"text-red-400":i===6?"text-blue-400":"text-muted-foreground"}`}>{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            if (!day) return (
              <div key={`e-${i}`} className={`min-h-[100px] bg-muted/5 ${i%7!==6?"border-r":""} ${Math.floor(i/7)<totalRows-1?"border-b":""} border-border`} />
            );
            const dateStr = toDateStr(day);
            const isToday = dateStr === TODAY_STR;
            const isFuture = dateStr > TODAY_STR;
            const col = i % 7;
            const row = Math.floor(i / 7);
            const dayBlocks = topLevelBlocks.filter(b => b.date === dateStr)
              .sort((a,b) => a.startH*60+a.startM - (b.startH*60+b.startM));
            const dayDeadlines = deadlines.filter(d => d.dueDate === dateStr);
            const MAX = 3;
            const shown = dayBlocks.slice(0, MAX);
            const overflow = dayBlocks.length - MAX;

            return (
              <div key={dateStr}
                className={`min-h-[100px] p-1.5 relative ${col!==6?"border-r border-border":""} ${row<totalRows-1?"border-b border-border":""} ${isToday?"ring-1 ring-inset ring-primary/40":""} ${isFuture?"bg-muted/5":""}`}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  const tpl = templates.find(t => t.id === e.dataTransfer.getData("templateId"));
                  if (!tpl) return;
                  let startH = 9, startM = 0;
                  for (let h = 9; h < 22; h++) {
                    for (let m = 0; m < 60; m += 30) {
                      if (!hasOverlapForDate(dateStr, h*60+m, h*60+m+60)) { startH=h; startM=m; h=99; break; }
                    }
                  }
                  onAddBlock({ id:`b-${Date.now()}`, templateId: tpl.id, title:tpl.title, color:tpl.color,
                    startH, startM, endH:startH+1, endM:startM,
                    completed:false, tags:tpl.tags, memo:"", date:dateStr });
                  setDragTplId(null);
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    onClick={e => { e.stopPropagation(); setViewDate(day); setCalView("day"); }}
                    className={`text-xs font-medium inline-flex items-center justify-center leading-none cursor-pointer hover:opacity-70 transition-opacity ${isToday?"size-5 rounded-full bg-primary text-primary-foreground text-[10px]":col===0?"text-red-400":col===6?"text-blue-400":"text-muted-foreground"}`}
                    title="이 날짜 일 캘린더로 이동"
                  >
                    {day.getDate()}
                  </span>
                </div>
                {/* 마감(별도) — 블록보다 위에 표시 */}
                {dayDeadlines.length > 0 && (
                  <div className="space-y-0.5 mb-0.5">
                    {dayDeadlines.map(d => (
                      <div
                        key={d.id}
                        onClick={e => { e.stopPropagation(); onToggleDeadline(d.id); }}
                        className={`flex items-center gap-1 px-1 py-0.5 rounded text-[9px] cursor-pointer transition-colors ${d.completed ? "bg-muted/40 text-muted-foreground line-through" : "bg-red-100 text-red-700 hover:bg-red-200"}`}
                        title={d.completed ? "완료됨 — 다시 열기" : "완료 처리"}
                      >
                        <Target size={8} className="flex-shrink-0" />
                        <span className="truncate font-medium leading-tight">{d.title}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-0.5">
                  {shown.map(block => (
                    <div key={block.id} onClick={() => onSelect(block)}
                      className="flex items-center gap-1 px-1 py-0.5 rounded text-[9px] cursor-pointer hover:brightness-95 transition-all"
                      style={{ backgroundColor: block.color+"22", borderLeft:`2px solid ${block.color}` }}>
                      <span className="truncate font-medium leading-tight" style={{ color: block.color }}>
                        {fmtTime(block.startH,block.startM)} {block.title}
                      </span>
                    </div>
                  ))}
                  {overflow > 0 && <div className="text-[9px] text-muted-foreground pl-1">+{overflow}개</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── List view ───────────────────────────────────────────────────
  const renderListView = () => {
    const dateStr = toDateStr(viewDate);
    const listBlocks = calView === "day"
      ? topLevelBlocks.filter(b => b.date === dateStr)
      : viewDays.flatMap(d => topLevelBlocks.filter(b => b.date === toDateStr(d)));
    const sorted = [...listBlocks].sort((a,b) => a.startH*60+a.startM - (b.startH*60+b.startM));

    const listDeadlines = calView === "day"
      ? deadlines.filter(d => d.dueDate === dateStr)
      : viewDays.flatMap(d => deadlines.filter(x => x.dueDate === toDateStr(d)));
    const sortedDeadlines = [...listDeadlines].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg space-y-6">
          {/* 마감 (별도 섹션) */}
          {sortedDeadlines.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">마감</div>
              <div className="space-y-2">
                {sortedDeadlines.map(d => (
                  <div
                    key={d.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer hover:shadow-sm transition-all ${d.completed ? "bg-card opacity-60" : "border-red-200 bg-red-50/40"}`}
                    onClick={() => onToggleDeadline(d.id)}
                  >
                    <Target size={16} className={d.completed ? "text-muted-foreground" : "text-red-500"} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${d.completed ? "line-through text-muted-foreground" : ""}`}>{d.title}</div>
                      <div className="text-[11px] text-muted-foreground">{d.dueDate}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 블록 (기존) */}
          <div>
            {sortedDeadlines.length > 0 && (
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">일정</div>
            )}
            <div className="space-y-2">
              {sorted.map(block => (
                <div key={block.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-card cursor-pointer hover:shadow-sm transition-all"
                  onClick={() => onSelect(block)}
                >
                  <button onClick={e => { e.stopPropagation(); onToggle(block.id); }}>
                    {block.completed ? <CheckCircle2 size={18} style={{ color: block.color }} /> : <Circle size={18} className="text-muted-foreground" />}
                  </button>
                  <span className="w-0.5 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: block.color }} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${block.completed?"line-through text-muted-foreground":""}`}>{block.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {block.date !== TODAY_STR && `${parseLocalDate(block.date).getMonth()+1}/${parseLocalDate(block.date).getDate()} · `}
                      {fmtTime(block.startH,block.startM)} – {fmtTime(block.endH,block.endM)}
                    </div>
                  </div>
                  {block.tags.map(tag => (
                    <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">{tag}</span>
                  ))}
                </div>
              ))}
              {sorted.length === 0 && sortedDeadlines.length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">이 기간에 등록된 항목이 없어요</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0 bg-card/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg bg-muted p-0.5 gap-0.5">
            {(["day","week","month"] as const).map(v => (
              <button key={v} onClick={() => setCalView(v)}
                className={`px-3 py-1 text-xs rounded-md transition-all ${calView===v?"bg-card shadow-sm font-medium":"text-muted-foreground hover:text-foreground"}`}>
                {v==="day"?"일":v==="week"?"주":"월"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {calView !== "month" && (
            <button onClick={() => setCalMode(calMode==="grid"?"list":"grid")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border bg-card hover:bg-muted transition-colors">
              {calMode==="grid"?<List size={12}/>:<Grid3x3 size={12}/>}
              {calMode==="grid"?"리스트":"그리드"}
            </button>
          )}
          <div className="flex items-center gap-0.5">
            <button onClick={goPrev} className="p-1.5 rounded hover:bg-muted transition-colors"><ChevronLeft size={15}/></button>
            <span className="text-xs px-2 text-muted-foreground min-w-[180px] text-center">{headerLabel}</span>
            <button onClick={goNext} className="p-1.5 rounded hover:bg-muted transition-colors"><ChevronRight size={15}/></button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Template panel */}
        <div className={`border-r border-border flex-shrink-0 flex flex-col bg-sidebar transition-all duration-200 ${templateOpen?"w-44":"w-9"}`}>
          <button onClick={() => setTemplateOpen(!templateOpen)}
            className="flex items-center justify-between w-full px-3 py-3 border-b border-sidebar-border hover:bg-sidebar-accent transition-colors">
            {templateOpen && <span className="text-[11px] font-medium text-muted-foreground">템플릿</span>}
            <ChevronLeft size={13} className={`transition-transform text-muted-foreground mx-auto ${!templateOpen?"rotate-180":""}`} />
          </button>
          {templateOpen && (
            <div className="p-2 space-y-0.5 overflow-y-auto flex-1">
              {/* Block templates */}
              <div className="text-[10px] font-medium text-muted-foreground px-2 py-1 uppercase tracking-wide">블록 템플릿</div>
              {templates.map(t => (
                <div key={t.id} draggable
                  onDragStart={e => { e.dataTransfer.setData("templateId", t.id); setDragTplId(t.id); }}
                  onDragEnd={() => { setDragTplId(null); setDropTarget(null); }}
                  className="group/tpl flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sidebar-accent cursor-grab active:cursor-grabbing transition-colors text-xs select-none">
                  <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: t.color }} />
                  <span className="flex-1 truncate text-foreground/80">{t.title}</span>
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteBlockTemplate(t.id); }}
                    onMouseDown={e => e.stopPropagation()}
                    onDragStart={e => { e.stopPropagation(); e.preventDefault(); }}
                    draggable={false}
                    title="템플릿 삭제 (기존 블록은 유지)"
                    className="opacity-0 group-hover/tpl:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><X size={11} /></button>
                </div>
              ))}
              {showNewTpl ? (
                <div className="p-2 rounded-lg bg-sidebar-accent space-y-1.5">
                  <input
                    autoFocus
                    value={newTplTitle}
                    onChange={e => setNewTplTitle(e.target.value)}
                    placeholder="제목..."
                    className="w-full text-xs px-2 py-1 rounded bg-card border border-border outline-none focus:ring-1 focus:ring-ring"
                  />
                  {/* 프리셋/커스텀 색상 팔레트 — hover 시 X로 삭제, 마지막 '+'로 새 색 추가 */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {paletteColors.map(c => (
                      <div key={c} className="relative group/color size-5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => setNewTplColor(c)}
                          className={`size-5 rounded-full transition-transform ${newTplColor.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-sidebar-accent ring-foreground/40 scale-110" : ""}`}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                          className="absolute -top-1 -right-1 size-3 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                          title="팔레트에서 제거"
                        >
                          <X size={7} strokeWidth={2.5} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setShowTplCustomColor(v => !v)}
                      className={`size-5 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showTplCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
                      title="사용자 지정 색상 추가"
                    >
                      <Plus size={10} className={showTplCustomColor ? "text-primary" : "text-muted-foreground"} />
                    </button>
                  </div>
                  {showTplCustomColor && (
                    <CustomColorPickerInline
                      initial={newTplColor}
                      onAdd={(color) => { setNewTplColor(color); onAddPaletteColor(color); }}
                      onClose={() => setShowTplCustomColor(false)}
                    />
                  )}
                  <input
                    value={newTplTags}
                    onChange={e => setNewTplTags(e.target.value)}
                    placeholder="태그 (쉼표로 구분)"
                    className="w-full text-xs px-2 py-1 rounded bg-card border border-border outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        if (!newTplTitle.trim()) return;
                        onAddTemplate({
                          title: newTplTitle.trim(),
                          color: newTplColor,
                          tags: newTplTags.split(",").map(t => t.trim()).filter(Boolean),
                        });
                        setNewTplTitle(""); setNewTplTags(""); setShowNewTpl(false);
                      }}
                      disabled={!newTplTitle.trim()}
                      className="flex-1 text-[11px] py-1 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                    >
                      추가
                    </button>
                    <button onClick={() => setShowNewTpl(false)} className="flex-1 text-[11px] py-1 rounded-lg bg-muted hover:bg-muted/70 transition-colors">
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewTpl(true)}
                  className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:text-foreground w-full rounded-lg hover:bg-sidebar-accent transition-colors"
                >
                  <Plus size={11}/> 새 템플릿
                </button>
              )}

              {/* Schedule templates */}
              <div className="mt-3 pt-2 border-t border-sidebar-border">
                <div className="flex items-center justify-between px-2 py-1">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">저장된 일정</div>
                  <button
                    onClick={() => setShowTplHelp(v => !v)}
                    title="사용법"
                    className={`p-0.5 rounded transition-colors ${showTplHelp ? "text-foreground bg-sidebar-accent" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <Info size={11} />
                  </button>
                </div>
                {showTplHelp && (
                  <div className="text-[10px] text-muted-foreground bg-sidebar-accent/60 rounded-md px-2 py-1.5 mx-2 mb-1 leading-snug space-y-1">
                    <p><span className="text-foreground font-medium">저장:</span> 지금 보고 있는 날짜에 만들어둔 시간 블록들을 하나의 세트로 저장해요.</p>
                    <p><span className="text-foreground font-medium">적용:</span> 다른 날짜로 이동한 뒤 아래 목록 항목에 마우스를 올리면 나오는 <span className="text-foreground font-medium">적용</span> 버튼을 눌러 그 날에 붙여넣어요. 이미 잡힌 일정과 겹치는 시간대는 자동으로 건너뜁니다.</p>
                  </div>
                )}
                {scheduleTemplates.length === 0 && !showTplHelp && (
                  <p className="text-[10px] text-muted-foreground px-2 py-1 leading-tight">저장된 일정이 없어요.<br/>아래 "이 날 일정 저장"을 눌러 저장하세요.</p>
                )}
                {scheduleTemplates.map(st => (
                  <div key={st.id} className="group/st flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-sidebar-accent text-xs">
                    <span className="flex-1 truncate text-foreground/80">{st.name}</span>
                    <button
                      onClick={() => onApplyTemplate(st.id, toDateStr(viewDate))}
                      className="opacity-0 group-hover/st:opacity-100 text-[9px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground transition-opacity"
                      title="현재 날짜에 적용"
                    >적용</button>
                    <button
                      onClick={() => onDeleteTemplate(st.id)}
                      className="opacity-0 group-hover/st:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    ><X size={10} /></button>
                  </div>
                ))}

                {/* Save current day */}
                {showSaveTpl ? (
                  <form onSubmit={e => { e.preventDefault(); if (saveTplName.trim()) { onSaveTemplate(saveTplName.trim(), (viewDays[0] && toDateStr(viewDays[0])) || TODAY_STR); setSaveTplName(""); setShowSaveTpl(false); } }}
                    className="flex gap-1 px-2 mt-1">
                    <input autoFocus value={saveTplName} onChange={e => setSaveTplName(e.target.value)}
                      placeholder="이름..."
                      className="flex-1 text-[10px] px-2 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
                    <button type="submit" className="text-[10px] text-sky-600 font-medium px-1">저장</button>
                    <button type="button" onClick={() => setShowSaveTpl(false)} className="text-muted-foreground"><X size={10}/></button>
                  </form>
                ) : (
                  <button onClick={() => setShowSaveTpl(true)}
                    className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:text-foreground w-full rounded-lg hover:bg-sidebar-accent transition-colors mt-0.5">
                    <Plus size={11}/> 이 날 일정 저장
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Content — switches by view */}
        {calView === "month"
          ? renderMonthGrid()
          : calMode === "grid"
          ? renderTimeGrid(viewDays)
          : renderListView()
        }
      </div>
    </div>
  );
}

// ── Deadlines Section ──────────────────────────────────────────────
function DeadlinesSection({
  deadlines, onToggle, onAddDeadline, onDelete,
}: {
  deadlines: Deadline[];
  onToggle: (id: string) => void;
  onAddDeadline: (d: { title: string; dueDate: string }) => void;
  onDelete: (id: string) => void;
}) {
  const active = deadlines.filter(d => !d.completed);
  const overdue = active.filter(d => d.dueDate < TODAY_STR);
  const upcoming = active.filter(d => d.dueDate >= TODAY_STR);
  const completed = deadlines.filter(d => d.completed);

  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueDate, setNewDueDate] = useState(TODAY_STR);

  const daysLeft = (date: string) => daysBetween(parseLocalDate(date), TODAY_DATE);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 pt-16 pb-8">
        {overdue.length > 0 && (
          <div className="mb-7">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">지난 마감</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{overdue.length}</span>
            </div>
            <div className="space-y-2">
              {overdue.map(d => (
                <div key={d.id} className="group/dl flex items-center gap-4 px-4 py-3.5 rounded-xl border border-red-200 bg-red-50/40">
                  <button onClick={() => onToggle(d.id)}><Circle size={18} className="text-red-400" /></button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5" >{d.dueDate}</div>
                  </div>
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-red-100 text-red-600 font-medium flex-shrink-0">
                    {Math.abs(daysLeft(d.dueDate))}일 초과
                  </span>
                  <button
                    onClick={() => onDelete(d.id)}
                    title="삭제"
                    className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-7">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">진행 중</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{upcoming.length}</span>
          </div>
          <div className="space-y-2">
            {upcoming.map(d => {
              const dl = daysLeft(d.dueDate);
              return (
                <div key={d.id} className="group/dl flex items-center gap-4 px-4 py-3.5 rounded-xl border bg-card">
                  <button onClick={() => onToggle(d.id)}><Circle size={18} className="text-muted-foreground" /></button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5" >{d.dueDate}</div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${dl <= 3 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>
                    D-{dl}
                  </span>
                  <button
                    onClick={() => onDelete(d.id)}
                    title="삭제"
                    className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><Trash2 size={14} /></button>
                </div>
              );
            })}
            {showAdd ? (
              <div className="p-3 rounded-xl border bg-card space-y-2">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="제목..."
                  className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                />
                <input
                  type="date"
                  value={newDueDate}
                  onChange={e => setNewDueDate(e.target.value)}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (!newTitle.trim()) return;
                      // 날짜 입력을 지운 채 추가하면 dueDate=""가 저장돼 문자열 비교에서
                      // 무조건 "지난 마감"으로 잡히는 이상 상태가 됨 — 오늘로 폴백.
                      const due = newDueDate || TODAY_STR;
                      onAddDeadline({ title: newTitle.trim(), dueDate: due });
                      setNewTitle(""); setShowAdd(false);
                    }}
                    disabled={!newTitle.trim() || !newDueDate}
                    className="flex-1 text-sm py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
                  >
                    추가
                  </button>
                  <button onClick={() => setShowAdd(false)} className="flex-1 text-sm py-2 rounded-lg bg-muted hover:bg-muted/70 transition-colors">
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 mt-2 px-4 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-xl hover:bg-muted w-full"
              >
                <Plus size={15} /> 마감 작업 추가
              </button>
            )}
          </div>
        </div>

        {completed.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">완료됨</div>
            <div className="space-y-2 opacity-50">
              {completed.map(d => (
                <div key={d.id} className="group/dl flex items-center gap-4 px-4 py-3 rounded-xl border">
                  <button onClick={() => onToggle(d.id)}><CheckCircle2 size={18} className="text-sky-600" /></button>
                  <div className="flex-1 min-w-0 text-sm line-through text-muted-foreground">{d.title}</div>
                  <button
                    onClick={() => onDelete(d.id)}
                    title="삭제"
                    className="opacity-0 group-hover/dl:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive flex-shrink-0"
                  ><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity Record Section (v3: monthly calendar) ────────────────
function GrassSection({
  completionRate, blocks, timerSec, totalPlanMin, focusSecByDate,
}: {
  completionRate: number;
  blocks: Block[];
  timerSec: number;
  totalPlanMin: number;
  focusSecByDate: Record<string, number>;
}) {
  // 오늘이 속한 달을 기본값으로 — 이전에 2026/7 하드코드였던 자리. 앱 첫 마운트 시점의
  // 실제 날짜를 사용해야 배포 후에도 계속 현재 달이 열림.
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [goalMin, setGoalMin] = useState(totalPlanMin);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState(String((totalPlanMin / 60).toFixed(1)));
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const focusedMin = Math.floor(timerSec / 60);
  const goalProgress = goalMin > 0 ? Math.min(Math.round((focusedMin / goalMin) * 100), 100) : 0;

  const handleGoalSave = (e: React.FormEvent) => {
    e.preventDefault();
    setGoalMin(Math.round((parseFloat(goalInput) || 0) * 60));
    setEditingGoal(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  // Build day grid for viewed month
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dayStrings: (string | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(viewYear, viewMonth, i + 1);
      return toDateStr(d);
    }),
  ];
  while (dayStrings.length % 7 !== 0) dayStrings.push(null);

  // 그 날짜의 완료된 블록 목록과 총 집중 시간(분)을 실제 데이터에서 계산.
  // 오늘은 실시간 timerSec을 쓰고, 과거는 timer_sessions에서 집계한 focusSecByDate를 사용.
  const getDayData = (dateStr: string): {
    activities: { title: string; color: string }[];
    focusMin: number;
    goalMet: boolean;
  } => {
    if (dateStr === TODAY_STR) {
      // 오늘 분기도 반드시 date 필터를 함께 걸어야 함. 예전엔 `b.completed`만 걸어서
      // 지난 몇 달간의 모든 완료 블록이 오늘 셀에 activities로 나오고, activeDays 계산도
      // 왜곡되던 버그가 있었음.
      const completedBlocks = blocks.filter(b => b.date === dateStr && b.completed);
      return {
        activities: completedBlocks.map(b => ({ title: b.title, color: b.color })),
        focusMin: focusedMin,
        goalMet: focusedMin >= goalMin && goalMin > 0,
      };
    }
    if (dateStr > TODAY_STR) return { activities: [], focusMin: 0, goalMet: false };
    const completed = blocks.filter(b => b.date === dateStr && b.completed);
    const fm = Math.floor((focusSecByDate[dateStr] ?? 0) / 60);
    return {
      activities: completed.map(b => ({ title: b.title, color: b.color })),
      focusMin: fm,
      goalMet: fm >= goalMin && goalMin > 0,
    };
  };

  // Monthly summary stats
  const monthDays = dayStrings.filter((d): d is string => d !== null && d <= TODAY_STR);
  const achievedDays = monthDays.filter(d => getDayData(d).goalMet).length;
  const activeDays = monthDays.filter(d => getDayData(d).activities.length > 0).length;

  // 오늘까지 이어지는 연속 목표 달성 일수 — 오늘이 아직 달성 안 됐어도 어제 이전 스트릭은
  // 살아있는 것으로 취급 (오늘 시간이 남았으니 유예). 뷰 월과 무관하게 실제 오늘 기준으로 계산.
  const currentStreak = (() => {
    let streak = 0;
    const cur = parseLocalDate(TODAY_STR);
    for (let i = 0; i < 366; i++) {
      const dstr = toDateStr(cur);
      const isToday = dstr === TODAY_STR;
      const met = getDayData(dstr).goalMet;
      if (met) streak++;
      else if (!isToday) break;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  })();

  // "태그별 오늘 현황" 헤더에 맞춰 오늘 블록만 집계. 예전엔 전체 기간을 집계해서
  // 하루가 지날수록 total이 쌓이고 비율이 실제 오늘 현황과 무관해지던 버그가 있었음.
  const todaysBlocks = blocks.filter(b => b.date === TODAY_STR);
  const tagStats = [
    { tag: "공부", color: "#5B7EA8" },
    { tag: "개발", color: "#7B5EA7" },
    { tag: "루틴", color: "#C89A2E" },
    { tag: "운동", color: "#D4622A" },
  ].map(({ tag, color }) => ({
    tag, color,
    done: todaysBlocks.filter(b => b.completed && b.tags.includes(tag)).length,
    total: todaysBlocks.filter(b => b.tags.includes(tag)).length,
  })).filter(t => t.total > 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {/* Checklist completion */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-3">오늘 체크리스트 달성률</div>
            <div className="flex items-end gap-3">
              <div className="text-3xl font-semibold">{completionRate}%</div>
              <CircleProgress value={completionRate} size={44} />
            </div>
            <div className="mt-3 h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completionRate}%` }} />
            </div>
          </div>

          {/* Focus time vs editable goal */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-1">오늘 집중 시간</div>
            <div className="text-3xl font-semibold mt-1" >
              {fmt2(Math.floor(focusedMin / 60))}<span className="text-base font-normal text-muted-foreground">h </span>
              {fmt2(focusedMin % 60)}<span className="text-base font-normal text-muted-foreground">m</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-[11px] text-muted-foreground">목표</span>
              {editingGoal ? (
                <form onSubmit={handleGoalSave} className="flex items-center gap-1">
                  <input
                    autoFocus
                    type="number" step="0.5"
                    value={goalInput}
                    onChange={e => setGoalInput(e.target.value)}
                    className="w-14 px-1.5 py-0.5 text-xs rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                                     />
                  <span className="text-[11px] text-muted-foreground">시간</span>
                  <button type="submit" className="p-0.5 text-sky-600 hover:text-sky-700"><Check size={12} /></button>
                </form>
              ) : (
                <button
                  onClick={() => { setGoalInput(String((goalMin / 60).toFixed(1))); setEditingGoal(true); }}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground group"
                >
                  <span >
                    {Math.floor(goalMin / 60)}h{goalMin % 60 > 0 ? ` ${goalMin % 60}m` : ""}
                  </span>
                  <Edit3 size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              {!editingGoal && goalMin === totalPlanMin && (
                <span className="text-[10px] text-muted-foreground/50">(자동)</span>
              )}
            </div>
            <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-blue-400 transition-all" style={{ width: `${goalProgress}%` }} />
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">{goalProgress}%</div>
          </div>

          {/* This month summary */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1">
              <Flame size={11} /> 연속 일수
            </div>
            <div className="text-3xl font-semibold mt-2">{currentStreak}일</div>
            <div className="text-[11px] text-muted-foreground mt-1">이번 달 {activeDays}일 활동</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">목표 달성 {achievedDays}일</div>
          </div>
        </div>

        {/* Monthly calendar */}
        <div className="rounded-xl border bg-card overflow-hidden mb-4">
          {/* Month nav header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded hover:bg-muted transition-colors"
            >
              <ChevronLeft size={15} className="text-muted-foreground" />
            </button>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">{viewYear}년 {viewMonth + 1}월</span>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block size-2.5 rounded-sm bg-sky-100 border border-sky-300" />
                  목표 달성일
                </span>
              </div>
            </div>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded hover:bg-muted transition-colors"
            >
              <ChevronRight size={15} className="text-muted-foreground" />
            </button>
          </div>

          {/* Day of week headers */}
          <div className="grid grid-cols-7 border-b border-border">
            {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
              <div key={d} className={`text-center text-[10px] py-2 font-medium ${i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-muted-foreground"}`}>
                {d}
              </div>
            ))}
          </div>

          {/* Calendar cells */}
          <div className="grid grid-cols-7">
            {dayStrings.map((dateStr, i) => {
              if (!dateStr) {
                return (
                  <div
                    key={`empty-${i}`}
                    className={`min-h-[90px] border-border ${i % 7 !== 6 ? "border-r" : ""} ${i < dayStrings.length - 7 ? "border-b" : ""}`}
                  />
                );
              }

              const data = getDayData(dateStr);
              const isToday = dateStr === TODAY_STR;
              const isFuture = dateStr > TODAY_STR;
              const dayNum = parseLocalDate(dateStr).getDate();
              const dow = parseLocalDate(dateStr).getDay();
              const MAX_SHOWN = 3;
              const shown = data.activities.slice(0, MAX_SHOWN);
              const overflow = data.activities.length - MAX_SHOWN;
              const isExpanded = expandedDate === dateStr;
              const allShown = isExpanded ? data.activities : shown;
              const col = i % 7;
              const row = Math.floor(i / 7);
              const totalRows = Math.floor(dayStrings.length / 7);

              return (
                <div
                  key={dateStr}
                  className={`min-h-[90px] p-2 relative transition-colors ${
                    col !== 6 ? "border-r border-border" : ""
                  } ${
                    row < totalRows - 1 ? "border-b border-border" : ""
                  } ${
                    data.goalMet ? "bg-sky-50/70" : ""
                  } ${
                    isFuture ? "bg-muted/10" : ""
                  } ${
                    isToday ? "ring-1 ring-inset ring-primary/30" : ""
                  }`}
                >
                  {/* Date number */}
                  <div className="flex items-center justify-between mb-1.5">
                    <span
                      className={`text-xs font-medium inline-flex items-center justify-center ${
                        isToday
                          ? "size-5 rounded-full bg-primary text-primary-foreground text-[10px]"
                          : dow === 0 ? "text-red-400" : dow === 6 ? "text-blue-400" : "text-muted-foreground"
                      }`}
                    >
                      {dayNum}
                    </span>
                    {data.goalMet && (
                      <span className="text-[9px] text-sky-600 font-medium">✓</span>
                    )}
                  </div>

                  {/* Focus time — shown first */}
                  {!isFuture && data.focusMin > 0 && (
                    <div
                      className="text-[9px] font-semibold mb-0.5"
                      style={{ color: data.goalMet ? "#16a34a" : undefined }}
                    >
                      {Math.floor(data.focusMin / 60)}h{data.focusMin % 60 > 0 ? ` ${data.focusMin % 60}m` : ""}
                    </div>
                  )}

                  {/* Activities list — below focus time */}
                  {!isFuture && data.activities.length > 0 && (
                    <div className="space-y-0.5">
                      {allShown.map((act, ai) => (
                        <div key={ai} className="flex items-center gap-1 min-w-0">
                          <span className="size-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: act.color }} />
                          <span className="text-[9px] leading-tight truncate text-foreground/70">{act.title}</span>
                        </div>
                      ))}
                      {overflow > 0 && !isExpanded && (
                        <button onClick={() => setExpandedDate(dateStr)} className="text-[9px] text-muted-foreground hover:text-foreground transition-colors">
                          +{overflow}개
                        </button>
                      )}
                      {isExpanded && (
                        <button onClick={() => setExpandedDate(null)} className="text-[9px] text-muted-foreground hover:text-foreground transition-colors">
                          접기
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tag breakdown */}
        {tagStats.length > 0 && (
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-4">태그별 오늘 현황</div>
            <div className="space-y-3.5">
              {tagStats.map(({ tag, color, done, total }) => (
                <div key={tag} className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 w-14">
                    <span className="size-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-[11px] text-muted-foreground">{tag}</span>
                  </div>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${total > 0 ? (done / total) * 100 : 0}%`, backgroundColor: color }} />
                  </div>
                  <span className="text-[11px] text-muted-foreground w-8 text-right flex-shrink-0" >
                    {done}/{total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memo Section — 메모장 (리스트 · 폴더 · 카테고리 · 정렬 · 드래그) ─────
type SortMode = "custom" | "title-asc" | "title-desc" | "date-asc" | "date-desc";
const SORT_LABELS: Record<SortMode, string> = {
  "custom": "사용자 지정순",
  "title-asc": "제목 ↑",
  "title-desc": "제목 ↓",
  "date-asc": "날짜 ↑ (오래된순)",
  "date-desc": "날짜 ↓ (최신순)",
};
// 폴더 색상 팔레트
const FOLDER_COLORS = ["#5AA9E6", "#7CC0F0", "#A78BFA", "#F7A8B8", "#FCB86B", "#4E8B6E", "#C89A2E", "#B05A7A"];
// 블록/템플릿 프리셋 팔레트 — 파스텔 블루 톤을 축으로 대비색 몇 가지를 섞음.
// 사용자가 '+' 버튼으로 커스텀 색을 추가/삭제할 수 있으며, 현재 팔레트는
// localStorage에 저장되어 재실행 시에도 유지됨.
const DEFAULT_BLOCK_COLORS = ["#5AA9E6", "#7CC0F0", "#A78BFA", "#F7A8B8", "#FCB86B", "#6EE7B7", "#C89A2E", "#B05A7A"];
const BLOCK_PALETTE_KEY = "block_palette_colors";

// 앱 전역 커스텀 툴팁 — [title] 속성이 붙은 아무 요소든 호버하면 native OS 툴팁 대신
// 앱 톤에 맞는 스타일드 툴팁을 띄움. 기존 코드베이스의 title="..." 33개를 손대지 않고
// 한 곳에서 룩앤필을 통일하기 위해 mouseover/out 캡처 리스너로 개입하는 방식.
// - mouseover 시 title 속성을 순간적으로 비워 native 툴팁이 뜨는 걸 억제하고
//   원본 값은 ref에 백업 → mouseout에서 복원 → 컴포넌트가 언마운트돼도 원상복구
// - 350ms delay: 마우스가 스쳐 지나가는 경우엔 안 뜨게
// - 위치: 트리거 요소 하단 중앙 8px 아래, 뷰포트 하단에 걸리면 위로 뒤집힘
function AppTooltipRoot() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; placement: "below" | "above" } | null>(null);
  const currentEl = useRef<HTMLElement | null>(null);
  const originalTitle = useRef<string | null>(null);
  const showTimer = useRef<number | null>(null);

  useEffect(() => {
    const restore = () => {
      if (currentEl.current && originalTitle.current !== null) {
        try { currentEl.current.setAttribute("title", originalTitle.current); } catch {}
      }
      currentEl.current = null;
      originalTitle.current = null;
    };
    const clearAll = () => {
      if (showTimer.current !== null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
      restore();
      setTip(null);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const el = t.closest("[title]") as HTMLElement | null;
      if (!el) { clearAll(); return; }
      if (el === currentEl.current) return;
      // 다른 요소로 옮겨감 — 기존 타이머·툴팁 정리
      if (showTimer.current !== null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
      restore();
      setTip(null);
      const raw = el.getAttribute("title");
      if (!raw) return;
      currentEl.current = el;
      originalTitle.current = raw;
      try { el.setAttribute("title", ""); } catch {}
      showTimer.current = window.setTimeout(() => {
        if (!currentEl.current) return;
        const rect = currentEl.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const belowY = rect.bottom + 8;
        const wouldOverflow = belowY + 40 > window.innerHeight;
        setTip({
          text: raw,
          x: centerX,
          y: wouldOverflow ? rect.top - 8 : belowY,
          placement: wouldOverflow ? "above" : "below",
        });
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!currentEl.current) return;
      if (related && currentEl.current.contains(related)) return;
      clearAll();
    };
    const onDown = () => clearAll();
    const onScroll = () => clearAll();

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      clearAll();
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: tip.x,
        top: tip.y,
        transform: tip.placement === "below" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        zIndex: 9999,
      }}
      className="pointer-events-none rounded-lg bg-foreground/95 text-background text-[11px] font-medium px-2.5 py-1 shadow-lg max-w-[240px] whitespace-normal leading-snug"
    >
      {tip.text}
    </div>
  );
}

// 팔레트에 커스텀 색을 추가할 때 뜨는 인라인 편집 카드.
// native color picker의 onChange가 슬라이더 이동마다 마구 발동해 팔레트가 도배되는
// 문제를 막기 위해, 여기서 draft만 갱신하고 "추가" 버튼을 눌러야만 실제 팔레트에 등록됨.
function CustomColorPickerInline({ initial, onAdd, onClose }: {
  initial: string;
  onAdd: (color: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const isValid = /^#[0-9a-fA-F]{6}$/.test(draft.trim());
  const normalized = draft.trim();
  const confirm = () => { if (isValid) { onAdd(normalized); onClose(); } };
  const swatchColor = isValid ? normalized : "#5AA9E6";
  return (
    <div className="mt-2.5 p-2.5 rounded-xl border border-border bg-muted/30 space-y-2">
      <div className="flex items-center gap-2">
        <label
          className="relative size-8 rounded-lg cursor-pointer border border-border/60 flex-shrink-0 hover:opacity-80 transition-opacity"
          style={{ backgroundColor: swatchColor }}
          title="색상 대화상자 열기"
        >
          <input
            type="color"
            value={swatchColor}
            onChange={e => setDraft(e.target.value)}
            className="sr-only"
          />
        </label>
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); confirm(); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder="#5AA9E6"
          maxLength={7}
          className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-lg bg-card border border-border outline-none focus:ring-1 focus:ring-ring font-mono uppercase"
        />
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={confirm}
          disabled={!isValid}
          className="flex-1 text-[11px] py-1.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40 transition-opacity"
        >추가</button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 text-[11px] py-1.5 rounded-lg bg-muted hover:bg-muted/60 text-foreground font-medium transition-colors"
        >닫기</button>
      </div>
    </div>
  );
}

// 마크다운 프리뷰 공용 클래스
const PROSE_CLASS = "prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-li:my-1 prose-code:before:hidden prose-code:after:hidden prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-primary";

function MemoSection() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null이면 리스트 뷰

  useEffect(() => {
    (async () => {
      try {
        const [ns, fs] = await Promise.all([fetchNotes(), fetchNoteFolders()]);
        setNotes(ns);
        setFolders(fs);
      } catch (e) { console.error(e); }
      setLoaded(true);
    })();
  }, []);

  const refreshNotes = async () => { try { setNotes(await fetchNotes()); } catch (e) { console.error(e); } };
  const refreshFolders = async () => { try { setFolders(await fetchNoteFolders()); } catch (e) { console.error(e); } };

  const handleCreateNote = async () => {
    try {
      const n = await createNote({ title: "", content: "" });
      setNotes(ns => [n, ...ns]);
      setEditingId(n.id);
    } catch (e) { notifyError("새 메모 만들기 실패")(e); }
  };

  if (!loaded) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">불러오는 중…</div>;
  }

  const editingNote = notes.find(n => n.id === editingId) ?? null;
  if (editingNote) {
    return (
      <NoteEditor
        note={editingNote}
        folders={folders}
        allCategories={Array.from(new Set(notes.map(n => n.category).filter(Boolean)))}
        onBack={() => { setEditingId(null); refreshNotes(); }}
        onChangeLocal={patch => setNotes(ns => ns.map(x => x.id === editingNote.id ? { ...x, ...patch } : x))}
      />
    );
  }

  return (
    <NoteList
      notes={notes}
      folders={folders}
      onOpen={id => setEditingId(id)}
      onCreateNote={handleCreateNote}
      refreshNotes={refreshNotes}
      refreshFolders={refreshFolders}
      setNotes={setNotes}
    />
  );
}

// ── 메모 리스트 뷰 ──────────────────────────────────────────────────
function NoteList({
  notes, folders, onOpen, onCreateNote, refreshNotes, refreshFolders, setNotes,
}: {
  notes: Note[];
  folders: NoteFolder[];
  onOpen: (id: string) => void;
  onCreateNote: () => void;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
}) {
  const [sortMode, setSortMode] = useState<SortMode>("custom");
  const [sortOpen, setSortOpen] = useState(false);
  // viewFolderId: null이면 루트 뷰(폴더 카드 + 폴더 없는 노트), 폴더 id면 그 폴더의 노트만 노출.
  // 예전엔 "전체 / 폴더 없음 / 각 폴더" 필터 칩 바가 있었는데, 폴더 자체를 리스트 아이템으로
  // 두고 클릭으로 진입하는 파일탐색기 스타일이 더 직관적이라 그렇게 재설계.
  const [viewFolderId, setViewFolderId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [menuNoteId, setMenuNoteId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState(FOLDER_COLORS[0]);
  // 드래그 오버 중인 대상: 특정 폴더 id, "back"(뒤로가기 = 루트로 이동), null(없음)
  const [dropFolderId, setDropFolderId] = useState<string | "back" | null>(null);
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);

  const categories = Array.from(new Set(notes.map(n => n.category).filter(Boolean)));
  const currentFolder = viewFolderId ? folders.find(f => f.id === viewFolderId) ?? null : null;

  // 필터: 현재 뷰(루트=null 또는 특정 폴더)의 노트만 노출.
  let shown = notes.filter(n => {
    if (n.folderId !== viewFolderId) return false;
    if (activeCategory && n.category !== activeCategory) return false;
    return true;
  });
  // 정렬
  shown = [...shown].sort((a, b) => {
    switch (sortMode) {
      case "title-asc": return (a.title || "제목 없음").localeCompare(b.title || "제목 없음");
      case "title-desc": return (b.title || "제목 없음").localeCompare(a.title || "제목 없음");
      case "date-asc": return a.updatedAt.localeCompare(b.updatedAt);
      case "date-desc": return b.updatedAt.localeCompare(a.updatedAt);
      default: return a.sortOrder - b.sortOrder;
    }
  });

  const handleMoveNote = async (noteId: string, folderId: string | null) => {
    setNotes(ns => ns.map(n => n.id === noteId ? { ...n, folderId } : n));
    try { await moveNoteToFolder(noteId, folderId); } catch (e) { notifyError("메모 이동 실패")(e); }
    setMenuNoteId(null);
  };

  const handleDeleteNote = async (noteId: string) => {
    setNotes(ns => ns.filter(n => n.id !== noteId));
    try { await deleteNote(noteId); } catch (e) { notifyError("메모 삭제 실패")(e); }
    setMenuNoteId(null);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try { await createFolder({ name, color: newFolderColor }); await refreshFolders(); } catch (e) { notifyError("폴더 만들기 실패")(e); }
    setNewFolderName(""); setNewFolderColor(FOLDER_COLORS[0]); setShowNewFolder(false);
  };

  const handleDeleteFolder = async (folderId: string) => {
    if (viewFolderId === folderId) setViewFolderId(null);
    try { await deleteFolder(folderId); await Promise.all([refreshFolders(), refreshNotes()]); } catch (e) { notifyError("폴더 삭제 실패")(e); }
  };

  // 노트 카드 간 드래그로 재정렬 — 정렬 모드가 custom이 아니면 custom으로 전환
  const handleReorder = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ids = shown.map(n => n.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // shown에 없는(다른 폴더/카테고리) 노트는 뒤에 유지
    const rest = notes.map(n => n.id).filter(id => !ids.includes(id));
    const finalOrder = [...ids, ...rest];
    setSortMode("custom");
    setNotes(ns => [...ns].sort((a, b) => finalOrder.indexOf(a.id) - finalOrder.indexOf(b.id)).map((n, i) => ({ ...n, sortOrder: i })));
    try { await reorderNotes(finalOrder); } catch (e) { notifyError("메모 순서 저장 실패")(e); }
  };

  return (
    <div className="flex-1 overflow-y-auto" onClick={() => setMenuNoteId(null)}>
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Header — 타이틀 생략, 도구 버튼(정렬/새 폴더/새 메모)만 우측에 배치 */}
        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-2">
            {/* 정렬 드롭다운 */}
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); setSortOpen(v => !v); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-card text-xs hover:bg-muted transition-colors"
              >
                <ArrowUpDown size={13} /> {SORT_LABELS[sortMode]}
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-44 bg-card border border-border rounded-lg shadow-lg z-50 p-1">
                    {(Object.keys(SORT_LABELS) as SortMode[]).map(m => (
                      <button
                        key={m}
                        onClick={() => { setSortMode(m); setSortOpen(false); }}
                        className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors ${sortMode === m ? "text-primary font-medium" : "text-foreground"}`}
                      >
                        {SORT_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setShowNewFolder(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-card text-xs hover:bg-muted transition-colors"
            >
              <FolderPlus size={13} /> 새 폴더
            </button>
            <button
              onClick={onCreateNote}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={13} /> 새 메모
            </button>
          </div>
        </div>

        {/* 새 폴더 인라인 폼 */}
        {showNewFolder && (
          <div className="mb-4 p-4 rounded-xl border bg-card">
            <div className="flex items-center gap-2 mb-3">
              <input
                autoFocus
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
                placeholder="폴더 이름"
                className="flex-1 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
              />
              <button onClick={handleCreateFolder} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium">만들기</button>
              <button onClick={() => setShowNewFolder(false)} className="p-2 text-muted-foreground hover:text-foreground"><X size={14} /></button>
            </div>
            <div className="flex items-center gap-1.5">
              {FOLDER_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setNewFolderColor(c)}
                  className={`size-6 rounded-full transition-transform ${newFolderColor === c ? "ring-2 ring-offset-2 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        )}

        {/* 폴더 안에 들어와 있으면 뒤로가기 헤더 노출. 뒤로가기 버튼은 노트를 드래그해서
             드롭하면 루트로 꺼내는 드롭 타깃 역할도 겸함 — 폴더에서 밖으로 옮길 때 컨텍스트
             메뉴를 굳이 안 열어도 되도록. */}
        {currentFolder && (
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={() => setViewFolderId(null)}
              onDragOver={e => { if (dragNoteId) { e.preventDefault(); setDropFolderId("back"); } }}
              onDragLeave={() => setDropFolderId(null)}
              onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData("noteId"); if (id) handleMoveNote(id, null); setDropFolderId(null); setViewFolderId(null); }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                dropFolderId === "back" ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-card hover:bg-muted"
              }`}
            >
              <ArrowLeft size={13} /> 뒤로
            </button>
            <div className="flex items-center gap-1.5 text-sm">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: currentFolder.color }} />
              <span className="font-medium">{currentFolder.name}</span>
              <span className="text-[11px] text-muted-foreground">{shown.length}</span>
            </div>
          </div>
        )}

        {/* 카테고리 필터 칩 */}
        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-5">
            <span className="text-[10px] text-muted-foreground mr-1">카테고리</span>
            <button
              onClick={() => setActiveCategory(null)}
              className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${activeCategory === null ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >전체</button>
            {categories.map(c => (
              <button
                key={c}
                onClick={() => setActiveCategory(activeCategory === c ? null : c)}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${activeCategory === c ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}
              >{c}</button>
            ))}
          </div>
        )}

        {/* 목록: 루트 뷰에선 폴더 카드가 노트 위에 먼저 나오고, 폴더 안에선 노트만.
             폴더 카드에 노트를 드래그하면 그 폴더로 이동. */}
        {shown.length === 0 && (viewFolderId !== null || folders.length === 0) ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            {notes.length === 0 && folders.length === 0
              ? "아직 메모가 없어요. \"새 메모\"로 첫 메모를 만들어보세요."
              : viewFolderId !== null
              ? "이 폴더에는 아직 메모가 없어요. 다른 메모를 여기로 드래그해 옮길 수 있어요."
              : "이 조건에 해당하는 메모가 없어요."}
          </div>
        ) : (
          <div className="space-y-2">
            {viewFolderId === null && folders.map(f => (
              <FolderCard
                key={f.id}
                folder={f}
                count={notes.filter(n => n.folderId === f.id).length}
                isDropTarget={dropFolderId === f.id}
                onOpen={() => setViewFolderId(f.id)}
                onDelete={() => handleDeleteFolder(f.id)}
                onDragOver={e => { if (dragNoteId) { e.preventDefault(); setDropFolderId(f.id); } }}
                onDragLeave={() => setDropFolderId(null)}
                onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData("noteId"); if (id) handleMoveNote(id, f.id); setDropFolderId(null); }}
              />
            ))}
            {shown.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                folder={folders.find(f => f.id === n.folderId) ?? null}
                menuOpen={menuNoteId === n.id}
                folders={folders}
                onOpen={() => onOpen(n.id)}
                onToggleMenu={e => { e.stopPropagation(); setMenuNoteId(menuNoteId === n.id ? null : n.id); }}
                onMove={folderId => handleMoveNote(n.id, folderId)}
                onDelete={() => handleDeleteNote(n.id)}
                onDragStart={e => { e.dataTransfer.setData("noteId", n.id); setDragNoteId(n.id); }}
                onDragEnd={() => setDragNoteId(null)}
                onDragOverCard={e => { if (dragNoteId && dragNoteId !== n.id) e.preventDefault(); }}
                onDropCard={e => { e.preventDefault(); const id = e.dataTransfer.getData("noteId"); if (id) handleReorder(id, n.id); setDragNoteId(null); }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// 노트 리스트 안에 폴더를 카드로 노출. NoteCard와 시각 언어를 맞춰(rounded-xl, p-4, border)
// 같은 리스트에 섞여도 위화감이 없게 함. 드래그된 노트가 위에 오면 primary 링으로 강조하고,
// 클릭하면 폴더 안으로 진입. hover 시 우측에 삭제 버튼 노출.
function FolderCard({
  folder, count, isDropTarget, onOpen, onDelete, onDragOver, onDragLeave, onDrop,
}: {
  folder: NoteFolder; count: number; isDropTarget: boolean;
  onOpen: () => void; onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group/folder relative flex items-center gap-3 p-4 rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer ${
        isDropTarget ? "border-primary bg-primary/10 ring-1 ring-primary" : ""
      }`}
    >
      <div className="flex-shrink-0 flex items-center justify-center size-9 rounded-lg" style={{ backgroundColor: folder.color + "22" }}>
        <Folder size={16} style={{ color: folder.color }} fill={folder.color} fillOpacity={0.35} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{folder.name}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{count}개 메모</div>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete(); }}
        title="폴더 삭제"
        className="opacity-0 group-hover/folder:opacity-100 transition-opacity p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      ><Trash2 size={13} /></button>
    </div>
  );
}

function NoteCard({
  note, folder, folders, menuOpen, onOpen, onToggleMenu, onMove, onDelete,
  onDragStart, onDragEnd, onDragOverCard, onDropCard,
}: {
  note: Note; folder: NoteFolder | null; folders: NoteFolder[]; menuOpen: boolean;
  onOpen: () => void; onToggleMenu: (e: React.MouseEvent) => void;
  onMove: (folderId: string | null) => void; onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void; onDragEnd: (e: React.DragEvent) => void;
  onDragOverCard: (e: React.DragEvent) => void; onDropCard: (e: React.DragEvent) => void;
}) {
  const preview = note.content.replace(/[#*`_>\-\[\]]/g, "").replace(/\n+/g, " ").trim();
  const dateStr = note.updatedAt ? note.updatedAt.slice(0, 10) : "";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onDrop={onDropCard}
      onClick={onOpen}
      className="group/note relative flex items-start gap-3 p-4 rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{note.title.trim() || "제목 없음"}</span>
          {note.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">{note.category}</span>}
        </div>
        {preview && <p className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{preview}</p>}
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
          {folder && <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ backgroundColor: folder.color }} />{folder.name}</span>}
          <span>{dateStr}</span>
        </div>
      </div>

      {/* 3-dot 메뉴 — 카드 전체 높이 기준 세로 중앙 */}
      <div className="relative flex-shrink-0 self-stretch flex items-center" onClick={e => e.stopPropagation()}>
        <button
          onClick={onToggleMenu}
          className="p-1 rounded-md text-muted-foreground hover:bg-muted opacity-0 group-hover/note:opacity-100 transition-opacity"
        ><MoreVertical size={15} /></button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-50 p-1">
            <div className="text-[10px] text-muted-foreground px-2.5 py-1">폴더로 이동</div>
            <button
              onClick={() => onMove(null)}
              className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors flex items-center gap-2 ${!note.folderId ? "text-primary" : ""}`}
            ><Folder size={12} /> 폴더 없음</button>
            {folders.map(f => (
              <button
                key={f.id}
                onClick={() => onMove(f.id)}
                className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors flex items-center gap-2 ${note.folderId === f.id ? "text-primary" : ""}`}
              ><span className="size-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: f.color }} /> {f.name}</button>
            ))}
            <div className="h-px bg-border my-1" />
            <button
              onClick={onDelete}
              className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2"
            ><Trash2 size={12} /> 삭제</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메모 편집기 뷰 (생성·수정 공용) ─────────────────────────────────
function NoteEditor({
  note, folders, allCategories, onBack, onChangeLocal,
}: {
  note: Note;
  folders: NoteFolder[];
  allCategories: string[];
  onBack: () => void;
  onChangeLocal: (patch: Partial<Note>) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [category, setCategory] = useState(note.category);
  const [folderId, setFolderId] = useState<string | null>(note.folderId);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("saved");
  const first = useRef(true);
  // 아직 debounce 대기 중인 미저장 변경을 추적. 사용자가 debounce 안 끝난 상태에서
  // 뒤로가기를 누르면 아래 unmount cleanup이 이걸 즉시 flush해서 데이터 유실을 막음.
  // 예전엔 debounce cleanup(clearTimeout)만 있어서 마지막 몇 초 입력이 그대로 날아감.
  const pendingPatchRef = useRef<{ title: string; content: string; category: string; folderId: string | null } | null>(null);

  // 700ms debounce 자동 저장
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSaveState("saving");
    const patch = { title, content, category, folderId };
    pendingPatchRef.current = patch;
    const t = setTimeout(async () => {
      try {
        await updateNote(note.id, patch);
        pendingPatchRef.current = null;
        onChangeLocal(patch);
        setSaveState("saved");
      } catch (e) { setSaveState("idle"); notifyError("메모 저장 실패")(e); }
    }, 700);
    return () => clearTimeout(t);
  }, [title, content, category, folderId]);

  // 언마운트 시 아직 debounce 대기 중이던 변경을 즉시 저장. 뒤로가기 버튼으로 편집기를
  // 닫을 때 마지막 입력이 유실되지 않도록 하는 안전망.
  //
  // onChangeLocal은 부모 MemoSection이 매 렌더마다 새 함수로 만들어 내려주므로 deps에
  // 그대로 넣으면 부모가 다른 이유로 리렌더될 때마다 cleanup이 발화해 debounce 대기 중이던
  // 저장을 중복으로 트리거함. ref로 감싸서 최신 함수는 참조하되 effect는 재등록되지 않게.
  const onChangeLocalRef = useRef(onChangeLocal);
  onChangeLocalRef.current = onChangeLocal;
  useEffect(() => () => {
    const p = pendingPatchRef.current;
    if (p) {
      updateNote(note.id, p)
        .then(() => onChangeLocalRef.current(p))
        .catch(e => console.error("메모 저장 실패", e));
    }
  }, [note.id]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* 상단 바 */}
      <div className="flex items-center gap-3 px-8 pt-8 pb-3 flex-shrink-0">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors" title="목록으로">
          <ArrowLeft size={18} />
        </button>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="제목 없음"
          className="flex-1 text-2xl font-medium bg-transparent outline-none placeholder:text-muted-foreground/50"
        />
        <span className="text-[11px] text-muted-foreground flex-shrink-0">
          {saveState === "saving" ? "저장 중…" : saveState === "saved" ? "저장됨" : ""}
        </span>
      </div>

      {/* 메타: 카테고리 + 폴더 */}
      <div className="flex items-center gap-3 px-8 pb-3 flex-shrink-0">
        <input
          list="note-categories"
          value={category}
          onChange={e => setCategory(e.target.value)}
          placeholder="카테고리"
          className="px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring w-40"
        />
        <datalist id="note-categories">
          {allCategories.map(c => <option key={c} value={c} />)}
        </datalist>
        <select
          value={folderId ?? ""}
          onChange={e => setFolderId(e.target.value || null)}
          className="px-3 py-1.5 rounded-lg bg-muted text-xs outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
        >
          <option value="">폴더 없음</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>

      {/* 편집 + 프리뷰 */}
      <div className="flex-1 overflow-hidden grid grid-cols-2 gap-4 px-8 pb-8 min-h-0">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="여기에 마크다운으로 자유롭게 적어보세요.&#10;&#10;# 제목&#10;- 목록&#10;- [ ] 체크박스&#10;**굵게**, *기울임*, `code`"
          className="w-full h-full resize-none rounded-xl border bg-card p-4 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring leading-relaxed"
          spellCheck={false}
          autoFocus
        />
        <div className={`w-full h-full overflow-y-auto rounded-xl border bg-card p-4 ${PROSE_CLASS}`}>
          {content.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          ) : (
            <p className="text-muted-foreground text-sm italic">미리보기가 여기에 표시돼요</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Settings Section ───────────────────────────────────────────────
function SettingsSection({
  pomodoroOn, setPomodoroOn, pomWork, setPomWork,
  pomBreak, setPomBreak, abandonOn, setAbandonOn, abandonMin, setAbandonMin,
  darkMode, setDarkMode,
}: {
  pomodoroOn: boolean; setPomodoroOn: (v: boolean) => void;
  pomWork: number; setPomWork: (v: number) => void;
  pomBreak: number; setPomBreak: (v: number) => void;
  abandonOn: boolean; setAbandonOn: (v: boolean) => void;
  abandonMin: number; setAbandonMin: (v: number) => void;
  darkMode: boolean; setDarkMode: (v: boolean) => void;
}) {
  // 데이터 백업/업데이트 상태 — JSON export/import UI는 개인용에서 직관적이지 않아 제거,
  // 데이터 이전이 필요할 때는 %APPDATA%/…/backups 폴더의 .db 파일을 직접 복사하면 됨.
  // 두 버튼의 busy 상태를 분리 — 하나 누르면 둘 다 disabled:opacity-50 로 깜빡이던 버그 방지.
  // 추가로 ref 기반 재진입 가드 — React 재렌더 전에 클릭 이벤트가 중첩되어 setState가
  // 반영되기 전 동일 핸들러가 두 번 실행되는 경우까지 막음.
  type Target = "backup" | "update";
  const [backupBusy, setBackupBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const backupBusyRef = useRef(false);
  const updateBusyRef = useRef(false);
  // 상태 토스트를 각 버튼 옆에 인라인 표시 — target으로 어느 버튼에 붙일지 지정.
  const [statusMsg, setStatusMsg] = useState<{ kind: "ok" | "err"; text: string; target: Target } | null>(null);
  const [statusVisible, setStatusVisible] = useState(false);
  const flashTimersRef = useRef<number[]>([]);
  const [lastBackupTs, setLastBackupTs] = useState<number | null>(getLastBackupTimestamp());
  // 사용 가능한 업데이트가 있을 때 확인 카드를 인라인으로 표시 — 예전엔 window.confirm으로
  // OS-native 다이얼로그를 띄웠지만 앱 톤과 어울리지 않고 OS/WebView에 따라 룩앤필이 달라짐.
  const [pendingUpdate, setPendingUpdate] = useState<
    Extract<UpdateCheckResult, { status: "available" }> | null
  >(null);
  const [installing, setInstalling] = useState(false);
  const flash = (target: Target, kind: "ok" | "err", text: string) => {
    flashTimersRef.current.forEach(t => window.clearTimeout(t));
    flashTimersRef.current = [];
    setStatusMsg({ kind, text, target });
    setStatusVisible(false);
    // 순서: mount(opacity-0) → 다음 페인트 프레임 뒤 opacity 0→1 (fade in 500ms) → 1s 유지 → opacity 1→0 (fade out 500ms) → unmount.
    // requestAnimationFrame을 두 번 감싸서 React 커밋 + 브라우저 첫 페인트가 완전히 끝난 뒤에
    // opacity 클래스를 바꾸도록 보장 — 안 그러면 브라우저가 opacity-0을 안 그리고 바로 opacity-100으로 뛰어 트랜지션이 안 걸리는 케이스가 있음.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setStatusVisible(true));
    });
    flashTimersRef.current.push(window.setTimeout(() => setStatusVisible(false), 1550));
    flashTimersRef.current.push(window.setTimeout(() => setStatusMsg(null), 2100));
  };
  useEffect(() => () => { flashTimersRef.current.forEach(t => window.clearTimeout(t)); }, []);

  const handleBackupNow = async () => {
    if (backupBusyRef.current) return;
    backupBusyRef.current = true;
    setBackupBusy(true);
    try {
      await createBackupNow();
      setLastBackupTs(getLastBackupTimestamp());
      flash("backup", "ok", "백업 성공");
    } catch (e: any) {
      flash("backup", "err", `백업 실패: ${e?.message ?? e}`);
    } finally {
      setBackupBusy(false);
      backupBusyRef.current = false;
    }
  };
  const handleUpdateCheck = async () => {
    if (updateBusyRef.current) return;
    updateBusyRef.current = true;
    setUpdateBusy(true);
    try {
      const r = await checkForUpdate();
      if (r.status === "up-to-date") {
        flash("update", "ok", "이미 최신 버전이에요.");
      } else if (r.status === "available") {
        // 인라인 확인 카드로 전환 — 사용자가 "설치"를 눌러야 실제 다운로드+재시작이 시작됨.
        setPendingUpdate(r);
      } else {
        flash("update", "err", `업데이트 확인 실패: ${r.error}`);
      }
    } catch (e: any) {
      flash("update", "err", `업데이트 확인 실패: ${e?.message ?? e}`);
    } finally {
      setUpdateBusy(false);
      updateBusyRef.current = false;
    }
  };
  const handleInstallUpdate = async () => {
    if (!pendingUpdate || installing) return;
    setInstalling(true);
    try {
      await installUpdate(pendingUpdate.update);
      // installUpdate 안에서 relaunch()가 실행되므로 정상 흐름에선 여기 도달 전에 앱이 재시작됨.
    } catch (e: any) {
      flash("update", "err", `설치 실패: ${e?.message ?? e}`);
      setInstalling(false);
      setPendingUpdate(null);
    }
  };

  const lastBackupLabel = lastBackupTs
    ? new Date(lastBackupTs).toLocaleDateString("ko-KR", { dateStyle: "medium" })
    : "없음";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-8 pt-16 pb-8">
        <div className="space-y-4">
          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">다크 모드</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">어두운 색상 테마 사용</div>
              </div>
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${darkMode ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${darkMode ? "left-5" : "left-1"}`} />
              </button>
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">뽀모도로 모드</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">전역 타이머에 뽀모도로 사이클 적용</div>
              </div>
              <button
                onClick={() => setPomodoroOn(!pomodoroOn)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${pomodoroOn ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${pomodoroOn ? "left-5" : "left-1"}`} />
              </button>
            </div>
            {pomodoroOn && (
              <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-border">
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1.5">공부 시간 (분)</label>
                  <input type="number" min={1} value={pomWork} onChange={e => setPomWork(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1.5">쉬는 시간 (분)</label>
                  <input type="number" min={1} value={pomBreak} onChange={e => setPomBreak(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">방치 알림</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">수동 정지 후 지정 시간이 지나면 브라우저 알림 발송</div>
              </div>
              <button
                onClick={() => setAbandonOn(!abandonOn)}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${abandonOn ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${abandonOn ? "left-5" : "left-1"}`} />
              </button>
            </div>
            {abandonOn && (
              <div className="mt-4 pt-4 border-t border-border">
                <label className="block text-[11px] text-muted-foreground mb-1.5">알림 임계 시간 (분)</label>
                <input type="number" min={1} value={abandonMin} onChange={e => setAbandonMin(Math.max(1, Number(e.target.value) || 1))}
                  className="w-40 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">데이터 백업</div>
            <div className="text-[11px] text-muted-foreground mb-3">
              하루 1회 자동 백업 · 마지막 백업: <span className="text-foreground">{lastBackupLabel}</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleBackupNow}
                disabled={backupBusy}
                className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >{backupBusy ? "백업 중…" : "지금 백업"}</button>
              {statusMsg?.target === "backup" && (
                <span className={`min-w-0 text-[11px] leading-snug transition-opacity duration-500 ease-out ${statusVisible ? "opacity-100" : "opacity-0"} ${statusMsg.kind === "ok" ? "text-primary" : "text-destructive"}`}>
                  {statusMsg.text}
                </span>
              )}
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">앱 업데이트</div>
            <div className="text-[11px] text-muted-foreground mb-3">
              최신 릴리스를 확인하고 설치. 서명된 패키지만 적용되며 설치 후 앱이 재시작됩니다.
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleUpdateCheck}
                disabled={updateBusy || installing || !!pendingUpdate}
                className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >{updateBusy ? "확인 중…" : "업데이트 확인"}</button>
              {statusMsg?.target === "update" && !pendingUpdate && (
                <span className={`min-w-0 text-[11px] leading-snug transition-opacity duration-500 ease-out ${statusVisible ? "opacity-100" : "opacity-0"} ${statusMsg.kind === "ok" ? "text-primary" : "text-destructive"}`}>
                  {statusMsg.text}
                </span>
              )}
            </div>
            {pendingUpdate && (
              <div className="mt-3 pt-3 border-t border-border space-y-2">
                <div className="text-xs">
                  <span className="text-muted-foreground">새 버전</span>{" "}
                  <span className="font-medium">v{pendingUpdate.next}</span>
                  {pendingUpdate.current && (
                    <span className="text-muted-foreground"> (현재 v{pendingUpdate.current})</span>
                  )}
                </div>
                {pendingUpdate.notes && (
                  <div className="text-[11px] text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto rounded-md bg-muted/40 p-2">
                    {pendingUpdate.notes}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleInstallUpdate}
                    disabled={installing}
                    className="flex-shrink-0 whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
                  >{installing ? "설치 중…" : "지금 설치 후 재시작"}</button>
                  <button
                    onClick={() => setPendingUpdate(null)}
                    disabled={installing}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-muted hover:bg-muted/70 text-foreground disabled:opacity-50 transition-colors"
                  >나중에</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Block Detail Panel — no timer (v2) ─────────────────────────────
function BlockDetailPanel({
  block, childBlocks, templates, sameDayBlocks, initialEditTitle, onClose, onToggle, onDelete, onDeleteRepeatGroup, onSetRepeat, onMemoSave, onTitleSave, onColorSave,
  paletteColors, onAddPaletteColor, onRemovePaletteColor,
  onSelectChild, onToggleChild, onDeleteChild, onAddTimeblockChild, onGoToParent, onSetNextBlock,
}: {
  block: Block;
  childBlocks: Block[];
  templates: Template[];
  sameDayBlocks: Block[];
  initialEditTitle?: boolean;
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onDeleteRepeatGroup: (fromDate: string) => void;
  onSetRepeat: (repeat: BlockRepeat) => void;
  onMemoSave: (memo: string) => void;
  onTitleSave: (title: string) => void;
  onColorSave: (color: string) => void;
  paletteColors: string[];
  onAddPaletteColor: (color: string) => void;
  onRemovePaletteColor: (color: string) => void;
  onSelectChild: (b: Block) => void;
  onToggleChild: (id: string) => void;
  onDeleteChild: (id: string) => void;
  onAddTimeblockChild: (child: { templateId: string; title: string; color: string; tags: string[]; startH: number; startM: number; endH: number; endM: number }) => void;
  onGoToParent: () => void;
  onSetNextBlock: (nextBlockId: string | null) => void;
}) {
  const [memo, setMemo] = useState(block.memo);
  // 헤더의 제목 인라인 편집 — 캘린더 직접 생성 블록은 initialEditTitle=true로 넘어와서
  // 패널이 뜨자마자 편집 모드로 진입하고 input에 포커스가 잡힘.
  // Enter/blur로 저장, Esc로 취소. 빈 문자열은 무시하고 원래 제목 유지.
  const [editingTitle, setEditingTitle] = useState(!!initialEditTitle);
  const [titleDraft, setTitleDraft] = useState(block.title);
  const [showBlockCustomColor, setShowBlockCustomColor] = useState(false);
  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== block.title) onTitleSave(trimmed);
    else setTitleDraft(block.title);
    setEditingTitle(false);
  };

  // 체크리스트형 자식(무제한 중첩) — block.id 기준으로 불러옴. 위 BlockDetailPanel은
  // key={selectedBlock.id}로 블록이 바뀔 때마다 통째로 리마운트되므로 이 useEffect는
  // 이 블록의 데이터만 다룸.
  const [items, setItems] = useState<ChecklistItemT[]>([]);
  useEffect(() => {
    fetchChecklistItems(block.id).then(setItems).catch(notifyError("체크리스트 불러오기 실패"));
  }, [block.id]);

  const addChecklistItem = async (text: string, parentItemId?: string) => {
    try {
      const created = await createChecklistItem(block.id, text, parentItemId);
      setItems(is => [...is, created]);
    } catch (e) { notifyError("체크리스트 항목 추가 실패")(e); }
  };
  const toggleChecklistItem = async (id: string, completed: boolean) => {
    setItems(is => is.map(i => i.id === id ? { ...i, completed } : i));
    try { await toggleChecklistItemRow(id, completed); } catch (e) { notifyError("체크리스트 저장 실패")(e); }
  };
  const deleteChecklistItem = async (id: string) => {
    // DB의 FK가 ON DELETE CASCADE라 하위 항목도 서버에서 같이 지워짐 — 로컬 상태도 같이 정리
    const toRemove = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of items) {
        if (it.parentItemId && toRemove.has(it.parentItemId) && !toRemove.has(it.id)) { toRemove.add(it.id); grew = true; }
      }
    }
    setItems(is => is.filter(i => !toRemove.has(i.id)));
    try { await deleteChecklistItemRow(id); } catch (e) { notifyError("체크리스트 삭제 실패")(e); }
  };

  // 독립 타임블록형 자식 추가 폼 — 부모→자식 1단계 제약이라 이 블록 자신이 이미 자식인 경우
  // (block.parentBlockId 존재) 렌더링 자체를 하지 않음(아래 JSX 참고)
  const [showAddTimeblock, setShowAddTimeblock] = useState(false);
  const [childTplId, setChildTplId] = useState("");
  const [childStart, setChildStart] = useState("09:00");
  const [childEnd, setChildEnd] = useState("10:00");
  const submitTimeblockChild = () => {
    const tpl = templates.find(t => t.id === childTplId);
    if (!tpl) return;
    const [sh, sm] = childStart.split(":").map(Number);
    const [eh, em] = childEnd.split(":").map(Number);
    // 시간 입력이 비어 있거나 잘못돼 NaN이 나오면 그대로 진행할 경우 DB에 "NaN:undefined:00"
    // 같은 깨진 문자열이 저장되므로 여기서 방어. NaN 비교는 항상 false이므로 아래 시간
    // 비교로는 걸러지지 않음.
    if (![sh, sm, eh, em].every(n => Number.isFinite(n))) return;
    if (eh * 60 + em <= sh * 60 + sm) return;
    onAddTimeblockChild({ templateId: tpl.id, title: tpl.title, color: tpl.color, tags: tpl.tags, startH: sh, startM: sm, endH: eh, endM: em });
    setShowAddTimeblock(false);
    setChildTplId("");
  };

  // Repeat settings
  const [repeatType, setRepeatType] = useState<"none" | "daily" | "weekly">(block.repeat?.type ?? "none");
  const [repeatDays, setRepeatDays] = useState<number[]>(block.repeat?.days ?? []);
  const [repeatEndType, setRepeatEndType] = useState<"none" | "count" | "date">(block.repeat?.endType ?? "none");
  const [repeatEndCount, setRepeatEndCount] = useState(block.repeat?.endCount ?? 10);
  const [repeatEndDate, setRepeatEndDate] = useState(block.repeat?.endDate ?? "");
  const [showRepeatSaved, setShowRepeatSaved] = useState(false);

  // Delete confirmation for repeat blocks
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const DAYS_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

  const saveRepeat = () => {
    if (repeatType === "none") return;
    onSetRepeat({ type: repeatType as "daily" | "weekly", days: repeatDays, endType: repeatEndType, endCount: repeatEndCount, endDate: repeatEndDate });
    setShowRepeatSaved(true);
    setTimeout(() => setShowRepeatSaved(false), 2000);
  };

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border flex-shrink-0">
        <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: block.color }} />
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { setTitleDraft(block.title); setEditingTitle(false); }
            }}
            className="flex-1 min-w-0 text-sm font-medium bg-transparent outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5"
          />
        ) : (
          <button
            onClick={() => { setTitleDraft(block.title); setEditingTitle(true); }}
            title="제목 편집"
            className="flex-1 min-w-0 text-left text-sm font-medium truncate hover:bg-muted/40 rounded px-1 py-0.5 transition-colors"
          >
            {block.title}
          </button>
        )}
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors flex-shrink-0">
          <X size={13} className="text-muted-foreground" />
        </button>
      </div>
      {block.parentBlockId && (
        <button onClick={onGoToParent} className="flex items-center gap-1 px-4 py-1.5 text-[11px] text-muted-foreground hover:text-foreground border-b border-border flex-shrink-0">
          <ChevronLeft size={11} /> 상위 블록으로
        </button>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Time info — plan only, no timer */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">계획 시간</div>
          <div className="px-3 py-2.5 rounded-lg bg-muted/40 border border-border">
            <div className="text-[11px] text-muted-foreground" >
              {block.date} ({DAYS_KO[parseLocalDate(block.date).getDay()]})
            </div>
            <div className="text-sm font-medium mt-0.5" >
              {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{durMin(block)}분</div>
          </div>
        </div>

        {/* Color picker — hover 시 X로 색 제거, '+' 로 커스텀 색 추가(팔레트에 영구 등록) */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-2">색상</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {paletteColors.map(c => (
              <div key={c} className="relative group/color size-6 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onColorSave(c)}
                  className={`size-6 rounded-full transition-transform ${block.color.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1 ring-offset-card ring-foreground/40 scale-110" : ""}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onRemovePaletteColor(c); }}
                  className="absolute -top-1 -right-1 size-3.5 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover/color:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                  title="팔레트에서 제거"
                >
                  <X size={8} strokeWidth={2.5} />
                </button>
              </div>
            ))}
            {/* 커스텀 색 — 클릭하면 아래에 인라인 편집 카드가 열림. "추가"를 눌러야만
                실제 팔레트에 등록되어 native picker onChange 폭주로 색이 도배되는 문제 방지. */}
            <button
              type="button"
              onClick={() => setShowBlockCustomColor(v => !v)}
              className={`size-6 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${showBlockCustomColor ? "border-primary/60 bg-primary/10" : "border-border/70 bg-muted/40 hover:bg-muted"}`}
              title="사용자 지정 색상 추가"
            >
              <Plus size={12} className={showBlockCustomColor ? "text-primary" : "text-muted-foreground"} />
            </button>
          </div>
          {showBlockCustomColor && (
            <CustomColorPickerInline
              initial={block.color}
              onAdd={(color) => { onColorSave(color); onAddPaletteColor(color); }}
              onClose={() => setShowBlockCustomColor(false)}
            />
          )}
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {block.tags.map(tag => (
            <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{tag}</span>
          ))}
        </div>

        {/* 체크리스트형 자식 — 무제한 중첩 */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-2">체크리스트</div>
          <div className="space-y-0.5">
            {items.filter(i => !i.parentItemId).map(item => (
              <ChecklistNode
                key={item.id}
                item={item}
                items={items}
                depth={0}
                onToggle={toggleChecklistItem}
                onDelete={deleteChecklistItem}
                onAddChild={addChecklistItem}
              />
            ))}
            <NewChecklistItemForm onAdd={text => addChecklistItem(text)} />
          </div>
        </div>

        {/* 독립 타임블록형 자식 — 1단계까지만 허용되므로 이 블록 자신이 이미 자식이면 숨김 */}
        {!block.parentBlockId && (
          <div>
            <div className="text-[11px] font-medium text-muted-foreground mb-2">하위 타임블록</div>
            <div className="space-y-1.5">
              {childBlocks.map(cb => (
                <div
                  key={cb.id}
                  onClick={() => onSelectChild(cb)}
                  className="group/child flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/60 rounded-lg px-1.5 py-1 transition-colors"
                >
                  <button onClick={e => { e.stopPropagation(); onToggleChild(cb.id); }}>
                    {cb.completed
                      ? <CheckCircle2 size={13} style={{ color: cb.color }} />
                      : <Circle size={13} className="text-muted-foreground" />
                    }
                  </button>
                  <span className="w-0.5 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cb.color }} />
                  <span className={`flex-1 truncate ${cb.completed ? "line-through text-muted-foreground" : ""}`}>{cb.title}</span>
                  <span className="text-muted-foreground flex-shrink-0" >
                    {fmtTime(cb.startH, cb.startM)}-{fmtTime(cb.endH, cb.endM)}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteChild(cb.id); }}
                    className="opacity-0 group-hover/child:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:text-destructive flex-shrink-0"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}

              {showAddTimeblock ? (
                <div className="p-2 rounded-lg bg-muted/40 space-y-1.5">
                  <select
                    value={childTplId}
                    onChange={e => setChildTplId(e.target.value)}
                    className="w-full text-xs px-2 py-1 rounded bg-card border border-border outline-none"
                  >
                    <option value="">템플릿 선택...</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                  <div className="flex items-center gap-1.5">
                    <input type="time" value={childStart} onChange={e => setChildStart(e.target.value)}
                      className="flex-1 text-xs px-2 py-1 rounded bg-card border border-border outline-none" />
                    <span className="text-muted-foreground text-xs">–</span>
                    <input type="time" value={childEnd} onChange={e => setChildEnd(e.target.value)}
                      className="flex-1 text-xs px-2 py-1 rounded bg-card border border-border outline-none" />
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={submitTimeblockChild} disabled={!childTplId}
                      className="flex-1 text-[11px] py-1 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity">
                      추가
                    </button>
                    <button onClick={() => setShowAddTimeblock(false)} className="flex-1 text-[11px] py-1 rounded-lg bg-muted hover:bg-muted/70 transition-colors">
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddTimeblock(true)}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus size={11} /> 타임블록 자식 추가
                </button>
              )}
            </div>
          </div>
        )}

        {/* Memo */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">메모</div>
          <textarea
            value={memo}
            onChange={e => setMemo(e.target.value)}
            onBlur={() => { if (memo !== block.memo) onMemoSave(memo); }}
            placeholder="자유롭게 메모하세요..."
            className="w-full h-20 px-3 py-2 text-xs bg-muted rounded-lg resize-none outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* Habit stacking — 같은 날짜의 다른 최상위 블록을 "다음 블록"으로 연결.
            연결된 블록끼리는 캘린더 그리드 위에 선으로 표시됨(CalendarSection 참고) */}
        {!block.parentBlockId && (
          <div>
            <div className="text-[11px] font-medium text-muted-foreground mb-1.5">습관 스태킹</div>
            <select
              value={block.nextBlockId ?? ""}
              onChange={e => onSetNextBlock(e.target.value || null)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">다음 블록 없음</option>
              {sameDayBlocks.map(b => (
                <option key={b.id} value={b.id}>{fmtTime(b.startH, b.startM)} {b.title}</option>
              ))}
            </select>
          </div>
        )}

        {/* Repeat settings (5.12A) */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
            <span>반복 설정</span>
            {block.repeatGroupId && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">반복 중</span>}
          </div>

          {/* Type selector */}
          <div className="flex gap-1 mb-2">
            {(["none", "daily", "weekly"] as const).map(t => (
              <button key={t}
                onClick={() => setRepeatType(t)}
                className={`flex-1 py-1 text-[10px] rounded-lg transition-colors ${repeatType === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>
                {t === "none" ? "없음" : t === "daily" ? "매일" : "매주"}
              </button>
            ))}
          </div>

          {/* Weekly day picker */}
          {repeatType === "weekly" && (
            <div className="flex gap-1 mb-2">
              {DAYS_LABEL.map((d, i) => (
                <button key={i}
                  onClick={() => setRepeatDays(ds => ds.includes(i) ? ds.filter(x => x !== i) : [...ds, i])}
                  className={`flex-1 py-1 text-[10px] rounded-lg transition-colors ${repeatDays.includes(i) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {d}
                </button>
              ))}
            </div>
          )}

          {/* End condition */}
          {repeatType !== "none" && (
            <div className="space-y-1.5 mb-2">
              <div className="text-[10px] text-muted-foreground">종료 조건</div>
              <div className="flex flex-col gap-1">
                {(["none", "count", "date"] as const).map(et => (
                  <label key={et} className="flex items-center gap-2 text-[11px] cursor-pointer">
                    <input type="radio" checked={repeatEndType === et} onChange={() => setRepeatEndType(et)} className="size-3" />
                    {et === "none" && "종료 없음"}
                    {et === "count" && (
                      <span className="flex items-center gap-1">
                        <input type="number" min={1} max={99} value={repeatEndCount}
                          onChange={e => setRepeatEndCount(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                          onClick={() => setRepeatEndType("count")}
                          className="w-12 px-1.5 py-0.5 text-[11px] rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                                                 />회 반복 후 종료
                      </span>
                    )}
                    {et === "date" && (
                      <span className="flex items-center gap-1">
                        <input type="date" value={repeatEndDate}
                          onChange={e => setRepeatEndDate(e.target.value)}
                          onClick={() => setRepeatEndType("date")}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                        />까지
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {repeatType !== "none" && (() => {
            // 매주인데 요일이 하나도 선택 안 됐거나 종료 조건이 '날짜'인데 날짜가 비어 있으면
            // saveRepeat이 조용히 no-op으로 끝나 사용자는 '저장'을 눌러도 아무 일이 안 벌어져
            // 원인을 알 수 없음. 버튼을 disabled로 만들고 이유를 짧게 표시.
            const missingDays = repeatType === "weekly" && repeatDays.length === 0;
            const missingDate = repeatEndType === "date" && !repeatEndDate;
            const disabled = missingDays || missingDate;
            const hint = missingDays ? "요일을 하나 이상 선택해 주세요" : missingDate ? "종료 날짜를 선택해 주세요" : "";
            return (
              <>
                <button onClick={saveRepeat}
                  disabled={disabled}
                  className={`w-full py-1.5 text-xs rounded-lg font-medium transition-all ${showRepeatSaved ? "bg-sky-100 text-sky-700" : "bg-muted hover:bg-muted/70 text-foreground"} disabled:opacity-50 disabled:cursor-not-allowed`}>
                  {showRepeatSaved ? "✓ 반복 저장됨" : "반복 저장"}
                </button>
                {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
              </>
            );
          })()}
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border flex-shrink-0 space-y-2">
        <button
          onClick={onToggle}
          className={`w-full py-2.5 rounded-xl text-sm font-medium transition-all ${
            block.completed
              ? "bg-muted text-muted-foreground hover:bg-muted/70"
              : "bg-primary text-primary-foreground hover:opacity-90"
          }`}
        >
          {block.completed ? "완료 취소" : "완료로 표시"}
        </button>

        {/* Delete — with repeat confirmation */}
        {showDeleteConfirm && block.repeatGroupId ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground text-center">반복 일정을 삭제할까요?</p>
            <div className="flex gap-2">
              <button onClick={onDelete}
                className="flex-1 py-1.5 text-xs rounded-lg bg-muted hover:bg-muted/70 text-foreground transition-colors">
                이 일정만
              </button>
              <button onClick={() => onDeleteRepeatGroup(block.date)}
                className="flex-1 py-1.5 text-xs rounded-lg bg-destructive text-white hover:opacity-90 transition-opacity">
                이후 모두
              </button>
            </div>
            <button onClick={() => setShowDeleteConfirm(false)}
              className="w-full text-[10px] text-muted-foreground hover:text-foreground transition-colors">
              취소
            </button>
          </div>
        ) : (
          <button
            onClick={() => block.repeatGroupId ? setShowDeleteConfirm(true) : onDelete()}
            className="w-full py-2 rounded-xl text-sm font-medium text-destructive hover:bg-destructive/10 transition-all border border-destructive/20"
          >
            블록 삭제
          </button>
        )}
      </div>
    </div>
  );
}

// ── Checklist item — recursive, unlimited nesting ─────────────────
function ChecklistNode({
  item, items, depth, onToggle, onDelete, onAddChild,
}: {
  item: ChecklistItemT;
  items: ChecklistItemT[];
  depth: number;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  // (text, parentItemId) 순서 — addChecklistItem의 시그니처와 일치시켜야 함.
  // 예전에 (parentItemId, text)로 잘못 선언돼 있어 addChecklistItem을 그대로 넘기면
  // 인자 순서가 뒤집혀 text 자리에 부모 UUID, parent_item_id 자리에 사용자 입력이
  // 들어가 하위 항목이 완전히 깨져 저장되던 버그.
  onAddChild: (text: string, parentItemId?: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const kids = items.filter(i => i.parentItemId === item.id);

  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <div className="group flex items-center gap-1.5 text-xs py-0.5">
        <button onClick={() => onToggle(item.id, !item.completed)} className="flex-shrink-0">
          {item.completed
            ? <CheckCircle2 size={13} className="text-sky-500" />
            : <Circle size={13} className="text-muted-foreground" />
          }
        </button>
        <span className={`flex-1 min-w-0 truncate ${item.completed ? "line-through text-muted-foreground" : ""}`}>{item.text}</span>
        <button
          onClick={() => setShowAdd(v => !v)}
          title="하위 항목 추가"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity flex-shrink-0"
        >
          <Plus size={11} />
        </button>
        <button
          onClick={() => onDelete(item.id)}
          title="삭제"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity flex-shrink-0"
        >
          <X size={11} />
        </button>
      </div>
      {showAdd && (
        <div style={{ marginLeft: 18 }}>
          <NewChecklistItemForm
            autoFocus
            onAdd={text => { onAddChild(text, item.id); setShowAdd(false); }}
            onCancel={() => setShowAdd(false)}
          />
        </div>
      )}
      {kids.map(k => (
        <ChecklistNode key={k.id} item={k} items={items} depth={depth + 1} onToggle={onToggle} onDelete={onDelete} onAddChild={onAddChild} />
      ))}
    </div>
  );
}

function NewChecklistItemForm({
  onAdd, onCancel, autoFocus,
}: {
  onAdd: (text: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (text.trim()) { onAdd(text.trim()); setText(""); } }}
      className="flex items-center gap-1.5 mt-1"
    >
      <input
        autoFocus={autoFocus}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") onCancel?.(); }}
        placeholder="항목 추가..."
        className="flex-1 text-xs px-2 py-1 rounded bg-muted outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
      />
      {text && (
        <button type="submit" className="text-[11px] text-sky-600 hover:text-sky-700 px-1.5">추가</button>
      )}
    </form>
  );
}
