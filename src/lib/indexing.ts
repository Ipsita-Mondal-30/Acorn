import "server-only";
import { embeddingStatus, getEmbeddingProvider, type EmbeddingProvider } from "./ai/embeddings";
import { AiError } from "./ai/errors";
import type { Memory } from "./schema";
import { getEnv } from "./env";
import { embeddingHash, embeddingText, validVector } from "./semantic";
import { embeddingHashes, listMemories, saveEmbedding, similarMemories } from "./store";

// Embedding generation and semantic scoring. Everything goes through the signed-in user's store, so another
// user's memories or vectors are never read. A failure here never breaks search: callers fall back to keywords.

export type IndexReport = {
  /** false when no embedding provider is available; nothing was attempted */
  available: boolean;
  reason?: string;
  total: number;
  embedded: number;
  upToDate: number;
  failed: number;
};

const BATCH = 16;

/** Embed every memory that has no vector yet, or whose text changed since. Safe to run again after a failure. */
export async function indexMissing(opts: { provider?: EmbeddingProvider | null; memories?: Memory[] } = {}): Promise<IndexReport> {
  const provider = opts.provider === undefined ? getEmbeddingProvider() : opts.provider;
  const memories = opts.memories ?? (await listMemories());
  if (!provider) return { available: false, reason: embeddingStatus().reason, total: memories.length, embedded: 0, upToDate: 0, failed: 0 };

  const stored = await embeddingHashes(provider.model);
  const todo: { memory: Memory; text: string; hash: string }[] = [];
  let upToDate = 0;
  for (const memory of memories) {
    if (memory.status !== "ready" && memory.status !== "failed") continue; // still being processed; its text isn't final
    const text = embeddingText(memory);
    if (!text.trim()) continue;
    const hash = embeddingHash(provider.model, text);
    if (stored.get(memory.id) === hash) upToDate++;
    else todo.push({ memory, text, hash });
  }

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const vectors = await provider.embed(batch.map((b) => b.text));
      if (vectors.length !== batch.length) throw new AiError("The embedding service returned the wrong number of vectors.", "malformed");
      for (let j = 0; j < batch.length; j++) {
        // never store a vector pgvector can't use (empty, NaN, all zeros): count it as a failure so a retry tries again
        if (!validVector(vectors[j])) failed++;
        else if (await saveEmbedding(batch[j].memory.id, { provider: provider.name, model: provider.model, vector: vectors[j], sourceHash: batch[j].hash })) embedded++;
        else failed++;
      }
    } catch (e) {
      failed += batch.length;
      console.error(`[embeddings] batch of ${batch.length} failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }
  return { available: true, total: memories.length, embedded, upToDate, failed };
}

/** Best-effort: embed one memory right after it was understood. Never throws. */
export async function indexMemory(memory: Memory, provider: EmbeddingProvider | null = getEmbeddingProvider()): Promise<void> {
  if (!provider) return;
  try {
    await indexMissing({ provider, memories: [memory] });
  } catch (e) {
    console.error(`[embeddings] memory=${memory.id} failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}

/** The hybrid-ranking settings, from the environment. Defaults are uncalibrated; see env.ts. */
export function searchTuning() {
  const env = getEnv();
  return {
    semanticWeight: env.SEARCH_SEMANTIC_WEIGHT,
    keywordWeight: env.SEARCH_KEYWORD_WEIGHT,
    minSimilarity: env.SEARCH_MIN_SIMILARITY,
    limit: env.SEARCH_SEMANTIC_LIMIT,
  };
}

export type SemanticResult = {
  /** memory id -> cosine similarity, best first (only those at or above the threshold, at most `limit`) */
  scores: Map<string, number>;
  /** "off": no provider; "failed": the query couldn't be embedded or searched; "ok" */
  status: "off" | "ok" | "failed";
  /** memories that have no current vector, so semantic search can't see them (keywords still do) */
  unindexed: number;
};

/**
 * Similarity of the query to the user's memories, ranked by the database (pgvector) or the local store.
 * Never throws: on any failure search falls back to keywords only.
 */
export async function semanticScores(
  query: string,
  memories: Memory[],
  opts: { provider?: EmbeddingProvider | null; minSimilarity?: number; limit?: number } = {},
): Promise<SemanticResult> {
  const provider = opts.provider === undefined ? getEmbeddingProvider() : opts.provider;
  if (!provider) return { scores: new Map(), status: "off", unindexed: 0 };
  try {
    const tuning = searchTuning();
    const [qv] = await provider.embed([query.slice(0, 500)]);
    if (!qv || !validVector(qv)) throw new Error("the query embedding is empty or invalid");
    const hashes = await embeddingHashes(provider.model);
    const found = await similarMemories(provider.model, qv, { limit: opts.limit ?? tuning.limit, minSimilarity: opts.minSimilarity ?? tuning.minSimilarity });
    const mine = new Set(memories.map((m) => m.id)); // only memories this request is already allowed to show
    const scores = new Map([...found].filter(([id]) => mine.has(id)).map(([id, sim]) => [id, Math.round(sim * 1000) / 1000] as const));
    return { scores, status: "ok", unindexed: memories.filter((m) => !hashes.has(m.id)).length };
  } catch (e) {
    console.error(`[embeddings] semantic search unavailable: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    return { scores: new Map(), status: "failed", unindexed: 0 };
  }
}

/** The options searchMemories needs to blend in a semantic result. */
export const hybridOptions = (sem: SemanticResult) => {
  const t = searchTuning();
  return { semantic: sem.scores, semanticWeight: t.semanticWeight, keywordWeight: t.keywordWeight };
};
