import "server-only";
import { AuthError } from "../backends/types";
import { createServerSupabase } from "./server";

export type SessionUser = { id: string; email: string | null };

/**
 * The signed-in user, or null. Uses getClaims(): it verifies the session token's signature and expiry
 * (against the project's published keys) instead of trusting the cookie's contents. Postgres RLS re-checks
 * the same token on every query, so a stale or forged cookie can't read anything either way.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || typeof sub !== "string" || !sub) return null;
  const email = data.claims.email;
  return { id: sub, email: typeof email === "string" ? email : null };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new AuthError();
  return user;
}
