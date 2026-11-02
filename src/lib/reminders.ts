import "server-only";
import { z } from "zod";
import { ActionError } from "./actions";
import { ReminderKind, type Reminder, type ReminderStatus } from "./agent/schema";
import { isValidTimezone, localToUtc } from "./notify/time";
import { effective, type Memory } from "./schema";
import { cancelDeliveries, getMemory, getReminder, listReminders, mutateReminder, upsertReminder } from "./store";

// Reminders: create, edit, reschedule, complete, snooze, dismiss, reopen. Every function goes through the signed-in
// user's store, so a reminder (or the memory it points at) that belongs to someone else simply doesn't exist here.
// Changing or closing a reminder also cancels any notification for it that hasn't gone out yet.

export class ReminderError extends ActionError {
  override name = "ReminderError";
}

const iso = z.iso.datetime({ offset: true });
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "use YYYY-MM-DDTHH:MM");
const tz = z.string().min(1).max(64);

/** Either an absolute instant (`dueAt`), or a wall-clock time in a time zone (`dueLocal` + `timezone`): "9am MY time". */
const When = z.object({ dueAt: iso.optional(), dueLocal: localTime.optional(), timezone: tz.optional() });
const oneWhen = (w: z.infer<typeof When>) => (w.dueAt !== undefined) !== (w.dueLocal !== undefined) && (w.dueLocal === undefined) === (w.timezone === undefined);
const WHEN_MSG = "give either dueAt, or dueLocal together with timezone";

export const NewReminder = When.extend({
  memoryId: z.string().min(1).max(100),
  actionId: z.string().min(1).max(100).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  note: z.string().max(2000).optional(),
  kind: ReminderKind.optional(),
})
  .strict()
  .refine(oneWhen, WHEN_MSG);
export const ReminderEdit = When.extend({ title: z.string().trim().min(1).max(200).optional(), note: z.string().max(2000).optional() })
  .strict()
  .refine((w) => (w.dueAt === undefined && w.dueLocal === undefined && w.timezone === undefined) || oneWhen(w), WHEN_MSG);

function resolveWhen(w: { dueAt?: string; dueLocal?: string; timezone?: string }): { dueAt: string; timezone: string | null } {
  if (w.dueAt !== undefined) return { dueAt: new Date(w.dueAt).toISOString(), timezone: null };
  if (!isValidTimezone(w.timezone!)) throw new ReminderError("That time zone isn't valid.");
  const [date, time] = w.dueLocal!.split("T");
  return { dueAt: localToUtc(date, Number(time.slice(0, 2)), Number(time.slice(3, 5)), w.timezone!).toISOString(), timezone: w.timezone! };
}

/**
 * A reminder that Acorn creates on the strength of an intent (from a plan, or "remind me before the deadline") needs an
 * intent the USER confirmed on that memory. An inferred guess never counts. A plain "manual" reminder is the user's own
 * request and needs nothing.
 */
export function assertKindAllowed(m: Memory, kind: ReminderKind): void {
  if (kind === "manual") return;
  const v = effective(m);
  if (!v.intentKind) throw new ReminderError("Confirm why you saved this first. Acorn doesn't set reminders from its own guess about what you meant.");
  if (kind === "recipe" && v.contentType !== "recipe") throw new ReminderError("This memory isn't a recipe.");
  if (kind === "event" && v.contentType !== "event") throw new ReminderError("This memory isn't an event.");
  if (kind === "follow_up" && !["follow_up", "reconnect"].includes(v.intentKind)) throw new ReminderError("Mark this memory as something to follow up on first.");
  if (kind === "deadline" && !v.deadline) throw new ReminderError("This memory has no deadline.");
}

export async function createReminder(raw: z.input<typeof NewReminder>, now = new Date()): Promise<Reminder> {
  const input = NewReminder.parse(raw);
  const memory = await getMemory(input.memoryId);
  if (!memory) throw new ReminderError("That memory doesn't exist.");
  const kind = input.kind ?? "manual";
  assertKindAllowed(memory, kind);
  const { dueAt, timezone } = resolveWhen(input);
  const at = now.toISOString();
  return upsertReminder({
    id: crypto.randomUUID(),
    memoryId: memory.id,
    actionId: input.actionId ?? null,
    title: input.title,
    note: input.note ?? "",
    dueAt,
    kind,
    timezone,
    snoozeCount: 0,
    status: "scheduled",
    history: [{ at, status: "scheduled" }],
    createdAt: at,
    updatedAt: at,
  });
}

const OPEN: ReminderStatus[] = ["scheduled", "snoozed"];
const need = (r: Reminder, allowed: ReminderStatus[], verb: string) => {
  if (!allowed.includes(r.status)) throw new ReminderError(`A reminder that is ${r.status} can't be ${verb}.`);
};

/** Apply a change, then cancel unsent notifications for the old state. */
async function change(id: string, fn: (r: Reminder) => Reminder, cancel: string): Promise<Reminder | null> {
  const r = await mutateReminder(id, fn);
  if (r) await cancelDeliveries(r.id, cancel).catch((e) => console.error(`[reminders] cancel failed for ${id}: ${e instanceof Error ? e.message.slice(0, 200) : e}`));
  return r;
}

export const editReminder = async (id: string, raw: z.input<typeof ReminderEdit>, now = new Date()) => {
  const parsed = ReminderEdit.safeParse(raw);
  if (!parsed.success) throw new ReminderError(parsed.error.issues.some((i) => /date|due|time/i.test(i.path.join(".") + i.message)) ? "That date isn't valid." : "That change isn't valid.");
  const patch = parsed.data;
  const when = patch.dueAt !== undefined || patch.dueLocal !== undefined ? resolveWhen(patch) : null;
  return change(
    id,
    (r) => {
      need(r, OPEN, "edited");
      const moved = when && when.dueAt !== r.dueAt;
      return {
        ...r,
        title: patch.title ?? r.title,
        note: patch.note ?? r.note,
        dueAt: when?.dueAt ?? r.dueAt,
        timezone: when ? (when.timezone ?? r.timezone) : r.timezone,
        // a reminder that moved is a fresh one: it starts again as scheduled
        status: moved ? "scheduled" : r.status,
        updatedAt: now.toISOString(),
        history: [...r.history, { at: now.toISOString(), status: "edited" as const, ...(moved ? { note: `rescheduled from ${r.dueAt} to ${when!.dueAt}` } : {}) }],
      };
    },
    "Cancelled: the reminder was changed.",
  );
};

export const completeReminder = (id: string, now = new Date()) =>
  change(id, (r) => {
    need(r, OPEN, "completed");
    return { ...r, status: "done", updatedAt: now.toISOString(), history: [...r.history, { at: now.toISOString(), status: "done" as const }] };
  }, "Cancelled: the reminder was completed.");

/** Move it to a later time. Counts as a snooze, which the follow-through check uses to notice something keeps being put off. */
export const snoozeReminder = (id: string, raw: string | { dueLocal: string; timezone: string }, now = new Date()) => {
  const when = resolveWhen(typeof raw === "string" ? { dueAt: raw } : raw);
  return change(id, (r) => {
    need(r, OPEN, "snoozed");
    if (new Date(when.dueAt).getTime() <= now.getTime()) throw new ReminderError("Snooze until a time in the future.");
    return {
      ...r,
      status: "snoozed",
      dueAt: when.dueAt,
      snoozeCount: r.snoozeCount + 1,
      updatedAt: now.toISOString(),
      history: [...r.history, { at: now.toISOString(), status: "snoozed" as const, note: `until ${when.dueAt}` }],
    };
  }, "Cancelled: the reminder was snoozed.");
};

export const dismissReminder = (id: string, now = new Date()) =>
  change(id, (r) => {
    need(r, OPEN, "dismissed");
    return { ...r, status: "dismissed", updatedAt: now.toISOString(), history: [...r.history, { at: now.toISOString(), status: "dismissed" as const }] };
  }, "Cancelled: the reminder was dismissed.");

export const reopenReminder = (id: string, now = new Date()) =>
  change(id, (r) => {
    need(r, ["done", "dismissed"], "reopened");
    return { ...r, status: "scheduled", updatedAt: now.toISOString(), history: [...r.history, { at: now.toISOString(), status: "scheduled" as const, note: "reopened" }] };
  }, "");

export const isDue = (r: Reminder, now: Date) => OPEN.includes(r.status) && new Date(r.dueAt).getTime() <= now.getTime();

export { getReminder, listReminders };
