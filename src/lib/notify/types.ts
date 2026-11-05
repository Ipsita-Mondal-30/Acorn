import { z } from "zod";

// Shared shapes for notifications. Client-safe (no server imports).

export const Channel = z.enum(["in_app", "email"]);
export type Channel = z.infer<typeof Channel>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const NotificationPrefs = z
  .object({
    /** master switch: off means nothing is delivered (reminders still show in the app) */
    enabled: z.boolean(),
    inApp: z.boolean(),
    /** email is opt-in, and also needs a configured provider */
    email: z.boolean(),
    /** IANA timezone, e.g. "Asia/Kolkata". Quiet hours and the daily briefing follow it. */
    timezone: z.string().min(1).max(64),
    quietStart: hhmm.nullable(),
    quietEnd: hhmm.nullable(),
    /** reminder notifications per local day; the rest wait for the next day, they are not dropped */
    maxPerDay: z.number().int().min(1).max(50),
    briefingEnabled: z.boolean(),
    /** local hour (0-23) the daily briefing is due */
    briefingHour: z.number().int().min(0).max(23),
    /** follow-through suggestions you dismissed: subject key -> hidden until (ISO) */
    snoozedSuggestions: z.record(z.string(), z.string()),
  })
  .refine((p) => (p.quietStart === null) === (p.quietEnd === null), "set both quiet-hours times or neither");
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  email: false,
  timezone: "UTC",
  quietStart: null,
  quietEnd: null,
  maxPerDay: 10,
  briefingEnabled: false,
  briefingHour: 8,
  snoozedSuggestions: {},
};

export const PrefsPatch = z
  .object({
    enabled: z.boolean(),
    inApp: z.boolean(),
    email: z.boolean(),
    timezone: z.string().min(1).max(64),
    quietStart: hhmm.nullable(),
    quietEnd: hhmm.nullable(),
    maxPerDay: z.number().int().min(1).max(50),
    briefingEnabled: z.boolean(),
    briefingHour: z.number().int().min(0).max(23),
  })
  .partial()
  .strict();
export type PrefsPatch = z.infer<typeof PrefsPatch>;

/** What a notification says. Built from the user's own saved data; nothing in it is invented. */
export const Message = z.object({
  kind: z.enum(["job", "recipe", "follow_up", "generic", "briefing"]),
  title: z.string().max(200),
  lines: z.array(z.string().max(500)).max(20),
  links: z.array(z.object({ label: z.string().max(100), href: z.string().max(300) })).max(8),
  /** a draft the user can send themselves (follow-ups); never sent by Acorn */
  draft: z.string().max(5000).nullable(),
});
export type Message = z.infer<typeof Message>;

export const DeliveryStatus = z.enum(["pending", "sent", "failed", "skipped"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const Delivery = z.object({
  id: z.string(),
  reminderId: z.string().nullable(),
  kind: z.enum(["reminder", "briefing"]),
  channel: Channel,
  status: DeliveryStatus,
  /** why it was skipped, deferred or failed, in words the user can read */
  reason: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** when it should go out (later than creation when it was held for quiet hours or the daily limit) */
  scheduledFor: z.string(),
  sentAt: z.string().nullable(),
  readAt: z.string().nullable(),
  /** a worker holds it until here (a crashed worker's hold just expires) */
  lockedUntil: z.string().nullable().default(null),
  /** the reminder's due time when this was queued: a rescheduled reminder gets a fresh delivery */
  dueAt: z.string().nullable(),
  /** same key = same notification: this is what makes delivery idempotent */
  dedupeKey: z.string(),
  payload: Message,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Delivery = z.infer<typeof Delivery>;
