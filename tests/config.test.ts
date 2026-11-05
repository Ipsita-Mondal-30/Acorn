import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { GET } from "@/app/api/health/route";
import { AiError, getProvider } from "@/lib/ai/provider";
import { aiHealth } from "@/lib/ai/health";
import { getEnv, modeInfo } from "@/lib/env";

const KEY = "LLM_test_key_do_not_leak_0123456789";
const NAMES = [
  "AI_PROVIDER", "ACORN_MODE", "AI_ENABLE_REAL_CALLS", "META_API_KEY", "META_BASE_URL", "META_API_BASE_URL",
  "META_PRIMARY_MODEL", "META_EXTRACTION_MODEL", "META_REASONING_MODEL", "META_REASONING_FOR_PLANS", "META_PLAN_MODEL",
  "META_IMAGE_MODEL", "META_TRANSCRIPTION_MODEL", "META_SEGMENTATION_MODEL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  vi.unstubAllGlobals();
});

describe("provider switch", () => {
  it("defaults to the mock provider with no credentials", () => {
    expect(getEnv().ACORN_MODE).toBe("demo");
    expect(getProvider().name).toBe("mock");
  });

  it("AI_PROVIDER=mock wins over a leftover ACORN_MODE=meta", () => {
    process.env.ACORN_MODE = "meta";
    process.env.AI_PROVIDER = "mock";
    expect(getProvider().name).toBe("mock");
  });

  it("rejects an unknown AI_PROVIDER", () => {
    process.env.AI_PROVIDER = "openai";
    expect(() => getEnv()).toThrow(/AI_PROVIDER must be "mock" or "meta"/);
  });

  it("AI_PROVIDER=meta without a key fails clearly instead of falling back to the mock", () => {
    process.env.AI_PROVIDER = "meta";
    process.env.AI_ENABLE_REAL_CALLS = "true";
    expect(() => getProvider()).toThrow(/META_API_KEY is not set/);
  });

  it("AI_PROVIDER=meta with a key but real calls off refuses before any request", async () => {
    process.env.AI_PROVIDER = "meta";
    process.env.META_API_KEY = KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => getProvider()).toThrow(AiError);
    expect(() => getProvider()).toThrow(/AI_ENABLE_REAL_CALLS/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(modeInfo().label).toBe("Meta mode — real calls off");
  });

  it("accepts the canonical names and falls back to the original ones", () => {
    process.env.META_BASE_URL = "https://example.test/v1/";
    process.env.META_PRIMARY_MODEL = "muse-spark-1.3";
    expect(getEnv().META_API_BASE_URL).toBe("https://example.test/v1");
    process.env.META_API_BASE_URL = "https://other.test/v1";
    expect(getEnv().META_API_BASE_URL).toBe("https://example.test/v1"); // canonical wins
    delete process.env.META_BASE_URL;
    expect(getEnv().META_API_BASE_URL).toBe("https://other.test/v1");
    process.env.META_EXTRACTION_MODEL = "muse-spark-1.2";
    expect(getEnv().META_EXTRACTION_MODEL).toBe("muse-spark-1.3"); // META_PRIMARY_MODEL still wins
  });

  it("uses the documented base URL and model ids by default", () => {
    const e = getEnv();
    expect(e.META_API_BASE_URL).toBe("https://api.meta.ai/v1");
    expect([e.META_EXTRACTION_MODEL, e.META_REASONING_MODEL, e.META_IMAGE_MODEL, e.META_TRANSCRIPTION_MODEL, e.META_SEGMENTATION_MODEL]).toEqual([
      "muse-spark-1.3", "muse-wonder-1.0", "muse-image-1.0", "muse-voice-transcribe-1.0", "sam-3.1",
    ]);
  });

  it("the reasoning model writes plans only when asked to", () => {
    process.env.META_REASONING_MODEL = "muse-wonder-1.0";
    expect(getEnv().META_PLAN_MODEL).toBeUndefined();
    process.env.META_REASONING_FOR_PLANS = "true";
    expect(getEnv().META_PLAN_MODEL).toBe("muse-wonder-1.0");
  });
});

describe("GET /api/health", () => {
  it("reports mock mode", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "mock", status: "mock", apiKeyPresent: false, realCallsEnabled: false });
  });

  it("never contains the key, makes no network request, and distinguishes each state", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.AI_PROVIDER = "meta";
    process.env.META_API_KEY = KEY;
    let text = await (await GET()).text();
    expect(JSON.parse(text)).toMatchObject({ provider: "meta", status: "real-calls-disabled", apiKeyPresent: true });
    process.env.AI_ENABLE_REAL_CALLS = "true";
    text += await (await GET()).text();
    expect(aiHealth().status).toBe("ready");
    delete process.env.META_API_KEY;
    expect(aiHealth().status).toBe("key-missing");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("LLM_");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports each capability's model and which ones Acorn calls", () => {
    const m = aiHealth().models;
    expect(m.primary).toEqual({ id: "muse-spark-1.3", usedByAcorn: true });
    expect(m.image.usedByAcorn || m.transcription.usedByAcorn || m.segmentation.usedByAcorn).toBe(false);
  });
});
