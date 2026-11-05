import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlan } from "@/lib/agent/executor";
import { insightsFor, recentInsights, type InsightContext } from "@/lib/insights";
import { captureMemory } from "@/lib/process";
import { applyCorrection } from "@/lib/schema";
import { buildToday } from "@/lib/today";
import { listActions, listMemories, listPlans, listReminders, updateMemory, upsertReminder } from "@/lib/store";

// Automatic intelligence after capture, through the real local store, the real mock reading and the real retrieval.

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-insights-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo" });
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const now = new Date();
const ctx = async (): Promise<InsightContext> => ({ memories: await listMemories(), plans: await listPlans(), reminders: await listReminders(), actions: await listActions(), now });

describe("connections to work you already decided on", () => {
  let redisA: string;
  let redisB: string;
  it("a new memory about Redis is connected to your unfinished Redis learning plan, and says why", async () => {
    redisA = (await captureMemory({ kind: "note", text: "Learn Redis caching: allkeys-lru evicts the least recently used keys. Redis maxmemory sets the memory limit." })).memory.id;
    await updateMemory(redisA, (m) => applyCorrection(m, { userIntent: { kind: "learn" } }, now));
    await createPlan(redisA, now);
    redisB = (await captureMemory({ kind: "note", text: "Redis persistence: RDB snapshots and the append-only file save Redis data to disk." })).memory.id;
    const c = await ctx();
    const b = c.memories.find((m) => m.id === redisB)!;
    const found = insightsFor(b, c);
    const joins = found.find((i) => i.kind === "joins_work");
    expect(joins).toBeTruthy();
    expect(joins!.href).toBe(`/memories/${redisA}`);
    expect(joins!.why).toMatch(/Both mention .redis./i);
    expect(joins!.why).toMatch(/You confirmed that you want to learn it/);
    expect(joins!.why).toMatch(/isn't finished/);
  });
  it("it only SUGGESTS: the new memory's intention is still undecided and no plan was made for it", async () => {
    const c = await ctx();
    const b = c.memories.find((m) => m.id === redisB)!;
    expect(b.userIntent ?? null).toBeNull();
    expect(c.plans.filter((p) => p.memoryId === redisB)).toEqual([]);
  });
  it("an unrelated memory gets no connection insight", async () => {
    const { memory } = await captureMemory({ kind: "note", text: "Creamy lemon garlic pasta: 200g spaghetti, 3 cloves of garlic, one lemon." });
    const c = await ctx();
    expect(insightsFor(c.memories.find((m) => m.id === memory.id)!, c).filter((i) => i.kind === "joins_work")).toEqual([]);
  });
  it("a finished or rejected plan no longer counts as work in progress", async () => {
    const c = await ctx();
    const done = { ...c, plans: c.plans.map((p) => ({ ...p, status: "completed" as const })) };
    const b = c.memories.find((m) => m.id === redisB)!;
    expect(insightsFor(b, done).some((i) => i.kind === "joins_work")).toBe(false);
  });
});

describe("deadlines appear only when they were really extracted or set, and only once", () => {
  it("shows an extracted deadline that is still ahead and has no reminder or plan", async () => {
    const soon = new Date(now.getTime() + 20 * 86_400_000);
    const iso = soon.toISOString().slice(0, 10);
    const { memory } = await captureMemory({ kind: "note", text: `Senior Data Engineer at Northwind Labs. Applications close ${iso}. Remote. Python and SQL.` });
    const c = await ctx();
    const m = c.memories.find((x) => x.id === memory.id)!;
    const d = insightsFor(m, c).find((i) => i.kind === "deadline");
    expect(d?.title).toMatch(/Deadline/);
    expect(d?.why).toMatch(/found in the item/);
    expect(d?.detail).toMatch(/20 days/);
    // a reminder for it removes the nudge: nothing is recommended twice
    await upsertReminder({ id: crypto.randomUUID(), memoryId: memory.id, actionId: null, title: "Apply", dueAt: soon.toISOString(), status: "scheduled", kind: "deadline", note: "", snoozeCount: 0, timezone: null, history: [], createdAt: now.toISOString(), updatedAt: now.toISOString() } as Parameters<typeof upsertReminder>[0]);
    const c2 = await ctx();
    expect(insightsFor(c2.memories.find((x) => x.id === memory.id)!, c2).some((i) => i.kind === "deadline")).toBe(false);
  });
  it("invents nothing: a memory with no date has no deadline insight, and a past date is not shown", async () => {
    const { memory: none } = await captureMemory({ kind: "note", text: "Thoughts on typography: serif fonts for headings feel warm." });
    const { memory: past } = await captureMemory({ kind: "note", text: "Conference registration. Applications closed 2020-01-15." });
    const c = await ctx();
    for (const id of [none.id, past.id]) expect(insightsFor(c.memories.find((x) => x.id === id)!, c).some((i) => i.kind === "deadline")).toBe(false);
  });
});

describe("next steps and duplicates", () => {
  it("does not repeat a step that is already an action, plan goal or reminder", async () => {
    const { memory } = await captureMemory({ kind: "note", text: "Reconnect with Priya Nair, now at Mossbank Labs, about the data platform role." });
    const c = await ctx();
    const m = c.memories.find((x) => x.id === memory.id)!;
    const steps = insightsFor(m, c).filter((i) => i.kind === "next_step");
    for (const s of steps) expect(s.why).toMatch(/Proposed by the reading/);
    // pretend each proposed step already exists as an action: none is recommended again
    const asActions = steps.map((s) => ({ id: crypto.randomUUID(), memoryId: memory.id, title: s.title })) as unknown as InsightContext["actions"];
    expect(insightsFor(m, { ...c, actions: asActions }).filter((i) => i.kind === "next_step")).toEqual([]);
  });
  it("every insight key is unique, and Today lists a connected pair once", async () => {
    const c = await ctx();
    const all = c.memories.flatMap((m) => insightsFor(m, c));
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
    const recent = recentInsights(c, { withinDays: 30, limit: 50 });
    const pairs = recent.filter((i) => i.key.startsWith("joins:") || i.key.startsWith("conn:")).map((i) => i.key.split(":").slice(1, 3).sort().join("|"));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe("Today shows what was noticed, traceable to stored data", () => {
  it("includes a 'Noticed' section whose entries each carry their reason and a link to a real memory", async () => {
    const c = await ctx();
    const t = buildToday({ memories: c.memories, plans: c.plans, reminders: c.reminders, actions: c.actions, now });
    const noticed = t.sections.find((s) => s.id === "noticed");
    expect(noticed?.entries.length).toBeGreaterThan(0);
    const ids = new Set(c.memories.map((m) => m.id));
    for (const e of noticed!.entries) {
      expect(e.why.length).toBeGreaterThan(10);
      expect(ids.has(e.href.split("/memories/")[1].split("#")[0])).toBe(true);
    }
  });
});
