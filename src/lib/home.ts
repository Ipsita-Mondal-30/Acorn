import { effective, type Action, type ActionState, type Memory } from "./schema";

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
