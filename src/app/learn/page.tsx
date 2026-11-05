import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AikoSays } from "@/components/Aiko";
import { CardSkeleton, EmptyState, SectionHeading, Tag } from "@/components/ui";
import { learningPlans } from "@/lib/home";
import { effective, INTENT_LABEL } from "@/lib/schema";
import { listMemories, listPlans } from "@/lib/store";

export const metadata: Metadata = { title: "Learn" };

export default function LearnPage() {
  return (
    <div className="space-y-8">
      <h1 className="sr-only">Learn</h1>
      <AikoSays mood="learning" size={112} title="Welcome to the study corner!">
        Things you want to learn live here, with their notes, flashcards and practice. Go at your own pace.
      </AikoSays>
      <Suspense fallback={<CardSkeleton />}>
        <Corner />
      </Suspense>
    </div>
  );
}

async function Corner() {
  await connection();
  const [memories, plans] = await Promise.all([listMemories(), listPlans().catch(() => [])]);
  const items = learningPlans(memories, plans);
  const planned = new Set(items.map((i) => i.memory.id));
  const waiting = memories.filter((m) => m.status === "ready" && effective(m).intentKind === "learn" && !planned.has(m.id));
  const active = items.filter((i) => i.plan.status !== "completed");
  const done = items.filter((i) => i.plan.status === "completed");

  if (items.length === 0 && waiting.length === 0) {
    return (
      <EmptyState mood="curious" title="Nothing to study yet" action={{ href: "/memories", label: "Pick something to learn" }}>
        Open a memory and tell me you want to learn it. I&apos;ll turn it into a little study pack.
      </EmptyState>
    );
  }
  return (
    <>
      {active.length > 0 && (
        <section aria-labelledby="active">
          <SectionHeading id="active">Keep going</SectionHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            {active.map(({ plan, memory, sp }) => (
              <Link key={plan.id} href={`/memories/${memory.id}#agent-heading`} className="lift block rounded-3xl border-2 border-lav/30 bg-lav-soft/50 p-5">
                <p className="font-display text-xl leading-snug">{effective(memory).title}</p>
                {sp ? (
                  <>
                    <div className="mt-3 h-3 overflow-hidden rounded-full bg-card" role="progressbar" aria-valuenow={sp.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Learning progress">
                      <div className="h-full rounded-full bg-lav transition-all" style={{ width: `${Math.max(sp.percent, 4)}%` }} />
                    </div>
                    <p className="mt-2 text-sm text-lav-ink">{sp.known} of {sp.cards} cards known · {sp.answered} of {sp.questions} questions · {sp.done} of {sp.exercises} exercises</p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-lav-ink">{plan.status === "awaiting_approval" ? "Your plan is waiting for your OK." : "Your plan is in progress."}</p>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}
      {waiting.length > 0 && (
        <section aria-labelledby="waiting">
          <SectionHeading id="waiting">Ready for a plan</SectionHeading>
          <ul className="grid gap-3">
            {waiting.map((m) => (
              <li key={m.id} className="lift relative rounded-3xl border-2 border-line bg-card p-4">
                <Link href={`/memories/${m.id}`} className="font-display text-lg after:absolute after:inset-0 after:content-['']">{effective(m).title}</Link>
                <p className="mt-1"><Tag tone="lav">{INTENT_LABEL.learn}</Tag> <span className="ml-1 text-sm text-ink-soft">Open it and make a study plan.</span></p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {done.length > 0 && (
        <section aria-labelledby="done">
          <SectionHeading id="done">We did it! One more thing remembered.</SectionHeading>
          <ul className="space-y-2">
            {done.map(({ memory }) => (
              <li key={memory.id}><Link href={`/memories/${memory.id}`} className="font-semibold text-moss-ink underline-offset-4 hover:underline">{effective(memory).title}</Link></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
