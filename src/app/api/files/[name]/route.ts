import { connection } from "next/server";
import { AuthError } from "@/lib/backends/types";
import { logError } from "@/lib/log";
import { readUpload, signedUploadUrl } from "@/lib/uploads";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SIGNED_URL_SECONDS = 300;

export async function GET(_req: Request, ctx: RouteContext<"/api/files/[name]">) {
  await connection();
  const { name } = await ctx.params;
  // readUpload validates too; reject traversal-shaped names before touching storage.
  if (!SAFE_NAME.test(name) || name.includes("..")) return new Response("Not found", { status: 404 });
  try {
    // Cloud: the path is built from the SIGNED-IN user's id, so you can only ever sign your own files, and
    // Storage policies check it again. The browser then loads the image straight from a 5-minute signed URL.
    const signed = await signedUploadUrl(name, SIGNED_URL_SECONDS);
    if (signed) return new Response(null, { status: 302, headers: { Location: signed, "Cache-Control": "private, no-store" } });
    const file = await readUpload(name);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return new Response("Sign in to view this file", { status: 401, headers: { "Cache-Control": "no-store" } });
    logError("file_route_error", e);
    return new Response("Something went wrong", { status: 500 });
  }
}
