import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { embeddingStatus, getEmbeddingProvider, type EmbeddingProvider } from "@/lib/ai/embeddings";
import { answerQuestion, NO_MATCH } from "@/lib/answer";
import { indexMissing, semanticScores } from "@/lib/indexing";
import { searchMemories } from "@/lib/search";
import { buildSeed } from "@/lib/seed";
import { cosine, embeddingHash, embeddingText } from "@/lib/semantic";
import { listMemories, updateMemory } from "@/lib/store";
import type { Memory } from "@/lib/schema";
import { fakeEmbedder } from "./helpers/fake-embedder";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-semantic-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const PASTA = "sample-recipe-pasta"; // "Creamy lemon garlic pasta"
const now = new Date();
const top = (hits: { memory: Memory }[]) => hits[0]?.memory.id;

describe("semantic retrieval (deterministic test embedder, no network)", () => {
  it("finds a memory by meaning when the query shares no words with it", async () => {
    const embedder = fakeEmbedder();
    const memories = await listMemories();
    await indexMissing({ provider: embedder });

    // "citrus noodles" appears nowhere in the lemon pasta memory: keywords alone find nothing
    expect(searchMemories(memories, "citrus noodles", now)).toEqual([]);

    const sem = await semanticScores("citrus noodles", memories, { provider: embedder });
    expect(sem.status).toBe("ok");
    const hits = searchMemories(memories, "citrus noodles", now, { semantic: sem.scores });
    expect(top(hits)).toBe(PASTA);
    expect(hits[0].reasons).toContain("Close in meaning to your search (no exact words needed)");
    expect(hits[0].semantic).toBeGreaterThan(0.35);
  });

  it.each(["That citrus pasta I saved.", "The Italian dish with lemon.", "What was the recipe with parmesan?"])("different wording: %s", async (q) => {
    const embedder = fakeEmbedder();
    const memories = await listMemories();
    await indexMissing({ provider: embedder });
    const { scores } = await semanticScores(q, memories, { provider: embedder });
    expect(top(searchMemories(memories, q, now, { semantic: scores }))).toBe(PASTA);
  });

  it("keeps exact keyword queries working, with or without semantic scores", async () => {
    const embedder = fakeEmbedder();
    const memories = await listMemories();
    await indexMissing({ provider: embedder });
    const { scores } = await semanticScores("pasta recipe", memories, { provider: embedder });
    expect(top(searchMemories(memories, "Find the pasta recipe I saved", now))).toBe(PASTA);
    expect(top(searchMemories(memories, "Find the pasta recipe I saved", now, { semantic: scores }))).toBe(PASTA);
  });

  it("returns nothing for a query that means nothing in the saved memories, and calls no model to answer", async () => {
    const embedder = fakeEmbedder();
    const memories = await listMemories();
    await indexMissing({ provider: embedder });
    const sem = await semanticScores("quantum telescope alignment", memories, { provider: embedder });
    expect(sem.scores.size).toBe(0);
    expect(searchMemories(memories, "quantum telescope alignment", now, { semantic: sem.scores })).toEqual([]);
    const provider = { name: "mock", model: "x", answerFromMemories: vi.fn() } as never;
    const a = await answerQuestion("quantum telescope alignment", memories, { semantic: sem.scores, provider });
    expect(a).toMatchObject({ answer: NO_MATCH, noReliableMatch: true, by: null });
    expect((provider as { answerFromMemories: ReturnType<typeof vi.fn> }).answerFromMemories).not.toHaveBeenCalled();
  });

  it("hybrid ranking: a memory that matches by words AND meaning outranks one that matches by meaning alone", async () => {
    const memories = buildSeed(now).memories;
    const embedder = fakeEmbedder();
    const vectors = new Map(memories.map((m) => [m.id, embedder.embed([embeddingText(m)])]));
    const scores = new Map<string, number>();
    for (const [id, p] of vectors) {
      const [v] = await p;
      const [q] = await embedder.embed(["lemon pasta"]);
      const s = cosine(q, v);
      if (s >= 0.35) scores.set(id, s);
    }
    const hits = searchMemories(memories, "lemon pasta", now, { semantic: scores });
    expect(top(hits)).toBe(PASTA);
    const keywordOnly = searchMemories(memories, "lemon pasta", now);
    expect(hits.find((h) => h.memory.id === PASTA)!.score).toBeGreaterThan(keywordOnly.find((h) => h.memory.id === PASTA)!.score);
    // sorted by score, ties by recency: deterministic
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it("answers from a semantic-only match, grounded in the memory's own words", async () => {
    const memories = await listMemories();
    const embedder = fakeEmbedder();
    await indexMissing({ provider: embedder });
    const { scores } = await semanticScores("citrus noodles", memories, { provider: embedder });
    const provider = {
      name: "mock",
      model: "stub",
      answerFromMemories: async () => ({
        data: { answer: "Your lemon garlic pasta.", noReliableMatch: false, citations: [{ memoryId: PASTA, quote: "Creamy lemon garlic pasta" }] },
      }),
    } as never;
    const a = await answerQuestion("citrus noodles", memories, { semantic: scores, provider });
    expect(a.noReliableMatch).toBe(false);
    expect(a.citations[0]).toMatchObject({ memoryId: PASTA, quote: "Creamy lemon garlic pasta" });
  });
});

describe("missing, stale and failed embeddings", () => {
  it("memories without vectors are reported and still found by keywords", async () => {
    const memories = await listMemories();
    const embedder = fakeEmbedder("test-missing");
    const none = await semanticScores("lemon pasta", memories, { provider: embedder });
    expect(none).toMatchObject({ status: "ok", unindexed: memories.length });
    expect(none.scores.size).toBe(0);
    expect(top(searchMemories(memories, "lemon pasta", now, { semantic: none.scores }))).toBe(PASTA);
  });

  it("a failed embedding call stores nothing, search falls back to keywords, and a retry succeeds", async () => {
    let broken = true;
    const real = fakeEmbedder("test-flaky");
    const flaky: EmbeddingProvider = {
      name: "test",
      model: "test-flaky",
      embed: async (texts) => {
        if (broken) throw new AiError("The embedding service failed (HTTP 503).", "unavailable");
        return real.embed(texts);
      },
    };
    const memories = await listMemories();
    const failed = await indexMissing({ provider: flaky });
    expect(failed).toMatchObject({ available: true, embedded: 0, failed: memories.length });
    const sem = await semanticScores("citrus noodles", memories, { provider: flaky });
    expect(sem).toMatchObject({ status: "failed" });
    expect(top(searchMemories(memories, "Find the pasta recipe", now, { semantic: sem.scores }))).toBe(PASTA);

    broken = false; // the service recovers; running the same call again fills the gaps
    const retried = await indexMissing({ provider: flaky });
    expect(retried).toMatchObject({ embedded: memories.length, failed: 0 });
    expect(await indexMissing({ provider: flaky })).toMatchObject({ embedded: 0, upToDate: memories.length });
  });

  it("re-embeds a memory whose text changed", async () => {
    const embedder = fakeEmbedder("test-stale");
    await indexMissing({ provider: embedder });
    const before = embedder.calls.length;
    await updateMemory(PASTA, (m) => ({ ...m, overrides: { ...m.overrides, title: "Lime spaghetti" } }));
    const r = await indexMissing({ provider: embedder });
    expect(r.embedded).toBe(1);
    expect(embedder.calls.length).toBe(before + 1);
    expect(embedder.calls.at(-1)![0]).toContain("Lime spaghetti");
    await updateMemory(PASTA, (m) => ({ ...m, overrides: {} }));
  });

  it("does nothing, and says why, when no provider is configured", async () => {
    const r = await indexMissing({ provider: null });
    expect(r).toMatchObject({ available: false, embedded: 0, failed: 0 });
    expect(r.reason).toMatch(/EMBEDDING_PROVIDER=none/);
    expect(await semanticScores("anything", await listMemories(), { provider: null })).toMatchObject({ status: "off" });
  });
});

describe("embedding configuration and the HTTP provider (stubbed fetch)", () => {
  const KEY = "EMBED_SECRET_KEY_123";
  const env = (over: Record<string, string>) => {
    for (const k of ["EMBEDDING_PROVIDER", "EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "AI_ENABLE_REAL_CALLS"]) delete process.env[k];
    Object.assign(process.env, over);
  };
  afterEach(() => env({}));

  it("is off by default: no provider, no fetch", () => {
    env({});
    expect(getEmbeddingProvider()).toBeNull();
    expect(embeddingStatus().configured).toBe(false);
  });

  it("needs a base URL, key, model and the real-calls switch; says which is missing and never leaks the key", () => {
    env({ EMBEDDING_PROVIDER: "http", EMBEDDING_API_KEY: KEY });
    expect(embeddingStatus().reason).toMatch(/EMBEDDING_BASE_URL, EMBEDDING_MODEL/);
    env({ EMBEDDING_PROVIDER: "http", EMBEDDING_API_KEY: KEY, EMBEDDING_BASE_URL: "https://e.example/v1", EMBEDDING_MODEL: "m" });
    expect(getEmbeddingProvider()).toBeNull();
    expect(JSON.stringify(embeddingStatus())).not.toContain(KEY);
    expect(embeddingStatus().reason).toMatch(/AI_ENABLE_REAL_CALLS/);
  });

  const ready = { EMBEDDING_PROVIDER: "http", EMBEDDING_API_KEY: KEY, EMBEDDING_BASE_URL: "https://e.example/v1/", EMBEDDING_MODEL: "embed-x", AI_ENABLE_REAL_CALLS: "true" };

  it("sends a bearer-authenticated /embeddings request and returns vectors in order", async () => {
    env(ready);
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ model: "embed-x", input: ["a", "b"] });
      return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const p = getEmbeddingProvider()!;
    expect(await p.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://e.example/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("turns a rejected key, a bad shape and a wrong count into safe errors", async () => {
    env(ready);
    const p = getEmbeddingProvider()!;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: `echo ${KEY}` } }), { status: 401 }));
    const auth = await p.embed(["a"]).catch((e) => e);
    expect(auth).toBeInstanceOf(AiError);
    expect(auth.message).not.toContain(KEY);
    vi.stubGlobal("fetch", async () => Response.json({ nope: 1 }));
    await expect(p.embed(["a"])).rejects.toThrow(/unexpected shape/);
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ embedding: [1] }] }));
    await expect(p.embed(["a", "b"])).rejects.toThrow(/unexpected shape/);
  });
});

describe("embedding text", () => {
  it("includes what the user corrected, and hashes differ per model and text", async () => {
    const [m] = buildSeed(now).memories.filter((x) => x.id === PASTA);
    expect(embeddingText(m)).toContain("Creamy lemon garlic pasta");
    expect(embeddingText({ ...m, overrides: { title: "Grandma's lasagna" } })).toContain("Grandma's lasagna");
    expect(embeddingHash("a", "t")).not.toBe(embeddingHash("b", "t"));
    expect(embeddingHash("a", "t")).not.toBe(embeddingHash("a", "u"));
  });
  it("cosine handles empty and mismatched vectors", () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 0], [1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
  });
});

describe("hybrid weights and local similarity", () => {
  it("the semantic and keyword weights change the ranking they are documented to change", () => {
    const memories = buildSeed(now).memories;
    const sem = new Map([["sample-job-lumen", 0.9]]); // a job that only matches by meaning
    const base = searchMemories(memories, "lemon pasta", now, { semantic: sem });
    const strong = searchMemories(memories, "lemon pasta", now, { semantic: sem, semanticWeight: 100 });
    const off = searchMemories(memories, "lemon pasta", now, { semantic: sem, semanticWeight: 0 });
    expect(top(base)).toBe(PASTA);
    expect(top(strong)).toBe("sample-job-lumen"); // a heavy semantic weight lets meaning beat words
    expect(off.find((h) => h.memory.id === "sample-job-lumen")?.score).toBe(0);
    const kw = searchMemories(memories, "lemon pasta", now, { keywordWeight: 3 });
    const kw1 = searchMemories(memories, "lemon pasta", now);
    expect(kw[0].score).toBeCloseTo(kw1[0].score * 3, 1);
  });

  it("never invents a result: a similarity for an unknown id is ignored by callers, and nothing matches without scores", async () => {
    const memories = await listMemories();
    const sem = await semanticScores("citrus noodles", memories, { provider: fakeEmbedder("test-orphan") });
    expect(sem.scores.size).toBe(0); // nothing indexed for this model yet
    expect(searchMemories(memories, "citrus noodles", now, { semantic: sem.scores })).toEqual([]);
  });

  it("local similarity search honours the limit and minimum, and refuses a query of the wrong size", async () => {
    const embedder = fakeEmbedder("test-local");
    const memories = await listMemories();
    await indexMissing({ provider: embedder });
    const all = await semanticScores("citrus noodles", memories, { provider: embedder, minSimilarity: 0 });
    const one = await semanticScores("citrus noodles", memories, { provider: embedder, minSimilarity: 0, limit: 1 });
    expect(one.scores.size).toBe(1);
    expect([...one.scores.keys()][0]).toBe([...all.scores.keys()][0]);
    const strict = await semanticScores("citrus noodles", memories, { provider: embedder, minSimilarity: 0.999 });
    expect(strict.scores.size).toBe(0);
    const wrong: EmbeddingProvider = { name: "test", model: "test-local", embed: async () => [[1, 0]] };
    expect(await semanticScores("x", memories, { provider: wrong })).toMatchObject({ status: "failed" }); // falls back, doesn't throw
  });

  it("indexing refuses vectors pgvector couldn't use, and a retry can still embed them later", async () => {
    let bad = true;
    const real = fakeEmbedder("test-badvec");
    const p: EmbeddingProvider = { name: "test", model: "test-badvec", embed: async (t) => (bad ? t.map(() => [0, 0, 0]) : real.embed(t)) };
    const memories = await listMemories();
    expect(await indexMissing({ provider: p })).toMatchObject({ embedded: 0, failed: memories.length });
    bad = false;
    expect(await indexMissing({ provider: p })).toMatchObject({ failed: 0 });
  });
});

describe("HTTP embedding provider: retries and usage", () => {
  const ready = { EMBEDDING_PROVIDER: "http", EMBEDDING_API_KEY: "k", EMBEDDING_BASE_URL: "https://e.example/v1", EMBEDDING_MODEL: "embed-x", AI_ENABLE_REAL_CALLS: "true", ACORN_RETRY_BASE_MS: "0" };
  afterEach(() => {
    for (const k of Object.keys(ready)) delete process.env[k];
  });

  it("retries 429/503 then succeeds, and records token usage without inventing a price", async () => {
    Object.assign(process.env, ready);
    const { usageTotals, resetUsageTotals } = await import("@/lib/ai/usage");
    resetUsageTotals();
    let n = 0;
    const spy = vi.fn(async () => (++n < 3 ? new Response("{}", { status: n === 1 ? 429 : 503 }) : Response.json({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 12 } })));
    vi.stubGlobal("fetch", spy);
    expect(await getEmbeddingProvider()!.embed(["a"])).toEqual([[1, 0]]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(usageTotals()).toMatchObject({ promptTokens: 12, costUsd: 0, unpricedCalls: 1 });
  });

  it("does not retry a rejected key, and rejects a wrong vector size or mixed sizes", async () => {
    Object.assign(process.env, ready, { EMBEDDING_DIMENSIONS: "8" });
    const spy = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", spy);
    await expect(getEmbeddingProvider()!.embed(["a"])).rejects.toThrow(/rejected the API key/);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ embedding: [1, 0] }] }));
    await expect(getEmbeddingProvider()!.embed(["a"])).rejects.toThrow(/wrong size/);
    delete process.env.EMBEDDING_DIMENSIONS;
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }] }));
    await expect(getEmbeddingProvider()!.embed(["a", "b"])).rejects.toThrow(/different sizes/);
  });
});
