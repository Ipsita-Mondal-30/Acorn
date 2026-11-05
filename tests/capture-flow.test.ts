import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `after()` only exists inside a request; here it just collects the callbacks so a test decides when they run.
const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));

import { POST as capture } from "@/app/api/memories/route";
import { POST as share, GET as shareGet } from "@/app/share/route";
import { POST as memoryOp } from "@/app/api/memories/[id]/route";
import { saveCapture, processMemory } from "@/lib/process";
import { captureFromShare } from "@/lib/share";
import { getMemory, listMemories, updateMemory } from "@/lib/store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let dir: string;
const saved = { ...process.env };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-capture-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.ACORN_MODE = "demo";
});
beforeEach(() => void (afterQueue.length = 0));
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const note = (s: string) => `${s} [${randomUUID()}]`;
const post = (body: unknown) =>
  capture(new Request("http://x/api/memories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const runAfter = async () => {
  for (const fn of afterQueue.splice(0)) await fn();
};
const op = (id: string, name: string) =>
  memoryOp(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: name }) }), { params: Promise.resolve({ id }) } as never);

describe("capture saves first, understands afterwards", () => {
  it("replies 201 with a pending memory and understands it only after the response", async () => {
    const res = await post({ kind: "note", text: note("Apply to Acme by Nov 12") });
    const { memory, created } = await res.json();
    expect(res.status).toBe(201);
    expect(created).toBe(true);
    expect(memory.status).toBe("pending");
    expect(memory.extraction).toBeNull();
    expect((await getMemory(memory.id))?.status).toBe("pending"); // persisted before any processing
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    const done = await getMemory(memory.id);
    expect(done?.status).toBe("ready");
    expect(done?.extraction?.producedBy.provider).toBe("mock");
  });

  it("a repeated submission gives the existing memory, not a duplicate, and schedules nothing new once understood", async () => {
    const text = note("Reconnect with Sam");
    const a = await (await post({ kind: "note", text })).json();
    await runAfter();
    const res = await post({ kind: "note", text: `  ${text} ` });
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.created).toBe(false);
    expect(b.memory.id).toBe(a.memory.id);
    expect(afterQueue).toHaveLength(0);
    expect((await listMemories()).filter((m) => m.source.text === text)).toHaveLength(1);
  });

  it("a repeat of something never understood picks the work up again", async () => {
    const text = note("Try the lentil soup");
    const { memory } = await saveCapture({ kind: "note", text }); // saved, then the server 'restarted' before processing
    const res = await post({ kind: "note", text });
    expect((await res.json()).created).toBe(false);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect((await getMemory(memory.id))?.status).toBe("ready");
  });

  it("stores an uploaded image before anything else and keeps the original when understanding fails", async () => {
    const form = new FormData();
    form.set("file", new File([PNG, new Uint8Array([9, 9, randomUUID().length])], "shot.png", { type: "image/png" }));
    const res = await capture(new Request("http://x/api/memories", { method: "POST", body: form }));
    const { memory } = await res.json();
    expect(res.status).toBe(201);
    expect(memory.status).toBe("pending");
    expect(memory.source).toMatchObject({ kind: "image", originalName: "shot.png" });
    expect(memory.source.fileName).toMatch(/\.png$/);
    await runAfter();
    // simulate a model failure on a second try: the original file is untouched and the memory says what happened
    const failed = await updateMemory(memory.id, (m) => ({ ...m, status: "failed", error: "The model timed out. Try again." }));
    expect(failed?.source.fileName).toBe(memory.source.fileName);
    const retry = await (await op(memory.id, "process")).json();
    expect(["ready", "failed"]).toContain(retry.memory.status);
    expect(retry.memory.source.fileName).toBe(memory.source.fileName);
  });

  it("rejects a file that isn't an image or PDF, naming what is supported, and saves nothing", async () => {
    const before = (await listMemories()).length;
    const form = new FormData();
    form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const res = await capture(new Request("http://x/api/memories", { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PNG, JPEG, WebP or GIF/);
    expect((await listMemories()).length).toBe(before);
    expect(afterQueue).toHaveLength(0);
  });

  it("a processing failure is recorded on the memory and a retry can finish it", async () => {
    const { memory } = await saveCapture({ kind: "note", text: note("Learn Redis") });
    await updateMemory(memory.id, (m) => ({ ...m, status: "failed", error: "Acorn couldn't understand this one." }));
    const out = await processMemory(memory.id);
    expect(out?.status).toBe("ready");
  });
});

describe("share target", () => {
  const shareForm = (fields: Record<string, string | File>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return new Request("http://localhost:3000/share", { method: "POST", body: f });
  };

  it("saves a shared link and opens the new memory", async () => {
    const res = await share(shareForm({ title: "Great article", url: `https://example.com/a/${randomUUID()}` }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!, "https://acorn.example");
    expect(loc.pathname).toMatch(/^\/memories\/[0-9a-f-]{36}$/);
    expect(loc.searchParams.get("saved")).toBe("1");
    const m = await getMemory(loc.pathname.split("/")[2]);
    expect(m?.source).toMatchObject({ kind: "url" });
    expect(afterQueue).toHaveLength(1);
  });

  it("saves a shared image and sends an unsupported file back to the capture page with a reason", async () => {
    const ok = await share(shareForm({ file: new File([PNG, new Uint8Array([7, 7, 1])], "s.png") }));
    expect(new URL(ok.headers.get("location")!, "https://acorn.example").pathname).toMatch(/^\/memories\//);
    const bad = await share(shareForm({ file: new File(["not an image"], "x.exe") }));
    expect(new URL(bad.headers.get("location")!, "https://acorn.example").search).toBe("?share=type");
  });

  it("sends an empty share back with a reason instead of saving nothing silently", async () => {
    const res = await share(shareForm({ title: "  " }));
    expect(new URL(res.headers.get("location")!, "https://acorn.example").search).toBe("?share=empty");
  });

  it("GET only pre-fills the capture form; it saves nothing", async () => {
    const before = (await listMemories()).length;
    const res = await shareGet(new Request("http://localhost:3000/share?url=https%3A%2F%2Fexample.com%2Fx&title=Hi"));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!, "https://acorn.example").pathname).toBe("/capture");
    expect((await listMemories()).length).toBe(before);
  });

  it("captureFromShare reads a link from the text field, keeps the shared words, and rejects unsafe links", () => {
    expect(captureFromShare({ text: "Look at this https://example.com/p?q=1 so good" })).toEqual({ kind: "url", url: "https://example.com/p?q=1", text: "Look at this so good" });
    expect(captureFromShare({ title: "T", text: "just words" })).toEqual({ kind: "note", text: "T\n\njust words" });
    expect(captureFromShare({ url: "javascript:alert(1)", text: "" })).toBeNull();
    expect(captureFromShare({ url: "https://user:pw@example.com/", text: "" })).toBeNull();
    expect(captureFromShare({})).toBeNull();
  });
});
