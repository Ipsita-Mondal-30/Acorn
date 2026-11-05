import { getEnv } from "@/lib/env";
import { logError, logEvent } from "@/lib/log";
import { cronAuthorized, runTick } from "@/lib/notify/service";

// The scheduler's entry point: POST with `Authorization: Bearer <CRON_SECRET>`. It takes no input at all (the clock is the
// server's, and who is notified is decided by the database, never by the request), answers with counts only, and does
// the same safe, idempotent pass however often it is called. With CRON_SECRET unset the endpoint does not exist.

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!getEnv().CRON_SECRET) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (!cronAuthorized(req.headers.get("authorization"))) {
    logEvent("warn", "tick_unauthorized", {}); // no source address or header is logged: nothing an attacker sent ends up in the log
    return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  }
  try {
    return Response.json({ ok: true, ...(await runTick()) }, { headers: NO_STORE });
  } catch (e) {
    logError("tick_failed", e);
    return Response.json({ ok: false, error: "The scheduled run failed. See the server log." }, { status: 500, headers: NO_STORE });
  }
}
