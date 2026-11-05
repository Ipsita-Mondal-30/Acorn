"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "./api";
import type { Memory } from "@/lib/schema";

type SampleInfo = { id: string; label: string; blurb: string; kind: string };

/** Demo mode only: run one of the built-in (fictional) inputs through the real capture pipeline. */
export function SamplePicker({ samples }: { samples: SampleInfo[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string) {
    setBusy(id);
    setError(null);
    try {
      const { memory } = await api<{ memory: Memory; created: boolean }>("/api/samples", { method: "POST", body: { id } });
      router.push(`/memories/${memory.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="samples" className="mt-8 rounded-3xl border border-dashed border-line bg-paper-deep/60 p-5 sm:p-6">
      <h2 id="samples" className="font-display text-2xl">Try a sample</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Fictional examples saved through the real pipeline: the original is stored, then read by the <strong>demo reader</strong> (not
        an AI model). It only recognises these exact files; any other screenshot or PDF is saved but not read until Meta mode is on.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {samples.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run(s.id)}
              className="h-full w-full rounded-2xl border border-line bg-card p-3 text-left transition-colors hover:border-moss/60 disabled:opacity-60"
            >
              <span className="block text-sm font-medium">{busy === s.id ? "Saving…" : s.label}</span>
              <span className="mt-0.5 block text-sm text-ink-soft">{s.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
