import "server-only";
import type { z } from "zod";
import { getEnv } from "../env";
import { ExtractionOutput, type ContentType, type IntentKind, type SourceKind, type Usage } from "../schema";
import { AiError } from "./errors";
import { ActionPlan, AnswerOutput, IntentClassification } from "./outputs";
import { metaProvider } from "./meta";
import { mockProvider } from "./mock";
import { replayEnabled, replayProvider } from "./replay";

export { AiError } from "./errors";

// The provider interface is all the memory pipeline knows about a model. Business logic (process.ts, answer.ts,
// intent.ts, plan.ts) calls these four methods and validates what comes back; it never sees a vendor SDK or URL.

export type ImageInput = { bytes: Uint8Array; mimeType: string };
export type DocumentInput = { bytes: Uint8Array; mimeType: "application/pdf"; fileName: string };

export type ExtractInput = {
  kind: SourceKind;
  text?: string;
  url?: string;
  image?: ImageInput;
  document?: DocumentInput;
  /** user's original upload name — the only image signal the mock has besides its built-in samples */
  originalName?: string;
  now: Date;
};

/** A saved memory reduced to what a model needs to reason about it. Saved text is untrusted data. */
export type MemoryDigest = {
  id: string;
  title: string;
  contentType: ContentType;
  createdAt: string;
  summary: string;
  facts: { statement: string; quote: string | null }[];
  entities: string[];
  deadline: string | null;
  /** the user's confirmed intent, if any; Acorn's guess is deliberately not included */
  userIntent: IntentKind | null;
  sourceUrl: string | null;
  /** clipped original text, for quoting */
  sourceText: string;
};

export type ClassifyInput = { kind: SourceKind; title: string; contentType: ContentType; summary: string; text: string; now: Date };
export type AnswerInput = { question: string; memories: MemoryDigest[]; now: Date };
export type PlanInput = { memory: MemoryDigest; now: Date };

/** Raw model output plus bookkeeping. `data` is untrusted until it passes validate(). */
export type ProviderResult = { data: unknown; usage?: Usage; latencyMs?: number; note?: string };

export interface AiProvider {
  name: "mock" | "meta";
  model: string;
  extractMemory(input: ExtractInput): Promise<ProviderResult>;
  classifyIntent(input: ClassifyInput): Promise<ProviderResult>;
  answerFromMemories(input: AnswerInput): Promise<ProviderResult>;
  generateActionPlan(input: PlanInput): Promise<ProviderResult>;
}

export function getProvider(): AiProvider {
  if (replayEnabled()) return replayProvider(); // demo only; see replay.ts
  return getEnv().ACORN_MODE === "meta" ? metaProvider() : mockProvider;
}

export type Validated<T> = { data: T; usage?: Usage; latencyMs?: number; note?: string };

/** The single place provider output is validated, for every provider and every method. */
export function validate<S extends z.ZodType>(provider: AiProvider, schema: S, result: ProviderResult): Validated<z.infer<S>> {
  const r = schema.safeParse(result.data);
  if (!r.success) {
    console.error(
      `[ai] ${provider.name} output failed validation: ${r.error.issues.length} issue(s) at ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
    throw new AiError("The model returned an answer in an unexpected shape. Try again.", "malformed");
  }
  return { data: r.data, usage: result.usage, latencyMs: result.latencyMs, note: result.note };
}

export const extractValidated = async (provider: AiProvider, input: ExtractInput) =>
  validate(provider, ExtractionOutput, await provider.extractMemory(input));
export const classifyValidated = async (provider: AiProvider, input: ClassifyInput) =>
  validate(provider, IntentClassification, await provider.classifyIntent(input));
export const answerValidated = async (provider: AiProvider, input: AnswerInput) =>
  validate(provider, AnswerOutput, await provider.answerFromMemories(input));
export const planValidated = async (provider: AiProvider, input: PlanInput) =>
  validate(provider, ActionPlan, await provider.generateActionPlan(input));
