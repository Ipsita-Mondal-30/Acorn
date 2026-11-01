import { z } from "zod";

// Shared contract for the whole app. Every boundary (API input, model output,
// file store) validates against these schemas.

export const ContentType = z.enum([
  "job",
  "recipe",
  "technical",
  "article",
  "person",
  "idea",
  "deadline",
  "event",
  "product",
  "note",
  "other",
]);
export type ContentType = z.infer<typeof ContentType>;

export const SourceKind = z.enum(["note", "url", "image", "document"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const ProcessingStatus = z.enum(["pending", "processing", "ready", "failed"]);
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;

/** A real calendar day: rejects 2026-02-31 and 2026-13-01, which a bare regex lets through. */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").refine(isRealDate, "not a real calendar date");

export const Entity = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["person", "organization", "place", "product", "skill", "ingredient", "technology", "other"]),
});
export type Entity = z.infer<typeof Entity>;

export const DateMention = z.object({
  date: isoDate,
  label: z.string().max(200),
  isDeadline: z.boolean(),
  /** verbatim text from the source that supports this date */
  evidence: z.string().max(500),
});
export type DateMention = z.infer<typeof DateMention>;

export const Evidence = z.object({
  /** verbatim quote from the saved item */
  quote: z.string().max(500),
  /** which extracted field this quote supports, e.g. "deadline", "company" */
  supports: z.string().max(100),
});
export type Evidence = z.infer<typeof Evidence>;

export const NextAction = z.object({
  label: z.string().min(1).max(200),
  kind: z.enum(["apply", "cook", "read", "reconnect", "remind", "learn", "review", "other"]),
});
export type NextAction = z.infer<typeof NextAction>;

export const JobDetails = z.object({
  company: z.string().max(200).nullable(),
  role: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  requirements: z.array(z.string().max(300)).max(30),
  applyUrl: z.string().max(2000).nullable(),
  deadline: isoDate.nullable(),
});
export type JobDetails = z.infer<typeof JobDetails>;

/** Why the user saved something. Closed set so it can be searched, filtered and corrected. */
// pursue = APPLY (a job or opportunity), reconnect = CONNECT (a person); the names predate the wider set.
export const IntentKind = z.enum([
  "remember",
  "learn",
  "try",
  "buy",
  "reconnect",
  "pursue",
  "do_later",
  "attend",
  "explore",
  "reference",
  "follow_up",
  "other",
]);
export type IntentKind = z.infer<typeof IntentKind>;

export const INTENT_LABEL: Record<IntentKind, string> = {
  remember: "Remember it",
  learn: "Learn it",
  try: "Try it",
  buy: "Buy it",
  reconnect: "Reconnect with them",
  pursue: "Pursue this opportunity",
  do_later: "Do it later",
  attend: "Attend it",
  explore: "Explore the idea",
  reference: "Keep for reference",
  follow_up: "Follow up on it",
  other: "Something else",
};

/**
 * A guess about intent made by Acorn or a model. It is NEVER the user's intention until they confirm it
 * (see UserIntent). "stated" = the user's own words say so (quote is verbatim); "inferred" = guessed from content.
 */
export const IntentGuess = z.object({
  kind: IntentKind,
  confidence: z.number().min(0).max(1),
  basis: z.enum(["stated", "inferred"]),
  rationale: z.string().max(300),
  quote: z.string().max(500).nullable(),
});
export type IntentGuess = z.infer<typeof IntentGuess>;

/** The user's own decision about a memory's intent. Absent until they act. */
export const UserIntent = z.object({
  /** "none" = the user rejected Acorn's guess and doesn't want to act on this */
  kind: z.union([IntentKind, z.literal("none")]),
  status: z.enum(["confirmed", "corrected", "set", "dismissed"]),
  note: z.string().max(300).optional(),
  at: z.string(),
});
export type UserIntent = z.infer<typeof UserIntent>;

/**
 * A fact the content itself states. It must carry the verbatim words that support it ("quote"); a fact with no
 * support is dropped. `page` is set only for documents, and only when the model reports one.
 */
export const FactOut = z.object({
  statement: z.string().min(1).max(300),
  quote: z.string().min(1).max(500),
  page: z.number().int().min(1).nullable(),
});
/** After verification: was the quote found in the text Acorn actually sent? Image-only facts can't be machine-checked. */
export const Fact = FactOut.extend({ checked: z.boolean().default(false) });
export type Fact = z.infer<typeof Fact>;

/** What a model (or the mock) is allowed to return. No provenance — we add that ourselves. */
export const ExtractionOutput = z.object({
  title: z.string().min(1).max(200),
  contentType: ContentType,
  summary: z.string().max(1000),
  entities: z.array(Entity).max(30),
  topics: z.array(z.string().max(60)).max(12),
  intent: z.string().max(300).nullable(),
  /** Acorn's structured guess about why this was saved; null when there is no real signal. */
  intentGuess: IntentGuess.nullable().default(null),
  /** Other plausible reasons for saving it, weaker than intentGuess. Never the user's decision. */
  alternativeIntents: z.array(IntentGuess).max(3).default([]),
  /** Statements the content makes, each with its supporting quote. Separate from the summary and from intent. */
  facts: z.array(FactOut).max(20).default([]),
  nextActions: z.array(NextAction).max(6),
  dates: z.array(DateMention).max(10),
  confidence: z.number().min(0).max(1),
  uncertainties: z.array(z.string().max(300)).max(10),
  evidence: z.array(Evidence).max(15),
  job: JobDetails.nullable(),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const Usage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** list price x tokens; null when Acorn has no documented price for the model. An estimate, not a bill. */
  estimatedCostUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const Provenance = z.object({
  provider: z.enum(["mock", "meta"]),
  model: z.string(),
  at: z.string(),
  latencyMs: z.number().optional(),
  usage: Usage.optional(),
  /** mock only: what the demo matched to produce this (it does not read pixels) */
  note: z.string().max(300).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Extraction = ExtractionOutput.extend({ facts: z.array(Fact).max(20).default([]), producedBy: Provenance });
export type Extraction = z.infer<typeof Extraction>;

export const Source = z.object({
  kind: SourceKind,
  /** note body, or optional user-pasted text for a URL / image */
  text: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
  /** stored upload file name inside the uploads dir (random, never user-controlled) */
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  originalName: z.string().max(255).optional(),
});
export type Source = z.infer<typeof Source>;

/** Fields a user can correct. Overrides win over the extraction everywhere. */
export const Overrides = z.object({
  title: z.string().min(1).max(200).optional(),
  contentType: ContentType.optional(),
  summary: z.string().max(1000).optional(),
  intent: z.string().max(300).optional(),
  deadline: isoDate.nullable().optional(),
  /** The user's own list of facts (replaces Acorn's). Items keep their evidence when they came from Acorn. */
  facts: z
    .array(
      z.object({
        statement: z.string().trim().min(1).max(300),
        by: z.enum(["ai", "you"]),
        quote: z.string().max(500).nullable().optional(),
        page: z.number().int().min(1).nullable().optional(),
        checked: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
});
export type Overrides = z.infer<typeof Overrides>;

export const Memory = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: Source,
  status: ProcessingStatus,
  error: z.string().optional(),
  contentHash: z.string(),
  extraction: Extraction.nullable(),
  overrides: Overrides,
  /** The user's confirmed/corrected intent. Optional so data saved before it existed still loads. */
  userIntent: UserIntent.optional(),
  /** true for seeded fixtures — UI must label these as sample data */
  isSample: z.boolean(),
});
export type Memory = z.infer<typeof Memory>;

export const ActionState = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
export type ActionState = z.infer<typeof ActionState>;

/** suggested = idea only; simulated = Acorn pretended (demo); executed = really happened, needs evidence */
export const ExecutionKind = z.enum(["suggested", "simulated", "executed"]);
export type ExecutionKind = z.infer<typeof ExecutionKind>;

export const Action = z.object({
  id: z.string(),
  memoryId: z.string(),
  title: z.string().min(1).max(200),
  detail: z.string().max(2000),
  kind: ExecutionKind,
  state: ActionState,
  history: z.array(z.object({ state: ActionState, at: z.string(), note: z.string().max(500).optional() })),
  /** observable proof required before an executed action may be completed */
  evidence: z.string().max(2000).optional(),
  scheduledFor: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Action = z.infer<typeof Action>;

/** One memory's embedding for one model. `sourceHash` says which text it was made from, so stale ones can be found. */
export const StoredEmbedding = z.object({
  memoryId: z.string(),
  provider: z.string().default("unknown"),
  model: z.string(),
  sourceHash: z.string(),
  vector: z.array(z.number()),
});
export type StoredEmbedding = z.infer<typeof StoredEmbedding>;

export const Db = z.object({
  version: z.literal(1),
  memories: z.array(Memory),
  actions: z.array(Action),
  // local demo store only; absent in files written before semantic search
  embeddings: z.array(StoredEmbedding).default([]),
});
export type Db = z.infer<typeof Db>;

export type IntentStatus = "confirmed" | "corrected" | "set" | "dismissed" | "suggested" | "none";

/** Extraction with user corrections applied — use this for display and search. */
export type MemoryView = {
  title: string;
  contentType: ContentType;
  summary: string;
  /** free-text intent: the user's wording if they edited it, otherwise the extractor's reading */
  intent: string | null;
  deadline: string | null;
  /** Acorn's facts with evidence, or the user's own list once they've edited it. */
  facts: { statement: string; by: "ai" | "you"; quote: string | null; page: number | null; checked: boolean }[];
  edited: (keyof Overrides)[];
  /** The user's own intent. Only ever set by the user; never copied from a model guess. */
  intentKind: IntentKind | null;
  intentStatus: IntentStatus;
  intentNote: string | null;
  /** Acorn's unconfirmed guess; null once the user has decided either way. */
  suggestedIntent: IntentGuess | null;
};

export function effective(m: Memory): MemoryView {
  const x = m.extraction;
  const o = m.overrides;
  const u = m.userIntent;
  const extractedDeadline = x?.job?.deadline ?? x?.dates.find((d) => d.isDeadline)?.date ?? null;
  return {
    title: o.title ?? x?.title ?? m.source.url ?? m.source.originalName ?? "Untitled",
    contentType: o.contentType ?? x?.contentType ?? "other",
    summary: o.summary ?? x?.summary ?? "",
    intent: o.intent ?? x?.intent ?? null,
    deadline: o.deadline !== undefined ? o.deadline : extractedDeadline,
    facts:
      o.facts?.map((f) => ({ statement: f.statement, by: f.by, quote: f.quote ?? null, page: f.page ?? null, checked: f.checked ?? false })) ??
      (x?.facts ?? []).map((f) => ({ statement: f.statement, by: "ai" as const, quote: f.quote, page: f.page, checked: f.checked })),
    edited: (Object.keys(o) as (keyof Overrides)[]).filter((k) => o[k] !== undefined),
    intentKind: u && u.kind !== "none" ? u.kind : null,
    intentStatus: u ? u.status : x?.intentGuess ? "suggested" : "none",
    intentNote: u?.note ?? null,
    suggestedIntent: u ? null : (x?.intentGuess ?? null),
  };
}

/** What the correction endpoint accepts: field overrides, a decision about intent, and/or fields to restore. */
export const CorrectionPatch = Overrides.extend({
  userIntent: z
    .object({ kind: z.union([IntentKind, z.literal("none")]), note: z.string().trim().max(300).optional() })
    .strict()
    .optional(),
  /** drop these corrections and go back to Acorn's reading ("userIntent" un-decides the intent) */
  restore: z.array(z.enum(["title", "contentType", "summary", "intent", "deadline", "facts", "userIntent"])).max(7).optional(),
}).strict();
export type CorrectionPatch = z.infer<typeof CorrectionPatch>;

/** Apply a correction. Pure, so it can be tested without the store. */
export function applyCorrection(m: Memory, patch: CorrectionPatch, now: Date): Memory {
  const { userIntent, restore = [], ...fields } = patch;
  const overrides: Overrides = { ...m.overrides };
  for (const k of restore) if (k !== "userIntent") delete overrides[k];
  Object.assign(overrides, fields);

  let next = m.userIntent;
  if (restore.includes("userIntent")) next = undefined;
  if (userIntent) {
    const guess = m.extraction?.intentGuess ?? null;
    const status =
      userIntent.kind === "none" ? "dismissed" : !guess ? "set" : guess.kind === userIntent.kind ? "confirmed" : "corrected";
    next = { kind: userIntent.kind, status, ...(userIntent.note ? { note: userIntent.note } : {}), at: now.toISOString() };
  }
  return { ...m, overrides, userIntent: next };
}
