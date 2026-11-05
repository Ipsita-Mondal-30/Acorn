import "server-only";
import { type Env } from "../env";
import type { Usage } from "../schema";
import { AiError } from "./errors";
import { estimateCostUsd } from "./models";
import { recordCall } from "./usage";

// Meta Model API client: Chat Completions (https://dev.meta.ai/docs/protocols/chat-completions), Bearer auth.
// Only parameters the docs list as supported are sent: model, messages, response_format, max_completion_tokens,
// reasoning_effort. Retry rules follow https://dev.meta.ai/docs/error-handling: retry 429/500/503 with backoff
// (honouring Retry-After); never retry 400/401/402/403/404/413; a 504 means the same request will likely time out again.

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type ChatRequest = {
  model: string;
  system: string;
  user: ChatPart[];
  /** for logs only: "extract" | "intent" | "answer" | "plan" */
  purpose: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
};

export type ChatResult = { json: unknown; usage?: Usage; latencyMs: number; attempts: number };

const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 10_000;
const RETRYABLE = new Set([429, 500, 503]);

// ponytail: per-process counter; resets on restart. Persist it if the budget must survive restarts.
let callsMade = 0;
export const resetCallBudget = () => (callsMade = 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response | null, attempt: number, baseMs: number): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  }
  return Math.min(baseMs * 2 ** (attempt - 1) + Math.random() * Math.min(baseMs, 1000), MAX_RETRY_WAIT_MS);
}

/** Read only the machine-readable error code/type from an error body, never its message (it may echo our content). */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
    return String(body?.error?.code ?? body?.error?.type ?? "");
  } catch {
    return "";
  }
}

function fail(status: number, code: string, model: string): never {
  if (status === 401 || status === 403) throw new AiError(`Meta API rejected the API key or its access to this model (HTTP ${status}).`, "auth");
  if (status === 402) throw new AiError("Meta API reports a billing problem (HTTP 402). Check billing for this key's team.", "billing");
  if (status === 404 && /model/i.test(code)) throw new AiError(`The model "${model}" isn't available to this API key. Check META_PRIMARY_MODEL.`, "model_unavailable");
  if (status === 413) throw new AiError("The file is too large for the Meta API.", "too_large");
  if (status === 400 && /content_policy/i.test(code)) throw new AiError("Meta's safety filters blocked this request. Nothing was generated.", "bad_request");
  if (status === 400) throw new AiError("The model couldn't process this input (HTTP 400). The file may be corrupt, unsupported or too large.", "bad_request");
  if (status === 406 || status === 415 || status === 422) throw new AiError(`Meta API rejected the request format (HTTP ${status}).`, "bad_request");
  if (status === 504) throw new AiError("The model took too long to answer (HTTP 504). Try a smaller file or reprocess.", "timeout");
  if (status === 429) throw new AiError("Meta API rate limit hit. Try again in a minute.", "rate_limit");
  throw new AiError(`Meta API request failed (HTTP ${status}).`, "unavailable");
}

/** The paid-call switch. Checked before any request is built, so a half-enabled setup can never spend. */
export function assertRealCallsEnabled(env: Env) {
  if (env.AI_ENABLE_REAL_CALLS !== "true") {
    throw new AiError("Real Meta API calls are switched off. Set AI_ENABLE_REAL_CALLS=true to allow paid requests, or AI_PROVIDER=mock.", "config");
  }
}

export async function metaChat(env: Env, key: string, req: ChatRequest): Promise<ChatResult> {
  assertRealCallsEnabled(env);
  const body = JSON.stringify({
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: req.schemaName, schema: req.schema, strict: env.META_STRICT_SCHEMA === "true" },
    },
    max_completion_tokens: req.maxTokens ?? 4096,
    reasoning_effort: env.META_REASONING_EFFORT,
  });

  const started = Date.now();
  const log = (status: string | number, attempts: number, usage?: Usage) =>
    console.info(
      `[meta] purpose=${req.purpose} model=${req.model} status=${status} attempts=${attempts} latencyMs=${Date.now() - started}` +
        (usage ? ` promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens} costUsd=${usage.estimatedCostUsd ?? "n/a"}` : ""),
    );

  let res: Response | null = null;
  let attempts = 0;
  for (let attempt = 1; ; attempt++) {
    attempts = attempt;
    if (callsMade >= env.ACORN_MAX_MODEL_CALLS) {
      throw new AiError(
        `Model call budget exhausted (${env.ACORN_MAX_MODEL_CALLS} calls this server run). Raise ACORN_MAX_MODEL_CALLS or restart the server.`,
        "budget",
      );
    }
    callsMade++;
    try {
      res = await fetch(`${env.META_API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(env.META_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      log(timedOut ? "timeout" : "network-error", attempt);
      recordCall(undefined, false);
      if (timedOut) throw new AiError(`Meta API timed out after ${Math.round(env.META_TIMEOUT_MS / 1000)}s.`, "timeout");
      if (attempt >= MAX_ATTEMPTS) throw new AiError("Could not reach the Meta API.", "network");
      await sleep(retryDelayMs(null, attempt, env.ACORN_RETRY_BASE_MS));
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      void res.body?.cancel().catch(() => {}); // free the connection; nothing in a failed body is used
      log(res.status, attempt);
      await sleep(retryDelayMs(res, attempt, env.ACORN_RETRY_BASE_MS));
      continue;
    }
    break;
  }

  if (!res.ok) {
    const code = await errorCode(res);
    log(res.status, attempts);
    recordCall(undefined, false);
    return fail(res.status, code, req.model);
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  } | null;

  let usage: Usage | undefined;
  const u = json?.usage;
  if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
    usage = {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : u.prompt_tokens + u.completion_tokens,
      estimatedCostUsd: estimateCostUsd(req.model, u.prompt_tokens, u.completion_tokens),
    };
  }
  const latencyMs = Date.now() - started;
  log(res.status, attempts, usage);
  recordCall(usage, true);

  const choice = json?.choices?.[0];
  if (choice?.finish_reason === "length") throw new AiError("Meta API response was cut off (token limit).", "truncated");
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content) throw new AiError("Meta API returned no content.", "malformed");
  try {
    return { json: JSON.parse(content), usage, latencyMs, attempts };
  } catch {
    // JSON.parse messages include a snippet of the content — don't propagate them
    throw new AiError("Meta API returned output that is not valid JSON.", "malformed");
  }
}


/**
 * The other Meta endpoints (speech to text, image generation, segmentation) use the same key, base URL, call budget,
 * retry rules and logging as chat; only the path and body differ. This is the single place they are sent from.
 * Returns the successful Response for the caller to read; every failure is mapped to an AiError.
 */
export type RawRequest = {
  /** for logs only: "transcribe" | "image" | "segment" */
  purpose: string;
  model: string;
  /** appended to META_API_BASE_URL, e.g. "/asr/transcribe" */
  path: string;
  /** built per attempt, because a FormData/stream body can only be sent once */
  body: () => BodyInit;
  headers?: Record<string, string>;
  /** overrides META_TIMEOUT_MS for slow endpoints */
  timeoutMs?: number;
};

export async function metaRequest(env: Env, key: string, req: RawRequest): Promise<{ res: Response; latencyMs: number; attempts: number }> {
  assertRealCallsEnabled(env);
  const started = Date.now();
  const timeoutMs = req.timeoutMs ?? env.META_TIMEOUT_MS;
  const log = (status: string | number, attempts: number) =>
    console.info(`[meta] purpose=${req.purpose} model=${req.model} status=${status} attempts=${attempts} latencyMs=${Date.now() - started}`);

  let res: Response | null = null;
  let attempts = 0;
  for (let attempt = 1; ; attempt++) {
    attempts = attempt;
    if (callsMade >= env.ACORN_MAX_MODEL_CALLS) {
      throw new AiError(`Model call budget exhausted (${env.ACORN_MAX_MODEL_CALLS} calls this server run). Raise ACORN_MAX_MODEL_CALLS or restart the server.`, "budget");
    }
    callsMade++;
    try {
      res = await fetch(`${env.META_API_BASE_URL}${req.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, ...req.headers },
        body: req.body(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      log(timedOut ? "timeout" : "network-error", attempt);
      recordCall(undefined, false);
      if (timedOut) throw new AiError(`Meta API timed out after ${Math.round(timeoutMs / 1000)}s.`, "timeout");
      if (attempt >= MAX_ATTEMPTS) throw new AiError("Could not reach the Meta API.", "network");
      await sleep(retryDelayMs(null, attempt, env.ACORN_RETRY_BASE_MS));
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      void res.body?.cancel().catch(() => {});
      log(res.status, attempt);
      await sleep(retryDelayMs(res, attempt, env.ACORN_RETRY_BASE_MS));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const code = await errorCode(res);
    log(res.status, attempts);
    recordCall(undefined, false);
    return fail(res.status, code, req.model);
  }
  log(res.status, attempts);
  recordCall(undefined, true);
  return { res, latencyMs: Date.now() - started, attempts };
}

export function requireMetaKey(env: Env): string {
  if (!env.META_API_KEY) throw new AiError("Meta mode is on but META_API_KEY is not set. Add it to .env.local or set AI_PROVIDER=mock.", "config");
  return env.META_API_KEY;
}
