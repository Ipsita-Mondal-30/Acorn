import { effective } from "../schema";
import { suggestions, type Snapshot } from "./followthrough";
import { formatInZone, localDate, addDays } from "./time";
import type { Message } from "./types";

// The daily briefing: what needs YOU today, in a handful of lines. It is assembled from reminders, plans, actions and
// memories you marked for follow-up. It is not a summary of everything you saved, and it is empty (and not sent) on a
// quiet day.

const MAX_PER_SECTION = 5;
const open = (r: { status: string }) => r.status === "scheduled" || r.status === "snoozed";

export type Briefing = { message: Message; counts: { dueToday: number; overdue: number; approvals: number; deadlines: number; followUps: number; suggestions: number }; isEmpty: boolean };

export function buildBriefing(s: Snapshot): Briefing {
  const tz = s.prefs.timezone;
  const today = localDate(s.now, tz);
  const tomorrow = addDays(today, 1);
  const title = (id: string) => {
    const m = s.memories.find((x) => x.id === id);
    return m ? effective(m).title : "a saved memory";
  };
  const links: Message["links"] = [];
  const lines: string[] = [];
  const section = (heading: string, items: { text: string; href?: string }[]) => {
    if (!items.length) return;
    lines.push(`${heading}:`);
    for (const i of items.slice(0, MAX_PER_SECTION)) lines.push(`  • ${i.text}`);
    if (items.length > MAX_PER_SECTION) lines.push(`  • and ${items.length - MAX_PER_SECTION} more`);
    if (items[0].href && links.length < 6) links.push({ label: heading, href: items[0].href });
  };

  const openReminders = s.reminders.filter(open);
  const dueToday = openReminders.filter((r) => Date.parse(r.dueAt) >= s.now.getTime() && localDate(new Date(r.dueAt), tz) === today).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const overdue = openReminders.filter((r) => Date.parse(r.dueAt) < s.now.getTime()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const approvals = s.plans.filter((p) => p.status === "awaiting_approval");
  const deadlines = s.memories
    .map((m) => ({ m, d: effective(m).deadline, intent: effective(m).intentKind }))
    .filter((x) => x.d && x.intent && x.d >= today && x.d <= addDays(today, 7))
    .sort((a, b) => a.d!.localeCompare(b.d!));
  const followUps = s.memories.filter((m) => {
    const v = effective(m);
    return v.intentKind === "follow_up" && Date.parse(m.createdAt) > s.now.getTime() - 14 * 86_400_000 && !openReminders.some((r) => r.memoryId === m.id) && !s.plans.some((p) => p.memoryId === m.id && !["completed", "rejected"].includes(p.status));
  });
  const ideas = suggestions(s);

  section("Due today", dueToday.map((r) => ({ text: `${r.title}, ${formatInZone(new Date(r.dueAt), r.timezone ?? tz).replace(/ \(.*\)$/, "")}`, href: `/memories/${r.memoryId}` })));
  section("Overdue", overdue.map((r) => ({ text: `${r.title} (was due ${localDate(new Date(r.dueAt), tz)})`, href: `/memories/${r.memoryId}` })));
  section("Waiting for your approval", approvals.map((p) => ({ text: p.goal, href: `/memories/${p.memoryId}#agent-heading` })));
  section("Deadlines this week", deadlines.map((x) => ({ text: `${effective(x.m).title}: ${x.d === today ? "today" : x.d === tomorrow ? "tomorrow" : x.d}`, href: `/memories/${x.m.id}` })));
  section("You marked these for follow-up", followUps.map((m) => ({ text: effective(m).title, href: `/memories/${m.id}` })));
  if (ideas.length) section("Worth a look", ideas.map((i) => ({ text: i.text, href: i.link.href })));
  void title;

  const counts = { dueToday: dueToday.length, overdue: overdue.length, approvals: approvals.length, deadlines: deadlines.length, followUps: followUps.length, suggestions: ideas.length };
  const parts = [counts.dueToday && `${counts.dueToday} due today`, counts.overdue && `${counts.overdue} overdue`, counts.approvals && `${counts.approvals} to approve`, counts.deadlines && `${counts.deadlines} deadline${counts.deadlines === 1 ? "" : "s"} this week`].filter(Boolean);
  const isEmpty = lines.length === 0;
  return {
    isEmpty,
    counts,
    message: { kind: "briefing", title: parts.length ? `Your day: ${parts.join(", ")}` : isEmpty ? "Nothing needs you today" : "Your day", lines, links, draft: null },
  };
}
