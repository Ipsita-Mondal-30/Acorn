import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AikoSays } from "@/components/Aiko";
import { CardSkeleton, EmptyState, SampleTag, SectionHeading } from "@/components/ui";
import { buildToday } from "@/lib/today";
import { listActions, listArtifacts, listMemories, listPlans, listReminders } from "@/lib/store";

export const metadata: Metadata = { title: "Today with Acorn" };

export default function TodayPage() {
  return (
    <div className="space-y-8">
      <h1 className="sr-only">Today with Acorn</h1>
      <AikoSays mood="encouraging" size={108} title="Today with Acorn">
        What could use you today, worked out from what you&apos;ve saved. Each line says why it&apos;s here, and nothing happens until you decide.
      </AikoSays>
      <Suspense fallback={<CardSkeleton />}>
        <Body />
      </Suspense>
    </div>
  );
}

async function Body() {
  await connection();
  const now = new Date();
  const [memories, plans, reminders, artifacts, actions] = await Promise.all([listMemories(), listPlans().catch(() => []), listReminders().catch(() => []), listArtifacts().catch(() => []), listActions().catch(() => [])]);
  const { sections, empty } = buildToday({ memories, plans, reminders, artifacts, actions, now });
  if (empty) {
    return (
      <EmptyState mood="sleeping" title="All quiet today" action={{ href: "/capture", label: "Save something" }}>
        Nothing is waiting on you. When you save something, I&apos;ll line up what to do with it here.
      </EmptyState>
    );
  }
  const anySample = sections.some((s) => s.entries.some((e) => e.sample));
  return (
    <div className="space-y-10">
      {anySample && (
        <p className="rounded-2xl bg-butter-soft px-4 py-3 text-[15px] text-butter-ink" data-testid="sample-note">
          Items tagged <strong>Sample</strong> come from Acorn&apos;s built-in demo data, not from anything you saved. Your own items are listed first.
        </p>
      )}
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`t-${s.id}`}>
          <SectionHeading id={`t-${s.id}`}>{s.heading}</SectionHeading>
          {s.hint && <p className="-mt-2 mb-3 text-sm text-ink-faint">{s.hint}</p>}
          <ol className="divide-y divide-line/70 overflow-hidden rounded-3xl border-2 border-line/80 bg-card shadow-card">
            {s.entries.map((e) => (
              <li key={e.key} className="relative p-4 sm:p-5">
                <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-moss-ink uppercase">{e.verb}{e.sample && <SampleTag />}</p>
                <Link href={e.href} className="mt-1 block font-display text-lg leading-snug after:absolute after:inset-0 after:content-[''] hover:underline hover:underline-offset-4">{e.title}</Link>
                <p className="mt-0.5 text-[15px] text-ink-soft">{e.detail}</p>
                <p className="mt-1 text-xs text-ink-faint">Why: {e.why}</p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
