import React, { useState, useEffect, useRef } from "react";
import {
  CheckCircle2, Circle, Clock, Play, Square,
  Plus, X, ChevronLeft, ChevronRight, List, Grid3x3,
  BarChart2, Settings, Calendar, Target, Flame,
  Edit3, Check, AlertCircle,
} from "lucide-react";
import {
  fetchTemplates, createTemplate, fetchBlocks, insertBlock, patchBlock, deleteBlockRow,
  deleteBlocksByRepeatGroup as apiDeleteRepeatGroup, insertBlocksBulk,
  fetchDeadlines, createDeadline, toggleDeadlineRow,
  fetchScheduleTemplates, createScheduleTemplateRow, deleteScheduleTemplateRow,
  fetchTodaySessions, startTimerSession, endTimerSession,
  fetchChecklistItems, createChecklistItem, toggleChecklistItemRow, deleteChecklistItemRow,
} from "../lib/api";

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

type Section = "today" | "calendar" | "deadlines" | "grass" | "settings";
type TimerState = "running" | "auto-paused" | "stopped";

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
const TODAY_STR = toDateStr(new Date());

const fmt2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (h: number, m: number) => `${fmt2(h)}:${fmt2(m)}`;
const fmtSec = (s: number) => `${fmt2(Math.floor(s / 60))}:${fmt2(s % 60)}`;
const durMin = (b: Block) => (b.endH * 60 + b.endM) - (b.startH * 60 + b.startM);
const DAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
const MONTHS_KO = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
const TODAY_DATE = parseLocalDate(TODAY_STR);
const TODAY_LABEL = `${TODAY_DATE.getFullYear()}년 ${TODAY_DATE.getMonth() + 1}월 ${TODAY_DATE.getDate()}일 ${DAYS_KO[TODAY_DATE.getDay()]}요일`;

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
  }, []);

  // Global timer — single, app-wide. "자동 일시정지"는 사용자가 누르는 버튼이 아니라
  // 브라우저 탭 가시성(Page Visibility API)에 의해서만 진입/해제되는 상태.
  const [timerState, setTimerState] = useState<TimerState>("stopped");
  const [timerSec, setTimerSec] = useState(0);
  const [sessions, setSessions] = useState<TimerSession[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);

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
      } catch (e) { console.error(e); }
    })();
  }, []);

  const startSession = async () => {
    setTimerState("running");
    try {
      const session = await startTimerSession(TODAY_STR);
      currentSessionIdRef.current = session.id;
      setSessions(s => [...s, session]);
    } catch (e) { console.error(e); }
  };

  const endSession = async (reason: "manual" | "auto") => {
    setTimerState(reason === "manual" ? "stopped" : "auto-paused");
    const sid = currentSessionIdRef.current;
    currentSessionIdRef.current = null;
    if (!sid) return;
    try {
      await endTimerSession(sid, reason);
      setSessions(s => s.map(x => x.id === sid ? { ...x, endedAt: new Date().toISOString(), endReason: reason } : x));
    } catch (e) { console.error(e); }
  };

  // 탭 비활성화 → 실행중이었다면 자동 일시정지 / 탭 재활성화 → 자동 일시정지였다면 자동 재시작.
  // 수동 정지 상태는 이 로직과 무관 — 탭이 어떻게 되든 아무 반응 없음.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (timerState === "running") endSession("auto");
      } else {
        if (timerState === "auto-paused") startSession();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [timerState]);

  // Pomodoro / settings
  const [pomodoroOn, setPomodoroOn] = useState(false);
  const [pomWork, setPomWork] = useState(25);
  const [pomBreak, setPomBreak] = useState(5);
  const [abandonMin, setAbandonMin] = useState(15);

  // Calendar UI state
  const [calView, setCalView] = useState<"day" | "week" | "month">("week");
  const [calMode, setCalMode] = useState<"grid" | "list">("grid");
  const [templateOpen, setTemplateOpen] = useState(true);

  useEffect(() => {
    if (timerState !== "running") return;
    const id = setInterval(() => setTimerSec(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [timerState]);

  const toggleBlock = (id: string) => {
    const target = blocks.find(b => b.id === id);
    if (!target) return;
    const completed = !target.completed;
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, completed } : b));
    patchBlock(id, { completed }).catch(console.error);
  };

  // Optimistic insert: shows instantly with a temp id, then swapped for the real DB row
  const addBlock = (block: Block) => {
    const tempId = `temp-${Date.now()}`;
    setBlocks(bs => [...bs, { ...block, id: tempId }]);
    insertBlock(block)
      .then(real => setBlocks(bs => bs.map(b => (b.id === tempId ? real : b))))
      .catch(e => { console.error(e); setBlocks(bs => bs.filter(b => b.id !== tempId)); });
  };

  // Local-only update — used for high-frequency visual feedback (e.g. resize drag) where
  // hitting the DB on every mousemove would be wasteful. Persisted separately on drag-end.
  const updateBlockLocal = (id: string, changes: Partial<Block>) =>
    setBlocks(bs => bs.map(b => b.id === id ? { ...b, ...changes } : b));

  const updateBlock = (id: string, changes: Partial<Block>) => {
    updateBlockLocal(id, changes);
    patchBlock(id, changes).catch(console.error);
  };

  const deleteBlock = (id: string) => {
    setBlocks(bs => bs.filter(b => b.id !== id));
    setSelectedBlock(prev => prev?.id === id ? null : prev);
    deleteBlockRow(id).catch(console.error);
  };

  const deleteRepeatGroup = (id: string, fromDate: string) => {
    const block = blocks.find(b => b.id === id);
    const groupId = block?.repeatGroupId;
    if (!groupId) {
      setBlocks(bs => bs.filter(b => b.id !== id));
      deleteBlockRow(id).catch(console.error);
    } else {
      setBlocks(bs => bs.filter(b => !(b.repeatGroupId === groupId && b.date >= fromDate)));
      apiDeleteRepeatGroup(groupId, fromDate).catch(console.error);
    }
    setSelectedBlock(null);
  };

  // Generate repeat instances for a block
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

    if (repeat.type === "daily") {
      const maxDays = repeat.endType === "count" ? repeat.endCount : 14;
      for (let i = 1; i <= maxDays && (repeat.endType !== "count" || instances.length < repeat.endCount); i++) {
        const d = new Date(origin); d.setDate(origin.getDate() + i);
        pushInstance(d, i);
      }
    } else {
      let count = 0;
      for (let week = 1; week <= 8; week++) {
        for (const day of repeat.days.slice().sort()) {
          if (repeat.endType === "count" && count >= repeat.endCount) break;
          const d = new Date(origin);
          const diff = (day - origin.getDay() + 7) % 7 || 7;
          d.setDate(origin.getDate() + diff + (week - 1) * 7);
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
        if (instances.length) await insertBlocksBulk(instances);
        await refetchBlocks();
      } catch (e) { console.error(e); }
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
      .catch(e => { console.error(e); setScheduleTemplates(ts => ts.filter(t => t.id !== tempId)); });
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
    insertBlocksBulk(newBlocks).then(() => refetchBlocks()).catch(console.error);
  };

  const deleteScheduleTemplate = (id: string) => {
    setScheduleTemplates(ts => ts.filter(t => t.id !== id));
    deleteScheduleTemplateRow(id).catch(console.error);
  };

  const toggleDeadline = (id: string) => {
    const target = deadlines.find(d => d.id === id);
    if (!target) return;
    const completed = !target.completed;
    setDeadlines(ds => ds.map(d => d.id === id ? { ...d, completed } : d));
    toggleDeadlineRow(id, completed).catch(console.error);
  };

  const addTemplate = (t: { title: string; color: string; tags: string[] }) => {
    const tempId = `temp-${Date.now()}`;
    setTemplates(ts => [...ts, { id: tempId, ...t }]);
    createTemplate(t)
      .then(real => setTemplates(ts => ts.map(x => (x.id === tempId ? real : x))))
      .catch(e => { console.error(e); setTemplates(ts => ts.filter(x => x.id !== tempId)); });
  };

  const addDeadline = (d: { title: string; dueDate: string }) => {
    const tempId = `temp-${Date.now()}`;
    setDeadlines(ds => [...ds, { id: tempId, title: d.title, dueDate: d.dueDate, completed: false }]);
    createDeadline(d)
      .then(real => setDeadlines(ds => ds.map(x => (x.id === tempId ? real : x))))
      .catch(e => { console.error(e); setDeadlines(ds => ds.filter(x => x.id !== tempId)); });
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
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>

      {/* ── Global Header ── */}
      <header className="flex items-center gap-6 px-5 border-b border-border bg-card flex-shrink-0" style={{ height: 52 }}>
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <h1 className="text-base font-medium" style={{ fontFamily: "'Fraunces', serif", fontStyle: "italic" }}>
            생활 플래너
          </h1>
          <span className="text-[11px] text-muted-foreground hidden sm:block">{TODAY_LABEL}</span>
        </div>

        {/* Global timer widget — center of header */}
        <div className="flex-1 flex justify-center">
          <GlobalTimer
            timerState={timerState}
            timerSec={timerSec}
            sessions={sessions}
            onStart={startSession}
            onManualStop={() => endSession("manual")}
          />
        </div>

        {/* Right side: completion summary */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="text-[11px] text-muted-foreground text-right hidden md:block">
            <div>오늘 달성률</div>
            <div className="font-semibold text-foreground">{completionRate}%</div>
          </div>
          <CircleProgress value={completionRate} size={32} strokeWidth={3} />
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
              templates={templates}
              calView={calView}
              setCalView={setCalView}
              calMode={calMode}
              setCalMode={setCalMode}
              templateOpen={templateOpen}
              setTemplateOpen={setTemplateOpen}
              onSelect={setSelectedBlock}
              onToggle={toggleBlock}
              onAddBlock={addBlock}
              onUpdateBlock={updateBlock}
              onUpdateBlockLocal={updateBlockLocal}
              onDeleteBlock={deleteBlock}
              scheduleTemplates={scheduleTemplates}
              onSaveTemplate={saveScheduleTemplate}
              onApplyTemplate={applyScheduleTemplate}
              onDeleteTemplate={deleteScheduleTemplate}
              onAddTemplate={addTemplate}
            />
          )}
          {section === "deadlines" && (
            <DeadlinesSection deadlines={deadlines} onToggle={toggleDeadline} onAddDeadline={addDeadline} />
          )}
          {section === "grass" && (
            <GrassSection
              completionRate={completionRate}
              blocks={blocks.filter(b => !b.parentBlockId)}
              timerSec={timerSec}
              totalPlanMin={totalPlanMin}
            />
          )}
          {section === "settings" && (
            <SettingsSection
              pomodoroOn={pomodoroOn} setPomodoroOn={setPomodoroOn}
              pomWork={pomWork} setPomWork={setPomWork}
              pomBreak={pomBreak} setPomBreak={setPomBreak}
              abandonMin={abandonMin} setAbandonMin={setAbandonMin}
            />
          )}
        </main>

        {/* Block detail side panel — no timer */}
        {selectedBlock && (
          <BlockDetailPanel
            key={selectedBlock.id}
            block={selectedBlock}
            childBlocks={blocks.filter(b => b.parentBlockId === selectedBlock.id)}
            templates={templates}
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
            onSelectChild={setSelectedBlock}
            onToggleChild={toggleBlock}
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
          />
        )}
      </div>
    </div>
  );
}

// ── Global Timer Widget ────────────────────────────────────────────
// 3-state: 실행중 / 자동 일시정지 / 수동 정지. "자동 일시정지"는 버튼으로 들어가는 상태가
// 아니라 탭 가시성 변화로만 진입·해제됨(App의 visibilitychange 로직 참고) — 그래서 여기엔
// "일시정지" 버튼이 없고 시작/정지만 있음.
function GlobalTimer({
  timerState, timerSec, sessions, onStart, onManualStop,
}: {
  timerState: TimerState;
  timerSec: number;
  sessions: TimerSession[];
  onStart: () => void;
  onManualStop: () => void;
}) {
  const isRunning = timerState === "running";
  const isAutoPaused = timerState === "auto-paused";
  const isStopped = timerState === "stopped";
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 px-4 py-1.5 rounded-xl border transition-all ${
          isRunning
            ? "bg-green-50 border-green-200"
            : isAutoPaused
            ? "bg-amber-50 border-amber-200"
            : "bg-muted/40 border-border"
        }`}
      >
        {/* State indicator */}
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full flex-shrink-0 ${
              isRunning ? "bg-green-500 animate-pulse" :
              isAutoPaused ? "bg-amber-400" :
              "bg-muted-foreground/40"
            }`}
          />
          <span
            className={`text-[11px] font-medium w-16 ${
              isRunning ? "text-green-700" :
              isAutoPaused ? "text-amber-700" :
              "text-muted-foreground"
            }`}
          >
            {isRunning ? "집중 중" : isAutoPaused ? "자동 정지" : "정지됨"}
          </span>
        </div>

        {/* Timer display — click to see today's focus/rest session history */}
        <button
          onClick={() => setShowHistory(v => !v)}
          title="오늘의 집중 기록 보기"
          className={`text-xl font-medium tabular-nums w-20 text-center rounded-md hover:bg-black/5 transition-colors ${
            isRunning ? "text-green-800" :
            isAutoPaused ? "text-amber-800" :
            "text-muted-foreground"
          }`}
          style={{ fontFamily: "'Geist Mono', monospace" }}
        >
          {fmtSec(timerSec)}
        </button>

        {/* Controls */}
        <div className="flex items-center gap-1">
          {isStopped && (
            <button
              onClick={onStart}
              title="타이머 시작"
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-700 transition-colors"
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
              <Square size={14} fill="currentColor" />
            </button>
          )}
          {isAutoPaused && (
            <>
              <button
                onClick={onStart}
                title="재시작"
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-700 transition-colors"
              >
                <Play size={11} fill="white" /> 재시작
              </button>
              <button
                onClick={onManualStop}
                title="정지"
                className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
              >
                <Square size={14} fill="currentColor" />
              </button>
            </>
          )}
        </div>
      </div>

      {showHistory && (
        <TimerHistoryPopover sessions={sessions} onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}

// ── Timer session history popover ───────────────────────────────────
function TimerHistoryPopover({ sessions, onClose }: { sessions: TimerSession[]; onClose: () => void }) {
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const now = Date.now();

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
            <div className="text-sm font-medium" style={{ fontFamily: "'Geist Mono', monospace" }}>{fmtDur(totalFocusMs)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">오늘 총 휴식</div>
            <div className="text-sm font-medium" style={{ fontFamily: "'Geist Mono', monospace" }}>{fmtDur(totalRestMs)}</div>
          </div>
        </div>
        {segments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-3">아직 오늘 기록이 없어요</p>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {segments.slice().reverse().map((seg, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                {seg.type === "focus" ? (
                  <span className="size-1.5 rounded-full bg-green-500 flex-shrink-0" />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                )}
                <span className="text-muted-foreground" style={{ fontFamily: "'Geist Mono', monospace" }}>
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
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E8E2D6" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#6B9B37" strokeWidth={strokeWidth}
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
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-3xl font-medium" style={{ fontFamily: "'Fraunces', serif" }}>오늘의 계획</h2>
            <p className="text-sm text-muted-foreground mt-1">{TODAY_LABEL}</p>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <div className="text-right">
              <div className="text-[11px] text-muted-foreground">달성률</div>
              <div className="text-2xl font-semibold leading-none mt-0.5" style={{ fontFamily: "'Fraunces', serif" }}>
                {completionRate}%
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{done}/{blocks.length}</div>
            </div>
            <CircleProgress value={completionRate} size={56} />
          </div>
        </div>

        {/* Overdue deadlines — shown inline with warning */}
        {overdueDeadlines.length > 0 && (
          <div className="mb-4 p-3 rounded-xl border border-red-200 bg-red-50/50">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle size={12} className="text-red-500" />
              <span className="text-[11px] font-semibold text-red-600 uppercase tracking-wide">지난 마감</span>
            </div>
            <div className="space-y-1.5">
              {overdueDeadlines.map(d => {
                const daysOver = Math.abs(Math.ceil((parseLocalDate(d.dueDate).getTime() - TODAY_DATE.getTime()) / 86400000));
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
                <div className="text-[11px] text-muted-foreground mt-0.5" style={{ fontFamily: "'Geist Mono', monospace" }}>
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
  blocks, templates, calView, setCalView, calMode, setCalMode,
  templateOpen, setTemplateOpen, onSelect, onToggle, onAddBlock, onUpdateBlock, onUpdateBlockLocal, onDeleteBlock,
  scheduleTemplates, onSaveTemplate, onApplyTemplate, onDeleteTemplate, onAddTemplate,
}: {
  blocks: Block[];
  templates: Template[];
  calView: "day" | "week" | "month";
  setCalView: (v: "day" | "week" | "month") => void;
  calMode: "grid" | "list";
  setCalMode: (m: "grid" | "list") => void;
  templateOpen: boolean;
  setTemplateOpen: (v: boolean) => void;
  onSelect: (b: Block) => void;
  onToggle: (id: string) => void;
  onAddBlock: (block: Block) => void;
  onUpdateBlock: (id: string, changes: Partial<Block>) => void;
  onUpdateBlockLocal: (id: string, changes: Partial<Block>) => void;
  onDeleteBlock: (id: string) => void;
  scheduleTemplates: ScheduleTemplate[];
  onSaveTemplate: (name: string, date: string) => void;
  onApplyTemplate: (templateId: string, targetDate: string) => void;
  onDeleteTemplate: (id: string) => void;
  onAddTemplate: (t: { title: string; color: string; tags: string[] }) => void;
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
  const [showNewTpl, setShowNewTpl] = useState(false);
  const [newTplTitle, setNewTplTitle] = useState("");
  const [newTplColor, setNewTplColor] = useState("#6B9B37");
  const [newTplTags, setNewTplTags] = useState("");
  const [dragTplId, setDragTplId] = useState<string | null>(null);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragBlockOffsetMin, setDragBlockOffsetMin] = useState(0); // minutes from block top to mouse
  const [dropTarget, setDropTarget] = useState<{ dayIdx: number; startH: number; startM: number } | null>(null);
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

      {/* Scrollable grid */}
      <div ref={gridScrollRef} className="flex-1 overflow-auto">
        <div className="flex" style={{ height: TOTAL_H * HOUR_H }}>
          {/* Hour labels */}
          <div className="w-12 flex-shrink-0 relative select-none">
            {Array.from({ length: TOTAL_H }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted-foreground"
                style={{ top: h * HOUR_H - 7, fontFamily: "'Geist Mono', monospace" }}>
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
                className={`flex-1 relative border-l border-border min-w-0 ${isToday ? "bg-green-50/10" : ""}`}
                style={{ height: TOTAL_H * HOUR_H }}
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
                  <div key={h} className="absolute w-full border-t border-border/40" style={{ top: h * HOUR_H }} />
                ))}

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
                        <div className="text-[9px] opacity-60 mt-0.5" style={{ fontFamily: "'Geist Mono', monospace", color: src.color }}>
                          {fmtTime(Math.floor(ghostStartMin/60), ghostStartMin%60)} – {fmtTime(Math.floor(gEnd/60), gEnd%60)}
                        </div>
                      )}
                    </div>
                  );
                })()}

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
                      onClick={() => !resizing && !dragBlockId && !justResizedRef.current && onSelect(block)}
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
                          <div className="text-[9px] opacity-70 mt-0.5" style={{ fontFamily: "'Geist Mono', monospace", color: block.color }}>
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

    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-2 max-w-lg">
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
                <div className="text-[11px] text-muted-foreground" style={{ fontFamily:"'Geist Mono', monospace" }}>
                  {block.date !== TODAY_STR && `${parseLocalDate(block.date).getMonth()+1}/${parseLocalDate(block.date).getDate()} · `}
                  {fmtTime(block.startH,block.startM)} – {fmtTime(block.endH,block.endM)}
                </div>
              </div>
              {block.tags.map(tag => (
                <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">{tag}</span>
              ))}
            </div>
          ))}
          {sorted.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">이 기간에 등록된 블록이 없어요</p>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0 bg-card/50">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold" style={{ fontFamily: "'Fraunces', serif" }}>캘린더</h2>
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
                  className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sidebar-accent cursor-grab active:cursor-grabbing transition-colors text-xs select-none">
                  <span className="size-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: t.color }} />
                  <span className="truncate text-foreground/80">{t.title}</span>
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
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={newTplColor}
                      onChange={e => setNewTplColor(e.target.value)}
                      className="size-6 rounded cursor-pointer border border-border flex-shrink-0"
                    />
                    <input
                      value={newTplTags}
                      onChange={e => setNewTplTags(e.target.value)}
                      placeholder="태그 (쉼표로 구분)"
                      className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-card border border-border outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
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
                <div className="text-[10px] font-medium text-muted-foreground px-2 py-1 uppercase tracking-wide">저장된 일정</div>
                {scheduleTemplates.length === 0 && (
                  <p className="text-[10px] text-muted-foreground px-2 py-1 leading-tight">저장된 일정이 없어요.<br/>헤더의 "이 날 저장"을 눌러 저장하세요.</p>
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
                    <button type="submit" className="text-[10px] text-green-600 font-medium px-1">저장</button>
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
  deadlines, onToggle, onAddDeadline,
}: {
  deadlines: Deadline[];
  onToggle: (id: string) => void;
  onAddDeadline: (d: { title: string; dueDate: string }) => void;
}) {
  const active = deadlines.filter(d => !d.completed);
  const overdue = active.filter(d => d.dueDate < TODAY_STR);
  const upcoming = active.filter(d => d.dueDate >= TODAY_STR);
  const completed = deadlines.filter(d => d.completed);

  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueDate, setNewDueDate] = useState(TODAY_STR);

  const daysLeft = (date: string) =>
    Math.ceil((parseLocalDate(date).getTime() - TODAY_DATE.getTime()) / 86400000);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 py-8">
        <h2 className="text-3xl font-medium mb-1" style={{ fontFamily: "'Fraunces', serif" }}>마감 작업</h2>
        <p className="text-sm text-muted-foreground mb-8">시간대 없이 날짜만 지정된 작업 목록</p>

        {overdue.length > 0 && (
          <div className="mb-7">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">지난 마감</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{overdue.length}</span>
            </div>
            <div className="space-y-2">
              {overdue.map(d => (
                <div key={d.id} className="flex items-center gap-4 px-4 py-3.5 rounded-xl border border-red-200 bg-red-50/40">
                  <button onClick={() => onToggle(d.id)}><Circle size={18} className="text-red-400" /></button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5" style={{ fontFamily: "'Geist Mono', monospace" }}>{d.dueDate}</div>
                  </div>
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-red-100 text-red-600 font-medium flex-shrink-0">
                    {Math.abs(daysLeft(d.dueDate))}일 초과
                  </span>
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
                <div key={d.id} className="flex items-center gap-4 px-4 py-3.5 rounded-xl border bg-card">
                  <button onClick={() => onToggle(d.id)}><Circle size={18} className="text-muted-foreground" /></button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5" style={{ fontFamily: "'Geist Mono', monospace" }}>{d.dueDate}</div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${dl <= 3 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>
                    D-{dl}
                  </span>
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
                      onAddDeadline({ title: newTitle.trim(), dueDate: newDueDate });
                      setNewTitle(""); setShowAdd(false);
                    }}
                    disabled={!newTitle.trim()}
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
                <div key={d.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border">
                  <button onClick={() => onToggle(d.id)}><CheckCircle2 size={18} className="text-green-600" /></button>
                  <div className="text-sm line-through text-muted-foreground">{d.title}</div>
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
const ACT_NAMES = ["운영체제", "알고리즘", "React 개발", "운동", "독서", "글쓰기", "수학", "영어"];
const ACT_COLORS = ["#6B9B37", "#5B7EA8", "#C89A2E", "#D4622A", "#8B6E4E", "#4E8B6E", "#7B5EA7", "#A87B5E"];

function GrassSection({
  completionRate, blocks, timerSec, totalPlanMin,
}: {
  completionRate: number;
  blocks: Block[];
  timerSec: number;
  totalPlanMin: number;
}) {
  const [viewYear, setViewYear] = useState(2026);
  const [viewMonth, setViewMonth] = useState(6); // 0-indexed, 6 = July
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

  // Deterministic activity data per day
  const getDayData = (dateStr: string): {
    activities: { title: string; color: string }[];
    focusMin: number;
    goalMet: boolean;
  } => {
    if (dateStr === TODAY_STR) {
      const completedBlocks = blocks.filter(b => b.completed);
      return {
        activities: completedBlocks.map(b => ({ title: b.title, color: b.color })),
        focusMin: focusedMin,
        goalMet: focusedMin >= goalMin && goalMin > 0,
      };
    }
    if (dateStr > TODAY_STR) return { activities: [], focusMin: 0, goalMet: false };
    const d = parseLocalDate(dateStr);
    const n = d.getDate() + d.getMonth() * 31 + (d.getFullYear() - 2026) * 365;
    const seed = ((n * 17 + 7) % 97 + 97) % 97;
    if (seed < 30) return { activities: [], focusMin: 0, goalMet: false };
    const numActs = seed < 50 ? 1 : seed < 70 ? 2 : seed < 85 ? 3 : 4;
    const fm = (seed % 5 + 1) * 40 + (n % 40);
    const acts = Array.from({ length: Math.min(numActs, ACT_NAMES.length) }, (_, i) => {
      const idx = (n + i * 3) % ACT_NAMES.length;
      return { title: ACT_NAMES[idx], color: ACT_COLORS[idx] };
    });
    return { activities: acts, focusMin: fm, goalMet: fm >= 120 };
  };

  // Monthly summary stats
  const monthDays = dayStrings.filter((d): d is string => d !== null && d <= TODAY_STR);
  const achievedDays = monthDays.filter(d => getDayData(d).goalMet).length;
  const activeDays = monthDays.filter(d => getDayData(d).activities.length > 0).length;

  const tagStats = [
    { tag: "공부", color: "#5B7EA8" },
    { tag: "개발", color: "#7B5EA7" },
    { tag: "루틴", color: "#C89A2E" },
    { tag: "운동", color: "#D4622A" },
  ].map(({ tag, color }) => ({
    tag, color,
    done: blocks.filter(b => b.completed && b.tags.includes(tag)).length,
    total: blocks.filter(b => b.tags.includes(tag)).length,
  })).filter(t => t.total > 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        <h2 className="text-3xl font-medium mb-8" style={{ fontFamily: "'Fraunces', serif" }}>활동 기록 & 통계</h2>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {/* Checklist completion */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-3">오늘 체크리스트 달성률</div>
            <div className="flex items-end gap-3">
              <div className="text-3xl font-semibold" style={{ fontFamily: "'Fraunces', serif" }}>{completionRate}%</div>
              <CircleProgress value={completionRate} size={44} />
            </div>
            <div className="mt-3 h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${completionRate}%` }} />
            </div>
          </div>

          {/* Focus time vs editable goal */}
          <div className="p-5 rounded-xl border bg-card">
            <div className="text-[11px] text-muted-foreground mb-1">오늘 집중 시간</div>
            <div className="text-3xl font-semibold mt-1" style={{ fontFamily: "'Geist Mono', monospace" }}>
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
                    style={{ fontFamily: "'Geist Mono', monospace" }}
                  />
                  <span className="text-[11px] text-muted-foreground">시간</span>
                  <button type="submit" className="p-0.5 text-green-600 hover:text-green-700"><Check size={12} /></button>
                </form>
              ) : (
                <button
                  onClick={() => { setGoalInput(String((goalMin / 60).toFixed(1))); setEditingGoal(true); }}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground group"
                >
                  <span style={{ fontFamily: "'Geist Mono', monospace" }}>
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
              <Flame size={11} /> 이번 달
            </div>
            <div className="text-3xl font-semibold mt-2" style={{ fontFamily: "'Fraunces', serif" }}>{achievedDays}일</div>
            <div className="text-[11px] text-muted-foreground mt-1">목표 달성 · {activeDays}일 활동</div>
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
                  <span className="inline-block size-2.5 rounded-sm bg-green-100 border border-green-300" />
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
                    data.goalMet ? "bg-green-50/70" : ""
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
                      <span className="text-[9px] text-green-600 font-medium">✓</span>
                    )}
                  </div>

                  {/* Focus time — shown first */}
                  {!isFuture && data.focusMin > 0 && (
                    <div
                      className="text-[9px] font-semibold mb-0.5"
                      style={{ fontFamily: "'Geist Mono', monospace", color: data.goalMet ? "#16a34a" : undefined }}
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
                  <span className="text-[11px] text-muted-foreground w-8 text-right flex-shrink-0" style={{ fontFamily: "'Geist Mono', monospace" }}>
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

// ── Settings Section ───────────────────────────────────────────────
function SettingsSection({
  pomodoroOn, setPomodoroOn, pomWork, setPomWork,
  pomBreak, setPomBreak, abandonMin, setAbandonMin,
}: {
  pomodoroOn: boolean; setPomodoroOn: (v: boolean) => void;
  pomWork: number; setPomWork: (v: number) => void;
  pomBreak: number; setPomBreak: (v: number) => void;
  abandonMin: number; setAbandonMin: (v: number) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-8 py-8">
        <h2 className="text-3xl font-medium mb-2" style={{ fontFamily: "'Fraunces', serif" }}>설정</h2>
        <p className="text-sm text-muted-foreground mb-8">타이머 · 알림 · 뽀모도로 설정</p>

        <div className="space-y-4">
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
                  <input type="number" value={pomWork} onChange={e => setPomWork(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1.5">쉬는 시간 (분)</label>
                  <input type="number" value={pomBreak} onChange={e => setPomBreak(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">방치 알림</div>
            <div className="text-[11px] text-muted-foreground mb-4">수동 정지 후 지정 시간이 지나면 브라우저 알림 발송</div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1.5">알림 임계 시간 (분)</label>
              <input type="number" value={abandonMin} onChange={e => setAbandonMin(Number(e.target.value))}
                className="w-40 px-3 py-2 rounded-lg bg-muted text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-2">전역 타이머 동작</div>
            <div className="text-[11px] text-muted-foreground space-y-1.5">
              <div className="flex gap-2 items-start">
                <span className="size-2 mt-1 rounded-full bg-green-500 flex-shrink-0" />
                <span><strong>실행 중</strong> → 다른 탭으로 전환 시 자동 일시정지</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="size-2 mt-1 rounded-full bg-amber-400 flex-shrink-0" />
                <span><strong>자동 일시정지</strong> → 탭으로 돌아오면 자동 재시작</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="size-2 mt-1 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                <span><strong>수동 정지</strong> → 탭 전환과 무관, 직접 재시작</span>
              </div>
            </div>
          </div>

          <div className="p-5 rounded-xl border bg-card">
            <div className="text-sm font-medium mb-1">브라우저 알림 권한</div>
            <div className="text-[11px] text-muted-foreground mb-4">뽀모도로·방치 알림을 받으려면 브라우저 알림 권한이 필요해요</div>
            <button
              onClick={() => typeof Notification !== "undefined" && Notification.requestPermission()}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              알림 권한 요청
            </button>
            <p className="text-[11px] text-muted-foreground mt-3">※ 브라우저를 완전히 닫은 상태에서는 알림이 발송되지 않아요</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Block Detail Panel — no timer (v2) ─────────────────────────────
function BlockDetailPanel({
  block, childBlocks, templates, onClose, onToggle, onDelete, onDeleteRepeatGroup, onSetRepeat, onMemoSave,
  onSelectChild, onToggleChild, onAddTimeblockChild, onGoToParent,
}: {
  block: Block;
  childBlocks: Block[];
  templates: Template[];
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onDeleteRepeatGroup: (fromDate: string) => void;
  onSetRepeat: (repeat: BlockRepeat) => void;
  onMemoSave: (memo: string) => void;
  onSelectChild: (b: Block) => void;
  onToggleChild: (id: string) => void;
  onAddTimeblockChild: (child: { templateId: string; title: string; color: string; tags: string[]; startH: number; startM: number; endH: number; endM: number }) => void;
  onGoToParent: () => void;
}) {
  const [memo, setMemo] = useState(block.memo);
  const [nextBlock, setNextBlock] = useState("");

  // 체크리스트형 자식(무제한 중첩) — block.id 기준으로 불러옴. 위 BlockDetailPanel은
  // key={selectedBlock.id}로 블록이 바뀔 때마다 통째로 리마운트되므로 이 useEffect는
  // 이 블록의 데이터만 다룸.
  const [items, setItems] = useState<ChecklistItemT[]>([]);
  useEffect(() => {
    fetchChecklistItems(block.id).then(setItems).catch(console.error);
  }, [block.id]);

  const addChecklistItem = async (text: string, parentItemId?: string) => {
    try {
      const created = await createChecklistItem(block.id, text, parentItemId);
      setItems(is => [...is, created]);
    } catch (e) { console.error(e); }
  };
  const toggleChecklistItem = async (id: string, completed: boolean) => {
    setItems(is => is.map(i => i.id === id ? { ...i, completed } : i));
    try { await toggleChecklistItemRow(id, completed); } catch (e) { console.error(e); }
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
    try { await deleteChecklistItemRow(id); } catch (e) { console.error(e); }
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
        <span className="text-sm font-medium flex-1 truncate">{block.title}</span>
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
            <div className="text-[11px] text-muted-foreground" style={{ fontFamily: "'Geist Mono', monospace" }}>
              {block.date} ({DAYS_KO[parseLocalDate(block.date).getDay()]})
            </div>
            <div className="text-sm font-medium mt-0.5" style={{ fontFamily: "'Geist Mono', monospace" }}>
              {fmtTime(block.startH, block.startM)} – {fmtTime(block.endH, block.endM)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{durMin(block)}분</div>
          </div>
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
                  className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/60 rounded-lg px-1.5 py-1 transition-colors"
                >
                  <button onClick={e => { e.stopPropagation(); onToggleChild(cb.id); }}>
                    {cb.completed
                      ? <CheckCircle2 size={13} style={{ color: cb.color }} />
                      : <Circle size={13} className="text-muted-foreground" />
                    }
                  </button>
                  <span className="w-0.5 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cb.color }} />
                  <span className={`flex-1 truncate ${cb.completed ? "line-through text-muted-foreground" : ""}`}>{cb.title}</span>
                  <span className="text-muted-foreground flex-shrink-0" style={{ fontFamily: "'Geist Mono', monospace" }}>
                    {fmtTime(cb.startH, cb.startM)}-{fmtTime(cb.endH, cb.endM)}
                  </span>
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

        {/* Habit stacking */}
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">습관 스태킹</div>
          <input
            value={nextBlock}
            onChange={e => setNextBlock(e.target.value)}
            placeholder="다음 블록 선택..."
            className="w-full px-3 py-2 text-xs rounded-lg bg-muted outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          />
        </div>

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
                          onChange={e => setRepeatEndCount(Number(e.target.value))}
                          onClick={() => setRepeatEndType("count")}
                          className="w-12 px-1.5 py-0.5 text-[11px] rounded bg-muted outline-none focus:ring-1 focus:ring-ring"
                          style={{ fontFamily: "'Geist Mono', monospace" }}
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

          {repeatType !== "none" && (
            <button onClick={saveRepeat}
              className={`w-full py-1.5 text-xs rounded-lg font-medium transition-all ${showRepeatSaved ? "bg-green-100 text-green-700" : "bg-muted hover:bg-muted/70 text-foreground"}`}>
              {showRepeatSaved ? "✓ 반복 저장됨" : "반복 저장"}
            </button>
          )}
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
  onAddChild: (parentItemId: string, text: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const kids = items.filter(i => i.parentItemId === item.id);

  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <div className="group flex items-center gap-1.5 text-xs py-0.5">
        <button onClick={() => onToggle(item.id, !item.completed)} className="flex-shrink-0">
          {item.completed
            ? <CheckCircle2 size={13} className="text-green-500" />
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
            onAdd={text => { onAddChild(item.id, text); setShowAdd(false); }}
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
        <button type="submit" className="text-[11px] text-green-600 hover:text-green-700 px-1.5">추가</button>
      )}
    </form>
  );
}
