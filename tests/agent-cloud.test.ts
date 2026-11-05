import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDb, type TestDb } from "./helpers/pg";
import { pgrestClient, type Bucket } from "./helpers/pgrest";

// Phase 4 against the real schema (every migration except pgvector) and the real store code, as two different users.
// Only "who is signed in" is faked.
let t: TestDb;
let current: string | null = null;
const storage: Bucket = new Map();

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("@/lib/supabase/user", () => ({
  currentUser: async () => (current ? { id: current, email: `${current}@example.com` } : null),
  requireUser: async () => {
    if (!current) throw new (await import("@/lib/backends/types")).AuthError();
    return { id: current, email: null };
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => pgrestClient(t, current, { storage }).client }));

const saved = { ...process.env };
let alice: string;
let bob: string;
const CV = "Asha Rao\n- Built React and TypeScript apps in production for 4 years\n- Ran A/B tests on the signup funnel";

beforeAll(async () => {
  t = await makeDb();
  alice = await t.signUp("alice@example.com");
  bob = await t.signUp("bob@example.com");
}, 60_000);
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.ACORN_MODE = "demo";
  delete process.env.ACORN_STORAGE;
  current = null;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  process.env = saved;
  await t.db.close();
});

const post = (body: unknown) => new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function aliceJobMemory() {
  current = alice;
  const { captureMemory } = await import("@/lib/process");
  const { updateMemory } = await import("@/lib/store");
  const { applyCorrection } = await import("@/lib/schema");
  const { memory } = await captureMemory({ kind: "note", text: `Acme is hiring a Staff Engineer. Requirements: React and TypeScript. Apply by Nov 12 [${randomUUID()}]` });
  const done = await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "pursue" } }, new Date()));
  return done!;
}

describe("plans, reminders and the CV are private to their owner", () => {
  it("alice's plan, action, reminder and CV are invisible to bob, and bob can't act on them", async () => {
    const memory = await aliceJobMemory();
    const { createPlan, approvePlan } = await import("@/lib/agent/executor");
    const { setCv } = await import("@/lib/store");
    await setCv(CV);
    const r = (await createPlan(memory.id))!;
    expect(r.plan.workflow).toBe("job_application");
    const plan = (await approvePlan(r.plan.id))!;
    expect(["awaiting_you", "failed", "running"]).toContain(plan.status);

    current = bob;
    const store = await import("@/lib/store");
    const rem = await import("@/lib/reminders");
    const exec = await import("@/lib/agent/executor");
    expect(await store.getPlan(plan.id)).toBeNull();
    expect(await store.listPlans()).toEqual([]);
    expect(await store.listPlans(memory.id)).toEqual([]);
    expect(await store.getCv()).toBeNull();
    expect(await store.listReminders()).toEqual([]);
    expect(await store.getAction(plan.actionId)).toBeNull();
    expect(await exec.approvePlan(plan.id)).toBeNull();
    expect(await exec.rejectPlan(plan.id, "x")).toBeNull();
    expect(await exec.approveReview(plan.id, "s4")).toBeNull();
    expect(await exec.completeUserStep(plan.id, "s9", "I did this myself, honest")).toBeNull();
    expect(await exec.createPlan(memory.id)).toBeNull(); // bob can't even see the memory
    await expect(rem.createReminder({ memoryId: memory.id, title: "x", dueAt: new Date(Date.now() + 1e8).toISOString() })).rejects.toThrow(/doesn't exist/);

    // bob writes his own CV: it never touches alice's
    await store.setCv("Bob's CV text, long enough to be a CV.");
    current = alice;
    expect((await store.getCv())!.text).toBe(CV);

    // and the plan is untouched
    expect((await store.getPlan(plan.id))!.status).toBe(plan.status);
  });

  it("a tool can't read another user's memory even if a plan names its id", async () => {
    const memory = await aliceJobMemory();
    current = bob;
    const { runTool } = await import("@/lib/agent/tools");
    const { makeIO } = await import("@/lib/agent/executor");
    const c = { io: makeIO(new Date()), plan: { id: "p", memoryId: memory.id, actionId: "a", memoryIds: [memory.id] }, stepId: "s1" };
    await expect(runTool(c, "retrieve_memory", { memoryId: memory.id }, { stepPermissions: ["memory:read"], approved: ["memory:read"] })).rejects.toThrow(/could not be found/);
    const found = await runTool(c, "search_memories", { query: "Acme React TypeScript" }, { stepPermissions: ["memory:read"], approved: ["memory:read"] });
    expect(found.output.results).toEqual([]);
  });

  it("the database refuses a plan or reminder that points at someone else's memory or action", async () => {
    const memory = await aliceJobMemory();
    const actionId = (await t.db.query<{ id: string }>("select id from actions limit 1")).rows[0]?.id;
    await expect(
      t.asUser(bob, (q) => q(`insert into plans (user_id, memory_id, action_id, workflow, doc) values ($1, $2, $3, 'recipe', '{}')`, [bob, memory.id, actionId ?? randomUUID()])),
    ).rejects.toThrow();
    await expect(t.asUser(bob, (q) => q(`insert into plans (user_id, memory_id, action_id, workflow, doc) values ($1, $2, $3, 'recipe', '{}')`, [alice, memory.id, actionId ?? randomUUID()]))).rejects.toThrow(/row-level security/);
    await expect(t.asUser(bob, (q) => q(`update profiles set cv_text = 'x' where id = $1`, [alice]))).resolves.toMatchObject({ affectedRows: 0 });
    expect((await t.asUser(bob, (q) => q("select cv_text from profiles where id = $1", [alice]))).rows).toEqual([]);
    await expect(t.asAnon((q) => q("select * from plans"))).rejects.toThrow(/permission denied/);
  });

  it("an action that belongs to a plan can't be approved or completed through the actions API", async () => {
    const memory = await aliceJobMemory();
    current = alice;
    const { createPlan } = await import("@/lib/agent/executor");
    const { plan } = (await createPlan(memory.id))!;
    const { PATCH } = await import("@/app/api/actions/route");
    const patch = (body: unknown) => PATCH(new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    for (const body of [{ id: plan.actionId, to: "approved" }, { id: plan.actionId, to: "cancelled" }, { id: plan.actionId, kind: "simulated" }]) {
      const res = await patch(body);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/run by a plan/);
    }
    const { getAction } = await import("@/lib/store");
    expect((await getAction(plan.actionId))!.state).toBe("awaiting_approval");
  });

  it("signed-out requests to the new routes get 401", async () => {
    current = null;
    const plans = await import("@/app/api/plans/route");
    const one = await import("@/app/api/plans/[id]/route");
    const cv = await import("@/app/api/cv/route");
    const rems = await import("@/app/api/reminders/route");
    const rem = await import("@/app/api/reminders/[id]/route");
    const id = randomUUID();
    const statuses = await Promise.all([
      plans.GET(new Request("http://x/api/plans")).then((r) => r.status),
      plans.POST(post({ memoryId: id })).then((r) => r.status),
      one.GET(new Request("http://x"), ctx(id)).then((r) => r.status),
      one.POST(post({ op: "approve" }), ctx(id)).then((r) => r.status),
      cv.GET().then((r) => r.status),
      cv.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ text: "x".repeat(30) }) })).then((r) => r.status),
      rems.GET(new Request("http://x/api/reminders")).then((r) => r.status),
      rems.POST(post({ memoryId: id, title: "x", dueAt: new Date().toISOString() })).then((r) => r.status),
      rem.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ op: "done" }) }), ctx(id)).then((r) => r.status),
    ]);
    expect(statuses).toEqual(Array(9).fill(401));
  });

  it("the plan routes validate input and answer 404 for a plan that isn't yours", async () => {
    current = bob;
    const one = await import("@/app/api/plans/[id]/route");
    const id = randomUUID();
    expect((await one.POST(post({ op: "approve" }), ctx(id))).status).toBe(404);
    expect((await one.POST(post({ op: "hack" }), ctx(id))).status).toBe(400);
    expect((await one.POST(post({ op: "approve", extra: 1 }), ctx(id))).status).toBe(400);
    expect((await one.POST(post({ op: "set", stepId: "s4", field: "title", value: "x" }), ctx(id))).status).toBe(400);
    const plans = await import("@/app/api/plans/route");
    expect((await plans.POST(post({ memoryId: randomUUID() }))).status).toBe(404);
  });

  it("reminders: filters by status for the signed-in user only", async () => {
    const memory = await aliceJobMemory();
    const rem = await import("@/lib/reminders");
    const store = await import("@/lib/store");
    current = alice;
    const r = await rem.createReminder({ memoryId: memory.id, title: "Mine", dueAt: new Date(Date.now() + 1e8).toISOString() });
    await rem.completeReminder(r.id);
    expect((await store.listReminders({ status: ["done"] })).map((x) => x.id)).toContain(r.id);
    expect((await store.listReminders({ status: ["scheduled"] })).map((x) => x.id)).not.toContain(r.id);
    current = bob;
    expect(await store.listReminders({ status: ["done"] })).toEqual([]);
    expect(await rem.completeReminder(r.id)).toBeNull();
    expect(await rem.editReminder(r.id, { title: "stolen" })).toBeNull();
  });
});

describe("CVs and plans persist correctly and stay private (real store code over the real schema)", () => {
  const fx = async (n: string) => new Uint8Array((await import("node:fs")).readFileSync((await import("node:path")).resolve(__dirname, "fixtures", n)));

  it("an uploaded CV survives a fresh store, keeps its original file in the owner's folder, and keeps history on replacement", async () => {
    current = alice;
    const { uploadCv } = await import("@/lib/cv/service");
    const { readUpload } = await import("@/lib/uploads");
    const { supabaseStore } = await import("@/lib/backends/supabase");
    const bytes = await fx("cv-sample.docx");
    const { cv } = await uploadCv(bytes, "Asha CV.docx");

    const fresh = supabaseStore(pgrestClient(t, alice, { storage }).client, alice); // a brand new store instance
    const got = (await fresh.getCvDocument())!;
    expect(got).toMatchObject({ id: cv.id, source: "upload", fileKind: "docx", originalName: "Asha CV.docx", readable: true, isCurrent: true });
    expect(got.text).toBe(cv.text);
    expect(got.parsed.experience).toHaveLength(2);
    expect([...storage.keys()].some((k) => k === `${alice}/${cv.fileName}`)).toBe(true); // private bucket, owner's folder
    expect(new Uint8Array((await readUpload(cv.fileName!))!.bytes)).toEqual(bytes);

    const { cv: next } = await uploadCv(await fx("cv-sample.pdf"), "cv.pdf");
    const all = await fresh.listCvDocuments();
    expect(all.slice(0, 2).map((d) => [d.id, d.isCurrent])).toEqual([[next.id, true], [cv.id, false]]);
    expect(all.filter((d) => d.isCurrent)).toHaveLength(1); // one current, whatever the history
    expect(all[1].replacedAt).toBeTruthy();
    expect(await readUpload(cv.fileName!)).not.toBeNull(); // the old original is still there

    // the database allows only one current CV per user
    await expect(
      t.db.query(`insert into cv_documents (user_id, source, text_content, text_sha256, parser_version, is_current) values ($1, 'paste', $2, $3, 'x', true)`, [alice, "x".repeat(30), "a".repeat(64)]),
    ).rejects.toThrow(/cv_documents_one_current_idx|duplicate key/);
  });

  it("another user can't see the CV, read its file, or change it", async () => {
    current = alice;
    const { getCvDocument } = await import("@/lib/store");
    const mine = (await getCvDocument())!;
    const dave = await t.signUp("dave@example.com"); // a user who never gave Acorn a CV
    current = dave;
    const { readUpload } = await import("@/lib/uploads");
    const { getCvDocument: bobCv, listCvDocuments, updateCvDocument, deleteCvDocuments } = await import("@/lib/store");
    expect(await bobCv()).toBeNull();
    expect(await listCvDocuments()).toEqual([]);
    expect(await readUpload(mine.fileName!)).toBeNull(); // his own folder has no such file
    expect(await updateCvDocument(mine.id, (d) => ({ ...d, readable: false }))).toBeNull();
    expect(await deleteCvDocuments()).toEqual({ versions: 0, files: [] });
    const row = await t.asUser(dave, (q) => q("update cv_documents set readable = false where id = $1", [mine.id]));
    expect(row.affectedRows).toBe(0);
    expect((await t.asUser(dave, (q) => q("select id from cv_documents"))).rows).toEqual([]);
    await expect(t.asAnon((q) => q("select * from cv_documents"))).rejects.toThrow(/permission denied/);
    current = alice;
    expect((await getCvDocument())!.readable).toBe(true); // untouched
  });

  it("a plan, with all its step outputs, persists exactly and concurrent updates are not lost", async () => {
    current = alice;
    const memory = await aliceJobMemory();
    const { createPlan, approvePlan } = await import("@/lib/agent/executor");
    const { supabaseStore } = await import("@/lib/backends/supabase");
    const r = (await createPlan(memory.id))!;
    const done = (await approvePlan(r.plan.id))!;
    const fresh = supabaseStore(pgrestClient(t, alice, { storage }).client, alice);
    expect(await fresh.getPlan(done.id)).toEqual(done);
    expect(done.steps.find((s) => s.id === "s1")!.output).toBeTruthy(); // step outputs are saved with the plan

    const a = fresh.mutatePlan(done.id, (p) => ({ ...p, history: [...p.history, { at: new Date().toISOString(), event: "concurrent-a" }] }));
    const b = fresh.mutatePlan(done.id, (p) => ({ ...p, history: [...p.history, { at: new Date().toISOString(), event: "concurrent-b" }] }));
    await Promise.all([a, b]);
    const events = (await fresh.getPlan(done.id))!.history.map((h) => h.event);
    expect(events).toEqual(expect.arrayContaining(["concurrent-a", "concurrent-b"]));
  });

  it("deleting a memory removes its plans and reminders; deleting the user removes the CV rows", async () => {
    current = alice;
    const memory = await aliceJobMemory();
    const { createPlan } = await import("@/lib/agent/executor");
    const { removeMemory } = await import("@/lib/process");
    const { listPlans } = await import("@/lib/store");
    await createPlan(memory.id);
    expect((await listPlans(memory.id)).length).toBe(1);
    await removeMemory(memory.id);
    expect(await listPlans(memory.id)).toEqual([]);
    const carol = await t.signUp("carol@example.com");
    await t.db.query(`insert into cv_documents (user_id, source, text_content, text_sha256, parser_version) values ($1, 'paste', $2, $3, 'x')`, [carol, "y".repeat(30), "b".repeat(64)]);
    await t.db.query("delete from auth.users where id = $1", [carol]);
    expect((await t.db.query("select id from cv_documents where user_id = $1", [carol])).rows).toEqual([]);
  });
});

describe("Phase 5 routes in cloud mode", () => {
  it("signed-out requests to the notification routes get 401, and the scheduler endpoint needs its own secret", async () => {
    current = null;
    const prefs = await import("@/app/api/notifications/preferences/route");
    const inbox = await import("@/app/api/notifications/route");
    const brief = await import("@/app/api/briefing/route");
    const ft = await import("@/app/api/followthrough/route");
    const put = (body: unknown) => new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const statuses = await Promise.all([
      prefs.GET().then((r) => r.status),
      prefs.PUT(put({ enabled: false })).then((r) => r.status),
      inbox.GET(new Request("http://x/api/notifications")).then((r) => r.status),
      inbox.PATCH(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read", ids: "all" }) })).then((r) => r.status),
      brief.GET().then((r) => r.status),
      ft.GET().then((r) => r.status),
      ft.POST(post({ op: "hide", key: "x" })).then((r) => r.status),
    ]);
    expect(statuses).toEqual(Array(7).fill(401));

    // the scheduler endpoint is not a user endpoint: a user's session is useless to it
    const tick = await import("@/app/api/cron/tick/route");
    current = alice;
    process.env.CRON_SECRET = "c".repeat(40);
    expect((await tick.POST(new Request("http://x", { method: "POST" }))).status).toBe(401);
    expect((await tick.POST(new Request("http://x", { method: "POST", headers: { authorization: "Bearer " + "c".repeat(39) } }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await tick.POST(new Request("http://x", { method: "POST" }))).status).toBe(404);
  });

  it("settings and the inbox are private to the user", async () => {
    const { supabaseStore } = await import("@/lib/backends/supabase");
    const a = supabaseStore(pgrestClient(t, alice).client, alice);
    const b = supabaseStore(pgrestClient(t, bob).client, bob);
    await a.setPrefs({ maxPerDay: 3, quietStart: "21:00", quietEnd: "06:00" });
    expect((await b.getPrefs()).maxPerDay).not.toBe(3);
    expect(await b.listDeliveries()).toEqual([]);
    current = bob;
    const prefs = await import("@/app/api/notifications/preferences/route");
    const res = await prefs.PUT(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPerDay: 7 }) }));
    expect(res.status).toBe(200);
    expect((await a.getPrefs()).maxPerDay).toBe(3); // alice's untouched
    expect((await b.getPrefs()).maxPerDay).toBe(7);
  });
});
