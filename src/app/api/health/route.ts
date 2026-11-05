import { connection } from "next/server";
import { aiHealth } from "@/lib/ai/health";
import { storageMode } from "@/lib/env";
import { requireUser } from "@/lib/supabase/user";
import { errorResponse, json } from "../_http";

/**
 * Configuration check for the model provider. Reads env only: it never calls a model, so it costs nothing, and the
 * response carries no secret (the key appears only as a yes/no). Cloud mode asks for a signed-in user.
 */
export async function GET() {
  await connection();
  try {
    if (storageMode() === "supabase") await requireUser();
    return json(aiHealth());
  } catch (e) {
    return errorResponse(e);
  }
}
