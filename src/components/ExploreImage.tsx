"use client";

import { useState } from "react";
import type { Artifact, RegionReadingOutput, SegmentationOutput } from "@/lib/artifacts";
import { Aiko } from "./Aiko";
import { api } from "./api";
import { useMutation } from "./MemoryControls";
import { ModelNote } from "./ModelNote";
import { buttonClass, fieldClass, Tag } from "./ui";

// Explore image: SAM 3.1 says WHERE something is (boxes drawn over the ORIGINAL image, which is never altered); Muse Spark
// reads the region the user picks; the user decides whether to keep that reading as a linked memory.

const EXAMPLES = ["the deadline", "the company logo", "the ingredients list", "the architecture diagram"];

export function ExploreImage({ memoryId, imageUrl, segmentations, readings, real }: { memoryId: string; imageUrl: string; segmentations: Artifact[]; readings: Artifact[]; real: boolean }) {
  const m = useMutation();
  const [target, setTarget] = useState("");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const busy = m.pending;
  return (
    <section aria-labelledby="explore-heading" data-testid="explore-image">
      <h2 id="explore-heading" className="font-display text-2xl">Explore image</h2>
      <p className="mt-1 text-[15px] text-ink-soft">
        Describe one thing to find. SAM 3.1 only marks <em>where</em> it is; it doesn&apos;t know what it means. Pick a region and Muse Spark can read it for you.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (target.trim()) m.run(() => api(`/api/memories/${memoryId}/explore`, { method: "POST", body: { target }, timeoutMs: 120_000 }), () => setTarget(""));
        }}
      >
        <label htmlFor="explore-target" className="sr-only">What to find in the image</label>
        <input id="explore-target" value={target} onChange={(e) => setTarget(e.target.value)} maxLength={120} placeholder="e.g. the deadline" className={`${fieldClass} min-w-0 flex-1`} />
        <button type="submit" disabled={busy || !target.trim()} className={buttonClass.primary}>{busy ? "Looking…" : "Find it"}</button>
      </form>
      <p className="mt-2 flex flex-wrap gap-1.5 text-xs text-ink-faint">
        Try:
        {EXAMPLES.map((x) => (
          <button key={x} type="button" onClick={() => setTarget(x)} className="rounded-full bg-paper-deep px-2.5 py-0.5 font-bold text-ink-soft hover:bg-moss-soft">{x}</button>
        ))}
      </p>
      <p className="mt-1 text-xs text-ink-faint">{real ? "Uses Meta SAM 3.1 ($2.50 per 1,000 images) and Muse Spark." : "Demo mode only finds regions in Acorn's built-in sample screenshots (fixture boxes, no model call)."}</p>
      {busy && (
        <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-ink-soft" role="status"><Aiko mood="curious" size={56} /> Looking closely…</p>
      )}
      {m.error && <p role="alert" className="mt-3 rounded-2xl bg-danger-soft px-3 py-2 text-sm text-danger">{m.error}</p>}

      <ul className="mt-4 space-y-5">
        {segmentations.map((a) => {
          const out = a.output as Partial<SegmentationOutput>;
          const regions = out.regions ?? [];
          const frame = out.frame && out.frame.w > 0 ? out.frame : null;
          const sel = picked[a.id];
          const mine = readings.filter((r) => r.parentId === a.id);
          return (
            <li key={a.id} className="rounded-3xl border-2 border-line bg-card p-4">
              <p className="font-semibold">Looking for “{String(a.input.target ?? out.target ?? "")}”</p>
              {a.status === "failed" && (
                <p role="alert" className="mt-2 rounded-2xl bg-danger-soft px-3 py-2 text-sm text-danger">
                  Couldn&apos;t explore the image: {a.error?.message}{" "}
                  <button type="button" disabled={busy} onClick={() => m.run(() => api(`/api/artifacts/${a.id}`, { method: "POST", body: { op: "retry" }, timeoutMs: 120_000 }))} className="font-bold underline underline-offset-4">Try again</button>
                </p>
              )}
              {a.status === "ready" && regions.length === 0 && (
                <p className="mt-2 rounded-2xl bg-butter-soft px-3 py-2 text-sm text-butter-ink">
                  Nothing matched that description. {out.note ?? "SAM looks for one concrete thing at a time (like “the deadline” or “a logo”), so try a shorter, simpler phrase."}
                </p>
              )}
              {a.status === "ready" && regions.length > 0 && frame && (
                <>
                  <div className="relative mt-3 overflow-hidden rounded-2xl border border-line">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the saved original, unchanged; boxes are drawn over it */}
                    <img src={imageUrl} alt="Your saved image with the found regions outlined" className="block w-full" />
                    {regions.map((r, i) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-label={`Region ${i + 1}${r.confidence !== null ? `, ${Math.round(r.confidence * 100)}% confident` : ""}`}
                        aria-pressed={sel === r.id}
                        onClick={() => setPicked((p) => ({ ...p, [a.id]: r.id }))}
                        className={`absolute rounded-md border-[3px] transition ${sel === r.id ? "border-moss bg-moss/25" : "border-amber bg-amber/10 hover:bg-amber/25"}`}
                        style={{ left: `${(r.box.x1 / frame.w) * 100}%`, top: `${(r.box.y1 / frame.h) * 100}%`, width: `${((r.box.x2 - r.box.x1) / frame.w) * 100}%`, height: `${((r.box.y2 - r.box.y1) / frame.h) * 100}%` }}
                      >
                        <span className="absolute -top-0.5 -left-0.5 rounded-br-md bg-ink px-1.5 text-[11px] font-bold text-paper">{i + 1}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-ink-faint">
                    {regions.length} {regions.length === 1 ? "region" : "regions"} found. Boxes only: Acorn doesn&apos;t draw or decode the masks. Your original image is unchanged.
                  </p>
                  <button type="button" disabled={busy || sel === undefined} onClick={() => m.run(() => api(`/api/artifacts/${a.id}`, { method: "POST", body: { op: "interpret", regionId: sel }, timeoutMs: 90_000 }))} className={`${buttonClass.secondary} mt-2`}>
                    {sel === undefined ? "Pick a region to read" : "Read this region with Muse Spark"}
                  </button>
                </>
              )}
              <div className="mt-2"><ModelNote a={a} label="Regions" /></div>
              {out.note && <p className="mt-1 text-xs text-ink-faint">{out.note}</p>}

              {mine.map((r) => {
                const ro = r.output as Partial<RegionReadingOutput>;
                return (
                  <div key={r.id} className="mt-3 rounded-2xl border-2 border-lav/30 bg-lav-soft/40 p-3">
                    {r.status === "failed" ? (
                      <p role="alert" className="text-sm text-danger">Couldn&apos;t read that region: {r.error?.message}</p>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-2 text-xs"><Tag tone="amber">AI-read, not verified</Tag><ModelNote a={r} label="Reading" /></div>
                        <p className="mt-2 text-[15px]">{ro.reading}</p>
                        {ro.quote && <blockquote className="mt-1 border-l-2 border-line pl-3 font-display text-[15px] text-ink-soft italic">“{ro.quote}”</blockquote>}
                        {ro.note && <p className="mt-1 text-xs text-ink-faint">{ro.note}</p>}
                        {r.confirmedMemoryId ? (
                          <p className="mt-2 text-sm font-semibold text-moss-ink">Saved as a linked memory. <a className="underline underline-offset-4" href={`/memories/${r.confirmedMemoryId}`}>Open it</a></p>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => m.run(() => api(`/api/artifacts/${r.id}`, { method: "POST", body: { op: "confirm" } }))} className={`${buttonClass.primary} mt-2`}>
                            Save as a linked memory
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <button type="button" disabled={busy} onClick={() => m.run(() => api(`/api/artifacts/${a.id}`, { method: "DELETE" }))} className="mt-2 text-sm text-ink-faint underline underline-offset-4">Remove this search</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
