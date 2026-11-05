import Link from "next/link";
import { connection } from "next/server";
import { storageMode } from "@/lib/env";
import { getProfile } from "@/lib/profile";
import { buttonClass } from "./ui";

/**
 * Says where your data lives and who you are. Local demo storage and the signed-in cloud account are
 * labelled differently on purpose, so nobody mistakes sample data on this machine for their private account.
 */
export async function AccountBar() {
  await connection();
  if (storageMode() === "local") {
    return (
      <p
        className="inline-flex items-center gap-2 rounded-full border border-line bg-paper-deep px-3 py-1 text-[13px] font-medium text-ink-soft"
        title="Data is stored in a file on this machine. No accounts, not synced."
      >
        <span className="size-1.5 rounded-full bg-ink-faint" aria-hidden="true" />
        Local demo storage
      </p>
    );
  }
  let profile = null;
  try {
    profile = await getProfile();
  } catch (e) {
    console.error("[account] profile lookup failed", e instanceof Error ? e.message : e);
  }
  if (!profile) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-[13px] font-medium text-ink-soft">
          <span className="size-1.5 rounded-full bg-amber" aria-hidden="true" />
          Cloud · signed out
        </span>
        <Link href="/login" className={buttonClass.secondary}>Sign in</Link>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex max-w-56 items-center gap-2 truncate rounded-full border border-moss/30 bg-moss-soft px-3 py-1 text-[13px] font-medium text-moss-ink"
        title={profile.email ?? undefined}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-moss" aria-hidden="true" />
        <span className="truncate">Cloud · {profile.displayName ?? profile.email ?? "signed in"}</span>
      </span>
      <form action="/auth/logout" method="post">
        <button type="submit" className={buttonClass.quiet}>Sign out</button>
      </form>
    </div>
  );
}
