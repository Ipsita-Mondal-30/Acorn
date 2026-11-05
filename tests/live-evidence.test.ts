import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { centreInside, iou, liveCheck, pngSize, similarity } from "./live/evidence";

// The live-check harness itself, with no network and no key: its guards, its validators and its cleanup.

describe("validators", () => {
  it("scores a transcript by words, ignoring case and punctuation, and catches a wrong one", () => {
    const s = "I want to learn Redis, build a project around it and finish it this week.";
    expect(similarity(s, s.toUpperCase().replace(/,/g, ""))).toBe(1);
    expect(similarity(s, "I want to learn Redis build a project around it and finish it this week")).toBeGreaterThanOrEqual(0.9);
    expect(similarity(s, "the weather is lovely today in Lisbon")).toBeLessThan(0.3);
    expect(similarity("", "")).toBe(1);
  });
  it("measures how well a box lands on the expected one", () => {
    const line = { x1: 36, y1: 458, x2: 446, y2: 492 };
    expect(iou(line, line)).toBe(1);
    expect(iou({ x1: 40, y1: 462, x2: 442, y2: 490 }, line)).toBeGreaterThan(0.75);
    expect(iou({ x1: 600, y1: 10, x2: 700, y2: 40 }, line)).toBe(0);
    expect(centreInside({ x1: 40, y1: 462, x2: 442, y2: 490 }, line)).toBe(true);
    expect(centreInside({ x1: 0, y1: 0, x2: 900, y2: 600 }, { x1: 0, y1: 0, x2: 100, y2: 100 })).toBe(false);
  });
  it("reads a PNG's size from its header", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDEgAVgkAFgNA/9kTlG/AAAAAElFTkSuQmCC", "base64");
    expect(pngSize(new Uint8Array(png))).toEqual({ w: 2, h: 2 });
  });
});

describe("live check guards", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });
  const make = (run: () => Promise<never>) =>
    liveCheck({ check: "voice", model: "m", endpoint: "e", input: {}, stubFetch: () => (async () => new Response("{}")) as typeof fetch, run });

  it("refuses without the confirmation variable and without the key-rotated flag, before reading any key or sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.META_LIVE_DRY_RUN;
    await expect(make(async () => { throw new Error("must not run"); })).rejects.toThrow(/META_LIVE_CONFIRM=voice/);
    process.env.META_LIVE_CONFIRM = "voice";
    await expect(make(async () => { throw new Error("must not run"); })).rejects.toThrow(/META_KEY_ROTATED=yes/);
    process.env.META_LIVE_CONFIRM = "image"; // a different check's confirmation does not unlock this one
    process.env.META_KEY_ROTATED = "yes";
    await expect(make(async () => { throw new Error("must not run"); })).rejects.toThrow(/META_LIVE_CONFIRM=voice/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a failing dry run still restores the environment, drops the confirmation variables and saves a failed record", async () => {
    process.env.META_LIVE_DRY_RUN = "1";
    process.env.AI_PROVIDER = "mock";
    process.env.AI_ENABLE_REAL_CALLS = "false";
    delete process.env.ACORN_MAX_MODEL_CALLS;
    const before = globalThis.fetch;
    await expect(make(async () => { throw Object.assign(new Error("boom with Bearer abc.def-123"), { kind: "timeout" }); })).rejects.toThrow(/did not pass/);
    expect(process.env.AI_PROVIDER).toBe("mock");
    expect(process.env.AI_ENABLE_REAL_CALLS).toBe("false");
    expect(process.env.ACORN_MAX_MODEL_CALLS).toBeUndefined();
    expect(process.env.META_API_KEY).toBe(saved.META_API_KEY);
    expect(process.env.META_LIVE_CONFIRM).toBeUndefined();
    expect(globalThis.fetch).toBe(before);
    // this test's own failed record is not evidence of anything: remove it
    const dir = path.resolve(import.meta.dirname, "../artifacts/meta-live/dry-run");
    for (const f of readdirSync(dir).filter((n) => n.endsWith("-voice-failed.json"))) unlinkSync(path.join(dir, f));
  });
});

