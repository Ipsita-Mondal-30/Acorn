import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseConfig } from "./config";

/**
 * Per-request client acting AS the signed-in user (anon key + their session cookie), so Postgres
 * Row-Level Security and Storage policies apply to everything it does. Never uses the service-role key.
 */
export async function createServerSupabase() {
  const { url, anonKey } = requireSupabaseConfig();
  const jar = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) jar.set(name, value, options);
        } catch {
          // called from a Server Component: cookies are read-only there; proxy.ts refreshes the session
        }
      },
    },
  });
}
