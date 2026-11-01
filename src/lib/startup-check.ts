import "server-only";
import { getEnv, storageMode } from "./env";

// Fail-fast configuration check, run once when the server starts (src/instrumentation.ts). It reads env only:
// no network, no model call. Messages name the variable, never its value.

export function configProblems(): string[] {
  const problems: string[] = [];
  let env;
  try {
    env = getEnv();
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
  let storage: "local" | "supabase" | undefined;
  try {
    storage = storageMode();
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (env.ACORN_MODE === "meta" && !env.META_API_KEY) problems.push("AI_PROVIDER=meta but META_API_KEY is not set.");
  if (env.EMAIL_PROVIDER !== "none" && (!env.EMAIL_API_KEY || !env.EMAIL_FROM)) problems.push("EMAIL_PROVIDER is set but EMAIL_API_KEY or EMAIL_FROM is not.");
  if (env.NOTIFICATIONS_ENABLE_SENDING === "true" && env.EMAIL_PROVIDER === "none") problems.push("NOTIFICATIONS_ENABLE_SENDING=true but EMAIL_PROVIDER is none.");
  if (env.CRON_SECRET && storage === "supabase" && !process.env.SUPABASE_SERVICE_ROLE_KEY) problems.push("CRON_SECRET is set (scheduled notifications) but SUPABASE_SERVICE_ROLE_KEY is not: the worker needs it.");
  if (storage === "supabase" && process.env.NEXT_PUBLIC_SUPABASE_URL && /service_role|sb_secret_/.test(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "")) {
    problems.push("NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a secret key. Use the publishable/anon key; secret keys must never be public.");
  }
  return problems;
}

export function assertConfig() {
  const problems = configProblems();
  if (!problems.length) return;
  const text = `Acorn configuration problem${problems.length > 1 ? "s" : ""}:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
  // production refuses to start half-configured; in development the error is loud but the server stays up
  if (process.env.NODE_ENV === "production") throw new Error(text);
  console.error(text);
}
