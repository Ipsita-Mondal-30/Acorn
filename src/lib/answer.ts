import "server-only";
import { answerValidated, getProvider, type AiProvider } from "./ai/provider";
import { digestOf } from "./digest";
import { searchMemories } from "./search";
import { effective, type Memory, type Usage } from "./schema";

// "Answer from my memories": retrieve first, then let the provider write an answer using ONLY what was retrieved,
// then check every citation against the saved memory. An answer with no citation that survives is not an answer.

export type AnswerResult = {
  answer: string;
  /** true when nothing reliable backs an answer. Say so; never invent a memory. */
  noReliableMatch: boolean;
  citations: { memoryId: string; title: string; quote: string }[];
  /** the retrieved memories and why each matched (the user can inspect these) */
  matches: { memoryId: string; title: string; reasons: string[]; score: number }[];
  /** citations the model gave that were not in the saved memory, so were dropped */
  droppedCitations: number;
  /** null when no model was called (nothing was retrieved) */
  by: { provider: "mock" | "meta"; model: string; latencyMs?: number; usage?: Usage } | null;
};

const MAX_MATCHES = 5;
const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").trim();

export const NO_MATCH = "I couldn't find a saved memory that matches that, so I won't guess.";

export async function answerQuestion(
  question: string,
  memories: Memory[],
  opts: { now?: Date; fts?: Map<string, number>; semantic?: Map<string, number>; semanticWeight?: number; keywordWeight?: number; provider?: AiProvider } = {},
): Promise<AnswerResult> {
  const now = opts.now ?? new Date();
  // A memory that only fits the query's TYPE ("technical") but contains none of its specific words ("Redis") is a
  // weak lead for a search list, not a reliable basis for an answer.
  const hits = searchMemories(memories, question, now, { fts: opts.fts, semantic: opts.semantic, semanticWeight: opts.semanticWeight, keywordWeight: opts.keywordWeight })
    // and with three or more specific words, one stray generic hit ("return" in "my tax return for 2019") isn't enough
    .filter((h) => h.semantic !== undefined || h.termsTotal === 0 || h.termsMatched >= (h.termsTotal >= 3 ? Math.ceil(h.termsTotal / 2) : 1))
    .slice(0, MAX_MATCHES);
  const matches = hits.map((h) => ({ memoryId: h.memory.id, title: effective(h.memory).title, reasons: h.reasons, score: h.score }));
  // no retrieval, no model call: nothing to ground an answer in, and nothing to pay for
  if (!hits.length) return { answer: NO_MATCH, noReliableMatch: true, citations: [], matches, droppedCitations: 0, by: null };

  const provider = opts.provider ?? getProvider();
  const digests = hits.map((h) => digestOf(h.memory));
  const { data, usage, latencyMs } = await answerValidated(provider, { question, memories: digests, now });
  const by = { provider: provider.name, model: provider.model, latencyMs, usage };

  const byId = new Map(digests.map((d) => [d.id, d]));
  const corpus = (id: string) => {
    const d = byId.get(id);
    return d ? norm([d.title, d.summary, d.sourceText, ...d.entities, ...d.facts.flatMap((f) => [f.statement, f.quote ?? ""])].join("\n")) : null;
  };
  const citations = data.citations.flatMap((c) => {
    const text = corpus(c.memoryId);
    return text && text.includes(norm(c.quote)) ? [{ memoryId: c.memoryId, title: byId.get(c.memoryId)!.title, quote: c.quote }] : [];
  });
  const droppedCitations = data.citations.length - citations.length;

  if (data.noReliableMatch) return { answer: data.answer, noReliableMatch: true, citations: [], matches, droppedCitations, by };
  if (!citations.length) {
    // the model made claims it couldn't back with the memory's own words
    return { answer: "I found some saved items that might be related, but I can't back an answer with their own words, so I won't claim one.", noReliableMatch: true, citations: [], matches, droppedCitations, by };
  }
  return { answer: data.answer, noReliableMatch: false, citations, matches, droppedCitations, by };
}
