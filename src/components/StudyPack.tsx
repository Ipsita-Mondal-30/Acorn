"use client";

import { useState } from "react";
import type { StudyPack as Pack, StudyProgress } from "@/lib/agent/study";
import { api } from "./api";
import { useMutation } from "./MemoryControls";
import { buttonClass } from "./ui";

// The learning pack: notes to read, flashcards to flip, questions to answer, exercises to do. Marking progress is the
// only thing you can change here, and it is saved on the plan (so it survives a reload and shows up on Home).

const mark = (planId: string, stepId: string, study: StudyProgress) => api(`/api/plans/${planId}`, { method: "POST", body: { op: "edit", stepId, edit: { study } } });

export function StudyPackView({ pack, planId, stepId, canMark }: { pack: Pack; planId: string; stepId: string; canMark: boolean }) {
  const m = useMutation();
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const known = pack.cards.filter((c) => c.status === "known").length;
  const review = pack.cards.filter((c) => c.status === "review").length;
  const answered = pack.questions.filter((q) => q.answered).length;
  const done = pack.exercises.filter((e) => e.done).length;
  const total = pack.cards.length + pack.questions.length + pack.exercises.length;
  const percent = Math.round(((known + answered + done) / total) * 100);

  return (
    <div className="mt-3 space-y-6">
      <p className="rounded-2xl bg-butter-soft px-3 py-2 text-xs text-butter-ink">
        Built from what this item says: nothing here comes from outside it, and no model wrote it. Quotes are the item&apos;s own words.
      </p>

      <div>
        <div className="flex items-center justify-between gap-3">
          <h4 className="font-display text-base">Your progress</h4>
          <span className="text-sm tabular-nums text-ink-soft">{percent}%</span>
        </div>
        <div role="meter" aria-label="Learning progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1 h-2 overflow-hidden rounded-full bg-paper-deep">
          <div className="h-full rounded-full bg-lav transition-all" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1 text-xs text-ink-faint" data-testid="study-progress">
          {known} of {pack.cards.length} cards known · {review} to review · {answered} of {pack.questions.length} questions answered · {done} of {pack.exercises.length} exercises done
        </p>
      </div>

      <section aria-label="Session plan">
        <h4 className="font-display text-base">How to study this</h4>
        <ol className="mt-2 space-y-1.5 text-sm">
          {pack.sessions.map((s, i) => (
            <li key={s.id}>
              <span className="text-ink-faint">{i + 1}. </span>
              <span className="font-medium">{s.title}.</span> <span className="text-ink-soft">{s.detail}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Revision notes">
        <h4 className="font-display text-base">Revision notes</h4>
        <ul className="mt-2 space-y-2 text-sm">
          {pack.notes.map((n) => (
            <li key={n.id}>
              {n.text}
              {n.quote && <span className="mt-0.5 block border-l-2 border-line pl-2 font-display text-ink-soft italic">“{n.quote}”</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Flashcards">
        <h4 className="font-display text-base">Flashcards</h4>
        <ul className="mt-2 grid gap-3 sm:grid-cols-2">
          {pack.cards.map((c) => {
            const open = flipped[c.id] ?? false;
            return (
              <li key={c.id} className="flex flex-col rounded-2xl border-2 border-lav/30 bg-lav-soft/40 p-4 text-sm">
                <p className="text-xs text-ink-faint">{c.cloze ? "Fill in the blank" : "Recall"}</p>
                <p className="mt-1 flex-1">{c.front}</p>
                {open && (
                  <div className="mt-2 border-t border-line/60 pt-2" data-testid="card-back">
                    <p className="font-medium">{c.back}</p>
                    {c.quote && <p className="mt-1 text-xs text-ink-soft">“{c.quote}”</p>}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" aria-expanded={open} className={buttonClass.quiet} onClick={() => setFlipped((f) => ({ ...f, [c.id]: !open }))}>
                    {open ? "Hide answer" : "Show answer"}
                  </button>
                  {canMark && (
                    <>
                      <button type="button" disabled={m.pending} aria-pressed={c.status === "known"} className={c.status === "known" ? buttonClass.primary : buttonClass.secondary} onClick={() => m.run(() => mark(planId, stepId, { cards: { [c.id]: "known" } }))}>
                        I knew it
                      </button>
                      <button type="button" disabled={m.pending} aria-pressed={c.status === "review"} className={c.status === "review" ? buttonClass.primary : buttonClass.secondary} onClick={() => m.run(() => mark(planId, stepId, { cards: { [c.id]: "review" } }))}>
                        Review again
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Practice questions">
        <h4 className="font-display text-base">Practice questions</h4>
        <p className="text-xs text-ink-faint">Answer in your own words. Acorn doesn&apos;t grade them; you tick them off.</p>
        <ul className="mt-2 space-y-2 text-sm">
          {pack.questions.map((q) => (
            <li key={q.id} className="flex items-start gap-2">
              {canMark ? (
                <input type="checkbox" id={`q-${stepId}-${q.id}`} checked={q.answered} disabled={m.pending} onChange={(e) => m.run(() => mark(planId, stepId, { questions: { [q.id]: e.target.checked } }))} className="mt-1 size-4 accent-moss" />
              ) : (
                <span aria-hidden="true">{q.answered ? "☑" : "☐"}</span>
              )}
              <label htmlFor={`q-${stepId}-${q.id}`}>{q.text}</label>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Exercises">
        <h4 className="font-display text-base">Exercises</h4>
        <ul className="mt-2 space-y-2 text-sm">
          {pack.exercises.map((e) => (
            <li key={e.id} className="flex items-start gap-2">
              {canMark ? (
                <input type="checkbox" id={`e-${stepId}-${e.id}`} checked={e.done} disabled={m.pending} onChange={(ev) => m.run(() => mark(planId, stepId, { exercises: { [e.id]: ev.target.checked } }))} className="mt-1 size-4 accent-moss" />
              ) : (
                <span aria-hidden="true">{e.done ? "☑" : "☐"}</span>
              )}
              <label htmlFor={`e-${stepId}-${e.id}`}>{e.text}</label>
            </li>
          ))}
        </ul>
      </section>
      <p role="status" aria-live="polite" className="text-sm">
        {m.pending && <span className="text-ink-soft">Saving…</span>}
        {m.error && <span className="text-danger">{m.error}</span>}
      </p>
    </div>
  );
}
