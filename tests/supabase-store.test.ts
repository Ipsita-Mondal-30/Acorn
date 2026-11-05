import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { supabaseBackend, supabaseStore } from "@/lib/backends/supabase";
import { StoreError } from "@/lib/backends/types";
import { proposeAction, transition } from "@/lib/actions";
import { hashContent } from "@/lib/store";
import type { Memory } from "@/lib/schema";
import { makeDb, type TestDb } from "./helpers/pg";
import { pgrestClient } from "./helpers/pgrest";

let t: TestDb;
let alice: string;
let bob: string;

const note = (text: string, over: Partial<Memory> = {}): Memory => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), createdAt: now, updatedAt: now, source: { kind: "note", text }, status: "pending",
    contentHash: hashContent("note", undefined, text), extraction: null, overrides: {}, isSample: false, ...over,
  };
};
const storeFor = (user: string) => supabaseStore(pgrestClient(t, user).client, user);

beforeAll(async () => {
  t = await makeDb();
  alice = await t.signUp("alice@example.com");
  bob = await t.signUp("bob@example.com");
}, 60_000);
afterAll(() => t.db.close());

describe("memory CRUD through the real store code", () => {
  it("creates, reads, lists, updates and deletes a memory", async () => {
    const s = storeFor(alice);
    const m = note("buy oat milk");
    const created = await s.insertMemory(m);
    expect(created.created).toBe(true);
    expect(created.memory).toMatchObject({ id: m.id, status: "pending", source: { kind: "note", text: "buy oat milk" } });

    expect((await s.getMemory(m.id))?.source.text).toBe("buy oat milk");
    expect((await s.listMemories()).map((x) => x.id)).toContain(m.id);

    const updated = await s.updateMemory(m.id, (x) => ({ ...x, overrides: { title: "Groceries" }, userIntent: { kind: "buy", status: "set", at: new Date().toISOString() } }));
    expect(updated?.overrides.title).toBe("Groceries");
    expect(updated?.userIntent?.kind).toBe("buy");
    const row = await t.db.query<{ title: string; intent_kind: string; intent_status: string }>("select title, intent_kind, intent_status from memories where id = $1", [m.id]);
    expect(row.rows[0]).toEqual({ title: "Groceries", intent_kind: "buy", intent_status: "set" });

    expect((await s.deleteMemory(m.id))?.id).toBe(m.id);
    expect(await s.getMemory(m.id)).toBeNull();
    expect(await s.deleteMemory(m.id)).toBeNull();
  });

  it("round-trips a full extraction, corrections and intent decision losslessly", async () => {
    const { buildSeed } = await import("@/lib/seed");
    const sample = buildSeed(new Date()).memories.find((x) => x.extraction?.intentGuess)!;
    const m: Memory = { ...sample, id: randomUUID(), isSample: false, contentHash: "rt-" + sample.id, overrides: { title: "Mine", deadline: null }, userIntent: { kind: "none", status: "dismissed", at: "2026-10-31T00:00:00.000Z" }, source: { kind: "note", text: sample.source.text ?? "x" } };
    const s = storeFor(alice);
    await s.insertMemory(m);
    const back = (await s.getMemory(m.id))!;
    expect(back.extraction).toEqual(m.extraction);
    expect(back.overrides).toEqual(m.overrides);
    expect(back.userIntent).toEqual(m.userIntent);
    await s.deleteMemory(m.id);
  });

  it("is idempotent for identical content and never duplicates", async () => {
    const s = storeFor(alice);
    const a = await s.insertMemory(note("same thing"));
    const b = await s.insertMemory(note("same thing"));
    expect(b.created).toBe(false);
    expect(b.memory.id).toBe(a.memory.id);
  });

  it("treats a malformed id as not found rather than a database error", async () => {
    const s = storeFor(alice);
    expect(await s.getMemory("not-a-uuid")).toBeNull();
    expect(await s.deleteMemory("../etc/passwd")).toBeNull();
    expect(await s.updateMemory("nope", (m) => m)).toBeNull();
    expect(await s.listActions("not-a-uuid")).toEqual([]);
    expect(await s.getAction("x")).toBeNull();
    expect(await s.claimProcessing("x", {})).toEqual({ memory: null, claimed: false });
  });

  it("keeps users apart: one user can't read, change or delete another's memory", async () => {
    const a = storeFor(alice);
    const b = storeFor(bob);
    const m = (await a.insertMemory(note("alice private"))).memory;
    expect(await b.getMemory(m.id)).toBeNull();
    expect((await b.listMemories()).map((x) => x.id)).not.toContain(m.id);
    expect(await b.updateMemory(m.id, (x) => ({ ...x, overrides: { title: "pwned" } }))).toBeNull();
    expect(await b.deleteMemory(m.id)).toBeNull();
    expect((await a.getMemory(m.id))?.overrides.title).toBeUndefined();
  });

  it("derives tags from topics, without letting tag trouble fail the update", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("topics please"))).memory;
    const { buildSeed } = await import("@/lib/seed");
    const extraction = { ...buildSeed(new Date()).memories.find((x) => x.extraction)!.extraction!, topics: ["Cooking", "pasta ", "cooking"] };
    await s.updateMemory(m.id, (x) => ({ ...x, status: "ready", extraction }));
    const tags = await t.db.query<{ name: string }>("select t.name from memory_tags mt join tags t on t.id = mt.tag_id where mt.memory_id = $1 order by 1", [m.id]);
    expect(tags.rows.map((r) => r.name)).toEqual(["cooking", "pasta"]);

    const failing = pgrestClient(t, alice);
    const fs = supabaseStore(failing.client, alice);
    failing.failNext(/insert into public\.tags/, { message: "tags down" });
    const ok = await fs.updateMemory(m.id, (x) => ({ ...x, overrides: { title: "still saved" } }));
    expect(ok?.overrides.title).toBe("still saved");
    expect(failing.pendingFailures()).toBe(0); // the injected failure really was hit
  });
});

describe("concurrency", () => {
  it("lets exactly one of 8 racing callers claim processing", async () => {
    const m = (await storeFor(alice).insertMemory(note("race me"))).memory;
    const results = await Promise.all(Array.from({ length: 8 }, () => storeFor(alice).claimProcessing(m.id, {})));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.every((r) => r.memory?.id === m.id)).toBe(true);
  });

  it("applies concurrent updates without losing any (compare-and-swap with retry)", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("cas"))).memory;
    const fields = ["title", "summary", "intent"] as const;
    await Promise.all(fields.map((f) => storeFor(alice).updateMemory(m.id, (x) => ({ ...x, overrides: { ...x.overrides, [f]: `v-${f}` } }))));
    const o = (await s.getMemory(m.id))!.overrides;
    expect(o).toEqual({ title: "v-title", summary: "v-summary", intent: "v-intent" });
  });

  it("lets only one of 10 simultaneous 'complete' requests win on an action", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("action race"))).memory;
    let a = proposeAction(m, { title: "Do it", kind: "simulated" }, new Date());
    a = { ...a, id: randomUUID() };
    await s.upsertAction(a);
    const attempt = () => storeFor(alice).mutateAction(a.id, (cur) => {
      if (cur.state === "completed") throw new Error("already completed");
      let n = cur;
      if (n.state === "proposed") n = transition(n, "awaiting_approval", {}, new Date());
      if (n.state === "awaiting_approval") n = transition(n, "approved", {}, new Date());
      if (n.state === "approved") n = transition(n, "in_progress", {}, new Date());
      return transition(n, "completed", {}, new Date());
    });
    const out = await Promise.allSettled(Array.from({ length: 10 }, attempt));
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.getAction(a.id))?.state).toBe("completed");
  });
});

describe("actions", () => {
  it("creates, updates and isolates actions", async () => {
    const a = storeFor(alice);
    const b = storeFor(bob);
    const m = (await a.insertMemory(note("action memory"))).memory;
    const action = { ...proposeAction(m, { title: "Email Priya", detail: "short note", kind: "suggested" }, new Date()), id: randomUUID() };
    const saved = await a.upsertAction(action);
    expect(saved).toMatchObject({ id: action.id, memoryId: m.id, title: "Email Priya", kind: "suggested", state: "proposed" });
    expect((await a.listActions(m.id)).map((x) => x.id)).toEqual([action.id]);

    const moved = await a.mutateAction(action.id, (x) => transition(x, "awaiting_approval", { note: "ready" }, new Date()));
    expect(moved?.state).toBe("awaiting_approval");
    const row = await t.db.query<{ approval_status: string }>("select approval_status from actions where id = $1", [action.id]);
    expect(row.rows[0].approval_status).toBe("pending");

    expect(await b.getAction(action.id)).toBeNull();
    expect(await b.listActions()).toEqual([]);
    expect(await b.mutateAction(action.id, (x) => ({ ...x, title: "pwned" }))).toBeNull();
    // and bob can't create an action against alice's memory
    await expect(b.upsertAction({ ...action, id: randomUUID() })).rejects.toBeInstanceOf(StoreError);
  });

  it("removes a memory's actions with it", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("cascade me"))).memory;
    const act = { ...proposeAction(m, { title: "x", kind: "suggested" }, new Date()), id: randomUUID() };
    await s.upsertAction(act);
    await s.deleteMemory(m.id);
    expect(await s.getAction(act.id)).toBeNull();
  });
});

describe("database errors", () => {
  it("turn into a safe StoreError without leaking details", async () => {
    const { client, failNext, pendingFailures: pending } = pgrestClient(t, alice);
    const s = supabaseStore(client, alice);
    failNext(/from \(select \* from public\.memories/, { message: 'relation "secret_internal_name" is on fire', code: "XX000" });
    const err = await s.listMemories().catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(pending()).toBe(0);
    expect(err.message).not.toMatch(/secret_internal_name|XX000/);
  });
  it("reports unreadable stored data instead of crashing", async () => {
    const m = (await storeFor(alice).insertMemory(note("corrupt me"))).memory;
    await t.db.query("update memories set structured_metadata = '{\"overrides\": 5}' where id = $1", [m.id]);
    await expect(storeFor(alice).getMemory(m.id)).rejects.toBeInstanceOf(StoreError);
  });
  it("gives a retryable error when an edit keeps losing the race", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("always conflicted"))).memory;
    // every attempt finds that someone else changed the row first
    await expect(
      s.updateMemory(m.id, (x) => {
        void t.db.query("update memories set summary = summary || '.' where id = $1", [m.id]);
        return { ...x, overrides: { title: "t" } };
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });
});

describe("files", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  it("stores under the user's folder, serves a signed URL, and refuses other users", async () => {
    const a = pgrestClient(t, alice);
    const fa = supabaseBackend(a.client, alice).files;
    const name = `${randomUUID()}.png`;
    await fa.put(name, bytes, "image/png");
    expect([...a.storage.keys()]).toEqual([`${alice}/${name}`]);
    expect(await fa.signedUrl!(name, 300)).toContain(`${alice}/${name}`);
    expect((await fa.get(name))?.mimeType).toBe("image/png");

    const fb = supabaseBackend(pgrestClient(t, bob, { storage: a.storage }).client, bob).files;
    expect(await fb.get(name)).toBeNull();
    expect(await fb.signedUrl!(name, 300)).toBeNull();
    await fb.remove(name);
    expect(a.storage.size).toBe(1);

    await fa.remove(name);
    expect(a.storage.size).toBe(0);
  });
  it("surfaces a failed upload as a safe error", async () => {
    const a = pgrestClient(t, alice);
    a.failNext(/storage\.upload/, { message: "bucket exploded: internal-detail" });
    const err = await supabaseBackend(a.client, alice).files.put(`${randomUUID()}.png`, bytes, "image/png").catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.message).not.toMatch(/internal-detail/);
  });
});

describe("artifacts through the real store code", () => {
  const artifact = (memoryId: string | null, over: Record<string, unknown> = {}) => {
    const now = new Date().toISOString();
    return { id: randomUUID(), memoryId, parentId: null, kind: "visual_aid" as const, status: "ready" as const, provider: "mock" as const, model: "mock-diagram", fileName: null, mimeType: null, input: {}, output: { title: "t" }, attempts: 1, error: null, latencyMs: 5, usage: null, confirmedMemoryId: null, createdAt: now, updatedAt: now, ...over };
  };
  it("saves, lists, mutates (compare-and-swap) and deletes, and keeps users apart", async () => {
    const s = storeFor(alice);
    const m = (await s.insertMemory(note("artifact host"))).memory;
    const a = await s.upsertArtifact(artifact(m.id));
    expect((await s.listArtifacts({ memoryId: m.id })).map((x) => x.id)).toEqual([a.id]);
    expect(await s.listArtifacts({ memoryId: m.id, kind: "voice" })).toEqual([]);
    const bumped = await s.mutateArtifact(a.id, (x) => ({ ...x, status: "failed", attempts: x.attempts + 1, error: { kind: "timeout", message: "slow", at: x.createdAt } }));
    expect(bumped).toMatchObject({ status: "failed", attempts: 2, error: { kind: "timeout" } });
    expect((await t.db.query<{ status: string }>("select status from artifacts where id = $1", [a.id])).rows[0].status).toBe("failed");
    // a voice note that isn't a memory yet
    const draft = await s.upsertArtifact(artifact(null, { kind: "voice" }));
    expect((await s.getArtifact(draft.id))?.memoryId).toBeNull();
    // another user sees none of it and can't change or remove it
    const other = storeFor(bob);
    expect(await other.getArtifact(a.id)).toBeNull();
    expect(await other.listArtifacts()).toEqual([]);
    expect(await other.deleteArtifact(a.id)).toBeNull();
    expect(await other.mutateArtifact(a.id, (x) => x)).toBeNull();
    expect((await s.deleteArtifact(a.id))?.id).toBe(a.id);
    expect(await s.getArtifact(a.id)).toBeNull();
    expect(await s.getArtifact("not-a-uuid")).toBeNull();
  });
});
