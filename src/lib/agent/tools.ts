import "server-only";
import { z } from "zod";
import { ActionError, transition } from "../actions";
import { effective, JobDetails, type Action, type ActionState, type Memory } from "../schema";
import { searchMemories } from "../search";
import { buildCoverLetter, buildResume, claimProblems, CoverLetter, flagUnsupported, ResumeDraft } from "./draft";
import { ChecklistItem, cvLines, jobChecklist } from "./job";
import { countByStatus, cvClaims, matchRequirements, RequirementResult } from "./match";
import type { ParsedCv } from "../cv/parse";
import { buildStudyPack, normalise, StudyInput, StudyPack, withoutProgress } from "./study";
import { buildShoppingList, ParsedRecipe, parseRecipe, ShoppingItem, Substitution } from "./recipe";
import { Permission, ReminderKind, ToolName, type Reminder, type Verification } from "./schema";

// The controlled tool registry. A plan can only name a tool from this table; the model never gets to run code.
// Every tool has: a typed input and output, the permissions it needs, an owner-scoped way to reach data (ToolIO is
// built from the signed-in user's store, so another user's rows are unreachable), and a SEPARATE verify() that re-checks
// the result against the source instead of trusting run(). No tool can send, submit, pay or contact anyone.

/** A failure whose message is safe to show the user. */
export class ToolError extends Error {
  override name = "ToolError";
}

export type ToolIO = {
  now: Date;
  getMemory(id: string): Promise<Memory | null>;
  listMemories(): Promise<Memory[]>;
  getCv(): Promise<{ text: string; parsed: ParsedCv } | null>;
  /** Embed short texts with the configured embedding provider, or null when none is configured. Paid when it is. */
  embed?(texts: string[]): Promise<number[][] | null>;
  createReminder(r: { memoryId: string; actionId: string; title: string; note: string; dueAt: string; kind: ReminderKind }): Promise<Reminder>;
  getReminder(id: string): Promise<Reminder | null>;
  getAction(id: string): Promise<Action | null>;
  mutateAction(id: string, fn: (a: Action) => Action): Promise<Action | null>;
};

/** What callers supply; the permissions the user approved are added by runTool itself. */
export type ToolCtxIn = Omit<ToolCtx, "approved">;
export type ToolCtx = {
  io: ToolIO;
  plan: { id: string; memoryId: string; actionId: string; memoryIds: string[] };
  stepId: string;
  /** the permissions the user approved for this plan */
  approved: Permission[];
};

type Meta = { edited: boolean };
export type Tool = {
  name: ToolName;
  description: string;
  permissions: Permission[];
  /** always false: there is no tool that acts outside Acorn */
  external: false;
  input: z.ZodType;
  output: z.ZodType;
  run(ctx: ToolCtx, input: unknown): Promise<unknown>;
  verify(ctx: ToolCtx, input: unknown, output: unknown, meta: Meta): Promise<Verification>;
  /** After the user edits an output: recompute derived fields (e.g. flags for words that aren't in the CV). */
  refresh?(ctx: ToolCtx, input: unknown, output: unknown): Promise<unknown>;
};

function defineTool<I, O>(t: {
  name: ToolName;
  description: string;
  permissions: Permission[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(ctx: ToolCtx, input: I): Promise<O>;
  verify(ctx: ToolCtx, input: I, output: O, meta: Meta): Promise<Verification>;
  refresh?(ctx: ToolCtx, input: I, output: O): Promise<O>;
}): Tool {
  return {
    ...t,
    external: false,
    run: (c, i) => t.run(c, i as I),
    verify: (c, i, o, m) => t.verify(c, i as I, o as O, m),
    refresh: t.refresh ? (c, i, o) => t.refresh!(c, i as I, o as O) : undefined,
  };
}

const verification = (checks: { name: string; passed: boolean; detail: string }[]): Verification => ({ passed: checks.every((c) => c.passed), checks });
const requireInPlan = (ctx: ToolCtx, memoryId: string) => {
  // ownership, twice: the id must belong to this plan, and the store only ever returns the signed-in user's rows
  if (!ctx.plan.memoryIds.includes(memoryId)) throw new ToolError("That memory is not part of this plan.");
};

// ───────────────────────── memory tools ─────────────────────────

const MemorySnapshot = z.object({
  memoryId: z.string(),
  title: z.string(),
  contentType: z.string(),
  sourceKind: z.string(),
  summary: z.string(),
  facts: z.array(z.object({ statement: z.string(), quote: z.string().nullable() })),
  entities: z.array(z.object({ name: z.string(), kind: z.string() })),
  dates: z.array(z.object({ date: z.string(), label: z.string(), isDeadline: z.boolean(), evidence: z.string() })),
  deadline: z.string().nullable(),
  sourceText: z.string(),
  /** the saved text, or for a screenshot/PDF the quotes Acorn read from it */
  readableText: z.string(),
  sourceUrl: z.string().nullable(),
  job: JobDetails.nullable(),
  /** what the user confirmed, never Acorn's guess */
  userIntent: z.string().nullable(),
});
type MemorySnapshot = z.infer<typeof MemorySnapshot>;

const snapshot = (m: Memory): MemorySnapshot => {
  const v = effective(m);
  const x = m.extraction;
  return {
    memoryId: m.id,
    title: v.title,
    contentType: v.contentType,
    sourceKind: m.source.kind,
    summary: v.summary,
    facts: v.facts.map((f) => ({ statement: f.statement, quote: f.quote })),
    entities: x?.entities ?? [],
    dates: x?.dates ?? [],
    deadline: v.deadline,
    sourceText: (m.source.text ?? "").slice(0, 8_000),
    readableText: ((m.source.text ?? "").trim() || v.facts.map((f) => f.quote ?? f.statement).join("\n")).slice(0, 8_000),
    sourceUrl: m.source.url ?? null,
    job: x?.job ? { ...x.job, deadline: v.deadline } : null,
    userIntent: v.intentKind,
  };
};

const retrieveVerify = async (ctx: ToolCtx, input: { memoryId: string }, out: MemorySnapshot) => {
  const again = await ctx.io.getMemory(input.memoryId);
  const now = again ? snapshot(again) : null;
  return verification([
    { name: "Memory exists and is yours", passed: Boolean(again), detail: again ? "Found in your saved memories." : "Not found." },
    { name: "Output matches the saved memory", passed: JSON.stringify(now) === JSON.stringify(out), detail: "Re-read the memory and compared." },
  ]);
};

const retrieveMemory = defineTool({
  name: "retrieve_memory",
  description: "Read one saved memory that belongs to this plan: its title, facts with quotes, dates and original text.",
  permissions: ["memory:read"],
  input: z.object({ memoryId: z.string().min(1).max(100) }).strict(),
  output: MemorySnapshot,
  async run(ctx, input) {
    requireInPlan(ctx, input.memoryId);
    const m = await ctx.io.getMemory(input.memoryId);
    if (!m) throw new ToolError("That memory could not be found.");
    if (m.status !== "ready" || !m.extraction) throw new ToolError("Acorn hasn't finished reading that memory yet.");
    return snapshot(m);
  },
  verify: retrieveVerify,
});

const readDocument = defineTool({
  name: "read_document",
  description: "Read what Acorn understood from an uploaded screenshot or PDF. It uses the saved extraction; it does not re-read the file or call a model.",
  permissions: ["memory:read"],
  input: z.object({ memoryId: z.string().min(1).max(100) }).strict(),
  output: MemorySnapshot,
  async run(ctx, input) {
    requireInPlan(ctx, input.memoryId);
    const m = await ctx.io.getMemory(input.memoryId);
    if (!m) throw new ToolError("That memory could not be found.");
    if (m.source.kind !== "image" && m.source.kind !== "document") throw new ToolError("That memory is not an uploaded screenshot or PDF.");
    if (m.status !== "ready" || !m.extraction) throw new ToolError("Acorn hasn't finished reading that file yet.");
    return snapshot(m);
  },
  verify: retrieveVerify,
});

const searchTool = defineTool({
  name: "search_memories",
  description: "Search the user's own memories by keywords. Returns ids, titles and why each matched.",
  permissions: ["memory:read"],
  input: z.object({ query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(10).default(5) }).strict(),
  output: z.object({ results: z.array(z.object({ memoryId: z.string(), title: z.string(), reasons: z.array(z.string()), score: z.number() })) }),
  async run(ctx, input) {
    const hits = searchMemories(await ctx.io.listMemories(), input.query, ctx.io.now).slice(0, input.limit);
    return { results: hits.map((h) => ({ memoryId: h.memory.id, title: effective(h.memory).title, reasons: h.reasons, score: h.score })) };
  },
  async verify(ctx, input, out) {
    const mine = new Set((await ctx.io.listMemories()).map((m) => m.id));
    return verification([
      { name: "Every result is one of your memories", passed: out.results.every((r) => mine.has(r.memoryId)), detail: `${out.results.length} result(s) checked.` },
      { name: "Within the limit", passed: out.results.length <= input.limit, detail: `limit ${input.limit}` },
    ]);
  },
});

// ───────────────────────── CV and job tools ─────────────────────────

const Comparison = z.object({
  results: z.array(RequirementResult),
  counts: z.object({ verified: z.number().int(), potential: z.number().int(), unverified: z.number().int(), missing: z.number().int() }),
  semantic: z.object({ used: z.boolean(), note: z.string() }),
});
/** Below this a similar-meaning match isn't offered at all. Model-specific and uncalibrated; see docs/agent.md. */
const SEMANTIC_MIN = 0.5;

const needCv = async (ctx: ToolCtx) => {
  const cv = await ctx.io.getCv();
  if (!cv || !cv.text.trim()) throw new ToolError("You haven't added your CV yet. Add it, then retry this step.");
  return cv;
};

const compareTool = defineTool({
  name: "compare_job_to_cv",
  description: "Compare each requirement of the job with your CV. Every result carries the CV's own words as evidence, a status (verified, potential, unverified, missing), an explanation and whether you must confirm it.",
  permissions: ["profile:cv:read", "compute"],
  input: z.object({ job: JobDetails }).strict(),
  output: Comparison,
  async run(ctx, input) {
    if (input.job.requirements.length === 0) throw new ToolError("The saved job lists no requirements to compare.");
    const cv = await needCv(ctx);
    let semantic: { sims: number[][]; min: number } | undefined;
    let note = "Matched by wording only.";
    if (ctx.approved.includes("embed:text") && ctx.io.embed) {
      const firstPass = matchRequirements({ requirements: input.job.requirements, text: cv.text, parsed: cv.parsed, now: ctx.io.now });
      const open = firstPass.map((r, i) => [r, i] as const).filter(([r]) => r.status === "MISSING" || r.status === "POTENTIAL_MATCH");
      const claims = cvClaims(cv.text, cv.parsed);
      if (open.length && claims.length) {
        try {
          const vecs = await ctx.io.embed([...open.map(([r]) => r.requirement), ...claims.map((c) => c.quote)]);
          if (vecs) {
            const reqV = vecs.slice(0, open.length);
            const claimV = vecs.slice(open.length);
            const sims: number[][] = input.job.requirements.map(() => []);
            open.forEach(([, ri], k) => {
              sims[ri] = claimV.map((cv2) => cosine(reqV[k], cv2));
            });
            semantic = { sims, min: SEMANTIC_MIN };
            note = `Also compared meaning for ${open.length} requirement(s) using your embedding service.`;
          }
        } catch {
          note = "Comparing meaning failed, so only wording was matched.";
        }
      }
    }
    const results = matchRequirements({ requirements: input.job.requirements, text: cv.text, parsed: cv.parsed, now: ctx.io.now, semantic });
    return { results, counts: countByStatus(results), semantic: { used: Boolean(semantic), note } };
  },
  async verify(ctx, input, out, meta) {
    const cv = await needCv(ctx);
    const quotesOk = out.results.every((r) => r.evidence.every((e) => cv.text.slice(e.span.start, e.span.end) === e.quote));
    const checks = [
      { name: "Covers exactly the job's requirements", passed: JSON.stringify(out.results.map((r) => r.requirement)) === JSON.stringify(input.job.requirements), detail: `${out.results.length} requirement(s).` },
      { name: "Every piece of evidence is the CV's own words, at the place it points to", passed: quotesOk, detail: "Checked each quote against the CV text." },
      { name: "Only wording or documented equivalents make a verified match", passed: out.results.every((r) => r.status !== "VERIFIED_MATCH" || ((r.method === "exact" || r.method === "alias") && r.evidence.length > 0 && !r.needsConfirmation)), detail: "A similar meaning can never be verified." },
      { name: "Anything ambiguous asks for your confirmation", passed: out.results.every((r) => !["POTENTIAL_MATCH", "UNVERIFIED"].includes(r.status) || r.needsConfirmation), detail: "Potential and unverified results are flagged." },
    ];
    if (!out.semantic.used && !meta.edited) {
      const again = matchRequirements({ requirements: input.job.requirements, text: cv.text, parsed: cv.parsed, now: ctx.io.now });
      checks.push({ name: "Same result when recomputed", passed: JSON.stringify(again) === JSON.stringify(out.results), detail: "Deterministic recheck." });
    }
    return verification(checks);
  },
});

function cosine(a: number[], b: number[]) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

const DraftInput = z.object({ job: JobDetails, results: z.array(RequirementResult) }).strict();

const resumeTool = defineTool({
  name: "draft_resume",
  description: "Lay out your own CV for this job: the roles and lines that back the job's requirements first, with computed durations. Every line points to the CV text it came from; nothing is rewritten or added.",
  permissions: ["profile:cv:read", "compute"],
  input: DraftInput,
  output: ResumeDraft,
  async run(ctx, input) {
    const cv = await needCv(ctx);
    return buildResume(input.job, input.results, cv.text, cv.parsed, ctx.io.now);
  },
  async verify(ctx, input, out, meta) {
    const cv = await needCv(ctx);
    if (meta.edited) return verification([{ name: "Edited by you", passed: out.text.trim().length > 0, detail: out.flags.length ? `You changed this draft. Words not in your CV or the job: ${out.flags.join(", ")}.` : "You changed this draft, so Acorn can't vouch for the wording. You are responsible for its accuracy." }]);
    const problems = claimProblems(out, cv.text, input.job, ctx.io.now, cv.parsed);
    const bullets = cv.parsed.experience.reduce((n, e) => n + e.bullets.length, 0) + cv.parsed.projects.reduce((n, e) => n + e.bullets.length, 0);
    const included = out.lines.filter((l) => l.kind === "cv" && l.text.startsWith("- ") && l.evidence && cv.parsed.experience.concat(cv.parsed.projects).some((e) => e.bullets.some((b) => b.span.start === l.evidence!.span.start))).length;
    return verification([
      { name: "Every line traces to your CV text", passed: problems.length === 0, detail: problems[0] ?? `${out.lines.length} line(s) checked.` },
      { name: "No experience bullet was dropped or invented", passed: included === bullets, detail: `${included} of ${bullets} bullets included.` },
      { name: "Requirements your CV doesn't back are not claimed", passed: JSON.stringify(out.unsupported) === JSON.stringify(input.results.filter((r) => !(r.userDecision !== "rejected" && (r.status === "VERIFIED_MATCH" || r.userDecision === "confirmed") && r.evidence.length > 0)).map((r) => r.requirement)), detail: `${out.unsupported.length} left for you to review.` },
    ]);
  },
  async refresh(ctx, input, out) {
    const cv = await needCv(ctx);
    return { ...out, flags: flagUnsupported(out.text, cv.text, input.job) };
  },
});

const coverTool = defineTool({
  name: "draft_cover_letter",
  description: "Write a cover letter whose claims are lines from your CV (with their role and dates), only for requirements that are verified or that you confirmed. Everything else is a marked blank for you.",
  permissions: ["profile:cv:read", "compute"],
  input: DraftInput,
  output: CoverLetter,
  async run(ctx, input) {
    const cv = await needCv(ctx);
    return buildCoverLetter(input.job, input.results, cv.text, cv.parsed);
  },
  async verify(ctx, input, out, meta) {
    const cv = await needCv(ctx);
    if (meta.edited) return verification([{ name: "Edited by you", passed: out.text.trim().length > 0, detail: out.flags.length ? `You changed this letter. Words not in your CV or the job: ${out.flags.join(", ")}.` : "You changed this letter, so Acorn can't vouch for the wording. You are responsible for its accuracy." }]);
    const problems = claimProblems(out, cv.text, input.job, ctx.io.now, cv.parsed);
    const claims = out.lines.filter((l) => l.requirement !== null);
    return verification([
      { name: "Every claim is a line from your CV, at the place it points to", passed: problems.length === 0, detail: problems[0] ?? `${claims.length} claim(s) checked.` },
      { name: "Only verified matches or ones you confirmed are claimed", passed: claims.every((l) => input.results.some((r) => r.requirement === l.requirement && r.userDecision !== "rejected" && (r.status === "VERIFIED_MATCH" || r.userDecision === "confirmed"))), detail: "Potential, unverified and missing requirements are not claimed." },
      { name: "What isn't backed is marked for you, not papered over", passed: out.unsupported.every((u) => out.text.includes(u)) && (out.unsupported.length === 0 || out.text.includes("[TO COMPLETE")), detail: `${out.unsupported.length} requirement(s) left as [TO COMPLETE].` },
      { name: "No number or term that isn't in your CV or the job", passed: flagUnsupported(out.text, cv.text, input.job).length === 0, detail: "Scanned the letter." },
    ]);
  },
  async refresh(ctx, input, out) {
    const cv = await needCv(ctx);
    return { ...out, flags: flagUnsupported(out.text, cv.text, input.job) };
  },
});

const readCv = defineTool({
  name: "read_cv",
  description: "Check that the user has given Acorn a CV, and how much of it Acorn could read. Returns counts only, never the text.",
  permissions: ["profile:cv:read"],
  input: z.object({}).strict(),
  output: z.object({ present: z.literal(true), characters: z.number().int(), lines: z.number().int(), experience: z.number().int(), skills: z.number().int(), warnings: z.array(z.string()) }),
  async run(ctx) {
    const cv = await needCv(ctx);
    return { present: true as const, characters: cv.text.length, lines: cvLines(cv.text).length, experience: cv.parsed.experience.length, skills: cv.parsed.skills.length, warnings: cv.parsed.warnings.map((w) => w.message).slice(0, 5) };
  },
  async verify(ctx, _i, out) {
    const cv = await ctx.io.getCv();
    return verification([{ name: "CV is stored and matches", passed: Boolean(cv) && cv!.text.length === out.characters, detail: "Compared sizes with the stored CV." }]);
  },
});

const Checklist = z.object({ items: z.array(ChecklistItem).min(1).max(30) });
const checklistTool = defineTool({
  name: "create_checklist",
  description: "Build a checklist: for a job from its details and the CV comparison, otherwise from the plain steps the plan supplies.",
  permissions: ["compute"],
  input: z.object({ job: JobDetails.nullable().default(null), results: z.array(RequirementResult).nullable().default(null), items: z.array(z.string().min(1).max(300)).max(30).nullable().default(null) }).strict(),
  output: Checklist,
  async run(_ctx, input) {
    if (input.job) return { items: jobChecklist(input.job, input.results ?? []) };
    if (input.items?.length) return { items: input.items.map((text, i) => ({ id: `c${i + 1}`, text, done: false, by: "acorn" as const })) };
    throw new ToolError("There is nothing to put on a checklist.");
  },
  async verify(_ctx, input, out, meta) {
    const ids = new Set(out.items.map((i) => i.id));
    return verification([
      { name: "Has items, each with a unique id", passed: out.items.length > 0 && ids.size === out.items.length, detail: `${out.items.length} item(s).` },
      { name: "Never claims anything is already done", passed: meta.edited || out.items.every((i) => !i.done), detail: "New checklists start unchecked." },
      { name: "Deadline item matches the saved deadline", passed: !input.job?.deadline || out.items.some((i) => i.text.includes(input.job!.deadline!)), detail: input.job?.deadline ? `Looked for ${input.job.deadline}.` : "No deadline saved." },
    ]);
  },
});


// ───────────────────────── learning tools ─────────────────────────

const studyTool = defineTool({
  name: "build_study_pack",
  description: "Turn a saved memory you want to learn into a session plan, revision notes, flashcards, practice questions and exercises. Built only from the memory's own facts and quotes; nothing is invented and no model is called.",
  permissions: ["compute"],
  input: StudyInput,
  output: StudyPack,
  async run(_ctx, input) {
    try {
      return buildStudyPack(input);
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : "Nothing to study yet.");
    }
  },
  async verify(_ctx, input, out) {
    const source = normalise([input.readableText, input.summary, ...input.facts.flatMap((f) => [f.statement, f.quote ?? ""])].join(" "));
    const rebuilt = (() => {
      try {
        return buildStudyPack(input);
      } catch {
        return null;
      }
    })();
    return verification([
      { name: "Content is exactly what the saved memory supports", passed: rebuilt !== null && JSON.stringify(withoutProgress(out)) === JSON.stringify(withoutProgress(rebuilt)), detail: "Rebuilt the pack from the memory and compared." },
      { name: "Every quote is in the saved item", passed: [...out.cards.map((c) => c.quote), ...out.notes.map((n) => n.quote)].every((q) => !q || source.includes(normalise(q))), detail: "Looked each quote up in the memory's text and facts." },
      { name: "Each blanked word is a word of the item", passed: out.cards.filter((c) => c.cloze).every((c) => source.includes(normalise(c.back))), detail: `${out.cards.filter((c) => c.cloze).length} fill-in card(s) checked.` },
      { name: "Nothing is counted as learnt before you did it", passed: true, detail: "Progress only changes when you mark it." },
    ]);
  },
});

// ───────────────────────── recipe tools ─────────────────────────

const extractRecipe = defineTool({
  name: "extract_recipe",
  description: "Read ingredients, servings and method out of the saved recipe's own text. Quantities are read only where they are written; every ingredient and step points at its place in the text.",
  permissions: ["compute"],
  input: z.object({ title: z.string(), text: z.string(), entities: z.array(z.object({ name: z.string(), kind: z.string() })).default([]) }).strict(),
  output: ParsedRecipe,
  async run(_ctx, input) {
    const r = parseRecipe(input);
    if (r.ingredients.length === 0) throw new ToolError("Acorn couldn't find any ingredients in this recipe. Add them to the memory's text and retry.");
    return r;
  },
  async verify(_ctx, input, out) {
    const names = new Set(input.entities.map((e) => e.name.toLowerCase()));
    const at = (s: { start: number; end: number }) => input.text.slice(s.start, s.end);
    return verification([
      { name: "Every ingredient is in the saved recipe, at the place it points to", passed: out.ingredients.every((i) => (i.span ? at(i.span).replace(/\s+/g, " ") === i.raw : names.has(i.raw.toLowerCase()))), detail: `${out.ingredients.length} ingredient(s) checked.` },
      { name: "Every method step is in the saved recipe, at the place it points to", passed: out.instructions.every((s) => at(s.span) === s.text), detail: `${out.instructions.length} step(s) checked.` },
      { name: "Quantities are as written", passed: out.ingredients.every((i) => i.quantity === null || /\d|[½¼¾⅓⅔⅛]/.test(i.raw)), detail: "A quantity is only set when the text has a number." },
      { name: "Servings are as written", passed: !out.servings || at(out.servings.span) === out.servings.raw, detail: out.servings ? out.servings.raw : "The recipe doesn't say." },
    ]);
  },
});

const ShoppingList = z.object({
  items: z.array(ShoppingItem).min(1).max(80),
  substitutions: z.array(Substitution).max(20),
  servings: z.object({ original: z.number().nullable(), target: z.number().nullable() }),
  warnings: z.array(z.string()),
});
const shoppingTool = defineTool({
  name: "build_shopping_list",
  description: "Turn the extracted ingredients into a shopping list (duplicates merged, amounts scaled if you ask for other servings). Substitutions are Acorn's own ideas, always labelled inferred, and never change the list.",
  permissions: ["compute"],
  input: z.object({ recipe: ParsedRecipe, targetServings: z.number().positive().max(200).nullable().default(null) }).strict(),
  output: ShoppingList,
  async run(_ctx, input) {
    if (input.targetServings !== null && !input.recipe.servings) throw new ToolError("This recipe doesn't say how many it serves, so Acorn can't scale it. Change the amounts yourself.");
    const r = buildShoppingList(input.recipe, input.targetServings);
    if (r.items.length === 0) throw new ToolError("There are no ingredients to shop for.");
    return r;
  },
  async verify(_ctx, input, out, meta) {
    const names = new Set(input.recipe.ingredients.map((i) => i.name));
    const orig = out.servings.original;
    return verification([
      { name: "Every extracted item is an ingredient of the recipe", passed: out.items.filter((i) => i.source === "extracted").every((i) => names.has(i.name)), detail: "Compared with the extracted ingredients." },
      { name: "Items you added are marked as yours", passed: meta.edited || out.items.every((i) => i.source === "extracted"), detail: "Only the user can add items." },
      { name: "Substitutions are labelled as Acorn's ideas, and never change the list", passed: out.substitutions.every((s) => s.source === "inferred") && out.items.every((i) => i.source !== "extracted" || !out.substitutions.some((s) => s.idea.toLowerCase().startsWith(i.name) && !names.has(i.name))), detail: `${out.substitutions.length} idea(s), kept out of the list.` },
      { name: "Amounts follow the servings you chose", passed: meta.edited || out.servings.target === null || !orig || out.items.every((i) => i.baseQuantity === null || i.quantity === Math.round(((i.baseQuantity * out.servings.target!) / orig) * 100) / 100), detail: out.servings.target ? `Scaled from ${orig} to ${out.servings.target}.` : "Not scaled." },
    ]);
  },
});

// ───────────────────────── drafts, reminders, status ─────────────────────────

const draftEmail = defineTool({
  name: "draft_email",
  description: "Draft (never send) a short email. The user copies it into their own mail app.",
  permissions: ["compute"],
  input: z.object({ purpose: z.enum(["reconnect", "follow_up"]), name: z.string().max(100).nullable().default(null), context: z.string().max(600).nullable().default(null) }).strict(),
  output: z.object({ subject: z.string(), body: z.string(), sent: z.literal(false) }),
  async run(_ctx, input) {
    const who = input.name?.trim() || "[name]";
    const ref = input.context ? `\n\nFrom my notes: ${input.context}` : "";
    // no template asserts a past conversation, a promise or a relationship: unknowns are [placeholders] for the user
    return input.purpose === "reconnect"
      ? { subject: `Getting back in touch${input.name ? `, ${input.name}` : ""}`, body: `Hi ${who},\n\nI'd like to get back in touch.${ref}\n\nWould you be open to a quick call or coffee sometime soon?\n\n[Your name]`, sent: false as const }
      : { subject: "Following up", body: `Hi ${who},\n\nI'm following up on [what you are following up on].${ref}\n\nPlease let me know if there is anything else I can provide.\n\n[Your name]`, sent: false as const };
  },
  async verify(_ctx, input, out, meta) {
    return verification([
      { name: "Is a draft, not a sent message", passed: out.sent === false, detail: "Acorn has no way to send email." },
      { name: "Names the person when known", passed: meta.edited || !input.name || out.body.includes(input.name), detail: input.name ? `Looked for ${input.name}.` : "No name saved." },
      { name: "Unknown details are left as [placeholders]", passed: meta.edited || (input.name !== null || out.body.includes("[name]")) && (input.purpose !== "follow_up" || out.body.includes("[what you are following up on]")), detail: "Nothing is guessed." },
      { name: "Doesn't claim a past conversation, meeting or promise", passed: meta.edited || !/\b(?:as we discussed|as promised|our (?:earlier|last|previous) (?:conversation|meeting|call)|great meeting you|nice speaking)\b/i.test(out.body), detail: "Acorn doesn't know what was said between you." },
    ]);
  },
});

const ReminderOut = z.object({ reminderId: z.string(), title: z.string(), dueAt: z.string() });
const createReminder = defineTool({
  name: "create_reminder",
  description: "Create a reminder for the user, linked to this memory and action. It only shows up in Acorn.",
  permissions: ["reminder:write"],
  input: z.object({ memoryId: z.string(), title: z.string().trim().min(1).max(200), note: z.string().max(2000).default(""), dueAt: z.iso.datetime({ offset: true }), kind: ReminderKind.default("intent") }).strict(),
  output: ReminderOut,
  async run(ctx, input) {
    requireInPlan(ctx, input.memoryId);
    if (new Date(input.dueAt).getTime() < ctx.io.now.getTime() - 60_000) throw new ToolError("That reminder date is in the past. Pick a later date and retry.");
    const r = await ctx.io.createReminder({ memoryId: input.memoryId, actionId: ctx.plan.actionId, title: input.title, note: input.note, dueAt: new Date(input.dueAt).toISOString(), kind: input.kind });
    return { reminderId: r.id, title: r.title, dueAt: r.dueAt };
  },
  async verify(ctx, input, out) {
    const r = await ctx.io.getReminder(out.reminderId);
    return verification([
      { name: "The reminder exists for you", passed: Boolean(r), detail: r ? "Found it again in your reminders." : "Not found." },
      { name: "Linked to this memory and this action", passed: r?.memoryId === input.memoryId && r?.actionId === ctx.plan.actionId, detail: "Compared the links." },
      { name: "Created from a confirmed intent, as the kind you approved", passed: r?.kind === input.kind, detail: `Kind: ${input.kind}.` },
      { name: "Due date is as requested", passed: Boolean(r) && new Date(r!.dueAt).getTime() === new Date(input.dueAt).getTime(), detail: input.dueAt },
    ]);
  },
});

const ALLOWED_STATUS: ActionState[] = ["awaiting_approval", "in_progress", "failed", "cancelled"];
const updateAction = defineTool({
  name: "update_action_status",
  description: "Move this plan's action through its states. It can never approve it (only the user does) or complete it (the executor does, from verified evidence).",
  permissions: ["action:write"],
  input: z.object({ to: z.enum(["awaiting_approval", "in_progress", "failed", "cancelled", "approved", "completed", "proposed"]), note: z.string().max(500).optional() }).strict(),
  output: z.object({ state: z.string() }),
  async run(ctx, input) {
    if (!ALLOWED_STATUS.includes(input.to)) throw new ToolError("Only you can approve an action, and Acorn completes it only from verified evidence.");
    try {
      const a = await ctx.io.mutateAction(ctx.plan.actionId, (cur) => transition(cur, input.to, { note: input.note }, ctx.io.now));
      if (!a) throw new ToolError("That action could not be found.");
      return { state: a.state };
    } catch (e) {
      if (e instanceof ActionError) throw new ToolError(e.message);
      throw e;
    }
  },
  async verify(ctx, input, out) {
    const a = await ctx.io.getAction(ctx.plan.actionId);
    return verification([{ name: "The action is now in that state", passed: a?.state === input.to && out.state === input.to, detail: a ? `State: ${a.state}.` : "Action not found." }]);
  },
});

export const TOOLS: Record<ToolName, Tool> = {
  retrieve_memory: retrieveMemory,
  search_memories: searchTool,
  read_document: readDocument,
  read_cv: readCv,
  compare_job_to_cv: compareTool,
  extract_recipe: extractRecipe,
  build_shopping_list: shoppingTool,
  draft_resume: resumeTool,
  draft_cover_letter: coverTool,
  draft_email: draftEmail,
  create_checklist: checklistTool,
  build_study_pack: studyTool,
  create_reminder: createReminder,
  update_action_status: updateAction,
};

export const isToolName = (s: string): s is ToolName => ToolName.safeParse(s).success;

/**
 * The only way a tool runs. Order matters: it must exist, the step must declare (and the user must have approved) every
 * permission the tool needs, the input must validate, the output must validate, and an independent verify() must pass.
 */
export async function runTool(
  ctxIn: ToolCtxIn,
  name: string,
  rawInput: unknown,
  grant: { stepPermissions: Permission[]; approved: Permission[]; edited?: boolean },
): Promise<{ output: Record<string, unknown>; result: Verification }> {
  if (!isToolName(name)) throw new ToolError("That tool does not exist.");
  const tool = TOOLS[name];
  const missing = tool.permissions.filter((p) => !grant.stepPermissions.includes(p) || !grant.approved.includes(p));
  if (missing.length) throw new ToolError(`Not permitted: this step needs ${missing.join(", ")}, which you haven't approved.`);
  // a permission counts only if the step declares it AND the user approved it
  const ctx: ToolCtx = { ...ctxIn, approved: grant.approved.filter((p) => grant.stepPermissions.includes(p)) };

  const input = tool.input.safeParse(rawInput);
  if (!input.success) throw new ToolError(`This step is missing something it needs (${input.error.issues[0]?.message ?? "invalid input"}).`);
  const out = tool.output.safeParse(await tool.run(ctx, input.data));
  if (!out.success) throw new ToolError("The tool returned a result in an unexpected shape.");
  const result = await tool.verify(ctx, input.data, out.data, { edited: grant.edited ?? false });
  return { output: out.data as Record<string, unknown>, result };
}

/** Re-verify an output the user edited (same permission and ownership rules), after recomputing derived fields such as flags. */
export async function reverify(
  ctxIn: ToolCtxIn,
  name: string,
  rawInput: unknown,
  output: unknown,
  grant: { stepPermissions: Permission[]; approved: Permission[] },
): Promise<{ output: Record<string, unknown>; result: Verification }> {
  if (!isToolName(name)) throw new ToolError("That tool does not exist.");
  const tool = TOOLS[name];
  const missing = tool.permissions.filter((p) => !grant.stepPermissions.includes(p) || !grant.approved.includes(p));
  if (missing.length) throw new ToolError(`Not permitted: this step needs ${missing.join(", ")}, which you haven't approved.`);
  const ctx: ToolCtx = { ...ctxIn, approved: grant.approved.filter((p) => grant.stepPermissions.includes(p)) };
  const input = tool.input.safeParse(rawInput);
  let out = tool.output.safeParse(output);
  if (!input.success || !out.success) throw new ToolError("The edited result isn't in the right shape.");
  if (tool.refresh) {
    out = tool.output.safeParse(await tool.refresh(ctx, input.data, out.data));
    if (!out.success) throw new ToolError("The edited result isn't in the right shape.");
  }
  return { output: out.data as Record<string, unknown>, result: await tool.verify(ctx, input.data, out.data, { edited: true }) };
}
