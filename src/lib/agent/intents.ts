import { effective, INTENT_LABEL, type IntentKind, type IntentStatus, type Memory } from "../schema";
import type { Workflow } from "./schema";

// Intent suggestions, derived from what is already stored on a memory (extraction + the user's decision). Nothing here
// is a new source of truth and nothing is invented: every date carries its quote, every field comes from the extraction.

export type IntentSuggestion = {
  relatedMemoryId: string;
  kind: IntentKind;
  label: string;
  /** "suggested" = Acorn's guess, NOT the user's intention. Only confirmed/corrected/set mean the user decided. */
  status: IntentStatus;
  isSuggestion: boolean;
  basis: "stated" | "inferred" | "user";
  confidence: number | null;
  rationale: string;
  entities: { name: string; kind: string }[];
  /** only dates the item itself states, each with its supporting words */
  dates: { date: string; label: string; isDeadline: boolean; evidence: string }[];
  evidence: { quote: string; supports: string }[];
  nextSteps: string[];
  workflow: Workflow | null;
};

/** Which workflow can serve this memory, given the user's CONFIRMED intent. Null if the user hasn't decided or nothing fits. */
export function workflowFor(m: Memory): Workflow | null {
  const v = effective(m);
  if (!v.intentKind || m.status !== "ready" || !m.extraction) return null;
  if ((v.contentType === "job" || m.extraction.job) && (v.intentKind === "pursue" || v.intentKind === "do_later")) return "job_application";
  if (v.contentType === "recipe" && ["try", "do_later", "buy", "remember"].includes(v.intentKind)) return "recipe";
  return "followup";
}

export function intentSuggestion(m: Memory): IntentSuggestion | null {
  const x = m.extraction;
  if (!x) return null;
  const v = effective(m);
  const decided = v.intentKind !== null;
  const guess = v.suggestedIntent;
  const kind = v.intentKind ?? guess?.kind;
  if (!kind) return null;
  return {
    relatedMemoryId: m.id,
    kind,
    label: INTENT_LABEL[kind],
    status: v.intentStatus,
    isSuggestion: !decided,
    basis: decided ? "user" : (guess?.basis ?? "inferred"),
    confidence: decided ? null : (guess?.confidence ?? null),
    rationale: decided ? (v.intentNote ?? "You decided this.") : (guess?.rationale ?? ""),
    entities: x.entities.slice(0, 8),
    dates: x.dates.filter((d) => d.evidence.trim().length > 0),
    evidence: [...(guess?.quote ? [{ quote: guess.quote, supports: "intent" }] : []), ...x.evidence].slice(0, 6),
    nextSteps: x.nextActions.map((n) => n.label),
    workflow: workflowFor(m),
  };
}
