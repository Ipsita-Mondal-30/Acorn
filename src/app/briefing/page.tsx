import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { HideSuggestion } from "@/components/NotifyControls";
import { CardSkeleton, EmptyState, PageIntro } from "@/components/ui";
import { buildBriefing } from "@/lib/notify/briefing";
import { suggestions } from "@/lib/notify/followthrough";
import { snapshotForUser } from "@/lib/notify/snapshot";

export const metadata: Metadata = { title: "Today's briefing" };

export default function BriefingPage() {
  return (
    <div>
      <PageIntro mood="encouraging" title="Today">
        Here&apos;s what could use you today, worked out right now from your reminders, plans and deadlines. Nothing is sent. <Link className="underline underline-offset-4" href="/settings/notifications">Get it each morning</Link>
      </PageIntro>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={2} /></div>}>
        <Briefing />
      </Suspense>
    </div>
  );
}

async function Briefing() {
  await connection();
  const snap = await snapshotForUser(new Date());
  const b = buildBriefing(snap);
  const ideas = suggestions(snap);
  if (b.isEmpty) return <div className="mt-8"><EmptyState mood="sleeping" title="Nothing needs you today">No reminders due, nothing overdue and no deadlines this week on things you decided to act on.</EmptyState></div>;
  return (
    <div className="mt-8 max-w-2xl space-y-6">
      <h2 className="font-display text-2xl font-medium">{b.message.title}</h2>
      <div className="rounded-3xl border-2 border-line/80 bg-card p-5">
        <ul className="space-y-1 text-[15px]">
          {b.message.lines.map((l, i) => (
            <li key={i} className={l.startsWith("  ") ? "pl-4 text-ink-soft" : "pt-3 font-medium first:pt-0"}>{l.replace(/^ {2}• /, "• ")}</li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          {b.message.links.map((l) => (
            <Link key={l.href + l.label} className="font-medium underline underline-offset-4" href={l.href}>{l.label}</Link>
          ))}
        </div>
      </div>
      {ideas.length > 0 && (
        <ul className="space-y-2 text-sm">
          {ideas.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-2"><span>{s.text}</span><HideSuggestion k={s.key} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
