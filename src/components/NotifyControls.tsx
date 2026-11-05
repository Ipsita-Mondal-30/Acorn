"use client";

import { useState } from "react";
import type { NotificationPrefs } from "@/lib/notify/types";
import { api } from "./api";
import { useMutation } from "./MemoryControls";
import { buttonClass, fieldClass } from "./ui";

function Msg({ pending, error, done }: { pending: boolean; error: string | null; done?: string | null }) {
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {pending && <span className="text-ink-soft">Saving…</span>}
      {error && <span className="text-danger">{error}</span>}
      {!pending && !error && done && <span className="text-moss-ink">{done}</span>}
    </p>
  );
}

/** "Remind me": a reminder you choose yourself, at a wall-clock time in your time zone. */
export function NewReminderForm({ memoryId, defaultTitle, tz }: { memoryId: string; defaultTitle: string; tz: string }) {
  const m = useMutation();
  const [title, setTitle] = useState(defaultTitle);
  const [when, setWhen] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.run(() => api("/api/reminders", { method: "POST", body: { memoryId, title, dueLocal: when, timezone: tz, kind: "manual" } }), () => setWhen(""));
      }}
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="rem-title" className="block text-sm font-medium">
          Remind me about this
        </label>
        <input id="rem-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="rem-when" className="block text-sm font-medium">
          When ({tz})
        </label>
        <input id="rem-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${fieldClass} w-auto`} />
      </div>
      <button type="submit" disabled={m.pending || !when || !title.trim()} className={buttonClass.primary}>
        Set reminder
      </button>
      <div className="basis-full">
        <Msg pending={m.pending} error={m.error} />
      </div>
    </form>
  );
}

/** One click: a reminder before the deadline Acorn read, the day before at 09:00 your time when that's still ahead. */
export function DeadlineReminderButton({ memoryId, title, dueAt, deadline }: { memoryId: string; title: string; dueAt: string; deadline: string }) {
  const m = useMutation();
  return (
    <div>
      <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => m.run(() => api("/api/reminders", { method: "POST", body: { memoryId, title: `Deadline: ${title}`.slice(0, 200), dueAt, kind: "deadline", note: `Deadline: ${deadline}` } }))}>
        Remind me before the deadline ({deadline})
      </button>
      <Msg pending={m.pending} error={m.error} />
    </div>
  );
}

/** A follow-through suggestion: look, or "not now" (hides it for two weeks). It never changes anything else. */
export function HideSuggestion({ k }: { k: string }) {
  const m = useMutation();
  return (
    <>
      <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => m.run(() => api("/api/followthrough", { method: "POST", body: { op: "hide", key: k } }))}>
        Not now
      </button>
      <Msg pending={m.pending} error={m.error} />
    </>
  );
}

export function MarkAllRead({ unread }: { unread: number }) {
  const m = useMutation();
  if (!unread) return null;
  return (
    <>
      <button type="button" disabled={m.pending} className={buttonClass.secondary} onClick={() => m.run(() => api("/api/notifications", { method: "PATCH", body: { op: "read", ids: "all" } }))}>
        Mark all {unread} read
      </button>
      <Msg pending={m.pending} error={m.error} />
    </>
  );
}

export function MarkRead({ id }: { id: string }) {
  const m = useMutation();
  return (
    <button type="button" disabled={m.pending} className={buttonClass.quiet} onClick={() => m.run(() => api("/api/notifications", { method: "PATCH", body: { op: "read", ids: [id] } }))}>
      Mark read
    </button>
  );
}

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

/** Notification settings: switches, channels, time zone, quiet hours, daily limit and the briefing. */
export function PrefsForm({ initial, email }: { initial: NotificationPrefs; email: { configured: boolean; reason: string } }) {
  const m = useMutation();
  const [p, setP] = useState(initial);
  const [saved, setSaved] = useState<string | null>(null);
  const set = <K extends keyof NotificationPrefs>(k: K, v: NotificationPrefs[K]) => setP((x) => ({ ...x, [k]: v }));
  const device = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "UTC";
    }
  })();
  const quiet = p.quietStart !== null && p.quietEnd !== null;
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <form
      className="mt-8 max-w-xl space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(null);
        const { snoozedSuggestions, ...body } = p;
        void snoozedSuggestions;
        m.run(() => api("/api/notifications/preferences", { method: "PUT", body }), () => setSaved("Saved."));
      }}
    >
      <fieldset className="space-y-3">
        <legend className="font-display text-lg">Notifications</legend>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={p.enabled} onChange={(e) => set("enabled", e.target.checked)} className="size-5" />
          <span>Send me notifications about my reminders</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={p.inApp} disabled={!p.enabled} onChange={(e) => set("inApp", e.target.checked)} className="size-5" />
          <span>In Acorn (your inbox)</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={p.email} disabled={!p.enabled} onChange={(e) => set("email", e.target.checked)} className="size-5" />
          <span>By email</span>
        </label>
        {p.email && !email.configured && <p className="ml-8 text-sm text-amber">Email can&apos;t be sent from this server yet: {email.reason} Your choice is saved, and nothing is sent until it is set up.</p>}
        <p className="text-sm text-ink-faint">Phone calls and texts are not part of Acorn.</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg">Your time zone</legend>
        <p className="text-sm text-ink-soft">Quiet hours, the daily limit and the briefing follow your clock, including daylight-saving changes.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-60 flex-1">
            <label htmlFor="tz" className="sr-only">
              Time zone
            </label>
            <input id="tz" list="tz-list" value={p.timezone} onChange={(e) => set("timezone", e.target.value)} className={fieldClass} />
            <datalist id="tz-list">
              {zones().map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          {p.timezone !== device && (
            <button type="button" className={buttonClass.secondary} onClick={() => set("timezone", device)}>
              Use this device ({device})
            </button>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg">Quiet hours</legend>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={quiet} onChange={(e) => (e.target.checked ? setP((x) => ({ ...x, quietStart: "22:00", quietEnd: "07:00" })) : setP((x) => ({ ...x, quietStart: null, quietEnd: null })))} className="size-5" />
          <span>Hold notifications during these hours</span>
        </label>
        {quiet && (
          <div className="ml-8 flex flex-wrap items-center gap-2">
            <label htmlFor="qs" className="text-sm">From</label>
            <input id="qs" type="time" value={p.quietStart ?? ""} onChange={(e) => set("quietStart", e.target.value)} className={`${fieldClass} w-auto`} />
            <label htmlFor="qe" className="text-sm">to</label>
            <input id="qe" type="time" value={p.quietEnd ?? ""} onChange={(e) => set("quietEnd", e.target.value)} className={`${fieldClass} w-auto`} />
            <p className="basis-full text-sm text-ink-faint">Anything due meanwhile is held and sent when quiet hours end. Nothing is lost.</p>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg">How often</legend>
        <label className="flex flex-wrap items-center gap-3">
          <span>At most</span>
          <input type="number" min={1} max={50} value={p.maxPerDay} onChange={(e) => set("maxPerDay", Number(e.target.value))} className={`${fieldClass} w-24`} />
          <span>reminder notifications a day, per channel</span>
        </label>
        <p className="text-sm text-ink-faint">The rest wait until tomorrow. Each reminder is announced once; Acorn doesn&apos;t repeat itself.</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg">Daily briefing</legend>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={p.briefingEnabled} onChange={(e) => set("briefingEnabled", e.target.checked)} className="size-5" />
          <span>Send me a short briefing each morning, only on days something needs me</span>
        </label>
        {p.briefingEnabled && (
          <label className="ml-8 flex items-center gap-2">
            <span>At</span>
            <select value={p.briefingHour} onChange={(e) => set("briefingHour", Number(e.target.value))} className={`${fieldClass} w-auto`}>
              {hours.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={m.pending} className={buttonClass.primary}>
          Save settings
        </button>
        <Msg pending={m.pending} error={m.error} done={saved} />
      </div>
    </form>
  );
}
