import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AikoSays } from "@/components/Aiko";
import { HideSuggestion } from "@/components/NotifyControls";
import { ReminderCard } from "@/components/ReminderCard";
import { CardSkeleton, EmptyState } from "@/components/ui";
import { suggestions } from "@/lib/notify/followthrough";
import { snapshotForUser } from "@/lib/notify/snapshot";
import { localDate } from "@/lib/notify/time";
import { effective } from "@/lib/schema";
import { listActions, listDeliveries, listReminders, listMemories } from "@/lib/store";
import { listPlans } from "@/lib/store";

export const metadata: Metadata = { title: "Reminders" };

export default function RemindersPage() {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="sr-only">Reminders</h1>
        <nav aria-label="Related" className="flex gap-4 text-sm font-medium">
          <Link className="underline underline-offset-4" href="/notifications">Inbox</Link>
          <Link className="underline underline-offset-4" href="/briefing">Today&apos;s briefing</Link>
          <Link className="underline underline-offset-4" href="/settings/notifications">Settings</Link>
        </nav>
      </div>
      <AikoSays mood="encouraging" size={104} className="mt-4" title="Little nudges, no pressure">
        Here&apos;s what you asked me to remind you about. Do it, move it or let it go, it&apos;s all fine.
      </AikoSays>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={2} /></div>}>
        <Reminders />
      </Suspense>
    </div>
  );
}

async function Reminders() {
  await connection();
  const now = new Date();
  const [all, memories, actions, deliveries, snap] = await Promise.all([
    listReminders(),
    listMemories(),
    listActions(),
    listDeliveries({ kind: "reminder", limit: 300 }).catch(() => []),
    snapshotForUser(now).catch(() => null),
    listPlans().catch(() => []),
  ]);
  const tz = snap?.prefs.timezone ?? "UTC";
  const title = new Map(memories.map((m) => [m.id, effective(m).title]));
  const ideas = snap ? suggestions(snap) : [];
  const unread = (await listDeliveries({ unreadOnly: true, limit: 200 }).catch(() => [])).length;

  const today = localDate(now, tz);
  const open = (r: (typeof all)[number]) => r.status === "scheduled" || r.status === "snoozed";
  const past = (r: (typeof all)[number]) => Date.parse(r.dueAt) <= now.getTime();
  const overdue = all.filter((r) => open(r) && past(r));
  const snoozed = all.filter((r) => r.status === "snoozed" && !past(r));
  const todays = all.filter((r) => r.status === "scheduled" && !past(r) && localDate(new Date(r.dueAt), tz) === today);
  const upcoming = all.filter((r) => r.status === "scheduled" && !past(r) && localDate(new Date(r.dueAt), tz) !== today);
  const done = all.filter((r) => !open(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = [
    { id: "overdue", label: "Waiting for you", hint: "These are past their time. Do them when you can, move them, or let them go.", items: overdue },
    { id: "today", label: "Today", hint: undefined, items: todays },
    { id: "upcoming", label: "Upcoming", hint: undefined, items: upcoming },
    { id: "snoozed", label: "Snoozed", hint: "Put off until the time shown.", items: snoozed },
    { id: "completed", label: "Completed and dismissed", hint: undefined, items: done },
  ].filter((g) => g.items.length);

  return (
    <div className="mt-8 space-y-10">
      {unread > 0 && (
        <p className="rounded-2xl bg-butter-soft p-3 text-sm">
          You have {unread} unread {unread === 1 ? "notification" : "notifications"}. <Link className="font-medium underline underline-offset-4" href="/notifications">Open your inbox</Link>
        </p>
      )}

      {ideas.length > 0 && (
        <section aria-labelledby="ft">
          <h2 id="ft" className="font-display text-2xl">Worth a look</h2>
          <p className="mt-1 text-sm text-ink-faint">Acorn only suggests. It never moves a date or finishes something for you, and you can hide any suggestion.</p>
          <ul className="mt-3 space-y-3">
            {ideas.map((s) => (
              <li key={s.key} className="rounded-2xl border border-dashed border-line p-4 text-[15px]">
                <p>{s.text}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Link className="text-sm font-medium underline underline-offset-4" href={s.link.href}>{s.link.label}</Link>
                  <HideSuggestion k={s.key} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {all.length === 0 && (
        <EmptyState mood="sleeping" title="Nothing to remind you about" action={{ href: "/memories", label: "Open a memory" }}>
          Set one from any memory, or approve a plan that makes one for an application deadline, a recipe or a follow-up.
        </EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={g.id}>
          <h2 id={g.id} className="font-display text-2xl">
            {g.label} <span className="text-base font-normal text-ink-faint">({g.items.length})</span>
          </h2>
          {g.hint && <p className="mt-1 text-sm text-ink-faint">{g.hint}</p>}
          <div className="mt-3 space-y-3">
            {g.items.map((r) => (
              <ReminderCard key={r.id} r={r} memoryTitle={title.get(r.memoryId) ?? "a memory"} action={actions.find((a) => a.id === r.actionId)} deliveries={deliveries} tz={tz} now={now} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
