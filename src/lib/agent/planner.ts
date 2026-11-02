import "server-only";
import { effective, INTENT_LABEL, type Memory } from "../schema";
import { workflowFor } from "./intents";
import { Plan, PlanStep, type Permission, type PlanStep as Step, type Workflow } from "./schema";
import { ActionError } from "../actions";
import { embeddingStatus } from "../ai/embeddings";
import { TOOLS } from "./tools";

// The planner turns a memory the user has CONFIRMED an intent for into a typed Plan. It chooses from the tool
// registry and nothing else; it does not run anything. Plans come from fixed templates over real data in the memory
// (no model writes steps), and every plan passes validatePlan before it is stored.

export class PlanError extends ActionError {
  override name = "PlanError";
}

export type Ref = { $from: string; path?: string };
export const isRef = (v: unknown): v is Ref => typeof v === "object" && v !== null && typeof (v as Ref).$from === "string";
const ref = (step: string, path?: string): Ref => ({ $from: step, ...(path ? { path } : {}) });

const MAX_STEPS = 15;

/** A reminder date derived from a REAL deadline: the day before at 09:00 UTC if still ahead, else the deadline day. */
export function reminderForDeadline(deadline: string, now: Date): string | null {
  const day = new Date(`${deadline}T09:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return null;
  const before = new Date(day.getTime() - 24 * 3600_000);
  if (before.getTime() > now.getTime()) return before.toISOString();
  return day.getTime() > now.getTime() ? day.toISOString() : null;
}

type Draft = Omit<Partial<Step>, "id" | "kind" | "title"> & { id: string; kind: Step["kind"]; title: string; why: string; expected: string; verification: string };
const step = (d: Draft): Step =>
  PlanStep.parse({
    failureConditions: [],
    permissions: d.kind === "tool" && d.tool ? TOOLS[d.tool].permissions : [],
    ...d,
  });

const retrieve = (memoryId: string): Step =>
  step({
    id: "s1", kind: "tool", tool: "retrieve_memory", title: "Read the saved memory", why: "Everything in this plan rests on what you saved, so it starts by re-reading it.",
    input: { memoryId }, expected: "The memory's facts, dates and text",
    verification: "Re-reads the memory and compares", failureConditions: ["The memory was deleted", "Acorn hasn't finished reading it"],
  });

const userStep = (id: string, title: string, why: string, deps: string[]): Step =>
  step({
    id, kind: "user", title, why, dependsOn: deps, expected: "You do this yourself, then tell Acorn what happened",
    verification: "You record what happened (at least 10 characters, e.g. a confirmation number, link or note)", failureConditions: ["You haven't done it yet"],
  });

function reminderStep(id: string, memoryId: string, title: string, dueAt: string | null, deps: string[], why: string, kind: "intent" | "deadline" | "follow_up" | "recipe" | "event" = "intent"): Step {
  return step({
    id, kind: "tool", tool: "create_reminder", optional: true, userInputs: ["dueAt"], title: "Create a reminder", why, dependsOn: deps,
    input: { memoryId, title, note: "", kind, ...(dueAt ? { dueAt } : {}) }, expected: "A reminder in Acorn, linked to this memory",
    verification: "Reads the reminder back from your reminders", failureConditions: ["The date is in the past"],
  });
}

function jobPlan(m: Memory, now: Date): Step[] {
  const job = m.extraction?.job;
  const v = effective(m);
  const label = [job?.role, job?.company].filter(Boolean).join(" at ") || v.title;
  const steps: Step[] = [retrieve(m.id)];
  if (job?.company) {
    steps.push(step({
      id: "s2", kind: "tool", tool: "search_memories", optional: true, title: `Look for other memories about ${job.company}`, why: "Related things you saved may help your application.",
      dependsOn: ["s1"], input: { query: job.company, limit: 5 }, expected: "A short list of your own related memories", verification: "Checks every result is one of your memories",
    }));
  }
  steps.push(
    step({ id: "s3", kind: "tool", tool: "read_cv", title: "Check your CV is on file", why: "Acorn compares the job with your own CV, so it needs one.", dependsOn: ["s1"], expected: "Your CV is present", verification: "Reads the stored CV size back", failureConditions: ["No CV added yet"] }),
    step({
      id: "s4", kind: "tool", tool: "compare_job_to_cv", title: "Compare requirements with your CV", why: "Shows which requirements your CV supports, partly supports, or does not show.",
      dependsOn: ["s1", "s3"], input: { job: ref("s1", "job") }, reviewRequired: true,
      // comparing meaning sends short snippets to the embedding service, so it is a separate permission, asked for only when one is set up
      permissions: [...TOOLS.compare_job_to_cv.permissions, ...(embeddingStatus().configured ? (["embed:text"] as const) : [])],
      expected: "Each requirement marked verified, potential, unverified or missing, with your CV's own words as evidence",
      verification: "Every quote is in your CV at the place it points to; only wording can verify; anything ambiguous asks you", failureConditions: ["The saved item is not a job listing", "The job lists no requirements"],
    }),
    step({
      id: "s5", kind: "tool", tool: "draft_resume", title: "Draft a tailored resume", why: "Lays out your own CV with the lines that back this role first and the dates you gave. Nothing is rewritten or added.",
      dependsOn: ["s1", "s4"], input: { job: ref("s1", "job"), results: ref("s4", "results") }, reviewRequired: true, expected: "Your CV, reordered for this job, every line traceable to its place in your CV",
      verification: "Every line points to its CV text; no bullet dropped; unbacked requirements are not claimed", failureConditions: ["No CV"],
    }),
    step({
      id: "s6", kind: "tool", tool: "draft_cover_letter", title: "Draft a cover letter", why: "Quotes your CV for what you meet and leaves marked blanks for what you don't.",
      dependsOn: ["s1", "s4"], input: { job: ref("s1", "job"), results: ref("s4", "results") }, reviewRequired: true, expected: "A letter whose claims are your CV lines, with [TO COMPLETE] for what your CV doesn't back",
      verification: "Every claim traces to your CV and to a verified or confirmed match", failureConditions: ["No CV"],
    }),
    step({
      id: "s7", kind: "tool", tool: "create_checklist", title: "Make an application checklist", why: "Keeps the deadline and the open questions in one place.",
      dependsOn: ["s1", "s4"], input: { job: ref("s1", "job"), results: ref("s4", "results") }, reviewRequired: true, expected: "A checklist, all unchecked",
      verification: "Has the saved deadline; nothing is pre-ticked",
    }),
  );
  const due = job?.deadline ? reminderForDeadline(job.deadline, now) : null;
  steps.push(reminderStep("s8", m.id, `Apply: ${label}`, due, ["s1"], job?.deadline ? `Based on the deadline in the listing (${job.deadline}).` : "The listing shows no deadline, so pick a date if you want a reminder.", job?.deadline ? "deadline" : "intent"));
  steps.push(userStep("s9", "Review, then apply yourself on the employer's site", "Acorn never submits applications. When you have, record the confirmation so this is tracked as done.", ["s5", "s6", "s7"]));
  return steps;
}

function recipePlan(m: Memory): Step[] {
  const v = effective(m);
  return [
    retrieve(m.id),
    step({
      id: "s2", kind: "tool", tool: "extract_recipe", title: "Pull out the ingredients and method", why: "Reads them from the saved recipe's own words.",
      dependsOn: ["s1"], input: { title: ref("s1", "title"), text: ref("s1", "readableText"), entities: ref("s1", "entities") }, expected: "Ingredients with quantities where written, and the method",
      verification: "Every ingredient and step appears in the saved recipe", failureConditions: ["No ingredients found in the text"],
    }),
    step({
      id: "s3", kind: "tool", tool: "build_shopping_list", title: "Build a shopping list", why: "Merges duplicates and keeps your quantities. You can edit the list.",
      dependsOn: ["s2"], input: { recipe: ref("s2") }, reviewRequired: true, expected: "A shopping list of the recipe's ingredients, plus clearly labelled substitution ideas",
      verification: "Items are the recipe's ingredients; items you add are marked as yours; ideas are labelled inferred",
    }),
    reminderStep("s4", m.id, `Cook: ${v.title}`, null, ["s3"], "Optional. Pick when you want to be reminded to cook it.", "recipe"),
  ];
}

const GENERIC: Record<string, { items: string[]; user: string }> = {
  reconnect: { items: ["Decide how you'd like to reach out", "Send the message yourself, from your own email or app", "Note their reply, or a date to follow up"], user: "Reach out yourself, then note what happened" },
  attend: { items: ["Check the date, time and place", "Register or RSVP yourself on the organiser's page", "Put it in your calendar"], user: "Register yourself, then note the confirmation" },
  learn: { items: ["Set aside time to read or watch it", "Write down the three most useful things", "Try one idea in practice"], user: "Study it, then note what you learned" },
  buy: { items: ["Compare price and alternatives", "Decide your budget", "Buy it yourself (Acorn never spends money)"], user: "Decide or buy, then note what you did" },
  follow_up: { items: ["Decide what you are following up on, and with whom", "Write your message (Acorn can draft it; you send it)", "Choose when to check back"], user: "Follow up yourself, then note what happened" },
  try: { items: ["Pick a time to try it", "Gather what you need", "Try it and note how it went"], user: "Try it, then note how it went" },
};

function followupPlan(m: Memory, now: Date): Step[] {
  const v = effective(m);
  const kind = v.intentKind ?? "other";
  const g = GENERIC[kind] ?? { items: m.extraction?.nextActions.map((n) => n.label) ?? [], user: "Do it, then note what happened" };
  const items = g.items.length ? g.items : ["Decide what you want to do with this", "Do it yourself", "Note what happened"];
  const person = m.extraction?.entities.find((e) => e.kind === "person")?.name ?? null;
  const steps: Step[] = [retrieve(m.id)];
  let last = "s1";
  if (kind === "reconnect" || kind === "follow_up") {
    steps.push(step({
      id: "s2", kind: "tool", tool: "draft_email", title: "Draft a message to send yourself", why: "A starting point you can edit. It claims nothing about past conversations, and Acorn never sends it.",
      dependsOn: ["s1"], input: { purpose: kind === "follow_up" ? "follow_up" : "reconnect", name: person, context: v.summary ? v.summary.slice(0, 200) : null }, reviewRequired: true,
      expected: "A short draft with [placeholders] for anything unknown", verification: "It is marked as not sent; it names the person only if known",
    }));
    last = "s2";
  }
  steps.push(step({
    id: `s${steps.length + 1}`, kind: "tool", tool: "create_checklist", title: "Make a checklist", why: `Small steps for "${INTENT_LABEL[kind]}".`,
    dependsOn: [last], input: { items }, reviewRequired: true, expected: "A checklist, all unchecked", verification: "Has items and nothing is pre-ticked",
  }));
  const checklistId = steps.at(-1)!.id;
  const eventDate = m.extraction?.dates.find((d) => !d.isDeadline && d.evidence && new Date(`${d.date}T09:00:00.000Z`) > now)?.date;
  const when = v.deadline ? reminderForDeadline(v.deadline, now) : eventDate ? reminderForDeadline(eventDate, now) : null;
  const whenWhy = v.deadline ? `Based on the deadline in the item (${v.deadline}).` : eventDate ? `Based on the date in the item (${eventDate}).` : "The item states no date, so pick one if you want a reminder.";
  steps.push(reminderStep(`s${steps.length + 1}`, m.id, v.title.slice(0, 180), when, [checklistId], whenWhy, kind === "follow_up" || kind === "reconnect" ? "follow_up" : kind === "attend" && v.contentType === "event" ? "event" : v.deadline ? "deadline" : "intent"));
  steps.push(userStep(`s${steps.length + 1}`, g.user, "Acorn doesn't act outside the app. Record what happened so this is tracked honestly.", [checklistId]));
  return steps;
}

export function validatePlan(plan: Plan): void {
  const ids = new Set(plan.steps.map((s) => s.id));
  if (ids.size !== plan.steps.length) throw new PlanError("Plan has duplicate step ids.");
  if (plan.steps.length > MAX_STEPS) throw new PlanError("Plan has too many steps.");
  const requested = new Set<Permission>();
  for (const s of plan.steps) {
    if (s.kind === "tool") {
      if (!s.tool || !(s.tool in TOOLS)) throw new PlanError(`Step ${s.id} names a tool that doesn't exist.`);
      const tool = TOOLS[s.tool];
      if (tool.external) throw new PlanError(`Step ${s.id} would act outside Acorn, which plans can't do.`);
      const missing = tool.permissions.filter((p) => !s.permissions.includes(p));
      if (missing.length) throw new PlanError(`Step ${s.id} doesn't declare the permissions its tool needs (${missing.join(", ")}).`);
      s.permissions.forEach((p) => requested.add(p));
    } else if (s.tool || s.permissions.length) {
      throw new PlanError(`Step ${s.id} is yours to do, so it can't name a tool.`);
    }
    for (const d of s.dependsOn) if (!ids.has(d) || d === s.id) throw new PlanError(`Step ${s.id} depends on an unknown step.`);
    for (const v of Object.values(s.input)) {
      if (isRef(v) && !s.dependsOn.includes(v.$from)) throw new PlanError(`Step ${s.id} reads from ${v.$from} without depending on it.`);
    }
  }
  // no cycles: repeatedly peel steps whose dependencies are already placed
  const placed = new Set<string>();
  while (placed.size < plan.steps.length) {
    const next = plan.steps.filter((s) => !placed.has(s.id) && s.dependsOn.every((d) => placed.has(d)));
    if (!next.length) throw new PlanError("Plan steps depend on each other in a loop.");
    next.forEach((s) => placed.add(s.id));
  }
  const declared = new Set(plan.permissionsRequested);
  if (requested.size !== declared.size || [...requested].some((p) => !declared.has(p))) throw new PlanError("The plan's permission list doesn't match its steps.");
}

/** Build and validate the plan for a memory. Throws PlanError if the user hasn't confirmed why they saved it. */
export function buildPlan(m: Memory, actionId: string, now: Date): Plan {
  const v = effective(m);
  if (m.status !== "ready" || !m.extraction) throw new PlanError("Acorn hasn't finished reading this memory yet.");
  if (!v.intentKind) throw new PlanError("Tell Acorn why you saved this first. Plans are only made for an intent you've confirmed, not for Acorn's guess.");
  const workflow = workflowFor(m) as Workflow;
  const steps = workflow === "job_application" ? jobPlan(m, now) : workflow === "recipe" ? recipePlan(m) : followupPlan(m, now);
  const goal =
    workflow === "job_application"
      ? `Prepare a truthful application for ${[m.extraction.job?.role, m.extraction.job?.company].filter(Boolean).join(" at ") || v.title}`
      : workflow === "recipe"
        ? `Get ready to cook: ${v.title}`
        : `${INTENT_LABEL[v.intentKind]}: ${v.title}`;
  const at = now.toISOString();
  const plan: Plan = {
    id: crypto.randomUUID(),
    memoryId: m.id,
    actionId,
    workflow,
    intentKind: v.intentKind,
    goal: goal.slice(0, 300),
    context: { memoryIds: [m.id], summary: v.summary.slice(0, 1000), evidence: m.extraction.evidence.slice(0, 8) },
    status: "awaiting_approval",
    permissionsRequested: [...new Set(steps.flatMap((s) => s.permissions))],
    approvedPermissions: [],
    steps,
    createdAt: at,
    updatedAt: at,
    history: [{ at, event: "planned", note: "Waiting for your approval. Nothing has run." }],
  };
  const checked = Plan.parse(plan);
  validatePlan(checked);
  return checked;
}
