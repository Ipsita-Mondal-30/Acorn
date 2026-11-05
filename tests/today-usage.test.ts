import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlan } from "@/lib/agent/executor";
import type { Artifact } from "@/lib/artifacts";
import { captureMemory } from "@/lib/process";
import { applyCorrection } from "@/lib/schema";
import { buildToday } from "@/lib/today";
import { listMemories, listPlans, listReminders, updateMemory } from "@/lib/store";
import { usageRows, usageTotals } from "@/lib/usage-report";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-today-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo" });
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const now = new Date("2026-11-05T10:00:00Z");
const art = (over: Partial<Artifact>): Artifact => ({
  id: "a1", memoryId: null, parentId: null, kind: "visual_aid", status: "ready", provider: "mock", model: "mock-diagram", fileName: null, mimeType: null, input: {}, output: {},
  attempts: 1, error: null, latencyMs: 40, usage: null, confirmedMemoryId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), ...over,
});

describe("Today with Acorn", () => {
  it("is empty (and says nothing) when nothing is saved", () => {
    expect(buildToday({ memories: [], plans: [], reminders: [], now })).toEqual({ sections: [], empty: true });
  });

  it("every entry explains why it is shown, and nothing is invented", async () => {
    const { memory: job } = await captureMemory({ kind: "note", text: "Senior Data Engineer at Northwind Labs. Applications close 15 January 2027. Remote. Python and SQL." });
    const { memory: note } = await captureMemory({ kind: "note", text: "Learn Redis caching: allkeys-lru evicts the least recently used keys." });
    const memories = await listMemories();
    const t = buildToday({ memories, plans: [], reminders: [], now });
    const entries = t.sections.flatMap((s) => s.entries);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.why.length).toBeGreaterThan(10);
      expect(e.href).toMatch(/^\/memories\//);
    }
    // an undecided intention is a question, never a task Acorn made up
    const decide = t.sections.find((s) => s.id === "decide")?.entries ?? [];
    expect(decide.some((e) => e.memoryId === job.id || e.memoryId === note.id)).toBe(true);
    for (const e of decide) expect(e.why).toMatch(/guess|told Acorn|no plan/i);
    // a deadline only appears with the date it was found on
    const dl = t.sections.find((s) => s.id === "deadlines")?.entries.filter((e) => e.memoryId === job.id) ?? [];
    for (const e of dl) expect(e.detail).toMatch(/15 Jan 2027/);
    // no entry is listed twice
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a confirmed intention without a plan, then a plan waiting for approval, move up as 'Waiting for you'", async () => {
    const { memory } = await captureMemory({ kind: "note", text: "Learn Postgres indexing: a B-tree index speeds up equality and range filters." });
    await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "learn" } }, now));
    let t = buildToday({ memories: await listMemories(), plans: await listPlans(), reminders: [], now });
    expect(t.sections.flatMap((s) => s.entries).some((e) => e.memoryId === memory.id && e.verb === "Make a plan" && /told Acorn you want to/i.test(e.why))).toBe(true);
    await createPlan(memory.id, new Date(now));
    t = buildToday({ memories: await listMemories(), plans: await listPlans(), reminders: await listReminders(), now });
    const waiting = t.sections.find((s) => s.id === "waiting")?.entries ?? [];
    expect(waiting.some((e) => e.memoryId === memory.id && /approve/i.test(e.verb) && /never acts until you approve/.test(e.why))).toBe(true);
  });
});

describe("Meta model usage report", () => {
  it("lists what was stored, never counts a demo stand-in as Meta, and only totals real Meta usage", async () => {
    const memories = await listMemories();
    const rows = usageRows(memories, [
      art({ id: "v", kind: "voice", provider: "meta", model: "muse-voice-transcribe-1.0", latencyMs: 2300, usage: null }),
      art({ id: "i", kind: "visual_aid", provider: "meta", model: "muse-image-1.0", latencyMs: 41_000, usage: { promptTokens: 9831, completionTokens: 749, totalTokens: 10_580, estimatedCostUsd: 0.01 } }),
      art({ id: "d", kind: "visual_aid", provider: "mock", model: "mock-diagram", usage: null }),
      art({ id: "f", kind: "segmentation", provider: "meta", model: "sam-3.1", status: "failed", latencyMs: null, error: { kind: "timeout", message: "Meta API timed out after 60s.", at: now.toISOString() }, attempts: 2 }),
    ]);
    const t = usageTotals(rows);
    expect(t).toMatchObject({ metaCalls: 2, metaFailed: 1, promptTokens: 9831, completionTokens: 749, costUsd: 0.01, unpriced: 1 });
    expect(t.demoRows).toBeGreaterThan(0); // the demo-mode memories are listed, as demo
    expect(rows.find((r) => r.key === "a-d")?.provider).toBe("mock");
    expect(rows.find((r) => r.key === "a-f")).toMatchObject({ status: "failed", attempts: 2, error: expect.stringContaining("timeout") });
    for (const r of rows.filter((x) => x.provider === "mock")) expect(r.costUsd).toBeNull();
  });
});
