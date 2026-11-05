// Time zones, done with Intl and no library. Everything stores absolute instants (UTC); a time zone only matters when a
// person says "9am" or "quiet from 22:00", which means 9am or 22:00 on THEIR clock. Daylight-saving rules:
//   a local time that doesn't exist (clocks spring forward) moves forward by the gap, and
//   a local time that happens twice (clocks fall back) means its first occurrence.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz) || tz === "UTC";
  } catch {
    return false;
  }
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(at: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute, second: p.second };
}

/** How far the zone is ahead of UTC at this instant, in ms (negative for the Americas). */
export function offsetMs(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** "2026-11-01" on the wall clock of `tz` at this instant. */
export function localDate(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant at which the wall clock in `tz` reads this date and time (see the daylight-saving rules above). */
export function localToUtc(date: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  const DAY = 86_400_000;
  const o1 = offsetMs(new Date(asUtc - DAY), tz);
  const o2 = offsetMs(new Date(asUtc + DAY), tz);
  const matches = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  };
  const candidates = [...new Set([asUtc - o1, asUtc - o2])].filter(matches).sort((a, b) => a - b);
  if (candidates.length) return new Date(candidates[0]); // first occurrence when the time happens twice
  // the time doesn't exist: the clock jumped over it. Use the offset from before the jump, which lands after it.
  return new Date(asUtc - Math.min(o1, o2));
}

/** The first instant of the local day that `at` falls on. */
export function startOfLocalDay(at: Date, tz: string): Date {
  return localToUtc(localDate(at, tz), 0, 0, tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Start of the NEXT local day: not "24 hours later", because a day can be 23 or 25 hours long. */
export const startOfNextLocalDay = (at: Date, tz: string): Date => localToUtc(addDays(localDate(at, tz), 1), 0, 0, tz);

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this instant inside the user's quiet hours (start inclusive, end exclusive; a window may cross midnight)? */
export function inQuietHours(at: Date, tz: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const p = zonedParts(at, tz);
  const now = p.hour * 60 + p.minute;
  const s = toMin(start);
  const e = toMin(end);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The first instant at or after `at` that is outside quiet hours. */
export function quietHoursEnd(at: Date, tz: string, start: string | null, end: string | null): Date {
  if (!inQuietHours(at, tz, start, end)) return at;
  const p = zonedParts(at, tz);
  const e = toMin(end!);
  const nowMin = p.hour * 60 + p.minute;
  const s = toMin(start!);
  // an overnight window that we are in after its start ends tomorrow morning; otherwise it ends today
  const endsTomorrow = s > e && nowMin >= s;
  const date = endsTomorrow ? addDays(localDate(at, tz), 1) : localDate(at, tz);
  return localToUtc(date, Math.floor(e / 60), e % 60, tz);
}

/** A readable time for the user's own zone, e.g. "Sun 1 Nov, 09:00 (Asia/Kolkata)". */
export function formatInZone(at: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${f.format(at).replace(",", ",")} (${tz})`;
}
