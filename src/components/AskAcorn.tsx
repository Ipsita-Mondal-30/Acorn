"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AnswerResult } from "@/lib/answer";
import { api, errorMessage } from "./api";
import { buttonClass } from "./ui";

/**
 * An answer to the question, written only from the user's own memories, with the words it rests on and a link to each.
 * In demo mode it runs on its own (free, deterministic). With a real model it waits for a click, because each answer is a paid call.
 */
export function AskAcorn({ q, auto }: { q: string; auto: boolean }) {
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<AnswerResult>("/api/search/answer", { method: "POST", body: { q } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // the page keys this component by the question, so a new question is a fresh instance with empty state
  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void ask();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per instance
  }, [auto]);

  return (
    <section aria-labelledby="answer" className="mt-8 rounded-3xl border-2 border-line/80 bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="answer" className="text-xs font-medium tracking-wide text-ink-faint uppercase">Answer from your memories</h2>
        {!auto && (
          <button type="button" disabled={busy} onClick={ask} className={buttonClass.secondary}>
            {busy ? "Thinking…" : result ? "Ask again" : "Ask Acorn"}
          </button>
        )}
      </div>
      <div role="status" aria-live="polite" className="mt-3">
        {busy && !result && <p className="text-sm text-ink-soft">Looking through what you saved…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {!auto && !result && !busy && !error && <p className="text-sm text-ink-soft">Uses your saved memories only. Each answer is one model call.</p>}
        {result && (
          <div className="space-y-4">
            {result.by?.provider === "mock" && (
              <p className="rounded-xl border border-amber/40 bg-amber-soft px-3 py-2 text-sm text-amber-ink">
                <strong className="font-semibold">Demo answer (mock, no AI model).</strong> Built from your saved facts by simple rules.
              </p>
            )}
            <p className={`text-[16px] leading-relaxed ${result.noReliableMatch ? "text-ink-soft" : ""}`}>
              {result.noReliableMatch && <span className="mr-2 rounded-full bg-paper-deep px-2 py-0.5 text-xs font-semibold text-ink-soft">No reliable match</span>}
              {result.answer}
            </p>
            {result.citations.length > 0 && (
              <ul className="space-y-2">
                {result.citations.map((c, i) => (
                  <li key={i}>
                    <blockquote className="border-l-2 border-line pl-3 font-display text-[15px] text-ink-soft italic">&ldquo;{c.quote}&rdquo;</blockquote>
                    <Link href={`/memories/${c.memoryId}`} className="mt-1 inline-block text-sm font-medium text-moss-ink underline underline-offset-4">
                      {c.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {result.droppedCitations > 0 && (
              <p className="text-xs text-ink-faint">{result.droppedCitations} quote(s) the model offered weren&apos;t in your saved memory, so they were left out.</p>
            )}
            {result.matches.length > 0 && (
              <details className="text-sm text-ink-soft">
                <summary className="cursor-pointer font-medium hover:text-ink">Why these memories ({result.matches.length})</summary>
                <ul className="mt-2 space-y-1.5">
                  {result.matches.map((m) => (
                    <li key={m.memoryId}>
                      <Link href={`/memories/${m.memoryId}`} className="font-medium text-ink underline underline-offset-4">{m.title}</Link>
                      <span className="text-ink-faint"> — {m.reasons.join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {result.by && (
              <p className="text-xs text-ink-faint">
                {result.by.provider === "mock" ? "Demo rules" : "Meta"} · {result.by.model}
                {result.by.latencyMs !== undefined && ` · ${(result.by.latencyMs / 1000).toFixed(1)}s`}
                {result.by.usage?.estimatedCostUsd != null && ` · about $${result.by.usage.estimatedCostUsd.toFixed(4)}`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
