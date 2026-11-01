import "server-only";
import { z } from "zod";
import { storageMode } from "./env";
import { createServerSupabase } from "./supabase/server";
import { currentUser } from "./supabase/user";

export const Profile = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type Profile = z.infer<typeof Profile>;

/** The signed-in user's profile, or null when signed out or running in local demo mode. */
export async function getProfile(): Promise<Profile | null> {
  if (storageMode() !== "supabase") return null;
  const user = await currentUser();
  if (!user) return null;
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.from("profiles").select("display_name, avatar_url").eq("id", user.id).maybeSingle();
  if (error) console.error(`[profile] ${error.code ?? ""} ${error.message.slice(0, 200)}`);
  return { id: user.id, email: user.email, displayName: data?.display_name ?? null, avatarUrl: data?.avatar_url ?? null };
}
