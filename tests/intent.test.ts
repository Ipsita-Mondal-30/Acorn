import { describe, expect, it } from "vitest";
import { proposeAction, transition } from "@/lib/actions";
import { mockProvider } from "@/lib/ai/mock";
import { applyCorrection, effective, ExtractionOutput, type Memory } from "@/lib/schema";
import { searchMemories } from "@/lib/search";
import { buildSeed } from "@/lib/seed";
import { verifyExtraction } from "@/lib/verify";

const now = new Date(2026, 9, 27, 10, 0);
/** a plain-text source: everything the model saw is also what the user wrote */
const tx = (t: string) => ({ text: t, pixels: false, userText: t });
const run = async (text: string, extra = {}) => ExtractionOutput.parse((await mockProvider.extractMemory({ kind: "note", text, now, ...extra })).data);
const guessOf = async (text: string) => (await run(text)).intentGuess;

describe("intent guesses (mock)", () => {
  it.each([
    ["I want to buy a standing desk for the study", "buy"],
    ["Want to try the new ramen place on 5th", "try"],
    ["I want to learn about Rust lifetimes", "learn"],
    ["Reconnect with Priya Nair about the design role", "reconnect"],
    ["Don't forget the wifi password is on the router", "remember"],
    ["Read this later when I have time", "do_later"],
  ] as const)("%s → %s, from the user's own words", async (text, kind) => {
    const g = await guessOf(text);
    expect(g?.kind).toBe(kind);
    expect(g?.basis).toBe("stated");
    expect(text.toLowerCase()).toContain(g!.quote!.toLowerCase());
  });

  it("a job listing is only an inferred 'pursue', with no quote and modest confidence", async () => {
    const g = await guessOf("Acme is hiring a Staff Engineer.\nRequirements:\n- 5 years of experience\nFull-time role.");
    expect(g).toMatchObject({ kind: "pursue", basis: "inferred", quote: null });
    expect(g!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("makes no guess when there is no signal", async () => {
    expect(await guessOf("blue")).toBeNull();
  });

  it("makes no guess for an uncaptioned image", async () => {
    const out = (await mockProvider.extractMemory({ kind: "image", originalName: "shot.png", now })).data;
    expect(ExtractionOutput.parse(out).intentGuess).toBeNull();
  });
});

describe("a guess is never the user's intent", () => {
  const base = (): Memory => buildSeed(now).memories.find((m) => m.id === "sample-job-lumen")!;

  it("is 'suggested' until the user acts", () => {
    const v = effective(base());
    expect(v.intentStatus).toBe("suggested");
    expect(v.intentKind).toBeNull();
    expect(v.suggestedIntent?.kind).toBe("pursue");
  });

  it("confirm / correct / set / dismiss record who decided", () => {
    const m = base();
    expect(effective(applyCorrection(m, { userIntent: { kind: "pursue" } }, now))).toMatchObject({ intentKind: "pursue", intentStatus: "confirmed", suggestedIntent: null });
    expect(effective(applyCorrection(m, { userIntent: { kind: "learn", note: "just to see the stack" } }, now))).toMatchObject({ intentKind: "learn", intentStatus: "corrected", intentNote: "just to see the stack" });
    expect(effective(applyCorrection(m, { userIntent: { kind: "none" } }, now))).toMatchObject({ intentKind: null, intentStatus: "dismissed", suggestedIntent: null });
    const noGuess = { ...m, extraction: { ...m.extraction!, intentGuess: null } };
    expect(effective(applyCorrection(noGuess, { userIntent: { kind: "buy" } }, now)).intentStatus).toBe("set");
  });

  it("undo returns to the guess, and corrections can be restored one by one", () => {
    const m = applyCorrection(base(), { userIntent: { kind: "learn" }, title: "Mine", summary: "S" }, now);
    const undone = applyCorrection(m, { restore: ["userIntent", "title"] }, now);
    const v = effective(undone);
    expect(v.intentStatus).toBe("suggested");
    expect(v.title).toBe(base().extraction!.title);
    expect(v.summary).toBe("S"); // untouched
  });

  it("a decision survives a fresh extraction", () => {
    const decided = applyCorrection(base(), { userIntent: { kind: "learn" } }, now);
    const reprocessed = { ...decided, extraction: { ...decided.extraction!, intentGuess: { ...decided.extraction!.intentGuess!, kind: "buy" as const } } };
    expect(effective(reprocessed)).toMatchObject({ intentKind: "learn", intentStatus: "corrected" });
  });

  it("old data without the new fields still loads", () => {
    const { intentGuess: _g, ...legacy } = base().extraction!;
    void _g;
    expect(() => ExtractionOutput.parse({ ...legacy })).not.toThrow();
    expect(effective({ ...base(), userIntent: undefined }).intentStatus).toBe("suggested");
  });
});

describe("search understands intent honestly", () => {
  const ms = buildSeed(now).memories;
  const ids = (q: string, list = ms) => searchMemories(list, q, now).map((h) => h.memory.id);

  it("finds only memories whose intent matches, and says it's a guess", () => {
    const hits = searchMemories(ms, "what do I want to try", now);
    expect(hits.map((h) => h.memory.id)).toContain("sample-recipe-pasta");
    expect(hits[0].reasons.join()).toContain("not confirmed");
  });

  it("ranks a confirmed intent above a guess", () => {
    const lumen = ms.find((m) => m.id === "sample-job-lumen")!;
    const confirmed = applyCorrection(lumen, { userIntent: { kind: "learn" } }, now);
    const hits = searchMemories([confirmed, ...ms.filter((m) => m.id !== lumen.id)], "things I want to learn", now);
    expect(hits[0].memory.id).toBe("sample-job-lumen");
    expect(hits[0].reasons[0]).toBe("You marked it: Learn it");
  });

  it("does not match on a guess the user rejected or replaced", () => {
    const pasta = ms.find((m) => m.id === "sample-recipe-pasta")!;
    const dismissed = applyCorrection(pasta, { userIntent: { kind: "none" } }, now);
    const replaced = applyCorrection(pasta, { userIntent: { kind: "buy" } }, now);
    expect(ids("want to try", [dismissed])).toEqual([]);
    expect(ids("want to try", [replaced])).toEqual([]);
    expect(ids("want to buy", [replaced])).toEqual(["sample-recipe-pasta"]);
  });

  it("an intent word alongside other words ranks but doesn't flood the results", () => {
    expect(ids("learn pasta")).not.toContain("sample-article-idempotency");
  });
});

describe("verifyExtraction checks what can be checked", () => {
  const base = async () => run("I want to try the ramen place. Reservation deadline: 2026-11-02. Closes Friday.");
  const hay = "I want to try the ramen place. Reservation deadline: 2026-11-02. Closes Friday.";

  it("keeps verbatim evidence and drops invented quotes", async () => {
    const out = { ...(await base()), evidence: [{ quote: "ramen place", supports: "x" }, { quote: "Michelin starred", supports: "x" }] };
    const r = verifyExtraction(out, tx(hay));
    expect(r.output.evidence.map((e) => e.quote)).toEqual(["ramen place"]);
    expect(r.notes.join()).toMatch(/could not be found/);
  });

  it("demotes a deadline whose supporting text isn't in the item", async () => {
    const out = { ...(await base()), dates: [{ date: "2026-12-25", label: "Deadline", isDeadline: true, evidence: "closes on Christmas" }] };
    const r = verifyExtraction(out, tx(hay));
    expect(r.output.dates[0].isDeadline).toBe(false);
    expect(effective({ ...buildSeed(now).memories[0], extraction: { ...buildSeed(now).memories[0].extraction!, ...r.output, facts: r.facts, dates: r.output.dates, job: null } }).deadline).toBeNull();
  });

  it("downgrades a 'stated' intent the user never said", async () => {
    const out = { ...(await base()), intentGuess: { kind: "buy" as const, confidence: 0.95, basis: "stated" as const, rationale: "r", quote: "I will buy it" } };
    const g = verifyExtraction(out, tx(hay)).output.intentGuess!;
    expect(g).toMatchObject({ basis: "inferred", quote: null });
    expect(g.confidence).toBeLessThanOrEqual(0.5);
  });

  it("keeps a genuinely stated intent", async () => {
    const out = await base();
    expect(verifyExtraction(out, tx(hay)).output.intentGuess).toMatchObject({ kind: "try", basis: "stated" });
  });

  it("can't check an uncaptioned image, so it drops nothing", async () => {
    const out = { ...(await base()), evidence: [{ quote: "pixels", supports: "x" }] };
    expect(verifyExtraction(out, { text: null, pixels: true, userText: null }).output.evidence).toHaveLength(1);
  });

  it("the mock's own output always verifies cleanly", async () => {
    for (const text of [
      "Lumen is hiring a Frontend Engineer. Location: Remote. Apply by Nov 12.\nRequirements:\n- 3+ years React",
      "Ingredients: 2 cups flour, 1 tbsp butter. Bake 20 minutes.",
      "Reconnect with Sam Lee next Friday",
      "Passport renewal deadline 2026-12-01",
    ]) {
      const out = await run(text);
      expect(verifyExtraction(out, tx(text)).notes, text).toEqual([]);
    }
  });
});

describe("executed actions need real evidence", () => {
  const m = buildSeed(now).memories[0];
  const a = () => {
    const x = proposeAction(m, { title: "Apply", kind: "executed" }, now);
    return ["awaiting_approval", "approved", "in_progress"].reduce((y, s) => transition(y, s as never, {}, now), x);
  };
  it.each(["", "   ", "ok", "done"])("rejects %j", (evidence) => {
    expect(() => transition(a(), "completed", { evidence }, now)).toThrow(/evidence/);
  });
  it("accepts a concrete confirmation", () => {
    expect(transition(a(), "completed", { evidence: "Confirmation email 'Application received' ref #A-1234" }, now).state).toBe("completed");
  });
});
