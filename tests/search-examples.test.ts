import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchMemories } from "@/lib/search";
import { SEARCH_EXAMPLES } from "@/lib/search-examples";
import { effective } from "@/lib/schema";
import { listMemories } from "@/lib/store";

// The "Try" chips and the demo script's queries must really work on the built-in demo data: a judge who clicks one must
// see a sensible answer, and a meaning-only question must honestly find nothing rather than something unrelated.

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-examples-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo" });
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const search = async (q: string) => searchMemories(await listMemories(), q, new Date());

describe("search suggestions on the demo data", () => {
  it("every suggestion returns at least one result", async () => {
    for (const q of SEARCH_EXAMPLES) expect((await search(q)).length, q).toBeGreaterThan(0);
  });
  it("the obvious ones put the right memory first", async () => {
    const top = async (q: string) => effective((await search(q))[0].memory).title;
    expect(await top("pasta recipe I saved")).toMatch(/pasta/i);
    expect(await top("screenshot about database optimization")).toMatch(/postgres|database|index/i);
    expect(await top("what did I want to do with the Lumen job")).toMatch(/lumen/i);
  });
  it("a question that shares no words with anything finds nothing: it does not guess", async () => {
    expect(await search("something about keeping a cache warm for speed").then((h) => h.filter((x) => x.termsTotal > 1 && x.termsMatched === x.termsTotal))).toEqual([]);
    expect(await search("zebra quantum saxophone")).toEqual([]);
  });
});
