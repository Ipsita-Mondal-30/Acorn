import { describe, expect, it } from "vitest";
import { searchMemories } from "@/lib/search";
import { buildSeed } from "@/lib/seed";

const now = new Date(2026, 9, 27, 10, 0);
const { memories } = buildSeed(now);
const search = (q: string, ms = memories) => searchMemories(ms, q, now);

describe("searchMemories", () => {
  it("finds the pasta recipe", () => {
    const [top] = search("Find the pasta recipe I saved");
    expect(top.memory.id).toBe("sample-recipe-pasta");
    expect(top.reasons).toContain('Title mentions "pasta"');
    expect(top.reasons).toContain("It's a recipe");
  });

  it("finds last week's job listing and excludes older ones", () => {
    const hits = search("Show me the job listing from last week");
    expect(hits.map((h) => h.memory.id)).toEqual(["sample-job-lumen"]);
    expect(hits[0].reasons).toEqual(["It's a job listing", "Saved 5 days ago (last week)"]);
  });

  it("finds the database screenshot", () => {
    const [top] = search("Find the screenshot about database optimization");
    expect(top.memory.id).toBe("sample-screenshot-db");
    expect(top.reasons).toContain("Topic: database optimization");
    expect(top.reasons).toContain("Screenshot");
  });

  it("answers what I wanted to do with the lumen job", () => {
    const [top, ...rest] = search("What did I want to do with the lumen job?");
    expect(top.memory.id).toBe("sample-job-lumen");
    expect(top.reasons).toEqual(['Title mentions "lumen"', "Acorn's reading of your intent: Apply before applications close", "It's a job listing"]);
    expect(rest.every((h) => h.score < top.score)).toBe(true);
  });

  it("ranks the image first for a bare screenshot hint", () => {
    expect(search("screenshot")[0].memory.id).toBe("sample-screenshot-db");
  });

  it("returns nothing for empty or stopword-only queries", () => {
    expect(search("")).toEqual([]);
    expect(search("  find me the thing I saved  ")).toEqual([]);
  });

  it("matches plurals, prefixes and small synonyms", () => {
    expect(search("indexes")[0].memory.id).toBe("sample-screenshot-db");
    expect(search("optim")[0].memory.id).toBe("sample-screenshot-db");
    expect(search("db")[0].memory.id).toBe("sample-screenshot-db");
  });

  it("searches the user's overridden title", () => {
    const edited = memories.map((m) => (m.id === "sample-recipe-pasta" ? { ...m, overrides: { title: "Grandma's lasagna shortcut" } } : m));
    const [top] = search("lasagna", edited);
    expect(top.memory.id).toBe("sample-recipe-pasta");
    expect(top.reasons).toEqual(['Title mentions "lasagna"', "Edited by you"]);
    expect(search("lasagna")).toEqual([]);
  });

  it("is deterministic and sorted by score", () => {
    const a = search("postgres");
    expect(a).toEqual(search("postgres"));
    expect(a.map((h) => h.score)).toEqual([...a.map((h) => h.score)].sort((x, y) => y - x));
    expect(a.every((h) => h.reasons.length <= 4)).toBe(true);
  });
});

describe("answers need more than one stray word", () => {
  it("declines when only one of three specific words matches, and still answers a genuine match", async () => {
    const { answerQuestion, NO_MATCH } = await import("@/lib/answer");
    const { mockProvider } = await import("@/lib/ai/mock");
    const declined = await answerQuestion("my tax return for 2019", memories, { provider: mockProvider });
    expect(declined.noReliableMatch).toBe(true);
    expect(declined.answer).toBe(NO_MATCH);
    const real = await answerQuestion("which job listing mentions Kafka", memories, { provider: mockProvider });
    expect(real.noReliableMatch).toBe(false);
  });
});
