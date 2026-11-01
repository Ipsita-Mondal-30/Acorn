import "server-only";
import { z } from "zod";
import { getEnv, type Env } from "../env";
import { AiError } from "./errors";
import { recordCall } from "./usage";

// Embeddings turn text into vectors so "citrus pasta" can find "lemon pasta". Meta's Model API documents no
// embedding model or endpoint (dev.meta.ai/docs lists chat, responses, messages, images, voice, files, models), so
// nothing here is tied to Meta and nothing is invented: EMBEDDING_PROVIDER=none (the default) means "not available",
// and search simply stays keyword-only. "http" speaks the OpenAI-compatible POST {base}/embeddings protocol and has
// NOT been verified against a real service yet.

export interface EmbeddingProvider {
  /** "http" for a real service; tests inject their own deterministic provider. */
  name: string;
  model: string;
  /** One vector per input, in order. Throws AiError on any failure. */
  embed(texts: string[]): Promise<number[][]>;
}

const EmbedResponse = z.object({
  data: z.array(z.object({ index: z.number().int().optional(), embedding: z.array(z.number().refine(Number.isFinite)).min(1) })),
  usage: z.object({ prompt_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional(),
});

export const EMBED_TIMEOUT_MS = 30_000;
const MAX_BATCH = 64;
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([429, 500, 502, 503]);

/** Why semantic search is or isn't available, with no network call. Never includes the key. */
export function embeddingStatus(env: Env = getEnv()): { configured: boolean; reason: string; model: string | null } {
  if (env.EMBEDDING_PROVIDER === "none") {
    return { configured: false, reason: "No embedding provider is configured (EMBEDDING_PROVIDER=none). Search uses keywords only.", model: null };
  }
  const missing = (["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"] as const).filter((k) => !env[k]);
  if (missing.length) return { configured: false, reason: `EMBEDDING_PROVIDER=http but ${missing.join(", ")} is not set.`, model: null };
  if (env.AI_ENABLE_REAL_CALLS !== "true") {
    return { configured: false, reason: "Embeddings are paid calls; set AI_ENABLE_REAL_CALLS=true to allow them.", model: env.EMBEDDING_MODEL ?? null };
  }
  return { configured: true, reason: "Embedding provider configured (not verified by this check).", model: env.EMBEDDING_MODEL ?? null };
}

/** The configured provider, or null when semantic search isn't available. Never falls back to a fake. */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const env = getEnv();
  if (!embeddingStatus(env).configured) return null;
  const { EMBEDDING_BASE_URL: base, EMBEDDING_API_KEY: key, EMBEDDING_MODEL: model, EMBEDDING_DIMENSIONS: dimensions } = env;
  return {
    name: "http",
    model: model!,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        let res: Response | null = null;
        for (let attempt = 1; ; attempt++) {
          try {
            res = await fetch(`${base}/embeddings`, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model, input: batch, ...(dimensions ? { dimensions } : {}) }),
              signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
            });
          } catch (e) {
            recordCall(undefined, false);
            const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
            if (timedOut) throw new AiError("The embedding service timed out.", "timeout");
            if (attempt >= MAX_ATTEMPTS) throw new AiError("Could not reach the embedding service.", "network");
            await new Promise((r) => setTimeout(r, env.ACORN_RETRY_BASE_MS * 2 ** (attempt - 1)));
            continue;
          }
          if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
            void res.body?.cancel().catch(() => {});
            await new Promise((r) => setTimeout(r, env.ACORN_RETRY_BASE_MS * 2 ** (attempt - 1)));
            continue;
          }
          break;
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          recordCall(undefined, false);
          throw new AiError(
            res.status === 401 || res.status === 403 ? "The embedding service rejected the API key." : `The embedding service failed (HTTP ${res.status}).`,
            res.status === 401 || res.status === 403 ? "auth" : "unavailable",
          );
        }
        const parsed = EmbedResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success || parsed.data.data.length !== batch.length) {
          throw new AiError("The embedding service returned an unexpected shape.", "malformed");
        }
        const tokens = parsed.data.usage?.prompt_tokens ?? parsed.data.usage?.total_tokens;
        // price is unknown (no provider chosen), so cost stays null rather than a guess
        recordCall(tokens === undefined ? undefined : { promptTokens: tokens, completionTokens: 0, totalTokens: tokens, estimatedCostUsd: null }, true);
        const rows = [...parsed.data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const r of rows) {
          if (dimensions && r.embedding.length !== dimensions) throw new AiError("The embedding service returned vectors of the wrong size.", "malformed");
          out.push(r.embedding);
        }
      }
      if (out.some((v) => v.length !== out[0].length)) throw new AiError("The embedding service returned vectors of different sizes.", "malformed");
      return out;
    },
  };
}
