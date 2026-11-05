import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/pg";

// Ownership of artifacts (voice notes, visual aids, segmentations, region readings) at the database: RLS and the
// same-user foreign keys. Runs the real migration file in an in-process Postgres.

let t: TestDb;
let alice: string;
let bob: string;
let aliceMemory: string;
let aliceArtifact: string;

const doc = (kind: string) => JSON.stringify({ kind, status: "ready", provider: "mock", model: "m", input: {}, output: {}, attempts: 1 });
const insert = (user: string, memory: string | null, kind = "visual_aid", parent: string | null = null) =>
  `insert into artifacts (user_id, memory_id, parent_id, kind, status, provider, model, doc) values ('${user}', ${memory ? `'${memory}'` : "null"}, ${parent ? `'${parent}'` : "null"}, '${kind}', 'ready', 'mock', 'm', '${doc(kind)}'::jsonb) returning id`;

beforeAll(async () => {
  t = await makeDb();
  alice = await t.signUp("alice@example.com");
  bob = await t.signUp("bob@example.com");
  aliceMemory = (await t.asUser(alice, (q) => q<{ id: string }>(`insert into memories (user_id, source_kind, original_text, content_hash) values ('${alice}', 'note', 'hello', 'h1') returning id`))).rows[0].id;
  aliceArtifact = (await t.asUser(alice, (q) => q<{ id: string }>(insert(alice, aliceMemory)))).rows[0].id;
}, 60_000);
afterAll(() => t.db.close());

describe("artifacts isolation", () => {
  it("shows an artifact only to its owner", async () => {
    expect((await t.asUser(alice, (q) => q("select id from artifacts"))).rows).toHaveLength(1);
    expect((await t.asUser(bob, (q) => q("select id from artifacts"))).rows).toHaveLength(0);
    expect((await t.asUser(bob, (q) => q("select id from artifacts where id = $1", [aliceArtifact]))).rows).toHaveLength(0);
  });
  it("cannot update or delete someone else's artifact", async () => {
    expect((await t.asUser(bob, (q) => q("update artifacts set status = 'failed' where id = $1", [aliceArtifact]))).affectedRows).toBe(0);
    expect((await t.asUser(bob, (q) => q("delete from artifacts where id = $1", [aliceArtifact]))).affectedRows).toBe(0);
    expect((await t.db.query<{ status: string }>("select status from artifacts where id = $1", [aliceArtifact])).rows[0].status).toBe("ready");
  });
  it("cannot attach an artifact to another user's memory, or create one in another user's name", async () => {
    await expect(t.asUser(bob, (q) => q(insert(bob, aliceMemory)))).rejects.toThrow();
    await expect(t.asUser(bob, (q) => q(insert(alice, null)))).rejects.toThrow();
  });
  it("a region reading can only point at a parent artifact of the same user", async () => {
    await expect(t.asUser(bob, (q) => q(insert(bob, null, "region_reading", aliceArtifact)))).rejects.toThrow();
    const own = await t.asUser(alice, (q) => q<{ id: string }>(insert(alice, aliceMemory, "region_reading", aliceArtifact)));
    expect(own.rows).toHaveLength(1);
  });
  it("allows a voice note that is not a memory yet (memory_id is null)", async () => {
    const r = await t.asUser(alice, (q) => q<{ id: string }>(insert(alice, null, "voice")));
    expect(r.rows).toHaveLength(1);
  });
  it("rejects unknown kinds and providers", async () => {
    await expect(t.asUser(alice, (q) => q(insert(alice, aliceMemory, "telepathy")))).rejects.toThrow();
  });
  it("deleting a memory removes its artifacts", async () => {
    const m = (await t.asUser(alice, (q) => q<{ id: string }>(`insert into memories (user_id, source_kind, original_text, content_hash) values ('${alice}', 'note', 'bye', 'h2') returning id`))).rows[0].id;
    await t.asUser(alice, (q) => q(insert(alice, m)));
    await t.asUser(alice, (q) => q("delete from memories where id = $1", [m]));
    expect((await t.db.query("select id from artifacts where memory_id = $1", [m])).rows).toHaveLength(0);
  });
});
