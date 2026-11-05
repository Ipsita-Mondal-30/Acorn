import { connection } from "next/server";
import { AuthError } from "@/lib/backends/types";
import { storageMode } from "@/lib/env";
import { getProfile } from "@/lib/profile";
import { errorResponse, HttpError, json } from "../_http";

export async function GET() {
  await connection();
  try {
    if (storageMode() === "local") throw new HttpError(404, "Profiles exist only in cloud mode");
    const profile = await getProfile();
    if (!profile) throw new AuthError();
    return json({ profile });
  } catch (e) {
    return errorResponse(e);
  }
}
