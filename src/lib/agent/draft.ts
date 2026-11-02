import { z } from "zod";
import { type ParsedCv, rangeMonths, Span } from "../cv/parse";
import type { JobInput } from "./job";
import { type RequirementResult, usable } from "./match";

// Resume and cover-letter drafts. Every sentence is either a CV line (copied unchanged), a fixed heading, a duration
// computed from dates the CV itself gives, or a template sentence that states only facts about the JOB. Each CV-based
// line carries the character span of its source, so the whole draft can be traced to the original text and checked.
// A model could later reword lines, but only if every claim still validates against its evidence (see `claimProblems`).

export const DraftLine = z.object({
  text: z.string(),
  kind: z.enum(["heading", "cv", "computed", "template"]),
  /** where in the CV text the words come from (cv and computed lines) */
  evidence: z.object({ quote: z.string(), span: Span }).nullable(),
  /** the job requirement this line answers, when it is a claim made to the employer */
  requirement: z.string().nullable().default(null),
  /** how the claim is backed: found verbatim, or an ambiguous match you confirmed */
  basis: z.enum(["verified", "confirmed_by_you"]).nullable().default(null),
});
export type DraftLine = z.infer<typeof DraftLine>;

export const RESUME_HEADINGS = ["Summary", "Experience", "Projects", "Skills most relevant to this role", "Other skills", "Education", "Certifications", "Your CV (no sections were found)"] as const;

export const ResumeDraft = z.object({
  text: z.string(),
  lines: z.array(DraftLine),
  /** requirements that are NOT claimed in the resume because the CV doesn't back them (or you rejected them) */
  unsupported: z.array(z.string()),
  /** words or numbers in the text that are in neither your CV nor the job (e.g. after you edit). Review them. */
  flags: z.array(z.string()),
});
export type ResumeDraft = z.infer<typeof ResumeDraft>;

export const CoverLetter = z.object({
  text: z.string(),
  lines: z.array(DraftLine),
  unsupported: z.array(z.string()),
  flags: z.array(z.string()),
});
export type CoverLetter = z.infer<typeof CoverLetter>;

const monthsLabel = (m: number) => {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return [y ? `${y} year${y === 1 ? "" : "s"}` : "", r ? `${r} month${r === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ") || "under a month";
};
const slice = (text: string, s: { start: number; end: number }) => text.slice(s.start, s.end);
const ev = (text: string, span: { start: number; end: number }) => ({ quote: slice(text, span), span });

export const unsupportedOf = (rs: RequirementResult[]) => rs.filter((r) => !usable(r)).map((r) => r.requirement);

// ───────────────────────── resume ─────────────────────────

export function buildResume(job: JobInput, results: RequirementResult[], text: string, cv: ParsedCv, now: Date): ResumeDraft {
  const lines: DraftLine[] = [];
  const cvLine = (span: { start: number; end: number }, prefix = ""): DraftLine => ({ text: `${prefix}${slice(text, span)}`, kind: "cv", evidence: ev(text, span), requirement: null, basis: null });
  const heading = (h: (typeof RESUME_HEADINGS)[number]): DraftLine => ({ text: h, kind: "heading", evidence: null, requirement: null, basis: null });

  // evidence the job's usable requirements rest on: those lines (and their roles) come first
  const used = results.filter(usable).flatMap((r) => r.evidence.map((e) => e.span.start));
  const isUsed = (s: { start: number; end: number }) => used.some((u) => u >= s.start && u < s.end);

  if (cv.name) lines.push(cvLine(cv.name.span));
  const contact = [...cv.contact.emails, ...cv.contact.phones, ...cv.contact.links];
  for (const c of contact) lines.push(cvLine(c.span));
  if (cv.summary) lines.push(heading("Summary"), cvLine(cv.summary.span));

  const section = (title: "Experience" | "Projects", list: ParsedCv["experience"]) => {
    if (!list.length) return;
    lines.push(heading(title));
    const ordered = list.map((e, i) => ({ e, i, rank: e.bullets.filter((b) => isUsed(b.span)).length + (isUsed({ start: e.span.start, end: e.span.start + e.header.length }) ? 1 : 0) })).sort((a, b) => b.rank - a.rank || a.i - b.i);
    for (const { e } of ordered) {
      const nl = text.indexOf("\n", e.span.start);
      lines.push(cvLine({ start: e.span.start, end: nl < 0 || nl > e.span.end ? e.span.end : nl }));
      if (e.dates) {
        const m = rangeMonths(e.dates, now);
        const approx = e.dates.precision === "year";
        lines.push({
          text: `${e.dates.raw}${m.max > 0 ? ` (${approx ? "about " : ""}${monthsLabel(approx ? Math.round((m.min + m.max) / 2) : m.min)})` : ""}`,
          kind: "computed",
          evidence: ev(text, e.dates.span),
          requirement: null,
          basis: null,
        });
      }
      const bullets = [...e.bullets].sort((a, b) => Number(isUsed(b.span)) - Number(isUsed(a.span)));
      for (const b of bullets) lines.push(cvLine(b.span, "- "));
    }
  };
  section("Experience", cv.experience);
  section("Projects", cv.projects);

  if (cv.skills.length) {
    const jobWords = new Set(job.requirements.flatMap((r) => r.toLowerCase().split(/[^\p{L}\p{N}+#./-]+/u)).filter(Boolean));
    const relevant = cv.skills.filter((s) => s.text.toLowerCase().split(/[^\p{L}\p{N}+#./-]+/u).some((w) => jobWords.has(w)));
    const other = cv.skills.filter((s) => !relevant.includes(s));
    if (relevant.length) lines.push(heading("Skills most relevant to this role"), ...relevant.map((s) => cvLine(s.span, "- ")));
    if (other.length) lines.push(heading("Other skills"), ...other.map((s) => cvLine(s.span, "- ")));
  }
  if (!cv.experience.length && !cv.projects.length && !cv.skills.length && !cv.education.length && !cv.certifications.length) {
    // no sections were recognised: keep every line of the CV, in order, rather than dropping anything
    const own = new Set(lines.map((l) => l.evidence?.span.start));
    lines.push(heading("Your CV (no sections were found)"));
    let pos = 0;
    for (const raw of text.split("\n")) {
      const lead = raw.length - raw.trimStart().length;
      const t = raw.trim();
      if (t && !own.has(pos + lead)) lines.push(cvLine({ start: pos + lead, end: pos + lead + t.length }));
      pos += raw.length + 1;
    }
  }
  if (cv.education.length) lines.push(heading("Education"), ...cv.education.map((e) => cvLine(e.span, "- ")));
  if (cv.certifications.length) lines.push(heading("Certifications"), ...cv.certifications.map((c) => cvLine(c.span, "- ")));

  const body = lines.map((l) => (l.kind === "heading" ? `\n${l.text}` : l.text)).join("\n").trim();
  const title = [job.role, job.company].filter(Boolean).join(" at ");
  return { text: title ? `Draft for: ${title}\n\n${body}` : body, lines, unsupported: unsupportedOf(results), flags: [] };
}

// ───────────────────────── cover letter ─────────────────────────

export function buildCoverLetter(job: JobInput, results: RequirementResult[], text: string, cv: ParsedCv): CoverLetter {
  const lines: DraftLine[] = [];
  const tpl = (t: string): DraftLine => ({ text: t, kind: "template", evidence: null, requirement: null, basis: null });
  lines.push(tpl(`Dear ${job.company ? `${job.company} hiring team` : "hiring team"},`), tpl(""));
  lines.push(tpl(`I am writing to apply for the ${job.role ?? "[role]"} position${job.company ? ` at ${job.company}` : ""}${job.location ? ` (${job.location})` : ""}.`), tpl(""));

  const claims = results.filter(usable).slice(0, 5);
  if (claims.length) {
    lines.push(tpl("Here is how my experience meets what you are looking for:"));
    for (const r of claims) {
      const e = r.evidence[0];
      const where = e.context && e.section !== "skills" ? `In my role as ${e.context}${e.dates ? ` (${e.dates})` : ""}: ` : e.section === "skills" ? "Skill listed on my CV: " : "";
      lines.push({
        text: `- ${r.requirement}: ${where}${e.quote.replace(/[.;]+$/, "")}.`,
        kind: "cv",
        evidence: { quote: e.quote, span: e.span },
        requirement: r.requirement,
        basis: r.status === "VERIFIED_MATCH" ? "verified" : "confirmed_by_you",
      });
    }
    lines.push(tpl(""));
  } else {
    lines.push(tpl("[TO COMPLETE: none of the job's requirements are backed by your CV yet. Say what you honestly bring, or update your CV and run this again.]"), tpl(""));
  }

  const unsupported = unsupportedOf(results);
  if (unsupported.length) {
    lines.push(tpl("[TO COMPLETE: your CV does not back the following, so they are NOT claimed above. Add your own experience ONLY if it is true, or delete this section.]"));
    for (const u of unsupported) lines.push(tpl(`- ${u}: [your experience, if any]`));
    lines.push(tpl(""));
  }
  lines.push(tpl("Thank you for your time and consideration."), tpl(""));
  lines.push(cv.name ? { text: cv.name.text, kind: "cv", evidence: ev(text, cv.name.span), requirement: null, basis: null } : tpl("[Your name]"));
  return { text: lines.map((l) => l.text).join("\n"), lines, unsupported, flags: [] };
}

// ───────────────────────── checking ─────────────────────────

const numbersOf = (s: string) => (s.match(/\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[,.]+$/, ""));

/**
 * Problems that mean a draft says something its evidence doesn't. Used on every generated draft and designed to also
 * gate any future model-written wording: a claim passes only if its evidence is real, it names a requirement of this
 * job, and it adds no number the evidence lacks.
 */
export function claimProblems(draft: { lines: DraftLine[] }, cvText: string, job: JobInput, now: Date, cv?: ParsedCv): string[] {
  const out: string[] = [];
  const reqs = new Set(job.requirements);
  const headings = new Set<string>(RESUME_HEADINGS);
  draft.lines.forEach((l, i) => {
    const where = `line ${i + 1}`;
    if (l.kind === "heading" && !headings.has(l.text)) out.push(`${where}: unknown heading “${l.text}”`);
    if (l.kind === "cv" || l.kind === "computed") {
      if (!l.evidence) return void out.push(`${where}: no evidence`);
      if (slice(cvText, l.evidence.span) !== l.evidence.quote) return void out.push(`${where}: evidence is not in the CV at that place`);
      if (l.kind === "cv") {
        const core = l.text.replace(/^- /, "");
        if (l.requirement === null && core !== l.evidence.quote) out.push(`${where}: text differs from its evidence`);
        // a claim line may add its context (role, dates) but never a number that isn't in the CV
        const unknown = numbersOf(core).filter((n) => !cvText.includes(n) && !(l.requirement ?? "").includes(n)); // numbers may come from the CV or from the job's own requirement
        if (unknown.length) out.push(`${where}: number ${unknown.join(", ")} is not in the CV`);
      }
      if (l.kind === "computed" && cv) {
        const e = [...cv.experience, ...cv.projects].find((x) => x.dates && x.dates.span.start === l.evidence!.span.start);
        if (!e?.dates || !l.text.startsWith(e.dates.raw)) out.push(`${where}: duration doesn't match the CV's dates`);
      }
    }
    if (l.requirement !== null && !reqs.has(l.requirement)) out.push(`${where}: answers a requirement the job doesn't list`);
    if (l.requirement !== null && !l.basis) out.push(`${where}: claim without a basis`);
  });
  void now;
  return out;
}

/** All-caps words that Acorn's own template text uses. */
const TEMPLATE_WORDS = new Set(["TO", "COMPLETE", "CV", "NOT", "ONLY"]);
// CamelCase, ALLCAPS and name.js words, numbers, and capitalised words in the middle of a sentence (names and technologies)
const TOKEN = /\b(?:[A-Z][a-z]+[A-Z]\w*|[A-Z]{2,}[A-Za-z]*|\w+\.js)\b|(?<=[a-z,;:] )[A-Z][a-z]{3,}\b|\b\d[\d,.]*%?/g;
/** Capitalised tech-looking words and numbers in `text` that appear in neither the CV nor the job. For the user to review. */
export function flagUnsupported(text: string, cvText: string, job: JobInput): string[] {
  const known = `${cvText}\n${job.requirements.join("\n")}\n${job.role ?? ""} ${job.company ?? ""} ${job.location ?? ""} ${job.deadline ?? ""}`.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0].replace(/[.,]+$/, "");
    if (TEMPLATE_WORDS.has(t)) continue;
    if (!known.includes(t.toLowerCase())) out.add(t);
  }
  return [...out].slice(0, 12);
}
