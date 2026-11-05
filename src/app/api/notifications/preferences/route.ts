import { connection } from "next/server";
import { emailStatus } from "@/lib/notify/providers";
import { isValidTimezone } from "@/lib/notify/time";
import { PrefsPatch } from "@/lib/notify/types";
import { getPrefs, setPrefs } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../../_http";

export async function GET() {
  await connection();
  try {
    return json({ preferences: await getPrefs(), email: emailStatus() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Change any of: enabled, inApp, email, timezone, quietStart/quietEnd (both or neither), maxPerDay, briefingEnabled, briefingHour. */
export async function PUT(req: Request) {
  try {
    const patch = PrefsPatch.parse(await readJson(req));
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) throw new HttpError(400, "timezone: not a valid IANA time zone");
    const current = await getPrefs();
    const next = { ...current, ...patch };
    if ((next.quietStart === null) !== (next.quietEnd === null)) throw new HttpError(400, "Set both quiet-hours times, or neither.");
    return json({ preferences: await setPrefs(patch), email: emailStatus() });
  } catch (e) {
    return errorResponse(e);
  }
}
