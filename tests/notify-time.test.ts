import { describe, expect, it } from "vitest";
import { briefingDueAt, briefingKey, decide, MAX_ATTEMPTS, retryDelay } from "@/lib/notify/policy";
import { addDays, formatInZone, inQuietHours, isValidTimezone, localDate, localToUtc, offsetMs, quietHoursEnd, startOfLocalDay, startOfNextLocalDay } from "@/lib/notify/time";
import { DEFAULT_PREFS, NotificationPrefs, type NotificationPrefs as Prefs } from "@/lib/notify/types";

const iso = (d: Date) => d.toISOString();
const NY = "America/New_York";
const prefs = (p: Partial<Prefs> = {}): Prefs => ({ ...DEFAULT_PREFS, timezone: "Asia/Kolkata", ...p });

describe("time zones", () => {
  it("validates IANA names and rejects junk", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    for (const bad of ["", "Mars/Olympus", "../etc/passwd", "IST; drop table", "Asia/Kolkata\n"]) expect(isValidTimezone(bad), bad).toBe(false);
  });

  it("converts a wall-clock time to the right instant, including half-hour and no-DST zones", () => {
    expect(iso(localToUtc("2026-11-05", 9, 0, "Asia/Kolkata"))).toBe("2026-11-05T03:30:00.000Z");
    expect(iso(localToUtc("2026-07-01", 9, 0, "UTC"))).toBe("2026-07-01T09:00:00.000Z");
    expect(iso(localToUtc("2026-07-01", 9, 0, "Asia/Kathmandu"))).toBe("2026-07-01T03:15:00.000Z");
    expect(iso(localToUtc("2026-01-15", 9, 0, NY))).toBe("2026-01-15T14:00:00.000Z"); // EST
    expect(iso(localToUtc("2026-07-15", 9, 0, NY))).toBe("2026-07-15T13:00:00.000Z"); // EDT
    expect(iso(localToUtc("2026-12-01", 9, 0, "Australia/Sydney"))).toBe("2026-11-30T22:00:00.000Z"); // AEDT, the day before in UTC
  });

  it("spring forward: a time that doesn't exist moves forward by the gap", () => {
    // New York, 2026-03-08: 02:00-03:00 never happens
    expect(iso(localToUtc("2026-03-08", 2, 30, NY))).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(iso(localToUtc("2026-03-08", 1, 59, NY))).toBe("2026-03-08T06:59:00.000Z"); // still EST
    expect(iso(localToUtc("2026-03-08", 3, 0, NY))).toBe("2026-03-08T07:00:00.000Z");
    // London, 2026-03-29: 01:00-02:00 never happens
    expect(iso(localToUtc("2026-03-29", 1, 30, "Europe/London"))).toBe("2026-03-29T01:30:00.000Z"); // 02:30 BST
  });

  it("fall back: a time that happens twice means its first occurrence", () => {
    // New York, 2026-11-01: 01:00-02:00 happens twice (EDT, then EST). Today in this project.
    expect(iso(localToUtc("2026-11-01", 1, 30, NY))).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, the first one
    expect(iso(localToUtc("2026-11-01", 2, 30, NY))).toBe("2026-11-01T07:30:00.000Z"); // 02:30 EST, once
    expect(iso(localToUtc("2026-10-25", 1, 30, "Europe/London"))).toBe("2026-10-25T00:30:00.000Z"); // BST
  });

  it("a 30-minute DST zone (Lord Howe) is handled", () => {
    // clocks go forward 30 minutes on 2026-10-04 at 02:00
    expect(iso(localToUtc("2026-10-04", 2, 15, "Australia/Lord_Howe"))).toBe("2026-10-03T15:45:00.000Z"); // moved forward by the half-hour gap to 02:45 local
    expect(offsetMs(new Date("2026-10-03T14:00:00Z"), "Australia/Lord_Howe") / 3_600_000).toBe(10.5);
    expect(offsetMs(new Date("2026-10-03T16:00:00Z"), "Australia/Lord_Howe") / 3_600_000).toBe(11);
  });

  it("days are not always 24 hours: the same local hour is 23 or 25 hours apart across a change", () => {
    const eight = (d: string) => localToUtc(d, 8, 0, NY).getTime();
    expect((eight("2026-03-08") - eight("2026-03-07")) / 3_600_000).toBe(23); // clocks go forward during the night
    expect((eight("2026-11-01") - eight("2026-10-31")) / 3_600_000).toBe(25); // and back
    expect((eight("2026-06-02") - eight("2026-06-01")) / 3_600_000).toBe(24);
    // the start of the next day follows the calendar, not a fixed 24 hours
    expect(iso(startOfNextLocalDay(new Date("2026-11-01T12:00:00Z"), NY))).toBe("2026-11-02T05:00:00.000Z");
    expect(iso(startOfLocalDay(new Date("2026-11-01T12:00:00Z"), NY))).toBe("2026-11-01T04:00:00.000Z");
  });

  it("local dates depend on the zone, and date arithmetic crosses months and years", () => {
    const at = new Date("2026-12-31T20:00:00Z");
    expect(localDate(at, "UTC")).toBe("2026-12-31");
    expect(localDate(at, "Asia/Kolkata")).toBe("2027-01-01");
    expect(localDate(at, "America/Los_Angeles")).toBe("2026-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("formats in the user's own zone", () => {
    expect(formatInZone(new Date("2026-11-05T03:30:00Z"), "Asia/Kolkata")).toContain("09:00");
    expect(formatInZone(new Date("2026-11-05T03:30:00Z"), "Asia/Kolkata")).toContain("(Asia/Kolkata)");
  });
});

describe("quiet hours", () => {
  const q = (utc: string, tz: string, s: string | null, e: string | null) => inQuietHours(new Date(utc), tz, s, e);
  it("same-day window: start inclusive, end exclusive", () => {
    expect(q("2026-11-05T06:29:00Z", "Asia/Kolkata", "12:00", "14:00")).toBe(false); // 11:59
    expect(q("2026-11-05T06:30:00Z", "Asia/Kolkata", "12:00", "14:00")).toBe(true); // 12:00
    expect(q("2026-11-05T08:29:00Z", "Asia/Kolkata", "12:00", "14:00")).toBe(true); // 13:59
    expect(q("2026-11-05T08:30:00Z", "Asia/Kolkata", "12:00", "14:00")).toBe(false); // 14:00
  });
  it("an overnight window crosses midnight", () => {
    for (const [utc, inside] of [["2026-11-05T16:29:00Z", false], ["2026-11-05T16:30:00Z", true], ["2026-11-05T21:00:00Z", true], ["2026-11-06T01:29:00Z", true], ["2026-11-06T01:30:00Z", false]] as const) {
      expect(q(utc, "Asia/Kolkata", "22:00", "07:00"), utc).toBe(inside); // 21:59 / 22:00 / 02:30 / 06:59 / 07:00 local... see below
    }
  });
  it("no window, or an empty one, means never quiet", () => {
    expect(q("2026-11-05T21:00:00Z", "UTC", null, null)).toBe(false);
    expect(q("2026-11-05T21:00:00Z", "UTC", "10:00", "10:00")).toBe(false);
  });
  it("finds the end of the window, today or tomorrow, in the user's zone", () => {
    const e = (utc: string) => iso(quietHoursEnd(new Date(utc), "Asia/Kolkata", "22:00", "07:00"));
    expect(e("2026-11-05T17:00:00Z")).toBe("2026-11-06T01:30:00.000Z"); // 22:30 local: ends at 07:00 tomorrow
    expect(e("2026-11-05T22:00:00Z")).toBe("2026-11-06T01:30:00.000Z"); // 03:30 local: ends at 07:00 the same morning
    expect(e("2026-11-05T10:00:00Z")).toBe("2026-11-05T10:00:00.000Z"); // outside the window: unchanged
  });
  it("quiet hours follow the user's zone through a DST change", () => {
    // New York 22:00-07:00. On the night clocks fall back (2026-11-01), 01:30 happens twice and both are inside.
    expect(q("2026-11-01T05:30:00Z", NY, "22:00", "07:00")).toBe(true); // 01:30 EDT
    expect(q("2026-11-01T06:30:00Z", NY, "22:00", "07:00")).toBe(true); // 01:30 EST
    expect(iso(quietHoursEnd(new Date("2026-11-01T06:30:00Z"), NY, "22:00", "07:00"))).toBe("2026-11-01T12:00:00.000Z"); // 07:00 EST
    expect(iso(quietHoursEnd(new Date("2026-11-01T05:30:00Z"), NY, "22:00", "07:00"))).toBe("2026-11-01T12:00:00.000Z");
    expect(iso(quietHoursEnd(new Date("2026-11-01T03:30:00Z"), NY, "22:00", "07:00"))).toBe("2026-11-01T12:00:00.000Z"); // 23:30 EDT the evening before: ends tomorrow morning
  });
});

describe("delivery policy", () => {
  const now = new Date("2026-11-05T10:00:00Z"); // 15:30 in Kolkata
  it("sends when allowed", () => {
    expect(decide({ now, prefs: prefs(), channel: "in_app", dueAt: now, sentToday: 0 })).toEqual({ action: "send" });
  });
  it("respects the master switch and each channel", () => {
    expect(decide({ now, prefs: prefs({ enabled: false }), channel: "in_app", sentToday: 0 })).toMatchObject({ action: "skip", reason: expect.stringMatching(/switched off/) });
    expect(decide({ now, prefs: prefs({ inApp: false }), channel: "in_app", sentToday: 0 }).action).toBe("skip");
    expect(decide({ now, prefs: prefs({ email: false }), channel: "email", sentToday: 0 }).action).toBe("skip");
    expect(decide({ now, prefs: prefs({ email: true }), channel: "email", sentToday: 0 }).action).toBe("send");
  });
  it("holds during quiet hours until they end, and says why", () => {
    const d = decide({ now, prefs: prefs({ quietStart: "15:00", quietEnd: "16:00" }), channel: "in_app", dueAt: now, sentToday: 0 });
    expect(d).toMatchObject({ action: "hold", reason: expect.stringMatching(/quiet hours/) });
    expect(iso((d as { until: Date }).until)).toBe("2026-11-05T10:30:00.000Z"); // 16:00 local
  });
  it("holds when the daily limit is reached until the next LOCAL day, never dropping it", () => {
    const d = decide({ now, prefs: prefs({ maxPerDay: 3 }), channel: "in_app", dueAt: now, sentToday: 3 });
    expect(d).toMatchObject({ action: "hold" });
    expect(iso((d as { until: Date }).until)).toBe("2026-11-05T18:30:00.000Z"); // 00:00 on 6 Nov in Kolkata
    expect(decide({ now, prefs: prefs({ maxPerDay: 3 }), channel: "in_app", sentToday: 2 }).action).toBe("send");
  });
  it("the next day's start is pushed past quiet hours that begin at midnight", () => {
    const d = decide({ now, prefs: prefs({ maxPerDay: 1, quietStart: "00:00", quietEnd: "07:00" }), channel: "in_app", sentToday: 1 });
    expect(iso((d as { until: Date }).until)).toBe("2026-11-06T01:30:00.000Z"); // 07:00 on 6 Nov
  });
  it("skips a reminder that was already stale when Acorn first saw it", () => {
    const old = new Date(now.getTime() - 100 * 3_600_000);
    expect(decide({ now, prefs: prefs(), channel: "in_app", dueAt: old, sentToday: 0 })).toMatchObject({ action: "skip", reason: expect.stringMatching(/Expired/) });
    expect(decide({ now, prefs: prefs(), channel: "in_app", dueAt: new Date(now.getTime() - 71 * 3_600_000), sentToday: 0 }).action).toBe("send");
  });
});

describe("retries and the daily briefing clock", () => {
  it("backs off and gives up", () => {
    expect([1, 2, 3, 4, 5].map(retryDelay)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
    expect(retryDelay(MAX_ATTEMPTS)).toBeNull();
  });
  it("the briefing is due at the user's local hour, once per local day", () => {
    const p = prefs({ timezone: NY, briefingHour: 8 });
    expect(iso(briefingDueAt(new Date("2026-11-01T14:00:00Z"), p))).toBe("2026-11-01T13:00:00.000Z"); // 08:00 EST... after the change
    expect(briefingKey(new Date("2026-11-01T14:00:00Z"), p)).toBe("briefing:2026-11-01");
    expect(briefingKey(new Date("2026-11-02T04:30:00Z"), p)).toBe("briefing:2026-11-01"); // 23:30 the evening before still counts as the 1st
    expect(briefingKey(new Date("2026-11-02T05:30:00Z"), p)).toBe("briefing:2026-11-02");
  });
  it("preferences validate: quiet hours come as a pair, times are HH:MM", () => {
    expect(NotificationPrefs.safeParse({ ...DEFAULT_PREFS, quietStart: "22:00" }).success).toBe(false);
    expect(NotificationPrefs.safeParse({ ...DEFAULT_PREFS, quietStart: "25:00", quietEnd: "07:00" }).success).toBe(false);
    expect(NotificationPrefs.safeParse({ ...DEFAULT_PREFS, quietStart: "22:00", quietEnd: "07:00" }).success).toBe(true);
    expect(NotificationPrefs.safeParse({ ...DEFAULT_PREFS, maxPerDay: 0 }).success).toBe(false);
  });
});
