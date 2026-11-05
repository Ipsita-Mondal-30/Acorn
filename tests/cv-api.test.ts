import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { docx, scannedPdf } from "./helpers/office";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-cvapi-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const fixture = (n: string) => readFileSync(path.resolve(__dirname, "fixtures", n));
const upload = (bytes: Buffer | Uint8Array, name: string, type = "application/octet-stream") => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return new Request("http://x/api/cv", { method: "POST", body: form });
};

describe("/api/cv", () => {
  it("accepts an upload, summarises what was read, and serves the original back to its owner only", async () => {
    const route = await import("@/app/api/cv/route");
    const res = await route.POST(upload(fixture("cv-sample.docx"), "cv.docx", "application/msword")); // a wrong MIME type changes nothing
    expect(res.status).toBe(201);
    const { cv } = await res.json();
    expect(cv).toMatchObject({ source: "upload", fileKind: "docx", counts: { experience: 2 }, hasFile: true });
    expect(cv.parsed.name.text).toBe("Asha Rao");

    const got = await (await route.GET()).json();
    expect(got.cv.id).toBe(cv.id);
    expect(got.history).toEqual([]);

    const file = await import("@/app/api/files/[name]/route");
    const served = await file.GET(new Request("http://x"), { params: Promise.resolve({ name: cv.fileName }) } as never);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-type")).toContain("wordprocessingml");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(fixture("cv-sample.docx")));
  });

  it("replaces with pasted text, keeps history, re-reads on request, and removes on request", async () => {
    const route = await import("@/app/api/cv/route");
    const put = await route.PUT(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Jo Lee\n\nExperience\nEngineer, Acme\nJan 2020 - Present\n- Built things" }) }));
    expect(put.status).toBe(200);
    const g = await (await route.GET()).json();
    expect(g.cv.source).toBe("paste");
    expect(g.history).toHaveLength(1);
    const patch = await route.PATCH(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "reparse" }) }));
    expect(patch.status).toBe(200);
    const del = await route.DELETE();
    expect((await del.json()).removed).toBe(2);
    expect((await (await route.GET()).json()).cv).toBeNull();
    expect((await route.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ op: "reparse" }) }))).status).toBe(404);
  });

  it("answers with clear errors, never stack traces", async () => {
    const route = await import("@/app/api/cv/route");
    const bad = [
      [await route.POST(upload(scannedPdf(), "scan.pdf")), 400, /little or no readable text/],
      [await route.POST(upload(Buffer.from([0x4d, 0x5a, 0x90, 0, 3]), "a.exe")), 400, /PDF, a Word document/],
      [await route.POST(upload(new Uint8Array(0), "empty.pdf")), 400, /required/],
      [await route.POST(upload(docx(["x"]).subarray(0, 40), "cut.docx")), 400, /PDF, a Word document|damaged|valid/],
      [await route.POST(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })), 415, /multipart/],
      [await route.POST(new Request("http://x", { method: "POST", headers: { "content-length": String(50 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" }, body: "x" })), 413, /too large/],
      [await route.PUT(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "short" }) })), 400, /Paste your CV/],
      [await route.PUT(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(70_000) }) })), 400, /too_big|Too big|60000|at most/i],
      [await route.PUT(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ok enough text for a cv", extra: 1 }) })), 400, /nrecognized|extra/i],
    ] as const;
    for (const [res, status, msg] of bad) {
      expect(res.status).toBe(status);
      const text = JSON.stringify(await res.json());
      expect(text).toMatch(msg);
      expect(text).not.toMatch(/at \/|node_modules|Error:/);
    }
  });
});
