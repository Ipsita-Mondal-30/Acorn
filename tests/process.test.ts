import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureMemory, processMemory } from "@/lib/process";
import { listMemories } from "@/lib/store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let dir: string;
const saved = { ...process.env };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-process-"));
  process.env.ACORN_DATA_DIR = dir;
});
afterEach(() => {
  process.env.ACORN_MODE = "demo";
  delete process.env.META_API_KEY;
  vi.unstubAllGlobals();
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

// unique text so seeded fixtures (another agent's) can never collide by contentHash
const note = (s: string) => `${s} [${randomUUID()}]`;

describe("captureMemory (demo mode)", () => {
  it("captures a note and processes it with the mock provider", async () => {
    process.env.ACORN_MODE = "demo";
    const { memory, created } = await captureMemory({ kind: "note", text: note("Acme is hiring a Staff Engineer. Apply by Nov 12") });
    expect(created).toBe(true);
    expect(memory.status).toBe("ready");
    expect(memory.isSample).toBe(false);
    expect(memory.extraction?.producedBy.provider).toBe("mock");
    expect(memory.extraction?.contentType).toBe("job");
  });

  it("dedupes identical notes without reprocessing", async () => {
    const text = note("Reconnect with Sam Lee");
    const first = await captureMemory({ kind: "note", text });
    const second = await captureMemory({ kind: "note", text: `  ${text}\n` }); // trimmed → same hash
    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.updatedAt).toBe(first.memory.updatedAt);
    expect((await listMemories()).filter((m) => m.source.text === text)).toHaveLength(1);
  });

  it("rejects invalid input before touching the store", async () => {
    await expect(captureMemory({ kind: "note", text: "   " })).rejects.toThrow();
    await expect(captureMemory({ kind: "url", url: "javascript:alert(1)" })).rejects.toThrow(/http/);
  });

  it("captures a URL without fetching it in demo mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { memory } = await captureMemory({ kind: "url", url: `https://example.com/post/${randomUUID()}` });
    expect(memory.status).toBe("ready");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores an image upload and deletes the duplicate file", async () => {
    const caption = note("Postgres query plan screenshot");
    const a = await captureMemory({ kind: "image", bytes: PNG, originalName: "plan.png", text: caption });
    expect(a.memory.status).toBe("ready");
    expect(a.memory.source.fileName).toMatch(/\.png$/);
    expect(a.memory.extraction?.confidence).toBeLessThanOrEqual(0.3);
    const b = await captureMemory({ kind: "image", bytes: PNG, originalName: "plan-again.png", text: caption });
    expect(b.created).toBe(false);
    expect(await readdir(path.join(dir, "uploads"))).toEqual([a.memory.source.fileName]);
  });

  it("returns null for an unknown id", async () => {
    expect(await processMemory("nope")).toBeNull();
  });
});

describe("meta mode without a key", () => {
  it("fails clearly, never falls back to the mock, never calls the network", async () => {
    process.env.ACORN_MODE = "meta";
    process.env.AI_ENABLE_REAL_CALLS = "true";
    delete process.env.META_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { memory } = await captureMemory({ kind: "note", text: note("some note") });
    expect(memory.status).toBe("failed");
    expect(memory.error).toMatch(/META_API_KEY is not set/);
    expect(memory.extraction).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reprocesses with force once demo mode is back", async () => {
    process.env.ACORN_MODE = "meta";
    process.env.AI_ENABLE_REAL_CALLS = "true";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { memory } = await captureMemory({ kind: "note", text: note("Idea: a tiny CLI") });
    expect(memory.status).toBe("failed");
    process.env.ACORN_MODE = "demo";
    const again = await processMemory(memory.id, { force: true });
    expect(again?.status).toBe("ready");
    expect(again?.error).toBeUndefined();
  });
});
