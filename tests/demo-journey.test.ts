import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ONE coherent journey, end to end, in demo mode with NO network and NO key:
//   voice note → saved memory → saved REAL Muse Spark extraction (replayed) → related memories → Today recommendations
//   → confirmed intention → approved plan → study pack, progress and revision reminder → visual aid.
// It proves the product loop works and persists. It does NOT prove a live Meta flow: the only Meta output in it is the
// saved result of the one real, separately verified request, replayed and labelled as such.

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));

import { POST as voiceSave } from "@/app/api/voice/[id]/route";
import { POST as voicePost } from "@/app/api/voice/route";
import { POST as visualAid } from "@/app/api/memories/[id]/visual-aid/route";
import { approvePlan, approveReview, createPlan, editStep, setStepInput } from "@/lib/agent/executor";
import { StudyPack, studyProgress } from "@/lib/agent/study";
import { encodeWav } from "@/lib/audio/wav";
import { insightsFor } from "@/lib/insights";
import { processMemory, saveCapture } from "@/lib/process";
import { applyCorrection, effective } from "@/lib/schema";
import { getMemory, listActions, listArtifacts, listMemories, listPlans, listReminders, updateMemory } from "@/lib/store";
import { buildToday } from "@/lib/today";
import { usageRows, usageTotals } from "@/lib/usage-report";

const SAVED = path.resolve("artifacts/meta-live/2026-11-03T17-55-24-748Z-ok.json");
const have = existsSync(SAVED);
const SPOKEN = "I want to learn Redis, build a project around it and finish it this week.";
const saved = { ...process.env };
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-journey-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo", AI_ENABLE_REAL_CALLS: "false", ACORN_DEMO_REPLAY: "1" });
  delete process.env.META_API_KEY;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterAll(async () => {
  process.env = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const jsonReq = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runAfter = async () => {
  for (const fn of afterQueue.splice(0)) await fn();
};
const wav = () => encodeWav(Float32Array.from({ length: 16_000 * 2 }, (_, i) => Math.sin(i / 25) * 0.3), 16_000);
const now = new Date();
const world = async () => ({ memories: await listMemories(), plans: await listPlans(), reminders: await listReminders(), actions: await listActions(), artifacts: await listArtifacts(), now });

let voiceMemory: string;
let jobMemory: string;
let planId: string;

describe.skipIf(!have)("the demo journey", () => {
  it("1. voice capture: the audio is kept, the transcript is yours to confirm, and only then is it a memory", async () => {
    const form = new FormData();
    form.set("audio", new File([Buffer.from(wav())], "r.wav", { type: "audio/wav" }));
    const { artifact } = await (await voicePost(new Request("http://x/api/voice", { method: "POST", body: form }))).json();
    expect(artifact).toMatchObject({ kind: "voice", provider: "mock", memoryId: null }); // demo mode does not listen: nothing pretends otherwise
    expect((await listMemories()).some((m) => m.source.text === SPOKEN)).toBe(false);
    const res = await voiceSave(jsonReq({ op: "save", text: SPOKEN }), ctx(artifact.id));
    voiceMemory = (await res.json()).memory.id;
    await runAfter();
    const m = (await getMemory(voiceMemory))!;
    expect(m.status).toBe("ready");
    expect(m.userIntent ?? null).toBeNull(); // a suggestion at most
    expect(effective(m).deadline ?? null).toBeNull(); // "this week" is not a date
  });

  it("2. the saved REAL Muse Spark extraction is read through the normal pipeline and labelled as a replay", async () => {
    const png = new Uint8Array(readFileSync(path.resolve("public/samples/job-listing-screenshot.png")));
    const { memory } = await saveCapture({ kind: "image", bytes: png, originalName: "job-listing-screenshot.png" });
    jobMemory = memory.id;
    await processMemory(memory.id);
    const m = (await getMemory(jobMemory))!;
    const real = JSON.parse(readFileSync(SAVED, "utf8"));
    expect(m.extraction!.producedBy).toMatchObject({ provider: "meta", model: "muse-spark-1.3", latencyMs: real.latencyMs });
    expect(m.extraction!.producedBy.usage?.totalTokens).toBe(real.usage.totalTokens);
    expect(m.extraction!.producedBy.note).toMatch(/Replay of a saved real Meta muse-spark-1.3 result.*No new request was made/);
    expect(m.extraction!.title).toBe(real.extraction.title);
    expect(effective(m).deadline).toBe("2027-01-15");
    // the nine facts keep their quotes and are NOT presented as verified
    expect(m.extraction!.facts).toHaveLength(9);
    expect(m.extraction!.facts.every((f) => f.quote && f.checked === false)).toBe(true);
    // every other memory in this journey was read by the mock, and says so
    expect((await getMemory(voiceMemory))!.extraction!.producedBy.provider).toBe("mock");
  });

  it("3. related-memory retrieval connects the new job listing to earlier saved memories, with reasons", async () => {
    const c = await world();
    const job = c.memories.find((m) => m.id === jobMemory)!;
    const conn = insightsFor(job, c).filter((i) => i.kind === "connection" || i.kind === "joins_work");
    expect(conn.length).toBeGreaterThan(0);
    expect(conn.some((i) => /postgres|kafka/i.test(i.why))).toBe(true);
  });

  it("4. Today recommends what to do, and every line traces to stored data", async () => {
    const c = await world();
    const t = buildToday({ ...c });
    const all = t.sections.flatMap((s) => s.entries);
    // the undecided voice memory is a QUESTION for the user, not a plan Acorn made
    const q = all.find((e) => e.memoryId === voiceMemory);
    expect(q).toBeTruthy();
    expect(q!.why).toMatch(/guess|told Acorn/i);
    // a deadline appears only because it was extracted, with its date
    const ids = new Set(c.memories.map((m) => m.id));
    for (const e of all) {
      expect(e.why.length).toBeGreaterThan(10);
      expect(ids.has(e.href.split("/memories/")[1].split("#")[0])).toBe(true);
    }
    expect(c.plans.filter((p) => p.memoryId === voiceMemory)).toEqual([]); // nothing was planned without the user
  });

  it("5. the user confirms Learn; the plan waits for approval, and nothing runs before it", async () => {
    await updateMemory(voiceMemory, (m) => applyCorrection(m, { userIntent: { kind: "learn" } }, now));
    const created = (await createPlan(voiceMemory, now))!;
    planId = created.plan.id;
    expect(created.plan.status).toBe("awaiting_approval");
    expect(created.plan.steps.every((s) => s.state === "pending")).toBe(true);
    expect(await listReminders({ memoryId: voiceMemory })).toEqual([]);
    const t = buildToday({ ...(await world()) });
    expect(t.sections.find((s) => s.id === "waiting")!.entries.some((e) => e.memoryId === voiceMemory && /approve/i.test(e.verb) && /never acts until you approve/.test(e.why))).toBe(true);
  });

  it("6. approval builds a study pack from the memory's own facts; progress and a chosen-date reminder persist", async () => {
    let plan = (await approvePlan(planId))!;
    const pack = StudyPack.parse(plan.steps[1]!.output);
    expect(pack.cards.length).toBeGreaterThan(0);
    plan = (await approveReview(plan.id, "s2"))!;
    plan = (await editStep(plan.id, "s2", { study: { cards: { [pack.cards[0]!.id]: "known" } } }))!;
    expect(studyProgress(StudyPack.parse(plan.steps[1]!.output)).known).toBe(1);
    expect(await listReminders({ memoryId: voiceMemory })).toEqual([]); // no date until the user picks one
    plan = (await setStepInput(plan.id, "s3", "dueAt", new Date(now.getTime() + 3 * 86_400_000).toISOString()))!;
    const rem = await listReminders({ memoryId: voiceMemory });
    expect(rem).toHaveLength(1);
    expect(rem[0]!.title).toMatch(/^Revise:/);
    // Today now says to keep studying, and why
    const t = buildToday({ ...(await world()) });
    const learn = t.sections.find((s) => s.id === "learning")?.entries.find((e) => e.memoryId === voiceMemory);
    expect(learn?.detail).toMatch(/% done/);
    expect(learn?.why).toMatch(/started this study pack/);
  });

  it("7. the visual aid is drawn from this memory, titled with its real title, labelled AI-created and kept apart from evidence", async () => {
    const res = await visualAid(new Request("http://x", { method: "POST" }), ctx(voiceMemory));
    const { artifact } = await res.json();
    expect(artifact).toMatchObject({ kind: "visual_aid", status: "ready", provider: "mock", memoryId: voiceMemory });
    expect(artifact.output.aiGenerated).toBe(true);
    expect(artifact.output.title).not.toMatch(/untitled/i);
    expect(artifact.output.title).toContain("I want to learn Redis");
    expect(artifact.output.prompt).not.toMatch(/untitled/i);
    // it is an artifact, not part of the memory's source or facts
    const m = (await getMemory(voiceMemory))!;
    expect(m.extraction!.facts.map((f) => f.statement).join(" ")).not.toContain("Demo diagram");
    expect(m.source.fileName).toBeUndefined();
  });

  it("8. the usage page counts ONE Meta result (the replayed saved run), and everything else as demo", async () => {
    const c = await world();
    const rows = usageRows(c.memories, c.artifacts);
    const t = usageTotals(rows);
    expect(t.metaCalls).toBe(1);
    expect(rows.filter((r) => r.provider === "meta")).toHaveLength(1);
    expect(rows.filter((r) => r.provider === "meta")[0]).toMatchObject({ model: "muse-spark-1.3", what: "Reading a memory" });
    expect(t.demoRows).toBeGreaterThan(0);
  });
});

describe("replay is opt-in and honest", () => {
  it("is off unless ACORN_DEMO_REPLAY=1, and never in Meta mode", async () => {
    const { replayEnabled } = await import("@/lib/ai/replay");
    expect(replayEnabled()).toBe(true);
    process.env.ACORN_DEMO_REPLAY = "0";
    expect(replayEnabled()).toBe(false);
    process.env.ACORN_DEMO_REPLAY = "1";
    process.env.ACORN_MODE = "meta";
    expect(replayEnabled()).toBe(false);
    process.env.ACORN_MODE = "demo";
  });
  it("only replays for the exact job-listing sample; any other image goes to the mock and is labelled mock", async () => {
    const { mockProvider } = await import("@/lib/ai/mock");
    void mockProvider;
    const { replayProvider } = await import("@/lib/ai/replay");
    const p = replayProvider();
    const other = await p.extractMemory({ kind: "image", image: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }, originalName: "x.png", now });
    expect(p.name).toBe("mock");
    expect(other.note ?? "").not.toMatch(/Replay/);
  });
});
