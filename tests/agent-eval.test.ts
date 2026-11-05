import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchRequirements, type MatchStatus } from "@/lib/agent/match";
import { buildShoppingList, parseRecipe } from "@/lib/agent/recipe";
import { captureMemory } from "@/lib/process";
import { parseCv } from "@/lib/cv/parse";
import { fakeEmbedder } from "./helpers/fake-embedder";

// Evaluation of the phase 4.5 agent on evals/agent-dataset.json. It measures matching quality and, above all, FALSE
// POSITIVES (a requirement the CV does not support coming out "verified"). Results are written to evals/agent-results.md.
// The dataset was written alongside the rules, so this is regression protection and an error-type audit, not a held-out score.

type Req = { id: string; cv: string; text: string; expect: MatchStatus; why: string };
type RecipeCase = { id: string; title: string; text: string; entities: { name: string; kind: string }[]; expect: { servings: number | null; ingredients?: [string, number | null, string | null][]; mergedList?: [string, number | null, string | null][]; steps: number; warnings?: number; warningContains?: string } };
type Follow = { id: string; note: string; expect: string | null };
const data = JSON.parse(readFileSync("evals/agent-dataset.json", "utf8")) as { today: string; cvs: Record<string, string>; requirements: Req[]; recipes: RecipeCase[]; followups: Follow[] };
const now = new Date(`${data.today}T00:00:00Z`);

const STATUSES: MatchStatus[] = ["VERIFIED_MATCH", "POTENTIAL_MATCH", "UNVERIFIED", "MISSING"];
const run = (r: Req) => matchRequirements({ requirements: [r.text], text: data.cvs[r.cv], parsed: parseCv(data.cvs[r.cv], now), now })[0];
const rows = data.requirements.map((r) => ({ r, got: run(r) }));

describe("requirement matching on the evaluation set", () => {
  it("never verifies a requirement the CV doesn't support (false verified = 0)", () => {
    const falseVerified = rows.filter(({ r, got }) => got.status === "VERIFIED_MATCH" && r.expect !== "VERIFIED_MATCH");
    expect(falseVerified.map((x) => `${x.r.id}: ${x.r.why}`)).toEqual([]);
  });

  it("every verified result is backed by the CV's own words, at the place it points to", () => {
    for (const { r, got } of rows) {
      for (const e of got.evidence) expect(data.cvs[r.cv].slice(e.span.start, e.span.end), r.id).toBe(e.quote);
      if (got.status === "VERIFIED_MATCH") {
        expect(got.evidence.length, r.id).toBeGreaterThan(0);
        expect(got.needsConfirmation, r.id).toBe(false);
        expect(["exact", "alias"], r.id).toContain(got.method);
      }
      if (got.status === "POTENTIAL_MATCH" || got.status === "UNVERIFIED") expect(got.needsConfirmation, r.id).toBe(true);
      if (got.status === "MISSING") expect(got.evidence, r.id).toEqual([]);
    }
  });

  it("agrees with the hand labels, and every disagreement is on the safe side", () => {
    const wrong = rows.filter(({ r, got }) => got.status !== r.expect);
    // a disagreement is acceptable only if the result asks the user rather than claiming (never VERIFIED when expected otherwise)
    expect(wrong.filter(({ got }) => got.status === "VERIFIED_MATCH").length).toBe(0);
    const accuracy = 1 - wrong.length / rows.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it("a similar meaning alone can only be a potential match, never a verified one", () => {
    const embedder = fakeEmbedder();
    const cv = data.cvs.dated;
    const parsed = parseCv(cv, now);
    // pretend the embedding service says 'Kubernetes' is very close to a CV line
    const claims = matchRequirements({ requirements: ["Experience with Kubernetes"], text: cv, parsed, now, semantic: { sims: [new Array(60).fill(0.95)], min: 0.5 } })[0];
    expect(claims.status).toBe("POTENTIAL_MATCH");
    expect(claims.method).toBe("semantic");
    expect(claims.needsConfirmation).toBe(true);
    expect(claims.confidence).toBeLessThanOrEqual(0.6);
    expect(embedder.model).toBeTruthy();
    // and a low similarity changes nothing
    expect(matchRequirements({ requirements: ["Experience with Kubernetes"], text: cv, parsed, now, semantic: { sims: [new Array(60).fill(0.2)], min: 0.5 } })[0].status).toBe("MISSING");
  });
});

describe("recipe reading on the evaluation set", () => {
  for (const c of data.recipes) {
    it(`${c.id}: ${c.title}`, () => {
      const p = parseRecipe({ title: c.title, text: c.text, entities: c.entities });
      expect(p.servings?.value ?? null).toBe(c.expect.servings);
      expect(p.instructions.length).toBe(c.expect.steps);
      for (const i of p.ingredients) if (i.span) expect(c.text.slice(i.span.start, i.span.end).replace(/\s+/g, " ")).toBe(i.raw); // source-linked
      for (const s of p.instructions) expect(c.text.slice(s.span.start, s.span.end)).toBe(s.text);
      if (c.expect.ingredients) expect(p.ingredients.map((i) => [i.name, i.quantity, i.unit])).toEqual(c.expect.ingredients);
      if (c.expect.mergedList) {
        const list = buildShoppingList(p).items;
        expect(list.map((i) => [i.name, i.quantity, i.unit])).toEqual(c.expect.mergedList); // duplicates merged by name and unit, never across units
      }
      if (c.expect.warnings !== undefined) expect(p.warnings.length).toBe(c.expect.warnings);
      if (c.expect.warningContains) expect(p.warnings.join(" ")).toContain(c.expect.warningContains);
    });
  }
});

describe("follow-up intent on the evaluation set", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "acorn-fu-"));
    process.env.ACORN_DATA_DIR = dir;
    process.env.ACORN_STORAGE = "local";
    process.env.ACORN_MODE = "demo";
  });
  afterAll(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const got: { f: Follow; kind: string | null; basis: string | null }[] = [];
  for (const f of data.followups) {
    it(`${f.id}: “${f.note}”`, async () => {
      const { memory } = await captureMemory({ kind: "note", text: `${f.note} [${f.id}]` });
      const g = memory.extraction?.intentGuess ?? null;
      got.push({ f, kind: g?.kind ?? null, basis: g?.basis ?? null });
      const statedOrNothing = !g || g.basis === "stated" || g.kind !== "follow_up";
      expect(statedOrNothing).toBe(true); // a follow-up is only suggested when the user's own words say so
      if (f.expect === "follow_up") {
        expect(g?.kind).toBe("follow_up");
        expect(g?.quote).toBeTruthy(); // the source of the suggestion is shown
        expect(memory.source.text).toContain(g!.quote!); // the quote is the user's own words
      } else expect(g?.kind === "follow_up").toBe(false);
      if (f.expect === "reconnect") expect(g?.kind).toBe("reconnect");
    });
  }

  it("writes the results file", () => {
    const count = (s: MatchStatus, f: (x: (typeof rows)[number]) => MatchStatus) => rows.filter((x) => f(x) === s).length;
    const lines = [
      "# Agent evaluation results (generated by `npm run eval:agent`, do not edit)",
      "",
      `Dataset: evals/agent-dataset.json (${rows.length} requirement cases). Written alongside the rules: this is not a held-out score.`,
      "",
      "## Requirement matching",
      "",
      "| expected \\ got | " + STATUSES.join(" | ") + " |",
      "|---|" + STATUSES.map(() => "---").join("|") + "|",
      ...STATUSES.map((e) => `| ${e} | ${STATUSES.map((g) => rows.filter((x) => x.r.expect === e && x.got.status === g).length).join(" | ")} |`),
      "",
      `Accuracy: ${((1 - rows.filter((x) => x.got.status !== x.r.expect).length / rows.length) * 100).toFixed(1)}%`,
      `False verified (verified but not expected): ${rows.filter((x) => x.got.status === "VERIFIED_MATCH" && x.r.expect !== "VERIFIED_MATCH").length}`,
      `Verified precision: ${count("VERIFIED_MATCH", (x) => x.got.status) ? ((rows.filter((x) => x.got.status === "VERIFIED_MATCH" && x.r.expect === "VERIFIED_MATCH").length / count("VERIFIED_MATCH", (x) => x.got.status)) * 100).toFixed(1) : "n/a"}%`,
      `Verified recall: ${((rows.filter((x) => x.got.status === "VERIFIED_MATCH" && x.r.expect === "VERIFIED_MATCH").length / Math.max(1, count("VERIFIED_MATCH", (x) => x.r.expect))) * 100).toFixed(1)}%`,
      "",
      "### Disagreements with the hand labels",
      "",
      ...(rows.filter((x) => x.got.status !== x.r.expect).map((x) => `- ${x.r.id}: expected ${x.r.expect}, got ${x.got.status}. ${x.r.why}`).concat([]).length ? rows.filter((x) => x.got.status !== x.r.expect).map((x) => `- ${x.r.id}: expected ${x.r.expect}, got ${x.got.status}. ${x.r.why}`) : ["None."]),
      "",
      "## Follow-up intent",
      "",
      ...got.map((x) => `- ${x.f.id}: expected ${x.f.expect ?? "no follow-up"}, got ${x.kind ?? "none"}`),
      "",
    ];
    writeFileSync("evals/agent-results.md", lines.join("\n"));
    expect(lines.length).toBeGreaterThan(10);
  });
});
