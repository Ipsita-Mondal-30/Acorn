import Link from "next/link";
import { REMINDER_KIND_LABEL, type Reminder } from "@/lib/agent/schema";
import { formatInZone } from "@/lib/notify/time";
import type { Delivery } from "@/lib/notify/types";
import type { Action } from "@/lib/schema";
import { ReminderControls } from "./AgentControls";
import { formatDateTime } from "./format";
import { Tag } from "./ui";

const CHANNEL = { in_app: "In Acorn", email: "Email" } as const;

/** One line per delivery in plain words: sent, waiting (and why), skipped (and why), or failed. */
export function deliveryLine(d: Delivery, tz: string): { text: string; tone: "plain" | "moss" | "amber" | "danger" } {
  const ch = CHANNEL[d.channel];
  const at = (iso: string) => formatInZone(new Date(iso), tz).replace(/ \(.*\)$/, "");
  if (d.status === "sent") return { text: `${ch}: sent ${at(d.sentAt ?? d.scheduledFor)}${d.channel === "in_app" && !d.readAt ? " (unread)" : ""}`, tone: "moss" };
  if (d.status === "pending") return { text: `${ch}: scheduled for ${at(d.scheduledFor)}${d.reason ? `. ${d.reason}` : ""}${d.attempts ? ` (${d.attempts} ${d.attempts === 1 ? "try" : "tries"} so far${d.lastError ? `: ${d.lastError}` : ""})` : ""}`, tone: "amber" };
  if (d.status === "failed") return { text: `${ch}: failed after ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}${d.lastError ? `: ${d.lastError}` : ""}`, tone: "danger" };
  return { text: `${ch}: not sent. ${d.reason ?? ""}`.trim(), tone: "plain" };
}

export function ReminderCard({ r, memoryTitle, action, deliveries, tz, now }: { r: Reminder; memoryTitle: string; action?: Action; deliveries: Delivery[]; tz: string; now: Date }) {
  const zone = r.timezone ?? tz;
  const mine = deliveries.filter((d) => d.reminderId === r.id && Date.parse(d.dueAt ?? "") === Date.parse(r.dueAt));
  const closed = r.status === "done" || r.status === "dismissed";
  return (
    <article className="rounded-3xl border-2 border-line/80 bg-card p-4 shadow-card" aria-label={r.title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium">{r.title}</h3>
        <div className="flex flex-wrap gap-1.5">
          <Tag>{REMINDER_KIND_LABEL[r.kind]}</Tag>
          {r.status === "snoozed" && <Tag tone="amber">Snoozed</Tag>}
          {r.status === "done" && <Tag tone="moss">Done</Tag>}
          {r.status === "dismissed" && <Tag>Dismissed</Tag>}
          {r.snoozeCount >= 3 && !closed && <Tag tone="amber">Moved {r.snoozeCount} times</Tag>}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        <time dateTime={r.dueAt}>{formatInZone(new Date(r.dueAt), zone)}</time>
      </p>
      {r.note && <p className="mt-1 text-sm text-ink-soft">{r.note}</p>}
      <p className="mt-2 text-sm">
        <span className="text-ink-faint">From: </span>
        <Link className="underline underline-offset-2" href={`/memories/${r.memoryId}`}>
          {memoryTitle}
        </Link>
        {action && (
          <>
            <span className="text-ink-faint"> · Action: </span>
            <Link className="underline underline-offset-2" href={`/memories/${r.memoryId}#agent-heading`}>
              {action.title}
            </Link>{" "}
            <span className="text-ink-faint">({action.state.replace("_", " ")})</span>
          </>
        )}
      </p>
      {mine.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm" aria-label="Delivery status">
          {mine.slice(0, 4).map((d) => {
            const l = deliveryLine(d, tz);
            return (
              <li key={d.id} className={l.tone === "danger" ? "text-danger" : l.tone === "amber" ? "text-amber" : l.tone === "moss" ? "text-moss-ink" : "text-ink-faint"}>
                {l.text}
              </li>
            );
          })}
        </ul>
      )}
      {mine.length === 0 && !closed && Date.parse(r.dueAt) > now.getTime() && <p className="mt-2 text-sm text-ink-faint">Not announced yet: it goes out when it is due, within your settings.</p>}
      <ReminderControls reminder={r} tz={tz} />
      {r.history.length > 0 && <p className="sr-only">Last changed {formatDateTime(r.updatedAt)}</p>}
    </article>
  );
}
