import type { Plan, Reminder } from "../agent/schema";
import { effective, type Action, type Memory } from "../schema";
import { addDays, localDate } from "./time";
import type { NotificationPrefs } from "./types";

// Follow-through checks. They LOOK and SUGGEST; they never change a reminder, a plan or an action. They run when you
// open Acorn (and once a day in the briefing), never as their own notification, and a suggestion you dismiss stays quiet
// for 14 days.

export type Snapshot = { memories: Memory[]; reminders: Reminder[]; actions: Action[]; plans: Plan[]; prefs: NotificationPrefs; now: Date };

export type Suggestion = {
  /** stable id for "dismiss for now" */
  key: string;
  kind: "overdue_action" | "postponed_reminder" | "incomplete_plan" | "upcoming_deadline";
  text: string;
  memoryId: string;
  link: { label: string; href: string };
};

export const STALE_ACTION_DAYS = 7;
export const STALE_PLAN_DAYS = 5;
export const POSTPONED_AFTER = 3;
export const DEADLINE_WINDOW_DAYS = 7;
export const SUGGESTION_SNOOZE_DAYS = 14;
export const MAX_SUGGESTIONS = 3;

const DAY = 86_400_000;
const days = (from: string, to: Date) => Math.floor((to.getTime() - Date.parse(from)) / DAY);
const open = (r: Reminder) => r.status === "scheduled" || r.status === "snoozed";
const title = (s: Snapshot, id: string) => {
  const m = s.memories.find((x) => x.id === id);
  return m ? effective(m).title : "a saved memory";
};
const memoryLink = (id: string) => ({ label: "Open the memory", href: `/memories/${id}` });

/** Actions that are not finished and are behind: past their scheduled time, or untouched for a week. */
export function overdueActions(s: Snapshot): { action: Action; why: string }[] {
  const out: { action: Action; why: string }[] = [];
  for (const a of s.actions) {
    if (a.state === "completed" || a.state === "cancelled" || a.kind === "suggested") continue; // an idea nobody started isn't overdue
    if (a.scheduledFor && Date.parse(a.scheduledFor) < s.now.getTime()) out.push({ action: a, why: `was scheduled for ${a.scheduledFor.slice(0, 10)} and is still ${a.state.replace("_", " ")}` });
    else if (days(a.updatedAt, s.now) >= STALE_ACTION_DAYS) out.push({ action: a, why: `has not moved for ${days(a.updatedAt, s.now)} days (${a.state.replace("_", " ")})` });
  }
  return out.sort((x, y) => x.action.updatedAt.localeCompare(y.action.updatedAt));
}

export const postponedReminders = (s: Snapshot) => s.reminders.filter((r) => open(r) && r.snoozeCount >= POSTPONED_AFTER);

export const incompletePlans = (s: Snapshot) =>
  s.plans.filter((p) => ["awaiting_you", "failed", "awaiting_approval"].includes(p.status) && days(p.updatedAt, s.now) >= STALE_PLAN_DAYS);

/** Deadlines in the next week on memories you decided to act on, with no open reminder and no active plan. */
export function upcomingDeadlines(s: Snapshot): { memory: Memory; deadline: string; daysLeft: number }[] {
  const today = localDate(s.now, s.prefs.timezone);
  const horizon = addDays(today, DEADLINE_WINDOW_DAYS);
  return s.memories
    .map((memory) => ({ memory, deadline: effective(memory).deadline, intent: effective(memory).intentKind }))
    .filter((x): x is { memory: Memory; deadline: string; intent: NonNullable<typeof x.intent> } => Boolean(x.deadline) && Boolean(x.intent) && x.deadline! >= today && x.deadline! <= horizon)
    .filter((x) => !s.reminders.some((r) => r.memoryId === x.memory.id && open(r)) && !s.plans.some((p) => p.memoryId === x.memory.id && !["completed", "rejected"].includes(p.status)))
    .map((x) => ({ memory: x.memory, deadline: x.deadline, daysLeft: Math.round((Date.parse(`${x.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) }))
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** At most three suggestions, most pressing first, minus anything you dismissed recently. Read-only. */
export function suggestions(s: Snapshot): Suggestion[] {
  const out: Suggestion[] = [];
  for (const d of upcomingDeadlines(s)) {
    out.push({ key: `deadline:${d.memory.id}`, kind: "upcoming_deadline", memoryId: d.memory.id, link: memoryLink(d.memory.id), text: `“${title(s, d.memory.id)}” has a deadline ${d.daysLeft === 0 ? "today" : d.daysLeft === 1 ? "tomorrow" : `in ${d.daysLeft} days (${d.deadline})`} and no reminder or plan. Want to set a reminder?` });
  }
  for (const { action, why } of overdueActions(s)) {
    out.push({ key: `action:${action.id}`, kind: "overdue_action", memoryId: action.memoryId, link: memoryLink(action.memoryId), text: `“${action.title}” ${why}. Continue it, or cancel it if it no longer matters.` });
  }
  for (const p of incompletePlans(s)) {
    const next = p.steps.find((x) => !["succeeded", "skipped"].includes(x.state));
    out.push({ key: `plan:${p.id}`, kind: "incomplete_plan", memoryId: p.memoryId, link: memoryLink(p.memoryId), text: `Your plan “${p.goal}” has been waiting ${days(p.updatedAt, s.now)} days${next ? `. Next: ${next.title}` : ""}.` });
  }
  for (const r of postponedReminders(s)) {
    out.push({ key: `reminder:${r.id}`, kind: "postponed_reminder", memoryId: r.memoryId, link: memoryLink(r.memoryId), text: `“${r.title}” has been moved ${r.snoozeCount} times. Pick a firm date, or dismiss it if it's no longer wanted.` });
  }
  const hidden = s.prefs.snoozedSuggestions;
  return out.filter((x) => !(hidden[x.key] && Date.parse(hidden[x.key]) > s.now.getTime())).slice(0, MAX_SUGGESTIONS);
}
