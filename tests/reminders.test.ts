import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeReminder, createReminder, dismissReminder, editReminder, isDue, ReminderError, reopenReminder, snoozeReminder } from "@/lib/reminders";
import { deleteMemory, getReminder, listReminders } from "@/lib/store";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-rem-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const MEM = "sample-job-lumen";
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("reminder lifecycle", () => {
  it("creates a reminder linked to a memory, with a due date", async () => {
    const r = await createReminder({ memoryId: MEM, title: "  Apply to Lumen ", dueAt: day(2), note: "before noon" });
    expect(r).toMatchObject({ memoryId: MEM, title: "Apply to Lumen", status: "scheduled", note: "before noon", actionId: null });
    expect(r.history).toHaveLength(1);
    expect((await getReminder(r.id))!.dueAt).toBe(r.dueAt);
  });

  it("rejects an unknown memory, a bad date and an empty title", async () => {
    await expect(createReminder({ memoryId: randomUUID(), title: "x", dueAt: day(1) })).rejects.toThrow(/doesn't exist/);
    await expect(createReminder({ memoryId: MEM, title: "x", dueAt: "next friday" })).rejects.toThrow();
    await expect(createReminder({ memoryId: MEM, title: "   ", dueAt: day(1) })).rejects.toThrow();
  });

  it("edits title, note and due date and records it in the history", async () => {
    const r = await createReminder({ memoryId: MEM, title: "Old", dueAt: day(3) });
    const e = (await editReminder(r.id, { title: "New", dueAt: day(5) }))!;
    expect(e.title).toBe("New");
    expect(new Date(e.dueAt).getTime()).toBeGreaterThan(new Date(r.dueAt).getTime());
    expect(e.history.at(-1)!.status).toBe("edited");
    await expect(editReminder(r.id, { dueAt: "soon" })).rejects.toThrow(ReminderError);
  });

  it("snoozes to a later time (never to the past) and the reminder is due again then", async () => {
    const r = await createReminder({ memoryId: MEM, title: "Snooze me", dueAt: new Date(Date.now() - 1000).toISOString() });
    expect(isDue(r, new Date())).toBe(true);
    await expect(snoozeReminder(r.id, new Date(Date.now() - 5000).toISOString())).rejects.toThrow(/future/);
    const later = day(1);
    const s = (await snoozeReminder(r.id, later))!;
    expect(s).toMatchObject({ status: "snoozed", dueAt: later });
    expect(isDue(s, new Date())).toBe(false);
    expect(isDue(s, new Date(Date.now() + 2 * 86_400_000))).toBe(true);
    expect(s.history.at(-1)).toMatchObject({ status: "snoozed" });
  });

  it("completes, dismisses and reopens, and a finished reminder can't be edited or completed twice", async () => {
    const r = await createReminder({ memoryId: MEM, title: "Finish", dueAt: day(1) });
    const done = (await completeReminder(r.id))!;
    expect(done.status).toBe("done");
    expect(isDue(done, new Date(Date.now() + 9 * 86_400_000))).toBe(false);
    await expect(completeReminder(r.id)).rejects.toThrow(/done can't be completed/);
    await expect(editReminder(r.id, { title: "x" })).rejects.toThrow(ReminderError);
    expect((await reopenReminder(r.id))!.status).toBe("scheduled");
    expect((await dismissReminder(r.id))!.status).toBe("dismissed");
    await expect(snoozeReminder(r.id, day(2))).rejects.toThrow(ReminderError);
    expect((await reopenReminder(r.id))!.history.map((h) => h.status)).toEqual(["scheduled", "done", "scheduled", "dismissed", "scheduled"]);
  });

  it("returns null for an unknown id and filters by status and memory", async () => {
    expect(await completeReminder(randomUUID())).toBeNull();
    const open = await listReminders({ status: ["scheduled", "snoozed"] });
    expect(open.every((r) => r.status === "scheduled" || r.status === "snoozed")).toBe(true);
    const sorted = [...open].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    expect(open.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    expect(await listReminders({ memoryId: "nope" })).toEqual([]);
  });

  it("goes away with its memory", async () => {
    const { memory } = await (await import("@/lib/process")).captureMemory({ kind: "note", text: `Temporary ${randomUUID()}` });
    const r = await createReminder({ memoryId: memory.id, title: "tmp", dueAt: day(1) });
    await deleteMemory(memory.id);
    expect(await getReminder(r.id)).toBeNull();
  });
});
