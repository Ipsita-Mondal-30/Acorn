import type { Plan, Reminder } from "./agent/schema";
import { dayDiff, localDay } from "./home";
import { relatedMemories } from "./related";
import { effective, INTENT_LABEL, type Action, type Memory } from "./schema";

// What Acorn can say about a memory once it has been read, using only what is already stored: the memory's own reading,
// its connections to other memories (the same retrieval the Connected memories block uses), the user's confirmed
// intentions and plans, reminders and actions. It is computed on read, so it is always current and always traceable.
// It never decides for the user: an unconfirmed intention stays a question, and nothing here creates a plan or a date.

export type InsightKind = "joins_work" | "connection" | "next_step" | "deadline";
export type Insight = {
  /** stable: the same fact never shows up twice (e.g. on the memory page and again on Today) */
  key: string;
  kind: InsightKind;
  /** the memory this insight is about (the one that was just read) */
  memoryId: string;
  title: string;
  detail: string;
  /** why this is shown, in plain words, naming the stored facts it rests on */
  why: string;
  href: string;
};

const LIVE_PLAN = (p: Plan) => !["completed", "rejected"].includes(p.status);
const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const savedWhen = (m: Memory, now: Date) => {
  const d = dayDiff(localDay(new Date(m.createdAt)), localDay(now));
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
const kindWord = (m: Memory) => {
  const t = effective(m).contentType;
  return t === "other" ? "Item" : t[0].toUpperCase() + t.slice(1);
};
const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export type InsightContext = { memories: Memory[]; plans: Plan[]; reminders: Reminder[]; actions: Action[]; now: Date };

export function insightsFor(memory: Memory, ctx: InsightContext): Insight[] {
  if (memory.status !== "ready" || !memory.extraction) return [];
  const { memories, plans, reminders, actions, now } = ctx;
  const v = effective(memory);
  const out: Insight[] = [];
  const add = (i: Insight) => (out.some((o) => o.key === i.key) ? null : out.push(i));

  // 1. connections to things the user already decided about
  for (const r of relatedMemories(memory, memories, 5)) {
    if (r.memory.status !== "ready") continue;
    const rv = effective(r.memory);
    const reasons = r.reasons.slice(0, 2).join("; ");
    const livePlan = plans.find((p) => p.memoryId === r.memory.id && LIVE_PLAN(p));
    if (rv.intentKind && ["learn", "pursue", "follow_up"].includes(rv.intentKind) && livePlan) {
      add({
        key: `joins:${memory.id}:${r.memory.id}`, kind: "joins_work", memoryId: memory.id, title: `Connected to something you're already working on`,
        detail: `“${rv.title}”: ${livePlan.goal}`, href: `/memories/${r.memory.id}`,
        why: `${reasons}. You confirmed that you want to ${INTENT_LABEL[rv.intentKind].toLowerCase()} “${rv.title}”, and its plan isn't finished.`,
      });
    } else if (rv.intentKind && rv.intentKind !== "reference") {
      add({
        key: `conn:${memory.id}:${r.memory.id}`, kind: "connection", memoryId: memory.id, title: `Related to “${rv.title}”${r.memory.isSample ? " (sample)" : ""}`,
        detail: `You told Acorn you want to ${INTENT_LABEL[rv.intentKind].toLowerCase()} that one.`, href: `/memories/${r.memory.id}`, why: `${reasons}.`,
      });
    } else if (r.score >= 3) {
      add({ key: `conn:${memory.id}:${r.memory.id}`, kind: "connection", memoryId: memory.id, title: `Related to “${rv.title}”${r.memory.isSample ? " (sample)" : ""}`, detail: `${kindWord(r.memory)} saved ${savedWhen(r.memory, now)}.`, href: `/memories/${r.memory.id}`, why: `${reasons}.` });
    }
  }

  // 2. a deadline, only when it was actually extracted from the item or set by the user, and only if it is still ahead
  if (v.deadline) {
    const left = dayDiff(localDay(now), v.deadline);
    const covered = reminders.some((r) => r.memoryId === memory.id && ["scheduled", "snoozed"].includes(r.status)) || plans.some((p) => p.memoryId === memory.id && LIVE_PLAN(p));
    if (left >= 0 && left <= 60 && !covered) {
      const edited = v.edited.includes("deadline");
      add({
        key: `deadline:${memory.id}`, kind: "deadline", memoryId: memory.id, title: `Deadline ${fmt(v.deadline)}`,
        detail: left === 0 ? "That's today." : left === 1 ? "That's tomorrow." : `${left} days from now.`, href: `/memories/${memory.id}`,
        why: `${edited ? "You set this date" : "This date was found in the item"}, and there is no reminder or plan for it yet.`,
      });
    }
  }

  // 3. next steps the reading proposed, minus what already exists (an action, a plan goal or a reminder with the same words)
  const have = [...actions.filter((a) => a.memoryId === memory.id).map((a) => lower(a.title)), ...plans.filter((p) => p.memoryId === memory.id).map((p) => lower(p.goal)), ...reminders.filter((r) => r.memoryId === memory.id).map((r) => lower(r.title))];
  for (const n of memory.extraction.nextActions.slice(0, 3)) {
    const label = lower(n.label);
    if (have.some((h) => h.includes(label) || label.includes(h))) continue;
    add({ key: `step:${memory.id}:${label}`, kind: "next_step", memoryId: memory.id, title: n.label, detail: "A possible next step.", href: `/memories/${memory.id}#agent-heading`, why: "Proposed by the reading of this item. Nothing happens unless you plan it." });
  }
  return out;
}

/** Insights for what was read recently, each fact once, strongest first (work you're already doing, then deadlines, then the rest). */
export function recentInsights(ctx: InsightContext, opts: { withinDays?: number; limit?: number } = {}): Insight[] {
  const cutoff = ctx.now.getTime() - (opts.withinDays ?? 3) * 86_400_000;
  const order: Record<InsightKind, number> = { joins_work: 0, deadline: 1, connection: 2, next_step: 3 };
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const m of [...ctx.memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (Date.parse(m.createdAt) < cutoff) continue;
    for (const i of insightsFor(m, ctx)) {
      // the same pair of memories is one connection whichever of them is newer
      const pair = i.key.startsWith("joins:") || i.key.startsWith("conn:") ? [i.key.split(":")[1], i.key.split(":")[2]].sort().join("|") : i.key;
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push(i);
    }
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, opts.limit ?? 6);
}
