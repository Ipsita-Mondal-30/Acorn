import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { supabaseStore } from "@/lib/backends/supabase";
import { StoreError } from "@/lib/backends/types";

// MAPPING ONLY. A fake supabase-js client checks what supabaseStore sends and how it reads replies. It proves nothing
// about pgvector: that is tests/pgvector.integration.test.ts, against a real PostgreSQL.

type Q = {
  select: (...a: unknown[]) => Q;
  eq: (...a: unknown[]) => Q;
  limit: (...a: unknown[]) => Q;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  upsert: (...a: unknown[]) => Promise<{ data: null; error: null }>;
  then: (res: (v: unknown) => unknown) => unknown;
};
type Call = { table?: string; op: string; args: unknown[] };
function fakeClient(replies: { memory?: unknown; hashes?: unknown[]; rpc?: unknown; rpcError?: { message: string; code: string } }) {
  const calls: Call[] = [];
  const chain = (table: string): Q => {
    const q: Q = {
      select: (...a: unknown[]) => (calls.push({ table, op: "select", args: a }), q),
      eq: (...a: unknown[]) => (calls.push({ table, op: "eq", args: a }), q),
      limit: (...a: unknown[]) => (calls.push({ table, op: "limit", args: a }), q),
      maybeSingle: () => Promise.resolve({ data: replies.memory ?? null, error: null }),
      upsert: (...a: unknown[]) => (calls.push({ table, op: "upsert", args: a }), Promise.resolve({ data: null, error: null })),
      then: (res: (v: unknown) => unknown) => res({ data: replies.hashes ?? [], error: null }),
    };
    return q;
  };
  const client = {
    from: chain,
    rpc: (fn: string, args: unknown) => (calls.push({ op: `rpc:${fn}`, args: [args] }), Promise.resolve(replies.rpcError ? { data: null, error: replies.rpcError } : { data: replies.rpc ?? [], error: null })),
  };
  return { client: client as never, calls };
}

const user = randomUUID();
const mem = randomUUID();

describe("supabaseStore embeddings (request/response mapping)", () => {
  it("saves a vector as pgvector text with its provider, model, dims and hash", async () => {
    const { client, calls } = fakeClient({ memory: { id: mem } });
    // rowToMemory isn't reached: saveEmbedding only needs to know the memory is visible
    const store = supabaseStore(client, user);
    expect(await store.saveEmbedding(mem, { provider: "http", model: "m", vector: [0.5, -1, 2], sourceHash: "h" })).toBe(true);
    const up = calls.find((c) => c.op === "upsert")!;
    expect(up.table).toBe("memory_embeddings");
    expect(up.args[0]).toEqual({ memory_id: mem, user_id: user, provider: "http", model: "m", dims: 3, embedding_vec: "[0.5,-1,2]", source_hash: "h" });
    expect(up.args[1]).toEqual({ onConflict: "memory_id,model" });
  });

  it("refuses empty, NaN and all-zero vectors before any request", async () => {
    const { client, calls } = fakeClient({ memory: { id: mem } });
    const store = supabaseStore(client, user);
    for (const vector of [[], [NaN, 1], [Infinity], [0, 0, 0]]) {
      await expect(store.saveEmbedding(mem, { provider: "p", model: "m", vector, sourceHash: "h" })).rejects.toBeInstanceOf(StoreError);
      await expect(store.similarMemories("m", vector, { limit: 5 })).rejects.toBeInstanceOf(StoreError);
    }
    expect(calls).toEqual([]);
  });

  it("says false (and writes nothing) for a memory that isn't visible to the user, or isn't a uuid", async () => {
    const { client, calls } = fakeClient({ memory: null });
    const store = supabaseStore(client, user);
    expect(await store.saveEmbedding(mem, { provider: "p", model: "m", vector: [1], sourceHash: "h" })).toBe(false);
    expect(await store.saveEmbedding("not-a-uuid", { provider: "p", model: "m", vector: [1], sourceHash: "h" })).toBe(false);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("calls match_memories with the model, vector text, limit and threshold, and maps the rows", async () => {
    const { client, calls } = fakeClient({ rpc: [{ memory_id: "a", similarity: 0.9 }, { memory_id: "b", similarity: 0.4 }] });
    const got = await supabaseStore(client, user).similarMemories("m", [1, 2], { limit: 7, minSimilarity: 0.3 });
    expect([...got]).toEqual([["a", 0.9], ["b", 0.4]]);
    expect(calls[0]).toEqual({ op: "rpc:match_memories", args: [{ p_model: "m", p_query: "[1,2]", p_limit: 7, p_min_similarity: 0.3 }] });
    await supabaseStore(client, user).similarMemories("m", [1], { limit: 1 });
    expect((calls[1].args[0] as { p_min_similarity: unknown }).p_min_similarity).toBeNull();
  });

  it("a database error (e.g. a dimension mismatch) becomes a safe StoreError without the database's words", async () => {
    const { client } = fakeClient({ rpcError: { message: "query vector has 2 dimensions but model m stores 3 dimensions", code: "22023" } });
    const err = await supabaseStore(client, user).similarMemories("m", [1, 2], { limit: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.message).not.toMatch(/dimensions/);
  });

  it("lists which memories already have a vector, by hash", async () => {
    const { client, calls } = fakeClient({ hashes: [{ memory_id: "a", source_hash: "h1" }] });
    const got = await supabaseStore(client, user).embeddingHashes("m");
    expect([...got]).toEqual([["a", "h1"]]);
    expect(calls.find((c) => c.op === "eq")?.args).toEqual(["model", "m"]);
  });
});
