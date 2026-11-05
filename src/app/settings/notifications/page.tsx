import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PrefsForm } from "@/components/NotifyControls";
import { CardSkeleton, PageIntro } from "@/components/ui";
import { emailStatus } from "@/lib/notify/providers";
import { getPrefs } from "@/lib/store";

export const metadata: Metadata = { title: "Notification settings" };

export default function NotificationSettingsPage() {
  return (
    <div>
      <PageIntro mood="encouraging" title="Notification settings">
        Choose how and when I nudge you. Gentle is the default. <Link className="underline underline-offset-4" href="/reminders">Back to reminders</Link>
      </PageIntro>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={2} /></div>}>
        <Form />
      </Suspense>
    </div>
  );
}

async function Form() {
  await connection();
  const prefs = await getPrefs();
  return <PrefsForm initial={prefs} email={emailStatus()} />;
}
