import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorSummary, logError, logEvent, redact } from "@/lib/log";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-log-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved, ACORN_DATA_DIR: dir, ACORN_STORAGE: "local" };
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"; // fake test value, not a real credential
const DB = "postgresql://postgres.abcd:Sup3rS3cretPw@aws-0.pooler.supabase.com:5432/postgres"; // fake test value, not a real credential
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

describe("redaction", () => {
  it("removes the value of every secret-named environment variable, and leaves other values alone", () => {
    process.env.SOMETHING_API_KEY = "value-that-must-vanish-1";
    process.env.MY_SERVICE_PASSWORD = "value-that-must-vanish-2";
    process.env.CRON_SECRET = "c".repeat(40);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://public.example.co";
    process.env.HARMLESS_SETTING = "just-a-setting";
    const out = redact(`a ${process.env.SOMETHING_API_KEY} b ${process.env.MY_SERVICE_PASSWORD} c ${"c".repeat(40)} d https://public.example.co e just-a-setting`);
    expect(out).not.toMatch(/value-that-must-vanish|c{40}/);
    expect(out).toContain("[redacted SOMETHING_API_KEY]");
    expect(out).toContain("https://public.example.co"); // public by design
    expect(out).toContain("just-a-setting");
  });

  it("removes secret-shaped strings even when no variable holds them", () => {
    const out = redact(`key ${KEY}; db ${DB}; header Authorization: Bearer abcdef1234567890xyz; jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl; resend re_AbCdEfGhIjKlMnOpQrSt; sb sb_secret_AbCdEfGhIjKlMnOp`); // fake test value, not a real credential
    for (const leaked of [KEY, "Sup3rS3cretPw", "abcdef1234567890xyz", "eyJhbGciOiJIUzI1NiJ9", "re_AbCdEfGhIjKlMnOpQrSt", "sb_secret_AbCdEfGhIjKlMnOp"]) expect(out, leaked).not.toContain(leaked); // fake test value, not a real credential
    expect(out).toContain("postgresql://postgres.abcd:[redacted]@aws-0.pooler.supabase.com"); // the host stays useful for debugging // fake test value, not a real credential
  });

  it("summarises an error as name, short message and file:line, never the object", () => {
    const e = new Error(`request to https://x failed with ${KEY}`);
    const s = errorSummary(e);
    expect(s).toMatchObject({ name: "Error" });
    expect(s.message).not.toContain(KEY);
    expect(errorSummary(new Error("x".repeat(2000))).message.length).toBeLessThan(310);
    expect(errorSummary("a plain string with " + KEY).message).not.toContain(KEY);
  });
});

describe("structured logs", () => {
  it("writes one parseable JSON line, with credentials removed from every field", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logEvent("info", "demo", { count: 3, note: `contains ${KEY}`, nested: { url: DB } });
    const [line] = lines(info);
    const j = JSON.parse(line);
    expect(j).toMatchObject({ level: "info", evt: "demo", count: 3 });
    expect(typeof j.t).toBe("string");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("Sup3rS3cretPw");
  });

  it("errors go to stderr with a summary, not the raw object", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("boom", new Error(`failed: ${DB}`), { id: "abc" });
    const j = JSON.parse(lines(err)[0]);
    expect(j).toMatchObject({ level: "error", evt: "boom", id: "abc", error: { name: "Error" } });
    expect(lines(err)[0]).not.toContain("Sup3rS3cretPw");
    expect(err.mock.calls[0]).toHaveLength(1); // one string, no error object with a stack and request details
  });
});

describe("API error responses and logs never carry secrets", () => {
  it("an unexpected failure answers with a fixed message and logs a redacted summary", async () => {
    process.env.META_API_KEY = KEY;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { errorResponse } = await import("@/app/api/_http");
    const res = errorResponse(new Error(`upstream refused ${KEY} for ${DB}`));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe('{"error":"Something went wrong on our side. Please try again."}');
    for (const l of lines(err)) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain("Sup3rS3cretPw");
    }
  });

  it("known failures show their own safe message and nothing else", async () => {
    const { errorResponse, HttpError } = await import("@/app/api/_http");
    const { AiError } = await import("@/lib/ai/errors");
    expect(await errorResponse(new HttpError(404, "Memory not found")).json()).toEqual({ error: "Memory not found" });
    const ai = await errorResponse(new AiError("Meta API rejected the API key or its access to this model (HTTP 401).", "auth")).json();
    expect(JSON.stringify(ai)).not.toMatch(/sk-|Bearer/);
  });
});

describe("scheduler logging", () => {
  it("a successful run logs counts and duration only: no reminder titles, ids or notification text", async () => {
    process.env.CRON_SECRET = "s".repeat(40);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { createReminder } = await import("@/lib/reminders");
    await createReminder({ memoryId: "sample-job-lumen", title: "TOP-SECRET-REMINDER-TITLE", dueAt: new Date(Date.now() - 60_000).toISOString() });
    const { POST } = await import("@/app/api/cron/tick/route");
    const res = await POST(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${"s".repeat(40)}` } }));
    expect(res.status).toBe(200);
    const tick = lines(info).map((l) => JSON.parse(l)).find((j) => j.evt === "tick");
    expect(tick).toMatchObject({ level: "info", queued: expect.any(Number), sent: expect.any(Number), ms: expect.any(Number) });
    expect(lines(info).join("\n")).not.toContain("TOP-SECRET-REMINDER-TITLE");
    expect(lines(info).join("\n")).not.toContain("s".repeat(40));
  });

  it("a rejected call is logged without anything the caller sent", async () => {
    process.env.CRON_SECRET = "s".repeat(40);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/cron/tick/route");
    const attempt = "Bearer guess-guess-guess-guess";
    expect((await POST(new Request("http://x", { method: "POST", headers: { authorization: attempt, "x-forwarded-for": "203.0.113.9" } }))).status).toBe(401);
    expect(JSON.parse(lines(warn)[0])).toMatchObject({ level: "warn", evt: "tick_unauthorized" });
    expect(lines(warn).join("")).not.toMatch(/guess|203\.0\.113/);
  });

  it("with Supabase configured but no service-role key, the scheduler answers 500 with a fixed message and logs the reason", async () => {
    process.env.CRON_SECRET = "s".repeat(40);
    process.env.ACORN_STORAGE = "supabase";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-public-key";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/cron/tick/route");
    const res = await POST(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${"s".repeat(40)}` } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "The scheduled run failed. See the server log." });
    expect(JSON.parse(lines(err)[0])).toMatchObject({ evt: "tick_failed", error: { message: expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY") } });
  });
});
