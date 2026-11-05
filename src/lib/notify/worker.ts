import type { Plan, Reminder } from "../agent/schema";
import type { Memory } from "../schema";
import { buildBriefing } from "./briefing";
import type { Snapshot } from "./followthrough";
import { reminderMessage, renderEmail } from "./message";
import type { EmailProvider } from "./providers";
import { briefingDueAt, BRIEFING_GRACE_MS, briefingKey, decide, DEFAULT_EXPIRY_HOURS, retryDelay } from "./policy";
import { localDate, startOfLocalDay } from "./time";
import type { Channel, Delivery, NotificationPrefs } from "./types";

// The scheduled worker: one idempotent pass, safe to run every minute from any scheduler and safe to run twice at once.
//   1. queue   a notification for every due reminder nobody has been told about (deduped by reminder + due time + channel)
//   2. deliver everything queued whose time has come, after checking again that it is still wanted and allowed
//   3. brief   users who asked for a daily briefing, once per local day
// It only ever reads what it needs for one user at a time, and it records every outcome (sent, held, skipped, failed).
// It does not send anything itself: it calls the providers it is given, so tests hand it recorders.

export type DueReminder = { userId: string; reminder: Reminder; memory: Memory; plans: Plan[]; prefs: NotificationPrefs };
export type ClaimedDelivery = { userId: string; delivery: Delivery; prefs: NotificationPrefs; email: string | null; reminder: Reminder | null };

export interface WorkerStore {
  /** open reminders that are due and have no delivery record for their current due time yet */
  unprocessedDueReminders(now: Date, limit: number): Promise<DueReminder[]>;
  deliveryExists(userId: string, dedupeKey: string): Promise<boolean>;
  /** false when a delivery with the same dedupe key already exists (nothing is written) */
  insertDelivery(userId: string, d: Delivery): Promise<boolean>;
  /** pending deliveries whose time has come, taken atomically and leased so no other run takes them */
  claimDeliveries(now: Date, limit: number, leaseSeconds: number): Promise<ClaimedDelivery[]>;
  updateDelivery(id: string, patch: Partial<Pick<Delivery, "status" | "reason" | "attempts" | "lastError" | "scheduledFor" | "sentAt">>): Promise<void>;
  sentCount(userId: string, since: Date, channel: Channel): Promise<number>;
  briefingUsers(): Promise<{ userId: string; prefs: NotificationPrefs; email: string | null }[]>;
  snapshot(userId: string, now: Date): Promise<Snapshot>;
}

export type TickSummary = { queued: number; skipped: number; sent: number; held: number; retried: number; failed: number; briefings: number };
export type TickOptions = { email: EmailProvider | null; baseUrl: string | null; expiryHours?: number; newId?: () => string };

const LEASE_SECONDS = 300;
const BATCH = 100;

export async function tick(store: WorkerStore, opts: TickOptions, now: Date): Promise<TickSummary> {
  const sum: TickSummary = { queued: 0, skipped: 0, sent: 0, held: 0, retried: 0, failed: 0, briefings: 0 };
  const id = opts.newId ?? (() => crypto.randomUUID());
  const at = now.toISOString();
  const emailReady = opts.email !== null;
  const row = (d: Pick<Delivery, "reminderId" | "kind" | "channel" | "status" | "reason" | "scheduledFor" | "dueAt" | "dedupeKey" | "payload">): Delivery => ({
    id: id(), attempts: 0, lastError: null, sentAt: null, readAt: null, lockedUntil: null, createdAt: at, updatedAt: at, ...d,
  });

  // 1. queue notifications for due reminders
  for (const due of await store.unprocessedDueReminders(now, BATCH)) {
    const { userId, reminder, prefs } = due;
    const payload = reminderMessage({ reminder, memory: due.memory, plans: due.plans, tz: prefs.timezone });
    const base = { reminderId: reminder.id, kind: "reminder" as const, dueAt: reminder.dueAt, payload };
    const key = (c: Channel) => `reminder:${reminder.id}:${Date.parse(reminder.dueAt)}:${c}`;
    let made = 0;
    let why = prefs.enabled ? "No notification channel is switched on." : "Notifications are switched off.";
    for (const channel of ["in_app", "email"] as const) {
      if (!prefs.enabled || (channel === "in_app" ? !prefs.inApp : !prefs.email)) continue;
      if (channel === "email" && !emailReady) {
        if (await store.insertDelivery(userId, row({ ...base, channel, status: "skipped", reason: "Email isn't set up on this server.", scheduledFor: at, dedupeKey: key(channel) }))) sum.skipped++;
        made++;
        continue;
      }
      const d = decide({ now, prefs, channel, dueAt: new Date(reminder.dueAt), sentToday: 0, expiryHours: opts.expiryHours ?? DEFAULT_EXPIRY_HOURS });
      if (d.action === "skip") {
        if (await store.insertDelivery(userId, row({ ...base, channel, status: "skipped", reason: d.reason, scheduledFor: at, dedupeKey: key(channel) }))) sum.skipped++;
        made++;
        why = d.reason;
      } else {
        // queued for now, or for when quiet hours end; the delivery pass decides again at send time (limit, still wanted)
        const when = d.action === "hold" ? d.until.toISOString() : at;
        if (await store.insertDelivery(userId, row({ ...base, channel, status: "pending", reason: d.action === "hold" ? d.reason : null, scheduledFor: when, dedupeKey: key(channel) }))) {
          sum.queued++;
          if (d.action === "hold") sum.held++;
        }
        made++;
      }
    }
    if (made === 0 && (await store.insertDelivery(userId, row({ ...base, channel: "in_app", status: "skipped", reason: why, scheduledFor: at, dedupeKey: key("in_app") })))) sum.skipped++;
  }

  // 2. deliver what is due
  for (const c of await store.claimDeliveries(now, BATCH, LEASE_SECONDS)) {
    const { delivery: d, prefs, userId } = c;
    const finish = (patch: Parameters<WorkerStore["updateDelivery"]>[1]) => store.updateDelivery(d.id, patch);

    if (d.kind === "reminder") {
      const stillOpen = c.reminder && (c.reminder.status === "scheduled" || c.reminder.status === "snoozed") && Date.parse(c.reminder.dueAt) === Date.parse(d.dueAt ?? "");
      if (!stillOpen) {
        await finish({ status: "skipped", reason: "Cancelled: the reminder was completed, dismissed or moved before this went out." });
        sum.skipped++;
        continue;
      }
    }
    const sentToday = d.kind === "reminder" ? await store.sentCount(userId, startOfLocalDay(now, prefs.timezone), d.channel) : 0;
    const dec = decide({ now, prefs, channel: d.channel, sentToday, ignoreExpiry: true });
    if (dec.action === "skip") {
      await finish({ status: "skipped", reason: dec.reason });
      sum.skipped++;
      continue;
    }
    if (dec.action === "hold") {
      // a briefing held past its window is no longer worth sending
      if (d.kind === "briefing" && dec.until.getTime() - briefingDueAt(now, prefs).getTime() > BRIEFING_GRACE_MS) {
        await finish({ status: "skipped", reason: "Quiet hours covered the whole time this briefing was useful." });
        sum.skipped++;
      } else {
        await finish({ scheduledFor: dec.until.toISOString(), reason: dec.reason });
        sum.held++;
      }
      continue;
    }

    if (d.channel === "in_app") {
      await finish({ status: "sent", sentAt: at, reason: null, attempts: d.attempts + 1 });
      sum.sent++;
      continue;
    }
    if (!opts.email) {
      await finish({ status: "skipped", reason: "Email isn't set up on this server." });
      sum.skipped++;
      continue;
    }
    if (!c.email) {
      await finish({ status: "skipped", reason: "There is no email address on your account." });
      sum.skipped++;
      continue;
    }
    const mail = renderEmail(d.payload, opts.baseUrl);
    // the key is the delivery plus its attempt number: a redelivery after a crash (attempt count not yet saved) repeats it and is
    // dropped by the provider, while a genuine retry after a recorded failure (attempt count bumped) gets a fresh one
    const r = await opts.email.send(c.email, mail.subject, mail.text, `acorn-delivery-${d.id}-${d.attempts + 1}`);
    const attempts = d.attempts + 1;
    if (r.ok) {
      await finish({ status: "sent", sentAt: at, reason: null, lastError: null, attempts });
      sum.sent++;
    } else {
      const wait = r.retryable ? retryDelay(attempts) : null;
      if (wait === null) {
        await finish({ status: "failed", attempts, lastError: r.error, reason: r.retryable ? "Gave up after repeated failures." : "The email service rejected it." });
        sum.failed++;
      } else {
        await finish({ attempts, lastError: r.error, scheduledFor: new Date(now.getTime() + wait).toISOString(), reason: `Will retry (attempt ${attempts + 1}).` });
        sum.retried++;
      }
    }
  }

  // 3. daily briefings
  for (const u of await store.briefingUsers()) {
    const p = u.prefs;
    if (!p.enabled || !p.briefingEnabled) continue;
    const due = briefingDueAt(now, p);
    if (now.getTime() < due.getTime() || now.getTime() - due.getTime() > BRIEFING_GRACE_MS) continue;
    const key = briefingKey(now, p);
    if (await store.deliveryExists(u.userId, `${key}:in_app`)) continue;
    const snap = await store.snapshot(u.userId, now);
    const b = buildBriefing(snap);
    const mk = (channel: Channel, status: "pending" | "skipped", reason: string | null, scheduledFor = at) =>
      row({ reminderId: null, kind: "briefing", channel, status, reason, scheduledFor, dueAt: null, dedupeKey: `${key}:${channel}`, payload: b.message });
    if (b.isEmpty) {
      await store.insertDelivery(u.userId, mk("in_app", "skipped", "Nothing needed you today, so no briefing was sent."));
      sum.skipped++;
      continue;
    }
    // one decision for the briefing: held through quiet hours, or dropped if they would cover the whole time it is useful
    const when = decide({ now, prefs: p, channel: "in_app", sentToday: 0, ignoreExpiry: true });
    const queue = async (channel: Channel) => {
      if (when.action === "hold" && when.until.getTime() - due.getTime() > BRIEFING_GRACE_MS) return store.insertDelivery(u.userId, mk(channel, "skipped", "Quiet hours covered the whole time this briefing was useful."));
      return store.insertDelivery(u.userId, mk(channel, "pending", when.action === "hold" ? when.reason : null, when.action === "hold" ? when.until.toISOString() : at));
    };
    if (p.inApp) {
      if (await queue("in_app")) {
        sum.briefings++;
        if (when.action === "hold") sum.held++;
      }
    } else await store.insertDelivery(u.userId, mk("in_app", "skipped", "In-app notifications are switched off."));
    if (p.email) {
      if (opts.email) await queue("email");
      else await store.insertDelivery(u.userId, mk("email", "skipped", "Email isn't set up on this server."));
    }
  }
  return sum;
}

/** Convenience for the UI: today's local date for a user (used by pages and tests). */
export const today = (now: Date, prefs: NotificationPrefs) => localDate(now, prefs.timezone);
