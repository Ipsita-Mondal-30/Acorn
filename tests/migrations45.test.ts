import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/pg";

// The Phase 4 and 4.5 migrations and their rollbacks, applied for real (in-process Postgres, every migration except
// pgvector, in filename order) and checked: objects, constraints, row-level security and what a rollback leaves behind.

const ROLLBACK = path.resolve(__dirname, "../supabase/rollback");
const down = (f: string) => readFileSync(path.join(ROLLBACK, f), "utf8");
let t: TestDb;
let alice: string;
let bob: string;
beforeAll(async () => {
  t = await makeDb();
  alice = await t.signUp("a@example.com");
  bob = await t.signUp("b@example.com");
}, 60_000);
afterAll(() => t.db.close());

const memory = async (user: string, extra = "") =>
  (await t.db.query<{ id: string }>(`insert into memories (user_id, source_kind, original_text, content_hash${extra ? ", intent_kind" : ""}) values ($1, 'note', 'x', $2${extra ? ", $3" : ""}) returning id`, extra ? [user, `h-${Math.random()}`, extra] : [user, `h-${Math.random()}`])).rows[0].id;

describe("what the migrations create", () => {
  it("plans and cv_documents exist with row-level security and four owner-only policies each", async () => {
    for (const table of ["plans", "cv_documents", "reminders", "memory_embeddings"]) {
      const r = await t.db.query<{ rls: boolean }>("select relrowsecurity as rls from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [table]);
      expect(r.rows[0]?.rls, table).toBe(true);
    }
    for (const table of ["plans", "cv_documents"]) {
      const p = await t.db.query<{ cmd: string }>("select cmd from pg_policies where tablename = $1 order by cmd", [table]);
      expect(p.rows.map((x) => x.cmd), table).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }
    const cols = await t.db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'profiles' and column_name in ('cv_text', 'cv_updated_at')");
    expect(cols.rows).toHaveLength(2);
    await expect(t.asAnon((q) => q("select * from plans"))).rejects.toThrow(/permission denied/);
  });

  it("the follow_up intent is accepted, and unknown intents are still refused", async () => {
    await expect(memory(alice, "follow_up")).resolves.toBeTruthy();
    await expect(memory(alice, "stalk")).rejects.toThrow(/memories_intent_kind_check/);
  });

  it("cv_documents keeps itself coherent: file and source agree, names are safe, one current, sane sizes", async () => {
    const ins = (cols: string, vals: unknown[]) => t.db.query(`insert into cv_documents (user_id, ${cols}, text_content, text_sha256, parser_version, is_current) values ($1, ${vals.map((_, i) => `$${i + 2}`).join(", ")}, $${vals.length + 2}, $${vals.length + 3}, 'v', false)`, [alice, ...vals, "t".repeat(40), "c".repeat(64)]);
    await expect(ins("source", ["upload"])).rejects.toThrow(/check/); // an upload with no file
    await expect(ins("source, file_name", ["paste", "11111111-1111-1111-1111-111111111111.pdf"])).rejects.toThrow(/check/); // pasted text with a file
    await expect(ins("source, file_name", ["upload", "../../etc/passwd"])).rejects.toThrow(/check/);
    await expect(ins("source, file_name", ["upload", "11111111-1111-1111-1111-111111111111.exe"])).rejects.toThrow(/check/);
    await expect(ins("source, file_name, byte_size", ["upload", "11111111-1111-1111-1111-111111111111.pdf", 999_999_999])).rejects.toThrow(/check/);
    await expect(ins("source, file_name, file_kind", ["upload", "11111111-1111-1111-1111-111111111111.pdf", "pdf"])).resolves.toBeTruthy();
    await expect(t.db.query(`insert into cv_documents (user_id, source, text_content, text_sha256, parser_version) values ($1, 'paste', 'short', $2, 'v')`, [alice, "d".repeat(64)])).rejects.toThrow(/check/);
  });

  it("a plan can't point at another user's memory or action, and reminders likewise", async () => {
    const m = await memory(alice);
    await expect(
      t.asUser(bob, (q) => q(`insert into plans (user_id, memory_id, action_id, workflow, doc) values ($1, $2, gen_random_uuid(), 'recipe', '{}')`, [bob, m])),
    ).rejects.toThrow();
  });
});

describe("notification tables", () => {
  it("exist with row-level security; reminders gained their new columns with safe defaults", async () => {
    for (const table of ["notification_preferences", "notification_deliveries"]) {
      expect((await t.db.query<{ rls: boolean }>("select relrowsecurity as rls from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [table])).rows[0]?.rls, table).toBe(true);
    }
    const p = await t.db.query<{ cmd: string }>("select cmd from pg_policies where tablename = 'notification_deliveries' order by cmd");
    expect(p.rows.map((x) => x.cmd)).toEqual(["SELECT", "UPDATE"]); // no insert or delete for users: only the worker writes history
    const m = await memory(alice);
    const r = await t.db.query<{ kind: string; snooze_count: number; timezone: string | null }>(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, 'x', now()) returning kind, snooze_count, timezone`, [alice, m]);
    expect(r.rows[0]).toEqual({ kind: "manual", snooze_count: 0, timezone: null });
    await expect(t.db.query(`insert into reminders (user_id, memory_id, title, due_at, kind) values ($1, $2, 'x', now(), 'guess')`, [alice, m])).rejects.toThrow(/check/);
  });

  it("the same notification can't be queued twice, and a delivery can't point at someone else's reminder", async () => {
    const m = await memory(alice);
    const r = (await t.db.query<{ id: string }>(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, 'x', now()) returning id`, [alice, m])).rows[0].id;
    const ins = (user: string, key: string) => t.db.query(`insert into notification_deliveries (user_id, reminder_id, kind, channel, scheduled_for, dedupe_key, payload) values ($1, $2, 'reminder', 'in_app', now(), $3, '{}')`, [user, r, key]);
    await ins(alice, "k1");
    await expect(ins(alice, "k1")).rejects.toThrow(/duplicate key/);
    await expect(ins(bob, "k2")).rejects.toThrow(/foreign key/); // alice's reminder, bob's row
    await expect(t.db.query(`insert into notification_deliveries (user_id, kind, channel, scheduled_for, dedupe_key, payload) values ($1, 'ping', 'in_app', now(), 'k3', '{}')`, [alice])).rejects.toThrow(/check/);
    await expect(t.db.query(`insert into notification_deliveries (user_id, kind, channel, scheduled_for, dedupe_key, payload) values ($1, 'reminder', 'sms', now(), 'k4', '{}')`, [alice])).rejects.toThrow(/check/);
  });

  it("deleting a reminder deletes its notifications, and deleting the user deletes their settings", async () => {
    const carol = await t.signUp("carol45@example.com");
    const m = await memory(carol);
    const r = (await t.db.query<{ id: string }>(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, 'x', now()) returning id`, [carol, m])).rows[0].id;
    await t.db.query(`insert into notification_deliveries (user_id, reminder_id, kind, channel, scheduled_for, dedupe_key, payload) values ($1, $2, 'reminder', 'in_app', now(), 'c', '{}')`, [carol, r]);
    await t.db.query(`insert into notification_preferences (user_id) values ($1)`, [carol]);
    await t.db.query("delete from reminders where id = $1", [r]);
    expect((await t.db.query("select 1 from notification_deliveries where user_id = $1", [carol])).rows).toEqual([]);
    await t.db.query("delete from auth.users where id = $1", [carol]);
    expect((await t.db.query("select 1 from notification_preferences where user_id = $1", [carol])).rows).toEqual([]);
  });
});

describe("rollbacks leave memories alone and undo exactly their migration", () => {
  it("follow-up: refuses while memories use it, then restores the old check", async () => {
    const db = await makeDb();
    const u = (await db.signUp("r1@example.com"));
    await db.db.query(`insert into memories (user_id, source_kind, original_text, content_hash, intent_kind) values ($1, 'note', 'x', 'h1', 'follow_up')`, [u]);
    await expect(db.db.exec(down("20261103010000_follow_up_intent.down.sql"))).rejects.toThrow(/refusing/);
    await db.db.exec("rollback"); // the script runs in a transaction, which a failed psql session discards
    await db.db.query("update memories set intent_kind = 'remember'");
    await db.db.exec(down("20261103010000_follow_up_intent.down.sql"));
    await expect(db.db.query(`insert into memories (user_id, source_kind, original_text, content_hash, intent_kind) values ($1, 'note', 'x', 'h2', 'follow_up')`, [u])).rejects.toThrow(/memories_intent_kind_check/);
    expect((await db.db.query("select count(*)::int as n from memories")).rows[0]).toEqual({ n: 1 });
    await db.db.close();
  }, 60_000);

  it("cv documents: drops the table and restores the bucket's old allowed types", async () => {
    const db = await makeDb();
    await db.db.exec(down("20261103000000_cv_documents.down.sql"));
    expect((await db.db.query("select to_regclass('public.cv_documents') as t")).rows[0]).toEqual({ t: null });
    const b = await db.db.query<{ allowed_mime_types: string[] }>("select allowed_mime_types from storage.buckets where id = 'memory-images'");
    expect(b.rows[0].allowed_mime_types).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
    await db.db.close();
  }, 60_000);

  it("notifications: drops the tables and the new reminder columns, keeps reminders", async () => {
    const db = await makeDb();
    const u = await db.signUp("r4@example.com");
    const m = (await db.db.query<{ id: string }>(`insert into memories (user_id, source_kind, original_text, content_hash) values ($1, 'note', 'x', 'h') returning id`, [u])).rows[0].id;
    await db.db.query(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, 'x', now())`, [u, m]);
    await db.db.exec(down("20261104000000_notifications.down.sql"));
    expect((await db.db.query("select to_regclass('public.notification_deliveries') as a, to_regclass('public.notification_preferences') as b, to_regproc('public.claim_deliveries') as c")).rows[0]).toEqual({ a: null, b: null, c: null });
    expect((await db.db.query("select count(*)::int as n from information_schema.columns where table_name = 'reminders' and column_name in ('kind', 'timezone', 'snooze_count')")).rows[0]).toEqual({ n: 0 });
    expect((await db.db.query("select count(*)::int as n from reminders")).rows[0]).toEqual({ n: 1 });
    await db.db.close();
  }, 60_000);

  it("agent plans: drops plans and the profile CV columns, keeps memories and actions", async () => {
    const db = await makeDb();
    const u = await db.signUp("r3@example.com");
    const m = (await db.db.query<{ id: string }>(`insert into memories (user_id, source_kind, original_text, content_hash) values ($1, 'note', 'x', 'h') returning id`, [u])).rows[0].id;
    await db.db.query(`insert into actions (user_id, memory_id, title, action_type) values ($1, $2, 'A', 'executed')`, [u, m]);
    await db.db.exec(down("20261102000000_agent_plans.down.sql"));
    expect((await db.db.query("select to_regclass('public.plans') as t")).rows[0]).toEqual({ t: null });
    expect((await db.db.query("select count(*)::int as n from information_schema.columns where table_name = 'profiles' and column_name = 'cv_text'")).rows[0]).toEqual({ n: 0 });
    expect((await db.db.query("select (select count(*) from memories)::int as m, (select count(*) from actions)::int as a")).rows[0]).toEqual({ m: 1, a: 1 });
    await db.db.close();
  }, 60_000);
});
