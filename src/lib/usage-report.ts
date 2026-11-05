import { ARTIFACT_LABEL, type Artifact } from "./artifacts";
import { effective, type Memory } from "./schema";

// What Acorn has STORED about model use: one row per memory reading and per artifact. It is built only from persisted
// provenance, so it never shows invented usage, and a demo stand-in is never counted as Meta.

export type UsageRow = {
  key: string;
  at: string;
  what: string;
  title: string;
  provider: "meta" | "mock";
  model: string;
  status: "ready" | "failed" | "processing";
  latencyMs: number | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  costUsd: number | null;
  attempts: number | null;
  error: string | null;
  href: string;
};

export function usageRows(memories: Memory[], artifacts: Artifact[]): UsageRow[] {
  const title = new Map(memories.map((m) => [m.id, effective(m).title]));
  const rows: UsageRow[] = [];
  for (const m of memories) {
    const p = m.extraction?.producedBy;
    if (p && !m.isSample) {
      rows.push({
        key: `m-${m.id}`, at: p.at, what: "Reading a memory", title: effective(m).title, provider: p.provider, model: p.model, status: "ready", latencyMs: p.latencyMs ?? null,
        tokens: p.usage ? { prompt: p.usage.promptTokens, completion: p.usage.completionTokens, total: p.usage.totalTokens } : null,
        costUsd: p.usage?.estimatedCostUsd ?? null, attempts: null, error: null, href: `/memories/${m.id}`,
      });
    } else if (m.status === "failed" && m.error) {
      rows.push({
        key: `m-${m.id}`, at: m.updatedAt, what: "Reading a memory", title: effective(m).title, provider: "meta", model: "-", status: "failed", latencyMs: null,
        tokens: null, costUsd: null, attempts: null, error: m.error.slice(0, 200), href: `/memories/${m.id}`,
      });
    }
  }
  for (const a of artifacts) {
    rows.push({
      key: `a-${a.id}`, at: a.updatedAt, what: ARTIFACT_LABEL[a.kind], title: (a.memoryId && title.get(a.memoryId)) || "Voice note not saved yet",
      provider: a.provider, model: a.model, status: a.status, latencyMs: a.latencyMs,
      tokens: a.usage ? { prompt: a.usage.promptTokens, completion: a.usage.completionTokens, total: a.usage.totalTokens } : null,
      costUsd: a.usage?.estimatedCostUsd ?? null, attempts: a.attempts, error: a.error ? `${a.error.kind}: ${a.error.message}` : null,
      href: a.memoryId ? `/memories/${a.memoryId}` : "/capture?kind=voice",
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export function usageTotals(rows: UsageRow[]) {
  const meta = rows.filter((r) => r.provider === "meta");
  return {
    metaCalls: meta.filter((r) => r.status === "ready").length,
    metaFailed: meta.filter((r) => r.status === "failed").length,
    demoRows: rows.filter((r) => r.provider === "mock").length,
    promptTokens: meta.reduce((n, r) => n + (r.tokens?.prompt ?? 0), 0),
    completionTokens: meta.reduce((n, r) => n + (r.tokens?.completion ?? 0), 0),
    costUsd: Math.round(meta.reduce((n, r) => n + (r.costUsd ?? 0), 0) * 1e6) / 1e6,
    unpriced: meta.filter((r) => r.status === "ready" && r.costUsd === null).length,
  };
}
