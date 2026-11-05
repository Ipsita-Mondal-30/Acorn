import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockProvider } from "@/lib/ai/mock";
import { captureMemory, processMemory } from "@/lib/process";
import { Overrides, isRealDate } from "@/lib/schema";
import { getMemory, insertMemory, PROCESSING_LEASE_MS, updateMemory } from "@/lib/store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let dir: string;
const saved = { ...process.env };
const note = (s: string) => `${s} [${randomUUID()}]`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-foundation-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_MODE = "demo";
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

describe("dates are real calendar days", () => {
  it("rejects impossible dates a bare regex accepts", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "2027-02-29", "9999-99-99"]) expect(isRealDate(bad)).toBe(false);
    expect(Overrides.safeParse({ deadline: "2026-02-31" }).success).toBe(false);
  });
});

describe("processing is claimed atomically", () => {
  it("runs one extraction when many requests race for the same memory", async () => {
    const text = note("Reconnect with Maya Rao");
    const { memory } = await insertThenReset(text);
    const spy = vi.spyOn(mockProvider, "extractMemory");
    await Promise.all(Array.from({ length: 8 }, () => processMemory(memory.id)));
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await getMemory(memory.id))?.status).toBe("ready");
  });

  it("recovers a run that crashed while 'processing', but never steals a live one", async () => {
    const { memory } = await insertThenReset(note("Try the new ramen place"));
    const spy = vi.spyOn(mockProvider, "extractMemory");
    // a live run (just started): hands-off
    await updateMemory(memory.id, (m) => ({ ...m, status: "processing" }));
    expect((await processMemory(memory.id))?.status).toBe("processing");
    expect(spy).not.toHaveBeenCalled();
    // a stale run (process died long ago): reclaimed and finished
    const old = new Date(Date.now() - PROCESSING_LEASE_MS - 1000).toISOString();
    await updateMemory(memory.id, (m) => ({ ...m, status: "processing" }));
    await rewindUpdatedAt(memory.id, old);
    expect((await processMemory(memory.id))?.status).toBe("ready");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries a failed memory and keeps the user's corrections", async () => {
    const { memory } = await insertThenReset(note("Buy a desk lamp"));
    await updateMemory(memory.id, (m) => ({ ...m, status: "failed", error: "boom", overrides: { title: "My lamp" } }));
    const again = await processMemory(memory.id);
    expect(again?.status).toBe("ready");
    expect(again?.error).toBeUndefined();
    expect(again?.overrides.title).toBe("My lamp");
  });
});

describe("persistence", () => {
  it("memories survive a server restart (fresh module graph, same data dir)", async () => {
    const { memory } = await captureMemory({ kind: "note", text: note("Learn about B-tree indexes") });
    vi.resetModules();
    const fresh = await import("@/lib/store");
    const loaded = await fresh.getMemory(memory.id);
    expect(loaded?.extraction?.title).toBe(memory.extraction?.title);
    expect(loaded?.status).toBe("ready");
  });
});

describe("demo mode makes no network calls", () => {
  it("never calls fetch for notes, links or images", async () => {
    process.env.ACORN_MODE = "demo";
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used in demo mode")));
    vi.stubGlobal("fetch", fetchSpy);
    await captureMemory({ kind: "note", text: note("Buy oat milk") });
    await captureMemory({ kind: "url", url: `https://example.com/a?${randomUUID()}`, text: "read later" });
    await captureMemory({ kind: "image", bytes: new Uint8Array([...PNG, ...randomUUID().split("").map((c) => c.charCodeAt(0))]), originalName: "x.png" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("labels mock output as mock", async () => {
    const { memory } = await captureMemory({ kind: "note", text: note("Cook the lemon pasta, ingredients: garlic") });
    expect(memory.extraction?.producedBy.provider).toBe("mock");
  });
});

describe("a corrupt data file is reported, not silently replaced", () => {
  it("throws instead of reseeding over the user's data", async () => {
    const bad = await mkdtemp(path.join(os.tmpdir(), "acorn-corrupt-"));
    await writeFile(path.join(bad, "acorn.json"), "{ not json");
    const prev = process.env.ACORN_DATA_DIR;
    process.env.ACORN_DATA_DIR = bad;
    vi.resetModules();
    const fresh = await import("@/lib/store");
    await expect(fresh.listMemories()).rejects.toThrow();
    process.env.ACORN_DATA_DIR = prev;
    await rm(bad, { recursive: true, force: true });
  });
});

// helpers ---------------------------------------------------------------------------------------------
async function insertThenReset(text: string) {
  // insert without processing so tests control when extraction runs
  const { hashContent, newId } = await import("@/lib/store");
  const now = new Date().toISOString();
  const memory = {
    id: newId(), createdAt: now, updatedAt: now, source: { kind: "note" as const, text }, status: "pending" as const,
    contentHash: hashContent("note", undefined, text), extraction: null, overrides: {}, isSample: false,
  };
  return insertMemory(memory);
}

async function rewindUpdatedAt(id: string, iso: string) {
  // updateMemory stamps "now"; write the old time straight into the file the store reads
  const { readFile, writeFile: wf } = await import("node:fs/promises");
  const file = path.join(dir, "acorn.json");
  const db = JSON.parse(await readFile(file, "utf8"));
  db.memories.find((m: { id: string }) => m.id === id).updatedAt = iso;
  await wf(file, JSON.stringify(db));
}
