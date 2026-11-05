import { addDays, inQuietHours, localDate, localToUtc, quietHoursEnd, startOfNextLocalDay } from "./time";
import type { NotificationPrefs } from "./types";

// The rules for WHEN a notification may go out. Pure, so they are tested without a database or a clock.
// Nothing here ever drops a due reminder silently: it is sent, held until it may be sent, or skipped with a reason.

/** A reminder this overdue when Acorn first looks at it is not announced as if it were new: the app shows it as overdue. */
export const DEFAULT_EXPIRY_HOURS = 72;

export type Decision =
  | { action: "send" }
  | { action: "hold"; until: Date; reason: string }
  | { action: "skip"; reason: string };

export function decide(input: { now: Date; prefs: NotificationPrefs; channel: "in_app" | "email"; dueAt?: Date; sentToday: number; expiryHours?: number; ignoreExpiry?: boolean }): Decision {
  const { now, prefs, channel, dueAt, sentToday } = input;
  if (!prefs.enabled) return { action: "skip", reason: "Notifications are switched off." };
  if (channel === "in_app" && !prefs.inApp) return { action: "skip", reason: "In-app notifications are switched off." };
  if (channel === "email" && !prefs.email) return { action: "skip", reason: "Email notifications are switched off." };
  const hours = input.expiryHours ?? DEFAULT_EXPIRY_HOURS;
  if (!input.ignoreExpiry && dueAt && now.getTime() - dueAt.getTime() > hours * 3_600_000) {
    return { action: "skip", reason: `Expired: it was due more than ${hours} hours before Acorn could notify you, so it is shown as overdue instead.` };
  }
  if (inQuietHours(now, prefs.timezone, prefs.quietStart, prefs.quietEnd)) {
    return { action: "hold", until: quietHoursEnd(now, prefs.timezone, prefs.quietStart, prefs.quietEnd), reason: `Held for your quiet hours (${prefs.quietStart}-${prefs.quietEnd}).` };
  }
  if (sentToday >= prefs.maxPerDay) {
    // the next local day, and not into quiet hours that start right at midnight
    const next = startOfNextLocalDay(now, prefs.timezone);
    return { action: "hold", until: quietHoursEnd(next, prefs.timezone, prefs.quietStart, prefs.quietEnd), reason: `Your limit of ${prefs.maxPerDay} notifications a day was reached. It goes out tomorrow.` };
  }
  return { action: "send" };
}

/** Retry delays after a failed delivery: 1 min, 5 min, 30 min, 2 h, 6 h, then it stays failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const retryDelay = (attemptsSoFar: number): number | null => (attemptsSoFar >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[Math.min(attemptsSoFar - 1, RETRY_DELAYS_MS.length - 1)]);

/** The instant the daily briefing is due on the local day of `now`. */
export const briefingDueAt = (now: Date, prefs: NotificationPrefs): Date => localToUtc(localDate(now, prefs.timezone), prefs.briefingHour, 0, prefs.timezone);

/** The key that makes a briefing happen at most once per local day. */
export const briefingKey = (now: Date, prefs: NotificationPrefs) => `briefing:${localDate(now, prefs.timezone)}`;

/** A briefing older than this when Acorn gets to it is skipped: a morning briefing in the evening is noise. */
export const BRIEFING_GRACE_MS = 6 * 3_600_000;

export { addDays };
