import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DisposablePg, findPostgres, migrationFiles, ROLLBACK } from "./helpers/realpg";

// REAL pgvector against a REAL (disposable) PostgreSQL, applying the REAL migration files. Not PGlite, not mocked.
// Skipped, visibly, when PostgreSQL with pgvector isn't installed (set PGBIN to point at one); a skip is not a pass.

const pg = findPostgres();
if (!pg) console.warn("[pgvector.integration] SKIPPED: no PostgreSQL with the pgvector extension found (set PGBIN).");

const PGVECTOR = "20261101000000_pgvector_embeddings.sql";
const before = () => migrationFiles().filter((f) => f < PGVECTOR);
const all = () => migrationFiles();

describe.skipIf(!pg)("pgvector (real PostgreSQL)", () => {
  let db: DisposablePg;
  const alice = randomUUID();
  const bob = randomUUID();
  const memA = randomUUID();
  const memA2 = randomUUID();
  const memA3 = randomUUID();
  const memB = randomUUID();
  const as = (user: string | null) => ({ db: "main", as: { user } });
  const run = (sql: string, user?: string | null) => db.sql(sql, user === undefined ? { db: "main" } : as(user));
  const vec = (v: number[]) => `[${v.join(",")}]`;
  const put = (user: string, mem: string, v: number[], model = "m1") =>
    run(`insert into memory_embeddings (memory_id, user_id, provider, model, dims, embedding_vec, source_hash) values ('${mem}', '${user}', 'test', '${model}', ${v.length}, '${vec(v)}', 'h')`, user);
  const match = (user: string | null, q: number[], extra = "", model = "m1") =>
    run(`select memory_id, round(similarity::numeric, 4) from match_memories('${model}', '${vec(q)}'${extra})`, user);

  beforeAll(() => {
    db = new DisposablePg(pg!.bin);
    db.start();

    // 1. the world BEFORE pgvector: the real[] migration applied, with a pre-existing vector for alice
    db.createDb("main", before());
    db.sql(`insert into auth.users (id, email) values ('${alice}', 'a@x'), ('${bob}', 'b@x')`, { db: "main" });
    for (const [id, user, hash] of [[memA, alice, "a"], [memA2, alice, "a2"], [memA3, alice, "a3"], [memB, bob, "b"]]) {
      db.sql(`insert into memories (id, user_id, source_kind, original_text, content_hash) values ('${id}', '${user}', 'note', 'text ${hash}', '${hash}')`, { db: "main" });
    }
    db.sql(`insert into memory_embeddings (memory_id, user_id, model, dims, embedding, source_hash) values ('${memA}', '${alice}', 'old', 3, '{0.5,0.25,1}', 'oldhash')`, { db: "main" });

    // 2. apply the pgvector migration on top
    db.sql(readFileSync(path.resolve(__dirname, "../supabase/migrations", PGVECTOR), "utf8"), { db: "main" });
  }, 120_000);
  afterAll(() => db?.stop());

  it("migration: carries the existing real[] vector over, keeps the old column, touches no memory", () => {
    expect(run(`select embedding_vec::text, embedding::text, provider, source_hash from memory_embeddings where model = 'old'`)[0]).toEqual(["[0.5,0.25,1]", "{0.5,0.25,1}", "unknown", "oldhash"]);
    expect(run(`select count(*) from memories`)[0][0]).toBe("4");
  });

  it("stores the extension in its own schema and the column has no fixed dimension", () => {
    expect(run(`select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'`)[0][0]).toBe("extensions");
    expect(run(`select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.memory_embeddings'::regclass and attname = 'embedding_vec'`)[0][0]).toBe("extensions.vector");
  });

  it("inserts and reads back a vector as its owner", () => {
    put(alice, memA, [1, 0, 0]);
    put(alice, memA2, [0.7071, 0.7071, 0]);
    put(alice, memA3, [0, 1, 0]);
    expect(run(`select embedding_vec::text, dims, provider from memory_embeddings where memory_id = '${memA}' and model = 'm1'`, alice)[0]).toEqual(["[1,0,0]", "3", "test"]);
  });

  it("ranks by cosine similarity, best first, with correct scores", () => {
    expect(match(alice, [1, 0, 0])).toEqual([[memA, "1.0000"], [memA2, "0.7071"], [memA3, "0.0000"]]);
    expect(match(alice, [0, 1, 0])[0][0]).toBe(memA3);
  });

  it("supports a result limit and a minimum similarity", () => {
    expect(match(alice, [1, 0, 0], ", 2").map((r) => r[0])).toEqual([memA, memA2]);
    expect(match(alice, [1, 0, 0], ", 20, 0.5").map((r) => r[0])).toEqual([memA, memA2]);
    expect(match(alice, [1, 0, 0], ", 0").length).toBe(1); // a limit below 1 is clamped, not an error
  });

  it("rejects wrong dimensions, empty and invalid vectors", () => {
    expect(() => match(alice, [1, 0])).toThrow(/2 dimensions but model m1 stores 3/);
    expect(() => run(`select * from match_memories('m1', '[]')`, alice)).toThrow(/at least 1 dimension/);
    expect(() => run(`select '[1,NaN]'::extensions.vector`)).toThrow(/NaN not allowed/);
    // a row whose vector doesn't match its dims column is refused by the table itself
    expect(() => run(`insert into memory_embeddings (memory_id, user_id, model, dims, embedding_vec, source_hash) values ('${memA}', '${alice}', 'bad', 5, '[1,2,3]', 'h')`, alice)).toThrow(/memory_embeddings_vec_dims_check/);
    expect(() => run(`insert into memory_embeddings (memory_id, user_id, model, dims, source_hash) values ('${memA}', '${alice}', 'none', 3, 'h')`, alice)).toThrow(/has_vector_check/);
  });

  it("returns nothing for a model nobody has embedded", () => {
    expect(match(alice, [1, 0, 0], "", "other-model")).toEqual([]);
  });

  it("isolates users: bob never sees alice's vectors, even for an identical query", () => {
    put(bob, memB, [1, 0, 0]);
    expect(match(bob, [1, 0, 0])).toEqual([[memB, "1.0000"]]);
    expect(match(alice, [1, 0, 0]).map((r) => r[0])).not.toContain(memB);
    expect(run(`select count(*) from memory_embeddings`, bob)[0][0]).toBe("1");
  });

  it("stops bob from writing to, replacing or deleting alice's vectors", () => {
    // attach a vector to alice's memory: blocked by RLS (user_id) and by the composite foreign key
    expect(() => put(bob, memA2, [9, 9, 9], "evil")).toThrow();
    expect(() => run(`insert into memory_embeddings (memory_id, user_id, model, dims, embedding_vec, source_hash) values ('${memA2}', '${alice}', 'evil', 1, '[1]', 'x')`, bob)).toThrow(/row-level security/);
    expect(run(`update memory_embeddings set source_hash = 'pwn' where memory_id = '${memA}' returning 1`, bob)).toEqual([]);
    expect(run(`delete from memory_embeddings where memory_id = '${memA}' returning 1`, bob)).toEqual([]);
    expect(run(`select source_hash from memory_embeddings where memory_id = '${memA}' and model = 'm1'`, alice)[0][0]).toBe("h");
  });

  it("RPC security: anonymous and signed-out callers are refused; it runs with the caller's rights", () => {
    expect(() => db.sql(`select * from match_memories('m1', '[1,0,0]')`, { db: "main", as: { user: null, role: "anon" } })).toThrow(/permission denied/);
    expect(() => db.sql(`select * from match_memories('m1', '[1,0,0]')`, { db: "main", as: { user: null } })).toThrow(/not signed in/);
    const [secdef, config] = run(`select prosecdef, proconfig::text from pg_proc where proname = 'match_memories'`)[0];
    expect(secdef).toBe("f"); // SECURITY INVOKER: no elevated rights to abuse
    expect(config).toContain("search_path=");
    expect(run(`select has_function_privilege('anon', 'public.match_memories(text, extensions.vector, integer, double precision)', 'execute')`)[0][0]).toBe("f");
    expect(run(`select has_function_privilege('authenticated', 'public.match_memories(text, extensions.vector, integer, double precision)', 'execute')`)[0][0]).toBe("t");
    expect(() => db.sql(`select * from memory_embeddings`, { db: "main", as: { user: null, role: "anon" } })).toThrow(/permission denied/);
  });

  it("safe re-indexing: the same memory and model is replaced in place", () => {
    run(`insert into memory_embeddings (memory_id, user_id, provider, model, dims, embedding_vec, source_hash) values ('${memA}', '${alice}', 'test', 'm1', 3, '[0,0,1]', 'h2')
         on conflict (memory_id, model) do update set embedding_vec = excluded.embedding_vec, dims = excluded.dims, source_hash = excluded.source_hash`, alice);
    expect(run(`select count(*), max(source_hash), max(embedding_vec::text) from memory_embeddings where memory_id = '${memA}' and model = 'm1'`, alice)[0]).toEqual(["1", "h2", "[0,0,1]"]);
    // a different model coexists with it, so switching models never overwrites the old vectors
    put(alice, memA, [1, 1], "m2");
    expect(run(`select count(*) from memory_embeddings where memory_id = '${memA}'`, alice)[0][0]).toBe("3");
  });

  it("cascades: deleting a memory removes its vectors; deleting a user removes everything", () => {
    expect(run(`select count(*) from memory_embeddings where memory_id = '${memA3}'`, alice)[0][0]).toBe("1");
    run(`delete from memories where id = '${memA3}'`, alice);
    expect(run(`select count(*) from memory_embeddings where memory_id = '${memA3}'`)[0][0]).toBe("0");
    expect(run(`select count(*) from memories where id in ('${memA}', '${memA2}')`)[0][0]).toBe("2"); // siblings untouched
    run(`delete from auth.users where id = '${bob}'`);
    expect(run(`select count(*) from memory_embeddings where user_id = '${bob}'`)[0][0]).toBe("0");
  });

  it("ROLLBACK restores real[] for vectors written after the migration, removes the new objects, keeps the memories", () => {
    db.createDb("rb", before());
    const u = randomUUID();
    const m = randomUUID();
    db.sql(`insert into auth.users (id, email) values ('${u}', 'r@x')`, { db: "rb" });
    db.sql(`insert into memories (id, user_id, source_kind, original_text, content_hash) values ('${m}', '${u}', 'note', 't', 'h')`, { db: "rb" });
    db.sql(readFileSync(path.resolve(__dirname, "../supabase/migrations", PGVECTOR), "utf8"), { db: "rb" });
    db.sql(`insert into memory_embeddings (memory_id, user_id, provider, model, dims, embedding_vec, source_hash) values ('${m}', '${u}', 'p', 'new', 2, '[0.5,2]', 'h')`, { db: "rb" });

    db.sql(readFileSync(path.join(ROLLBACK, "20261101000000_pgvector_embeddings.down.sql"), "utf8"), { db: "rb" });
    expect(db.sql(`select embedding::text from memory_embeddings where model = 'new'`, { db: "rb" })[0][0]).toBe("{0.5,2}");
    expect(db.sql(`select count(*) from information_schema.columns where table_name = 'memory_embeddings' and column_name in ('embedding_vec', 'provider')`, { db: "rb" })[0][0]).toBe("0");
    expect(db.sql(`select count(*) from pg_proc where proname = 'match_memories'`, { db: "rb" })[0][0]).toBe("0");
    expect(db.sql(`select count(*) from memories`, { db: "rb" })[0][0]).toBe("1");
  }, 60_000);

  it("the optional cleanup script refuses to run while a row has no vector in the new column", () => {
    db.createDb("cl", all());
    const u = randomUUID();
    const m = randomUUID();
    db.sql(`insert into auth.users (id, email) values ('${u}', 'c@x')`, { db: "cl" });
    db.sql(`insert into memories (id, user_id, source_kind, original_text, content_hash) values ('${m}', '${u}', 'note', 't', 'h')`, { db: "cl" });
    // a legacy row that only has the old array (what an unconverted row would look like)
    db.sql(`insert into memory_embeddings (memory_id, user_id, model, dims, embedding, source_hash) values ('${m}', '${u}', 'legacy', 2, '{1,2}', 'h')`, { db: "cl" });
    const script = readFileSync(path.join(ROLLBACK, "cleanup_real_array_embeddings.sql"), "utf8");
    expect(() => db.sql(script, { db: "cl" })).toThrow(/refusing/);
    db.sql(`update memory_embeddings set embedding_vec = embedding::extensions.vector`, { db: "cl" });
    db.sql(script, { db: "cl" }); // now allowed
    expect(db.sql(`select count(*) from information_schema.columns where table_name = 'memory_embeddings' and column_name = 'embedding'`, { db: "cl" })[0][0]).toBe("0");
  }, 60_000);
});
