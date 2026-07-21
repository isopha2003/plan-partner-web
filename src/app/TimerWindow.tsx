import { useEffect, useState } from "react";
import { Play, Pause, X } from "lucide-react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type TimerState, fmtSec } from "../lib/timer";

// 뜬 타이머 창(src-tauri가 별도 webview로 띄움)의 내용물. 메인 창과는 별개 프로세스의
// 별도 document라 상태를 직접 공유할 수 없어 Tauri 이벤트로만 주고받음 — 메인 창이
// "timer:state"를 브로드캐스트하면 받아서 그리고, 버튼을 누르면 "timer:action"을 보내서
// 메인 창의 startSession/endSession이 실행되게 함(Supabase 쓰기는 항상 메인 창에서만 발생).
type PomPhase = "focus" | "break";
type TimerStatePayload = {
  timerState: TimerState;
  timerSec: number;
  pomodoroOn?: boolean;
  pomPhase?: PomPhase;
  pomPhaseRemainSec?: number;
};

export default function TimerWindow() {
  const [timerState, setTimerState] = useState<TimerState>("stopped");
  const [timerSec, setTimerSec] = useState(0);
  const [pomodoroOn, setPomodoroOn] = useState(false);
  const [pomPhase, setPomPhase] = useState<PomPhase>("focus");
  const [pomPhaseRemainSec, setPomPhaseRemainSec] = useState(0);

  useEffect(() => {
    const unlisten = listen<TimerStatePayload>("timer:state", (e) => {
      setTimerState(e.payload.timerState);
      setTimerSec(e.payload.timerSec);
      setPomodoroOn(!!e.payload.pomodoroOn);
      setPomPhase(e.payload.pomPhase ?? "focus");
      setPomPhaseRemainSec(e.payload.pomPhaseRemainSec ?? 0);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const isRunning = timerState === "running";
  const isAutoPaused = timerState === "auto-paused";
  const isBreak = pomodoroOn && isRunning && pomPhase === "break";

  const start = () => emit("timer:action", { type: "start" });
  const stop = () => emit("timer:action", { type: "stop" });
  const closeWindow = () => getCurrentWindow().close();

  return (
    <div
      data-tauri-drag-region
      className={`relative h-screen flex flex-col items-center justify-center gap-1 rounded-xl ${
        isBreak ? "bg-indigo-50" : isRunning ? "bg-sky-50" : isAutoPaused ? "bg-amber-50" : "bg-muted/40"
      }`}
    >
      <button
        onClick={closeWindow}
        title="닫기"
        className="absolute top-1.5 right-1.5 p-1 rounded-md hover:bg-black/10 text-muted-foreground"
      >
        <X size={12} />
      </button>

      {pomodoroOn && isRunning && (
        <div className={`text-[10px] font-medium tabular-nums ${isBreak ? "text-indigo-700" : "text-sky-700"}`}>
          {isBreak ? "휴식" : "집중"} · {fmtSec(pomPhaseRemainSec)}
        </div>
      )}

      <div
        data-tauri-drag-region
        className={`text-3xl font-medium tabular-nums ${
          isBreak ? "text-indigo-800" : isRunning ? "text-sky-800" : isAutoPaused ? "text-amber-800" : "text-muted-foreground"
        }`}
      >
        {fmtSec(timerSec)}
      </div>
      <div className="flex gap-2">
        {timerState === "stopped" && (
          <button onClick={start} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium">
            <Play size={11} fill="white" /> 시작
          </button>
        )}
        {isRunning && (
          <button onClick={stop} className="p-2 rounded-lg bg-muted text-muted-foreground">
            <Pause size={14} fill="currentColor" />
          </button>
        )}
        {isAutoPaused && (
          <>
            <button onClick={start} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium">
              <Play size={11} fill="white" /> 재시작
            </button>
            <button onClick={stop} className="p-2 rounded-lg bg-muted text-muted-foreground">
              <Pause size={14} fill="currentColor" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
