import { describe, expect, it } from "vitest";
import { buildCoverLetter, buildResume, claimProblems, flagUnsupported, unsupportedOf } from "@/lib/agent/draft";
import { matchRequirements } from "@/lib/agent/match";
import { parseCv } from "@/lib/cv/parse";

const CV = `Asha Rao
asha.rao@example.com

Experience
Senior Frontend Engineer, Brightly Labs
Jan 2021 - Present
- Built React and TypeScript apps in production for the growth team
- Ran A/B tests on the signup funnel and reported funnel metrics weekly

Frontend Engineer, Kiln Studio
Jun 2018 - Dec 2020
- Led a Next.js migration with server rendering and web performance budgets

Skills
React, TypeScript, Next.js, SQL, A/B testing`;
const NOW = new Date("2026-11-01T00:00:00Z");
const parsed = parseCv(CV, NOW);
const job = {
  company: "Lumen Robotics",
  role: "Frontend Engineer, Growth",
  location: null,
  deadline: null,
  applyUrl: null,
  requirements: ["3+ years building production React and TypeScript apps", "Experience with Kubernetes", "Product analytics background"],
};
const results = matchRequirements({ requirements: job.requirements, text: CV, parsed, now: NOW });

describe("drafts built from the CV", () => {
  it("resume: every line is a CV line or a computed duration, with its source span, and no bullet is lost", () => {
    const r = buildResume(job, results, CV, parsed, NOW);
    expect(claimProblems(r, CV, job, NOW, parsed)).toEqual([]);
    const bullets = parsed.experience.flatMap((e) => e.bullets.map((b) => b.text));
    for (const b of bullets) expect(r.text).toContain(b);
    expect(r.lines.filter((l) => l.kind === "computed").map((l) => l.text)).toEqual(["Jan 2021 - Present (5 years 11 months)", "Jun 2018 - Dec 2020 (2 years 7 months)"]);
    expect(r.unsupported).toEqual(["Experience with Kubernetes", "Product analytics background"]); // listed for review, never claimed
    expect(r.text).not.toMatch(/Kubernetes|analytics/);
  });

  it("cover letter: claims only what is verified, marks the rest, and quotes the role and dates it comes from", () => {
    const l = buildCoverLetter(job, results, CV, parsed);
    expect(claimProblems(l, CV, job, NOW, parsed)).toEqual([]);
    const claims = l.lines.filter((x) => x.requirement);
    expect(claims.map((c) => c.requirement)).toEqual([job.requirements[0]]);
    expect(claims[0].text).toContain("Senior Frontend Engineer, Brightly Labs (Jan 2021 - Present)");
    expect(claims[0].basis).toBe("verified");
    expect(l.unsupported).toEqual(["Experience with Kubernetes", "Product analytics background"]);
    expect(l.text).toContain("NOT claimed above");
    expect(l.text).toMatch(/^Dear Lumen Robotics hiring team,/);
    expect(l.text.trimEnd().endsWith("Asha Rao")).toBe(true);
  });

  it("an answer from the user changes what is claimed: confirmed is used and labelled, rejected is not", () => {
    expect(results.map((r) => r.status)).toEqual(["VERIFIED_MATCH", "MISSING", "POTENTIAL_MATCH"]);
    const decided = results.map((r, i) => (i === 2 ? { ...r, userDecision: "confirmed" as const } : i === 0 ? { ...r, userDecision: "rejected" as const } : r));
    expect(unsupportedOf(decided)).toEqual([job.requirements[0], job.requirements[1]]);
    const l = buildCoverLetter(job, decided, CV, parsed);
    const claims = l.lines.filter((x) => x.requirement);
    expect(claims.map((c) => [c.requirement, c.basis])).toEqual([[job.requirements[2], "confirmed_by_you"]]);
    expect(claims[0].evidence!.quote).toContain("funnel metrics"); // the CV's words that the user vouched for
    expect(claimProblems(l, CV, job, NOW, parsed)).toEqual([]);
    // nothing the user did not confirm leaks into the claims
    expect(l.lines.some((x) => x.requirement === job.requirements[1])).toBe(false);
  });

  it("a letter with nothing backed says so instead of inventing a paragraph", () => {
    const none = matchRequirements({ requirements: ["Kubernetes", "Rust"], text: CV, parsed, now: NOW });
    const l = buildCoverLetter({ ...job, requirements: ["Kubernetes", "Rust"] }, none, CV, parsed);
    expect(l.text).toContain("none of the job's requirements are backed by your CV yet");
    expect(l.lines.some((x) => x.requirement)).toBe(false);
  });

  it("keeps every line of a CV that has no recognisable sections", () => {
    const flat = "Tara Menon\nI built React apps for six years.\nI ran A/B experiments on checkout.";
    const p = parseCv(flat, NOW);
    const rs = matchRequirements({ requirements: ["React experience"], text: flat, parsed: p, now: NOW });
    const r = buildResume({ ...job, requirements: ["React experience"] }, rs, flat, p, NOW);
    for (const line of flat.split("\n")) expect(r.text).toContain(line);
    expect(claimProblems(r, flat, job, NOW, p)).toEqual([]);
  });
});

describe("the claim checker catches drafts that say more than the CV does", () => {
  const base = () => structuredClone(buildCoverLetter(job, results, CV, parsed));

  it("catches invented numbers, forged evidence, unknown headings and unlisted requirements", () => {
    const withNumber = base();
    const claim = withNumber.lines.find((l) => l.requirement)!;
    claim.text += " This cut load time by 40%.";
    expect(claimProblems(withNumber, CV, job, NOW, parsed).join()).toMatch(/number 40% is not in the CV/);

    const forged = base();
    forged.lines.find((l) => l.requirement)!.evidence!.quote = "Led a team of 12 engineers";
    expect(claimProblems(forged, CV, job, NOW, parsed).join()).toMatch(/not in the CV at that place/);

    const moved = base();
    const e = moved.lines.find((l) => l.requirement)!.evidence!;
    e.span = { start: e.span.start + 3, end: e.span.end + 3 };
    expect(claimProblems(moved, CV, job, NOW, parsed).length).toBeGreaterThan(0);

    const heading = buildResume(job, results, CV, parsed, NOW);
    heading.lines.push({ text: "Awards and Achievements", kind: "heading", evidence: null, requirement: null, basis: null });
    expect(claimProblems(heading, CV, job, NOW, parsed).join()).toMatch(/unknown heading/);

    const other = base();
    other.lines.find((l) => l.requirement)!.requirement = "Led a team of 12";
    expect(claimProblems(other, CV, job, NOW, parsed).join()).toMatch(/doesn't list/);

    const noBasis = base();
    noBasis.lines.find((l) => l.requirement)!.basis = null;
    expect(claimProblems(noBasis, CV, job, NOW, parsed).join()).toMatch(/without a basis/);

    const none = base();
    none.lines.push({ text: "Won an award", kind: "cv", evidence: null, requirement: null, basis: null });
    expect(claimProblems(none, CV, job, NOW, parsed).join()).toMatch(/no evidence/);
  });

  it("a computed duration must match the CV's dates", () => {
    const r = buildResume(job, results, CV, parsed, NOW);
    const dur = r.lines.find((l) => l.kind === "computed")!;
    dur.text = "Mar 2015 - Present (11 years)";
    expect(claimProblems(r, CV, job, NOW, parsed).join()).toMatch(/duration doesn't match/);
  });
});

describe("words and numbers that are not in the CV or the job are flagged for review", () => {
  it("flags invented technologies and metrics, not the CV's own words", () => {
    const flags = flagUnsupported("I led a Terraform rollout on AWS that cut costs by 40% and used GraphQL. I built React apps with Next.js in 2021.", CV, job);
    expect(flags).toEqual(expect.arrayContaining(["Terraform", "AWS", "40%", "GraphQL"]));
    expect(flags).not.toContain("Next.js");
    expect(flags).not.toContain("2021");
    expect(flags).not.toContain("React");
  });
});
