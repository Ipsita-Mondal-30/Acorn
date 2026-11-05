import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/backends/types";
import { storageMode } from "@/lib/env";
import { ConfigError, readSupabaseConfig } from "@/lib/supabase/config";
import { safeNext } from "@/lib/supabase/redirect";
import { makeDb, type TestDb } from "./helpers/pg";
import { pgrestClient, type Bucket } from "./helpers/pgrest";

// "Who is signed in" is the only thing faked here. Everything else is the real app code over the real schema.
let t: TestDb;
let current: string | null = null;
const storage: Bucket = new Map();
let injected: ReturnType<typeof pgrestClient> | null = null;

// route handlers call connection(), which only works inside a real Next request
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("@/lib/supabase/user", () => ({
  currentUser: async () => (current ? { id: current, email: `${current}@example.com` } : null),
  requireUser: async () => {
    if (!current) throw new (await import("@/lib/backends/types")).AuthError();
    return { id: current, email: null };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => (injected ?? pgrestClient(t, current, { storage })).client,
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 24 }, (_, i) => i)]);
const saved = { ...process.env };
let alice: string;
let bob: string;

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
  injected = null;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  process.env = saved;
  await t.db.close();
});

describe("environment validation", () => {
  it("runs in local demo mode when Supabase isn't configured", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(readSupabaseConfig()).toBeNull();
    expect(storageMode()).toBe("local");
  });
  it("treats blank placeholders from .env.example as unset", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "  ";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(storageMode()).toBe("local");
  });
  it("uses the cloud when both values are set", () => {
    expect(storageMode()).toBe("supabase");
    expect(readSupabaseConfig()).toEqual({ url: "https://abc.supabase.co", anonKey: "anon-key" });
  });
  it("fails loudly when only one value is set (never a silent local fallback)", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => storageMode()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY missing/);
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => storageMode()).toThrow(ConfigError);
  });
  it("rejects a malformed or insecure URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not a url";
    expect(() => storageMode()).toThrow(/valid URL/);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://abc.supabase.co";
    expect(() => storageMode()).toThrow(/https/);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    expect(storageMode()).toBe("supabase"); // local Supabase is fine over http
  });
  it("lets ACORN_STORAGE=local force the demo store, and =supabase demand the cloud", () => {
    process.env.ACORN_STORAGE = "local";
    expect(storageMode()).toBe("local");
    process.env.ACORN_STORAGE = "supabase";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => storageMode()).toThrow(/ACORN_STORAGE=supabase/);
    process.env.ACORN_STORAGE = "bogus";
    expect(() => storageMode()).toThrow(/Invalid environment/);
  });
  it("never exposes the service-role key through a NEXT_PUBLIC variable", () => {
    expect(JSON.stringify(readSupabaseConfig())).not.toMatch(/service/i);
  });
});

describe("post-login redirects", () => {
  it("only allows same-site paths", () => {
    expect(safeNext("/memories/1?x=2")).toBe("/memories/1?x=2");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined, "/a\nb"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("unauthorized requests", () => {
  it("is refused at the store boundary with AuthError", async () => {
    const store = await import("@/lib/store");
    await expect(store.listMemories()).rejects.toBeInstanceOf(AuthError);
    await expect(store.getMemory(randomUUID())).rejects.toBeInstanceOf(AuthError);
    await expect(store.upsertAction({} as never)).rejects.toBeInstanceOf(AuthError);
  });
  it("answers API routes with 401, never data", async () => {
    const list = await import("@/app/api/memories/route");
    const one = await import("@/app/api/memories/[id]/route");
    const actions = await import("@/app/api/actions/route");
    const profile = await import("@/app/api/profile/route");
    const id = randomUUID();
    const ctx = { params: Promise.resolve({ id }) } as never;
    const json = (body: unknown) => new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const results = await Promise.all([
      list.GET(),
      list.POST(json({ kind: "note", text: "hi" })),
      one.GET(new Request("http://x"), ctx),
      one.DELETE(new Request("http://x", { method: "DELETE" }), ctx),
      actions.GET(new Request("http://x/api/actions")),
      profile.GET(),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
  it("answers the file route with 401 for a signed-out visitor", async () => {
    const files = await import("@/app/api/files/[name]/route");
    const res = await files.GET(new Request("http://x"), { params: Promise.resolve({ name: `${randomUUID()}.png` }) } as never);
    expect(res.status).toBe(401);
  });
  it("is not fooled by a made-up user id in the request", async () => {
    current = null; // no session, whatever headers or bodies claim
    const list = await import("@/app/api/memories/route");
    const res = await list.POST(
      new Request("http://x", { method: "POST", headers: { "content-type": "application/json", "x-user-id": alice }, body: JSON.stringify({ kind: "note", text: "x", user_id: alice }) }),
    );
    expect(res.status).toBe(401);
  });
});

describe("end to end in cloud mode", () => {
  it("creates, uploads, searches, corrects, acts, signs out and back in, then deletes", async () => {
    const { captureMemory, removeMemory } = await import("@/lib/process");
    const { listMemories, getMemory, listActions, upsertAction, updateMemory } = await import("@/lib/store");
    const { searchMemories } = await import("@/lib/search");
    const { proposeAction } = await import("@/lib/actions");
    const { applyCorrection } = await import("@/lib/schema");

    current = alice;
    // a note
    const noted = await captureMemory({ kind: "note", text: `Try the lemon pasta recipe ${randomUUID()}` });
    expect(noted.created).toBe(true);
    expect(noted.memory.status).toBe("ready");
    expect(noted.memory.extraction?.producedBy.provider).toBe("mock"); // demo mode: no paid call, labelled as mock

    // an image: stored privately under the user's folder
    const img = await captureMemory({ kind: "image", bytes: PNG, originalName: "pasta.png", text: "pasta screenshot" });
    const fileName = img.memory.source.fileName!;
    expect([...storage.keys()]).toContain(`${alice}/${fileName}`);
    const row = await t.db.query<{ storage_path: string }>("select storage_path from memories where id = $1", [img.memory.id]);
    expect(row.rows[0].storage_path).toBe(`${alice}/${fileName}`);

    // the same image again is a duplicate: no second memory, and no orphan file
    const before = storage.size;
    const dup = await captureMemory({ kind: "image", bytes: PNG, originalName: "again.png", text: "pasta screenshot" });
    expect(dup.created).toBe(false);
    expect(storage.size).toBe(before);

    // search finds the user's own memories
    const all = await listMemories();
    expect(searchMemories(all, "pasta", new Date()).map((h) => h.memory.id)).toContain(noted.memory.id);

    // correction + action
    await updateMemory(noted.memory.id, (m) => applyCorrection(m, { title: "Lemon pasta" }, new Date()));
    expect((await getMemory(noted.memory.id))?.overrides.title).toBe("Lemon pasta");
    const action = { ...proposeAction(noted.memory, { title: "Cook it Friday" }, new Date()), id: randomUUID() };
    await upsertAction(action);
    expect((await listActions(noted.memory.id)).map((a) => a.title)).toEqual(["Cook it Friday"]);

    // sign out → nothing; someone else signs in → nothing of Alice's; Alice signs back in → everything is still there
    current = null;
    await expect(listMemories()).rejects.toBeInstanceOf(AuthError);
    current = bob;
    expect(await listMemories()).toEqual([]);
    expect(await getMemory(noted.memory.id)).toBeNull();
    expect(await removeMemory(img.memory.id)).toBe(false);
    expect(storage.size).toBe(before); // Bob's delete attempt didn't touch Alice's image
    current = alice;
    const back = await listMemories();
    expect(back.map((m) => m.id).sort()).toEqual([noted.memory.id, img.memory.id].sort());
    expect((await getMemory(noted.memory.id))?.overrides.title).toBe("Lemon pasta");

    // deleting the image memory removes its file and its row
    expect(await removeMemory(img.memory.id)).toBe(true);
    expect([...storage.keys()].some((k) => k.endsWith(fileName))).toBe(false);
    expect(await getMemory(img.memory.id)).toBeNull();
  }, 30_000);

  it("serves a private image through a signed URL, only to its owner", async () => {
    const { captureMemory } = await import("@/lib/process");
    const files = await import("@/app/api/files/[name]/route");
    current = alice;
    const { memory } = await captureMemory({ kind: "image", bytes: new Uint8Array([...PNG, 99]), originalName: "x.png" });
    const name = memory.source.fileName!;
    const mine = await files.GET(new Request("http://x"), { params: Promise.resolve({ name }) } as never);
    expect(mine.status).toBe(302);
    expect(mine.headers.get("location")).toContain(`/sign/memory-images/${alice}/${name}`);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");

    current = bob;
    const theirs = await files.GET(new Request("http://x"), { params: Promise.resolve({ name }) } as never);
    expect(theirs.status).toBe(404);
  });

  it("rejects bad uploads before anything is stored", async () => {
    const { captureMemory } = await import("@/lib/process");
    const { UploadError } = await import("@/lib/uploads");
    current = alice;
    const before = storage.size;
    await expect(captureMemory({ kind: "image", bytes: new Uint8Array(0), originalName: "e.png" })).rejects.toBeInstanceOf(UploadError);
    await expect(captureMemory({ kind: "image", bytes: new TextEncoder().encode("<script>alert(1)</script>"), originalName: "evil.png" })).rejects.toThrow(/PNG, JPEG, WebP or GIF/);
    await expect(captureMemory({ kind: "image", bytes: Uint8Array.from({ length: 8 * 1024 * 1024 + 1 }, (_, i) => PNG[i] ?? 1), originalName: "big.png" })).rejects.toThrow(/8 MB/);
    expect(storage.size).toBe(before);
  });

  it("reports a failed upload without saving a memory", async () => {
    const { captureMemory } = await import("@/lib/process");
    const { UploadError } = await import("@/lib/uploads");
    current = alice;
    injected = pgrestClient(t, alice, { storage });
    injected.failNext(/storage\.upload/, { message: "bucket exploded: internal-detail" });
    const count = (await t.db.query("select 1 from memories where user_id = $1", [alice])).rows.length;
    const err = await captureMemory({ kind: "image", bytes: new Uint8Array([...PNG, 7]), originalName: "f.png" }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).not.toMatch(/internal-detail/);
    expect((await t.db.query("select 1 from memories where user_id = $1", [alice])).rows.length).toBe(count);
  });

  it("removes the uploaded file when saving the memory fails", async () => {
    const { captureMemory } = await import("@/lib/process");
    current = alice;
    injected = pgrestClient(t, alice, { storage });
    injected.failNext(/insert into public\.memories/, { message: "db down" });
    const before = storage.size;
    await expect(captureMemory({ kind: "image", bytes: new Uint8Array([...PNG, 8]), originalName: "g.png" })).rejects.toThrow();
    expect(storage.size).toBe(before); // no orphan
  });

  it("shows a database outage to API callers as a clean 503", async () => {
    const list = await import("@/app/api/memories/route");
    current = alice;
    injected = pgrestClient(t, alice, { storage });
    injected.failNext(/from \(select \* from public\.memories/, { message: "db down" });
    const res = await list.GET();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/db down/);
  });
});

describe("proxy (session gate)", () => {
  const call = async (path: string) => {
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(`http://localhost:3000${path}`));
  };
  it("sends a signed-out visitor to /login and remembers where they were going", async () => {
    const res = await call("/memories?q=1");
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!, "http://localhost:3000"); // the Location is relative on purpose
    expect(res.headers.get("location")).toMatch(/^\/login\?/);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/memories?q=1");
  });
  it("lets public pages and API routes through (APIs answer 401 themselves)", async () => {
    for (const p of ["/login", "/signup", "/auth/callback", "/api/memories"]) {
      expect((await call(p)).status, p).toBe(200);
    }
  });
  it("does nothing in local demo mode", async () => {
    process.env.ACORN_STORAGE = "local";
    expect((await call("/memories")).status).toBe(200);
    delete process.env.ACORN_STORAGE;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect((await call("/memories")).status).toBe(200);
  });
  it("refuses to run half-configured instead of silently opening up", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await call("/memories");
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/misconfigured/);
  });
});

describe("logout", () => {
  it("only accepts same-origin POSTs", async () => {
    const { POST } = await import("@/app/auth/logout/route");
    const res = await POST(new Request("http://localhost:3000/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
  });

  it("signs the session out server-side and sends the browser to /login", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    injected = { client: { auth: { signOut } } } as never;
    const { POST } = await import("@/app/auth/logout/route");
    const res = await POST(new Request("http://localhost:3000/auth/logout", { method: "POST", headers: { origin: "http://localhost:3000" } }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!, "http://localhost:3000").pathname).toBe("/login");
  });

  it("a link (GET) can't log you out", async () => {
    const { POST, ...rest } = await import("@/app/auth/logout/route");
    expect(POST).toBeTypeOf("function");
    expect(Object.keys(rest)).not.toContain("GET");
  });

  it("after logout there is no user: private APIs answer 401 and pages redirect to /login", async () => {
    current = alice;
    const list = await import("@/app/api/memories/route");
    expect((await list.GET()).status).toBe(200);
    current = null; // what the server sees once the cookie is gone
    expect((await list.GET()).status).toBe(401);
    const emb = await import("@/app/api/embeddings/route");
    expect((await emb.GET()).status).toBe(401);
    expect((await emb.POST()).status).toBe(401);
    const { proxy } = await import("@/proxy");
    for (const p of ["/", "/memories", "/capture", "/search?q=x", `/memories/${randomUUID()}`]) {
      const res = await proxy(new NextRequest(`http://localhost:3000${p}`));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!, "http://localhost:3000").pathname).toBe("/login");
    }
  });
});

describe("multimodal memories in cloud mode", () => {
  const post = (body: unknown) => new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sample = async (id: string) => {
    const { POST } = await import("@/app/api/samples/route");
    const res = await POST(post({ id }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { memory: import("@/lib/schema").Memory }).memory;
  };

  it("requires sign-in for answers, samples, intent and plan requests", async () => {
    const answer = await import("@/app/api/search/answer/route");
    const samples = await import("@/app/api/samples/route");
    const one = await import("@/app/api/memories/[id]/route");
    const ctx = { params: Promise.resolve({ id: randomUUID() }) } as never;
    current = null;
    const statuses = (
      await Promise.all([
        answer.POST(post({ q: "what were the ingredients" })),
        samples.POST(post({ id: "job-listing" })),
        one.POST(post({ op: "intent" }), ctx),
        one.POST(post({ op: "plan" }), ctx),
      ])
    ).map((r) => r.status);
    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it("stores a PDF privately, finds it by full-text search, answers from it with page citations, and keeps it away from other users", async () => {
    const store = await import("@/lib/store");
    const answer = await import("@/app/api/search/answer/route");
    const files = await import("@/app/api/files/[name]/route");

    current = alice;
    const paper = await sample("paper-pdf");
    expect(paper.source).toMatchObject({ kind: "document", mimeType: "application/pdf" });
    const name = paper.source.fileName!;
    expect(name.endsWith(".pdf")).toBe(true);
    expect(storage.has(`${alice}/${name}`)).toBe(true);
    expect(storage.get(`${alice}/${name}`)!.type).toBe("application/pdf");

    const row = await t.db.query<{ source_kind: string; storage_path: string; search_text: string }>("select source_kind, storage_path, search_text from memories where id = $1", [paper.id]);
    expect(row.rows[0]).toMatchObject({ source_kind: "document", storage_path: `${alice}/${name}` });
    expect(row.rows[0].search_text).toMatch(/Sparse Routing/); // what the memory says is indexed for search

    // PostgreSQL full-text search finds it (stemming: "routing" matches "route"-family words) and ranks it
    const ranks = await store.fullTextIds("sparse routing recall");
    expect(ranks.has(paper.id)).toBe(true);
    expect(ranks.get(paper.id)!).toBeGreaterThan(0);

    // an evidence-grounded answer through the real route, citing the stored quote and the page it came from
    const res = await answer.POST(post({ q: "How much did recall improve with sparse routing?" }));
    const body = (await res.json()) as import("@/lib/answer").AnswerResult;
    expect(res.status).toBe(200);
    expect(body.matches[0].memoryId).toBe(paper.id);
    expect(body.noReliableMatch).toBe(false);
    expect(body.citations.every((c) => c.memoryId === paper.id)).toBe(true);

    // the original PDF is served through a short-lived signed URL, to its owner only
    const mine = await files.GET(new Request("http://x"), { params: Promise.resolve({ name }) } as never);
    expect(mine.status).toBe(302);
    expect(mine.headers.get("location")).toContain(`/sign/memory-images/${alice}/${name}`);

    current = bob;
    expect((await store.fullTextIds("sparse routing recall")).size).toBe(0);
    const theirs = await (await answer.POST(post({ q: "How much did recall improve with sparse routing?" }))).json();
    expect(theirs).toMatchObject({ noReliableMatch: true, citations: [], matches: [] });
    expect((await files.GET(new Request("http://x"), { params: Promise.resolve({ name }) } as never)).status).toBe(404);
  });

  it("keeps the database full-text index private even for odd queries", async () => {
    const store = await import("@/lib/store");
    current = bob;
    for (const q of ["'; drop table memories; --", "((("]) expect((await store.fullTextIds(q)).size, q).toBe(0);
    expect((await t.db.query("select count(*)::int as n from memories")).rows[0]).toMatchObject({ n: expect.any(Number) }); // the table is still there
  });

  it("rejects a PDF-shaped upload that isn't a PDF, and an oversized one, before storing anything", async () => {
    const { captureMemory } = await import("@/lib/process");
    const { UploadError } = await import("@/lib/uploads");
    current = alice;
    const before = storage.size;
    await expect(captureMemory({ kind: "document", bytes: new TextEncoder().encode("not a pdf"), originalName: "fake.pdf" })).rejects.toBeInstanceOf(UploadError);
    await expect(captureMemory({ kind: "document", bytes: new Uint8Array(15 * 1024 * 1024 + 1).fill(37), originalName: "big.pdf" })).rejects.toBeInstanceOf(UploadError);
    const pdfBigHeader = new Uint8Array(15 * 1024 * 1024 + 1);
    pdfBigHeader.set(new TextEncoder().encode("%PDF-1.4"));
    await expect(captureMemory({ kind: "document", bytes: pdfBigHeader, originalName: "big.pdf" })).rejects.toThrow(/15 MB/);
    // a PDF can't be saved as an "image", nor an image as a document
    await expect(captureMemory({ kind: "image", bytes: new TextEncoder().encode("%PDF-1.4 x"), originalName: "x.png" })).rejects.toThrow(/images/);
    expect(storage.size).toBe(before);
  });
});
