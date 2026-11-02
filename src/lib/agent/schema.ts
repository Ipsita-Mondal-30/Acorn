import { z } from "zod";
import { IntentKind } from "../schema";

// The typed contract of the agent engine. A Plan is DATA: it names registered tools and their inputs, and nothing
// in it can run by itself. The executor (executor.ts) is the only thing that runs steps, one at a time, after approval.

/**
 * What a step may touch. There is deliberately no permission for the outside world (sending, submitting, paying):
 * a plan cannot ask for one, and no tool needs one. Adding such a permission is a product decision, not a refactor.
 */
export const Permission = z.enum(["memory:read", "profile:cv:read", "reminder:write", "action:write", "compute", "embed:text"]);
export type Permission = z.infer<typeof Permission>;

export const PERMISSION_LABEL: Record<Permission, string> = {
  "memory:read": "Read your saved memories",
  "profile:cv:read": "Read the CV you gave Acorn",
  "reminder:write": "Create a reminder for you",
  "action:write": "Update the status of this action",
  compute: "Work out drafts and checklists inside Acorn (nothing is sent anywhere)",
  "embed:text": "Send short snippets of your CV and the job to your embedding service to compare meaning (a small paid call)",
};

export const ToolName = z.enum([
  "retrieve_memory",
  "search_memories",
  "read_document",
  "read_cv",
  "compare_job_to_cv",
  "extract_recipe",
  "build_shopping_list",
  "draft_resume",
  "draft_cover_letter",
  "draft_email",
  "create_checklist",
  "create_reminder",
  "update_action_status",
]);
export type ToolName = z.infer<typeof ToolName>;

export const Workflow = z.enum(["job_application", "recipe", "followup"]);
export type Workflow = z.infer<typeof Workflow>;

export const WORKFLOW_LABEL: Record<Workflow, string> = {
  job_application: "Job application assistant",
  recipe: "Recipe → shopping list",
  followup: "Follow-through plan",
};

export const StepState = z.enum(["pending", "running", "awaiting_review", "succeeded", "failed", "skipped"]);
export type StepState = z.infer<typeof StepState>;

export const PlanStatus = z.enum(["awaiting_approval", "approved", "running", "awaiting_you", "completed", "failed", "rejected"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const Check = z.object({ name: z.string().max(200), passed: z.boolean(), detail: z.string().max(500) });
export type Check = z.infer<typeof Check>;
export const Verification = z.object({ passed: z.boolean(), checks: z.array(Check).max(30) });
export type Verification = z.infer<typeof Verification>;

export const StepEvent = z.object({ at: z.string(), event: z.string().max(60), note: z.string().max(500).optional() });

export const PlanStep = z.object({
  id: z.string().min(1).max(20),
  title: z.string().min(1).max(200),
  /** why this step exists, in the user's terms */
  why: z.string().max(400),
  /** "tool": Acorn runs a registered tool. "user": only the user can do it (e.g. apply on a website) and must say what happened. */
  kind: z.enum(["tool", "user"]),
  tool: ToolName.optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).max(10).default([]),
  permissions: z.array(Permission).max(6).default([]),
  expected: z.string().max(300),
  /** the criteria the executor checks before it calls this step done (in words; the tool's verify() does the checking) */
  verification: z.string().max(300),
  failureConditions: z.array(z.string().max(200)).max(6).default([]),
  /** the output must be looked at (and may be edited) by the user before dependent steps run */
  reviewRequired: z.boolean().default(false),
  /** may be skipped by the user, and a missing input (e.g. a date) just leaves it waiting */
  optional: z.boolean().default(false),
  /** input fields only the user may supply (e.g. "dueAt"); the step waits until they are present */
  userInputs: z.array(z.string()).max(3).default([]),
  state: StepState.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  output: z.record(z.string(), z.unknown()).optional(),
  result: Verification.optional(),
  error: z.string().max(500).optional(),
  /** user steps: what the user says happened (needed to finish) */
  evidence: z.string().max(2000).optional(),
  /** the user changed the output */
  edited: z.boolean().default(false),
  history: z.array(StepEvent).default([]),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  id: z.string(),
  memoryId: z.string(),
  /** the action (existing state machine) this plan belongs to: it holds approval and the final evidence */
  actionId: z.string(),
  workflow: Workflow,
  intentKind: IntentKind,
  goal: z.string().min(1).max(300),
  context: z.object({
    memoryIds: z.array(z.string()).max(20),
    summary: z.string().max(1000),
    /** verbatim quotes from the saved item that the plan rests on */
    evidence: z.array(z.object({ quote: z.string().max(500), supports: z.string().max(100) })).max(15),
  }),
  status: PlanStatus,
  permissionsRequested: z.array(Permission).max(6),
  /** set when the user approves; the executor refuses any step that needs more than this */
  approvedPermissions: z.array(Permission).max(6).default([]),
  steps: z.array(PlanStep).min(1).max(15),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(StepEvent).default([]),
});
export type Plan = z.infer<typeof Plan>;

// ───────────────────────── reminders ─────────────────────────

export const ReminderStatus = z.enum(["scheduled", "done", "snoozed", "dismissed"]);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const ReminderKind = z.enum(["manual", "intent", "deadline", "follow_up", "recipe", "event"]);
export type ReminderKind = z.infer<typeof ReminderKind>;
export const REMINDER_KIND_LABEL: Record<ReminderKind, string> = {
  manual: "Your reminder",
  intent: "From your confirmed intent",
  deadline: "Before a deadline",
  follow_up: "Follow-up",
  recipe: "Cooking",
  event: "Event",
};

export const Reminder = z.object({
  id: z.string(),
  memoryId: z.string(),
  actionId: z.string().nullable().default(null),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).default(""),
  dueAt: z.string(),
  /** why it exists: "manual" is yours alone; every other kind needs an intent you confirmed on the memory */
  kind: ReminderKind.default("manual"),
  /** the time zone it was set in (display only: dueAt is an absolute instant) */
  timezone: z.string().max(64).nullable().default(null),
  /** how many times it was snoozed: the follow-through check uses it to notice a reminder that keeps being put off */
  snoozeCount: z.number().int().nonnegative().default(0),
  status: ReminderStatus,
  history: z.array(z.object({ at: z.string(), status: ReminderStatus.or(z.literal("edited")), note: z.string().max(500).optional() })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reminder = z.infer<typeof Reminder>;

/** Steps done out of steps that count (skipped optional steps leave the total). */
export function planProgress(p: Plan): { done: number; total: number; percent: number } {
  const counted = p.steps.filter((s) => s.state !== "skipped");
  const done = counted.filter((s) => s.state === "succeeded").length;
  return { done, total: counted.length, percent: counted.length ? Math.round((done / counted.length) * 100) : 0 };
}
