import type { Usage } from "../schema";

// ponytail: per-process totals for logs and tests; they reset on restart. Persist if spend must be audited.
const totals = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedCalls: 0 };

export function recordCall(usage: Usage | undefined, ok: boolean) {
  totals.calls++;
  if (!ok) totals.failures++;
  if (!usage) return;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  if (usage.estimatedCostUsd === null) totals.unpricedCalls++;
  else totals.costUsd += usage.estimatedCostUsd;
}

export const usageTotals = () => ({ ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6 });
export const resetUsageTotals = () => Object.assign(totals, { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedCalls: 0 });
