import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyCorrection } from "@/lib/schema";
import { cancelDeliveries, getReminder, listDeliveries, updateMemory } from "@/lib/store";
import { completeReminder, createReminder, dismissReminder, editReminder, ReminderError, snoozeReminder } from "@/lib/reminders";
import { localBackend } from "@/lib/backends/local";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const saved = { ...process.env };
let dir: string;
const SECRET = "s".repeat(40);
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-napi-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.ACORN_MODE = "demo";
  vi.stubGlobal("fetch", () => {
    throw new Error("a test tried to use the network");
  });
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const JOB = "sample-job-lumen";
const RECIPE = "sample-recipe-pasta";
const PERSON = "sample-person-priya";
const ARTICLE = "sample-article-idempotency";
const future = (days = 2) => new Date(Date.now() + days * 86_400_000).toISOString();
const confirm = (id: string, kind: Parameters<typeof applyCorrection>[1]["userIntent"] extends infer U ? (U extends { kind: infer K } ? K : never) : never) =>
  updateMemory(id, (m) => applyCorrection(m, { userIntent: { kind } }, new Date()));
const jsonReq = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/api", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("reminders from intent: only from an intent you confirmed", () => {
  it("a reminder you ask for yourself needs nothing; every other kind needs a confirmed intent", async () => {
    await expect(createReminder({ memoryId: ARTICLE, title: "Read it", dueAt: future() })).resolves.toMatchObject({ kind: "manual" });
    // the memory has only an inferred guess so far
    for (const kind of ["intent", "deadline", "follow_up", "recipe", "event"] as const) {
      await expect(createReminder({ memoryId: ARTICLE, title: "x", dueAt: future(), kind }), kind).rejects.toThrow(/Confirm why you saved this first/);
    }
    await confirm(ARTICLE, "learn");
    await expect(createReminder({ memoryId: ARTICLE, title: "Study it", dueAt: future(), kind: "intent" })).resolves.toMatchObject({ kind: "intent" });
    // a dismissed guess is no confirmation either
    await updateMemory(PERSON, (m) => applyCorrection(m, { userIntent: { kind: "none" } }, new Date()));
    await expect(createReminder({ memoryId: PERSON, title: "x", dueAt: future(), kind: "intent" })).rejects.toThrow(ReminderError);
  });

  it("each kind also has to fit the memory", async () => {
    await confirm(JOB, "pursue");
    await confirm(RECIPE, "try");
    await expect(createReminder({ memoryId: JOB, title: "Deadline", dueAt: future(), kind: "deadline" })).resolves.toMatchObject({ kind: "deadline" });
    await expect(createReminder({ memoryId: JOB, title: "x", dueAt: future(), kind: "recipe" })).rejects.toThrow(/isn't a recipe/);
    await expect(createReminder({ memoryId: JOB, title: "x", dueAt: future(), kind: "event" })).rejects.toThrow(/isn't an event/);
    await expect(createReminder({ memoryId: JOB, title: "x", dueAt: future(), kind: "follow_up" })).rejects.toThrow(/follow up on/);
    await expect(createReminder({ memoryId: RECIPE, title: "Cook", dueAt: future(), kind: "recipe" })).resolves.toMatchObject({ kind: "recipe" });
    await expect(createReminder({ memoryId: RECIPE, title: "x", dueAt: future(), kind: "deadline" })).rejects.toThrow(/no deadline/);
    await confirm(PERSON, "follow_up");
    await expect(createReminder({ memoryId: PERSON, title: "Check back", dueAt: future(), kind: "follow_up" })).resolves.toMatchObject({ kind: "follow_up" });
  });

  it("every reminder points at the memory (and the action) it came from", async () => {
    const r = await createReminder({ memoryId: JOB, title: "Apply", dueAt: future(), actionId: "an-action", kind: "deadline" });
    expect(r).toMatchObject({ memoryId: JOB, actionId: "an-action" });
    await expect(createReminder({ memoryId: "no-such-memory", title: "x", dueAt: future() })).rejects.toThrow(/doesn't exist/);
  });
});

describe("times and time zones", () => {
  it("'9am my time' becomes the right instant, daylight saving included, and the zone is kept for display", async () => {
    const r = await createReminder({ memoryId: ARTICLE, title: "Morning", dueLocal: "2026-11-02T09:00", timezone: "America/New_York" }); // the day after clocks fell back
    expect(r.dueAt).toBe("2026-11-02T14:00:00.000Z"); // EST
    expect(r.timezone).toBe("America/New_York");
    const r2 = await createReminder({ memoryId: ARTICLE, title: "Summer", dueLocal: "2027-07-01T09:00", timezone: "America/New_York" });
    expect(r2.dueAt).toBe("2027-07-01T13:00:00.000Z"); // EDT
    const gap = await createReminder({ memoryId: ARTICLE, title: "Spring", dueLocal: "2027-03-14T02:30", timezone: "America/New_York" }); // doesn't exist
    expect(gap.dueAt).toBe("2027-03-14T07:30:00.000Z");
  });

  it("refuses an unknown zone, a time given two ways, and neither", async () => {
    await expect(createReminder({ memoryId: ARTICLE, title: "x", dueLocal: "2026-11-02T09:00", timezone: "Mars/Base" })).rejects.toThrow(/time zone/);
    await expect(createReminder({ memoryId: ARTICLE, title: "x", dueAt: future(), dueLocal: "2026-11-02T09:00", timezone: "UTC" })).rejects.toThrow();
    await expect(createReminder({ memoryId: ARTICLE, title: "x" } as never)).rejects.toThrow();
    await expect(createReminder({ memoryId: ARTICLE, title: "x", dueLocal: "2026-11-02T09:00" } as never)).rejects.toThrow();
  });

  it("rescheduling moves the time, records it, and makes the reminder scheduled again", async () => {
    const r = await createReminder({ memoryId: ARTICLE, title: "Move me", dueAt: future(1) });
    const snoozed = (await snoozeReminder(r.id, future(2)))!;
    expect(snoozed.status).toBe("snoozed");
    const moved = (await editReminder(r.id, { dueLocal: "2026-12-01T10:00", timezone: "Asia/Kolkata" }))!;
    expect(moved).toMatchObject({ status: "scheduled", dueAt: "2026-12-01T04:30:00.000Z", timezone: "Asia/Kolkata" });
    expect(moved.history.at(-1)).toMatchObject({ status: "edited", note: expect.stringMatching(/rescheduled from .* to 2026-12-01T04:30:00.000Z/) });
    const sameTime = (await editReminder(r.id, { title: "Renamed" }))!;
    expect(sameTime.history.at(-1)!.note).toBeUndefined(); // a rename is not a reschedule
  });

  it("snoozing counts, takes a local time too, and never goes backwards", async () => {
    const r = await createReminder({ memoryId: ARTICLE, title: "Again", dueAt: future(1) });
    let cur = (await snoozeReminder(r.id, future(2)))!;
    cur = (await snoozeReminder(r.id, { dueLocal: "2027-01-05T08:00", timezone: "Asia/Kolkata" }))!;
    expect(cur).toMatchObject({ snoozeCount: 2, dueAt: "2027-01-05T02:30:00.000Z" });
    await expect(snoozeReminder(r.id, new Date(Date.now() - 1000).toISOString())).rejects.toThrow(/future/);
    expect((await getReminder(r.id))!.snoozeCount).toBe(2);
  });

  it("completing, dismissing, snoozing or moving cancels what hasn't been sent yet, and says why", async () => {
    const mk = async (title: string) => {
      const r = await createReminder({ memoryId: ARTICLE, title, dueAt: future(1) });
      await localBackend.store.getPrefs();
      // queue a pending (held) delivery by hand, as the worker would
      await (await import("@/lib/backends/local")).localWorkerStore.insertDelivery("local", {
        id: crypto.randomUUID(), reminderId: r.id, kind: "reminder", channel: "in_app", status: "pending", reason: "Held", attempts: 0, lastError: null, scheduledFor: future(1),
        sentAt: null, readAt: null, lockedUntil: null, dueAt: r.dueAt, dedupeKey: `t:${r.id}`, payload: { kind: "generic", title, lines: [], links: [], draft: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      return r;
    };
    const a = await mk("a");
    const b = await mk("b");
    const c = await mk("c");
    const d = await mk("d");
    await completeReminder(a.id);
    await dismissReminder(b.id);
    await snoozeReminder(c.id, future(5));
    await editReminder(d.id, { dueAt: future(6) });
    const reasons = await Promise.all([a, b, c, d].map(async (r) => (await listDeliveries({ reminderId: r.id }))[0]));
    expect(reasons.map((x) => x.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(reasons.map((x) => x.reason)).toEqual(["Cancelled: the reminder was completed.", "Cancelled: the reminder was dismissed.", "Cancelled: the reminder was snoozed.", "Cancelled: the reminder was changed."]);
    expect(await cancelDeliveries(a.id, "again")).toBe(0);
  });
});

describe("/api/cron/tick", () => {
  const call = async (headers: Record<string, string> = {}) => (await import("@/app/api/cron/tick/route")).POST(jsonReq("POST", undefined, headers));

  it("does not exist unless CRON_SECRET is set", async () => {
    expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
  });

  it("refuses a missing, wrong, malformed or differently-cased secret", async () => {
    process.env.CRON_SECRET = SECRET;
    const cases: Record<string, string>[] = [{}, { authorization: "Bearer nope" }, { authorization: SECRET }, { authorization: `bearer ${SECRET}` }, { authorization: `Bearer ${SECRET}x` }, { authorization: `Bearer x${SECRET}` }, { authorization: "Bearer " }];
    for (const h of cases) {
      const res = await call(h);
      expect(res.status, JSON.stringify(h)).toBe(401);
      expect(await res.text()).toBe("Unauthorized");
    }
  });

  it("only POST exists, and a short secret is rejected at startup", async () => {
    const route = await import("@/app/api/cron/tick/route");
    expect(Object.keys(route).filter((k) => ["GET", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    process.env.CRON_SECRET = "too-short";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/at least 32 characters/);
  });

  it("with the secret it runs one pass, answers with counts only, and a second pass changes nothing", async () => {
    process.env.CRON_SECRET = SECRET;
    const r = await createReminder({ memoryId: JOB, title: "Due long ago but within expiry", dueAt: new Date(Date.now() - 60_000).toISOString(), kind: "deadline" });
    const first = await (await call({ authorization: `Bearer ${SECRET}` })).json();
    expect(first).toMatchObject({ ok: true, queued: expect.any(Number), sent: expect.any(Number) });
    expect(Object.keys(first).sort()).toEqual(["briefings", "failed", "held", "ok", "queued", "retried", "sent", "skipped"]); // counts, never content
    const rows = await listDeliveries({ reminderId: r.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "in_app", status: "sent" });
    const second = await (await call({ authorization: `Bearer ${SECRET}` })).json();
    expect(second).toMatchObject({ queued: 0, sent: 0 });
    expect(await listDeliveries({ reminderId: r.id })).toHaveLength(1);
  });

  it("can't be made to send real email in a test: the provider is off, and a stubbed network would throw", async () => {
    const { getEmailProvider, emailStatus } = await import("@/lib/notify/providers");
    expect(getEmailProvider()).toBeNull();
    expect(emailStatus().reason).toMatch(/EMAIL_PROVIDER=none/);
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_API_KEY = "k";
    process.env.EMAIL_FROM = "Acorn <a@example.com>";
    expect(getEmailProvider()).toBeNull(); // still off: real sending is a second switch
    expect(emailStatus().reason).toMatch(/NOTIFICATIONS_ENABLE_SENDING/);
    process.env.NOTIFICATIONS_ENABLE_SENDING = "true";
    expect(getEmailProvider()?.name).toBe("resend");
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.NOTIFICATIONS_ENABLE_SENDING;
  });

  it("the Resend request has the documented shape and classifies failures (stubbed network)", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_API_KEY = "re_SECRET";
    process.env.EMAIL_FROM = "Acorn <a@example.com>";
    process.env.NOTIFICATIONS_ENABLE_SENDING = "true";
    const { getEmailProvider } = await import("@/lib/notify/providers");
    const calls: { url: string; init: RequestInit }[] = [];
    const respond = (status: number) => vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ id: "em_1" }), { status })));
    vi.stubGlobal("fetch", respond(200));
    const p = getEmailProvider()!;
    expect(await p.send("me@example.com", "Hi", "Body")).toEqual({ ok: true, id: "em_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_SECRET");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ from: "Acorn <a@example.com>", to: ["me@example.com"], subject: "Hi", text: "Body" });
    vi.stubGlobal("fetch", respond(503));
    expect(await p.send("me@example.com", "Hi", "Body")).toMatchObject({ ok: false, retryable: true });
    vi.stubGlobal("fetch", respond(429));
    expect(await p.send("me@example.com", "Hi", "Body")).toMatchObject({ ok: false, retryable: true });
    vi.stubGlobal("fetch", respond(422));
    const bad = await p.send("me@example.com", "Hi", "Body");
    expect(bad).toMatchObject({ ok: false, retryable: false });
    expect(JSON.stringify(bad)).not.toContain("re_SECRET");
    vi.stubGlobal("fetch", () => {
      throw new Error("a test tried to use the network");
    });
    expect(await p.send("me@example.com", "Hi", "Body")).toMatchObject({ ok: false, retryable: true, error: "Could not reach the email service." });
    for (const k of ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "NOTIFICATIONS_ENABLE_SENDING"]) delete process.env[k];
  });
});

describe("preferences, inbox, briefing and follow-through routes", () => {
  it("saves settings, validates them, and never half-saves quiet hours", async () => {
    const route = await import("@/app/api/notifications/preferences/route");
    const put = (body: unknown) => route.PUT(jsonReq("PUT", body));
    const ok = await (await put({ timezone: "Asia/Kolkata", quietStart: "22:00", quietEnd: "07:00", maxPerDay: 4, email: true, briefingEnabled: true, briefingHour: 7 })).json();
    expect(ok.preferences).toMatchObject({ timezone: "Asia/Kolkata", quietStart: "22:00", quietEnd: "07:00", maxPerDay: 4, email: true, briefingEnabled: true, briefingHour: 7 });
    expect(ok.email.configured).toBe(false); // email is wanted, but not set up here: the settings page says so
    expect((await put({ timezone: "Mars/Base" })).status).toBe(400);
    expect((await put({ quietStart: "21:00" })).status).toBe(200); // the pair stays valid because only the start moved
    expect((await put({ quietStart: null })).status).toBe(400); // clearing one half alone is refused
    expect((await put({ quietStart: null, quietEnd: null })).status).toBe(200);
    expect((await put({ quietStart: "25:99" })).status).toBe(400);
    expect((await put({ maxPerDay: 0 })).status).toBe(400);
    expect((await put({ maxPerDay: 51 })).status).toBe(400);
    expect((await put({ enabled: "yes" })).status).toBe(400);
    expect((await put({ snoozedSuggestions: { x: "y" } })).status).toBe(400); // not settable from here
    expect((await put({ surprise: 1 })).status).toBe(400);
    expect((await (await route.GET()).json()).preferences.maxPerDay).toBe(4);
  });

  it("the inbox lists in-app notifications and marks them read", async () => {
    const route = await import("@/app/api/notifications/route");
    const before = await (await route.GET(new Request("http://x/api/notifications"))).json();
    expect(before.deliveries.length).toBeGreaterThan(0);
    expect(before.unread).toBeGreaterThan(0);
    const mark = await route.PATCH(jsonReq("PATCH", { op: "read", ids: "all" }));
    expect((await mark.json()).changed).toBeGreaterThan(0);
    expect((await (await route.GET(new Request("http://x/api/notifications"))).json()).unread).toBe(0);
    expect((await route.PATCH(jsonReq("PATCH", { op: "read", ids: [] }))).status).toBe(400);
    expect((await route.PATCH(jsonReq("PATCH", { op: "delete", ids: "all" }))).status).toBe(400);
  });

  it("the briefing and suggestions are computed on request, and 'not now' hides one suggestion for two weeks", async () => {
    const brief = await (await (await import("@/app/api/briefing/route")).GET()).json();
    expect(brief.briefing.kind).toBe("briefing");
    expect(typeof brief.isEmpty).toBe("boolean");
    const ft = await import("@/app/api/followthrough/route");
    const first = await (await ft.GET()).json();
    if (first.suggestions.length) {
      const key = first.suggestions[0].key as string;
      const res = await (await ft.POST(jsonReq("POST", { op: "hide", key }))).json();
      expect(Date.parse(res.hiddenUntil) - Date.now()).toBeGreaterThan(13 * 86_400_000);
      expect((await (await ft.GET()).json()).suggestions.map((s: { key: string }) => s.key)).not.toContain(key);
    }
    expect((await ft.POST(jsonReq("POST", { op: "rewrite", key: "x" }))).status).toBe(400);
    expect((await ft.POST(jsonReq("POST", { op: "hide" }))).status).toBe(400);
  });
});
