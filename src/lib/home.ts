import type { Plan, Reminder } from "./agent/schema";
import { StudyPack, studyProgress } from "./agent/study";
import { effective, INTENT_LABEL, type Action, type ActionState, type Memory } from "./schema";

// Calendar days are the user's local days (the server is the user's machine).
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whole days from one YYYY-MM-DD to another (negative if `to` is earlier). */
export const dayDiff = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Calendar days since an ISO timestamp, never negative (clock skew). */
export const daysAgo = (iso: string, now: Date) => Math.max(0, dayDiff(localDay(new Date(iso)), localDay(now)));

export const byNewest = (a: Memory, b: Memory) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

// An action that is not cancelled/failed means the user is handling the item.
const HANDLED: ActionState[] = ["proposed", "awaiting_approval", "approved", "in_progress", "completed"];

const dueIn = (n: number) => (n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : `Due in ${n} days`);

export function homeSections(memories: Memory[], actions: Action[], now: Date) {
  const today = localDay(now);
  const sorted = [...memories].sort(byNewest);

  const needsAttention: { memory: Memory; reason: string; rank: number }[] = [];
  const upcoming: { memory: Memory; date: string; label: string; daysLeft: number }[] = [];

  for (const memory of sorted) {
    const v = effective(memory);
    const x = memory.extraction;
    const mine = actions.filter((a) => a.memoryId === memory.id);
    const reasons: string[] = [];
    let rank = Infinity; // soonest deadline first, then recency

    if (memory.status === "failed") reasons.push(`Processing failed${memory.error ? `: ${memory.error}` : ""}`);
    if (x && x.confidence < 0.5 && v.edited.length === 0) {
      reasons.push(`Low confidence (${Math.round(x.confidence * 100)}%) — check the details`);
    }
    if (v.deadline) {
      const left = dayDiff(today, v.deadline);
      if (left >= 0 && left <= 7 && !mine.some((a) => HANDLED.includes(a.state))) {
        reasons.push(`${dueIn(left)} — no action yet`);
        rank = left;
      }
    }
    for (const a of mine) {
      if (a.state === "proposed") reasons.push(`Suggested: "${a.title}"`);
      if (a.state === "awaiting_approval") reasons.push(`Waiting for your approval: "${a.title}"`);
    }
    if (reasons.length) needsAttention.push({ memory, reason: reasons.join(" · "), rank });

    const dates = [
      ...(v.deadline
        ? [{
            date: v.deadline,
            label: v.edited.includes("deadline")
              ? "Deadline (set by you)"
              : (x?.dates.find((d) => d.isDeadline && d.date === v.deadline)?.label ?? "Deadline"),
          }]
        : []),
      ...(x?.dates.filter((d) => !d.isDeadline) ?? []),
    ];
    for (const { date, label } of dates) {
      const daysLeft = dayDiff(today, date);
      if (daysLeft >= 0) upcoming.push({ memory, date, label, daysLeft });
    }
  }

  return {
    // skip what "Needs attention" already shows, so Home never lists a memory twice
    recent: sorted.filter((m) => !needsAttention.some((n) => n.memory.id === m.id)).slice(0, 6),
    // stable sort keeps recency order within the same rank
    needsAttention: needsAttention
      .sort((a, b) => a.rank - b.rank || 0) // Infinity - Infinity is NaN
      .map(({ memory, reason }) => ({ memory, reason })),
    upcoming: upcoming
      .sort((a, b) => a.date.localeCompare(b.date) || a.memory.id.localeCompare(b.memory.id) || a.label.localeCompare(b.label))
      .slice(0, 6),
  };
}

export type NextUp = { key: string; memoryId: string; title: string; verb: string; detail: string; href: string; /** why this is on the list, in plain words */ why: string };

/**
 * What to do next, most pressing first: due reminders, plans waiting on you, intents waiting for your decision, then plans
 * that could be made. Each item names the memory and the single thing to do; nothing here is a guess dressed up as a task.
 */
export function nextUp(memories: Memory[], plans: Plan[], reminders: Reminder[], now: Date, limit = 5): NextUp[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const out: NextUp[] = [];
  const title = (id: string) => (byId.has(id) ? effective(byId.get(id)!).title : "A memory");
  const link = (id: string) => `/memories/${id}`;

  for (const r of reminders) {
    if (!["scheduled", "snoozed"].includes(r.status) || Date.parse(r.dueAt) > now.getTime() || !byId.has(r.memoryId)) continue;
    out.push({ key: `rem-${r.id}`, memoryId: r.memoryId, title: title(r.memoryId), verb: "Reminder is due", detail: r.title, href: link(r.memoryId), why: "You set this reminder, and its time has come." });
  }
  const livePlans = plans.filter((p) => byId.has(p.memoryId) && !["completed", "rejected"].includes(p.status));
  for (const p of livePlans) {
    if (p.status === "awaiting_approval") {
      out.push({ key: `plan-${p.id}`, memoryId: p.memoryId, title: title(p.memoryId), verb: "Approve or reject the plan", detail: `Nothing runs until you approve: ${p.goal}`, href: link(p.memoryId), why: "Acorn drafted a plan from what you saved. It never acts until you approve." });
    } else if (p.status === "failed") {
      out.push({ key: `plan-${p.id}`, memoryId: p.memoryId, title: title(p.memoryId), verb: "A step needs attention", detail: p.goal, href: link(p.memoryId), why: "A step of your plan didn't finish, and Acorn won't carry on by itself." });
    } else {
      const pack = p.steps.find((s) => s.tool === "build_study_pack" && s.output && ["awaiting_review", "succeeded"].includes(s.state));
      const parsed = pack ? StudyPack.safeParse(pack.output) : null;
      const waiting = p.steps.find((s) => s.state === "awaiting_review") ?? p.steps.find((s) => s.kind === "user" && s.state === "pending");
      if (parsed?.success && pack?.state === "succeeded") {
        const sp = studyProgress(parsed.data);
        out.push({ key: `plan-${p.id}`, memoryId: p.memoryId, title: title(p.memoryId), verb: "Keep studying", detail: `${sp.known} of ${sp.cards} cards known, ${sp.review} to review`, href: link(p.memoryId), why: "You started this study pack and haven't finished it." });
      } else if (waiting) {
        out.push({ key: `plan-${p.id}`, memoryId: p.memoryId, title: title(p.memoryId), verb: waiting.state === "awaiting_review" ? "Review what Acorn prepared" : "Your step", detail: waiting.title, href: link(p.memoryId), why: waiting.state === "awaiting_review" ? "Acorn prepared this and it only counts once you check it." : "This step is yours: Acorn can't do it for you." });
      }
    }
  }
  const planned = new Set(plans.filter((p) => !["rejected"].includes(p.status)).map((p) => p.memoryId));
  for (const m of [...memories].sort(byNewest)) {
    if (m.status !== "ready" || !m.extraction) continue;
    const v = effective(m);
    if (!v.intentKind && v.suggestedIntent) {
      out.push({ key: `intent-${m.id}`, memoryId: m.id, title: v.title, verb: "Tell Acorn why you saved this", detail: `Acorn's guess is ${INTENT_LABEL[v.suggestedIntent.kind].toLowerCase()}, but only you know`, href: link(m.id), why: "Acorn guessed from the content, not from anything you said, so it is waiting for your answer." });
    }
  }
  for (const m of [...memories].sort(byNewest)) {
    const v = effective(m);
    if (m.status === "ready" && v.intentKind && !planned.has(m.id) && !["reference", "remember"].includes(v.intentKind)) {
      out.push({ key: `make-${m.id}`, memoryId: m.id, title: v.title, verb: "Make a plan", detail: `You said: ${INTENT_LABEL[v.intentKind].toLowerCase()}`, href: link(m.id), why: `You told Acorn you want to ${INTENT_LABEL[v.intentKind].toLowerCase()} this, and there is no plan yet.` });
    }
  }
  return out.slice(0, limit);
}

export type LearningItem = { plan: Plan; memory: Memory; sp: ReturnType<typeof studyProgress> | null };

/** Plans for things the user wants to learn (not finished or rejected), with study progress once the pack exists. */
export function learningPlans(memories: Memory[], plans: Plan[]): LearningItem[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  return plans
    .filter((p) => p.intentKind === "learn" && p.workflow === "followup" && byId.has(p.memoryId) && !["rejected"].includes(p.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((plan) => {
      const step = plan.steps.find((s) => s.tool === "build_study_pack" && s.output);
      const parsed = step ? StudyPack.safeParse(step.output) : null;
      return { plan, memory: byId.get(plan.memoryId)!, sp: parsed?.success ? studyProgress(parsed.data) : null };
    });
}
