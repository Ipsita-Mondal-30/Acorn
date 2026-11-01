import { createHash } from "node:crypto";
import { effective, type Memory } from "./schema";

// Pure helpers for semantic search: what text represents a memory, and how close two vectors are.

/**
 * The text a memory is embedded from: what it says (title, summary, facts, entities, topics), what the user wrote,
 * and the original file name. Corrections the user made are included, so edits change the embedding.
 */
export function embeddingText(m: Memory, max = 6_000): string {
  const v = effective(m);
  const x = m.extraction;
  return [
    v.title,
    v.summary,
    ...v.facts.map((f) => f.statement),
    ...(x?.entities.map((e) => e.name) ?? []),
    ...(x?.topics ?? []),
    v.intent ?? "",
    m.source.text ?? "",
    m.source.originalName ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, max);
}

/** Identifies the exact text and model a vector came from. A different hash means the stored vector is stale. */
export const embeddingHash = (model: string, text: string) => createHash("sha256").update(`${model}\u0000${text}`).digest("hex");

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A vector pgvector can index and compare: not empty, every number finite, not all zeros (cosine is undefined there). */
export function validVector(v: number[]): boolean {
  return v.length > 0 && v.every(Number.isFinite) && v.some((x) => x !== 0);
}

/** pgvector's text form, e.g. [0.1,0.2]. */
export const toVectorText = (v: number[]) => `[${v.join(",")}]`;

/** Parse pgvector's text form (PostgREST returns vectors as strings). Returns null if it isn't one. */
export function parseVectorText(s: unknown): number[] | null {
  if (Array.isArray(s)) return s.every((x) => typeof x === "number") ? (s as number[]) : null;
  if (typeof s !== "string" || !/^\[.*\]$/.test(s)) return null;
  const v = s.slice(1, -1).split(",").map(Number);
  return v.every(Number.isFinite) ? v : null;
}
