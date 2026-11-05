import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertConfig, configProblems } from "@/lib/startup-check";

const NAMES = ["AI_PROVIDER", "ACORN_MODE", "META_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ACORN_STORAGE", "ACORN_MAX_MODEL_CALLS"];
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startup configuration check", () => {
  it("is clean with nothing configured (local demo mode)", () => {
    expect(configProblems()).toEqual([]);
  });

  it("names the missing variable when Supabase is half configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    expect(configProblems().join()).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("rejects a secret key placed in the public variable, without printing it", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_secret_FAKE_VALUE_FOR_THIS_UNIT_TEST";
    const out = configProblems().join();
    expect(out).toMatch(/looks like a secret key/);
    expect(out).not.toContain("abcdef0123456789");
  });

  it("reports ACORN_STORAGE=supabase without credentials", () => {
    process.env.ACORN_STORAGE = "supabase";
    expect(configProblems().join()).toMatch(/ACORN_STORAGE=supabase/);
  });

  it("reports meta mode without a key and an invalid value", () => {
    process.env.AI_PROVIDER = "meta";
    expect(configProblems().join()).toMatch(/META_API_KEY/);
    process.env.ACORN_MAX_MODEL_CALLS = "lots";
    expect(configProblems().join()).toMatch(/Invalid environment configuration/);
  });

  it("logs in development but refuses to start in production", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertConfig()).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertConfig()).toThrow(/configuration problem/);
  });
});
