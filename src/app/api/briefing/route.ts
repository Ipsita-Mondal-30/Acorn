import { connection } from "next/server";
import { buildBriefing } from "@/lib/notify/briefing";
import { snapshotForUser } from "@/lib/notify/snapshot";
import { errorResponse, json } from "../_http";

/** Today's briefing, computed now from your own reminders, plans, actions and memories. Nothing is sent. */
export async function GET() {
  await connection();
  try {
    const b = buildBriefing(await snapshotForUser(new Date()));
    return json({ briefing: b.message, counts: b.counts, isEmpty: b.isEmpty });
  } catch (e) {
    return errorResponse(e);
  }
}
