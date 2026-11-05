import "server-only";
import { z } from "zod";
import { getEmbeddingProvider } from "../ai/embeddings";
import { MIN_EVIDENCE_CHARS, proposeAction, transition } from "../actions";
import { createReminder } from "../reminders";
import {
  getAction,
  getCv,
  getMemory,
  getPlan,
  getReminder,
  listMemories,
  listPlans,
  mutateAction,
  mutatePlan,
  upsertAction,
  upsertPlan,
} from "../store";
import { buildPlan, isRef, PlanError } from "./planner";
import { ChecklistItem } from "./job";
import { rescale, ShoppingItem } from "./recipe";
import { applyProgress, StudyPack, StudyProgress, withoutProgress } from "./study";
import type { Plan, PlanStep, Verification } from "./schema";
import { reverify, runTool, ToolError, type ToolCtxIn, type ToolIO } from "./tools";

// The executor is the only thing that runs plan steps. It never lets a model choose what runs: it walks the stored plan,
// one step at a time, only after the user approved it, and a step counts as done only when its tool's separate verify()
// passed (or, for steps that are the user's to do, when the user recorded what happened). Completion of the underlying
// action goes through the existing state machine, which refuses an executed action without evidence.

export { PlanError };
export const MAX_ATTEMPTS = 5;
/** A step stuck in "running" this long was interrupted (server restart, crash) and is failed so it can be retried. */
const STALE_MS = 2 * 60_000;
const ACTIVE = ["awaiting_approval", "approved", "running", "awaiting_you", "failed"] as const;

export function makeIO(now: Date): ToolIO {
  return {
    now,
    getMemory,
    listMemories,
    getCv: () => getCv(),
    embed: async (texts) => {
      const provider = getEmbeddingProvider();
      return provider ? provider.embed(texts) : null;
    },
    createReminder: (r) => createReminder(r, now),
    getReminder,
    getAction,
    mutateAction,
  };
}

const ctxFor = (plan: Plan, stepId: string, now: Date): ToolCtxIn => ({
  io: makeIO(now),
  plan: { id: plan.id, memoryId: plan.memoryId, actionId: plan.actionId, memoryIds: plan.context.memoryIds },
  stepId,
});

const at = (now: Date) => now.toISOString();
const event = (now: Date, e: string, note?: string) => ({ at: at(now), event: e, ...(note ? { note: note.slice(0, 500) } : {}) });
const patchStep = (p: Plan, id: string, fn: (s: PlanStep) => PlanStep, now: Date): Plan => ({
  ...p,
  updatedAt: at(now),
  steps: p.steps.map((s) => (s.id === id ? fn(s) : s)),
});

// ───────────────────────── create / approve / reject ─────────────────────────

export async function createPlan(memoryId: string, now = new Date()): Promise<{ plan: Plan; created: boolean } | null> {
  const memory = await getMemory(memoryId);
  if (!memory) return null;
  const existing = (await listPlans(memoryId)).find((p) => (ACTIVE as readonly string[]).includes(p.status));
  if (existing) return { plan: existing, created: false };

  const draftId = crypto.randomUUID();
  const draft = buildPlan(memory, draftId, now); // throws PlanError unless the user confirmed an intent
  const proposed = proposeAction(memory, { title: draft.goal.slice(0, 200), detail: `Plan with ${draft.steps.length} steps. Nothing runs until you approve it.`, kind: "executed" }, now);
  const asked = transition({ ...proposed, id: draftId }, "awaiting_approval", { note: "Acorn made a plan for you to review" }, now);
  await upsertAction(asked);
  try {
    return { plan: await upsertPlan(draft), created: true };
  } catch (e) {
    await mutateAction(draftId, (a) => transition(a, "cancelled", { note: "The plan couldn't be saved" }, now)).catch(() => {});
    throw e;
  }
}

export async function approvePlan(planId: string, now = new Date()): Promise<Plan | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  if (plan.status !== "awaiting_approval") throw new PlanError("This plan has already been decided.");
  await mutateAction(plan.actionId, (a) => transition(a, "approved", { note: "Approved by you" }, now));
  const approved = await mutatePlan(planId, (p) =>
    p.status !== "awaiting_approval"
      ? p
      : { ...p, status: "approved", approvedPermissions: p.permissionsRequested, updatedAt: at(now), history: [...p.history, event(now, "approved", "You approved the plan and the permissions it lists")] },
  );
  if (!approved) return null;
  return advance(planId, now);
}

export async function rejectPlan(planId: string, note: string | undefined, now = new Date()): Promise<Plan | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  if (plan.status === "completed" || plan.status === "rejected") throw new PlanError(`This plan is already ${plan.status}.`);
  await mutateAction(plan.actionId, (a) => (a.state === "cancelled" || a.state === "completed" ? a : transition(a, "cancelled", { note: note || "Rejected by you" }, now)));
  return mutatePlan(planId, (p) => ({ ...p, status: "rejected", updatedAt: at(now), history: [...p.history, event(now, "rejected", note || "You rejected the plan")] }));
}

// ───────────────────────── running ─────────────────────────

const get = (obj: unknown, path?: string): unknown => {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
};

/** Fill `{ $from, path }` references from earlier steps' outputs. A reference to a step that isn't done resolves to nothing. */
export function resolveInput(plan: Plan, s: PlanStep): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.input)) {
    if (!isRef(v)) {
      out[k] = v;
      continue;
    }
    const src = plan.steps.find((x) => x.id === v.$from);
    if (src && src.state === "succeeded" && src.output) {
      const value = get(src.output, v.path);
      if (value !== undefined) out[k] = value;
    }
  }
  return out;
}

const waitingForInput = (s: PlanStep) => s.userInputs.some((k) => s.input[k] === undefined || s.input[k] === null);
const depsMet = (p: Plan, s: PlanStep) => s.dependsOn.every((d) => ["succeeded", "skipped"].includes(p.steps.find((x) => x.id === d)?.state ?? ""));
const nextRunnable = (p: Plan) => p.steps.find((s) => s.kind === "tool" && s.state === "pending" && depsMet(p, s) && !waitingForInput(s));

async function recoverStale(planId: string, now: Date) {
  await mutatePlan(planId, (p) => {
    let changed = false;
    const steps = p.steps.map((s) => {
      const last = s.history.at(-1);
      if (s.state === "running" && last && now.getTime() - Date.parse(last.at) > STALE_MS) {
        changed = true;
        return { ...s, state: "failed" as const, error: "This step was interrupted. Retry it.", history: [...s.history, event(now, "interrupted")] };
      }
      return s;
    });
    return changed ? { ...p, steps, updatedAt: at(now) } : p;
  });
}

async function ensureInProgress(actionId: string, now: Date) {
  await mutateAction(actionId, (a) => (a.state === "approved" || a.state === "failed" ? transition(a, "in_progress", { note: "Acorn started the plan" }, now) : a));
}

export async function advance(planId: string, now = new Date()): Promise<Plan | null> {
  await recoverStale(planId, now);
  for (let guard = 0; guard < 40; guard++) {
    const plan = await getPlan(planId);
    if (!plan) return null;
    if (!["approved", "running", "awaiting_you"].includes(plan.status)) return plan;
    if (plan.steps.some((s) => s.state === "running")) return plan; // another request is mid-step
    const next = nextRunnable(plan);
    if (!next) return settle(plan, now);

    let claimed = false;
    const after = await mutatePlan(planId, (p) => {
      claimed = false;
      const s = p.steps.find((x) => x.id === next.id);
      if (!s || s.state !== "pending") return p;
      claimed = true;
      return { ...patchStep(p, s.id, (x) => ({ ...x, state: "running", attempts: x.attempts + 1, error: undefined, history: [...x.history, event(now, "started")] }), now), status: "running" };
    });
    if (!after || !claimed) return after;
    await ensureInProgress(plan.actionId, now);
    await execute(after, next.id, now);
  }
  return getPlan(planId);
}

async function execute(plan: Plan, stepId: string, now: Date) {
  const s = plan.steps.find((x) => x.id === stepId)!;
  let outcome: { output: Record<string, unknown>; result: Verification } | { error: string };
  try {
    outcome = await runTool(ctxFor(plan, stepId, now), s.tool!, resolveInput(plan, s), { stepPermissions: s.permissions, approved: plan.approvedPermissions });
  } catch (e) {
    if (!(e instanceof ToolError)) console.error(`[agent] plan=${plan.id} step=${stepId} failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    outcome = { error: e instanceof ToolError ? e.message : "Something went wrong running this step. Try again." };
  }
  await mutatePlan(plan.id, (p) =>
    patchStep(p, stepId, (x) => {
      if ("error" in outcome) return { ...x, state: "failed", error: outcome.error.slice(0, 500), history: [...x.history, event(now, "failed", outcome.error)] };
      if (!outcome.result.passed) {
        const bad = outcome.result.checks.find((c) => !c.passed);
        const msg = `Acorn's check failed: ${bad?.name ?? "verification"}. ${bad?.detail ?? ""}`.trim();
        return { ...x, state: "failed", output: outcome.output, result: outcome.result, error: msg.slice(0, 500), history: [...x.history, event(now, "failed verification", msg)] };
      }
      return { ...x, state: x.reviewRequired ? "awaiting_review" : "succeeded", output: outcome.output, result: outcome.result, error: undefined, history: [...x.history, event(now, x.reviewRequired ? "ready for your review" : "succeeded and verified")] };
    }, now),
  );
}

/** Done means every step succeeded (or was skipped when optional), every tool result passed its checks, and every step of yours has your evidence. */
export function canComplete(p: Plan): boolean {
  return p.steps.every((s) => {
    if (s.state === "skipped") return s.optional;
    if (s.state !== "succeeded") return false;
    return s.kind === "tool" ? s.result?.passed === true : (s.evidence?.trim().length ?? 0) >= MIN_EVIDENCE_CHARS;
  });
}

function evidenceOf(p: Plan): string {
  const verified = p.steps.filter((s) => s.kind === "tool" && s.state === "succeeded");
  const yours = p.steps.filter((s) => s.kind === "user" && s.evidence);
  return [
    `Acorn ran and verified ${verified.length} step(s): ${verified.map((s) => s.title).join("; ")}.`,
    ...yours.map((s) => `You recorded for "${s.title}": ${s.evidence}`),
  ].join(" ").slice(0, 2000);
}

async function settle(plan: Plan, now: Date): Promise<Plan | null> {
  if (plan.steps.some((s) => s.state === "failed")) {
    await mutateAction(plan.actionId, (a) => (a.state === "in_progress" ? transition(a, "failed", { note: "A step failed" }, now) : a));
    return mutatePlan(plan.id, (p) => (p.status === "failed" ? p : { ...p, status: "failed", updatedAt: at(now), history: [...p.history, event(now, "failed", "A step failed. Fix the cause and retry it.")] }));
  }
  if (canComplete(plan)) {
    await ensureInProgress(plan.actionId, now);
    await mutateAction(plan.actionId, (a) => (a.state === "in_progress" ? transition(a, "completed", { note: "All steps verified", evidence: evidenceOf(plan) }, now) : a));
    return mutatePlan(plan.id, (p) => (p.status === "completed" ? p : { ...p, status: "completed", updatedAt: at(now), history: [...p.history, event(now, "completed", "Every step passed its checks")] }));
  }
  return mutatePlan(plan.id, (p) => (p.status === "awaiting_you" ? p : { ...p, status: "awaiting_you", updatedAt: at(now), history: [...p.history, event(now, "waiting for you")] }));
}

// ───────────────────────── your decisions ─────────────────────────

const stepOf = (p: Plan, id: string) => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new PlanError("That step isn't part of this plan.");
  return s;
};
const live = (p: Plan) => {
  if (!["approved", "running", "awaiting_you", "failed"].includes(p.status)) throw new PlanError(`This plan is ${p.status.replace("_", " ")}.`);
};

async function guarded(planId: string, check: (p: Plan) => void, fn: (p: Plan) => Plan, now: Date): Promise<Plan | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  check(plan);
  let failure: PlanError | null = null;
  const saved = await mutatePlan(planId, (p) => {
    failure = null;
    try {
      check(p);
      return fn(p);
    } catch (e) {
      if (e instanceof PlanError) {
        failure = e;
        return p;
      }
      throw e;
    }
  });
  if (failure) throw failure;
  return saved && advance(planId, now);
}

/** You looked at a draft (or list) and it's good: later steps may use it. */
export const approveReview = (planId: string, stepId: string, now = new Date()) =>
  guarded(planId, (p) => {
    live(p);
    if (stepOf(p, stepId).state !== "awaiting_review") throw new PlanError("There is nothing to review on this step.");
  }, (p) => patchStep(p, stepId, (s) => ({ ...s, state: "succeeded", history: [...s.history, event(now, "reviewed and accepted by you")] }), now), now);

export const completeUserStep = (planId: string, stepId: string, evidence: string, now = new Date()) =>
  guarded(planId, (p) => {
    live(p);
    const s = stepOf(p, stepId);
    if (s.kind !== "user") throw new PlanError("Only steps that are yours to do can be completed this way.");
    if (s.state !== "pending" || !depsMet(p, s)) throw new PlanError("Finish the earlier steps first.");
    if (evidence.trim().length < MIN_EVIDENCE_CHARS) throw new PlanError(`Say what happened and how to check it (at least ${MIN_EVIDENCE_CHARS} characters, e.g. a confirmation number, link or email subject).`);
  }, (p) => patchStep(p, stepId, (s) => ({ ...s, state: "succeeded", evidence: evidence.trim(), history: [...s.history, event(now, "recorded by you", evidence.trim())] }), now), now);

export const skipStep = (planId: string, stepId: string, now = new Date()) =>
  guarded(planId, (p) => {
    live(p);
    const s = stepOf(p, stepId);
    if (!s.optional) throw new PlanError("Only optional steps can be skipped.");
    if (s.state !== "pending") throw new PlanError("This step has already started.");
  }, (p) => patchStep(p, stepId, (s) => ({ ...s, state: "skipped", history: [...s.history, event(now, "skipped by you")] }), now), now);

const DueAt = z.iso.datetime({ offset: true });
export const setStepInput = (planId: string, stepId: string, field: string, value: string, now = new Date()) =>
  guarded(planId, (p) => {
    live(p);
    const s = stepOf(p, stepId);
    if (!s.userInputs.includes(field)) throw new PlanError("That field can't be set by you.");
    if (s.state !== "pending") throw new PlanError("This step has already started.");
    if (field === "dueAt") {
      if (!DueAt.safeParse(value).success) throw new PlanError("That date isn't valid.");
      if (new Date(value).getTime() < now.getTime()) throw new PlanError("Pick a date in the future.");
    }
  }, (p) => patchStep(p, stepId, (s) => ({ ...s, input: { ...s.input, [field]: field === "dueAt" ? new Date(value).toISOString() : value }, history: [...s.history, event(now, "input set by you", field)] }), now), now);

export const retryStep = (planId: string, stepId: string, now = new Date()) =>
  guarded(planId, (p) => {
    live(p);
    const s = stepOf(p, stepId);
    if (s.state !== "failed") throw new PlanError("Only a failed step can be retried.");
    if (s.attempts >= MAX_ATTEMPTS) throw new PlanError(`This step has failed ${MAX_ATTEMPTS} times. Fix the cause (or reject the plan) instead of retrying again.`);
  }, (p) => ({ ...patchStep(p, stepId, (s) => ({ ...s, state: "pending", error: undefined, output: undefined, result: undefined, history: [...s.history, event(now, "retry requested by you")] }), now), status: "running" }), now);

// ───────────────────────── editing a draft ─────────────────────────

export const StepEdit = z
  .object({
    text: z.string().trim().min(1).max(20_000).optional(),
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    /** servings you want to cook for (the shopping list is rescaled from the extracted amounts) */
    servings: z.number().positive().max(200).optional(),
    /** your answer on ambiguous matches, by requirement number: "confirmed" (it is true) or "rejected" (it is not) */
    decisions: z.record(z.string().regex(/^\d{1,2}$/), z.enum(["confirmed", "rejected"])).optional(),
    /** study pack progress only (cards known / to review, questions answered, exercises done) */
    study: StudyProgress.optional(),
    items: z.array(z.object({ id: z.string().max(40).optional(), text: z.string().trim().min(1).max(300).optional(), name: z.string().trim().min(1).max(200).optional(), quantity: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(), done: z.boolean().optional(), checked: z.boolean().optional() }).strict()).min(1).max(80).optional(),
  })
  .strict();
export type StepEdit = z.infer<typeof StepEdit>;

const EDITABLE: Record<string, (keyof StepEdit)[]> = {
  compare_job_to_cv: ["decisions"],
  draft_resume: ["text"],
  draft_cover_letter: ["text"],
  draft_email: ["subject", "body"],
  create_checklist: ["items"],
  build_shopping_list: ["items", "servings"],
  build_study_pack: ["study"],
};

/** Apply the user's edit. Items they add or reword are marked as theirs, so what Acorn extracted stays distinguishable. */
export function applyEdit(tool: string, output: Record<string, unknown>, edit: StepEdit): Record<string, unknown> {
  const allowed = EDITABLE[tool] ?? [];
  const keys = (Object.keys(edit) as (keyof StepEdit)[]).filter((k) => edit[k] !== undefined);
  if (keys.length === 0) throw new PlanError("Nothing to change.");
  if (keys.some((k) => !allowed.includes(k))) throw new PlanError("That part of this step can't be edited.");
  const next: Record<string, unknown> = { ...output };
  for (const k of keys) {
    if (k === "decisions") {
      const results = [...((output.results as Record<string, unknown>[] | undefined) ?? [])];
      for (const [idx, decision] of Object.entries(edit.decisions!)) {
        const r = results[Number(idx)];
        if (!r) throw new PlanError("That requirement doesn't exist.");
        if (decision === "confirmed" && !["POTENTIAL_MATCH", "UNVERIFIED"].includes(String(r.status))) {
          throw new PlanError("Only a potential or unverified match can be confirmed. If it is true but missing, add it to your CV.");
        }
        results[Number(idx)] = { ...r, userDecision: decision };
      }
      next.results = results;
      continue;
    }
    if (k === "study") {
      try {
        next.study = undefined;
        Object.assign(next, applyProgress(StudyPack.parse(output), edit.study!));
      } catch (e) {
        throw new PlanError(e instanceof Error ? e.message : "That progress isn't valid.");
      }
      delete next.study;
      continue;
    }
    if (k === "servings") {
      const sv = output.servings as { original: number | null } | undefined;
      if (!sv?.original) throw new PlanError("This recipe doesn't say how many it serves, so Acorn can't scale it. Change the amounts yourself.");
      next.items = rescale(output.items as ShoppingItem[], sv.original, edit.servings!);
      next.servings = { original: sv.original, target: edit.servings };
      continue;
    }
    if (k !== "items") {
      next[k] = edit[k];
      continue;
    }
    const before = new Map(((output.items as { id: string }[]) ?? []).map((i) => [i.id, i as Record<string, unknown>]));
    const used = new Set<string>();
    next.items = edit.items!.map((raw, n) => {
      let id = raw.id && !used.has(raw.id) ? raw.id : `u${n + 1}-${used.size}`;
      while (used.has(id)) id += "x";
      used.add(id);
      const old = before.get(id);
      if (tool === "create_checklist") {
        const text = raw.text ?? (old?.text as string | undefined);
        if (!text) throw new PlanError("Every checklist item needs text.");
        return ChecklistItem.parse({ id, text, done: raw.done ?? false, by: old && old.text === text ? old.by : "you" });
      }
      const name = raw.name ?? (old?.name as string | undefined);
      if (!name) throw new PlanError("Every item needs a name.");
      const quantity = raw.quantity !== undefined ? raw.quantity : ((old?.quantity as number | null | undefined) ?? null);
      const unit = raw.unit !== undefined ? raw.unit : ((old?.unit as string | null | undefined) ?? null);
      const same = old && old.name === name && old.quantity === quantity && old.unit === unit;
      return ShoppingItem.parse({
        id,
        name,
        quantity,
        quantityMax: same ? (old.quantityMax ?? null) : null,
        // the extracted base only stays for items you didn't change, so servings never rescale your own numbers
        baseQuantity: same ? (old.baseQuantity ?? null) : null,
        unit,
        prep: same ? (old.prep ?? null) : null,
        note: same ? (old.note ?? null) : null,
        source: same ? old.source : "you",
        checked: raw.checked ?? false,
      });
    });
  }
  return next;
}

export async function editStep(planId: string, stepId: string, edit: StepEdit, now = new Date()): Promise<Plan | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  live(plan);
  const s = stepOf(plan, stepId);
  // marking study progress is not editing the pack: it stays possible after you accepted it, and it doesn't count as "edited by you"
  const progressOnly = s.tool === "build_study_pack" && Object.keys(edit).every((k) => k === "study");
  if (progressOnly && s.output && ["awaiting_review", "succeeded"].includes(s.state)) {
    const next = applyEdit(s.tool!, s.output, edit);
    const pack = StudyPack.parse(next);
    if (JSON.stringify(withoutProgress(pack)) !== JSON.stringify(withoutProgress(StudyPack.parse(s.output)))) throw new PlanError("Progress can't change the content of the pack.");
    return guarded(planId, (p) => {
      live(p);
      if (!["awaiting_review", "succeeded"].includes(stepOf(p, stepId).state)) throw new PlanError("This pack isn't available to update.");
    }, (p) => patchStep(p, stepId, (x) => ({ ...x, output: next, history: [...x.history.slice(-40), event(now, "progress updated by you")] }), now), now);
  }
  if (s.state !== "awaiting_review" || !s.output || !s.tool) throw new PlanError("Only a draft that is waiting for your review can be edited.");
  const edited = applyEdit(s.tool, s.output, edit);
  let output: Record<string, unknown>;
  let result: Verification;
  try {
    ({ output, result } = await reverify(ctxFor(plan, stepId, now), s.tool, resolveInput(plan, s), edited, { stepPermissions: s.permissions, approved: plan.approvedPermissions }));
  } catch (e) {
    if (e instanceof ToolError) throw new PlanError(e.message);
    throw e;
  }
  if (!result.passed) throw new PlanError(`That edit isn't valid: ${result.checks.find((c) => !c.passed)?.name ?? "a check failed"}.`);
  return guarded(planId, (p) => {
    live(p);
    if (stepOf(p, stepId).state !== "awaiting_review") throw new PlanError("This draft is no longer waiting for review.");
  }, (p) => patchStep(p, stepId, (x) => ({ ...x, output, result, edited: true, history: [...x.history, event(now, "edited by you")] }), now), now);
}

/** What the plan's action is allowed to be changed by: nothing but its plan. Used by the actions API. */
export async function planOwningAction(actionId: string): Promise<Plan | null> {
  return (await listPlans()).find((p) => p.actionId === actionId) ?? null;
}

