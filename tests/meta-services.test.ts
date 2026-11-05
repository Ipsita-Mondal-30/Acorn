import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));

import { DELETE as voiceDelete, POST as voiceOp } from "@/app/api/voice/[id]/route";
import { POST as voicePost } from "@/app/api/voice/route";
import { POST as artifactOp } from "@/app/api/artifacts/[id]/route";
import { GET as fileGet } from "@/app/api/files/[name]/route";
import { POST as explore } from "@/app/api/memories/[id]/explore/route";
import { POST as visualAid } from "@/app/api/memories/[id]/visual-aid/route";
import { encodeWav } from "@/lib/audio/wav";
import { processMemory, removeMemory, saveCapture } from "@/lib/process";
import { effective } from "@/lib/schema";
import { getArtifact, getMemory, listArtifacts } from "@/lib/store";
import { readUpload } from "@/lib/uploads";

// The whole persistence path in DEMO mode (no network, no key): rows are written before the model is called, outputs are
// labelled mock, nothing is confirmed on the user's behalf, and everything is removed with its memory.

let dir: string;
const saved = { ...process.env };
const wav = () => encodeWav(Float32Array.from({ length: 16_000 * 2 }, (_, i) => Math.sin(i / 25) * 0.3), 16_000);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const jsonReq = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runAfter = async () => {
  for (const fn of afterQueue.splice(0)) await fn();
};
const upload = (bytes: Uint8Array, langs?: string[]) => {
  const form = new FormData();
  form.set("audio", new File([Buffer.from(bytes)], "recording.wav", { type: "audio/wav" }));
  if (langs) form.set("languages", JSON.stringify(langs));
  return voicePost(new Request("http://x/api/voice", { method: "POST", body: form }));
};
const SAMPLE = async () => new Uint8Array(await readFile(path.resolve("public/samples/job-listing-screenshot.png")));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-svc-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo", AI_ENABLE_REAL_CALLS: "false" });
  delete process.env.META_API_KEY;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
beforeEach(() => void (afterQueue.length = 0));
afterAll(async () => {
  process.env = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("voice: record → transcript → confirm → memory", () => {
  it("keeps the audio privately, records provenance (mock, no transcript) and never creates a memory by itself", async () => {
    const before = (await import("@/lib/store").then((s) => s.listMemories())).length;
    const res = await upload(wav(), ["English", "Hindi"]);
    expect(res.status).toBe(201);
    const { artifact } = await res.json();
    expect(artifact).toMatchObject({ kind: "voice", status: "ready", provider: "mock", model: "mock-no-transcription", memoryId: null, attempts: 1 });
    expect(artifact.fileName).toMatch(/\.wav$/);
    expect(artifact.output.transcript).toBe("");
    expect(artifact.output.note).toMatch(/does not listen/);
    expect(artifact.input.languageBias).toEqual(["English", "Hindi"]);
    expect((await readUpload(artifact.fileName))?.mimeType).toBe("audio/wav");
    expect((await import("@/lib/store").then((s) => s.listMemories())).length).toBe(before);
  });

  it("rejects a recording the API would reject (stereo, wrong rate, not WAV) and stores nothing", async () => {
    const n = (await listArtifacts()).length;
    const bad = wav();
    new DataView(bad.buffer).setUint16(22, 2, true);
    expect((await upload(bad)).status).toBe(400);
    expect((await upload(new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await listArtifacts()).length).toBe(n);
  });

  it("saving makes a searchable note with a SUGGESTED intent only and no invented deadline; saving twice is idempotent", async () => {
    const { artifact } = await (await upload(wav())).json();
    const text = "I want to learn Redis, build a project around it and finish it this week.";
    const res = await voiceOp(jsonReq({ op: "save", text }), ctx(artifact.id));
    expect(res.status).toBe(201);
    const { memory } = await res.json();
    expect(memory.source).toMatchObject({ kind: "note", text });
    await runAfter();
    const understood = (await getMemory(memory.id))!;
    expect(understood.status).toBe("ready");
    const v = effective(understood);
    expect(understood.userIntent ?? null).toBeNull(); // nothing was confirmed on the user's behalf
    expect(v.intentStatus).not.toBe("confirmed");
    expect(v.deadline ?? null).toBeNull(); // "this week" is not a date
    const linked = await getArtifact(artifact.id);
    expect(linked).toMatchObject({ memoryId: memory.id });
    expect((linked!.output as { confirmedText: string }).confirmedText).toBe(text);
    const again = await voiceOp(jsonReq({ op: "save", text }), ctx(artifact.id));
    expect(again.status).toBe(200);
    expect((await again.json()).memory.id).toBe(memory.id);
  });

  it("an empty transcript can't be saved; discarding removes the audio; a saved note can't be discarded", async () => {
    const { artifact } = await (await upload(wav())).json();
    expect((await voiceOp(jsonReq({ op: "save", text: "   " }), ctx(artifact.id))).status).toBe(400);
    expect((await voiceDelete(new Request("http://x", { method: "DELETE" }), ctx(artifact.id))).status).toBe(200);
    expect(await getArtifact(artifact.id)).toBeNull();
    expect(await readUpload(artifact.fileName)).toBeNull();
    const kept = (await (await upload(wav())).json()).artifact;
    await voiceOp(jsonReq({ op: "save", text: "Keep this one" }), ctx(kept.id));
    expect((await voiceDelete(new Request("http://x", { method: "DELETE" }), ctx(kept.id))).status).toBe(409);
    expect((await voiceOp(jsonReq({ op: "save", text: "x" }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("visual aid: only on request, only from the memory's own statements, always labelled AI-created", () => {
  it("creates a labelled demo diagram linked to the memory, served sandboxed; regenerating keeps the earlier one", async () => {
    const { memory } = await saveCapture({ kind: "note", text: "Learn Redis caching\n- allkeys-lru evicts the least recently used keys when memory is full\n- maxmemory sets the memory limit for the dataset" });
    await processMemory(memory.id);
    expect(await listArtifacts({ memoryId: memory.id })).toEqual([]); // capture never generates images
    const res = await visualAid(new Request("http://x", { method: "POST" }), ctx(memory.id));
    expect(res.status).toBe(201);
    const { artifact } = await res.json();
    expect(artifact).toMatchObject({ kind: "visual_aid", status: "ready", provider: "mock", model: "mock-diagram", memoryId: memory.id, usage: null });
    expect(artifact.output.aiGenerated).toBe(true);
    expect(artifact.output.basedOn.join(" ")).toMatch(/allkeys-lru/);
    expect(artifact.output.prompt).toMatch(/use ONLY the numbered statements/i);
    const served = await fileGet(new Request("http://x"), { params: Promise.resolve({ name: artifact.fileName }) } as never);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(await served.text()).toMatch(/not Muse Image/);
    await visualAid(new Request("http://x", { method: "POST" }), ctx(memory.id));
    expect((await listArtifacts({ memoryId: memory.id, kind: "visual_aid" })).length).toBe(2);
  });

  it("a memory with nothing to draw from fails safely and can be retried once it has content", async () => {
    const { memory } = await saveCapture({ kind: "note", text: "x" });
    const { artifact } = await (await visualAid(new Request("http://x", { method: "POST" }), ctx(memory.id))).json();
    expect(artifact).toMatchObject({ status: "failed", attempts: 1 });
    expect(artifact.error.message).toMatch(/enough in this memory/);
    await processMemory(memory.id);
    const retried = await (await artifactOp(jsonReq({ op: "retry" }), ctx(artifact.id))).json();
    expect(retried.artifact.attempts).toBe(2);
    expect(["ready", "failed"]).toContain(retried.artifact.status);
    expect((await artifactOp(jsonReq({ op: "retry" }), ctx(artifact.id)).then((r) => r.status))).toBe(retried.artifact.status === "ready" ? 409 : 200);
  });

  it("404 for an unknown memory", async () => {
    expect((await visualAid(new Request("http://x", { method: "POST" }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("explore image: SAM boxes → Muse Spark reading → user confirms → linked memory", () => {
  it("finds regions, reads one, and saves it only after confirmation; the original is never changed", async () => {
    const bytes = await SAMPLE();
    const { memory } = await saveCapture({ kind: "image", bytes, originalName: "job-listing-screenshot.png" });
    await processMemory(memory.id);
    const original = await readUpload(memory.source.fileName!);

    const seg = await (await explore(jsonReq({ target: "the deadline" }), ctx(memory.id))).json();
    expect(seg.artifact).toMatchObject({ kind: "segmentation", status: "ready", provider: "mock", model: "mock-fixture", memoryId: memory.id });
    expect(seg.artifact.output.regions).toHaveLength(1);
    expect(seg.artifact.output.note).toMatch(/does not run SAM 3\.1/);

    const unknown = await (await explore(jsonReq({ target: "unicorn logo" }), ctx(memory.id))).json();
    expect(unknown.artifact.output.regions).toEqual([]);

    const regionId = seg.artifact.output.regions[0].id;
    expect((await artifactOp(jsonReq({ op: "interpret", regionId: 999 }), ctx(seg.artifact.id))).status).toBe(400);
    const reading = (await (await artifactOp(jsonReq({ op: "interpret", regionId }), ctx(seg.artifact.id))).json()).artifact;
    expect(reading).toMatchObject({ kind: "region_reading", status: "ready", parentId: seg.artifact.id, confirmedMemoryId: null, provider: "mock" });
    expect(reading.output.quote).toBe("Applications close 15 January 2027.");

    const before = (await import("@/lib/store").then((s) => s.listMemories())).length;
    expect((await import("@/lib/store").then((s) => s.listMemories())).length).toBe(before); // reading alone saves nothing
    const confirmed = await artifactOp(jsonReq({ op: "confirm" }), ctx(reading.id));
    expect(confirmed.status).toBe(201);
    const { memory: linked } = await confirmed.json();
    expect(linked.source.text).toMatch(/Applications close 15 January 2027/);
    expect(linked.source.text).toMatch(/confirmed by me/);
    expect((await getArtifact(reading.id))!.confirmedMemoryId).toBe(linked.id);
    expect((await artifactOp(jsonReq({ op: "confirm" }), ctx(reading.id))).status).toBe(200); // idempotent

    const after = await readUpload(memory.source.fileName!);
    expect(Buffer.from(after!.bytes).equals(Buffer.from(original!.bytes))).toBe(true);
    expect(Buffer.from(after!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("only works on saved images, and needs a target", async () => {
    const { memory } = await saveCapture({ kind: "note", text: "just a note about nothing" });
    expect((await explore(jsonReq({ target: "the deadline" }), ctx(memory.id))).status).toBe(400);
    expect((await explore(jsonReq({ target: "  " }), ctx(memory.id))).status).toBe(400);
    expect((await explore(jsonReq({ target: "x" }), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("cleanup", () => {
  it("deleting a memory removes its artifacts and their stored files", async () => {
    const { memory } = await saveCapture({ kind: "note", text: "Learn Redis eviction policies and the maxmemory setting" });
    await processMemory(memory.id);
    const { artifact } = await (await visualAid(new Request("http://x", { method: "POST" }), ctx(memory.id))).json();
    expect(await readUpload(artifact.fileName)).not.toBeNull();
    expect(await removeMemory(memory.id)).toBe(true);
    expect(await listArtifacts({ memoryId: memory.id })).toEqual([]);
    expect(await readUpload(artifact.fileName)).toBeNull();
  });
});
