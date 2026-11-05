import { relativeRedirect } from "@/lib/http/redirect";
import { storageMode } from "@/lib/env";
import { safeNext } from "@/lib/supabase/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/** Landing point for the link in the confirmation email: swaps the one-time `code` for a session cookie. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  if (storageMode() !== "supabase" || !code) return relativeRedirect("/login?error=link", 307);
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return relativeRedirect("/login?error=link", 307);
  return relativeRedirect(next, 307);
}
