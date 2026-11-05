import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { mockProvider } from "@/lib/ai/mock";
import { SAMPLES, sampleById, sampleForBytes } from "@/lib/ai/samples";
import { answerQuestion } from "@/lib/answer";
import { reclassifyIntent } from "@/lib/intent";
import { suggestPlan } from "@/lib/plan";
import { captureMemory, processMemory, removeMemory } from "@/lib/process";
import { relatedMemories } from "@/lib/related";
import { applyCorrection, effective, type Memory } from "@/lib/schema";
import { searchMemories } from "@/lib/search";
import { getMemory, listMemories, updateMemory, uploadsDir } from "@/lib/store";

// The whole local demo workflow through the real pipeline: capture -> store original -> read (mock) -> validate ->
// facts and candidate intent -> correct -> search -> answer. Nothing here calls the network or a model.

let dir: string;
const saved = { ...process.env };
const now = new Date(2026, 9, 31, 12, 0);
const byId: Record<string, Memory> = {};

async function saveSample(id: string): Promise<Memory> {
  const { POST } = await import("@/app/api/samples/route");
  const res = await POST(new Request("http://x/api/samples", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }));
  expect(res.status, `sample ${id}`).toBe(201);
  return ((await res.json()) as { memory: Memory }).memory;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-multimodal-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_MODE = "demo";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.ACORN_STORAGE;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("demo mode must never use the network"); }));
  for (const s of SAMPLES) byId[s.id] = await saveSample(s.id);
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllGlobals();
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const x = (id: string) => byId[id].extraction!;
/** the user's own memories: the store also holds the app's seeded sample memories, which are not part of these scenarios */
const mine = async () => (await listMemories()).filter((m) => !m.isSample);
const sampleLines = (id: string) => (sampleById(id)!.pages ?? [sampleById(id)!.text ?? ""]).join("\n").split("\n");

describe("sample files", () => {
  it("are real files that the demo recognises by their exact bytes", () => {
    for (const s of SAMPLES.filter((s) => s.fileName)) {
      const bytes = new Uint8Array(readFileSync(path.join("public/samples", s.fileName!)));
      expect(sampleForBytes(bytes)?.id, s.fileName).toBe(s.id);
      expect(Buffer.from(bytes).subarray(0, s.kind === "document" ? 5 : 4).toString("latin1")).toBe(s.kind === "document" ? "%PDF-" : "\x89PNG");
    }
    expect(sampleForBytes(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("1. screenshot -> structured memory (the first complete workflow)", () => {
  it("keeps the original image exactly as uploaded, privately, separate from the interpretation", async () => {
    const m = byId["job-listing"];
    expect(m.source).toMatchObject({ kind: "image", mimeType: "image/png", originalName: "job-listing-screenshot.png" });
    const stored = await readFile(path.join(uploadsDir(), m.source.fileName!));
    const original = readFileSync("public/samples/job-listing-screenshot.png");
    expect(createHash("sha256").update(stored).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
    // the memory stores a reference to the file, never a generated summary in its place
    expect(m.source.text).toBeUndefined();
    expect(m.extraction?.summary).toBeTruthy();
  });

  it("is processed, validated and marked ready, and labelled as a mock reading", () => {
    const m = byId["job-listing"];
    expect(m.status).toBe("ready");
    expect(x("job-listing").producedBy).toMatchObject({ provider: "mock", model: "acorn-heuristics-v2" });
    expect(x("job-listing").producedBy.note).toMatch(/built-in sample/);
    expect(x("job-listing").uncertainties.join(" ")).toMatch(/does not read|cannot read|built-in sample/i);
  });

  it("separates what the item states (with quotes) from the summary and from intent", () => {
    const job = x("job-listing");
    expect(job.contentType).toBe("job");
    expect(job.facts.length).toBeGreaterThanOrEqual(4);
    const lines = sampleLines("job-listing");
    for (const f of job.facts) {
      expect(lines.some((l) => l.includes(f.quote)), f.statement).toBe(true); // every fact quotes the image's own words
      expect(f.checked).toBe(false); // read from pixels: not machine-checked, and the memory says so
    }
    expect(job.facts.map((f) => f.statement)).toEqual(expect.arrayContaining(["Role: Senior Data Engineer", "Company: Northwind Labs", "Location: Remote (EU) or Lisbon"]));
    expect(job.job?.deadline).toBe("2027-01-15");
    expect(job.dates.find((d) => d.isDeadline)).toMatchObject({ date: "2027-01-15" });
    // intent is a separate, unconfirmed guess
    expect(job.intentGuess).toMatchObject({ kind: "pursue", basis: "inferred", quote: null });
    expect(effective(byId["job-listing"])).toMatchObject({ intentStatus: "suggested", intentKind: null });
  });

  it("gives alternative intents that are weaker than the main guess and equally unconfirmed", () => {
    const job = x("job-listing");
    expect(job.alternativeIntents.length).toBeGreaterThan(0);
    for (const a of job.alternativeIntents) {
      expect(a.confidence).toBeLessThan(job.intentGuess!.confidence);
      expect(a.basis).toBe("inferred");
    }
  });

  it("stores a stated intent only from the user's own caption, never from text in the screenshot", () => {
    const recipe = x("recipe-reel");
    expect(recipe.contentType).toBe("recipe");
    expect(recipe.intentGuess).toMatchObject({ kind: "try", basis: "stated", quote: "I want to try this at the weekend." });
    expect(byId["recipe-reel"].source.text).toBe("I want to try this at the weekend.");
    // the same screenshot with no caption has no stated intent
    expect(x("db-slide").intentGuess?.basis).toBe("inferred");
  });
});

describe("2. every kind of input", () => {
  it.each([
    ["job-listing", "job"],
    ["recipe-reel", "recipe"],
    ["db-slide", "technical"],
    ["event-post", "event"],
    ["product-idea", "idea"],
    ["paper-pdf", "article"],
  ])("%s is classified as %s", (id, type) => {
    expect(x(id).contentType).toBe(type);
    expect(byId[id].status).toBe("ready");
  });

  it("extracts recipe ingredients as entities and as quoted facts", () => {
    expect(x("recipe-reel").entities.filter((e) => e.kind === "ingredient").map((e) => e.name)).toEqual(
      expect.arrayContaining(["spaghetti", "garlic", "parmesan", "olive oil"]),
    );
    expect(x("recipe-reel").facts.filter((f) => f.statement.startsWith("Ingredient:")).map((f) => f.quote)).toEqual(
      expect.arrayContaining(["- 200g spaghetti", "- 50g parmesan"]),
    );
  });

  it("extracts an event's date, its RSVP deadline, who shared it and the venue", () => {
    const e = x("event-post");
    expect(e.dates.map((d) => [d.date, d.isDeadline])).toEqual(expect.arrayContaining([["2026-11-14", false], ["2026-11-10", true]]));
    expect(e.entities).toEqual(expect.arrayContaining([{ name: "Rohan Mehta", kind: "person" }, { name: "Indiranagar Social Hub", kind: "place" }]));
    expect(e.intentGuess?.kind).toBe("attend");
    // the weekday in "Saturday, 14 November 2026" was not turned into a second, guessed date
    expect(e.dates).toHaveLength(2);
  });

  it("recognises technical content and the technologies in it", () => {
    expect(x("db-slide").entities.map((e) => e.name)).toEqual(expect.arrayContaining(["postgres", "b-tree", "gin"]));
    expect(x("db-slide").intentGuess?.kind).toBe("learn");
  });

  it("treats a note's own words as the user's intent, and an unreadable item as unknown", () => {
    expect(x("product-idea").intentGuess).toMatchObject({ kind: "explore", basis: "stated" });
    expect(byId["product-idea"].source.text).toMatch(/^Product idea:/);
  });

  it("keeps page numbers for a PDF and never invents them elsewhere", () => {
    const paper = x("paper-pdf");
    expect(paper.facts.some((f) => f.page === 1)).toBe(true);
    expect(paper.facts.some((f) => f.page === 2)).toBe(true);
    const pages = sampleById("paper-pdf")!.pages!;
    for (const f of paper.facts.filter((f) => f.page)) expect(pages[f.page! - 1]).toContain(f.quote);
    for (const id of ["job-listing", "recipe-reel", "event-post"]) expect(x(id).facts.every((f) => f.page === null)).toBe(true);
    expect(byId["paper-pdf"].source).toMatchObject({ kind: "document", mimeType: "application/pdf" });
  });

  it("says plainly when it can't read a PDF or image it doesn't recognise", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n%%EOF");
    const r = await captureMemory({ kind: "document", bytes: new Uint8Array(pdf), originalName: "unknown-report.pdf" });
    expect(r.memory.extraction?.facts).toEqual([]);
    expect(r.memory.extraction?.confidence).toBeLessThanOrEqual(0.15);
    expect(r.memory.extraction?.uncertainties[0]).toMatch(/cannot read PDF contents/);
    expect(r.memory.extraction?.intentGuess).toBeNull(); // nothing to base a guess on: ask, don't guess
    await removeMemory(r.memory.id);
  });

  it("handles an ambiguous, uncaptioned image honestly", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const r = await captureMemory({ kind: "image", bytes: new Uint8Array(png), originalName: "IMG_4021.png" });
    const e = r.memory.extraction!;
    expect(e.contentType).toBe("other");
    expect(e.confidence).toBeLessThanOrEqual(0.15);
    expect(e.facts).toEqual([]);
    expect(e.intentGuess).toBeNull();
    expect(e.uncertainties[0]).toMatch(/cannot read image pixels/);
    await removeMemory(r.memory.id);
  });

  it("explains the limits of a link it can't open, and never fetches it", () => {
    const e = x("instagram-link");
    expect(e.uncertainties.join(" ")).toMatch(/Instagram posts need a sign-in, so Acorn can't see this one/);
    expect(e.confidence).toBeLessThanOrEqual(0.4);
    expect(byId["instagram-link"].source.url).toBe("https://www.instagram.com/reel/Cxample123/"); // the original link is kept
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported and unsafe links before saving anything", async () => {
    for (const url of ["ftp://example.com/x", "javascript:alert(1)", "http://user:pw@example.com/", "not a url"]) {
      await expect(captureMemory({ kind: "url", url }), url).rejects.toThrow();
    }
  });
});

describe("3. validation, mock honesty and failure handling", () => {
  it("never makes a network call in demo mode", () => {
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks a memory failed with a safe message when the model errors, and retries cleanly", async () => {
    const r = await captureMemory({ kind: "note", text: `Reconnect with Maya Rao about the design role ${Math.random()}` });
    const spy = vi.spyOn(mockProvider, "extractMemory").mockRejectedValueOnce(new AiError("Meta API rate limit hit. Try again in a minute.", "rate_limit"));
    const failed = await processMemory(r.memory.id, { force: true });
    expect(failed).toMatchObject({ status: "failed", error: "Meta API rate limit hit. Try again in a minute." });
    spy.mockRestore();
    const again = await processMemory(r.memory.id);
    expect(again?.status).toBe("ready");
    expect(again?.error).toBeUndefined();
    await removeMemory(r.memory.id);
  });

  it("rejects a malformed provider answer instead of storing it", async () => {
    const r = await captureMemory({ kind: "note", text: `Some note about gardening ${Math.random()}` });
    vi.spyOn(mockProvider, "extractMemory").mockResolvedValueOnce({ data: { title: "x", contentType: "spaceship" } });
    const failed = await processMemory(r.memory.id, { force: true });
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/unexpected shape/);
    expect(failed?.extraction?.contentType).not.toBe("spaceship");
    await removeMemory(r.memory.id);
  });

  it("drops facts whose quote isn't in the user's text (text sources are fully checkable)", async () => {
    const r = await captureMemory({ kind: "note", text: `I want to try the new bakery on Elm Street ${Math.random()}` });
    const good = (await mockProvider.extractMemory({ kind: "note", text: r.memory.source.text, now })).data as { facts: unknown[] };
    vi.spyOn(mockProvider, "extractMemory").mockResolvedValueOnce({
      data: { ...good, facts: [{ statement: "Opens at 6am", quote: "opens at 6am daily", page: null }, { statement: "On Elm Street", quote: "bakery on Elm Street", page: null }] },
    });
    const out = await processMemory(r.memory.id, { force: true });
    expect(out?.extraction?.facts.map((f) => f.statement)).toEqual(["On Elm Street"]);
    expect(out?.extraction?.facts[0].checked).toBe(true);
    expect(out?.extraction?.uncertainties.join(" ")).toMatch(/1 fact\(s\) had no supporting quote/);
    await removeMemory(r.memory.id);
  });
});

describe("4. the user can correct the interpretation", () => {
  it("corrects the title, summary, category, deadline and intent without losing Acorn's original reading", async () => {
    const id = byId["job-listing"].id;
    const m = (await updateMemory(id, (cur) => applyCorrection(cur, { title: "Northwind data role", contentType: "article", summary: "Maybe later.", userIntent: { kind: "learn" } }, now)))!;
    expect(effective(m)).toMatchObject({ title: "Northwind data role", contentType: "article", summary: "Maybe later.", intentKind: "learn", intentStatus: "corrected" });
    expect(m.extraction?.title).not.toBe("Northwind data role"); // the original reading is still there
    const back = (await updateMemory(id, (cur) => applyCorrection(cur, { restore: ["title", "contentType", "summary", "userIntent"] }, now)))!;
    expect(effective(back)).toMatchObject({ contentType: "job", intentStatus: "suggested" });
  });

  it("lets the user remove, edit and add facts, marks theirs as theirs, and restores Acorn's list", async () => {
    const id = byId["recipe-reel"].id;
    const orig = effective(byId["recipe-reel"]).facts;
    const kept = orig.filter((f) => !f.statement.includes("parmesan")).map((f) => ({ ...f }));
    kept[0] = { ...kept[0], statement: "Ingredient: 250g spaghetti" };
    const edited = (await updateMemory(id, (cur) => applyCorrection(cur, { facts: [...kept, { statement: "I'm out of lemons", by: "you" }] }, now)))!;
    const v = effective(edited);
    expect(v.edited).toContain("facts");
    expect(v.facts.some((f) => f.statement.includes("parmesan"))).toBe(false);
    expect(v.facts[0]).toMatchObject({ statement: "Ingredient: 250g spaghetti", by: "ai", quote: "- 200g spaghetti" }); // still carries its evidence
    expect(v.facts.at(-1)).toMatchObject({ statement: "I'm out of lemons", by: "you", quote: null, checked: false });
    expect(edited.extraction?.facts.some((f) => f.statement.includes("parmesan"))).toBe(true); // Acorn's list is untouched underneath
    const restored = (await updateMemory(id, (cur) => applyCorrection(cur, { restore: ["facts"] }, now)))!;
    expect(effective(restored).facts).toEqual(orig);
    expect(effective(restored).edited).not.toContain("facts");
  });

  it("rejects a malformed fact correction at the API boundary", async () => {
    const { CorrectionPatch } = await import("@/lib/schema");
    for (const facts of [[{ statement: "", by: "you" }], [{ statement: "x", by: "robot" }], [{ statement: "y".repeat(301), by: "you" }]]) {
      expect(CorrectionPatch.safeParse({ facts }).success).toBe(false);
    }
    expect(CorrectionPatch.safeParse({ facts: [{ statement: "ok", by: "you" }] }).success).toBe(true);
  });

  it("a candidate intent only becomes the user's after they choose it, and 'ask' returns a question when there is no signal", async () => {
    const note = await captureMemory({ kind: "note", text: `blue ${Math.random()}` });
    expect(note.memory.extraction?.intentGuess).toBeNull();
    const asked = await reclassifyIntent(note.memory.id);
    expect(asked?.question).toBe("What did you want to do with this?");
    expect(effective(asked!.memory)).toMatchObject({ intentStatus: "none", intentKind: null });
    await removeMemory(note.memory.id);

    const job = await reclassifyIntent(byId["job-listing"].id);
    expect(job?.question).toBeNull();
    expect(effective(job!.memory)).toMatchObject({ intentStatus: "suggested", intentKind: null });
  });
});

describe("5. natural-language search returns the right original memory", () => {
  const top = async (q: string) => {
    const hits = searchMemories(await mine(), q, now);
    return hits[0]?.memory.id;
  };
  it.each([
    ["Show me the job opportunity", "job-listing"],
    ["Find the screenshot with the database indexing explanation", "db-slide"],
    ["Which post mentioned that startup event?", "event-post"],
    ["Find the technical resources I saved about Postgres", "db-slide"],
    ["research paper about routing", "paper-pdf"],
  ])("%s -> %s", async (q, id) => {
    expect(await top(q)).toBe(byId[id].id);
  });

  it("returns both saved pasta recipes (the screenshot and the Instagram link), each with a reason", async () => {
    const hits = searchMemories(await mine(), "Find that pasta recipe I saved", now);
    const ids = hits.slice(0, 2).map((h) => h.memory.id).sort();
    expect(ids).toEqual([byId["recipe-reel"].id, byId["instagram-link"].id].sort());
  });

  it("explains why each result matched", async () => {
    const [hit] = searchMemories(await mine(), "pasta recipe", now);
    expect(hit.reasons.length).toBeGreaterThan(0);
    expect(hit.reasons.join(" ")).toMatch(/pasta|recipe/i);
  });
});

describe("6. evidence-grounded answers", () => {
  const ask = async (q: string) => answerQuestion(q, await mine(), { now });

  it("answers from the recipe's own facts, cites them, and links the original memory", async () => {
    const r = await ask("What were the ingredients in the recipe?");
    expect(r.noReliableMatch).toBe(false);
    expect(r.answer).toMatch(/spaghetti/);
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) {
      expect(c.memoryId).toBe(byId["recipe-reel"].id);
      expect(sampleLines("recipe-reel").some((l) => l.includes(c.quote))).toBe(true);
    }
    expect(r.matches[0].memoryId).toBe(byId["recipe-reel"].id);
    expect(r.by).toMatchObject({ provider: "mock" });
  });

  it("answers a deadline question with the saved date and its source", async () => {
    const r = await ask("When does the job listing close?");
    expect(r.noReliableMatch).toBe(false);
    expect(r.answer).toMatch(/2027-01-15/);
    expect(r.citations[0].memoryId).toBe(byId["job-listing"].id);
  });

  it("does not claim to know what the user wanted until they have said so", async () => {
    const before = await ask("What did I want to do with the lemon garlic pasta?");
    expect(before.answer).toMatch(/haven't told Acorn why you saved/);
    expect(before.answer).not.toMatch(/you told Acorn you wanted/);
    await updateMemory(byId["recipe-reel"].id, (m) => applyCorrection(m, { userIntent: { kind: "try" } }, now));
    const after = await ask("What did I want to do with the lemon garlic pasta?");
    expect(after.answer).toMatch(/you told Acorn you wanted to: try it/i);
    await updateMemory(byId["recipe-reel"].id, (m) => applyCorrection(m, { restore: ["userIntent"] }, now));
  });

  it("says there's no reliable match instead of inventing one", async () => {
    for (const q of ["Find the technical resources I saved about Redis", "What is the capital of France?", "zebra unicorn xylophone"]) {
      const r = await ask(q);
      expect(r.noReliableMatch, q).toBe(true);
      expect(r.citations, q).toEqual([]);
      expect(r.answer, q).toMatch(/couldn't find|none of|won't/i);
    }
  });

  it("makes no model call at all when nothing was retrieved", async () => {
    const spy = vi.spyOn(mockProvider, "answerFromMemories");
    await ask("zebra unicorn xylophone");
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops citations that are not in the saved memory, and refuses an answer left with none", async () => {
    const invented = { ...mockProvider, answerFromMemories: async () => ({ data: { answer: "It has truffle oil.", citations: [{ memoryId: byId["recipe-reel"].id, quote: "- 1 tbsp truffle oil" }], noReliableMatch: false } }) };
    const r = await answerQuestion("pasta recipe ingredients", await mine(), { now, provider: invented });
    expect(r.noReliableMatch).toBe(true);
    expect(r.droppedCitations).toBe(1);
    expect(r.answer).not.toMatch(/truffle/);

    const mixed = {
      ...mockProvider,
      answerFromMemories: async () => ({
        data: {
          answer: "It has spaghetti.",
          citations: [{ memoryId: byId["recipe-reel"].id, quote: "- 200g spaghetti" }, { memoryId: "00000000-0000-4000-8000-000000000000", quote: "made up" }],
          noReliableMatch: false,
        },
      }),
    };
    const m = await answerQuestion("pasta recipe ingredients", await mine(), { now, provider: mixed });
    expect(m.noReliableMatch).toBe(false);
    expect(m.citations).toHaveLength(1);
    expect(m.droppedCitations).toBe(1);
  });

  it("rejects a citation to a memory that wasn't retrieved", async () => {
    const wrong = { ...mockProvider, answerFromMemories: async () => ({ data: { answer: "x", citations: [{ memoryId: byId["event-post"].id, quote: "Founders & Builders Meetup — Bengaluru" }], noReliableMatch: false } }) };
    const r = await answerQuestion("pasta recipe", await mine(), { now, provider: wrong });
    expect(r.citations).toEqual([]); // the event memory is real, but it wasn't part of this question's retrieval
    expect(r.noReliableMatch).toBe(true);
  });
});

describe("7. connected memories and next steps", () => {
  it("connects memories through what they share, and says why", async () => {
    const all = await mine();
    const related = relatedMemories(all.find((m) => m.id === byId["job-listing"].id)!, all);
    const db = related.find((r) => r.memory.id === byId["db-slide"].id);
    expect(db).toBeDefined();
    expect(db!.reasons.join(" ")).toMatch(/Both mention “postgres/i); // "PostgreSQL" in the job and "Postgres" in the slide are one thing
    // one weak overlap is not a connection
    expect(relatedMemories(all.find((m) => m.id === byId["event-post"].id)!, all)).toEqual([]);
  });

  it("suggests next steps grounded in the memory's own facts, without creating anything", async () => {
    const r = await suggestPlan(byId["job-listing"].id);
    expect(r!.by.provider).toBe("mock");
    expect(r!.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(["review", "apply"]));
    expect(r!.steps.find((s) => s.kind === "apply")!.label).toContain("2027-01-15");
    for (const s of r!.steps) expect(s.rationale).toBeTruthy();
    const { listActions } = await import("@/lib/store");
    expect((await listActions(byId["job-listing"].id)).length).toBe(0);
    expect(await suggestPlan("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("8. deleting removes the original too", () => {
  it("removes the file and the memory, and tolerates a second delete", async () => {
    const r = await captureMemory({ kind: "image", bytes: new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4/58BAAUAAf+RHY9QAAAAAElFTkSuQmCC", "base64")), originalName: "tiny.png" });
    const file = path.join(uploadsDir(), r.memory.source.fileName!);
    await expect(readFile(file)).resolves.toBeDefined();
    expect(await removeMemory(r.memory.id)).toBe(true);
    await expect(readFile(file)).rejects.toThrow(/ENOENT/);
    expect(await getMemory(r.memory.id)).toBeNull();
    expect(await removeMemory(r.memory.id)).toBe(false);
  });
});
