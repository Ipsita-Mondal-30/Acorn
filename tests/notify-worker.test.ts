import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Reminder } from "@/lib/agent/schema";
import { localBackend, localWorkerStore } from "@/lib/backends/local";
import { supabaseStore } from "@/lib/backends/supabase";
import type { Store } from "@/lib/backends/types";
import type { EmailProvider, SendResult } from "@/lib/notify/providers";
import { supabaseWorkerStore } from "@/lib/notify/supabase-worker";
import type { Delivery } from "@/lib/notify/types";
import { tick, type WorkerStore } from "@/lib/notify/worker";
import { buildSeed } from "@/lib/seed";
import { hashContent } from "@/lib/store";
import type { Memory } from "@/lib/schema";
import { makeDb, type TestDb } from "./helpers/pg";
import { pgrestClient } from "./helpers/pgrest";

// The scheduled worker, run against BOTH stores (the local demo file and Supabase's schema in-process) with the same
// tests. Email is a recorder: nothing here can send a real message, and the real provider is blocked by a stub fetch.

const saved = { ...process.env };
let dir: string;
let t: TestDb;
let alice: string;
let bob: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-worker-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.NOTIFY_LOCAL_EMAIL = "local@example.com";
  vi.stubGlobal("fetch", () => {
    throw new Error("a test tried to use the network");
  });
  t = await makeDb();
  alice = await t.signUp("alice@example.com");
  bob = await t.signUp("bob@example.com");
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  process.env = saved;
  await t.db.close();
  await rm(dir, { recursive: true, force: true });
});

class Mail implements EmailProvider {
  name = "recorder";
  sent: { to: string; subject: string; text: string }[] = [];
  keys: (string | undefined)[] = [];
  attempts = 0;
  private done = new Set<string>();
  constructor(private plan: SendResult[] = []) {}
  async send(to: string, subject: string, text: string, idempotencyKey?: string): Promise<SendResult> {
    this.attempts++;
    this.keys.push(idempotencyKey);
    // like the real provider (Resend): a repeated Idempotency-Key does not send a second email
    if (idempotencyKey && this.done.has(idempotencyKey)) return { ok: true, id: `dup-${this.attempts}` };
    const next = this.plan.shift() ?? { ok: true as const, id: `m${this.attempts}` };
    if (next.ok) {
      this.sent.push({ to, subject, text });
      if (idempotencyKey) this.done.add(idempotencyKey);
    }
    return next;
  }
}

type Harness = {
  name: string;
  worker: WorkerStore;
  /** the user-bound store for a user (what the app uses) */
  store(user: string): Store;
  users: string[];
  email(user: string): string;
};

const harnesses: Harness[] = [
  { name: "local store", worker: localWorkerStore, store: () => localBackend.store, users: ["local"], email: () => "local@example.com" },
  {
    name: "Supabase schema",
    worker: supabaseWorkerStore(pgrestClient(null as never, null, { service: true }).client, async () => null),
    store: (u) => supabaseStore(pgrestClient(t, u).client, u),
    users: [] as string[],
    email: (u) => `${u}@example.com`,
  },
];

const mem = (title: string, over: Partial<Memory> = {}): Memory => {
  const m = structuredClone(buildSeed(new Date()).memories.find((x) => x.id === "sample-job-lumen")!);
  const id = randomUUID();
  return { ...m, id, contentHash: hashContent("w", id), isSample: false, overrides: { title, deadline: null }, userIntent: { kind: "pursue", status: "confirmed", at: new Date().toISOString() }, ...over };
};
const reminder = (memoryId: string, dueAt: Date, over: Partial<Reminder> = {}): Reminder => ({
  id: randomUUID(), memoryId, actionId: null, title: "Apply to Lumen", note: "", dueAt: dueAt.toISOString(), kind: "intent", timezone: "Asia/Kolkata", snoozeCount: 0,
  status: "scheduled", history: [{ at: new Date().toISOString(), status: "scheduled" }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});
const NOW = new Date("2026-11-05T10:00:00Z"); // 15:30 in Kolkata
const min = (n: number) => new Date(NOW.getTime() + n * 60_000);
const hours = (n: number) => min(n * 60);

describe.each(harnesses)("scheduled worker: $name", (h) => {
  // each test gets its own user so state never leaks between tests
  const fresh = async () => {
    let user: string;
    let worker = h.worker;
    if (h.name === "local store") {
      // a fresh data directory per test: no reminders, deliveries or settings carry over
      process.env.ACORN_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "acorn-worker-t-"));
      await localBackend.store.setPrefs({ timezone: "Asia/Kolkata" });
      user = "local";
    } else {
      user = await t.signUp(`u-${randomUUID()}@example.com`);
      await h.store(user).setPrefs({ timezone: "Asia/Kolkata" });
      const emails = new Map([[user, `${user}@example.com`]]);
      worker = supabaseWorkerStore(pgrestClient(t, null, { service: true }).client, async (id) => emails.get(id) ?? null);
    }
    const store = h.store(user);
    const memory = (await store.insertMemory(mem("Frontend Engineer at Lumen"))).memory;
    return { user, store, worker, memory, prefs: store.setPrefs.bind(store) };
  };
  const run = (w: WorkerStore, at: Date, email: EmailProvider | null = null) => tick(w, { email, baseUrl: "https://acorn.example" }, at);
  const log = async (store: Store, rid?: string) => (await store.listDeliveries({ reminderId: rid, limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  it("queues and delivers an in-app notification with the memory's context, once", async () => {
    const { store, worker, memory } = await fresh();
    const r = await store.upsertReminder(reminder(memory.id, min(-1)));
    const s = await run(worker, NOW);
    expect(s).toMatchObject({ queued: 1, sent: 1 });
    const [d] = await log(store, r.id);
    expect(d).toMatchObject({ channel: "in_app", status: "sent", kind: "reminder", dueAt: r.dueAt, readAt: null });
    expect(d.payload.kind).toBe("job");
    expect(d.payload.title).toBe("Apply to Lumen");
    expect(d.payload.lines.join(" ")).toMatch(/Lumen Robotics/);
    expect(d.payload.links[0]).toEqual({ label: "Original memory", href: `/memories/${memory.id}` });
    expect(await store.listDeliveries({ unreadOnly: true })).toHaveLength(1);
    expect(await store.markDeliveriesRead([d.id], NOW)).toBe(1);
    expect(await store.markDeliveriesRead("all", NOW)).toBe(0);
    expect((await store.listDeliveries({ unreadOnly: true })).length).toBe(0);
  });

  it("is idempotent: running again, or three runs at once, never doubles a notification", async () => {
    const { store, worker, memory } = await fresh();
    const r = await store.upsertReminder(reminder(memory.id, min(-1)));
    await run(worker, NOW);
    await run(worker, min(1));
    await Promise.all([run(worker, min(2)), run(worker, min(2)), run(worker, min(2))]);
    expect(await log(store, r.id)).toHaveLength(1);
  });

  it("does nothing for a reminder that isn't due, and ignores done and dismissed ones", async () => {
    const { store, worker, memory } = await fresh();
    await store.upsertReminder(reminder(memory.id, min(30)));
    await store.upsertReminder(reminder(memory.id, min(-5), { status: "done" }));
    await store.upsertReminder(reminder(memory.id, min(-5), { status: "dismissed" }));
    expect(await run(worker, NOW)).toMatchObject({ queued: 0, sent: 0, skipped: 0 });
    expect(await log(store)).toEqual([]);
  });

  it("holds during quiet hours, goes out when they end, and says why in the meantime", async () => {
    const { store, worker, memory, prefs } = await fresh();
    await prefs({ quietStart: "15:00", quietEnd: "16:00" }); // 15:30 now: inside
    const r = await store.upsertReminder(reminder(memory.id, min(-1)));
    const s1 = await run(worker, NOW);
    expect(s1).toMatchObject({ queued: 1, sent: 0, held: 1 });
    const [held] = await log(store, r.id);
    expect(held).toMatchObject({ status: "pending", scheduledFor: "2026-11-05T10:30:00.000Z" });
    expect(held.reason).toMatch(/quiet hours/i);
    expect(await run(worker, min(20))).toMatchObject({ sent: 0 }); // 15:50 still quiet
    await run(worker, min(31)); // 16:01
    expect((await log(store, r.id))[0]).toMatchObject({ status: "sent" });
  });

  it("enforces the daily limit without dropping anything: the rest goes out the next local day", async () => {
    const { store, worker, memory, prefs } = await fresh();
    await prefs({ maxPerDay: 2 });
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await store.upsertReminder(reminder(memory.id, min(-10 + i), { title: `R${i}` })));
    await run(worker, NOW);
    await run(worker, min(1)); // a second pass sees the earlier ones as sent
    const all = await log(store);
    expect(all.filter((d) => d.status === "sent")).toHaveLength(2);
    expect(all.filter((d) => d.status === "pending" && /limit of 2/.test(d.reason ?? ""))).toHaveLength(2);
    const later = new Date("2026-11-05T18:31:00Z"); // 00:01 on 6 Nov in Kolkata
    await run(worker, later);
    expect((await log(store)).filter((d) => d.status === "sent")).toHaveLength(4);
  });

  it("doesn't announce a reminder that was already stale, but records why", async () => {
    const { store, worker, memory } = await fresh();
    const r = await store.upsertReminder(reminder(memory.id, hours(-100)));
    expect(await run(worker, NOW)).toMatchObject({ queued: 0, skipped: 1, sent: 0 });
    const [d] = await log(store, r.id);
    expect(d).toMatchObject({ status: "skipped" });
    expect(d.reason).toMatch(/Expired/);
    expect((await store.getReminder(r.id))!.status).toBe("scheduled"); // still there, shown as overdue
    expect(await run(worker, min(5))).toMatchObject({ skipped: 0 }); // not evaluated again
  });

  it("respects the master switch and each channel, recording a reason instead of silently doing nothing", async () => {
    const { store, worker, memory, prefs } = await fresh();
    await prefs({ enabled: false });
    const r1 = await store.upsertReminder(reminder(memory.id, min(-1)));
    expect(await run(worker, NOW)).toMatchObject({ sent: 0, skipped: 1 });
    expect((await log(store, r1.id))[0].reason).toMatch(/switched off/);
    await prefs({ enabled: true, inApp: false, email: false });
    const r2 = await store.upsertReminder(reminder(memory.id, min(-1), { title: "second" }));
    await run(worker, NOW);
    expect((await log(store, r2.id))[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/No notification channel/) });
  });

  it("cancels a queued notification when the reminder is dismissed, completed or rescheduled before it goes out", async () => {
    const { store, worker, memory, prefs } = await fresh();
    await prefs({ quietStart: "15:00", quietEnd: "16:00" });
    const a = await store.upsertReminder(reminder(memory.id, min(-1), { title: "a" }));
    const b = await store.upsertReminder(reminder(memory.id, min(-1), { title: "b" }));
    await run(worker, NOW); // both held
    await store.mutateReminder(a.id, (r) => ({ ...r, status: "dismissed" })); // changed behind the worker's back: it must notice
    await store.mutateReminder(b.id, (r) => ({ ...r, dueAt: hours(48).toISOString() }));
    await run(worker, min(40));
    expect((await log(store, a.id))[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Cancelled/) });
    expect((await log(store, b.id))[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Cancelled/) });
    expect(await store.cancelDeliveries(a.id, "x")).toBe(0); // nothing pending is left to cancel
  });

  it("a snoozed reminder is a new notification when it comes due again", async () => {
    const { store, worker, memory } = await fresh();
    const r = await store.upsertReminder(reminder(memory.id, min(-1)));
    await run(worker, NOW);
    await store.mutateReminder(r.id, (x) => ({ ...x, status: "snoozed", dueAt: hours(24).toISOString(), snoozeCount: 1 }));
    await run(worker, hours(12));
    expect(await log(store, r.id)).toHaveLength(1);
    await run(worker, hours(24.5));
    const all = await log(store, r.id);
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.status)).toEqual(["sent", "sent"]);
    expect(new Set(all.map((d) => d.dedupeKey)).size).toBe(2);
  });

  describe("email", () => {
    it("is skipped, with the reason, when no provider is set up: nothing is sent", async () => {
      const { store, worker, memory, prefs } = await fresh();
      await prefs({ email: true });
      const r = await store.upsertReminder(reminder(memory.id, min(-1)));
      await run(worker, NOW, null);
      const emailRow = (await log(store, r.id)).find((d) => d.channel === "email")!;
      expect(emailRow).toMatchObject({ status: "skipped", reason: "Email isn't set up on this server." });
    });

    it("sends once with the context and a link back, and never twice", async () => {
      const { user, store, worker, memory, prefs } = await fresh();
      await prefs({ email: true });
      const mail = new Mail();
      const r = await store.upsertReminder(reminder(memory.id, min(-1)));
      await run(worker, NOW, mail);
      await run(worker, min(1), mail);
      await run(worker, min(2), mail);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0].to).toBe(h.email(user));
      expect(mail.sent[0].subject).toBe("Reminder: Apply to Lumen");
      expect(mail.sent[0].text).toContain(`https://acorn.example/memories/${memory.id}`);
      expect(mail.sent[0].text).toContain("Settings");
      expect((await log(store, r.id)).map((d) => `${d.channel}:${d.status}`).sort()).toEqual(["email:sent", "in_app:sent"]);
    });

    it("retries with backoff after a temporary failure, then succeeds", async () => {
      const { store, worker, memory, prefs } = await fresh();
      await prefs({ email: true });
      const mail = new Mail([{ ok: false, error: "The email service refused it (HTTP 503).", retryable: true }, { ok: false, error: "timed out", retryable: true }]);
      const r = await store.upsertReminder(reminder(memory.id, min(-1)));
      expect(await run(worker, NOW, mail)).toMatchObject({ retried: 1 });
      const pending = async () => (await log(store, r.id)).find((d) => d.channel === "email")!;
      expect(await pending()).toMatchObject({ status: "pending", attempts: 1, lastError: "The email service refused it (HTTP 503).", scheduledFor: min(1).toISOString() });
      expect(await run(worker, min(0.5), mail)).toMatchObject({ retried: 0, sent: 0 }); // too early
      expect(mail.attempts).toBe(1);
      expect(await run(worker, min(1.5), mail)).toMatchObject({ retried: 1 });
      expect((await pending()).scheduledFor).toBe(min(1.5 + 5).toISOString()); // 5 minutes later
      expect(await run(worker, min(7), mail)).toMatchObject({ sent: 1 });
      expect(await pending()).toMatchObject({ status: "sent", attempts: 3, lastError: null });
      expect(mail.sent).toHaveLength(1);
      // every GENUINE retry (after a recorded failure) carries a fresh idempotency key; none is missing
      expect(mail.keys).toHaveLength(3);
      expect(mail.keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
      expect(new Set(mail.keys).size).toBe(3);
    });

    it("gives up after the last retry, and gives up at once on a refusal that will never work", async () => {
      const { store, worker, memory, prefs } = await fresh();
      await prefs({ email: true });
      const always = new Mail(Array.from({ length: 10 }, () => ({ ok: false as const, error: "down", retryable: true })));
      const r = await store.upsertReminder(reminder(memory.id, min(-1)));
      let at = NOW;
      for (let i = 0; i < 8; i++) {
        await run(worker, at, always);
        at = new Date(at.getTime() + 7 * 3_600_000);
      }
      const d = (await log(store, r.id)).find((x) => d_isEmail(x))!;
      expect(d).toMatchObject({ status: "failed", attempts: 6, lastError: "down", reason: "Gave up after repeated failures." });
      expect(always.attempts).toBe(6);

      const w2 = await fresh();
      await w2.prefs({ email: true });
      const refuse = new Mail([{ ok: false, error: "The email service refused it (HTTP 422).", retryable: false }]);
      const r2 = await w2.store.upsertReminder(reminder(w2.memory.id, min(-1)));
      expect(await run(w2.worker, NOW, refuse)).toMatchObject({ failed: 1, retried: 0 });
      expect((await log(w2.store, r2.id)).find(d_isEmail)).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("never emails during quiet hours, and a held email is sent once they end", async () => {
      const { store, worker, memory, prefs } = await fresh();
      await prefs({ email: true, quietStart: "15:00", quietEnd: "16:00" });
      const mail = new Mail();
      await store.upsertReminder(reminder(memory.id, min(-1)));
      await run(worker, NOW, mail);
      expect(mail.attempts).toBe(0);
      await run(worker, min(31), mail);
      expect(mail.sent).toHaveLength(1);
    });

    it("stops if you switch email off before it goes out", async () => {
      const { store, worker, memory, prefs } = await fresh();
      await prefs({ email: true, quietStart: "15:00", quietEnd: "16:00" });
      const mail = new Mail();
      const r = await store.upsertReminder(reminder(memory.id, min(-1)));
      await run(worker, NOW, mail);
      await prefs({ email: false });
      await run(worker, min(31), mail);
      expect(mail.attempts).toBe(0);
      expect((await log(store, r.id)).find(d_isEmail)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/switched off/) });
    });
  });

  describe("daily briefing", () => {
    const NY = "America/New_York";
    const briefed = async () => {
      const x = await fresh();
      await x.prefs({ timezone: NY, briefingEnabled: true, briefingHour: 8 });
      return x;
    };
    const briefings = async (store: Store) => (await store.listDeliveries({ kind: "briefing", limit: 50 })).filter((d) => d.channel === "in_app");

    it("is sent once per local day at the user's hour, across the daylight-saving change", async () => {
      const { store, worker, memory } = await briefed();
      await store.upsertReminder(reminder(memory.id, new Date("2026-11-01T18:00:00Z"), { title: "Call recruiter" })); // 13:00 EST, today
      expect(await run(worker, new Date("2026-11-01T12:59:00Z"))).toMatchObject({ briefings: 0 }); // 07:59 EST: too early (08:00 EST = 13:00Z)
      expect(await run(worker, new Date("2026-11-01T13:05:00Z"))).toMatchObject({ briefings: 1 });
      expect(await run(worker, new Date("2026-11-01T13:30:00Z"))).toMatchObject({ briefings: 0 }); // not twice
      const [b] = await briefings(store);
      expect(b).toMatchObject({ kind: "briefing", status: "sent", dedupeKey: "briefing:2026-11-01:in_app" });
      expect(b.payload.lines.join("\n")).toContain("Call recruiter");
      // the day before, 08:00 was EDT = 12:00Z; the next day it is 13:00Z (EST)
      await run(worker, new Date("2026-11-02T12:30:00Z")); // 07:30 EST: too early
      expect(await briefings(store)).toHaveLength(1);
      await run(worker, new Date("2026-11-02T13:10:00Z"));
      expect((await briefings(store)).map((x) => x.dedupeKey).sort()).toEqual(["briefing:2026-11-01:in_app", "briefing:2026-11-02:in_app"]);
    });

    it("is not sent late, and a quiet day gets no briefing, only a record that there was nothing to say", async () => {
      const { store, worker } = await briefed();
      expect(await run(worker, new Date("2026-11-01T21:00:00Z"))).toMatchObject({ briefings: 0 }); // 16:00 EST: 8 hours past
      expect(await briefings(store)).toEqual([]);
      expect(await run(worker, new Date("2026-11-01T13:10:00Z"))).toMatchObject({ briefings: 0, skipped: 1 });
      const [b] = await briefings(store);
      expect(b).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Nothing needed you/) });
    });

    it("is held through quiet hours and dropped if they cover the whole window", async () => {
      const a = await briefed();
      await a.prefs({ quietStart: "07:00", quietEnd: "09:00" }); // 08:00-09:00 quiet
      await a.store.upsertReminder(reminder(a.memory.id, new Date("2026-11-01T18:00:00Z")));
      await run(a.worker, new Date("2026-11-01T13:10:00Z"));
      const [held] = await briefings(a.store);
      expect(held).toMatchObject({ status: "pending", scheduledFor: "2026-11-01T14:00:00.000Z" });
      await run(a.worker, new Date("2026-11-01T14:01:00Z"));
      expect((await briefings(a.store))[0].status).toBe("sent");

      const b = await briefed();
      await b.prefs({ quietStart: "07:00", quietEnd: "16:00" }); // 9 hours: longer than the briefing is useful
      await b.store.upsertReminder(reminder(b.memory.id, new Date("2026-11-01T18:00:00Z")));
      await run(b.worker, new Date("2026-11-01T13:10:00Z"));
      await run(b.worker, new Date("2026-11-01T21:01:00Z"));
      expect((await briefings(b.store))[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Quiet hours covered/) });
    });

    it("off by default, and off means nothing is built", async () => {
      const x = await fresh();
      await x.prefs({ briefingEnabled: false });
      expect(await run(x.worker, new Date("2026-11-01T13:10:00Z"))).toMatchObject({ briefings: 0 });
      expect(await x.store.listDeliveries({ kind: "briefing" })).toEqual([]);
    });
  });
});

const d_isEmail = (d: Delivery) => d.channel === "email";

describe("user isolation (Supabase schema)", () => {
  const worker = () => {
    const emails = new Map([[alice, "alice@example.com"], [bob, "bob@example.com"]]);
    return supabaseWorkerStore(pgrestClient(t, null, { service: true }).client, async (id) => emails.get(id) ?? null);
  };
  const store = (u: string) => supabaseStore(pgrestClient(t, u).client, u);

  it("each user is notified only about their own reminders, with only their own data, and only sees their own history", async () => {
    const a = store(alice);
    const b = store(bob);
    const ma = (await a.insertMemory(mem("Alice's secret job"))).memory;
    const mb = (await b.insertMemory(mem("Bob's secret job"))).memory;
    await a.setPrefs({ timezone: "Asia/Kolkata" });
    await b.setPrefs({ timezone: "Europe/London" });
    const ra = await a.upsertReminder(reminder(ma.id, min(-1), { title: "Alice reminder" }));
    const rb = await b.upsertReminder(reminder(mb.id, min(-1), { title: "Bob reminder" }));
    await tick(worker(), { email: null, baseUrl: null }, NOW);

    const da = await a.listDeliveries();
    const db = await b.listDeliveries();
    expect(da.map((d) => d.reminderId)).toEqual([ra.id]);
    expect(db.map((d) => d.reminderId)).toEqual([rb.id]);
    expect(JSON.stringify(da)).not.toMatch(/Bob/);
    expect(JSON.stringify(db)).not.toMatch(/Alice/);
    expect(da[0].payload.links[0].href).toBe(`/memories/${ma.id}`);

    // the database itself refuses the rest
    const asBob = (sql: string, params: unknown[] = []) => t.asUser(bob, (q) => q(sql, params));
    expect((await asBob("select id from notification_deliveries")).rows).toHaveLength(1);
    expect((await asBob("update notification_deliveries set read_at = now() where id = $1", [da[0].id])).affectedRows).toBe(0);
    await expect(asBob("insert into notification_deliveries (user_id, kind, channel, scheduled_for, dedupe_key, payload) values ($1, 'reminder', 'in_app', now(), 'x', '{}')", [bob])).rejects.toThrow(/permission denied/);
    expect(await b.cancelDeliveries(ra.id, "hijack")).toBe(0);
    expect(await b.markDeliveriesRead([da[0].id], NOW)).toBe(0);
    expect((await a.listDeliveries())[0].readAt).toBeNull();
    await expect(t.asAnon((q) => q("select * from notification_deliveries"))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((q) => q("select * from notification_preferences"))).rejects.toThrow(/permission denied/);
  });

  it("a user can mark their own read and cancel a pending one, but can't rewrite what was sent or failed", async () => {
    const a = store(alice);
    const m = (await a.insertMemory(mem("Guard test"))).memory;
    await a.setPrefs({ quietStart: "15:00", quietEnd: "16:00", timezone: "Asia/Kolkata" });
    const r = await a.upsertReminder(reminder(m.id, min(-1)));
    await tick(worker(), { email: null, baseUrl: null }, NOW); // held (pending)
    const [d] = await a.listDeliveries({ reminderId: r.id });
    const mine = (sql: string, p: unknown[] = []) => t.asUser(alice, (q) => q(sql, p));
    await expect(mine("update notification_deliveries set status = 'sent' where id = $1", [d.id])).rejects.toThrow(/cancelled while it is pending/);
    await expect(mine("update notification_deliveries set payload = '{\"x\":1}' where id = $1", [d.id])).rejects.toThrow(/only read state and cancellation/);
    await expect(mine("update notification_deliveries set attempts = 9 where id = $1", [d.id])).rejects.toThrow(/only read state and cancellation/);
    expect(await a.cancelDeliveries(r.id, "I changed my mind")).toBe(1);
    expect((await a.listDeliveries({ reminderId: r.id }))[0]).toMatchObject({ status: "skipped", reason: "I changed my mind" });
    await expect(mine("update notification_deliveries set status = 'pending' where id = $1", [d.id])).rejects.toThrow(/cancelled while it is pending/);
  });

  it("two workers can never take the same delivery", async () => {
    const a = store(alice);
    const m = (await a.insertMemory(mem("Claim test"))).memory;
    await a.setPrefs({ timezone: "Asia/Kolkata", quietStart: null, quietEnd: null, enabled: true, inApp: true });
    await a.upsertReminder(reminder(m.id, min(-1)));
    // queue only (no delivery pass): use a quiet window so it stays pending, then lift it
    const w = worker();
    await a.setPrefs({ quietStart: "15:00", quietEnd: "16:00" });
    await tick(w, { email: null, baseUrl: null }, NOW);
    const key = (await a.listDeliveries()).find((d) => d.status === "pending")!;
    const c1 = await w.claimDeliveries(hours(2), 10, 300);
    const c2 = await w.claimDeliveries(hours(2), 10, 300);
    expect(c1.map((c) => c.delivery.id)).toContain(key.id);
    expect(c2.map((c) => c.delivery.id)).not.toContain(key.id); // still leased
    const c3 = await w.claimDeliveries(new Date(hours(2).getTime() + 301_000), 10, 300); // the lease expired: a crashed worker's hold is not permanent
    expect(c3.map((c) => c.delivery.id)).toContain(key.id);
  });

  it("only the service role may use the claim function", async () => {
    await expect(t.asUser(alice, (q) => q("select * from claim_deliveries(now(), 10, 60)"))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((q) => q("select * from claim_deliveries(now(), 10, 60)"))).rejects.toThrow(/permission denied/);
  });

  it("preferences are private and validated by the database", async () => {
    const a = store(alice);
    await a.setPrefs({ quietStart: "22:00", quietEnd: "07:00", maxPerDay: 5, timezone: "Asia/Kolkata", briefingEnabled: true, briefingHour: 7 });
    expect(await a.getPrefs()).toMatchObject({ quietStart: "22:00", quietEnd: "07:00", maxPerDay: 5, briefingHour: 7 });
    expect((await store(bob).getPrefs()).quietStart).toBeNull(); // bob's own (default) settings
    await expect(t.asUser(alice, (q) => q("update notification_preferences set quiet_start = '22:00', quiet_end = null"))).rejects.toThrow(/check/);
    await expect(t.asUser(alice, (q) => q("update notification_preferences set max_per_day = 500"))).rejects.toThrow(/check/);
    expect((await t.asUser(bob, (q) => q("update notification_preferences set enabled = false where user_id = $1", [alice]))).affectedRows).toBe(0);
  });
});

describe("scale and failure recovery (Supabase schema)", () => {
  const worker = (emails = new Map<string, string>()) => supabaseWorkerStore(pgrestClient(t, null, { service: true }).client, async (id) => emails.get(id) ?? null);
  const store = (u: string) => supabaseStore(pgrestClient(t, u).client, u);

  it("a long backlog of already-handled overdue reminders can't starve a new one", async () => {
    const user = await t.signUp(`backlog-${randomUUID()}@example.com`);
    const s = store(user);
    await s.setPrefs({ timezone: "Asia/Kolkata" });
    const m = (await s.insertMemory(mem("Backlog"))).memory;
    // 650 reminders, each due long ago (so older than the new one), each already announced or expired
    await t.db.query(
      `insert into reminders (id, user_id, memory_id, title, due_at, status)
       select gen_random_uuid(), $1, $2, 'old ' || g, $3::timestamptz - (g || ' hours')::interval - interval '100 hours', 'scheduled' from generate_series(1, 650) g`,
      [user, m.id, NOW.toISOString()],
    );
    await t.db.query(
      `insert into notification_deliveries (user_id, reminder_id, kind, channel, status, reason, scheduled_for, due_at, dedupe_key, payload)
       select user_id, id, 'reminder', 'in_app', 'skipped', 'Expired', now(), due_at, 'old:' || id, '{"kind":"generic","title":"old","lines":[],"links":[],"draft":null}'::jsonb from reminders where user_id = $1`,
      [user],
    );
    const fresh = await s.upsertReminder(reminder(m.id, min(-1), { title: "brand new" }));
    await tick(worker(), { email: null, baseUrl: null }, NOW);
    const d = await s.listDeliveries({ reminderId: fresh.id });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "sent" });
    // and the old ones were not announced again
    expect((await s.listDeliveries({ limit: 1000 })).filter((x) => x.status === "sent")).toHaveLength(1);
  }, 60_000);

  it("a run that dies halfway is simply finished by the next run, with no duplicates and nothing lost", async () => {
    const user = await t.signUp(`crash-${randomUUID()}@example.com`);
    const s = store(user);
    await s.setPrefs({ timezone: "Asia/Kolkata", email: true });
    const m = (await s.insertMemory(mem("Crash"))).memory;
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await s.upsertReminder(reminder(m.id, min(-5 + i), { title: `c${i}` })));
    const real = worker(new Map([[user, "x@example.com"]]));
    let calls = 0;
    const flaky: WorkerStore = { ...real, updateDelivery: async (id, patch) => (++calls === 2 ? Promise.reject(new Error("connection lost")) : real.updateDelivery(id, patch)) };
    const mail = new Mail();
    await expect(tick(flaky, { email: mail, baseUrl: null }, NOW)).rejects.toThrow(/connection lost/);
    // the next run (after the 5-minute lease on whatever was in flight has passed) finishes the job
    await tick(real, { email: mail, baseUrl: null }, hours(1));
    await tick(real, { email: mail, baseUrl: null }, hours(2));
    const all = await s.listDeliveries({ limit: 100 });
    for (const r of rs) {
      const mine = all.filter((x) => x.reminderId === r.id);
      expect(mine.map((x) => `${x.channel}:${x.status}`).sort(), r.title).toEqual(["email:sent", "in_app:sent"]);
    }
    expect(mail.sent.length).toBe(3); // each email exactly once, even though the first run died
  }, 60_000);
});
