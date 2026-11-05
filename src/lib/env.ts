import "server-only";
import { z } from "zod";
import { ConfigError, readSupabaseConfig } from "./supabase/config";

const EnvSchema = z.object({
  ACORN_MODE: z.enum(["demo", "meta"]).default("demo"),
  META_API_KEY: z.string().optional(),
  META_API_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .default("https://api.meta.ai/v1")
    .transform((u) => u.replace(/\/+$/, "")),
  META_EXTRACTION_MODEL: z.string().min(1).default("muse-spark-1.3"),
  /** Paid calls are refused unless this is "true", even with AI_PROVIDER=meta and a key. */
  AI_ENABLE_REAL_CALLS: z.enum(["true", "false"]).default("false"),
  /** Separately configurable capabilities. Only the reasoning model is ever called, and only if META_REASONING_FOR_PLANS=true. */
  META_REASONING_MODEL: z.string().min(1).default("muse-wonder-1.0"),
  META_IMAGE_MODEL: z.string().min(1).default("muse-image-1.0"),
  META_TRANSCRIPTION_MODEL: z.string().min(1).default("muse-voice-transcribe-1.0"),
  META_SEGMENTATION_MODEL: z.string().min(1).default("sam-3.1"),
  ACORN_MAX_MODEL_CALLS: z.coerce.number().int().min(0).default(50),
  // Documented levels (dev.meta.ai/docs/reasoning). "none" is rejected by Muse Spark, so it is not offered.
  META_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  META_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  /** Optional different model for action plans (e.g. muse-wonder-1.0). Defaults to the extraction model. */
  META_PLAN_MODEL: z.string().min(1).optional(),
  /** Sent as json_schema.strict. The docs say output is schema-constrained either way; Acorn re-validates with Zod. */
  META_STRICT_SCHEMA: z.enum(["true", "false"]).default("false"),
  /** Attempts per request (1 = never retry). The default of 3 retries 429/500/503 with backoff; set 1 when every request is paid and counted. */
  META_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  ACORN_RETRY_BASE_MS: z.coerce.number().int().min(0).max(10_000).default(750),
  /**
   * Semantic search needs an embedding model. Meta's Model API documents none (dev.meta.ai/docs), so this is off
   * ("none") until you point it at an OpenAI-compatible /embeddings endpoint. Calls are paid, so they also need
   * AI_ENABLE_REAL_CALLS=true.
   */
  EMBEDDING_PROVIDER: z.enum(["none", "http"]).default("none"),
  EMBEDDING_BASE_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")).optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  /** Sent as `dimensions` when set (models that support shortening). Stored vectors are checked against it. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(4096).optional(),
  /**
   * Hybrid ranking knobs. UNCALIBRATED defaults: they were picked by hand against a test embedder, not measured with a
   * real model. Re-tune against an evaluation set (evals/) once an embedding provider is connected.
   */
  SEARCH_SEMANTIC_WEIGHT: z.coerce.number().min(0).max(100).default(10),
  SEARCH_KEYWORD_WEIGHT: z.coerce.number().min(0).max(100).default(1),
  /** Cosine similarity below which a vector match is ignored. Model-specific. */
  SEARCH_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.35),
  /** How many nearest memories the database returns for one query. */
  SEARCH_SEMANTIC_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  /**
   * Scheduled delivery. The scheduler (pg_cron, a platform cron, or curl) calls POST /api/cron/tick with
   * `Authorization: Bearer <CRON_SECRET>`. Unset means the endpoint doesn't exist.
   */
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be at least 32 characters").optional(),
  /** Real email is off unless this is "true", on top of EMAIL_PROVIDER: a second lock, like AI_ENABLE_REAL_CALLS. */
  NOTIFICATIONS_ENABLE_SENDING: z.enum(["true", "false"]).default("false"),
  EMAIL_PROVIDER: z.enum(["none", "resend"]).default("none"),
  EMAIL_API_KEY: z.string().optional(),
  /** The From address, e.g. "Acorn <reminders@yourdomain.com>" (must be a sender your provider has verified). */
  EMAIL_FROM: z.string().max(200).optional(),
  /** Public address of this app, used for links in emails. */
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** A reminder this many hours overdue when Acorn first looks at it is shown as overdue instead of announced. */
  NOTIFY_EXPIRY_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  /** Local (no accounts) mode only: where email goes. */
  NOTIFY_LOCAL_EMAIL: z.string().max(200).optional(),
  ACORN_DATA_DIR: z.string().min(1).default(".data"),
  ACORN_STORAGE: z.enum(["auto", "local", "supabase"]).default("auto"),
});
export type Env = z.infer<typeof EnvSchema>;

const read = (...names: string[]) => names.map((n) => process.env[n]?.trim()).find(Boolean);

/** Parsed on every call (cheap) so tests and restarts pick up process.env changes. */
export function getEnv(): Env {
  // empty strings (e.g. `META_API_KEY=` from .env.example) count as unset
  const raw: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(EnvSchema.shape).map((k) => [k, read(k)]),
  );
  // Canonical names first (AI_PROVIDER, META_BASE_URL, META_PRIMARY_MODEL); the original names still work.
  const provider = read("AI_PROVIDER");
  if (provider && !["mock", "meta", "demo"].includes(provider)) {
    throw new Error(`Invalid environment configuration:\nAI_PROVIDER must be "mock" or "meta" (got "${provider}").`);
  }
  if (provider) raw.ACORN_MODE = provider === "meta" ? "meta" : "demo";
  raw.META_API_BASE_URL = read("META_BASE_URL", "META_API_BASE_URL");
  raw.META_EXTRACTION_MODEL = read("META_PRIMARY_MODEL", "META_EXTRACTION_MODEL");
  // Wonder (about 3x the price) writes action plans only when asked to
  if (read("META_REASONING_FOR_PLANS") === "true") raw.META_PLAN_MODEL = read("META_REASONING_MODEL") ?? "muse-wonder-1.0";
  const r = EnvSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid environment configuration:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export function modeInfo(): { mode: "demo" | "meta"; metaConfigured: boolean; extractionModel: string; label: string } {
  const env = getEnv();
  const enabled = env.AI_ENABLE_REAL_CALLS === "true";
  const metaConfigured = Boolean(env.META_API_KEY) && enabled;
  const label =
    env.ACORN_MODE === "demo"
      ? "Demo mode — no model calls"
      : !env.META_API_KEY
        ? "Meta mode — key missing"
        : !enabled
          ? "Meta mode — real calls off"
          : `Meta mode — ${env.META_EXTRACTION_MODEL}`;
  return { mode: env.ACORN_MODE, metaConfigured, extractionModel: env.META_EXTRACTION_MODEL, label };
}

export type StorageMode = "local" | "supabase";

/**
 * Where data lives. "auto" (default): Supabase when its URL + anon key are configured, otherwise the local
 * demo store. A half-configured Supabase setup throws instead of silently falling back to local files.
 * ACORN_STORAGE=local forces the demo store (e.g. offline development); =supabase insists on the cloud.
 */
export function storageMode(): StorageMode {
  const { ACORN_STORAGE } = getEnv();
  if (ACORN_STORAGE === "local") return "local";
  const configured = readSupabaseConfig() !== null;
  if (ACORN_STORAGE === "supabase" && !configured) {
    throw new ConfigError("ACORN_STORAGE=supabase but NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.");
  }
  return configured ? "supabase" : "local";
}
