import { supabase } from "./supabase";

// ── DB row <-> app-shape mapping helpers ───────────────────────────
// DB stores start_time/end_time as Postgres "time" ("HH:MM:SS" strings);
// the UI works with separate startH/startM/endH/endM numbers.
const parseTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return { h, m };
};
const toTime = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

export function rowToBlock(row: any) {
  const start = parseTime(row.start_time);
  const end = parseTime(row.end_time);
  return {
    id: row.id,
    templateId: row.template_id,
    title: row.title,
    color: row.color,
    startH: start.h,
    startM: start.m,
    endH: end.h,
    endM: end.m,
    completed: row.completed,
    tags: row.tags ?? [],
    memo: row.memo ?? "",
    date: row.date,
    repeatGroupId: row.repeat_group_id ?? undefined,
    repeat: row.repeat_rule ?? undefined,
    parentBlockId: row.parent_block_id ?? undefined,
    nextBlockId: row.next_block_id ?? undefined,
  };
}

function blockToRow(block: any) {
  return {
    template_id: block.templateId ?? null,
    parent_block_id: block.parentBlockId ?? null,
    title: block.title,
    color: block.color,
    date: block.date,
    start_time: toTime(block.startH, block.startM),
    end_time: toTime(block.endH, block.endM),
    completed: block.completed ?? false,
    completed_at: block.completed ? new Date().toISOString() : null,
    memo: block.memo ?? "",
    repeat_group_id: block.repeatGroupId ?? null,
    repeat_rule: block.repeat ?? null,
    next_block_id: block.nextBlockId ?? null,
  };
}

// ── block_templates ─────────────────────────────────────────────
export async function fetchTemplates() {
  const { data, error } = await supabase.from("block_templates").select("*").order("created_at");
  if (error) throw error;
  return (data ?? []).map(t => ({ id: t.id, title: t.title, color: t.color, tags: t.tags ?? [] }));
}

export async function createTemplate(t: { title: string; color: string; tags: string[] }) {
  const { data, error } = await supabase.from("block_templates").insert(t).select().single();
  if (error) throw error;
  return { id: data.id, title: data.title, color: data.color, tags: data.tags ?? [] };
}

// ── blocks ──────────────────────────────────────────────────────
export async function fetchBlocks() {
  const { data, error } = await supabase.from("blocks").select("*, tags:block_templates(tags)");
  if (error) throw error;
  return (data ?? []).map((row: any) => {
    const b = rowToBlock(row);
    b.tags = row.tags?.tags ?? [];
    return b;
  });
}

export async function insertBlock(block: any) {
  const row = blockToRow(block);
  const { data, error } = await supabase.from("blocks").insert(row).select("*, tags:block_templates(tags)").single();
  if (error) throw error;
  const b = rowToBlock(data);
  b.tags = (data as any).tags?.tags ?? block.tags ?? [];
  return b;
}

export async function patchBlock(id: string, changes: any) {
  const row: Record<string, any> = {};
  if (changes.title !== undefined) row.title = changes.title;
  if (changes.color !== undefined) row.color = changes.color;
  if (changes.date !== undefined) row.date = changes.date;
  if (changes.startH !== undefined || changes.startM !== undefined) {
    row.start_time = toTime(changes.startH, changes.startM);
  }
  if (changes.endH !== undefined || changes.endM !== undefined) {
    row.end_time = toTime(changes.endH, changes.endM);
  }
  if (changes.completed !== undefined) {
    row.completed = changes.completed;
    row.completed_at = changes.completed ? new Date().toISOString() : null;
  }
  if (changes.memo !== undefined) row.memo = changes.memo;
  if (changes.repeatGroupId !== undefined) row.repeat_group_id = changes.repeatGroupId;
  if (changes.repeat !== undefined) row.repeat_rule = changes.repeat;
  if (changes.nextBlockId !== undefined) row.next_block_id = changes.nextBlockId;

  const { error } = await supabase.from("blocks").update(row).eq("id", id);
  if (error) throw error;
}

export async function deleteBlockRow(id: string) {
  const { error } = await supabase.from("blocks").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteBlocksByRepeatGroup(repeatGroupId: string, fromDate: string) {
  const { error } = await supabase
    .from("blocks")
    .delete()
    .eq("repeat_group_id", repeatGroupId)
    .gte("date", fromDate);
  if (error) throw error;
}

export async function insertBlocksBulk(blocks: any[]) {
  if (blocks.length === 0) return [];
  const rows = blocks.map(blockToRow);
  const { data, error } = await supabase.from("blocks").insert(rows).select("*, tags:block_templates(tags)");
  if (error) throw error;
  return (data ?? []).map((row: any) => {
    const b = rowToBlock(row);
    b.tags = row.tags?.tags ?? [];
    return b;
  });
}

// ── deadlines ───────────────────────────────────────────────────
export async function fetchDeadlines() {
  const { data, error } = await supabase.from("deadlines").select("*").order("due_date");
  if (error) throw error;
  return (data ?? []).map((d: any) => ({
    id: d.id, title: d.title, dueDate: d.due_date, completed: d.completed,
  }));
}

export async function createDeadline(d: { title: string; dueDate: string }) {
  const { data, error } = await supabase
    .from("deadlines")
    .insert({ title: d.title, due_date: d.dueDate })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, title: data.title, dueDate: data.due_date, completed: data.completed };
}

export async function toggleDeadlineRow(id: string, completed: boolean) {
  const { error } = await supabase
    .from("deadlines")
    .update({ completed, completed_at: completed ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) throw error;
}

// ── schedule_templates ─────────────────────────────────────────
export async function fetchScheduleTemplates() {
  const { data, error } = await supabase.from("schedule_templates").select("*").order("created_at");
  if (error) throw error;
  return (data ?? []).map((t: any) => ({ id: t.id, name: t.name, blocks: t.blocks }));
}

export async function createScheduleTemplateRow(name: string, blocks: any[]) {
  const { data, error } = await supabase
    .from("schedule_templates")
    .insert({ name, blocks })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, blocks: data.blocks };
}

export async function deleteScheduleTemplateRow(id: string) {
  const { error } = await supabase.from("schedule_templates").delete().eq("id", id);
  if (error) throw error;
}

// ── timer_sessions ──────────────────────────────────────────────
// A "session" is one continuous running stretch. It ends (ended_at set) either because the tab
// was hidden (end_reason: "auto") or the user hit stop (end_reason: "manual"). The gap between
// one session's end and the next session's start is a rest period.
export async function fetchTodaySessions(date: string) {
  const { data, error } = await supabase
    .from("timer_sessions")
    .select("*")
    .eq("date", date)
    .order("started_at");
  if (error) throw error;
  return (data ?? []).map((s: any) => ({
    id: s.id,
    date: s.date,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    endReason: s.end_reason as "manual" | "auto" | "ongoing",
  }));
}

export async function startTimerSession(date: string) {
  const { data, error } = await supabase
    .from("timer_sessions")
    .insert({ date, started_at: new Date().toISOString(), end_reason: "ongoing" })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, date: data.date, startedAt: data.started_at, endedAt: data.ended_at, endReason: data.end_reason };
}

export async function endTimerSession(id: string, endReason: "manual" | "auto") {
  const { error } = await supabase
    .from("timer_sessions")
    .update({ ended_at: new Date().toISOString(), end_reason: endReason })
    .eq("id", id);
  if (error) throw error;
}
