import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError, readSupabaseConfig } from "@/lib/supabase/config";
import { safeNext } from "@/lib/supabase/redirect";

// Cloud mode only: refresh the Supabase session cookie on every page request and send signed-out visitors
// to /login. In local demo mode (no Supabase configured, or ACORN_STORAGE=local) this does nothing.
// /api routes are never redirected: they answer 401 themselves (see errorResponse), which is what a fetch() wants.

const PUBLIC = ["/login", "/signup", "/auth"];
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

  if (!signedIn && !isPublic(pathname) && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", safeNext(pathname + search));
    return redirectKeepingCookies(url, response);
  }
  if (signedIn && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = safeNext(request.nextUrl.searchParams.get("next"));
    url.search = "";
    return redirectKeepingCookies(url, response);
  }
  return response;
}

/** A redirect must carry any refreshed session cookies, or the user is logged out on the next request. */
function redirectKeepingCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  for (const c of from.cookies.getAll()) redirect.cookies.set(c);
  return redirect;
}

export const config = {
  // everything except Next internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
