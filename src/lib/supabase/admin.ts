import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseConfig } from "./config";

// The service-role key BYPASSES Row-Level Security. No user-facing request uses it. The ONE server use is the scheduled
// notification worker behind the secret-protected /api/cron/tick (src/lib/notify/service.ts); the rest is operator scripts and tests. It is read from a non-NEXT_PUBLIC variable (so it can't be inlined into client
// JavaScript) and this file is server-only (so importing it from a client component fails the build).
export function createAdminSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  const { url } = requireSupabaseConfig();
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
