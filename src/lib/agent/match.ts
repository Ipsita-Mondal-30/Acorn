import { z } from "zod";
import { keyTerms } from "./job";
import { type ParsedCv, rangeMonths, Span } from "../cv/parse";

// Evidence-grounded requirement matching. For each requirement of a job, find the CV text that supports it and say how
// far it can be trusted. The rules are deliberately strict:
//   VERIFIED_MATCH  every key term (or a documented equivalent name) is in the CV's own words, and a years claim is backed
//                   by dates. Nothing needs confirming.
//   POTENTIAL_MATCH some of it is there, or only a related/similar-meaning phrase is: Acorn asks you to confirm.
//   UNVERIFIED      a CV can't prove it (eligibility, soft skills) or years are asked for but the CV gives no dates.
//   MISSING         nothing in the CV supports it.
// A similar meaning (embeddings) can only ever produce POTENTIAL_MATCH, never VERIFIED.

export const MatchStatus = z.enum(["VERIFIED_MATCH", "POTENTIAL_MATCH", "MISSING", "UNVERIFIED"]);
export type MatchStatus = z.infer<typeof MatchStatus>;

export const Evidence = z.object({
  /** the CV's own words, exactly as written */
  quote: z.string(),
  span: Span,
  section: z.enum(["experience", "projects", "skills", "education", "certifications", "summary", "other"]),
  /** the role / project the line sits under, as written */
  context: z.string().nullable(),
  dates: z.string().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

export const RequirementResult = z.object({
  requirement: z.string(),
  status: MatchStatus,
  /** rule-based, NOT a calibrated probability */
  confidence: z.number().min(0).max(1),
  evidence: z.array(Evidence).max(4),
  explanation: z.string(),
  needsConfirmation: z.boolean(),
  matchedTerms: z.array(z.string()),
  missingTerms: z.array(z.string()),
  method: z.enum(["exact", "alias", "related", "semantic", "none"]),
  years: z.object({ required: z.number(), shownMonthsMin: z.number().nullable(), shownMonthsMax: z.number().nullable() }).nullable(),
  /** the user's own call on an ambiguous match; Acorn never sets it */
  userDecision: z.enum(["confirmed", "rejected"]).nullable().default(null),
});
export type RequirementResult = z.infer<typeof RequirementResult>;

// ───────────────────────── text normalisation ─────────────────────────

/** Same thing, different spelling: rewritten to one form in both the requirement and the CV before comparing. */
const CANON: [RegExp, string][] = [
  [/\ba\s*\/\s*b[\s-]*(?:tests?|testing|experiments?|experimentation)?\b|\bab[\s-]+test(?:s|ing)?\b|\bsplit[\s-]+test(?:s|ing)?\b/g, "a/b"],
  [/\bnext\.?js\b/g, "next.js"],
  [/\bnode\.?js\b/g, "node.js"],
  [/\breact(?:\.js|js)\b/g, "react"],
  [/\bvue(?:\.js|js)\b/g, "vue"],
  [/\bpostgres(?:ql)?\b/g, "postgresql"],
  [/\bk8s\b/g, "kubernetes"],
  [/\bfront[\s-]+end\b/g, "frontend"],
  [/\bback[\s-]+end\b/g, "backend"],
  [/\bfull[\s-]+stack\b/g, "fullstack"],
  [/\bci\s*\/\s*cd\b/g, "ci/cd"],
  [/(?<![.\w])js\b/g, "javascript"],
  [/(?<![.\w])ts\b/g, "typescript"],
  [/\bamazon web services\b/g, "aws"],
  [/\bmachine learning\b/g, "machine-learning"],
  [/\bserver[\s-]+(?:side )?rendering\b/g, "ssr"],
  [/\bssr\b/g, "ssr"],
];

/** Related, not the same: finding only these makes a POTENTIAL match, never a verified one. */
const RELATED: Record<string, string[]> = {
  "a/b": ["experiment", "experiments", "experimentation", "funnel"],
  sql: ["postgresql", "mysql", "sqlite", "database", "databases"],
  postgresql: ["sql", "database", "databases"],
  database: ["sql", "postgresql", "mysql", "mongodb"],
  analytics: ["metrics", "tracking", "dashboards", "reporting"],
  frontend: ["react", "vue", "angular", "ui"],
  performance: ["optimisation", "optimization", "latency", "speed"],
  leadership: ["led", "lead", "managed", "mentored"],
  mentoring: ["mentored", "mentor", "coached"],
  testing: ["tests", "test", "jest", "vitest", "cypress"],
};

const TOKEN = /[^\p{L}\p{N}+#./-]+/u;
const canon = (s: string) => CANON.reduce((t, [re, to]) => t.replace(re, to), s.toLowerCase().replace(/[‘’]/g, "'"));
const trimTok = (t: string) => t.replace(/^[./-]+|[./-]+$/g, "");
const tokens = (s: string) => canon(s).split(TOKEN).map(trimTok).filter(Boolean);
const stem = (w: string) => (w.length > 4 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const sameWord = (a: string, b: string) => a === b || (stem(a).length >= 4 && stem(a) === stem(b));

/** What a CV cannot prove no matter how it is worded. */
const UNPROVABLE = /\b(?:authori[sz]ed to work|work authori[sz]ation|work permit|visa|sponsorship|right to work|willing(?:ness)? to (?:relocate|travel)|relocat\w*|on-?site|hybrid|remote|commut\w*|background check|security clearance|team player|self-?starter|fast-paced|passion\w*|positive attitude|good communicat\w*|excellent communicat\w*|strong communicat\w*|collaborat\w*|work ethic|interpersonal)\b/i;

// ───────────────────────── claims ─────────────────────────

export type Claim = Evidence & { entry: number | null };

/** Every sentence-sized piece of the CV that could back a requirement, each with its place in the original text. */
export function cvClaims(text: string, cv: ParsedCv): Claim[] {
  const out: Claim[] = [];
  const firstLine = (start: number) => {
    const nl = text.indexOf("\n", start);
    return { start, end: nl < 0 ? text.length : nl };
  };
  let e = 0;
  for (const [section, list] of [["experience", cv.experience], ["projects", cv.projects]] as const) {
    for (const entry of list) {
      const hdr = firstLine(entry.span.start);
      const context = entry.header;
      const dates = entry.dates?.raw ?? null;
      if (hdr.end > hdr.start) out.push({ quote: text.slice(hdr.start, hdr.end).trim(), span: hdr, section, context, dates, entry: e });
      for (const b of entry.bullets) out.push({ quote: b.text, span: b.span, section, context, dates, entry: e });
      e++;
    }
  }
  for (const s of cv.skills) out.push({ quote: s.text, span: s.span, section: "skills", context: null, dates: null, entry: null });
  // a whole skills line is one claim too: "React, Node.js" listed together backs a requirement that names both
  const seenLines = new Set<number>();
  for (const s of cv.skills) {
    const from = text.lastIndexOf("\n", s.span.start) + 1;
    if (seenLines.has(from)) continue;
    seenLines.add(from);
    const nl = text.indexOf("\n", s.span.start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(from, end).trim();
    const lead = text.slice(from, end).length - text.slice(from, end).trimStart().length;
    if (line && line !== s.text) out.push({ quote: line, span: { start: from + lead, end: from + lead + line.length }, section: "skills", context: null, dates: null, entry: null });
  }
  for (const d of cv.education) out.push({ quote: d.text, span: d.span, section: "education", context: null, dates: d.dates?.raw ?? null, entry: null });
  for (const c of cv.certifications) out.push({ quote: c.text, span: c.span, section: "certifications", context: null, dates: c.year ? String(c.year) : null, entry: null });
  if (cv.summary) out.push({ quote: cv.summary.text, span: cv.summary.span, section: "summary", context: null, dates: null, entry: null });
  // A CV with no recognisable sections still has words in it: every line is a claim (marked "other"), never nothing
  if (!cv.experience.length && !cv.projects.length && !cv.skills.length && !cv.education.length && !cv.certifications.length) {
    let pos = 0;
    for (const raw of text.split("\n")) {
      const lead = raw.length - raw.trimStart().length;
      const t = raw.trim();
      if (t.length >= 2) out.push({ quote: t, span: { start: pos + lead, end: pos + lead + t.length }, section: "other", context: null, dates: null, entry: null });
      pos += raw.length + 1;
    }
  }
  return out.filter((c) => c.quote.length >= 2);
}

const toEvidence = (c: Claim): Evidence => ({ quote: c.quote, span: c.span, section: c.section, context: c.context, dates: c.dates });

// ───────────────────────── matching ─────────────────────────

const monthsLabel = (m: number) => (m >= 12 ? `${Math.floor(m / 12)} year${Math.floor(m / 12) === 1 ? "" : "s"}${m % 12 ? ` ${m % 12} month${m % 12 === 1 ? "" : "s"}` : ""}` : `${m} month${m === 1 ? "" : "s"}`);

function unionMonths(ranges: { min: number; max: number; start: number; end: number }[]): { min: number; max: number } {
  // distinct roles may overlap in time; count shared months once (using the month index of each range)
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let min = 0;
  let max = 0;
  let curEnd = -Infinity;
  for (const r of sorted) {
    const from = Math.max(r.start, curEnd + 1);
    if (r.end >= from) {
      const share = (r.end - from + 1) / (r.end - r.start + 1);
      min += Math.round(r.min * share);
      max += Math.round(r.max * share);
    }
    curEnd = Math.max(curEnd, r.end);
  }
  return { min, max };
}

const ym = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;

export type MatchInput = {
  requirements: string[];
  text: string;
  parsed: ParsedCv;
  now: Date;
  /** optional similarity of each requirement to each claim (same order as cvClaims), from an embedding provider */
  semantic?: { sims: number[][]; min: number };
};

export function matchRequirements(input: MatchInput): RequirementResult[] {
  const { text, parsed, now } = input;
  const claims = cvClaims(text, parsed);
  const claimTokens = claims.map((c) => tokens(c.quote));
  const entries = [...parsed.experience, ...parsed.projects];
  const badEntries = new Set<number>();
  for (const w of parsed.warnings) {
    if (w.code !== "end_before_start" && w.code !== "overlap") continue;
    entries.forEach((e, i) => {
      if (e.dates && w.span && e.dates.span.start === w.span.start) badEntries.add(i);
    });
  }

  return input.requirements.map((requirement, ri) => {
    const years = /(\d+)\s*(?:\+|-\s*\d+)?\s*years?\b/i.exec(requirement);
    const need = years ? Number(years[1]) : null;
    const base = { requirement, userDecision: null, years: need === null ? null : { required: need, shownMonthsMin: null as number | null, shownMonthsMax: null as number | null } };
    const terms = [...new Set(keyTerms(canon(requirement)))].filter((t) => !/^\d+\+?$/.test(t));
    const unprovable = UNPROVABLE.test(requirement);

    // which terms each claim covers exactly, and which only by a related word
    const exact = new Map<string, number[]>();
    const related = new Map<string, number[]>();
    for (const t of terms) {
      claimTokens.forEach((toks, ci) => {
        if (toks.some((k) => sameWord(k, t))) exact.set(t, [...(exact.get(t) ?? []), ci]);
        else if ((RELATED[t] ?? []).some((r) => toks.some((k) => sameWord(k, r)))) related.set(t, [...(related.get(t) ?? []), ci]);
      });
    }
    const matched = terms.filter((t) => exact.has(t));
    const relatedOnly = terms.filter((t) => !exact.has(t) && related.has(t));
    const missing = terms.filter((t) => !exact.has(t) && !related.has(t));
    const claimIdx = (map: Map<string, number[]>, ts: string[]) => [...new Set(ts.flatMap((t) => map.get(t) ?? []))];

    // the best claims: those covering the most terms
    const score = (ci: number) => terms.filter((t) => (exact.get(t) ?? []).includes(ci)).length * 2 + terms.filter((t) => (related.get(t) ?? []).includes(ci)).length;
    const ranked = claimIdx(exact, matched).concat(claimIdx(related, relatedOnly)).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => score(b) - score(a));
    const ev = ranked.slice(0, 3).map((ci) => toEvidence(claims[ci]));
    const aliasUsed = matched.some((t) => claimTokens[(exact.get(t) ?? [])[0]]?.every((k) => k !== t));
    const found = matched.length ? `Found in your CV: ${matched.join(", ")}.` : "";
    const notFound = missing.length ? ` Not found: ${missing.join(", ")}.` : "";

    // semantic similarity can only add a POTENTIAL candidate
    const sem = input.semantic?.sims[ri];
    const semBest = sem ? sem.map((s, ci) => [s, ci] as const).filter(([s]) => s >= input.semantic!.min).sort((a, b) => b[0] - a[0])[0] : undefined;

    if (unprovable) {
      return RequirementResult.parse({
        ...base, status: "UNVERIFIED", confidence: 0.2, evidence: ev, needsConfirmation: true, matchedTerms: matched, missingTerms: missing, method: matched.length ? "exact" : "none",
        explanation: "A CV can't prove this (it is about eligibility, location or working style). Only you can say whether it is true.",
      });
    }

    if (terms.length === 0) {
      return RequirementResult.parse({
        ...base, status: "UNVERIFIED", confidence: 0.2, evidence: [], needsConfirmation: true, matchedTerms: [], missingTerms: [], method: "none",
        explanation: "This requirement has no specific skill or tool Acorn can look for. Confirm it yourself.",
      });
    }

    const bestCover = Math.max(0, ...claimTokens.map((_, ci) => terms.filter((t) => (exact.get(t) ?? []).includes(ci)).length)) / Math.max(1, terms.length);
    const allExact = matched.length === terms.length;
    if (allExact && bestCover < 0.6) {
      // every word is in the CV, but spread over unrelated lines: that is not evidence that they go together
      return RequirementResult.parse({
        ...base, status: "POTENTIAL_MATCH", confidence: 0.4, evidence: ev, needsConfirmation: true, matchedTerms: matched, missingTerms: [], method: "exact",
        explanation: `${found} The words appear in your CV, but in different places, so Acorn can't tell they describe the same thing. Confirm.`,
      });
    }
    if (allExact) {
      // a years claim must be backed by dates on the roles the evidence sits under
      if (need !== null) {
        const idx = [...new Set(ranked.map((ci) => claims[ci].entry).filter((e): e is number => e !== null))];
        const dated = idx.filter((i) => entries[i]?.dates);
        if (dated.length === 0) {
          return RequirementResult.parse({
            ...base, status: "UNVERIFIED", confidence: 0.3, evidence: ev, needsConfirmation: true, matchedTerms: matched, missingTerms: missing, method: aliasUsed ? "alias" : "exact",
            explanation: `${found} The job asks for ${need}+ years, but your CV gives no dates for this, so Acorn can't tell how long. Confirm the years yourself.`,
          });
        }
        const u = unionMonths(dated.map((i) => ({ ...rangeMonths(entries[i].dates!, now), start: ym(entries[i].dates!.start), end: entries[i].dates!.end ? ym(entries[i].dates!.end!) : now.getFullYear() * 12 + now.getMonth() })));
        const y = { required: need, shownMonthsMin: u.min, shownMonthsMax: u.max };
        const conflict = dated.some((i) => badEntries.has(i));
        if (u.min >= need * 12 && !conflict) {
          return RequirementResult.parse({
            ...base, years: y, status: "VERIFIED_MATCH", confidence: 0.8, evidence: ev, needsConfirmation: false, matchedTerms: matched, missingTerms: [], method: aliasUsed ? "alias" : "exact",
            explanation: `${found} The roles it appears under (${dated.map((i) => entries[i].dates!.raw).join("; ")}) span ${monthsLabel(u.min)}. That is the length of the roles, not necessarily the time spent on this skill.`,
          });
        }
        return RequirementResult.parse({
          ...base, years: y, status: "POTENTIAL_MATCH", confidence: 0.5, evidence: ev, needsConfirmation: true, matchedTerms: matched, missingTerms: [], method: aliasUsed ? "alias" : "exact",
          explanation: conflict
            ? `${found} The dates on these roles conflict with each other in your CV, so the years can't be trusted. Fix the dates or confirm.`
            : u.max >= need * 12
              ? `${found} The dates are only given to the year, so the time could be anywhere from ${monthsLabel(u.min)} to ${monthsLabel(u.max)}. The job asks for ${need}+ years. Confirm.`
              : `${found} Your dated roles show about ${monthsLabel(u.min)}, less than the ${need}+ years asked. Confirm whether other experience counts.`,
        });
      }
      return RequirementResult.parse({
        ...base, status: "VERIFIED_MATCH", confidence: aliasUsed ? 0.85 : 0.9, evidence: ev, needsConfirmation: false, matchedTerms: matched, missingTerms: [], method: aliasUsed ? "alias" : "exact",
        explanation: `${found} Every key term of the requirement is in your CV's own words.`,
      });
    }

    if (matched.length > 0 || relatedOnly.length > 0) {
      const ratio = (matched.length + relatedOnly.length * 0.5) / terms.length;
      return RequirementResult.parse({
        ...base, status: "POTENTIAL_MATCH", confidence: Math.round((0.25 + 0.5 * ratio) * 100) / 100, evidence: ev, needsConfirmation: true, matchedTerms: matched, missingTerms: [...relatedOnly, ...missing], method: matched.length ? "exact" : "related",
        explanation: `${found}${relatedOnly.length ? ` Only related wording for: ${relatedOnly.join(", ")}.` : ""}${notFound} This could count, but Acorn can't be sure. Confirm.`,
      });
    }

    if (semBest) {
      const [sim, ci] = semBest;
      return RequirementResult.parse({
        ...base, status: "POTENTIAL_MATCH", confidence: Math.round(Math.min(0.6, sim) * 100) / 100, evidence: [toEvidence(claims[ci])], needsConfirmation: true, matchedTerms: [], missingTerms: missing, method: "semantic",
        explanation: `No shared wording, but this CV line is similar in meaning (similarity ${sim.toFixed(2)}). A similar meaning is not proof. Confirm.`,
      });
    }

    return RequirementResult.parse({
      ...base, status: "MISSING", confidence: 0.7, evidence: [], needsConfirmation: false, matchedTerms: [], missingTerms: missing, method: "none",
      explanation: `Nothing in your CV text supports this.${notFound} If you do have it, add it to your CV; Acorn won't assume it.`,
    });
  });
}

export const countByStatus = (rs: RequirementResult[]) => ({
  verified: rs.filter((r) => r.status === "VERIFIED_MATCH").length,
  potential: rs.filter((r) => r.status === "POTENTIAL_MATCH").length,
  unverified: rs.filter((r) => r.status === "UNVERIFIED").length,
  missing: rs.filter((r) => r.status === "MISSING").length,
});

/** Results the drafts may state as true: verified, or ambiguous ones the user confirmed. Rejected ones are treated as missing. */
export const usable = (r: RequirementResult) => r.userDecision !== "rejected" && (r.status === "VERIFIED_MATCH" || r.userDecision === "confirmed") && r.evidence.length > 0;
