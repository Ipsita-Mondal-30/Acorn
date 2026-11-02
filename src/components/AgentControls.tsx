"use client";

import { useState } from "react";
import type { Reminder } from "@/lib/agent/schema";
import { api } from "./api";
import { formatDateTime } from "./format";
import { useMutation } from "./MemoryControls";
import { buttonClass, fieldClass } from "./ui";

// Client controls for plans, drafts and reminders. Every button maps to one explicit decision of the user's;
// nothing here runs on its own.

function Msg({ pending, error }: { pending: boolean; error: string | null }) {
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {pending && <span className="text-ink-soft">Working…</span>}
      {error && <span className="text-danger">{error}</span>}
    </p>
  );
}

const planOp = (planId: string, body: object) => api(`/api/plans/${planId}`, { method: "POST", body });

export function MakePlanButton({ memoryId, label }: { memoryId: string; label: string }) {
  const m = useMutation();
  return (
    <div>
      <button type="button" disabled={m.pending} className={buttonClass.primary} onClick={() => m.run(() => api("/api/plans", { method: "POST", body: { memoryId } }))}>
        {label}
      </button>
      <p className="mt-2 text-sm text-ink-faint">This only makes a plan for you to read. Nothing runs until you approve it.</p>
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

export function PlanDecision({ planId }: { planId: string }) {
  const m = useMutation();
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" disabled={m.pending} className={buttonClass.primary} onClick={() => m.run(() => planOp(planId, { op: "approve" }))}>
        Approve and run
      </button>
      <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => m.run(() => planOp(planId, { op: "reject" }))}>
        Reject
      </button>
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

export function RejectPlan({ planId }: { planId: string }) {
  const m = useMutation();
  return (
    <span>
      <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => m.run(() => planOp(planId, { op: "reject", note: "Stopped by you" }))}>
        Stop this plan
      </button>
      <Msg pending={m.pending} error={m.error} />
    </span>
  );
}

export function RetryStep({ planId, stepId }: { planId: string; stepId: string }) {
  const m = useMutation();
  return (
    <div className="mt-2">
      <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => m.run(() => planOp(planId, { op: "retry", stepId }))}>
        Retry this step
      </button>
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

type Item = { id?: string; text?: string; name?: string; quantity?: number | null; unit?: string | null; done?: boolean; checked?: boolean; source?: string; by?: string };

/** Accept a draft as it is, or edit it first. Items you add are marked as yours. */
export function ReviewControls({ planId, stepId, tool, output }: { planId: string; stepId: string; tool: string; output: Record<string, unknown> }) {
  const m = useMutation();
  const [editing, setEditing] = useState(false);
  const isText = tool === "draft_resume" || tool === "draft_cover_letter";
  const isEmail = tool === "draft_email";
  const isChecklist = tool === "create_checklist";
  const isShopping = tool === "build_shopping_list";
  const editable = isText || isEmail || isChecklist || isShopping;
  const [text, setText] = useState(String(output.text ?? ""));
  const [subject, setSubject] = useState(String(output.subject ?? ""));
  const [body, setBody] = useState(String(output.body ?? ""));
  const [items, setItems] = useState<Item[]>((output.items as Item[] | undefined) ?? []);
  const isCompare = tool === "compare_job_to_cv";
  const results = (isCompare ? (output.results as { requirement: string; status: string; userDecision: string | null }[]) : []) ?? [];
  const [decisions, setDecisions] = useState<Record<string, "confirmed" | "rejected">>({});
  const servings = output.servings as { original: number | null; target: number | null } | undefined;
  const [target, setTarget] = useState(String(servings?.target ?? servings?.original ?? ""));

  const save = () => {
    const edit = isText ? { text } : isEmail ? { subject, body } : { items: items.filter((i) => (i.text ?? i.name ?? "").trim()) };
    m.run(() => planOp(planId, { op: "edit", stepId, edit }), () => setEditing(false));
  };
  const setItem = (n: number, patch: Item) => setItems((xs) => xs.map((x, i) => (i === n ? { ...x, ...patch } : x)));

  return (
    <div className="mt-3">
      {isCompare && results.some((r) => r.status === "POTENTIAL_MATCH" || r.status === "UNVERIFIED") && (
        <fieldset className="mb-3 rounded-xl border border-line bg-paper p-3">
          <legend className="px-1 text-sm font-medium">Only you know these. Is each one true?</legend>
          <ul className="space-y-3">
            {results.map((r, i) =>
              r.status === "POTENTIAL_MATCH" || r.status === "UNVERIFIED" ? (
                <li key={i} className="text-sm">
                  <p>{r.requirement}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(["confirmed", "rejected"] as const).map((d) => {
                      const current = decisions[String(i)] ?? (r.userDecision as "confirmed" | "rejected" | null);
                      return (
                        <button key={d} type="button" aria-pressed={current === d} className={current === d ? buttonClass.primary : buttonClass.secondary} onClick={() => setDecisions((x) => ({ ...x, [String(i)]: d }))}>
                          {d === "confirmed" ? "Yes, this is true" : "No / not really"}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ) : null,
            )}
          </ul>
          <button type="button" disabled={m.pending || Object.keys(decisions).length === 0} className={`${buttonClass.primary} mt-3`} onClick={() => m.run(() => planOp(planId, { op: "edit", stepId, edit: { decisions } }), () => setDecisions({}))}>
            Save my answers
          </button>
          <p className="mt-1 text-xs text-ink-faint">Anything you say is true is used in your drafts and marked “confirmed by you”. Anything you leave open is not claimed.</p>
        </fieldset>
      )}
      {isShopping && servings?.original && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`sv-${stepId}`} className="block text-sm font-medium">
              Servings (recipe says {servings.original})
            </label>
            <input id={`sv-${stepId}`} type="number" min="1" max="200" value={target} onChange={(e) => setTarget(e.target.value)} className={`${fieldClass} w-28`} />
          </div>
          <button type="button" disabled={m.pending || !Number(target) || Number(target) === (servings.target ?? servings.original)} className={buttonClass.secondary} onClick={() => m.run(() => planOp(planId, { op: "edit", stepId, edit: { servings: Number(target) } }))}>
            Rescale amounts
          </button>
        </div>
      )}
      {editing && (
        <div className="space-y-3 rounded-xl border border-line bg-paper p-3">
          {isText && <textarea aria-label="Edit draft" value={text} onChange={(e) => setText(e.target.value)} rows={14} className={`${fieldClass} font-mono text-sm`} />}
          {isEmail && (
            <>
              <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={fieldClass} />
              <textarea aria-label="Body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={fieldClass} />
            </>
          )}
          {(isChecklist || isShopping) && (
            <ul className="space-y-2">
              {items.map((it, n) => (
                <li key={it.id ?? n} className="flex flex-wrap items-center gap-2">
                  {isShopping && (
                    <>
                      <input aria-label="Quantity" type="number" min="0" step="any" value={it.quantity ?? ""} onChange={(e) => setItem(n, { quantity: e.target.value === "" ? null : Number(e.target.value) })} className={`${fieldClass} w-20`} />
                      <input aria-label="Unit" value={it.unit ?? ""} onChange={(e) => setItem(n, { unit: e.target.value || null })} className={`${fieldClass} w-20`} />
                    </>
                  )}
                  <input aria-label={isShopping ? "Item" : "Checklist item"} value={(isShopping ? it.name : it.text) ?? ""} onChange={(e) => setItem(n, isShopping ? { name: e.target.value } : { text: e.target.value })} className={`${fieldClass} min-w-40 flex-1`} />
                  <button type="button" className={buttonClass.quiet} onClick={() => setItems((xs) => xs.filter((_, i) => i !== n))}>
                    Remove
                  </button>
                </li>
              ))}
              <li>
                <button type="button" className={buttonClass.quiet} onClick={() => setItems((xs) => [...xs, isShopping ? { name: "", quantity: null, unit: null } : { text: "" }])}>
                  + Add an item
                </button>
              </li>
            </ul>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={m.pending} className={buttonClass.primary} onClick={save}>
              Save my edit
            </button>
            <button type="button" className={buttonClass.quiet} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={m.pending} className={buttonClass.primary} onClick={() => m.run(() => planOp(planId, { op: "accept", stepId }))}>
            This looks right
          </button>
          {editable && (
            <button type="button" className={buttonClass.secondary} onClick={() => setEditing(true)}>
              Edit first
            </button>
          )}
        </div>
      )}
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

export function RecordStep({ planId, stepId, hint }: { planId: string; stepId: string; hint: string }) {
  const m = useMutation();
  const [evidence, setEvidence] = useState("");
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.run(() => planOp(planId, { op: "record", stepId, evidence }), () => setEvidence(""));
      }}
    >
      <label className="block text-sm font-medium" htmlFor={`rec-${stepId}`}>
        What happened? <span className="font-normal text-ink-faint">{hint}</span>
      </label>
      <textarea id={`rec-${stepId}`} value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} className={fieldClass} placeholder="e.g. Applied on the company site, confirmation LUM-48213" />
      <button type="submit" disabled={m.pending || evidence.trim().length < 10} className={buttonClass.primary}>
        I did this: record it
      </button>
      <Msg pending={m.pending} error={m.error} />
    </form>
  );
}

export function ReminderStepControls({ planId, stepId, hasDate }: { planId: string; stepId: string; hasDate: boolean }) {
  const m = useMutation();
  const [when, setWhen] = useState("");
  return (
    <div className="mt-3 space-y-2">
      {!hasDate && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`due-${stepId}`} className="block text-sm font-medium">
              Remind me on
            </label>
            <input id={`due-${stepId}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} />
          </div>
          <button type="button" disabled={m.pending || !when} className={buttonClass.primary} onClick={() => m.run(() => planOp(planId, { op: "set", stepId, field: "dueAt", value: new Date(when).toISOString() }))}>
            Set reminder
          </button>
        </div>
      )}
      {!hasDate && (
        <div className="flex flex-wrap gap-2">
          {[{ label: "In 3 days", d: 3 }, { label: "In 1 week", d: 7 }, { label: "In 2 weeks", d: 14 }].map((p) => (
            <button key={p.d} type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => m.run(() => planOp(planId, { op: "set", stepId, field: "dueAt", value: new Date(Date.now() + p.d * 86_400_000).toISOString() }))}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => m.run(() => planOp(planId, { op: "skip", stepId }))}>
        Skip this step
      </button>
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

export type CvInfo = {
  originalName: string | null;
  source: "upload" | "paste";
  fileKind: string | null;
  byteSize: number | null;
  createdAt: string;
  characters: number;
  counts: { experience: number; projects: number; skills: number; education: number; certifications: number };
  name: string | null;
  contact: string[];
  warnings: string[];
  fileName: string | null;
};

const kb = (n: number | null) => (n === null ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Add, replace, re-read or remove your CV. A file is kept as uploaded; Acorn reads the text out of it. */
export function CvEditor({ cv }: { cv: CvInfo | null }) {
  const m = useMutation();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const upload = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    m.run(async () => {
      const r = await api<{ warning: string | null }>("/api/cv", { method: "POST", form });
      setNote(r.warning);
    });
  };
  return (
    <details className="mt-4 rounded-xl border border-line bg-card p-3" open={!cv}>
      <summary className="cursor-pointer text-sm font-medium">{cv ? "Your CV is on file: view, replace or remove it" : "Add your CV (needed for job plans)"}</summary>
      <p className="mt-2 text-sm text-ink-soft">
        Upload a PDF, Word (.docx) or text file, or paste the text. It is stored privately on your account, read only by plans you approve, and Acorn never adds anything that isn&apos;t in it.
      </p>
      {cv && (
        <div className="mt-3 rounded-lg bg-paper p-3 text-sm">
          <p className="font-medium">
            {cv.source === "upload" ? `${cv.originalName ?? "Uploaded file"} (${cv.fileKind?.toUpperCase()}, ${kb(cv.byteSize)})` : "Pasted text"}
          </p>
          <p className="text-ink-soft">
            Read {cv.characters.toLocaleString()} characters{cv.name ? ` · name: ${cv.name}` : ""}
            {cv.contact.length ? ` · ${cv.contact.join(", ")}` : ""}
          </p>
          <p className="text-ink-soft">
            Found {cv.counts.experience} roles, {cv.counts.projects} projects, {cv.counts.skills} skills, {cv.counts.education} education, {cv.counts.certifications} certifications. Check these against your CV: Acorn only reads what is written.
          </p>
          {cv.warnings.map((w) => (
            <p key={w} className="mt-1 text-amber">
              ⚠ {w}
            </p>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            {cv.fileName && (
              <a className={buttonClass.quiet} href={`/api/files/${cv.fileName}`} target="_blank" rel="noopener noreferrer">
                Open original file
              </a>
            )}
            {cv.source === "upload" && (
              <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => m.run(() => api("/api/cv", { method: "PATCH", body: { op: "reparse" } }))}>
                Read the original again
              </button>
            )}
            <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => confirm("Remove your CV and its stored files, including older versions?") && m.run(() => api("/api/cv", { method: "DELETE" }))}>
              Remove CV
            </button>
          </div>
        </div>
      )}
      <div className="mt-3">
        <label htmlFor="cv-file" className="block text-sm font-medium">
          {cv ? "Replace with a new file (the old version is kept)" : "Upload a file"}
        </label>
        <input id="cv-file" type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={m.pending} className="mt-1 block text-sm" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      {note && <p className="mt-2 text-sm text-amber">{note}</p>}
      <p className="mt-3 text-sm font-medium">Or paste the text</p>
      <textarea aria-label="CV text" value={text} onChange={(e) => setText(e.target.value)} rows={6} className={`${fieldClass} mt-1 font-mono text-sm`} placeholder="Name&#10;&#10;Experience&#10;Role, Company&#10;Jan 2021 - Present&#10;- What you did" />
      <div className="mt-2">
        <button type="button" disabled={m.pending || text.trim().length < 20} className={buttonClass.primary} onClick={() => m.run(() => api("/api/cv", { method: "PUT", body: { text } }), () => setText(""))}>
          Save pasted CV
        </button>
      </div>
      <Msg pending={m.pending} error={m.error} />
    </details>
  );
}

// ───────────────────────── reminders ─────────────────────────

import { addDays, localDate, zonedParts } from "@/lib/notify/time";

/** The value a datetime-local input needs, for an instant, on the wall clock of `tz`. */
export const toLocalInput = (iso: string, tz: string) => {
  const p = zonedParts(new Date(iso), tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
};

/** Edit, reschedule, snooze, complete or dismiss. Times are your wall-clock time in your notification time zone. */
export function ReminderControls({ reminder, tz }: { reminder: Reminder; tz: string }) {
  const m = useMutation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(reminder.title);
  const [due, setDue] = useState(toLocalInput(reminder.dueAt, reminder.timezone ?? tz));
  const open = reminder.status === "scheduled" || reminder.status === "snoozed";
  const patch = (body: object, done?: () => void) => m.run(() => api(`/api/reminders/${reminder.id}`, { method: "PATCH", body }), done);
  const snoozeIn = (hours: number) => patch({ op: "snooze", until: new Date(Date.now() + hours * 3_600_000).toISOString() });
  // "tomorrow 9:00" means 9:00 on YOUR clock tomorrow, even if a clock change makes that 23 or 25 hours away
  const snoozeDays = (days: number) => patch({ op: "snooze", dueLocal: `${addDays(localDate(new Date(), tz), days)}T09:00`, timezone: tz });

  return (
    <div className="mt-3">
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            patch({ op: "edit", changes: { title, dueLocal: due, timezone: tz } }, () => setEditing(false));
          }}
        >
          <input aria-label="Reminder title" value={title} onChange={(e) => setTitle(e.target.value)} className={`${fieldClass} min-w-48 flex-1`} />
          <div>
            <label htmlFor={`due-${reminder.id}`} className="block text-xs text-ink-faint">
              Due ({tz})
            </label>
            <input id={`due-${reminder.id}`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={`${fieldClass} w-auto`} />
          </div>
          <button type="submit" disabled={m.pending} className={buttonClass.primary}>
            Save
          </button>
          <button type="button" className={buttonClass.quiet} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {open ? (
            <>
              <button type="button" disabled={m.pending} className={buttonClass.primary} onClick={() => patch({ op: "done" })}>
                Done
              </button>
              <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => snoozeIn(1)}>
                In 1 hour
              </button>
              <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => snoozeDays(1)}>
                Tomorrow 9:00
              </button>
              <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => snoozeDays(7)}>
                Next week
              </button>
              <button type="button" className={buttonClass.quiet} onClick={() => setEditing(true)}>
                Edit or reschedule
              </button>
              <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => patch({ op: "dismiss" })}>
                Dismiss
              </button>
            </>
          ) : (
            <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => patch({ op: "reopen" })}>
              Reopen
            </button>
          )}
        </div>
      )}
      <Msg pending={m.pending} error={m.error} />
      {reminder.history.length > 1 && (
        <details className="mt-2 text-sm text-ink-faint">
          <summary className="cursor-pointer">History</summary>
          <ul className="mt-1 space-y-0.5">
            {reminder.history.map((h, i) => (
              <li key={i}>
                {h.status} · {formatDateTime(h.at)}
                {h.note ? ` · ${h.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
