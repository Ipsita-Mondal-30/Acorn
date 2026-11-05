import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The real login proxy (src/proxy.ts) with a stubbed Supabase session: signed out vs signed in, no network.
// These are the regressions found when Acorn was reached through a tunnel and from the share sheet.

const session = vi.hoisted(() => ({ signedIn: false }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: session.signedIn ? { sub: "user-1" } : null } }) } }),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ auth: { signOut: async () => ({ error: null }) } }) }));

import { GET as callback } from "@/app/auth/callback/route";
import { POST as logout } from "@/app/auth/logout/route";
import { proxy } from "@/proxy";

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key" });
  delete process.env.ACORN_STORAGE;
});
beforeEach(() => void (session.signedIn = false));
afterAll(() => void (process.env = saved));

// the app sees its own address (like behind a tunnel), never the one the phone used
const ORIGIN = "https://localhost:3103";
const req = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => new NextRequest(`${ORIGIN}${path}`, init);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("signed-out share sheet POST", () => {
  it("reaches the route (it is NOT redirected to login), so the shared link and text are not lost", async () => {
    const res = await proxy(req("/share", { method: "POST", body: form({ url: "https://example.com/a", title: "T" }) }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
  it("only that exact POST is let through: a GET of /share, other POSTs and other pages still go to login", async () => {
    for (const [path, method] of [["/share", "GET"], ["/capture", "POST"], ["/memories", "GET"], ["/share/extra", "POST"]] as const) {
      const res = await proxy(req(path, { method, ...(method === "POST" ? { body: form({ a: "b" }) } : {}) }));
      expect(res.headers.get("location"), `${method} ${path}`).toMatch(/^\/login\?next=/);
    }
  });
  it("/api routes still answer for themselves (401), never a login redirect", async () => {
    const res = await proxy(req("/api/memories", { method: "POST", body: "{}" }));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("login redirects are relative and keep the whole target", () => {
  it("a signed-out page request goes to /login?next=<path and query>, relative, never to the origin's own address", async () => {
    const res = await proxy(req("/capture?url=https%3A%2F%2Fexample.com%2Fx&text=hello%20there&title=T"));
    expect(res.status).toBe(307);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith("/login?next=")).toBe(true);
    expect(loc).not.toMatch(/localhost|^https?:/);
    const next = new URL(loc, "https://phone.example").searchParams.get("next")!;
    expect(next).toBe("/capture?url=https%3A%2F%2Fexample.com%2Fx&text=hello%20there&title=T");
  });
  it("a signed-out form POST to a page arrives at login as a GET (303)", async () => {
    const res = await proxy(req("/memories", { method: "POST", body: form({ a: "b" }) }));
    expect(res.status).toBe(303);
  });
  it("signed in, /login sends you on to `next` (relative), and an open-redirect `next` falls back to /", async () => {
    session.signedIn = true;
    const ok = await proxy(req("/login?next=%2Fcapture%3Furl%3Dx"));
    expect(ok.headers.get("location")).toBe("/capture?url=x");
    for (const evil of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await proxy(req(`/login?next=${encodeURIComponent(evil)}`));
      expect(res.headers.get("location")).toBe("/");
    }
  });
  it("signed in, ordinary pages pass straight through", async () => {
    session.signedIn = true;
    expect((await proxy(req("/memories"))).headers.get("x-middleware-next")).toBe("1");
  });
  it("local demo mode never redirects", async () => {
    process.env.ACORN_STORAGE = "local";
    try {
      expect((await proxy(req("/memories"))).headers.get("location")).toBeNull();
    } finally {
      delete process.env.ACORN_STORAGE;
    }
  });
});

describe("auth routes behind a tunnel", () => {
  it("sign-out accepts the browser's real origin (the tunnel host) and redirects relative; a cross-site origin is refused", async () => {
    const ok = await logout(new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: "https://abc.trycloudflare.com", "x-forwarded-host": "abc.trycloudflare.com" } }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/login");
    const evil = await logout(new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", "x-forwarded-host": "abc.trycloudflare.com" } }));
    expect(evil.status).toBe(403);
    const direct = await logout(new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(direct.status).toBe(303);
  });
  it("the email-confirmation callback redirects relative", async () => {
    const res = await callback(new Request(`${ORIGIN}/auth/callback?next=%2Fcapture`));
    expect(res.headers.get("location")).toBe("/login?error=link");
  });
});
