import { z } from "zod";
import { IntentGuess, NextAction } from "../schema";

// Shapes the non-extraction model calls may return. Validated in one place (provider.ts), for every provider.

/** classifyIntent: up to three candidate reasons, strongest first, or a question to put to the user. */
export const IntentClassification = z.object({
  candidates: z.array(IntentGuess).max(3),
  /** set when nothing in the item points to a purpose: Acorn should ASK, not guess */
  question: z.string().max(200).nullable(),
});
export type IntentClassification = z.infer<typeof IntentClassification>;

export const Citation = z.object({
  memoryId: z.string().min(1).max(100),
  /** verbatim words from that memory's saved text or facts that support the answer */
  quote: z.string().min(1).max(500),
});

/** answerFromMemories */
export const AnswerOutput = z.object({
  answer: z.string().max(1500),
  citations: z.array(Citation).max(8),
  /** true when the retrieved memories don't actually answer the question */
  noReliableMatch: z.boolean(),
});
export type AnswerOutput = z.infer<typeof AnswerOutput>;

/** generateActionPlan: suggestions only; nothing here has been done, and nothing is created automatically. */
export const ActionPlan = z.object({
  steps: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        kind: NextAction.shape.kind,
        rationale: z.string().max(300),
      }),
    )
    .max(6),
});
export type ActionPlan = z.infer<typeof ActionPlan>;
