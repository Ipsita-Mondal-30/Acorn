import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DisposablePg, findPostgres, migration, migrationFiles, ROLLBACK } from "./helpers/realpg";

// The four migrations you have not applied yet, applied for real: on a real PostgreSQL (with pgvector), on top of a database
// that already holds data in the state your project is in, using the very SQL files and verification queries from the
// activation guide. Then rolled back and applied again. SKIPPED, visibly, if PostgreSQL with pgvector isn't installed.

const pg = findPostgres();
if (!pg) console.warn("[pending-migrations] SKIPPED: no PostgreSQL with the pgvector extension found (set PGBIN).");

const PENDING = ["20261102000000_agent_plans.sql", "20261103000000_cv_documents.sql", "20261103010000_follow_up_intent.sql", "20261104000000_notifications.sql"];
const DOWN = ["20261104000000_notifications.down.sql", "20261103010000_follow_up_intent.down.sql", "20261103000000_cv_documents.down.sql", "20261102000000_agent_plans.down.sql"];
const verify = (f: string) => readFileSync(path.resolve(__dirname, "../supabase/verify", f), "utf8");
const down = (f: string) => readFileSync(path.join(ROLLBACK, f), "utf8");
const ALREADY_APPLIED = () => migrationFiles().filter((f) => f < PENDING[0]);

describe.skipIf(!pg)("the four pending migrations on a real PostgreSQL holding real-shaped data", () => {
  let db: DisposablePg;
  const DB = "prod";
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const run = (sql: string, as?: { user: string | null; role?: "authenticated" | "anon" | "service_role" }) => db.sql(sql, as ? { db: DB, as: as as never } : { db: DB });
  const counts = () => run("select (select count(*) from memories), (select count(*) from actions), (select count(*) from reminders), (select count(*) from memory_embeddings), (select count(*) from profiles)")[0].join(",");
  /** a fingerprint of the whole public schema: columns, constraints, indexes, policies, triggers, functions, bucket types */
  const signature = () =>
    run(`select md5(string_agg(x, E'\\n' order by x)) , count(*) from (
      select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public'
      union all select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
      union all select 'idx ' || indexdef from pg_indexes where schemaname = 'public'
      union all select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
      union all select 'trg ' || tgrelid::regclass || ' ' || tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'public.%'
      union all select 'fn ' || p.oid::regprocedure from pg_proc p where pronamespace = 'public'::regnamespace
      union all select 'bucket ' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'memory-images'
      union all select 'tbl ' || relname || ' rls=' || relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
    ) s`)[0].join(",");
  const rows = (sql: string) => run(sql).map((r) => ({ grp: r[0], name: r[1], ok: r[2] === "t", detail: r.slice(3).join("|") }));

  beforeAll(() => {
    db = new DisposablePg(pg!.bin);
    db.start();
    // the database as your project is today: everything up to and including pgvector
    db.createDb(DB, ALREADY_APPLIED());
    run(`insert into auth.users (id, email) values ('${alice}', 'a@example.com'), ('${bob}', 'b@example.com')`);
    const m1 = crypto.randomUUID();
    const m2 = crypto.randomUUID();
    const m3 = crypto.randomUUID();
    run(`insert into memories (id, user_id, source_kind, original_text, content_hash, intent_kind, intent_status) values
      ('${m1}', '${alice}', 'note', 'apply to lumen by friday', 'h1', 'pursue', 'confirmed'),
      ('${m2}', '${alice}', 'note', 'pasta recipe', 'h2', null, null),
      ('${m3}', '${bob}', 'note', 'bobs private note', 'h3', 'learn', 'set')`);
    const a1 = crypto.randomUUID();
    run(`insert into actions (id, user_id, memory_id, title, action_type, status) values ('${a1}', '${alice}', '${m1}', 'Apply', 'executed', 'in_progress'), ('${crypto.randomUUID()}', '${alice}', '${m2}', 'Cook it', 'suggested', 'proposed')`);
    run(`insert into reminders (user_id, memory_id, action_id, title, due_at, status) values
      ('${alice}', '${m1}', '${a1}', 'Apply to Lumen', now() + interval '2 days', 'scheduled'),
      ('${alice}', '${m2}', null, 'Cook', now() - interval '1 day', 'done'),
      ('${bob}', '${m3}', null, 'Study', now() + interval '5 days', 'snoozed')`);
    run(`insert into memory_embeddings (memory_id, user_id, provider, model, dims, embedding_vec, source_hash) values ('${m1}', '${alice}', 'http', 'text-embedding-3-small', 3, '[0.1,0.2,0.3]', 'h')`);
  }, 120_000);
  afterAll(() => db?.stop());

  let before: string;
  let beforeCounts: string;
  let preflightInfo: Record<string, string>;

  it("pre-flight: every required check passes on the database as it is now", () => {
    const r = rows(verify("preflight.sql"));
    const required = r.filter((x) => x.grp === "required");
    expect(required.length).toBeGreaterThanOrEqual(14);
    expect(required.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([]);
    preflightInfo = Object.fromEntries(r.filter((x) => x.grp === "info").map((x) => [x.name, x.detail]));
    expect(preflightInfo["rows in memories"]).toBe("3");
    expect(preflightInfo["rows in reminders"]).toBe("3");
    expect(preflightInfo["extension vector installed"]).not.toBe("no");
    before = signature();
    beforeCounts = counts();
  });

  it("pre-flight catches a database that is NOT ready (so it can't give a false all-clear)", () => {
    db.createDb("bare", ALREADY_APPLIED().slice(0, 1)); // only the first migration: no reminders yet
    const r = db.sql(verify("preflight.sql"), { db: "bare" });
    const failed = r.filter((x) => x[0] === "required" && x[2] === "f").map((x) => x[1]);
    expect(failed).toEqual(expect.arrayContaining(["table reminders", "actions (id, user_id) unique key"]));
  });

  it("applies one by one, in order, and no existing row changes at any step", () => {
    for (const f of PENDING) {
      run(migration(f));
      expect(counts(), `after ${f}`).toBe(beforeCounts);
    }
  });

  it("post-check: every verification row is true, and the row counts equal the pre-flight's", () => {
    const r = rows(verify("after_pending.sql"));
    const checks = r.filter((x) => x.grp === "check");
    expect(checks.length).toBeGreaterThanOrEqual(17);
    expect(checks.filter((x) => !x.ok).map((x) => x.name)).toEqual([]);
    const info = Object.fromEntries(r.filter((x) => x.grp === "info").map((x) => [x.name.replace(/ \(.*\)$/, ""), x.detail]));
    expect(info["rows in memories"]).toBe(preflightInfo["rows in memories"]);
    expect(info["rows in actions"]).toBe(preflightInfo["rows in actions"]);
    expect(info["rows in reminders"]).toBe(preflightInfo["rows in reminders"]);
    expect(info["rows in memory_embeddings"]).toBe(preflightInfo["rows in memory_embeddings"]);
  });

  it("existing data works with the new schema: old reminders got safe defaults, old intents still allowed, new ones accepted", () => {
    expect(run("select kind, snooze_count, timezone is null from reminders order by title")).toEqual([["manual", "0", "t"], ["manual", "0", "t"], ["manual", "0", "t"]]);
    expect(() => run(`update memories set intent_kind = 'follow_up' where content_hash = 'h2'`)).not.toThrow();
    expect(() => run(`update memories set intent_kind = 'stalk' where content_hash = 'h2'`)).toThrow(/memories_intent_kind_check/);
    expect(run("select intent_kind from memories where content_hash = 'h1'")[0][0]).toBe("pursue");
    run(`update memories set intent_kind = null where content_hash = 'h2'`);
    expect(run("select allowed_mime_types[1] from storage.buckets where id = 'memory-images'")[0][0]).toBe("image/png"); // the old types are kept
  });

  it("the security model holds on real PostgreSQL: users only touch their own rows, only the service role claims deliveries", () => {
    const m = run(`select id from memories where user_id = '${alice}' limit 1`)[0][0];
    const rid = run(`select id from reminders where user_id = '${alice}' limit 1`)[0][0];
    run(`insert into notification_deliveries (user_id, reminder_id, kind, channel, scheduled_for, dedupe_key, payload) values ('${alice}', '${rid}', 'reminder', 'in_app', now() - interval '1 minute', 'k1', '{}')`);
    // bob sees none of alice's rows in any new table, and can't claim
    expect(run("select count(*) from notification_deliveries", { user: bob }) [0][0]).toBe("0");
    expect(run("select count(*) from plans", { user: bob })[0][0]).toBe("0");
    expect(run("select count(*) from cv_documents", { user: bob })[0][0]).toBe("0");
    expect(() => run("select * from claim_deliveries(now(), 10, 60)", { user: bob })).toThrow(/permission denied/);
    expect(() => run("select * from claim_deliveries(now(), 10, 60)", { user: null, role: "anon" })).toThrow(/permission denied/);
    expect(run("select count(*) from claim_deliveries(now(), 10, 60)", { user: null, role: "service_role" })[0][0]).toBe("1");
    expect(run("select count(*) from claim_deliveries(now(), 10, 60)", { user: null, role: "service_role" })[0][0]).toBe("0"); // leased
    // alice cannot rewrite the history of what was sent
    expect(() => run(`update notification_deliveries set status = 'sent' where dedupe_key = 'k1'`, { user: alice })).toThrow(/cancelled while it is pending/);
    expect(() => run(`insert into plans (user_id, memory_id, action_id, workflow, doc) values ('${bob}', '${m}', gen_random_uuid(), 'recipe', '{}')`, { user: bob })).toThrow();
    run("delete from notification_deliveries");
  });

  it("rolls back in reverse order to exactly the schema it started from, with the data untouched", () => {
    for (const f of DOWN) run(down(f));
    expect(counts()).toBe(beforeCounts);
    expect(signature()).toBe(before);
    expect(rows(verify("preflight.sql")).filter((x) => x.grp === "required" && !x.ok)).toEqual([]);
  });

  it("applies again after a rollback, and a second apply of the same file fails loudly instead of doing damage", () => {
    for (const f of PENDING) run(migration(f));
    expect(rows(verify("after_pending.sql")).filter((x) => x.grp === "check" && !x.ok)).toEqual([]);
    const afterAgain = signature();
    for (const f of PENDING.filter((x) => !x.includes("follow_up"))) expect(() => run(migration(f)), f).toThrow(/already exists|duplicate/);
    run(migration("20261103010000_follow_up_intent.sql")); // this one only swaps a check constraint, so running it twice is harmless
    expect(signature()).toBe(afterAgain); // the failed re-runs changed nothing
    expect(counts()).toBe(beforeCounts);
  });

  it("each rollback on its own leaves the others working (an out-of-order undo is safe)", () => {
    run(down("20261104000000_notifications.down.sql"));
    expect(run("select to_regclass('public.notification_deliveries') is null")[0][0]).toBe("t");
    expect(run("select to_regclass('public.plans') is not null, to_regclass('public.cv_documents') is not null")[0]).toEqual(["t", "t"]);
    expect(counts()).toBe(beforeCounts);
  });
});
