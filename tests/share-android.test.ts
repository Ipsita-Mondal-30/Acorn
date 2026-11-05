import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// What Android's share sheet really sends to the installed PWA: a multipart form POST to /share with title / text / url, or a
// file. Everything goes through the real route handler, the real store and the real processing code.

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn), connection: async () => {} }));
const saveCaptureSpy = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock("@/lib/process", async (orig) => {
  const real = await orig<typeof import("@/lib/process")>();
  return { ...real, saveCapture: async (...a: Parameters<typeof real.saveCapture>) => { if (saveCaptureSpy.failWith) throw saveCaptureSpy.failWith; return real.saveCapture(...a); } };
});

import manifest from "@/app/manifest";
import { POST as share } from "@/app/share/route";
import { AuthError } from "@/lib/backends/types";
import { getMemory, listMemories } from "@/lib/store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = (tag = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n% ${tag}\n%%EOF`);
let dir: string;
const saved = { ...process.env };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-share-"));
  Object.assign(process.env, { ACORN_DATA_DIR: dir, ACORN_STORAGE: "local", ACORN_MODE: "demo", AI_ENABLE_REAL_CALLS: "false" });
  delete process.env.META_API_KEY;
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
beforeEach(() => {
  afterQueue.length = 0;
  saveCaptureSpy.failWith = null;
});
afterAll(async () => {
  process.env = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return new Request("https://acorn.example/share", { method: "POST", body: f });
};
const where = (res: Response) => new URL(res.headers.get("location")!, "https://acorn.example");
const idOf = (res: Response) => where(res).pathname.split("/").pop()!;
const runAfter = async () => {
  for (const fn of afterQueue.splice(0)) await fn();
};

describe("the app is offered in Android's share sheet", () => {
  it("declares a POST multipart share target for text, links, images and PDFs", () => {
    const t = manifest().share_target as { action: string; method: string; enctype: string; params: { title: string; text: string; url: string; files: { name: string; accept: string[] }[] } };
    expect(t).toMatchObject({ action: "/share", method: "POST", enctype: "multipart/form-data", params: { title: "title", text: "text", url: "url" } });
    expect(t.params.files[0].name).toBe("file");
    expect(t.params.files[0].accept).toEqual(expect.arrayContaining(["image/png", "image/jpeg", "image/webp", "application/pdf"]));
    expect(manifest().display).toBe("standalone");
  });
});

describe("behind a tunnel or proxy", () => {
  it("redirects with a relative Location, so the phone never lands on the origin's own address (localhost)", async () => {
    // a proxy hands the app its own address in req.url; an absolute redirect built from it would point the phone at localhost
    const req = new Request("https://localhost:3103/share", { method: "POST", body: (() => { const f = new FormData(); f.set("url", `https://example.com/proxy/${randomUUID()}`); return f; })() });
    const res = await share(req);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith("/memories/")).toBe(true);
    expect(loc).not.toMatch(/localhost|^https?:/);
    const bad = await share(new Request("https://localhost:3103/share", { method: "POST", body: new FormData() }));
    expect(bad.headers.get("location")).toBe("/capture?share=empty");
  });
});

describe("what gets saved", () => {
  it("a shared link (Android puts it in `text`) becomes a link memory that keeps the shared words", async () => {
    const url = `https://example.com/post/${randomUUID()}`;
    const res = await share(form({ title: "Redis eviction guide", text: `Worth reading ${url}` }));
    expect(res.status).toBe(303);
    expect(where(res).search).toBe("?saved=1");
    const m = (await getMemory(idOf(res)))!;
    expect(m.source).toMatchObject({ kind: "url", url });
    expect(m.source.text).toContain("Redis eviction guide");
    expect(m.source.text).toContain("Worth reading");
    expect(m.status).toBe("pending"); // saved first, understood after the response
  });

  it("shared text with no link becomes a note", async () => {
    const res = await share(form({ title: "Idea", text: `Build a tiny reminder app ${randomUUID()}` }));
    const m = (await getMemory(idOf(res)))!;
    expect(m.source.kind).toBe("note");
    expect(m.source.text).toMatch(/Idea\n\nBuild a tiny reminder app/);
  });

  it("a shared screenshot is stored untouched, with the caption as the user's own words", async () => {
    const png = new Uint8Array([...PNG, ...new TextEncoder().encode(randomUUID())]);
    const res = await share(form({ title: "From Instagram", file: new File([png], "Screenshot_2026.png", { type: "image/png" }) }));
    const m = (await getMemory(idOf(res)))!;
    expect(m.source).toMatchObject({ kind: "image", originalName: "Screenshot_2026.png", text: "From Instagram" });
    const { readUpload } = await import("@/lib/uploads");
    expect(Buffer.from((await readUpload(m.source.fileName!))!.bytes).equals(Buffer.from(png))).toBe(true);
  });

  it("a shared PDF is saved as a document", async () => {
    const res = await share(form({ file: new File([pdf()], "paper.pdf", { type: "application/pdf" }) }));
    const m = (await getMemory(idOf(res)))!;
    expect(m.source).toMatchObject({ kind: "document", originalName: "paper.pdf" });
  });

  it("the kind comes from the bytes: a PDF mislabelled .png is still a document, an .exe is refused", async () => {
    const odd = await share(form({ file: new File([pdf()], "looks-like.png", { type: "image/png" }) }));
    expect((await getMemory(idOf(odd)))!.source.kind).toBe("document");
    const bad = await share(form({ file: new File(["MZ not an image"], "x.exe") }));
    expect(where(bad).pathname).toBe("/capture");
    expect(where(bad).search).toBe("?share=type");
  });

  it("an empty share and an oversized file go back to the capture page with a reason, saving nothing", async () => {
    const before = (await listMemories()).length;
    expect(where(await share(form({ title: " ", text: "" }))).search).toBe("?share=empty");
    const big = new File([new Uint8Array(16 * 1024 * 1024)], "huge.pdf");
    expect(where(await share(form({ file: big }))).search).toBe("?share=large");
    expect((await listMemories()).length).toBe(before);
  });
});

describe("duplicate submissions", () => {
  it("sharing the same link twice (a double tap, or a retry) keeps one memory", async () => {
    const url = `https://example.com/dup/${randomUUID()}`;
    const a = await share(form({ url }));
    const b = await share(form({ url }));
    expect(idOf(a)).toBe(idOf(b));
    expect((await listMemories()).filter((m) => m.source.url === url)).toHaveLength(1);
    // both shares queue a reading (the second is a safety net for a save that was never understood), but processing is
    // claimed atomically, so the model reads it exactly once
    const { mockProvider } = await import("@/lib/ai/mock");
    const reads = vi.spyOn(mockProvider, "extractMemory");
    await runAfter();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect((await getMemory(idOf(a)))!.status).toBe("ready");
  });
  it("sharing the same screenshot twice keeps one memory", async () => {
    const png = new Uint8Array([...PNG, ...new TextEncoder().encode(randomUUID())]);
    const a = await share(form({ file: new File([png], "a.png") }));
    const b = await share(form({ file: new File([png], "renamed.png") }));
    expect(idOf(a)).toBe(idOf(b));
  });
});

describe("signed out (cloud mode refuses before anything is stored)", () => {
  it("a shared link survives the sign-in: login → back to the capture form with it filled in", async () => {
    saveCaptureSpy.failWith = new AuthError();
    const url = "https://example.com/needs-login";
    const res = await share(form({ title: "Later", url }));
    const login = where(res);
    expect(login.pathname).toBe("/login");
    const next = new URL(login.searchParams.get("next")!, "https://acorn.example");
    expect(next.pathname).toBe("/capture");
    expect(next.searchParams.get("url")).toBe(url);
    expect(next.searchParams.get("title")).toBe("Later");
    expect(next.search).not.toContain("share=");
  });
  it("a shared file can't survive sign-in, so the user is told to share it again", async () => {
    saveCaptureSpy.failWith = new AuthError();
    const res = await share(form({ file: new File([PNG, new Uint8Array([1, 2, 3])], "s.png") }));
    const next = new URL(where(res).searchParams.get("next")!, "https://acorn.example");
    expect(next.pathname).toBe("/capture");
    expect(next.searchParams.get("share")).toBe("signin");
  });
  it("the redirect target is always a same-site path (no open redirect through a crafted title)", async () => {
    saveCaptureSpy.failWith = new AuthError();
    const res = await share(form({ title: "//evil.example", text: "https://evil.example/x" }));
    const next = where(res).searchParams.get("next")!;
    expect(next.startsWith("/capture")).toBe(true);
    expect(next.startsWith("//")).toBe(false);
  });
});

describe("processing failures and the pending state", () => {
  it("the save is never lost when understanding fails: the memory stays, marked failed with a safe reason, ready to retry", async () => {
    process.env.ACORN_MODE = "meta"; // Meta mode without a key: the reading cannot run
    try {
      const res = await share(form({ url: `https://example.com/fails/${randomUUID()}` }));
      const id = idOf(res);
      expect((await getMemory(id))!.status).toBe("pending"); // what the memory page shows as "Waiting to be understood"
      await runAfter();
      const m = (await getMemory(id))!;
      expect(m.status).toBe("failed");
      expect(m.error).toMatch(/META_API_KEY|Meta mode/);
      expect(m.error).not.toMatch(/Bearer|sk-/);
      expect(m.source.url).toBeTruthy(); // the original is untouched
    } finally {
      process.env.ACORN_MODE = "demo";
    }
  });
  it("a failed memory can be understood again later without saving it again", async () => {
    const res = await share(form({ text: `Remember to renew the passport ${randomUUID()}` }));
    const id = idOf(res);
    await runAfter();
    expect((await getMemory(id))!.status).toBe("ready");
    const again = await share(form({ text: (await getMemory(id))!.source.text! }));
    expect(idOf(again)).toBe(id);
  });
  it("an unexpected save error sends the user back to capture with a retry message instead of a blank page", async () => {
    saveCaptureSpy.failWith = new Error("disk full");
    const res = await share(form({ text: "anything" }));
    expect(where(res).pathname).toBe("/capture");
    expect(where(res).search).toBe("?share=failed");
  });
});
