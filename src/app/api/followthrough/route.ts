import { connection } from "next/server";
import { z } from "zod";
import { suggestions, SUGGESTION_SNOOZE_DAYS } from "@/lib/notify/followthrough";
import { snapshotForUser } from "@/lib/notify/snapshot";
import { getPrefs, setPrefs } from "@/lib/store";
import { errorResponse, json, readJson } from "../_http";

/** Up to three suggestions (overdue, postponed, stalled, deadline). Read-only: nothing is changed by looking. */
export async function GET() {
  await connection();
  try {
    return json({ suggestions: suggestions(await snapshotForUser(new Date())) });
  } catch (e) {
    return errorResponse(e);
  }
}

const Op = z.object({ op: z.literal("hide"), key: z.string().min(1).max(120) }).strict();

/** "Not now": hide one suggestion for 14 days. This is the only thing it can change. */
export async function POST(req: Request) {
  try {
    const { key } = Op.parse(await readJson(req));
    const now = new Date();
    const prefs = await getPrefs();
    const until = new Date(now.getTime() + SUGGESTION_SNOOZE_DAYS * 86_400_000).toISOString();
    // keep the list small: forget entries that already expired
    const kept = Object.fromEntries(Object.entries(prefs.snoozedSuggestions).filter(([, u]) => Date.parse(u) > now.getTime()).slice(0, 100));
    await setPrefs({ snoozedSuggestions: { ...kept, [key]: until } });
    return json({ hiddenUntil: until });
  } catch (e) {
    return errorResponse(e);
  }
}
