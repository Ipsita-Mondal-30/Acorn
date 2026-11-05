import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { localWorkerStore } from "../backends/local";
import { getEnv, storageMode } from "../env";
import { logEvent } from "../log";
import { createAdminSupabase } from "../supabase/admin";
import { getEmailProvider } from "./providers";
import { supabaseWorkerStore } from "./supabase-worker";
import { tick, type TickSummary, type WorkerStore } from "./worker";

/** The worker's store: the local demo file, or Supabase through the service role (the only server use of that key). */
export function workerStore(): WorkerStore {
  if (storageMode() === "local") return localWorkerStore;
  const admin = createAdminSupabase();
  return supabaseWorkerStore(admin, async (id) => (await admin.auth.admin.getUserById(id)).data.user?.email ?? null);
}

/** Constant-time check of the bearer token against CRON_SECRET. false when the secret isn't configured. */
export function cronAuthorized(authorization: string | null): boolean {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return false;
  const given = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  // hash both so lengths match and the comparison takes the same time whatever was sent
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());
}

export async function runTick(now = new Date()): Promise<TickSummary> {
  const env = getEnv();
  const started = Date.now();
  const summary = await tick(workerStore(), { email: getEmailProvider(), baseUrl: env.APP_BASE_URL ?? null, expiryHours: env.NOTIFY_EXPIRY_HOURS }, now);
  // one line per run: counts and duration, never who or what. A run with failures is a warning, so it stands out.
  logEvent(summary.failed > 0 ? "warn" : "info", "tick", { ...summary, ms: Date.now() - started });
  return summary;
}
