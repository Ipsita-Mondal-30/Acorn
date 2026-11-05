import { ImageResponse } from "next/og";

// 180 is the iPhone Home Screen icon (apple-touch-icon); 192 and 512 are the manifest icons
const SIZES = new Set([180, 192, 512]);

/** Home-screen icon for the installed app: a simple acorn mark, drawn in code so there is no binary asset to maintain. */
export async function GET(_req: Request, ctx: RouteContext<"/pwa-icon/[size]">) {
  const size = Number((await ctx.params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  const u = size / 100;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: "#5f9340" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 56 * u, height: 22 * u, background: "#fbf6ea", borderRadius: `${22 * u}px ${22 * u}px ${6 * u}px ${6 * u}px` }} />
          <div style={{ width: 44 * u, height: 40 * u, marginTop: 3 * u, background: "#f7d56a", borderRadius: `${4 * u}px ${4 * u}px ${24 * u}px ${24 * u}px` }} />
        </div>
      </div>
    ),
    { width: size, height: size, headers: { "cache-control": "public, max-age=86400" } },
  );
}
