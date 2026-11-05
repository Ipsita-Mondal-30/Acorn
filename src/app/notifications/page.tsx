import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { MarkAllRead, MarkRead } from "@/components/NotifyControls";
import { deliveryLine } from "@/components/ReminderCard";
import { CardSkeleton, EmptyState, PageIntro, Tag } from "@/components/ui";
import { formatInZone } from "@/lib/notify/time";
import { getPrefs, listDeliveries } from "@/lib/store";

export const metadata: Metadata = { title: "Inbox" };

export default function NotificationsPage() {
  return (
    <div>
      <PageIntro mood="happy" title="Inbox">Notes I sent you, and what happened to the rest.</PageIntro>
      <div className="mt-4 flex flex-wrap items-baseline justify-end gap-3">
        <nav aria-label="Related" className="flex gap-4 text-sm font-bold">
          <Link className="underline underline-offset-4" href="/reminders">Reminders</Link>
          <Link className="underline underline-offset-4" href="/settings/notifications">Settings</Link>
        </nav>
      </div>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={3} /></div>}>
        <Inbox />
      </Suspense>
    </div>
  );
}

async function Inbox() {
  await connection();
  const [all, prefs] = await Promise.all([listDeliveries({ limit: 100 }), getPrefs()]);
  const tz = prefs.timezone;
  const inbox = all.filter((d) => d.channel === "in_app" && d.status === "sent");
  const unread = inbox.filter((d) => !d.readAt).length;
  const other = all.filter((d) => !(d.channel === "in_app" && d.status === "sent"));
  return (
    <div className="mt-8 space-y-12">
      <section aria-labelledby="inbox">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="inbox" className="font-display text-2xl">Received ({inbox.length})</h2>
          <MarkAllRead unread={unread} />
        </div>
        {inbox.length === 0 ? (
          <div className="mt-4">
            <EmptyState mood="sleeping" title="Nothing here yet">Notifications show up when a reminder comes due, or in your daily briefing if you turned it on.</EmptyState>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {inbox.map((d) => (
              <li key={d.id} className={`rounded-2xl border p-4 ${d.readAt ? "border-line/80 bg-card" : "border-amber/40 bg-amber-soft/30"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="font-medium">{d.payload.title}</h3>
                  <div className="flex items-center gap-2 text-sm text-ink-faint">
                    {d.kind === "briefing" && <Tag>Daily briefing</Tag>}
                    <time dateTime={d.sentAt ?? d.scheduledFor}>{formatInZone(new Date(d.sentAt ?? d.scheduledFor), tz)}</time>
                  </div>
                </div>
                <ul className="mt-2 space-y-0.5 text-[15px] text-ink-soft">
                  {d.payload.lines.map((l, i) => (
                    <li key={i} className="whitespace-pre-wrap">{l}</li>
                  ))}
                </ul>
                {d.payload.draft && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer font-medium">Draft message (you send it; Acorn never does)</summary>
                    <pre className="mt-2 max-h-60 overflow-auto rounded-xl bg-paper p-3 whitespace-pre-wrap">{d.payload.draft}</pre>
                  </details>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  {d.payload.links.map((l) => (
                    <Link key={l.href + l.label} className="font-medium underline underline-offset-4" href={l.href}>{l.label}</Link>
                  ))}
                  {!d.readAt && <MarkRead id={d.id} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hist">
        <h2 id="hist" className="font-display text-2xl">Waiting, skipped or failed ({other.length})</h2>
        <p className="mt-1 text-sm text-ink-faint">The honest record: why something didn&apos;t reach you, or when it will.</p>
        {other.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">Nothing is waiting and nothing was skipped.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {other.map((d) => (
              <li key={d.id} className="rounded-xl border border-line/70 bg-card p-3">
                <p className="font-medium">{d.payload.title}</p>
                <p className="text-ink-soft">{deliveryLine(d, tz).text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
