import type { Action, ActionState, ExecutionKind, Memory } from "./schema";

// Pure action state machine. Every function returns a new Action; inputs are never mutated.

export class ActionError extends Error {
  override name = "ActionError";
}

export const TRANSITIONS: Record<ActionState, ActionState[]> = {
  proposed: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed", "failed", "cancelled"],
  failed: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

export const ACTION_STATE_LABEL: Record<ActionState, string> = {
  proposed: "Proposed",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const EXECUTION_KIND_LABEL: Record<ExecutionKind, string> = {
  suggested: "Suggested — not done",
  simulated: "Simulated (demo only)",
  executed: "Executed — verified",
};

/** "done" or "ok" is not evidence. */
export const MIN_EVIDENCE_CHARS = 10;

const KIND_EDITABLE: ActionState[] = ["proposed", "awaiting_approval", "approved"];

export const allowedNext = (action: Action): ActionState[] => TRANSITIONS[action.state];

export function proposeAction(
  memory: Memory,
  input: { title: string; detail?: string; kind?: ExecutionKind },
  now: Date,
): Action {
  const title = input.title.trim();
  if (!title) throw new ActionError("Action title is required");
  const at = now.toISOString();
  return {
    id: crypto.randomUUID(),
    memoryId: memory.id,
    title,
    detail: input.detail ?? "",
    kind: input.kind ?? "suggested",
    state: "proposed",
    history: [{ state: "proposed", at }],
    createdAt: at,
    updatedAt: at,
  };
}

export function transition(
  action: Action,
  to: ActionState,
  opts: { note?: string; evidence?: string },
  now: Date,
): Action {
  if (!TRANSITIONS[action.state].includes(to)) {
    throw new ActionError(`Can't go from "${ACTION_STATE_LABEL[action.state]}" to "${ACTION_STATE_LABEL[to]}"`);
  }
  // A suggestion is only an idea: it must become simulated or executed before it can run.
  if (action.kind === "suggested" && (to === "in_progress" || to === "completed")) {
    throw new ActionError("A suggested action can't be started or completed — mark it simulated or executed first");
  }
  const evidence = opts.evidence?.trim() || action.evidence;
  if (to === "completed" && action.kind === "executed" && (evidence?.trim().length ?? 0) < MIN_EVIDENCE_CHARS) {
    throw new ActionError(
      `An executed action needs evidence before it can be completed — say what happened and how to check it (at least ${MIN_EVIDENCE_CHARS} characters, e.g. a confirmation number, link or email subject)`,
    );
  }
  const at = now.toISOString();
  return {
    ...action,
    state: to,
    evidence,
    history: [...action.history, { state: to, at, ...(opts.note ? { note: opts.note } : {}) }],
    updatedAt: at,
  };
}

export function setKind(action: Action, kind: ExecutionKind, now: Date): Action {
  if (!KIND_EDITABLE.includes(action.state)) {
    throw new ActionError(`Can't change how an action runs once it is ${ACTION_STATE_LABEL[action.state].toLowerCase()}`);
  }
  return { ...action, kind, updatedAt: now.toISOString() };
}
