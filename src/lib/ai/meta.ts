import "server-only";
import { z } from "zod";
import { getEnv, type Env } from "../env";
import { ExtractionOutput } from "../schema";
import { AiError } from "./errors";
import { assertRealCallsEnabled, metaChat, type ChatPart } from "./meta-client";
import { ActionPlan, AnswerOutput, IntentClassification } from "./outputs";
import { ANSWER_SYSTEM, answerParts, CLASSIFY_SYSTEM, classifyParts, EXTRACT_SYSTEM, extractParts, PLAN_SYSTEM, planParts } from "./prompts";
import type { AiProvider, ProviderResult } from "./provider";

// Meta Model API provider. Reachable only when AI_PROVIDER=meta, META_API_KEY is set and AI_ENABLE_REAL_CALLS=true.
// Verified live once each for text, image and PDF (see README); tests/meta-provider.test.ts checks the request/response
// handling against the documented shapes with a stubbed fetch.

/** JSON Schema as the API wants it: no $schema key. */
function schemaOf(s: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  void _drop;
  return rest;
}
export const EXTRACTION_SCHEMA = schemaOf(ExtractionOutput);
export const INTENT_SCHEMA = schemaOf(IntentClassification);
export const ANSWER_SCHEMA = schemaOf(AnswerOutput);
export const PLAN_SCHEMA = schemaOf(ActionPlan);

/** Throws AiError when meta mode is on but no key is configured — never falls back to the mock. */
export function metaProvider(): AiProvider {
  const env = getEnv();
  const key = env.META_API_KEY;
  if (!key) throw new AiError("Meta mode is on but META_API_KEY is not set. Add it to .env.local or set AI_PROVIDER=mock.", "config");
  assertRealCallsEnabled(env);
  const model = env.META_EXTRACTION_MODEL;

  const call = async (
    e: Env,
    purpose: string,
    schemaName: string,
    schema: Record<string, unknown>,
    system: string,
    user: ChatPart[],
    useModel = model,
  ): Promise<ProviderResult> => {
    const r = await metaChat(e, key, { model: useModel, system, user, purpose, schemaName, schema });
    return { data: r.json, usage: r.usage, latencyMs: r.latencyMs };
  };

  return {
    name: "meta",
    model,
    extractMemory: (input) => call(env, "extract", "acorn_extraction", EXTRACTION_SCHEMA, EXTRACT_SYSTEM, extractParts(input)),
    classifyIntent: (input) => call(env, "intent", "acorn_intent", INTENT_SCHEMA, CLASSIFY_SYSTEM, classifyParts(input)),
    answerFromMemories: (input) => call(env, "answer", "acorn_answer", ANSWER_SCHEMA, ANSWER_SYSTEM, answerParts(input)),
    generateActionPlan: (input) => call(env, "plan", "acorn_plan", PLAN_SCHEMA, PLAN_SYSTEM, planParts(input), env.META_PLAN_MODEL ?? model),
  };
}
