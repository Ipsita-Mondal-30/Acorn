"use client";

import { useState } from "react";
import type { Artifact, VisualAidOutput } from "@/lib/artifacts";
import { Aiko } from "./Aiko";
import { api } from "./api";
import { ModelNote } from "./ModelNote";
import { useMutation } from "./MemoryControls";
import { buttonClass, Tag } from "./ui";

// A visual aid is drawn from the memory's own statements and is always labelled as AI-created. It is a learning
// illustration, never source evidence, and it is made only when the user asks.

export function VisualAidPanel({ memoryId, aids, ready, real }: { memoryId: string; aids: Artifact[]; ready: boolean; real: boolean }) {
  const m = useMutation();
  const [open, setOpen] = useState<string | null>(null);
  const busy = m.pending;
  return (
    <section aria-labelledby="visual-aid-heading" data-testid="visual-aid">
      <h2 id="visual-aid-heading" className="font-display text-2xl">Visual aid</h2>
      <p className="mt-1 text-[15px] text-ink-soft">
        Turn what you saved into a labelled picture to revise from. It&apos;s drawn only from this memory&apos;s own statements, and it is an AI illustration, not evidence.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={!ready || busy} onClick={() => m.run(() => api(`/api/memories/${memoryId}/visual-aid`, { method: "POST", timeoutMs: 150_000 }))} className={buttonClass.primary}>
          {busy ? "Aiko is drawing…" : aids.length ? "Make another" : "Create visual aid"}
        </button>
        <span className="text-xs text-ink-faint">{real ? "Uses Meta Muse Image (about $0.01 per picture)." : "Demo mode draws a simple diagram itself: no model call."}</span>
      </div>
      {!ready && <p className="mt-2 text-sm text-ink-soft">Available once Acorn has finished reading this memory.</p>}
      {busy && (
        <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-ink-soft" role="status">
          <Aiko mood="thinking" size={56} /> Give me a moment, this can take up to a minute or two…
        </p>
      )}
      {m.error && <p role="alert" className="mt-3 rounded-2xl bg-danger-soft px-3 py-2 text-sm text-danger">{m.error}</p>}
      <ul className="mt-4 space-y-4">
        {aids.map((a) => {
          const out = a.output as Partial<VisualAidOutput>;
          return (
            <li key={a.id} className="rounded-3xl border-2 border-lav/30 bg-card p-4">
              {a.status === "ready" && a.fileName && (
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element -- private, generated, served by our own route */}
                  <img src={`/api/files/${a.fileName}`} alt={`AI-created visual aid: ${out.title ?? "learning diagram"}`} className="w-full rounded-2xl border border-line bg-paper" />
                  <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <Tag tone="lav">AI-created illustration</Tag>
                    <Tag>Not source evidence</Tag>
                  </figcaption>
                </figure>
              )}
              {a.status === "failed" && (
                <div role="alert" className="rounded-2xl bg-danger-soft px-3 py-2 text-sm text-danger">
                  Couldn&apos;t make the picture: {a.error?.message}
                  <button type="button" disabled={busy} onClick={() => m.run(() => api(`/api/artifacts/${a.id}`, { method: "POST", body: { op: "retry" }, timeoutMs: 150_000 }))} className="ml-2 font-bold underline underline-offset-4">Try again</button>
                </div>
              )}
              {a.status === "processing" && <p className="text-sm text-ink-soft">Still working on this one…</p>}
              <div className="mt-2"><ModelNote a={a} /></div>
              {out.note && <p className="mt-1 text-xs text-ink-faint">{out.note}</p>}
              {out.basedOn && out.basedOn.length > 0 && (
                <div className="mt-2">
                  <button type="button" className="text-sm font-bold text-moss-ink underline underline-offset-4" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                    What it was drawn from
                  </button>
                  {open === a.id && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                      {out.basedOn.map((s) => <li key={s}>{s}</li>)}
                    </ul>
                  )}
                </div>
              )}
              <button type="button" disabled={busy} onClick={() => m.run(() => api(`/api/artifacts/${a.id}`, { method: "DELETE" }))} className="mt-2 text-sm text-ink-faint underline underline-offset-4">Remove</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
