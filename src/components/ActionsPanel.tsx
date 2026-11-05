import { ACTION_STATE_LABEL, allowedNext, EXECUTION_KIND_LABEL } from "@/lib/actions";
import type { Action, ActionState, ExecutionKind, Memory } from "@/lib/schema";
import { ActionControls, CustomPlanForm, PlanButton } from "./ActionControls";
import { formatDateTime, safeHref } from "./format";
import { SectionHeading, Tag } from "./ui";

const STATE_TONE: Record<ActionState, "plain" | "moss" | "amber" | "danger"> = {
  proposed: "plain",
  awaiting_approval: "amber",
  approved: "moss",
  in_progress: "amber",
  completed: "moss",
  failed: "danger",
  cancelled: "plain",
};

const KIND_HINT: Record<ExecutionKind, string> = {
  suggested: "An idea only — nothing has happened.",
  simulated: "Demo only — Acorn pretended; nothing happened outside this app.",
  executed: "Really happened, backed by evidence you recorded.",
};

export function ActionStateBadge({ state }: { state: ActionState }) {
  return <Tag tone={STATE_TONE[state]}>{ACTION_STATE_LABEL[state]}</Tag>;
}

export function ExecutionKindBadge({ kind }: { kind: ExecutionKind }) {
  return (
    <span title={KIND_HINT[kind]}>
      <Tag tone={kind === "executed" ? "moss" : kind === "simulated" ? "amber" : "plain"}>{EXECUTION_KIND_LABEL[kind]}</Tag>
    </span>
  );
}

export function ActionsPanel({ memory, actions, planActionIds = [] }: { memory: Memory; actions: Action[]; planActionIds?: string[] }) {
  const byPlan = new Set(planActionIds);
  const x = memory.extraction;
  const applyUrl = safeHref(x?.job?.applyUrl);
  const planned = new Set(actions.map((a) => a.title.toLowerCase()));
  const suggestions = (x?.nextActions ?? []).filter((n) => !planned.has(n.label.toLowerCase()));

  return (
    <section aria-labelledby="actions-heading">
      <SectionHeading id="actions-heading">Do something with it</SectionHeading>
      <p className="max-w-prose text-[15px] text-ink-soft">
        Acorn helps you plan, approve and keep track — but in this version it never acts on the outside world itself. You
        do the doing; Acorn keeps the record honest.
      </p>

      {applyUrl && (
        <div className="mt-5 rounded-2xl border border-moss/25 bg-moss-soft/60 p-4">
          <a
            href={applyUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1.5 font-medium text-moss-ink underline underline-offset-4"
          >
            Open official application page
            <span aria-hidden="true">↗</span>
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <p className="mt-1 text-sm text-ink-soft">
            You apply yourself on the employer&apos;s site. Acorn won&apos;t fill in or submit anything — come back and mark
            it complete with evidence when you&apos;re done.
          </p>
        </div>
      )}

      {(suggestions.length > 0 || memory.status === "ready") && (
        <div className="mt-6">
          {suggestions.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-ink-soft">Acorn suggests</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <PlanButton key={s.label} memoryId={memory.id} title={s.label} />
                ))}
              </div>
            </>
          )}
          <div className="mt-3 max-w-lg">
            <CustomPlanForm memoryId={memory.id} />
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <ol className="mt-8 space-y-4">
          {actions.map((a) => (
            <li key={a.id} className="rounded-3xl border-2 border-line/80 bg-card p-4 shadow-card sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="font-display text-lg leading-snug">{a.title}</h3>
                <div className="flex flex-wrap gap-1.5">
                  <ExecutionKindBadge kind={a.kind} />
                  <ActionStateBadge state={a.state} />
                </div>
              </div>
              {a.detail && <p className="mt-1 text-[15px] text-ink-soft">{a.detail}</p>}
              {a.evidence && (
                <p className="mt-2 text-sm">
                  <span className="font-medium">Evidence:</span> <span className="text-ink-soft">{a.evidence}</span>
                </p>
              )}
              <div className="mt-4">
                {byPlan.has(a.id) ? (
                  <p className="text-sm text-ink-soft">Run by a plan above: approve, review and finish it there.</p>
                ) : (
                  <ActionControls action={{ id: a.id, state: a.state, kind: a.kind, evidence: a.evidence }} next={allowedNext(a)} />
                )}
              </div>
              {a.history.length > 0 && (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-ink-faint hover:text-ink">History</summary>
                  <ol className="mt-3 space-y-2 border-l border-line pl-4">
                    {a.history.map((h, i) => (
                      <li key={i} className="relative">
                        <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-line" aria-hidden="true" />
                        <span className="font-medium">{ACTION_STATE_LABEL[h.state]}</span>{" "}
                        <time dateTime={h.at} className="text-ink-faint">
                          {formatDateTime(h.at)}
                        </time>
                        {h.note && <p className="text-ink-soft">{h.note}</p>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
