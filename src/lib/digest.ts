import type { MemoryDigest } from "./ai/provider";
import { effective, type Memory } from "./schema";

/** A memory reduced to what a model needs. The user's confirmed intent is included; Acorn's own guess is not. */
export function digestOf(m: Memory, maxText = 2_000): MemoryDigest {
  const v = effective(m);
  return {
    id: m.id,
    title: v.title,
    contentType: v.contentType,
    createdAt: m.createdAt,
    summary: v.summary,
    facts: v.facts.map((f) => ({ statement: f.statement, quote: f.quote })),
    entities: m.extraction?.entities.map((e) => e.name) ?? [],
    deadline: v.deadline,
    userIntent: v.intentKind,
    sourceUrl: m.source.url ?? null,
    sourceText: (m.source.text ?? "").slice(0, maxText),
  };
}
