"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { ContentType, INTENT_LABEL, IntentKind, type IntentGuess, type MemoryView, type Overrides } from "@/lib/schema";
import { api, errorMessage } from "./api";
import { TYPE_LABEL } from "./format";
import { buttonClass, fieldClass } from "./ui";

const noSubscribe = () => () => {};

/** False in server-rendered HTML and until React has attached its handlers; true afterwards. */
export function useHydrated() {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/**
 * Runs a mutation, then refreshes server data; `pending` stays true until the refresh lands.
 * A second call while one is running is ignored synchronously (state alone can't stop a fast double click).
 */
export function useMutation() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = (fn: () => Promise<unknown>, onDone?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      setError(null);
      try {
        await fn();
        onDone?.();
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        inFlight.current = false;
      }
    });
  };
  return { pending, error, run };
}

export function ProcessButton({
  memoryId,
  op,
  label,
  primary,
}: {
  memoryId: string;
  op: "process" | "reprocess";
  label: string;
  primary?: boolean;
}) {
  const m = useMutation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={m.pending}
        className={primary ? buttonClass.primary : buttonClass.secondary}
        onClick={() => m.run(() => api(`/api/memories/${memoryId}`, { method: "POST", body: { op } }))}
      >
        {label}
      </button>
      <p role="status" aria-live="polite" className="text-sm">
        {m.pending && <span className="text-ink-soft">Understanding…</span>}
        {m.error && <span className="text-danger">{m.error}</span>}
      </p>
    </div>
  );
}

type Initial = Pick<MemoryView, "title" | "contentType" | "summary" | "intent" | "deadline">;

export function CorrectionForm({ memoryId, initial }: { memoryId: string; initial: Initial }) {
  const m = useMutation();
  const [saved, setSaved] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const patch: Overrides = {};
    if (get("title") !== initial.title) patch.title = get("title");
    if (get("contentType") !== initial.contentType) patch.contentType = ContentType.parse(get("contentType"));
    if (get("summary") !== initial.summary) patch.summary = get("summary");
    if (get("intent") !== (initial.intent ?? "")) patch.intent = get("intent");
    if (get("deadline") !== (initial.deadline ?? "")) patch.deadline = get("deadline") || null;
    setSaved(false);
    if (Object.keys(patch).length === 0) return;
    m.run(() => api(`/api/memories/${memoryId}`, { method: "PATCH", body: patch }), () => setSaved(true));
  }

  const label = "mb-1.5 block text-sm font-medium";
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="fix-title" className={label}>
          Title
        </label>
        <input id="fix-title" name="title" required maxLength={200} defaultValue={initial.title} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="fix-type" className={label}>
          Type
        </label>
        <select id="fix-type" name="contentType" defaultValue={initial.contentType} className={fieldClass}>
          {ContentType.options.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="fix-summary" className={label}>
          Summary
        </label>
        <textarea id="fix-summary" name="summary" rows={4} maxLength={1000} defaultValue={initial.summary} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="fix-intent" className={label}>
          What you wanted to do with it
        </label>
        <input id="fix-intent" name="intent" maxLength={300} defaultValue={initial.intent ?? ""} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="fix-deadline" className={label}>
          Deadline <span className="font-normal text-ink-faint">(leave empty for none)</span>
        </label>
        <input id="fix-deadline" name="deadline" type="date" defaultValue={initial.deadline ?? ""} className={fieldClass} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={m.pending} className={buttonClass.primary}>
          {m.pending ? "Saving…" : "Save corrections"}
        </button>
        <p role="status" aria-live="polite" className="text-sm">
          {saved && !m.pending && <span className="text-moss-ink">Saved. Your edits now win over Acorn&apos;s reading.</span>}
          {m.error && <span className="text-danger">{m.error}</span>}
        </p>
      </div>
    </form>
  );
}

const FIELD_NAME: Record<string, string> = { title: "title", contentType: "type", summary: "summary", intent: "intent wording", deadline: "deadline", facts: "facts" };

/** Per-field "go back to Acorn's reading", so a correction is never a one-way door. */
export function RestoreEdits({ memoryId, edited }: { memoryId: string; edited: string[] }) {
  const m = useMutation();
  if (edited.length === 0) return null;
  return (
    <div className="mt-5 border-t border-line/70 pt-4">
      <p className="text-sm font-medium">Your corrections</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {edited.map((k) => (
          <li key={k}>
            <button
              type="button"
              disabled={m.pending}
              className={buttonClass.secondary}
              onClick={() => m.run(() => api(`/api/memories/${memoryId}`, { method: "PATCH", body: { restore: [k] } }))}
            >
              Restore Acorn&apos;s {FIELD_NAME[k] ?? k}
            </button>
          </li>
        ))}
      </ul>
      {m.error && <p role="status" className="mt-2 text-sm text-danger">{m.error}</p>}
    </div>
  );
}

/**
 * Why did you save this? Acorn's reading is shown as a guess until the user acts on it.
 * Confirm / change / dismiss all go through the same endpoint, and "undo" returns to the guess.
 */
export function IntentPanel({
  memoryId,
  view,
  alternatives = [],
}: {
  memoryId: string;
  view: Pick<MemoryView, "intentKind" | "intentStatus" | "intentNote" | "suggestedIntent">;
  /** other readings Acorn considered. Never the user's choice until they pick one. */
  alternatives?: IntentGuess[];
}) {
  const m = useMutation();
  // The buttons are NOT disabled before hydration. A click on a server-rendered, enabled button is queued by React, which hydrates
  // that part of the page first and replays the click. A disabled button drops the click, so if hydration was slow the page stayed dead.
  const ready = useHydrated();
  const off = m.pending;
  const [question, setQuestion] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState(view.intentNote ?? "");
  const send = (body: object) => m.run(() => api(`/api/memories/${memoryId}`, { method: "PATCH", body }), () => setChanging(false));
  const set = (kind: IntentKind | "none") => send({ userIntent: { kind, ...(note.trim() ? { note: note.trim() } : {}) } });
  const guess = view.suggestedIntent;
  const decided = view.intentStatus === "confirmed" || view.intentStatus === "corrected" || view.intentStatus === "set";
  // not decided, and either no guess or a weak inferred one: ask rather than pretend to know
  const unsure = !decided && view.intentStatus !== "dismissed" && (!guess || (guess.basis === "inferred" && guess.confidence < 0.5));
  const askAcorn = () =>
    m.run(async () => {
      const r = await api<{ question: string | null }>(`/api/memories/${memoryId}`, { method: "POST", body: { op: "intent" } });
      setQuestion(r.question);
    });

  return (
    <section aria-labelledby="intent" aria-busy={m.pending} data-hydrated={ready} className="mt-6 max-w-3xl rounded-3xl border-2 border-line/80 bg-card p-4 sm:p-5">
      <h2 id="intent" className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        Why you saved this
      </h2>

      {decided && view.intentKind && (
        <p className="mt-2 font-display text-lg">
          You want to: <strong className="font-medium">{INTENT_LABEL[view.intentKind]}</strong>
          <span className="ml-2 align-middle text-xs font-normal text-moss-ink">
            {view.intentStatus === "confirmed" ? "confirmed by you" : view.intentStatus === "corrected" ? "corrected by you" : "set by you"}
          </span>
        </p>
      )}
      {view.intentStatus === "dismissed" && <p className="mt-2 text-[15px] text-ink-soft">You said there&apos;s nothing to do with this. Acorn won&apos;t suggest anything.</p>}
      {view.intentNote && decided && <p className="mt-1 text-[15px] text-ink-soft">“{view.intentNote}”</p>}

      {guess && (
        <div className="mt-2">
          <p className="text-[15px]">
            <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber-ink">Acorn&apos;s guess · not confirmed</span>{" "}
            You might want to: <strong className="font-medium">{INTENT_LABEL[guess.kind]}</strong>{" "}
            <span className="text-sm text-ink-faint">({Math.round(guess.confidence * 100)}% sure)</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {guess.basis === "stated" ? "Based on your own words" : "Inferred from the content, not from anything you said"} — {guess.rationale}
          </p>
          {guess.quote && <blockquote className="mt-1 border-l-2 border-line pl-3 font-display text-[15px] text-ink-soft italic">“{guess.quote}”</blockquote>}
        </div>
      )}
      {unsure && (
        <p className="mt-2 text-[15px] text-ink-soft">
          {guess ? "Acorn isn't sure about this." : "Acorn can't tell why you saved this."} <strong className="font-medium text-ink">What did you want to do with it?</strong>
        </p>
      )}
      {question && <p className="mt-2 text-[15px] text-ink-soft">{question}</p>}

      {!decided && view.intentStatus !== "dismissed" && alternatives.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">Other possibilities Acorn considered · not confirmed</p>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {alternatives.map((a) => (
              <li key={a.kind}>
                <button type="button" disabled={off} className={buttonClass.secondary} title={a.rationale} onClick={() => set(a.kind)}>
                  {INTENT_LABEL[a.kind]} <span className="text-xs text-ink-faint">({Math.round(a.confidence * 100)}%)</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {guess && (
          <>
            <button type="button" disabled={off} className={buttonClass.primary} onClick={() => set(guess.kind)}>
              Yes, {INTENT_LABEL[guess.kind].toLowerCase()}
            </button>
            <button type="button" disabled={off} className={buttonClass.secondary} onClick={() => set("none")}>
              Not really
            </button>
          </>
        )}
        <button type="button" disabled={off} className={buttonClass.secondary} onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
          {decided || guess ? "Something else" : "Set what I want"}
        </button>
        {(decided || view.intentStatus === "dismissed") && (
          <button type="button" disabled={off} className={buttonClass.secondary} onClick={() => send({ restore: ["userIntent"] })}>
            Undo my answer
          </button>
        )}
        {!decided && view.intentStatus !== "dismissed" && (
          <button type="button" disabled={off} className={buttonClass.quiet} onClick={askAcorn}>
            Ask Acorn for a suggestion
          </button>
        )}
      </div>

      {changing && (
        <div className="mt-4 space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">I want to…</legend>
            <div className="flex flex-wrap gap-2">
              {IntentKind.options.map((k) => (
                <button key={k} type="button" disabled={off} className={buttonClass.secondary} onClick={() => set(k)}>
                  {INTENT_LABEL[k]}
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="intent-note" className="mb-1.5 block text-sm font-medium">
              In your words <span className="font-normal text-ink-faint">(optional, applied with your choice)</span>
            </label>
            <input id="intent-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={fieldClass} />
          </div>
        </div>
      )}

      <p role="status" aria-live="polite" className="mt-3 text-sm">
        {m.pending && <span className="text-ink-soft">Saving…</span>}
        {m.error && <span className="text-danger">{m.error}</span>}
      </p>
    </section>
  );
}

/** Permanent delete with an explicit confirm step. Removes the memory, its actions and its stored image. */
export function DeleteMemory({ memoryId, hasFile }: { memoryId: string; hasFile: boolean }) {
  const router = useRouter();
  const m = useMutation();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={buttonClass.quiet} onClick={() => setConfirming(true)}>
        Delete this memory
      </button>
    );
  }
  return (
    <div className="rounded-2xl border border-danger/30 bg-danger-soft p-4">
      <p className="text-sm text-danger">
        Delete this memory{hasFile ? ", its image" : ""} and its actions for good? This can&apos;t be undone.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={m.pending}
          className={buttonClass.primary}
          onClick={() => m.run(() => api(`/api/memories/${memoryId}`, { method: "DELETE" }), () => router.replace("/memories"))}
        >
          {m.pending ? "Deleting…" : "Yes, delete"}
        </button>
        <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
      {m.error && <p role="status" className="mt-2 text-sm text-danger">{m.error}</p>}
    </div>
  );
}

type FactItem = MemoryView["facts"][number];

/**
 * Correct what Acorn says the item states. Edits replace Acorn's list with yours (Acorn's evidence stays attached to the
 * facts you keep; facts you write are marked as yours), and "Restore Acorn's facts" brings the original list back.
 */
export function FactsEditor({ memoryId, facts }: { memoryId: string; facts: FactItem[] }) {
  const m = useMutation();
  const [items, setItems] = useState(facts);
  const [draft, setDraft] = useState("");
  const dirty = JSON.stringify(items) !== JSON.stringify(facts);
  const save = () =>
    m.run(() =>
      api(`/api/memories/${memoryId}`, {
        method: "PATCH",
        body: { facts: items.map((f) => ({ statement: f.statement, by: f.by, quote: f.quote, page: f.page, checked: f.checked })) },
      }),
    );
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setItems([...items, { statement: t, by: "you", quote: null, page: null, checked: false }]);
    setDraft("");
  };

  return (
    <div className="mt-5 border-t border-line/70 pt-4">
      <p className="text-sm font-medium">Facts</p>
      <p className="mt-1 text-sm text-ink-soft">Remove anything Acorn got wrong, edit it, or add a fact of your own.</p>
      <ul className="mt-3 space-y-2">
        {items.map((f, i) => (
          <li key={i} className="flex gap-2">
            <input
              aria-label={`Fact ${i + 1}`}
              value={f.statement}
              maxLength={300}
              onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, statement: e.target.value } : x)))}
              className={fieldClass}
            />
            <button type="button" className={buttonClass.secondary} onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Remove fact ${i + 1}`}>
              Remove
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-ink-faint">No facts.</li>}
      </ul>
      <div className="mt-3 flex gap-2">
        <input
          aria-label="Add a fact"
          value={draft}
          maxLength={300}
          placeholder="Add a fact you know about this"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className={fieldClass}
        />
        <button type="button" className={buttonClass.secondary} onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className={buttonClass.primary} disabled={m.pending || !dirty || items.some((f) => !f.statement.trim())} onClick={save}>
          {m.pending ? "Saving…" : "Save facts"}
        </button>
        {m.error && <span role="status" className="text-sm text-danger">{m.error}</span>}
      </div>
    </div>
  );
}

type Step = { label: string; kind: string; rationale: string };

/** Ask for next steps. They are suggestions: nothing is created until the user adds one as an action. */
export function SuggestSteps({ memoryId, memoryAcorn }: { memoryId: string; memoryAcorn: "mock" | "meta" }) {
  const m = useMutation();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  return (
    <div className="mt-6 rounded-3xl border-2 border-line/80 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">More next steps</h3>
          <p className="text-sm text-ink-soft">Suggestions from {memoryAcorn === "mock" ? "the demo rules (not a model)" : "Meta"}. Nothing happens until you add one.</p>
        </div>
        <button
          type="button"
          disabled={m.pending}
          className={buttonClass.secondary}
          onClick={() => m.run(async () => setSteps((await api<{ steps: Step[] }>(`/api/memories/${memoryId}`, { method: "POST", body: { op: "plan" } })).steps))}
        >
          {m.pending ? "Thinking…" : steps ? "Suggest again" : "Suggest steps"}
        </button>
      </div>
      {steps && (
        <ul className="mt-4 space-y-3">
          {steps.length === 0 && <li className="text-sm text-ink-faint">No steps suggested.</li>}
          {steps.map((s) => (
            <li key={s.label} className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px]">{s.label}</p>
                <p className="text-sm text-ink-faint">{s.rationale}</p>
              </div>
              <button
                type="button"
                disabled={m.pending || added.has(s.label)}
                className={buttonClass.secondary}
                onClick={() =>
                  m.run(async () => {
                    await api("/api/actions", { method: "POST", body: { memoryId, title: s.label, detail: s.rationale, kind: "suggested" } });
                    setAdded(new Set(added).add(s.label));
                  })
                }
              >
                {added.has(s.label) ? "Added" : "Add as action"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {m.error && <p role="status" className="mt-2 text-sm text-danger">{m.error}</p>}
    </div>
  );
}
