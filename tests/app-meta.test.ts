import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProvider } from "@/lib/ai/mock";

// The whole capture path through the application service (captureMemory -> processMemory -> getProvider -> Meta
// provider -> Zod validation -> store), with ONLY the network stubbed. No real request is made. This proves how Acorn
// wires the Meta provider into a capture; it does not prove the live API (that is `npm run meta:check`).

const KEY = "LLM_APP_TEST_SECRET";
const saved = { ...process.env };
let dir: string;
// a 1x1 PNG with a recognisable body so the data URL can be checked
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-appmeta-"));
});
beforeEach(() => {
  vi.resetModules();
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.AI_PROVIDER = "meta";
  process.env.AI_ENABLE_REAL_CALLS = "true";
  process.env.META_API_KEY = KEY;
  process.env.ACORN_RETRY_BASE_MS = "0";
  delete process.env.ACORN_MODE;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

async function extractionFor(text: string) {
  const r = await mockProvider.extractMemory({ kind: "note", text, now: new Date() });
  return r.data;
}
const completion = (data: unknown, usage = { prompt_tokens: 2000, completion_tokens: 400, total_tokens: 2400 }) =>
  Response.json({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }], usage });

describe("capture -> Meta -> memory (stubbed network)", () => {
  it("sends the right request for an image and persists the validated result with usage", async () => {
    const data = await extractionFor("Acme is hiring a Staff Engineer. Apply by Nov 12");
    const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => completion(data));
    vi.stubGlobal("fetch", fetchSpy);
    const { captureMemory } = await import("@/lib/process");

    const { memory, created } = await captureMemory({ kind: "image", bytes: PNG, originalName: `shot-${randomUUID()}.png`, text: "job post" });
    expect(created).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.response_format.type).toBe("json_schema");
    const parts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(body)).not.toContain(KEY);

    expect(memory.status).toBe("ready");
    expect(memory.extraction?.producedBy).toMatchObject({ provider: "meta", model: "muse-spark-1.3" });
    expect(memory.extraction?.producedBy.usage).toMatchObject({ promptTokens: 2000, completionTokens: 400, totalTokens: 2400 });
    expect(memory.extraction?.producedBy.usage?.estimatedCostUsd).toBeGreaterThan(0);
    expect(memory.extraction?.title).toBe(data && (data as { title: string }).title);

    // what was stored is what a later read returns (the memory-detail page reads this same record)
    const { getMemory } = await import("@/lib/store");
    expect((await getMemory(memory.id))?.extraction?.producedBy.provider).toBe("meta");
  });

  it("a model answer that fails validation is a visible failure, never a silent mock result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completion({ title: 123, nonsense: true })));
    const { captureMemory } = await import("@/lib/process");
    const { memory } = await captureMemory({ kind: "note", text: `Something to save ${randomUUID()}` });
    expect(memory.status).toBe("failed");
    expect(memory.error).toMatch(/unexpected shape/);
    expect(memory.extraction).toBeNull();
  });

  it.each([
    [401, /rejected the API key/],
    [402, /billing/],
    [429, /rate limit/],
  ])("HTTP %i is recorded on the memory with a safe message and no mock fallback", async (status, message) => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ error: { message: `echo ${KEY}`, code: "x" } }), { status }));
    vi.stubGlobal("fetch", spy);
    const { captureMemory } = await import("@/lib/process");
    const { memory } = await captureMemory({ kind: "note", text: `Another note ${randomUUID()}` });
    expect(memory.status).toBe("failed");
    expect(memory.error).toMatch(message);
    expect(memory.error).not.toContain(KEY);
    expect(memory.extraction).toBeNull();
  });

  it("with real calls switched off nothing is sent and the memory fails visibly", async () => {
    process.env.AI_ENABLE_REAL_CALLS = "false";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { captureMemory } = await import("@/lib/process");
    const { memory } = await captureMemory({ kind: "note", text: `Gated note ${randomUUID()}` });
    expect(spy).not.toHaveBeenCalled();
    expect(memory.status).toBe("failed");
    expect(memory.error).toMatch(/switched off/);
    expect(memory.extraction).toBeNull();
  });

  it("reprocess after a failure retries and succeeds, once", async () => {
    const data = await extractionFor("Remember to book the dentist for Friday");
    let n = 0;
    const spy = vi.fn(async () => (++n === 1 ? new Response("{}", { status: 401 }) : completion(data)));
    vi.stubGlobal("fetch", spy);
    const { captureMemory, processMemory } = await import("@/lib/process");
    const { memory } = await captureMemory({ kind: "note", text: `Remember to book the dentist ${randomUUID()}` });
    expect(memory.status).toBe("failed");
    const again = await processMemory(memory.id);
    expect(again?.status).toBe("ready");
    expect(again?.extraction?.producedBy.provider).toBe("meta");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
