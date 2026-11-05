import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Aiko, type Mood } from "@/components/Aiko";
import { QuickCapture } from "@/components/CaptureForm";
import { MemoryCard } from "@/components/MemoryCard";
import { ProcessingWatcher } from "@/components/ProcessingWatcher";
import { CardSkeleton, EmptyState, SampleTag, SectionHeading } from "@/components/ui";
import { homeSections } from "@/lib/home";
import { listActions, listArtifacts, listDeliveries, listMemories, listPlans, listReminders } from "@/lib/store";
import { buildToday } from "@/lib/today";

// Home is organised around OUTCOMES: what needs you today, what is unfinished, what is waiting for your approval, what is
// coming up and what Acorn noticed. Every line is built from stored data (see lib/today.ts) and says why it is there.
// What you recently saved comes after, as context.

const PER_SECTION = 3;

async function load() {
  await connection();
  const now = new Date();
  const [memories, actions, plans, reminders, artifacts] = await Promise.all([
    listMemories(),
    listActions(),
    listPlans().catch(() => []),
    listReminders().catch(() => []),
    listArtifacts().catch(() => []),
  ]);
  return { now, memories, actions, plans, reminders, artifacts, today: buildToday({ memories, plans, reminders, artifacts, actions, now }) };
}

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section aria-labelledby="greeting">
        <Suspense fallback={<h1 id="greeting" className="font-display text-3xl">Hello!</h1>}>
          <Greeting />
        </Suspense>
        <div className="mt-5">
          <QuickCapture />
        </div>
      </section>
      <Suspense fallback={<CardSkeleton />}>
        <TodayBlocks />
      </Suspense>
    </div>
  );
}

/** Aiko says how the day looks, in numbers that come from the same data the lists below use. */
async function Greeting() {
  const { now, memories, today } = await load();
  const h = now.getHours();
  const part = h < 5 ? "Still up?" : h < 12 ? "Good morning!" : h < 18 ? "Good afternoon!" : "Good evening!";
  // only the person's own items are counted: built-in samples must not make the day look busier than it is
  const count = (id: string) => today.sections.find((s) => s.id === id)?.entries.filter((e) => !e.sample).length ?? 0;
  const waiting = count("waiting");
  const deadlines = count("deadlines");
  const learning = count("learning");
  let mood: Mood = "happy";
  let line = "What did you come across today?";
  if (memories.length === 0) {
    mood = "curious";
    line = "Nothing here yet. Want to save your first little discovery?";
  } else if (memories.some((m) => m.status === "pending" || m.status === "processing")) {
    mood = "reading";
    line = "I'm reading what you saved. Give me a moment.";
  } else if (waiting + deadlines + learning > 0) {
    mood = "encouraging";
    const bits = [
      waiting > 0 && `${waiting} ${waiting === 1 ? "thing is" : "things are"} waiting for you`,
      deadlines > 0 && `${deadlines} ${deadlines === 1 ? "deadline is" : "deadlines are"} coming up`,
      learning > 0 && `${learning} learning ${learning === 1 ? "session is" : "sessions are"} unfinished`,
    ].filter(Boolean);
    line = `${bits.join(", ")}. No rush, here's the list.`;
  } else {
    line = "All caught up. Save something, and I'll line up what to do with it.";
  }
  return (
    <div className="flex items-center gap-3 sm:gap-5">
      <Aiko mood={mood} size={132} className="shrink-0" />
      <div className="bubble bubble-left min-w-0 flex-1 rounded-3xl px-5 py-4">
        <h1 id="greeting" className="font-display text-2xl sm:text-3xl">{part}</h1>
        <p className="mt-1 text-[15px] text-ink-soft sm:text-base">{line}</p>
      </div>
    </div>
  );
}

async function TodayBlocks() {
  const { now, memories, actions, today } = await load();
  // optional: these tables come from later migrations, and the home page works without them
  const unread = (await listDeliveries({ unreadOnly: true, limit: 50 }).catch(() => [])).length;
  if (memories.length === 0) {
    return (
      <EmptyState mood="sleeping" title="Nothing here yet" action={{ href: "/capture", label: "Save your first little discovery" }}>
        Drop in a note, a link, a screenshot, a PDF or a voice note. I&apos;ll work out what it is and what you might want to do with it.
      </EmptyState>
    );
  }
  const { recent } = homeSections(memories, actions, now);
  const working = memories.filter((m) => m.status === "pending" || m.status === "processing");

  return (
    <div className="space-y-10">
      {working.length > 0 && <ProcessingWatcher stalled={working.filter((m) => m.status === "pending").map((m) => m.id)} />}
      {unread > 0 && (
        <p className="rounded-2xl bg-butter-soft p-3.5 text-[15px] text-butter-ink">
          {unread} unread {unread === 1 ? "notification" : "notifications"}. <Link className="font-medium underline underline-offset-4" href="/notifications">Open inbox</Link>
        </p>
      )}

      {today.empty ? (
        <section aria-labelledby="today-empty">
          <SectionHeading id="today-empty">Today with Acorn</SectionHeading>
          <p className="rounded-3xl border-2 border-line bg-card p-5 text-[15px] text-ink-soft">Nothing needs you today, and there are no deadlines or unfinished learning to carry over.</p>
        </section>
      ) : (
        <div className="space-y-8" data-testid="today-blocks">
          {today.sections.map((s) => (
            <section key={s.id} aria-labelledby={`h-${s.id}`}>
              <SectionHeading
                id={`h-${s.id}`}
                aside={s.entries.length === PER_SECTION ? <Link href="/today" className="text-sm font-bold text-moss-ink underline-offset-4 hover:underline">See all</Link> : undefined}
              >
                {s.heading}
              </SectionHeading>
              <ol className="divide-y divide-line/70 overflow-hidden rounded-3xl border-2 border-line/80 bg-card shadow-card">
                {s.entries.slice(0, PER_SECTION).map((e) => (
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
          <p className="text-sm"><Link href="/today" className="font-bold text-moss-ink underline underline-offset-4">Today with Acorn: everything in one place</Link></p>
        </div>
      )}

      <section aria-labelledby="recent">
        <SectionHeading id="recent" aside={<Link href="/memories" className="text-sm font-bold text-moss-ink underline-offset-4 hover:underline">All memories</Link>}>
          Recently saved
        </SectionHeading>
        <div className="grid gap-3">
          {recent.slice(0, 4).map((m) => (
            <MemoryCard key={m.id} memory={m} now={now} understood />
          ))}
        </div>
      </section>
    </div>
  );
}
