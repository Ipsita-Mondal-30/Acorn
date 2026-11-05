import { NextResponse } from "next/server";
import { storageMode } from "@/lib/env";
import { isSameSiteRequest, relativeRedirect } from "@/lib/http/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/** POST only (a link can't log you out), and only from this site. */
export async function POST(req: Request) {
  if (!isSameSiteRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  if (storageMode() === "supabase") {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  return relativeRedirect("/login", 303);
}
