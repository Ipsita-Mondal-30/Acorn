import Link from "next/link";
import { intentSuggestion } from "@/lib/agent/intents";
import { PERMISSION_LABEL, planProgress, workflowLabel, type Plan, type PlanStatus, type PlanStep, type StepState } from "@/lib/agent/schema";
import { formatQuantity } from "@/lib/agent/recipe";
import type { StudyPack } from "@/lib/agent/study";
import type { Action, Memory } from "@/lib/schema";
import { type CvInfo, CvEditor, MakePlanButton, PlanDecision, RecordStep, RejectPlan, RetryStep, ReminderStepControls, ReviewControls } from "./AgentControls";
import { formatDateTime } from "./format";
import { Aiko, type Mood } from "./Aiko";
import { StudyPackView } from "./StudyPack";
import { SectionHeading, Tag } from "./ui";

const PLAN_TONE: Record<PlanStatus, "plain" | "moss" | "amber" | "danger"> = {
  awaiting_approval: "amber",
  approved: "moss",
  running: "amber",
  awaiting_you: "amber",
  completed: "moss",
  failed: "danger",
  rejected: "plain",
};
const PLAN_LABEL: Record<PlanStatus, string> = {
  awaiting_approval: "Waiting for your approval",
  approved: "Approved",
  running: "Running",
  awaiting_you: "Waiting for you",
  completed: "Completed and verified",
  failed: "Needs attention",
  rejected: "Rejected",
};
const STEP_TONE: Record<StepState, "plain" | "moss" | "amber" | "danger"> = { pending: "plain", running: "amber", awaiting_review: "amber", succeeded: "moss", failed: "danger", skipped: "plain" };
const STEP_LABEL: Record<StepState, string> = { pending: "Not yet", running: "Running", awaiting_review: "Review it", succeeded: "Done and checked", failed: "Failed", skipped: "Skipped" };

export function PlanPanel({ memory, plans, actions, cv }: { memory: Memory; plans: Plan[]; actions: Action[]; cv: CvInfo | null }) {
  const s = intentSuggestion(memory);
  const open = plans.find((p) => !["completed", "rejected"].includes(p.status));
  const isJob = s?.workflow === "job_application" || plans.some((p) => p.workflow === "job_application");
  if (!s && plans.length === 0) return null;

  return (
    <section aria-labelledby="agent-heading">
      <SectionHeading id="agent-heading">Let Acorn help you act on it</SectionHeading>

      {s && (
        <div className="rounded-3xl border-2 border-line/80 bg-card p-4 shadow-card sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg">{s.label}</h3>
            {s.isSuggestion ? <Tag tone="amber">Acorn&apos;s suggestion, not confirmed</Tag> : <Tag tone="moss">Your intent</Tag>}
            {s.confidence !== null && <span className="text-sm text-ink-faint">{Math.round(s.confidence * 100)}% sure</span>}
          </div>
          {s.rationale && <p className="mt-1 text-[15px] text-ink-soft">{s.rationale}</p>}
          {s.evidence.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {s.evidence.slice(0, 3).map((e, i) => (
                <li key={i}>
                  <span className="text-ink-faint">{e.supports}:</span> “{e.quote}”
                </li>
              ))}
            </ul>
          )}
          {s.dates.length > 0 && (
            <p className="mt-2 text-sm text-ink-soft">
              Dates in the item: {s.dates.map((d) => `${d.label} (${d.date})`).join(", ")}
            </p>
          )}
          {s.nextSteps.length > 0 && <p className="mt-2 text-sm text-ink-soft">Possible next steps: {s.nextSteps.join(" · ")}</p>}
          {s.isSuggestion && <p className="mt-3 text-sm text-ink-soft">Confirm why you saved this (above) and Acorn can make a plan. Until then it only has a guess.</p>}
          {!s.isSuggestion && s.workflow && !open && <div className="mt-4"><MakePlanButton memoryId={memory.id} label={plans.length ? `Start a new plan: ${workflowLabel(s.workflow, s.kind)}` : `Make a plan: ${workflowLabel(s.workflow, s.kind)}`} /></div>}
        </div>
      )}

      {isJob && <CvEditor cv={cv} />}

      <div className="mt-6 space-y-6">
        {plans.map((p) => (
          <PlanCard key={p.id} plan={p} action={actions.find((a) => a.id === p.actionId)} />
        ))}
      </div>

    </section>
  );
}

function planMood(plan: Plan): Mood {
  if (plan.status === "completed") return "celebrating";
  if (plan.status === "failed") return "confused";
  if (plan.status === "awaiting_approval") return "curious";
  return plan.intentKind === "learn" ? "learning" : "encouraging";
}

function PlanCard({ plan, action }: { plan: Plan; action: Action | undefined }) {
  const progress = planProgress(plan);
  const decided = plan.status !== "awaiting_approval";
  return (
    <article className="rounded-3xl border-2 border-line/80 bg-card p-4 shadow-card sm:p-5" aria-label={plan.goal}>
      <div className="flex items-center gap-3">
        <Aiko mood={planMood(plan)} size={64} className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold tracking-wide text-ink-faint uppercase">{workflowLabel(plan.workflow, plan.intentKind)}</p>
          <Tag tone={PLAN_TONE[plan.status]}>{PLAN_LABEL[plan.status]}</Tag>
        </div>
      </div>
      <h3 className="mt-2 font-display text-lg leading-snug">{plan.goal}</h3>

      {decided && plan.status !== "rejected" && (
        <div className="mt-3" aria-label={`Progress: ${progress.done} of ${progress.total} steps`}>
          <div className="h-2 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full rounded-full bg-moss transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="mt-1 text-sm text-ink-faint">
            {progress.done} of {progress.total} steps done
          </p>
        </div>
      )}

      {plan.status === "awaiting_approval" && (
        <div className="mt-4 rounded-2xl bg-butter-soft p-3 text-sm">
          <p className="font-medium">Nothing has run. If you approve, Acorn may:</p>
          <ul className="mt-1 list-disc pl-5 text-ink-soft">
            {plan.permissionsRequested.map((p) => (
              <li key={p}>{PERMISSION_LABEL[p]}</li>
            ))}
          </ul>
          <p className="mt-2 text-ink-soft">Acorn can&apos;t send messages, submit forms, spend money or contact anyone. The steps marked “you” are yours to do.</p>
        </div>
      )}

      <ol className="mt-5 space-y-4">
        {plan.steps.map((s, i) => (
          <StepRow key={s.id} plan={plan} step={s} index={i + 1} />
        ))}
      </ol>

      {plan.status === "awaiting_approval" && <PlanDecision planId={plan.id} />}
      {["approved", "running", "awaiting_you", "failed"].includes(plan.status) && (
        <div className="mt-4">
          <RejectPlan planId={plan.id} />
        </div>
      )}

      {plan.status === "completed" && action?.evidence && (
        <p className="mt-4 rounded-xl bg-moss-soft/60 p-3 text-sm">
          <span className="font-medium">Evidence:</span> <span className="text-ink-soft">{action.evidence}</span>
        </p>
      )}
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-ink-faint hover:text-ink">History</summary>
        <ol className="mt-2 space-y-1 border-l border-line pl-4">
          {plan.history.map((h, i) => (
            <li key={i}>
              <span className="font-medium">{h.event}</span> <time dateTime={h.at} className="text-ink-faint">{formatDateTime(h.at)}</time>
              {h.note && <span className="text-ink-soft"> · {h.note}</span>}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function StepRow({ plan, step, index }: { plan: Plan; step: PlanStep; index: number }) {
  const ready = step.dependsOn.every((d) => ["succeeded", "skipped"].includes(plan.steps.find((x) => x.id === d)?.state ?? ""));
  const live = ["approved", "running", "awaiting_you", "failed"].includes(plan.status);
  const output = step.output;
  return (
    <li className="rounded-xl border border-line/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          <span className="text-ink-faint">{index}. </span>
          {step.title}
          {step.kind === "user" && <span className="ml-2 align-middle"><Tag tone="amber">You do this</Tag></span>}
          {step.optional && <span className="ml-2 align-middle"><Tag>Optional</Tag></span>}
        </p>
        <Tag tone={STEP_TONE[step.state]}>{STEP_LABEL[step.state]}</Tag>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{step.why}</p>

      {plan.status === "awaiting_approval" && (
        <p className="mt-1 text-sm text-ink-faint">
          Expected: {step.expected}. Checked by: {step.verification}.
        </p>
      )}

      {output && step.tool && <StepOutput tool={step.tool} output={output} edited={step.edited} planId={plan.id} stepId={step.id} canMark={live && ["awaiting_review", "succeeded"].includes(step.state)} />}

      {step.result && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink-faint hover:text-ink">How Acorn checked this ({step.result.checks.filter((c) => c.passed).length}/{step.result.checks.length} passed)</summary>
          <ul className="mt-1 space-y-1">
            {step.result.checks.map((c, i) => (
              <li key={i} className={c.passed ? "text-ink-soft" : "text-danger"}>
                {c.passed ? "✓" : "✗"} {c.name} <span className="text-ink-faint">— {c.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {step.error && <p className="mt-2 text-sm text-danger" role="alert">{step.error}</p>}
      {step.state === "failed" && live && <RetryStep planId={plan.id} stepId={step.id} />}
      {step.state === "awaiting_review" && live && output && step.tool && (
        <ReviewControls key={JSON.stringify(output).length + String(step.edited)} planId={plan.id} stepId={step.id} tool={step.tool} output={output} />
      )}
      {step.kind === "user" && step.state === "pending" && live && ready && <RecordStep planId={plan.id} stepId={step.id} hint="At least 10 characters: a confirmation number, link or note." />}
      {step.kind === "user" && step.state === "pending" && live && !ready && <p className="mt-2 text-sm text-ink-faint">Unlocks after the earlier steps.</p>}
      {step.state === "succeeded" && step.kind === "user" && step.evidence && <p className="mt-2 text-sm text-ink-soft">You recorded: {step.evidence}</p>}
      {step.optional && step.tool === "create_reminder" && step.state === "pending" && live && ready && (
        <ReminderStepControls planId={plan.id} stepId={step.id} hasDate={step.input.dueAt !== undefined && step.input.dueAt !== null} />
      )}
      {step.optional && step.tool === "create_reminder" && step.state === "pending" && step.input.dueAt != null && plan.status === "awaiting_approval" && (
        <p className="mt-1 text-sm text-ink-faint">Proposed for {formatDateTime(String(step.input.dueAt))}.</p>
      )}
    </li>
  );
}

const MATCH_LABEL: Record<string, string> = { VERIFIED_MATCH: "Verified", POTENTIAL_MATCH: "Potential: confirm it", UNVERIFIED: "Can't be verified from a CV", MISSING: "Not in your CV" };
type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

function StepOutput({ tool, output, edited, planId, stepId, canMark }: { tool: string; output: Rec; edited: boolean; planId: string; stepId: string; canMark: boolean }) {
  const note = edited ? <p className="mt-1 text-xs text-amber">Edited by you. Acorn can&apos;t vouch for your changes.</p> : null;
  switch (tool) {
    case "retrieve_memory":
    case "read_document":
      return <p className="mt-2 text-sm text-ink-soft">Read “{String(output.title)}” ({arr(output.facts).length} facts with quotes).</p>;
    case "search_memories":
      return arr(output.results).length ? (
        <ul className="mt-2 space-y-0.5 text-sm">
          {arr(output.results).map((r) => (
            <li key={String(r.memoryId)}>
              <Link className="underline underline-offset-2" href={`/memories/${String(r.memoryId)}`}>{String(r.title)}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">No other related memories.</p>
      );
    case "read_cv":
      return (
        <p className="mt-2 text-sm text-ink-soft">
          Your CV is on file: {String(output.lines)} lines, {String(output.experience)} roles, {String(output.skills)} skills.
          {(output.warnings as string[]).map((w) => (
            <span key={w} className="block text-amber">⚠ {w}</span>
          ))}
        </p>
      );
    case "compare_job_to_cv": {
      const counts = output.counts as Record<string, number>;
      const sem = output.semantic as { used: boolean; note: string };
      return (
        <div className="mt-3">
          <p className="text-sm text-ink-soft">
            {counts.verified} verified · {counts.potential} to confirm · {counts.unverified} Acorn can&apos;t verify · {counts.missing} not in your CV. {sem.note}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-96 text-left text-sm">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1 pr-3 font-normal">Requirement</th>
                  <th className="py-1 pr-3 font-normal">What your CV shows</th>
                </tr>
              </thead>
              <tbody>
                {arr(output.results).map((m, i) => (
                  <tr key={i} className="border-t border-line/60 align-top">
                    <td className="py-2 pr-3">{String(m.requirement)}</td>
                    <td className="py-2 pr-3">
                      <Tag tone={m.status === "VERIFIED_MATCH" ? "moss" : m.status === "MISSING" ? "danger" : "amber"}>{MATCH_LABEL[String(m.status)]}</Tag>
                      {m.userDecision === "confirmed" && <Tag tone="moss">you confirmed it</Tag>}
                      {m.userDecision === "rejected" && <Tag>you said no</Tag>}
                      <span className="ml-2 text-xs text-ink-faint">confidence {Math.round(Number(m.confidence) * 100)}% (a rough rule-based score)</span>
                      <p className="mt-1 text-ink-soft">{String(m.explanation)}</p>
                      {(m.evidence as { quote: string; context: string | null; dates: string | null }[]).map((e) => (
                        <p key={e.quote} className="mt-1 text-ink-soft">
                          “{e.quote}”{e.context ? <span className="text-ink-faint"> — {e.context}{e.dates ? `, ${e.dates}` : ""}</span> : null}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case "draft_resume":
    case "draft_cover_letter":
      return (
        <div className="mt-3">
          <pre className="max-h-80 overflow-auto rounded-xl bg-paper p-3 text-sm whitespace-pre-wrap">{String(output.text)}</pre>
          <p className="mt-1 text-xs text-ink-faint">
            {tool === "draft_resume"
              ? "Every line is your CV's own words (each points to its place in your CV). Durations are computed from the dates you gave."
              : "Every claim is one of your CV's lines, with its role and dates. Fill every [TO COMPLETE] honestly, or remove it."}
          </p>
          {(output.unsupported as string[]).length > 0 && (
            <div className="mt-2 rounded-lg border border-dashed border-line p-2 text-sm">
              <p className="font-medium">Not claimed: your CV doesn&apos;t back these (review them)</p>
              <ul className="list-disc pl-5 text-ink-soft">
                {(output.unsupported as string[]).map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          {(output.flags as string[]).length > 0 && (
            <p className="mt-2 text-sm text-amber" role="alert">
              ⚠ Not in your CV or the job, please check: {(output.flags as string[]).join(", ")}
            </p>
          )}
          {note}
        </div>
      );
    case "draft_email":
      return (
        <div className="mt-3 rounded-xl bg-paper p-3 text-sm">
          <p className="font-medium">Subject: {String(output.subject)}</p>
          <pre className="mt-1 whitespace-pre-wrap">{String(output.body)}</pre>
          <p className="mt-2 text-xs text-ink-faint">Draft only. Acorn never sends email: copy it into your own mail app.</p>
          {note}
        </div>
      );
    case "create_checklist":
      return (
        <div className="mt-3">
          <ul className="space-y-1 text-sm">
            {arr(output.items).map((i) => (
              <li key={String(i.id)}>
                <span aria-hidden="true">☐ </span>
                {String(i.text)} {i.by === "you" && <Tag>added by you</Tag>}
              </li>
            ))}
          </ul>
          {note}
        </div>
      );
    case "build_study_pack":
      return <StudyPackView pack={output as unknown as StudyPack} planId={planId} stepId={stepId} canMark={canMark} />;
    case "extract_recipe": {
      const steps = arr(output.instructions);
      const sv = output.servings as { value: number } | null;
      return (
        <div className="mt-2 text-sm text-ink-soft">
          <p>
            Found {arr(output.ingredients).length} ingredients{sv ? `, serves ${sv.value}` : ", no servings stated"} and {steps.length} method steps, read from the saved text.
          </p>
          {(output.warnings as string[]).map((w) => (
            <p key={w} className="text-amber">⚠ {w}</p>
          ))}
          {(output.unreadLines as string[]).length > 0 && <p className="text-amber">Couldn&apos;t read: {(output.unreadLines as string[]).join("; ")}</p>}
          {steps.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-ink-faint">Method, as written ({steps.length})</summary>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                {steps.map((s, i) => (
                  <li key={i}>{String(s.text)}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      );
    }
    case "build_shopping_list": {
      const sv = output.servings as { original: number | null; target: number | null };
      return (
        <div className="mt-3">
          {sv.target && sv.original && sv.target !== sv.original && <p className="text-sm text-ink-soft">Amounts scaled from {sv.original} to {sv.target} servings.</p>}
          {(output.warnings as string[]).map((w) => (
            <p key={w} className="text-sm text-amber">⚠ {w}</p>
          ))}
          <ul className="mt-1 space-y-1 text-sm">
            {arr(output.items).map((i) => (
              <li key={String(i.id)}>
                <span aria-hidden="true">☐ </span>
                {formatQuantity({ quantity: i.quantity as number | null, quantityMax: i.quantityMax as number | null, unit: i.unit as string | null })} {String(i.name)}
                {i.prep ? <span className="text-ink-faint">, {String(i.prep)}</span> : null}
                {i.note ? <span className="text-ink-faint"> ({String(i.note)})</span> : null} {i.source === "you" ? <Tag>added or changed by you</Tag> : <Tag>from the recipe</Tag>}
              </li>
            ))}
          </ul>
          {arr(output.substitutions).length > 0 && (
            <div className="mt-3 rounded-xl border border-dashed border-line p-3 text-sm">
              <p className="font-medium">Ideas from Acorn <Tag>inferred, not in the recipe, not on your list</Tag></p>
              <ul className="mt-1 text-ink-soft">
                {arr(output.substitutions).map((s) => (
                  <li key={String(s.for)}>
                    Instead of {String(s.for)}: {String(s.idea)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {note}
        </div>
      );
    }
    case "create_reminder":
      return (
        <p className="mt-2 text-sm text-ink-soft">
          Reminder set for {formatDateTime(String(output.dueAt))}. <Link className="underline underline-offset-2" href="/reminders">See all reminders</Link>
        </p>
      );
    default:
      return null;
  }
}
