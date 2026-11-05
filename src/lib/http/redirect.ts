/**
 * Redirects with a RELATIVE Location. Behind a tunnel or reverse proxy the app's own `req.url` can carry the origin's address
 * (e.g. https://localhost:3103), and an absolute Location built from it sends the phone to "localhost". A relative one always
 * resolves against the address the phone actually used. Only same-site paths are accepted.
 */
export function relativeLocation(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) throw new Error("Redirects must be same-site paths.");
  return path;
}

export const relativeRedirect = (path: string, status: 301 | 302 | 303 | 307 | 308 = 303) =>
  new Response(null, { status, headers: { location: relativeLocation(path) } });

/**
 * Is this POST from our own site? The browser sets Origin and a cross-site page cannot forge it. The host to compare with is the
 * one the browser used: behind a tunnel or proxy that is x-forwarded-host / host, not the origin's own `req.url`.
 */
export function isSameSiteRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a cross-site browser request (curl, server to server)
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const seen = [req.headers.get("x-forwarded-host")?.split(",")[0]?.trim(), req.headers.get("host"), new URL(req.url).host].filter(Boolean);
  return seen.includes(host);
}
