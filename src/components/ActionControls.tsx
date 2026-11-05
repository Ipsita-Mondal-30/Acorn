"use client";

import { useState } from "react";
import type { ActionState, ExecutionKind } from "@/lib/schema";
import { api } from "./api";
import { useMutation } from "./MemoryControls";
import { buttonClass, fieldClass } from "./ui";

const VERB: Record<ActionState, string> = {
  proposed: "Back to proposed",
  awaiting_approval: "Request approval",
  approved: "Approve",
  in_progress: "Start",
  completed: "Mark complete",
  failed: "Mark failed",
  cancelled: "Cancel",
};

const KINDS: { value: ExecutionKind; label: string }[] = [
  { value: "suggested", label: "Suggested" },
  { value: "simulated", label: "Simulated" },
  { value: "executed", label: "Executed" },
];

function Status({ pending, error }: { pending: boolean; error: string | null }) {
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {pending && <span className="text-ink-soft">Saving…</span>}
      {error && <span className="text-danger">{error}</span>}
    </p>
  );
}

export function PlanButton({ memoryId, title }: { memoryId: string; title: string }) {
  const m = useMutation();
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={m.pending}
        className={`${buttonClass.secondary} justify-start text-left`}
        onClick={() => m.run(() => api("/api/actions", { method: "POST", body: { memoryId, title } }))}
      >
        <span aria-hidden="true" className="text-moss">
          +
        </span>
        <span>
          <span className="sr-only">Plan this: </span>
          {title}
        </span>
      </button>
      {m.error && <span className="mt-1 text-sm text-danger">{m.error}</span>}
    </span>
  );
}

export function CustomPlanForm({ memoryId }: { memoryId: string }) {
  const m = useMutation();
  const [title, setTitle] = useState("");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim())
          m.run(() => api("/api/actions", { method: "POST", body: { memoryId, title } }), () => setTitle(""));
      }}
    >
      <label htmlFor={`plan-${memoryId}`} className="sr-only">
        Plan something else
      </label>
      <input
        id={`plan-${memoryId}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        placeholder="Plan something else…"
        className={`${fieldClass} min-w-0 flex-1 basis-48 rounded-full`}
      />
      <button type="submit" disabled={m.pending || !title.trim()} className={buttonClass.secondary}>
        Add plan
      </button>
      <Status pending={false} error={m.error} />
    </form>
  );
}

type Prompt = { to?: ActionState; kind?: ExecutionKind } | null;

export function ActionControls({
  action,
  next,
}: {
  action: { id: string; state: ActionState; kind: ExecutionKind; evidence?: string };
  next: ActionState[];
}) {
  // Mirrors lib/actions: kind is fixed once work starts; a bare suggestion can't be started or completed.
  const kindEditable = action.state === "proposed" || action.state === "awaiting_approval" || action.state === "approved";
  const blocked = (to: ActionState) => action.kind === "suggested" && (to === "in_progress" || to === "completed");
  const m = useMutation();
  // Evidence prompt: completing an executed action, or switching to executed.
  const [prompt, setPrompt] = useState<Prompt>(null);
  const patch = (body: object) => m.run(() => api("/api/actions", { method: "PATCH", body: { id: action.id, ...body } }), () => setPrompt(null));

  return (
    <div className="space-y-3">
      {next.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {next.map((to) => (
            <button
              key={to}
              type="button"
              disabled={m.pending || blocked(to)}
              className={to === "cancelled" || to === "failed" ? buttonClass.quiet : buttonClass.secondary}
              onClick={() => (to === "completed" && action.kind === "executed" ? setPrompt({ to }) : patch({ to }))}
            >
              {VERB[to]}
            </button>
          ))}
        </div>
      )}

      {next.some(blocked) && (
        <p className="text-xs text-ink-faint">A suggestion is only an idea — switch it to Simulated or Executed before starting.</p>
      )}

      {kindEditable && (
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">How real is this action?</legend>
        <span className="text-xs font-medium text-ink-faint" aria-hidden="true">
          Kind
        </span>
        <div className="inline-flex rounded-full border border-line bg-paper-deep p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              aria-pressed={action.kind === k.value}
              disabled={m.pending || action.kind === k.value}
              onClick={() => (k.value === "executed" ? setPrompt({ kind: "executed" }) : patch({ kind: k.value }))}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:text-ink aria-pressed:bg-card aria-pressed:text-ink aria-pressed:shadow-card disabled:cursor-default"
            >
              {k.label}
            </button>
          ))}
        </div>
      </fieldset>
      )}

      {prompt && (
        <form
          className="space-y-2 rounded-xl border border-line bg-paper p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const evidence = String(new FormData(e.currentTarget).get("evidence") ?? "").trim();
            patch({ ...prompt, evidence });
          }}
        >
          <label htmlFor={`ev-${action.id}`} className="block text-sm font-medium">
            What shows this really happened?
          </label>
          <textarea
            id={`ev-${action.id}`}
            name="evidence"
            required
            rows={2}
            maxLength={2000}
            defaultValue={action.evidence}
            placeholder="e.g. Confirmation email from careers@lumen.com, 14 Oct"
            className={fieldClass}
          />
          <p className="text-xs text-ink-faint">
            &ldquo;Executed&rdquo; means it happened in the real world. Acorn only records it — it never does it for you.
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={m.pending} className={buttonClass.primary}>
              {prompt.to ? "Mark complete" : "Mark as executed"}
            </button>
            <button type="button" className={buttonClass.quiet} onClick={() => setPrompt(null)}>
              Never mind
            </button>
          </div>
        </form>
      )}
      <Status pending={m.pending} error={m.error} />
    </div>
  );
}
