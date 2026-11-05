import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError, readSupabaseConfig } from "@/lib/supabase/config";
import { relativeLocation } from "@/lib/http/redirect";
import { safeNext } from "@/lib/supabase/redirect";

// Cloud mode only: refresh the Supabase session cookie on every page request and send signed-out visitors
// to /login. In local demo mode (no Supabase configured, or ACORN_STORAGE=local) this does nothing.
// /api routes are never redirected: they answer 401 themselves (see errorResponse), which is what a fetch() wants.

// the manifest and its icons are fetched by the browser without cookies, so they can never sit behind a login redirect
const PUBLIC = ["/login", "/signup", "/auth", "/manifest.webmanifest", "/pwa-icon"];
const isPublic = (p: string) => PUBLIC.some((x) => p === x || p.startsWith(`${x}/`));

export async function proxy(request: NextRequest) {
  if (process.env.ACORN_STORAGE?.trim() === "local") return NextResponse.next();

  let config;
  try {
    config = readSupabaseConfig();
  } catch (e) {
    if (e instanceof ConfigError) return new NextResponse(`Acorn is misconfigured: ${e.message}`, { status: 500 });
    throw e;
  }
  if (!config) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the token and refreshes it when it has expired (writing the new cookies above).
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  // A share sheet POST must reach the route even when signed out: its body (the shared link or text) exists only in that
  // request, so redirecting it here would lose it. The route saves nothing without a user (the store refuses first) and
  // itself sends the person to sign in, carrying the shared link/text through to the capture form.
  const isShareSheetPost = pathname === "/share" && request.method === "POST";
  if (!signedIn && !isPublic(pathname) && !pathname.startsWith("/api/") && !isShareSheetPost) {
    const next = encodeURIComponent(safeNext(pathname + search));
    return redirectKeepingCookies(`/login?next=${next}`, response, request.method);
  }
  if (signedIn && (pathname === "/login" || pathname === "/signup")) {
    return redirectKeepingCookies(safeNext(request.nextUrl.searchParams.get("next")), response);
  }
  return response;
}

/** A redirect must carry any refreshed session cookies, or the user is logged out on the next request. */
function redirectKeepingCookies(path: string, from: NextResponse, method = "GET") {
  // a signed-out form POST must arrive at the login page as a GET, not be replayed as a POST (303). The Location is
  // RELATIVE so it resolves against the address the browser used, never the origin's own (a tunnel's "localhost").
  const redirect = new NextResponse(null, { status: method === "GET" || method === "HEAD" ? 307 : 303, headers: { location: relativeLocation(path) } });
  for (const c of from.cookies.getAll()) redirect.cookies.set(c);
  return redirect;
}

export const config = {
  // everything except Next internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
