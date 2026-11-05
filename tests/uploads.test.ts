import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, readUpload, saveUpload, UploadError } from "@/lib/uploads";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-uploads-"));
  process.env.ACORN_DATA_DIR = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("uploads", () => {
  it("rejects oversized files", async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PNG);
    await expect(saveUpload(big)).rejects.toThrow(UploadError);
  });

  it("rejects non-image bytes regardless of name", async () => {
    await expect(saveUpload(new TextEncoder().encode("<svg onload=alert(1)>"))).rejects.toThrow(/Only PNG, JPEG, WebP or GIF/);
    await expect(saveUpload(new Uint8Array())).rejects.toThrow(UploadError);
  });

  it("stores a PNG under a random name and reads it back", async () => {
    const { fileName, mimeType } = await saveUpload(PNG);
    expect(fileName).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(mimeType).toBe("image/png");
    expect(await readdir(path.join(dir, "uploads"))).toContain(fileName);
    const back = await readUpload(fileName);
    expect(back?.mimeType).toBe("image/png");
    expect([...back!.bytes]).toEqual([...PNG]);
  });

  it("sniffs webp/gif/jpeg", async () => {
    const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
    expect((await saveUpload(webp)).mimeType).toBe("image/webp");
    expect((await saveUpload(new TextEncoder().encode("GIF89a..."))).mimeType).toBe("image/gif");
    expect((await saveUpload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).fileName).toMatch(/\.jpg$/);
  });

  it.each(["../acorn.json", "../../etc/passwd", "x.png", "00000000-0000-0000-0000-000000000000.svg", "00000000-0000-0000-0000-000000000000.png/../../acorn.json", ""])(
    "rejects unsafe name %j",
    async (name) => expect(await readUpload(name)).toBeNull(),
  );

  it("returns null for a well-formed but missing file", async () => {
    expect(await readUpload("00000000-0000-0000-0000-000000000000.png")).toBeNull();
  });
});
