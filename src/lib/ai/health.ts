import "server-only";
import { getEnv } from "../env";
import { embeddingStatus } from "./embeddings";
import { usageTotals } from "./usage";

// What the configuration says, and nothing else: reads env, never touches the network, never includes the key.

export type AiHealth = {
  provider: "mock" | "meta";
  /** "ready": a call would be sent. Anything else says what is missing. */
  status: "mock" | "ready" | "real-calls-disabled" | "key-missing";
  apiKeyPresent: boolean;
  realCallsEnabled: boolean;
  baseUrl: string;
  models: Record<"primary" | "reasoning" | "image" | "transcription" | "segmentation", { id: string; usedByAcorn: boolean }>;
  planModel: string;
  maxModelCalls: number;
  callsThisProcess: { calls: number; failures: number; estimatedCostUsd: number };
  /** semantic search: configured only with an embedding provider (Meta documents none) */
  embeddings: { configured: boolean; reason: string; model: string | null };
  note: string;
};

export function aiHealth(): AiHealth {
  const env = getEnv();
  const meta = env.ACORN_MODE === "meta";
  const apiKeyPresent = Boolean(env.META_API_KEY);
  const realCallsEnabled = env.AI_ENABLE_REAL_CALLS === "true";
  const status: AiHealth["status"] = !meta ? "mock" : !apiKeyPresent ? "key-missing" : !realCallsEnabled ? "real-calls-disabled" : "ready";
  const t = usageTotals();
  return {
    provider: meta ? "meta" : "mock",
    status,
    apiKeyPresent,
    realCallsEnabled,
    baseUrl: env.META_API_BASE_URL,
    models: {
      primary: { id: env.META_EXTRACTION_MODEL, usedByAcorn: true },
      reasoning: { id: env.META_REASONING_MODEL, usedByAcorn: Boolean(env.META_PLAN_MODEL) },
      image: { id: env.META_IMAGE_MODEL, usedByAcorn: false },
      transcription: { id: env.META_TRANSCRIPTION_MODEL, usedByAcorn: false },
      segmentation: { id: env.META_SEGMENTATION_MODEL, usedByAcorn: false },
    },
    planModel: env.META_PLAN_MODEL ?? env.META_EXTRACTION_MODEL,
    maxModelCalls: env.ACORN_MAX_MODEL_CALLS,
    callsThisProcess: { calls: t.calls, failures: t.failures, estimatedCostUsd: t.costUsd },
    embeddings: embeddingStatus(env),
    note:
      status === "mock"
        ? "Mock provider: no network calls, no cost."
        : status === "ready"
          ? "Configuration looks complete. This check made no model call; nothing was verified against Meta."
          : status === "key-missing"
            ? "AI_PROVIDER=meta but META_API_KEY is not set."
            : "AI_PROVIDER=meta and a key is set, but AI_ENABLE_REAL_CALLS is not true, so no paid request will be sent.",
  };
}
