import "server-only";
import { classifyValidated, getProvider } from "./ai/provider";
import type { IntentClassification } from "./ai/outputs";
import { effective, type Memory } from "./schema";
import { getMemory, updateMemory } from "./store";

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").trim();

/**
 * Ask the provider for candidate reasons the user might have saved a memory. These are SUGGESTIONS: they replace
 * Acorn's earlier guess but never touch the user's own decision, and "stated" only survives if the user's own words say it.
 * Returns the question to put to the user when nothing in the item points to a purpose.
 */
export async function reclassifyIntent(id: string): Promise<{ memory: Memory; question: string | null } | null> {
  const memory = await getMemory(id);
  if (!memory) return null;
  const x = memory.extraction;
  if (!x) return { memory, question: "Acorn hasn't read this yet. Process it first, or tell Acorn why you saved it." };

  const v = effective(memory);
  const provider = getProvider();
  const text = [memory.source.text, ...v.facts.map((f) => f.statement)].filter(Boolean).join("\n");
  const { data } = await classifyValidated(provider, { kind: memory.source.kind, title: v.title, contentType: v.contentType, summary: v.summary, text, now: new Date() });

  const mine = norm(memory.source.text ?? "");
  const checked: IntentClassification["candidates"] = data.candidates.map((g) =>
    g.basis === "stated" && !(g.quote && mine.includes(norm(g.quote)))
      ? { ...g, basis: "inferred", quote: null, confidence: Math.min(g.confidence, 0.5) }
      : g,
  );
  const updated = await updateMemory(id, (m) =>
    m.extraction ? { ...m, extraction: { ...m.extraction, intentGuess: checked[0] ?? null, alternativeIntents: checked.slice(1, 4) } } : m,
  );
  return { memory: updated ?? memory, question: checked.length ? null : (data.question ?? "What did you want to do with this?") };
}
