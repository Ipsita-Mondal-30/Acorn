import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseConfig } from "./config";

/** Browser client: anon key only. Used for sign-in / sign-up; data access goes through server routes. */
export function createBrowserSupabase() {
  const { url, anonKey } = requireSupabaseConfig();
  return createBrowserClient(url, anonKey);
}
