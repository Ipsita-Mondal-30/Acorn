import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AikoSays } from "@/components/Aiko";
import { formatDateTime } from "@/components/format";
import { CardSkeleton, EmptyState, Tag } from "@/components/ui";
import { modeInfo } from "@/lib/env";
import { listArtifacts, listMemories } from "@/lib/store";
import { usageRows, usageTotals } from "@/lib/usage-report";

export const metadata: Metadata = { title: "Meta model usage" };

export default function UsagePage() {
  return (
    <div className="space-y-8">
      <h1 className="sr-only">Meta model usage</h1>
      <AikoSays mood="reading" size={104} title="Meta model usage">
        Which model did what, how it went, and what it used. This only lists what Acorn stored, so it isn&apos;t your Meta bill. Demo stand-ins are never counted as Meta.
      </AikoSays>
      <Suspense fallback={<CardSkeleton />}>
        <Body />
      </Suspense>
    </div>
  );
}

const usd = (n: number | null) => (n === null ? "not priced" : `$${n.toFixed(4)}`);

async function Body() {
  await connection();
  const info = modeInfo();
  const [memories, artifacts] = await Promise.all([listMemories(), listArtifacts().catch(() => [])]);
  const rows = usageRows(memories, artifacts);
  const t = usageTotals(rows);
  return (
    <>
      <p className="rounded-2xl bg-paper-deep px-4 py-3 text-[15px]">
        Right now: <strong>{info.label}</strong>. {info.mode === "meta" ? "Real Meta calls are possible (they also need AI_ENABLE_REAL_CALLS=true)." : "No model is being called."}
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Meta requests that worked", String(t.metaCalls)],
          ["Meta requests that failed", String(t.metaFailed)],
          ["Meta tokens (in / out)", `${t.promptTokens.toLocaleString("en-US")} / ${t.completionTokens.toLocaleString("en-US")}`],
          ["Estimated list price", usd(t.costUsd)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl border-2 border-line bg-card p-3">
            <dt className="text-xs text-ink-faint">{k}</dt>
            <dd className="font-display text-xl">{v}</dd>
          </div>
        ))}
      </dl>
      {t.unpriced > 0 && <p className="text-sm text-ink-faint">{t.unpriced} Meta request(s) have no documented token price (speech and segmentation are billed per hour / per image), so they are left out of the estimate.</p>}
      {rows.length === 0 ? (
        <EmptyState mood="sleeping" title="No model activity yet">Save something and the model that read it will show up here.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-3xl border-2 border-line bg-card">
          <table className="w-full min-w-[44rem] text-left text-sm" data-testid="usage-table">
            <thead className="text-xs text-ink-faint uppercase">
              <tr>{["When", "What", "Model", "Status", "Time", "Tokens", "Notes"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-bold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-soft">{formatDateTime(r.at)}</td>
                  <td className="px-3 py-2"><Link className="font-semibold underline-offset-4 hover:underline" href={r.href}>{r.what}</Link><span className="block max-w-56 truncate text-xs text-ink-faint">{r.title}</span></td>
                  <td className="px-3 py-2">{r.provider === "meta" ? <Tag tone="lav">Meta {r.model}</Tag> : <Tag tone="amber">Demo · {r.model}</Tag>}</td>
                  <td className="px-3 py-2">{r.status === "ready" ? <Tag tone="moss">worked</Tag> : r.status === "failed" ? <Tag tone="danger">failed</Tag> : <Tag>working</Tag>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-soft">{r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} s` : "-"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-soft">{r.tokens ? `${r.tokens.prompt.toLocaleString("en-US")} / ${r.tokens.completion.toLocaleString("en-US")}` : "-"}</td>
                  <td className="px-3 py-2 text-ink-soft">{[r.attempts && r.attempts > 1 ? `${r.attempts} attempts` : null, r.error].filter(Boolean).join(" · ") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
