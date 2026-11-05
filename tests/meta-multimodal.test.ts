import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWav, parseWav, resample, WavError } from "@/lib/audio/wav";

// Voice, image and segmentation against a STUBBED fetch shaped like the documented API (dev.meta.ai/docs). These prove how
// Acorn builds requests and handles answers and errors. They do not prove the live API accepts them: no paid call is made.

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));

const KEY = "LLM_TEST_SECRET_KEY_123";
const tone = (seconds = 1, rate = 16_000) => encodeWav(Float32Array.from({ length: seconds * rate }, (_, i) => Math.sin(i / 20) * 0.3), rate);
let dir: string;
const saved = { ...process.env };

const metaEnv = () => {
  process.env.ACORN_MODE = "meta";
  process.env.AI_ENABLE_REAL_CALLS = "true";
  process.env.META_API_KEY = KEY;
  process.env.META_API_BASE_URL = "https://api.meta.test/v1";
  process.env.ACORN_RETRY_BASE_MS = "0";
  process.env.ACORN_MAX_MODEL_CALLS = "50";
};
const demoEnv = () => {
  process.env.ACORN_MODE = "demo";
  process.env.AI_ENABLE_REAL_CALLS = "false";
  delete process.env.META_API_KEY;
};
const fresh = async () => {
  vi.resetModules();
  return {
    tr: await import("@/lib/ai/transcribe"),
    img: await import("@/lib/ai/image"),
    sam: await import("@/lib/ai/sam"),
    region: await import("@/lib/ai/region"),
    errors: await import("@/lib/ai/errors"),
  };
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-mm-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
beforeEach(() => demoEnv());
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("WAV validation (what the transcription API accepts)", () => {
  it("round-trips a mono 16-bit WAV and reports its duration", () => {
    const info = parseWav(tone(2));
    expect(info).toMatchObject({ sampleRate: 16_000, durationMs: 2000 });
  });
  it("accepts 24 kHz", () => expect(parseWav(tone(1, 24_000)).sampleRate).toBe(24_000));
  it("rejects what is not mono 16-bit PCM at 16/24 kHz, too short, empty or not WAV", () => {
    expect(() => parseWav(tone(1, 44_100))).toThrow(/16 kHz or 24 kHz/);
    expect(() => parseWav(new Uint8Array(0))).toThrow(/empty/);
    expect(() => parseWav(new Uint8Array(100).fill(7))).toThrow(WavError);
    expect(() => parseWav(encodeWav(new Float32Array(100), 16_000))).toThrow(/too short/);
    const stereo = tone(1);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow(/mono/);
    const eightBit = tone(1);
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(() => parseWav(eightBit)).toThrow(/16-bit/);
  });
  it("rejects recordings longer than 5 minutes and files over 10 MB", () => {
    expect(() => parseWav(tone(301))).toThrow(/up to 5 minutes/);
    expect(() => parseWav(new Uint8Array(11 * 1024 * 1024))).toThrow(/too large/);
  });
  it("resamples to the requested rate", () => expect(resample(new Float32Array(48_000), 48_000, 16_000).length).toBe(16_000));
});

describe("Muse Voice Transcribe client", () => {
  it("demo mode: makes no request, returns an EMPTY transcript labelled mock", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tr } = await fresh();
    const r = await tr.transcribeAudio(tone(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ transcript: "", provider: "mock", model: "mock-no-transcription" });
    expect(r.note).toMatch(/Demo mode does not listen/);
  });

  it("Meta mode: multipart POST /asr/transcribe with a JSON request part and the WAV audio part, Bearer auth", async () => {
    metaEnv();
    let seen: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ sessionId: "s-1", transcript: "I want to learn Redis.", audioDurationMs: 1000, turns: [] });
    }));
    const { tr } = await fresh();
    const r = await tr.transcribeAudio(tone(1), { languageBias: ["English", "Hindi"] });
    expect(seen!.url).toBe("https://api.meta.test/v1/asr/transcribe");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect((seen!.init.headers as Record<string, string>).Accept).toBe("application/json");
    const form = seen!.init.body as FormData;
    const settings = JSON.parse(await (form.get("request") as Blob).text());
    expect(settings).toMatchObject({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", languageBias: ["English", "Hindi"] });
    expect((form.get("audio") as File).type).toBe("audio/wav");
    expect(r).toMatchObject({ transcript: "I want to learn Redis.", provider: "meta", model: "muse-voice-transcribe-1.0", sessionId: "s-1" });
  });

  it("refuses an invalid recording before sending anything", async () => {
    metaEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tr } = await fresh();
    await expect(tr.transcribeAudio(tone(1, 44_100))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps API failures to safe messages and retries 429 then gives up", async () => {
    metaEnv();
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: `echo ${KEY}` } }), { status: 429 }));
    vi.stubGlobal("fetch", f);
    const { tr } = await fresh();
    const err = await tr.transcribeAudio(tone(1)).catch((e) => e);
    expect(err.kind).toBe("rate_limit");
    expect(err.message).not.toContain(KEY);
    expect(f).toHaveBeenCalledTimes(3);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(tr.transcribeAudio(tone(1))).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("META_MAX_ATTEMPTS=1 never retries: one paid request, one failure", async () => {
    metaEnv();
    process.env.META_MAX_ATTEMPTS = "1";
    try {
      const f = vi.fn(async () => new Response("{}", { status: 503 }));
      vi.stubGlobal("fetch", f);
      const { tr } = await fresh();
      await expect(tr.transcribeAudio(tone(1))).rejects.toMatchObject({ kind: "unavailable" });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.META_MAX_ATTEMPTS;
    }
  });

  it("is blocked without AI_ENABLE_REAL_CALLS", async () => {
    metaEnv();
    process.env.AI_ENABLE_REAL_CALLS = "false";
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { tr } = await fresh();
    await expect(tr.transcribeAudio(tone(1))).rejects.toMatchObject({ kind: "config" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Muse Image client", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  it("demo mode draws a labelled SVG itself and calls nothing", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { img } = await fresh();
    const r = await img.generateImage("p", () => "<svg/>");
    expect(f).not.toHaveBeenCalled();
    expect(r).toMatchObject({ provider: "mock", model: "mock-diagram", ext: "svg", usage: null });
    expect(r.note).toMatch(/not a Muse Image result/);
  });
  it("Meta mode: JSON POST /images/generations with model, prompt, n=1, size, b64_json, png", async () => {
    metaEnv();
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ created: 1, data: [{ b64_json: png.toString("base64"), revised_prompt: "rp" }], usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 } });
    }));
    const { img } = await fresh();
    const r = await img.generateImage("Draw it", () => "");
    expect(body).toMatchObject({ model: "muse-image-1.0", prompt: "Draw it", n: 1, response_format: "b64_json", output_format: "png" });
    expect(r).toMatchObject({ provider: "meta", model: "muse-image-1.0", ext: "png", revisedPrompt: "rp" });
    expect(r.usage).toMatchObject({ promptTokens: 100, completionTokens: 7, estimatedCostUsd: 0.01 });
  });
  it("rejects a non-PNG payload and maps a safety block", async () => {
    metaEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })));
    const { img } = await fresh();
    await expect(img.generateImage("p", () => "")).rejects.toMatchObject({ kind: "malformed" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "content_policy_violation", param: "prompt" } }), { status: 400 })));
    await expect(img.generateImage("p", () => "")).rejects.toThrow(/safety filters/);
  });
});

describe("SAM 3.1 client", () => {
  const stream = (text: string) =>
    new Response([`data: ${JSON.stringify({ type: "response.created" })}`, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`, "data: [DONE]", ""].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  const record = "<0f>7<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200;c=0.91|>,~12,34,ab=,cd=;x1=1;y1=2;x2=3;y2=4|>";

  it("parses boxes by key (xyxy source pixels), keeps confidence, ignores the mask payload", async () => {
    const { sam } = await fresh();
    const p = sam.parseBoxes(`${record}\n<0f>9<|box;w=900;h=600;x1=10;y1=20;x2=110;y2=60|>`);
    expect(p.frame).toEqual({ w: 1800, h: 1200 });
    expect(p.regions).toEqual([
      { id: 7, box: { x1: 444, y1: 626, x2: 675, y2: 849 }, confidence: 0.91 },
      { id: 9, box: { x1: 10, y1: 20, x2: 110, y2: 60 }, confidence: null },
    ]);
    expect(sam.parseBoxes("").regions).toEqual([]);
    expect(sam.parseBoxes("1<|box;x1=5;y1=5;x2=2;y2=9;w=10;h=10|>").regions).toEqual([]); // inverted box is not a region
  });

  it("Meta mode: /responses with sam-3.1, the phrase and the image as two parts of one message, streaming", async () => {
    metaEnv();
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      headers = init.headers as Record<string, string>;
      return stream(record);
    }));
    const { sam } = await fresh();
    const r = await sam.segmentImage(new Uint8Array([1, 2, 3]), "image/png", "the deadline");
    const content = (body as { input: { content: Record<string, string>[] }[] }).input[0].content;
    expect(body.model).toBe("sam-3.1");
    expect(body.stream).toBe(true);
    expect(content[0]).toEqual({ type: "input_text", text: "the deadline" });
    expect(content[1].type).toBe("input_image");
    expect(content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(headers.Accept).toBe("text/event-stream");
    expect(r).toMatchObject({ provider: "meta", model: "sam-3.1" });
    expect(r.regions).toHaveLength(1);
  });

  it("reads the closing output_text.done text when no deltas were streamed, and never counts text twice", async () => {
    const { sam } = await fresh();
    const rec = "<0f>4<|box;x1=1;y1=2;x2=30;y2=40;w=100;h=80|>";
    const done = `data: ${JSON.stringify({ type: "response.output_text.done", text: rec })}\n\n`;
    expect(sam.sseText(done)).toBe(rec);
    const both = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: rec })}\n\n${done}`;
    expect(sam.sseText(both)).toBe(rec);
    expect(sam.sseEventTypes(both)).toEqual(["response.output_text.delta", "response.output_text.done"]);
  });

  it("zero matches is a valid answer, not an error", async () => {
    metaEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 })));
    const { sam } = await fresh();
    expect((await sam.segmentImage(new Uint8Array([1]), "image/png", "unicorn")).regions).toEqual([]);
  });

  it("demo mode: fixture boxes only for the built-in sample screenshot, clearly labelled; nothing sent", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { sam } = await fresh();
    const bytes = new Uint8Array(await readFile(path.resolve("public/samples/job-listing-screenshot.png")));
    const hit = await sam.segmentImage(bytes, "image/png", "the deadline");
    expect(hit).toMatchObject({ provider: "mock", model: "mock-fixture" });
    expect(hit.regions).toHaveLength(1);
    expect(hit.note).toMatch(/does not run SAM 3\.1/);
    const none = await sam.segmentImage(new Uint8Array([1, 2, 3]), "image/png", "the deadline");
    expect(none.regions).toEqual([]);
    expect(none.note).toMatch(/built-in sample/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Muse Spark region reading", () => {
  it("Meta mode: chat request names the region in pixels and returns a validated reading", async () => {
    metaEnv();
    let sent: { messages: { content: string | { text: string }[] }[] } = { messages: [] };
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ reading: "A closing date.", quote: "Applications close 15 January 2027." }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
    }));
    const { region } = await fresh();
    const r = await region.readRegion(new Uint8Array([1]), "image/png", { box: { x1: 1, y1: 2, x2: 3, y2: 4 }, frame: { w: 900, h: 600 }, target: "the deadline" });
    const text = (sent.messages[1].content as { text: string }[])[0].text;
    expect(text).toContain("x1=1 y1=2 x2=3 y2=4");
    expect(text).toContain("900x600");
    expect(sent.messages[0].content).toMatch(/untrusted/);
    expect(r).toMatchObject({ provider: "meta", reading: "A closing date.", quote: "Applications close 15 January 2027." });
    expect(r.usage?.totalTokens).toBe(70);
  });
  it("demo mode refuses to invent a reading for an image it does not know", async () => {
    const { region } = await fresh();
    await expect(region.readRegion(new Uint8Array([1]), "image/png", { box: { x1: 1, y1: 2, x2: 3, y2: 4 }, frame: { w: 9, h: 9 }, target: "x" })).rejects.toMatchObject({ kind: "unsupported" });
  });
});
