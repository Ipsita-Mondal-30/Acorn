import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEADLINE_HORIZON_DAYS, buildToday } from "@/lib/today";
import { captureMemory } from "@/lib/process";
import { listActions, listMemories, listPlans, listReminders } from "@/lib/store";

// Demo transparency: the built-in sample memories appear in the local demo store, and Today must never pass them off as the
// person's own, nor let them crowd out what the person really saved.

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-today-samples-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo" });
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const now = new Date();
const world = async () => ({ memories: await listMemories(), plans: await listPlans(), reminders: await listReminders(), actions: await listActions(), now });
const iso = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe("Today and sample data", () => {
  it("marks entries that come from built-in samples, and does not mark the person's own", async () => {
    const mine = (await captureMemory({ kind: "note", text: `Senior Data Engineer at Northwind Labs. Applications close ${iso(20)}. Python, SQL, PostgreSQL and Kafka.` })).memory;
    const t = buildToday(await world());
    const entries = t.sections.flatMap((s) => s.entries);
    const memories = await listMemories();
    for (const e of entries) expect(e.sample, e.title).toBe(memories.find((m) => m.id === e.memoryId)!.isSample);
    expect(entries.some((e) => e.sample)).toBe(true); // the seeded demo data is there, and marked
    expect(entries.some((e) => e.memoryId === mine.id && !e.sample)).toBe(true);
  });

  it("lists the person's own items before samples in every section", async () => {
    const t = buildToday(await world());
    for (const s of t.sections) {
      const firstSample = s.entries.findIndex((e) => e.sample);
      if (firstSample >= 0) expect(s.entries.slice(firstSample).every((e) => e.sample), s.id).toBe(true);
    }
  });

  it("shows a real deadline 70 days away (the horizon is 90 days), with its date and why", async () => {
    expect(DEADLINE_HORIZON_DAYS).toBe(90);
    const far = (await captureMemory({ kind: "note", text: `Staff Data Engineer at Harbor Labs. Applications close ${iso(70)}. Python and Kafka.` })).memory;
    const t = buildToday(await world());
    const e = t.sections.find((s) => s.id === "deadlines")?.entries.find((x) => x.memoryId === far.id);
    expect(e).toBeTruthy();
    expect(e!.detail).toMatch(/in 70 days/);
    expect(e!.sample).toBe(false);
    expect(e!.why).toMatch(/found in what you saved/);
    // and one beyond the horizon is not shown
    const beyond = (await captureMemory({ kind: "note", text: `Principal Engineer at Far Labs. Applications close ${iso(120)}. Rust.` })).memory;
    const t2 = buildToday(await world());
    expect(t2.sections.find((s) => s.id === "deadlines")?.entries.some((x) => x.memoryId === beyond.id) ?? false).toBe(false);
  });

  it("connection lines say what the other memory is and when it was saved, and name a sample as a sample", async () => {
    const t = buildToday(await world());
    const conn = t.sections.find((s) => s.id === "noticed")?.entries.filter((e) => e.verb === "Related") ?? [];
    expect(conn.length).toBeGreaterThan(0);
    for (const e of conn) {
      expect(e.detail).not.toBe("A memory you saved earlier.");
      expect(e.detail).toMatch(/^(Job|Technical|Article|Recipe|Idea|Person|Note|Item|Event|Deadline|Product) saved (today|yesterday|\d+ days ago)\.$/);
    }
    expect(conn.some((e) => /\(sample\)$/.test(e.title))).toBe(true);
  });
});
