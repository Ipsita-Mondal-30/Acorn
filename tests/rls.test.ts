import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/pg";

let t: TestDb;
let alice: string;
let bob: string;
let aliceMemory: string;
let aliceTag: string;

const mem = (userId: string, hash: string, extra = "") =>
  [
    `insert into memories (user_id, source_kind, original_text, content_hash${extra ? ", " + extra.split("=")[0] : ""})`,
    `values ('${userId}', 'note', 'hello', '${hash}'${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
  ].join(" ");

beforeAll(async () => {
  t = await makeDb();
  alice = await t.signUp("alice@example.com");
  bob = await t.signUp("bob@example.com");
  aliceMemory = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "h1")))).rows[0].id;
  aliceTag = (
    await t.asUser(alice, (q) => q<{ id: string }>(`insert into tags (user_id, name) values ('${alice}', 'cooking') returning id`))
  ).rows[0].id;
}, 60_000);
afterAll(() => t.db.close());

describe("profiles", () => {
  it("creates a profile for each new auth user and shows it only to its owner", async () => {
    const own = await t.asUser(alice, (q) => q<{ id: string; display_name: string }>("select id, display_name from profiles"));
    expect(own.rows).toEqual([{ id: alice, display_name: "alice" }]);
  });
  it("lets a user update their own profile but not another's", async () => {
    await t.asUser(alice, (q) => q("update profiles set display_name = 'Alice A' where id = $1", [alice]));
    const r = await t.asUser(bob, (q) => q("update profiles set display_name = 'hacked' where id = $1", [alice]));
    expect(r.affectedRows).toBe(0);
    const now = await t.db.query<{ display_name: string }>("select display_name from profiles where id = $1", [alice]);
    expect(now.rows[0].display_name).toBe("Alice A");
  });
});

describe("memories isolation", () => {
  it("shows a user only their own memories", async () => {
    expect((await t.asUser(alice, (q) => q("select id from memories"))).rows).toHaveLength(1);
    expect((await t.asUser(bob, (q) => q("select id from memories"))).rows).toHaveLength(0);
  });
  it("finds nothing when another user asks for the id directly", async () => {
    const r = await t.asUser(bob, (q) => q("select id from memories where id = $1", [aliceMemory]));
    expect(r.rows).toHaveLength(0);
  });
  it("cannot create a memory under someone else's id", async () => {
    await expect(t.asUser(bob, (q) => q(mem(alice, "evil")))).rejects.toThrow(/row-level security/i);
  });
  it("cannot update or delete another user's memory (zero rows touched)", async () => {
    const u = await t.asUser(bob, (q) => q("update memories set title = 'pwned' where id = $1", [aliceMemory]));
    const d = await t.asUser(bob, (q) => q("delete from memories where id = $1", [aliceMemory]));
    expect([u.affectedRows, d.affectedRows]).toEqual([0, 0]);
    const row = await t.db.query<{ title: string }>("select title from memories where id = $1", [aliceMemory]);
    expect(row.rows[0].title).toBe("Untitled");
  });
  it("cannot hand its own memory to another user", async () => {
    await expect(
      t.asUser(alice, (q) => q("update memories set user_id = $1 where id = $2", [bob, aliceMemory])),
    ).rejects.toThrow(/row-level security/i);
  });
  it("lets the owner update and delete", async () => {
    const id = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "h-del")))).rows[0].id;
    const u = await t.asUser(alice, (q) => q("update memories set title = 'Mine' where id = $1", [id]));
    expect(u.affectedRows).toBe(1);
    const d = await t.asUser(alice, (q) => q("delete from memories where id = $1", [id]));
    expect(d.affectedRows).toBe(1);
  });
  it("blocks anonymous access entirely", async () => {
    await expect(t.asAnon((q) => q("select id from memories"))).rejects.toThrow(/permission denied/i);
    await expect(t.asAnon((q) => q(mem(alice, "anon")))).rejects.toThrow(/permission denied/i);
  });
  it("rejects an invalid id with a type error (the app validates ids before querying)", async () => {
    await expect(t.asUser(alice, (q) => q("select id from memories where id = 'not-a-uuid'"))).rejects.toThrow(/uuid/i);
  });
  it("makes capture idempotent per user, but allows the same content for another user", async () => {
    await expect(t.asUser(alice, (q) => q(mem(alice, "h1")))).rejects.toThrow(/duplicate key/i);
    await t.asUser(bob, (q) => q(mem(bob, "h1")));
    await t.db.query("delete from memories where user_id = $1", [bob]);
  });
  it("rejects a stored file path outside the owner's folder, even for a privileged writer", async () => {
    await expect(
      t.db.query(
        `insert into memories (user_id, source_kind, storage_path, content_hash) values ($1, 'image', $2, 'x1')`,
        [alice, `${bob}/pic.png`],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      t.db.query(`insert into memories (user_id, source_kind, content_hash) values ($1, 'image', 'x2')`, [alice]),
    ).rejects.toThrow(/check constraint/i);
  });
  it("enforces value constraints", async () => {
    await expect(t.asUser(alice, (q) => q(mem(alice, "bad", "processing_status='weird'")))).rejects.toThrow(/check constraint/i);
    await expect(t.asUser(alice, (q) => q(mem(alice, "bad2", "intent_confidence=1.5")))).rejects.toThrow();
  });
});

describe("actions isolation", () => {
  let actionId: string;
  it("lets the owner create an action on their memory", async () => {
    const r = await t.asUser(alice, (q) =>
      q<{ id: string }>(
        `insert into actions (user_id, memory_id, title, action_type) values ($1, $2, 'Apply', 'suggested') returning id`,
        [alice, aliceMemory],
      ),
    );
    actionId = r.rows[0].id;
  });
  it("hides it from other users and blocks their writes", async () => {
    expect((await t.asUser(bob, (q) => q("select id from actions"))).rows).toHaveLength(0);
    const u = await t.asUser(bob, (q) => q("update actions set status = 'completed' where id = $1", [actionId]));
    const d = await t.asUser(bob, (q) => q("delete from actions where id = $1", [actionId]));
    expect([u.affectedRows, d.affectedRows]).toEqual([0, 0]);
  });
  it("cannot attach an action to another user's memory", async () => {
    await expect(
      t.asUser(bob, (q) =>
        q(`insert into actions (user_id, memory_id, title, action_type) values ($1, $2, 'Sneaky', 'suggested')`, [bob, aliceMemory]),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
  it("rejects an unknown state", async () => {
    await expect(
      t.asUser(alice, (q) =>
        q(`insert into actions (user_id, memory_id, title, action_type, status) values ($1, $2, 'x', 'suggested', 'done')`, [alice, aliceMemory]),
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("tags and memory_tags", () => {
  it("keeps tags private", async () => {
    expect((await t.asUser(bob, (q) => q("select id from tags"))).rows).toHaveLength(0);
    await expect(t.asUser(bob, (q) => q(`insert into tags (user_id, name) values ($1, 'x')`, [alice]))).rejects.toThrow(/row-level security/i);
    await expect(t.asUser(alice, (q) => q(`insert into tags (user_id, name) values ($1, 'Mixed Case')`, [alice]))).rejects.toThrow(/check constraint/i);
  });
  it("links a user's own memory and tag", async () => {
    await t.asUser(alice, (q) =>
      q(`insert into memory_tags (memory_id, tag_id, user_id) values ($1, $2, $3)`, [aliceMemory, aliceTag, alice]),
    );
    expect((await t.asUser(alice, (q) => q("select * from memory_tags"))).rows).toHaveLength(1);
    expect((await t.asUser(bob, (q) => q("select * from memory_tags"))).rows).toHaveLength(0);
  });
  it("cannot link across users, whichever end belongs to someone else", async () => {
    const bobMemory = (await t.asUser(bob, (q) => q<{ id: string }>(mem(bob, "b1")))).rows[0].id;
    const bobTag = (await t.asUser(bob, (q) => q<{ id: string }>(`insert into tags (user_id, name) values ($1, 'b') returning id`, [bob]))).rows[0].id;
    const link = (user: string, m: string, tag: string) =>
      t.asUser(user, (q) => q(`insert into memory_tags (memory_id, tag_id, user_id) values ($1, $2, $3)`, [m, tag, user]));
    await expect(link(bob, bobMemory, aliceTag)).rejects.toThrow(); // my memory, their tag
    await expect(link(bob, aliceMemory, bobTag)).rejects.toThrow(); // their memory, my tag
    await expect(link(bob, aliceMemory, aliceTag)).rejects.toThrow(); // both theirs
    // even a privileged writer can't forge a cross-user link: the composite foreign keys refuse it
    await expect(
      t.db.query(`insert into memory_tags (memory_id, tag_id, user_id) values ($1, $2, $3)`, [aliceMemory, bobTag, alice]),
    ).rejects.toThrow(/foreign key/i);
  });
  it("lets the owner remove a link", async () => {
    const r = await t.asUser(alice, (q) => q("delete from memory_tags where memory_id = $1", [aliceMemory]));
    expect(r.affectedRows).toBe(1);
  });
});

describe("claim_memory_processing", () => {
  const claim = (user: string, id: string, force = false, lease = 120) =>
    t.asUser(user, (q) => q<{ id: string; processing_status: string }>("select * from claim_memory_processing($1, $2, $3)", [id, force, lease]));

  it("lets exactly one of two racing callers claim a pending memory", async () => {
    const id = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "claim1")))).rows[0].id;
    const first = await claim(alice, id);
    const second = await claim(alice, id);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].processing_status).toBe("processing");
    expect(second.rows).toHaveLength(0);
  });
  it("never takes over a live run, even with force, but reclaims a stale one", async () => {
    const id = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "claim2")))).rows[0].id;
    await claim(alice, id);
    expect((await claim(alice, id, true)).rows).toHaveLength(0);
    // the updated_at trigger would overwrite a backdated value, so switch it off just for this simulation
    await t.db.exec("alter table memories disable trigger memories_touch");
    await t.db.query("update memories set updated_at = now() - interval '5 minutes' where id = $1", [id]);
    await t.db.exec("alter table memories enable trigger memories_touch");
    expect((await claim(alice, id)).rows).toHaveLength(1);
  });
  it("re-runs a ready memory only when forced", async () => {
    const id = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "claim3", "processing_status='ready'")))).rows[0].id;
    expect((await claim(alice, id)).rows).toHaveLength(0);
    expect((await claim(alice, id, true)).rows).toHaveLength(1);
  });
  it("cannot claim another user's memory", async () => {
    expect((await claim(bob, aliceMemory)).rows).toHaveLength(0);
  });
  it("is not callable anonymously", async () => {
    await expect(t.asAnon((q) => q("select * from claim_memory_processing($1, false, 120)", [aliceMemory]))).rejects.toThrow(/permission denied/i);
  });
});

describe("reminders", () => {
  let reminderId: string;
  let actionId: string;
  const add = (user: string, memory: string, action: string | null = null, due = "2027-01-10T09:00:00Z") =>
    t.asUser(user, (q) =>
      q<{ id: string }>(
        `insert into reminders (user_id, memory_id, action_id, title, due_at) values ($1, $2, $3, 'Apply to Northwind', $4) returning id`,
        [user, memory, action, due],
      ),
    );
  it("lets the owner schedule a reminder on their memory and action", async () => {
    actionId = (
      await t.asUser(alice, (q) => q<{ id: string }>(`insert into actions (user_id, memory_id, title, action_type) values ($1, $2, 'Send CV', 'suggested') returning id`, [alice, aliceMemory]))
    ).rows[0].id;
    reminderId = (await add(alice, aliceMemory, actionId)).rows[0].id;
    const r = await t.asUser(alice, (q) => q<{ status: string; rev: number }>("select status, rev from reminders where id = $1", [reminderId]));
    expect(r.rows[0]).toMatchObject({ status: "scheduled", rev: 0 });
  });
  it("keeps a follow-up history and bumps the revision on update", async () => {
    await t.asUser(alice, (q) =>
      q(`update reminders set status = 'snoozed', history = history || '[{"status":"snoozed","note":"later"}]'::jsonb where id = $1`, [reminderId]),
    );
    const r = await t.asUser(alice, (q) => q<{ rev: number; history: unknown[] }>("select rev, history from reminders where id = $1", [reminderId]));
    expect(r.rows[0].rev).toBe(1);
    expect(r.rows[0].history).toHaveLength(1);
  });
  it("is invisible to other users and they cannot change or delete it", async () => {
    expect((await t.asUser(bob, (q) => q("select id from reminders"))).rows).toHaveLength(0);
    const u = await t.asUser(bob, (q) => q("update reminders set status = 'done' where id = $1", [reminderId]));
    const d = await t.asUser(bob, (q) => q("delete from reminders where id = $1", [reminderId]));
    expect([u.affectedRows, d.affectedRows]).toEqual([0, 0]);
  });
  it("cannot be attached to another user's memory or action, or created under another id", async () => {
    await expect(add(bob, aliceMemory)).rejects.toThrow(/foreign key/i);
    const bobMemory = (await t.asUser(bob, (q) => q<{ id: string }>(mem(bob, "bob-r")))).rows[0].id;
    await expect(add(bob, bobMemory, actionId)).rejects.toThrow(/foreign key/i);
    await expect(add(alice, bobMemory)).rejects.toThrow();
    await expect(
      t.asUser(bob, (q) => q(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, 'x', now())`, [alice, bobMemory])),
    ).rejects.toThrow(/row-level security/i);
  });
  it("rejects an unknown status and an empty title", async () => {
    await expect(t.asUser(alice, (q) => q("update reminders set status = 'later' where id = $1", [reminderId]))).rejects.toThrow(/check/i);
    await expect(
      t.asUser(alice, (q) => q(`insert into reminders (user_id, memory_id, title, due_at) values ($1, $2, '', now())`, [alice, aliceMemory])),
    ).rejects.toThrow(/check/i);
  });
  it("blocks anonymous access", async () => {
    await expect(t.asAnon((q) => q("select id from reminders"))).rejects.toThrow(/permission denied/i);
  });
  it("goes away with its memory", async () => {
    const m = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "rem-casc")))).rows[0].id;
    const id = (await add(alice, m)).rows[0].id;
    await t.asUser(alice, (q) => q("delete from memories where id = $1", [m]));
    expect((await t.db.query("select id from reminders where id = $1", [id])).rows).toHaveLength(0);
  });
});

describe("cascades", () => {
  it("deleting a memory removes its actions and tag links", async () => {
    const id = (await t.asUser(alice, (q) => q<{ id: string }>(mem(alice, "casc")))).rows[0].id;
    await t.asUser(alice, (q) => q(`insert into actions (user_id, memory_id, title, action_type) values ($1, $2, 'a', 'suggested')`, [alice, id]));
    await t.asUser(alice, (q) => q(`insert into memory_tags (memory_id, tag_id, user_id) values ($1, $2, $3)`, [id, aliceTag, alice]));
    await t.asUser(alice, (q) => q("delete from memories where id = $1", [id]));
    const left = await t.db.query("select (select count(*) from actions where memory_id = $1) a, (select count(*) from memory_tags where memory_id = $1) m", [id]);
    expect(left.rows[0]).toEqual({ a: 0, m: 0 });
  });
  it("deleting a user removes all of their data and leaves others alone", async () => {
    const carol = await t.signUp("carol@example.com");
    await t.asUser(carol, (q) => q(mem(carol, "c1")));
    await t.db.query("delete from auth.users where id = $1", [carol]);
    const left = await t.db.query("select (select count(*) from memories where user_id = $1) m, (select count(*) from profiles where id = $1) p", [carol]);
    expect(left.rows[0]).toEqual({ m: 0, p: 0 });
    expect((await t.asUser(alice, (q) => q("select id from memories"))).rows.length).toBeGreaterThan(0);
  });
});

describe("storage bucket", () => {
  it("is private, size-capped, and accepts only images, PDFs, CV files (.docx, plain text), voice notes (WAV) and generated pictures (SVG)", async () => {
    const b = await t.db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'memory-images'",
    );
    expect(b.rows[0].public).toBe(false);
    expect(Number(b.rows[0].file_size_limit)).toBe(15 * 1024 * 1024);
    expect(b.rows[0].allowed_mime_types).toEqual([
      "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain",
      "audio/wav", "image/svg+xml", // voice notes and generated pictures (20261105000000_meta_artifacts)
    ]);
  });
  const put = (user: string, name: string, bucket = "memory-images") =>
    t.asUser(user, (q) => q("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]));
  it("lets a user write only inside their own folder", async () => {
    await put(alice, `${alice}/a.png`);
    await expect(put(alice, `${bob}/a.png`)).rejects.toThrow(/row-level security/i);
    await expect(put(alice, "loose.png")).rejects.toThrow(/row-level security/i);
  });
  it("hides and protects one user's files from another", async () => {
    expect((await t.asUser(bob, (q) => q("select name from storage.objects"))).rows).toHaveLength(0);
    const d = await t.asUser(bob, (q) => q("delete from storage.objects where name = $1", [`${alice}/a.png`]));
    expect(d.affectedRows).toBe(0);
    expect((await t.asUser(alice, (q) => q("select name from storage.objects"))).rows).toHaveLength(1);
  });
  it("lets the owner delete their file", async () => {
    const d = await t.asUser(alice, (q) => q("delete from storage.objects where name = $1", [`${alice}/a.png`]));
    expect(d.affectedRows).toBe(1);
  });
  it("blocks anonymous access", async () => {
    await expect(t.asAnon((q) => q("select name from storage.objects"))).rejects.toThrow(/permission denied/i);
  });
});

describe("multimodal migration", () => {
  it("accepts the new content types, intents and document sources, and still rejects unknown ones", async () => {
    const ins = (cols: string, vals: string) =>
      t.asUser(alice, (q) => q(`insert into memories (user_id, content_hash, ${cols}) values ('${alice}', '${vals.split("|")[0]}', ${vals.split("|")[1]})`));
    await ins("source_kind, content_type, intent_kind", "mm1|'note', 'event', 'attend'");
    await ins("source_kind, content_type, intent_kind", "mm2|'note', 'product', 'explore'");
    await ins("source_kind, storage_path", `mm3|'document', '${alice}/${"a".repeat(8)}.pdf'`);
    await expect(ins("source_kind, content_type", "mm4|'note', 'spaceship'")).rejects.toThrow(/check constraint/i);
    await expect(ins("source_kind, intent_kind", "mm5|'note', 'conquer'")).rejects.toThrow(/check constraint/i);
    await expect(ins("source_kind", "mm6|'document'")).rejects.toThrow(/check constraint/i); // a PDF memory needs its stored original
  });

  describe("full-text search", () => {
    const rank = (user: string, query: string) =>
      t.asUser(user, (q) => q<{ id: string }>("select id from search_memories_fts($1, 20)", [query])).then((r) => r.rows.map((x) => x.id));
    let pasta: string;
    beforeAll(async () => {
      pasta = (
        await t.asUser(alice, (q) =>
          q<{ id: string }>(
            `insert into memories (user_id, source_kind, content_hash, title, search_text)
             values ($1, 'note', 'fts1', 'Lemon pasta', 'Creamy lemon garlic pasta with parmesan and olive oil') returning id`,
            [alice],
          ),
        )
      ).rows[0].id;
      await t.asUser(alice, (q) =>
        q(`insert into memories (user_id, source_kind, content_hash, title, search_text) values ($1, 'note', 'fts2', 'Index tips', 'Postgres B-tree and GIN index tuning with EXPLAIN ANALYZE')`, [alice]),
      );
    });
    it("finds a memory by what it says, with stemming", async () => {
      expect(await rank(alice, "garlic")).toEqual([pasta]);
      expect(await rank(alice, "indexes")).toHaveLength(1); // "indexes" matches "index"
    });
    it("understands quoted and negated terms (websearch syntax)", async () => {
      expect(await rank(alice, '"lemon garlic"')).toEqual([pasta]);
      expect(await rank(alice, "pasta -parmesan")).toEqual([]);
    });
    it("never returns another user's memories", async () => {
      expect(await rank(bob, "garlic pasta")).toEqual([]);
    });
    it("returns nothing for stopword-only, empty or odd input instead of erroring", async () => {
      for (const q of ["the", "", "   ", "'; drop table memories; --", "((("]) expect(await rank(alice, q)).toEqual([]);
    });
    it("is not callable anonymously", async () => {
      await expect(t.asAnon((q) => q("select * from search_memories_fts('pasta')"))).rejects.toThrow(/permission denied/i);
    });
  });
});
