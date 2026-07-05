export type TimerState = "running" | "auto-paused" | "stopped";

const fmt2 = (n: number) => String(n).padStart(2, "0");
export const fmtSec = (s: number) => `${fmt2(Math.floor(s / 60))}:${fmt2(s % 60)}`;
