import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Several files in ONE share (Android can send many). Each is judged on its own bytes and size; one bad file never costs
// the others; duplicates are still caught; nothing is saved without a user.

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));
const gate = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock("@/lib/process", async (orig) => {
  const real = await orig<typeof import("@/lib/process")>();
  return { ...real, saveCapture: async (...a: Parameters<typeof real.saveCapture>) => { if (gate.failWith) throw gate.failWith; return real.saveCapture(...a); } };
});

import { MAX_SHARED_FILES, POST as share } from "@/app/share/route";
import { POST as capture } from "@/app/api/memories/route";
import { AuthError } from "@/lib/backends/types";
import { getMemory, listMemories } from "@/lib/store";
import { isHeic } from "@/lib/uploads";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (n = 16) => new Uint8Array([...PNG_HEAD, ...new TextEncoder().encode(randomUUID()), ...new Uint8Array(n)]);
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n% ${randomUUID()}\n%%EOF`);
const heic = () => new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0, ...new TextEncoder().encode(randomUUID())]);
let dir: string;
const saved = { ...process.env };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-multi-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo", AI_ENABLE_REAL_CALLS: "false" });
  delete process.env.META_API_KEY;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
beforeEach(() => {
  afterQueue.length = 0;
  gate.failWith = null;
});
afterAll(async () => {
  process.env = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const post = (files: { name: string; bytes: Uint8Array; type?: string }[], extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const x of files) f.append("file", new File([Buffer.from(x.bytes)], x.name, { type: x.type }));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return share(new Request("https://acorn.example/share", { method: "POST", body: f }));
};
const loc = (r: Response) => new URL(r.headers.get("location")!, "https://acorn.example");
const kinds = async (ids: string[]) => Promise.all(ids.map(async (id) => (await getMemory(id))!.source.kind));

describe("several files in one share", () => {
  it("saves every valid file, each with its own kind, and queues one reading per memory", async () => {
    const before = (await listMemories()).length;
    const res = await post([{ name: "a.png", bytes: png() }, { name: "b.pdf", bytes: pdf() }, { name: "c.png", bytes: png() }], { title: "Trip photos" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/memories\?/); // relative
    expect(loc(res).searchParams.get("shared")).toBe("3");
    expect(loc(res).searchParams.get("skipped")).toBeNull();
    const added = (await listMemories()).slice(0, 3);
    expect((await listMemories()).length).toBe(before + 3);
    expect(new Set(added.map((m) => m.source.kind))).toEqual(new Set(["image", "document"]));
    expect(added.every((m) => m.source.text === "Trip photos")).toBe(true); // the shared title is each file's caption
    expect(afterQueue.length).toBe(3);
  });

  it("validates each file independently: a bad file is skipped with its reason and the others are still saved", async () => {
    const res = await post([{ name: "ok.png", bytes: png() }, { name: "virus.exe", bytes: new TextEncoder().encode("MZ not an image") }, { name: "ok.pdf", bytes: pdf() }, { name: "phone.heic", bytes: heic() }]);
    const q = loc(res).searchParams;
    expect(loc(res).pathname).toBe("/memories");
    expect(q.get("shared")).toBe("2");
    expect(q.get("skipped")).toBe("2");
    expect(q.get("why")!.split(",").sort()).toEqual(["heic", "type"]);
  });

  it("a file that is too large for its own type does not affect the others (an 9 MB PDF is fine, a 9 MB image is not)", async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const bigPng = new Uint8Array([...PNG_HEAD, ...big.subarray(8)]);
    const bigPdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.4\n"), ...big.subarray(9)]);
    const res = await post([{ name: "huge.png", bytes: bigPng }, { name: "long.pdf", bytes: bigPdf }, { name: "small.png", bytes: png() }]);
    const q = loc(res).searchParams;
    expect(q.get("shared")).toBe("2");
    expect(q.get("skipped")).toBe("1");
    expect(q.get("why")).toBe("large");
  }, 30_000); // builds and hashes ~27 MB of data, so it needs headroom when the whole suite runs in parallel

  it("when every file is bad it goes back to the capture page with the reason and saves nothing", async () => {
    const before = (await listMemories()).length;
    const res = await post([{ name: "a.exe", bytes: new TextEncoder().encode("MZ") }, { name: "b.exe", bytes: new TextEncoder().encode("MZ2") }]);
    expect(res.headers.get("location")).toBe("/capture?share=type");
    expect((await listMemories()).length).toBe(before);
    const h = await post([{ name: "p.heic", bytes: heic() }]);
    expect(h.headers.get("location")).toBe("/capture?share=heic");
  });

  it("the kind comes from each file's bytes, not its name or declared type", async () => {
    const res = await post([{ name: "really-a-pdf.png", bytes: pdf(), type: "image/png" }, { name: "really-a-png.pdf", bytes: png(), type: "application/pdf" }]);
    const ids = (await listMemories()).slice(0, 2).map((m) => m.id);
    expect(new Set(await kinds(ids))).toEqual(new Set(["image", "document"]));
    expect(loc(res).searchParams.get("shared")).toBe("2");
  });

  it("a single good file still opens its memory directly (unchanged behaviour)", async () => {
    const res = await post([{ name: "one.png", bytes: png() }]);
    expect(res.headers.get("location")).toMatch(/^\/memories\/[0-9a-f-]{36}\?saved=1$/);
  });

  it("one good file next to a bad one shows the summary so the skipped file is never silent", async () => {
    const res = await post([{ name: "one.png", bytes: png() }, { name: "bad.exe", bytes: new TextEncoder().encode("MZ-x") }]);
    expect(loc(res).pathname).toBe("/memories");
    expect(loc(res).searchParams.get("skipped")).toBe("1");
  });

  it("caps one share at the limit and says how many were left out", async () => {
    const many = Array.from({ length: MAX_SHARED_FILES + 2 }, (_, i) => ({ name: `f${i}.png`, bytes: png() }));
    const q = loc(await post(many)).searchParams;
    expect(q.get("shared")).toBe(String(MAX_SHARED_FILES));
    expect(q.get("skipped")).toBe("2");
    expect(q.get("why")).toBe("limit");
  });
});

describe("duplicates are still caught", () => {
  it("the same file twice in one share, and the same share sent again, make one memory each", async () => {
    const a = png();
    const res = await post([{ name: "x.png", bytes: a }, { name: "x-copy.png", bytes: a }]);
    const q = loc(res).searchParams;
    expect(q.get("shared")).toBe("1");
    expect(q.get("dup")).toBe("1");
    const again = await post([{ name: "renamed.png", bytes: a }]);
    expect(again.headers.get("location")).toMatch(/^\/memories\/[0-9a-f-]{36}\?saved=1$/);
    const hits = (await listMemories()).filter((m) => m.source.kind === "image" && m.source.originalName?.startsWith("x"));
    expect(hits).toHaveLength(1);
  });
});

describe("signed out", () => {
  it("nothing is saved, and a shared link/text (even with files) survives sign-in", async () => {
    gate.failWith = new AuthError();
    const before = (await listMemories()).length;
    const withFile = await post([{ name: "s.png", bytes: png() }], { title: "Later", text: "Read this https://example.com/p", url: "https://example.com/p" });
    const next = new URL(loc(withFile).searchParams.get("next")!, "https://acorn.example");
    expect(loc(withFile).pathname).toBe("/login");
    expect(next.pathname).toBe("/capture");
    expect(next.searchParams.get("share")).toBe("signin");
    expect(next.searchParams.get("url")).toBe("https://example.com/p");
    expect(next.searchParams.get("title")).toBe("Later");
    expect((await listMemories()).length).toBe(before);
  });
  it("long shared text is carried through sign-in without being cut at 2,000 characters", async () => {
    gate.failWith = new AuthError();
    const text = "word ".repeat(3000).trim(); // 14,999 characters
    const f = new FormData();
    f.set("text", text);
    const res = await share(new Request("https://acorn.example/share", { method: "POST", body: f }));
    const next = new URL(loc(res).searchParams.get("next")!, "https://acorn.example");
    expect(next.searchParams.get("text")).toBe(text);
  });
});

describe("HEIC", () => {
  it("is recognised by its bytes and refused with a specific message by the API too", async () => {
    expect(isHeic(heic())).toBe(true);
    expect(isHeic(png())).toBe(false);
    expect(isHeic(new Uint8Array(4))).toBe(false);
    const f = new FormData();
    f.set("file", new File([Buffer.from(heic())], "IMG_0001.HEIC", { type: "image/heic" }));
    const res = await capture(new Request("http://x/api/memories", { method: "POST", body: f }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/HEIC/);
  });
});
