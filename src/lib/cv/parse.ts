import { z } from "zod";

// Structured CV parsing. Deterministic rules over the extracted text: no model call, no cost, no guessing. Every
// extracted item carries the character span of the words it came from, so any claim can be traced to the original
// text (and the text to the original file, which is kept). What the rules can't read stays unread.

export const Span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() });
export type Span = z.infer<typeof Span>;

export const DateRange = z.object({
  raw: z.string(),
  /** "YYYY-MM"; with precision "year" the month is January and unknown */
  start: z.string(),
  /** "YYYY-MM", or null for "Present" */
  end: z.string().nullable(),
  precision: z.enum(["month", "year"]),
  span: Span,
});
export type DateRange = z.infer<typeof DateRange>;

const Line = z.object({ text: z.string(), span: Span });
export type Line = z.infer<typeof Line>;

export const ExperienceEntry = z.object({
  /** the words of the header line(s) exactly as written */
  header: z.string(),
  /** best-effort split of the header; either may be null. Heuristic, so check the header. */
  title: z.string().nullable(),
  org: z.string().nullable(),
  dates: DateRange.nullable(),
  bullets: z.array(Line),
  span: Span,
});
export type ExperienceEntry = z.infer<typeof ExperienceEntry>;

export const ParsedCv = z.object({
  parserVersion: z.literal("cv-rules-1"),
  name: Line.nullable(),
  contact: z.object({ emails: z.array(Line), phones: z.array(Line), links: z.array(Line) }),
  summary: Line.nullable(),
  experience: z.array(ExperienceEntry),
  projects: z.array(ExperienceEntry),
  skills: z.array(Line),
  education: z.array(z.object({ text: z.string(), dates: DateRange.nullable(), span: Span })),
  certifications: z.array(z.object({ text: z.string(), year: z.number().int().nullable(), span: Span })),
  /** things that look wrong or contradictory in the CV itself; shown to the user, never silently fixed */
  warnings: z.array(z.object({ code: z.enum(["end_before_start", "future_start", "overlap", "no_dates", "no_sections"]), message: z.string(), span: Span.optional() })),
});
export type ParsedCv = z.infer<typeof ParsedCv>;

// ───────────────────────── dates ─────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const POINT = `(?:${MON}\\s+(?:19|20)\\d{2}|(?:0?[1-9]|1[0-2])[/.](?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const END = `(?:${POINT}|present|current|now|ongoing|till\\s+date|to\\s+date)`;
const RANGE_RE = new RegExp(`(${POINT})\\s*(?:-|–|—|to)\\s*(${END})`, "i");
const SINGLE_YEAR_RE = /\b((?:19|20)\d{2})\b/;

function point(s: string): { ym: string; precision: "month" | "year" } | null {
  const t = s.trim().toLowerCase();
  let m = new RegExp(`^(${MON})\\s+((?:19|20)\\d{2})$`, "i").exec(t);
  if (m) return { ym: `${m[2]}-${String(MONTHS.indexOf(m[1].slice(0, 3)) + 1).padStart(2, "0")}`, precision: "month" };
  m = /^(0?[1-9]|1[0-2])[/.]((?:19|20)\d{2})$/.exec(t);
  if (m) return { ym: `${m[2]}-${m[1].padStart(2, "0")}`, precision: "month" };
  m = /^((?:19|20)\d{2})$/.exec(t);
  return m ? { ym: `${m[1]}-01`, precision: "year" } : null;
}

export function parseRange(line: string, offset: number): DateRange | null {
  const m = RANGE_RE.exec(line);
  if (!m) return null;
  const a = point(m[1]);
  if (!a) return null;
  const endRaw = m[2].trim().toLowerCase();
  const present = /^(present|current|now|ongoing|till\s+date|to\s+date)$/.test(endRaw);
  const b = present ? null : point(m[2]);
  if (!present && !b) return null;
  return {
    raw: m[0],
    start: a.ym,
    end: b ? b.ym : null,
    precision: a.precision === "year" || b?.precision === "year" ? "year" : "month",
    span: { start: offset + m.index, end: offset + m.index + m[0].length },
  };
}

const ymToIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/**
 * Months covered by a range, as a lower and an upper bound. With month-level dates they are equal-ish (inclusive of the
 * end month); with year-only dates the true length could be almost a year shorter or longer, so the bounds say so.
 */
export function rangeMonths(r: DateRange, now: Date): { min: number; max: number } {
  const start = ymToIndex(r.start);
  const end = r.end ? ymToIndex(r.end) : now.getFullYear() * 12 + now.getMonth();
  if (end < start) return { min: 0, max: 0 };
  if (r.precision === "month") return { min: end - start + 1, max: end - start + 1 };
  // year precision: each year-only date could fall anywhere in its year
  return { min: Math.max(0, end - start + 1 - 11), max: end - start + 1 + 11 };
}

// ───────────────────────── sections and lines ─────────────────────────

type SectionName = "summary" | "experience" | "projects" | "skills" | "education" | "certifications" | "other";
const HEADINGS: [RegExp, SectionName][] = [
  [/^(summary|profile|objective|about me|about|professional summary|career summary)$/, "summary"],
  [/^(experience|work experience|professional experience|employment|employment history|work history|career history|relevant experience)$/, "experience"],
  [/^(projects|personal projects|selected projects|key projects|side projects|open source|open-source)$/, "projects"],
  [/^(skills|technical skills|core skills|key skills|skills & tools|skills and tools|technologies|tech stack|competencies)$/, "skills"],
  [/^(education|academic background|academics|qualifications|education & training|education and training)$/, "education"],
  [/^(certifications?|licen[cs]es|licen[cs]es & certifications|certificates|courses|training)$/, "certifications"],
  [/^(awards|honou?rs|publications|languages|interests|references|volunteering|activities)$/, "other"],
];

function headingOf(line: string): SectionName | null {
  const t = line.trim().replace(/[:：]\s*$/, "").toLowerCase();
  if (!t || t.length > 40) return null;
  for (const [re, name] of HEADINGS) if (re.test(t)) return name;
  return null;
}

type L = { text: string; start: number; end: number };

function lines(text: string): L[] {
  const out: L[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: pos + lead, end: pos + lead + t.length });
    pos += raw.length + 1;
  }
  return out;
}

const BULLET = /^([-•*·▪●◦‣]|–\s|—\s|\d{1,2}[.)]\s)\s*/;
const isBullet = (t: string) => BULLET.test(t);
const stripBullet = (l: L): L => {
  const m = BULLET.exec(l.text);
  return m ? { text: l.text.slice(m[0].length), start: l.start + m[0].length, end: l.end } : l;
};
const toLine = (l: L): Line => ({ text: l.text, span: { start: l.start, end: l.end } });

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w/])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,5}[\s.-]?\d{3,5}[\s.-]?\d{0,5}(?![\w/])/g;
const LINK = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|[a-z0-9-]+\.(?:dev|io|me|com|in|org))\/[^\s|,;)]*/gi;

function splitHeader(header: string): { title: string | null; org: string | null } {
  const at = / at | @ /i.exec(header);
  if (at) return { title: header.slice(0, at.index).trim() || null, org: header.slice(at.index + at[0].length).trim() || null };
  const parts = header.split(/\s*[|,—–]\s*|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0], org: parts.slice(1).join(", ") };
  return { title: parts[0] ?? null, org: null };
}

const headerLike = (t: string) => t.split(/\s+/).length <= 14 && !/[.!?]$/.test(t) && /^[A-Z0-9(]/.test(t);

function entries(ls: L[]): ExperienceEntry[] {
  const out: ExperienceEntry[] = [];
  let cur: { head: L[]; dates: DateRange | null; bullets: Line[]; start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const header = cur.head.map((h) => h.text).join(" | ");
    // strip the date text from the header so "Brightly Labs | Jan 2021 - Present" splits as title/org
    const clean = cur.dates ? header.replace(cur.dates.raw, "").replace(/\s*[|,]\s*$/, "").replace(/^\s*[|,]\s*/, "").trim() : header;
    const { title, org } = splitHeader(clean);
    out.push({ header: clean || header, title, org, dates: cur.dates, bullets: cur.bullets, span: { start: cur.start, end: cur.end } });
    cur = null;
  };
  for (const l of ls) {
    const range = parseRange(l.text, l.start);
    const bullet = isBullet(l.text);
    const startsNew = !bullet && (!cur || ((cur.bullets.length > 0 || (cur.dates && cur.head.length > 0 && !range)) && headerLike(l.text)) || (range && cur.dates !== null));
    if (startsNew && !(range && cur && cur.dates === null && cur.bullets.length === 0)) {
      flush();
      cur = { head: [], dates: null, bullets: [], start: l.start, end: l.end };
    }
    if (!cur) cur = { head: [], dates: null, bullets: [], start: l.start, end: l.end };
    cur.end = l.end;
    if (range && !cur.dates && !bullet) {
      cur.dates = range;
      const rest = l.text.replace(range.raw, "").replace(/[|,\s–—-]+$/g, "").replace(/^[|,\s–—-]+/g, "");
      if (rest) cur.head.push({ text: rest, start: l.start, end: l.end });
    } else if (bullet || cur.head.length > 0 || cur.dates) {
      if (!bullet && cur.bullets.length === 0 && cur.head.length === 0) cur.head.push(l);
      else cur.bullets.push(toLine(bullet ? stripBullet(l) : l));
    } else cur.head.push(l);
  }
  flush();
  return out;
}

export function parseCv(text: string, now = new Date()): ParsedCv {
  const ls = lines(text);
  const sections: { name: SectionName; body: L[] }[] = [];
  const header: L[] = [];
  for (const l of ls) {
    const h = headingOf(l.text);
    if (h) sections.push({ name: h, body: [] });
    else if (sections.length) sections.at(-1)!.body.push(l);
    else header.push(l);
  }
  const of = (n: SectionName) => sections.filter((s) => s.name === n).flatMap((s) => s.body);

  const head = header.slice(0, 15);
  const contact = { emails: [] as Line[], phones: [] as Line[], links: [] as Line[] };
  for (const l of head) {
    for (const m of l.text.matchAll(EMAIL)) contact.emails.push({ text: m[0], span: { start: l.start + m.index, end: l.start + m.index + m[0].length } });
    for (const m of l.text.replace(EMAIL, (e) => " ".repeat(e.length)).matchAll(PHONE)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15 && !/^(19|20)\d{2}$/.test(digits)) contact.phones.push({ text: m[0].trim(), span: { start: l.start + m.index, end: l.start + m.index + m[0].trimEnd().length } });
    }
    for (const m of l.text.replace(EMAIL, (e) => " ".repeat(e.length)).matchAll(LINK)) contact.links.push({ text: m[0], span: { start: l.start + m.index, end: l.start + m.index + m[0].length } });
  }
  const nameLine = head.find((l) => !/[@\d/]/.test(l.text) && l.text.split(/\s+/).length <= 5 && /^\p{Lu}[\p{L}.'’ -]+$/u.test(l.text));

  const summaryLines = of("summary");
  const exp = entries(of("experience"));
  const projects = entries(of("projects"));

  const skills: Line[] = [];
  for (const l of of("skills")) {
    const body = stripBullet(l);
    const colon = body.text.indexOf(":");
    const from = colon > -1 && colon < 30 ? colon + 1 : 0;
    let pos = 0;
    for (const part of body.text.slice(from).split(/[,;|•·]/)) {
      const t = part.trim();
      const idx = body.text.indexOf(part, from + pos);
      pos = idx - from + part.length;
      if (t && t.length <= 60 && idx >= 0) {
        const lead = part.length - part.trimStart().length;
        skills.push({ text: t, span: { start: body.start + idx + lead, end: body.start + idx + lead + t.length } });
      }
    }
  }

  const education = of("education").map((l) => {
    const b = stripBullet(l);
    const range = parseRange(b.text, b.start);
    return { text: b.text, dates: range, span: { start: b.start, end: b.end } };
  });
  const certifications = of("certifications").map((l) => {
    const b = stripBullet(l);
    const y = SINGLE_YEAR_RE.exec(b.text);
    return { text: b.text, year: y ? Number(y[1]) : null, span: { start: b.start, end: b.end } };
  });

  const warnings: ParsedCv["warnings"] = [];
  const dated = [...exp, ...projects].filter((e) => e.dates);
  for (const e of dated) {
    const d = e.dates!;
    const s = ymToIndex(d.start);
    if (d.end && ymToIndex(d.end) < s) warnings.push({ code: "end_before_start", message: `“${d.raw}” ends before it starts.`, span: d.span });
    if (s > now.getFullYear() * 12 + now.getMonth() + 1) warnings.push({ code: "future_start", message: `“${d.raw}” starts in the future.`, span: d.span });
  }
  const full = exp.filter((e) => e.dates);
  for (let i = 0; i < full.length; i++) {
    for (let j = i + 1; j < full.length; j++) {
      const a = full[i].dates!;
      const b = full[j].dates!;
      const aEnd = a.end ? ymToIndex(a.end) : now.getFullYear() * 12 + now.getMonth();
      const bEnd = b.end ? ymToIndex(b.end) : now.getFullYear() * 12 + now.getMonth();
      const overlap = Math.min(aEnd, bEnd) - Math.max(ymToIndex(a.start), ymToIndex(b.start)) + 1;
      if (a.precision === "month" && b.precision === "month" && overlap > 3) {
        const message = `“${full[i].header}” and “${full[j].header}” overlap by ${overlap} months. Check the dates.`;
        warnings.push({ code: "overlap", message, span: a.span }, { code: "overlap", message, span: b.span }); // one per role, so each can be flagged
      }
    }
  }
  if (exp.length && !full.length) warnings.push({ code: "no_dates", message: "No dates were found on your experience, so Acorn can't verify years of experience." });
  if (!sections.length) warnings.push({ code: "no_sections", message: "No section headings (Experience, Skills, ...) were found, so only the raw text is available." });

  return ParsedCv.parse({
    parserVersion: "cv-rules-1",
    name: nameLine ? toLine(nameLine) : null,
    contact,
    summary: summaryLines.length ? { text: summaryLines.map((l) => l.text).join(" "), span: { start: summaryLines[0].start, end: summaryLines.at(-1)!.end } } : null,
    experience: exp,
    projects,
    skills,
    education,
    certifications,
    warnings,
  });
}

/** Every span must point at real words of the text. Used by tests and before storing a parse. */
export function checkSpans(text: string, cv: ParsedCv): string[] {
  const bad: string[] = [];
  const check = (what: string, span: Span, expect?: string) => {
    const got = text.slice(span.start, span.end);
    if (span.end > text.length || !got) bad.push(`${what}: span outside the text`);
    else if (expect !== undefined && !got.includes(expect.slice(0, 40)) && got !== expect) bad.push(`${what}: span does not contain its words`);
  };
  if (cv.name) check("name", cv.name.span, cv.name.text);
  for (const k of ["emails", "phones", "links"] as const) cv.contact[k].forEach((l, i) => check(`${k}[${i}]`, l.span, l.text));
  cv.skills.forEach((l, i) => check(`skill[${i}]`, l.span, l.text));
  for (const [kind, list] of [["experience", cv.experience], ["projects", cv.projects]] as const) {
    list.forEach((e, i) => {
      check(`${kind}[${i}]`, e.span);
      if (e.dates) check(`${kind}[${i}].dates`, e.dates.span, e.dates.raw);
      e.bullets.forEach((b, j) => check(`${kind}[${i}].bullets[${j}]`, b.span, b.text));
    });
  }
  cv.education.forEach((e, i) => check(`education[${i}]`, e.span, e.text));
  cv.certifications.forEach((e, i) => check(`certification[${i}]`, e.span, e.text));
  return bad;
}
