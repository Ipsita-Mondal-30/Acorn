import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { GET as icon } from "@/app/pwa-icon/[size]/route";

// The parts of the installed-web-app setup that iPhone and Android read. Static and unit checks only: how a real phone
// treats them is in docs/cross-platform-capture-setup.md (device checks), not claimed here.

const get = (size: string) => icon(new Request(`http://x/pwa-icon/${size}`), { params: Promise.resolve({ size }) } as never);

describe("icons", () => {
  it("serves the 180 px iPhone icon plus the manifest's 192 and 512 as PNG, and 404s anything else", async () => {
    for (const size of ["180", "192", "512"]) {
      const res = await get(size);
      expect(res.status, size).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const dv = new DataView(bytes.buffer);
      expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([Number(size), Number(size)]);
    }
    expect((await get("256")).status).toBe(404);
    expect((await get("abc")).status).toBe(404);
  });
});

describe("web app manifest", () => {
  const m = manifest();
  it("is an installable standalone app with a stable id, icons and the share target", () => {
    expect(m).toMatchObject({ name: "Acorn", short_name: "Acorn", id: "/", start_url: "/", scope: "/", display: "standalone", lang: "en" });
    expect(m.background_color).toBe("#fbf6ea");
    expect(m.theme_color).toBe("#5f9340");
    expect(m.icons?.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    expect(m.share_target).toMatchObject({ action: "/share", method: "POST", enctype: "multipart/form-data" });
  });
});

describe("page head for iPhone", () => {
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  it("declares the apple-touch-icon, standalone web-app mode and viewport-fit=cover", () => {
    expect(layout).toMatch(/apple: \[\{ url: "\/pwa-icon\/180", sizes: "180x180", type: "image\/png" \}\]/);
    expect(layout).toMatch(/appleWebApp: \{ capable: true, title: "Acorn"/);
    expect(layout).toMatch(/viewportFit: "cover"/);
  });
});
