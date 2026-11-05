import { reminderForDeadline } from "@/lib/agent/planner";
import type { Reminder } from "@/lib/agent/schema";
import type { Delivery } from "@/lib/notify/types";
import { effective, type Action, type Memory } from "@/lib/schema";
import { DeadlineReminderButton, NewReminderForm } from "./NotifyControls";
import { ReminderCard } from "./ReminderCard";
import { SectionHeading } from "./ui";

/** Reminders for one memory: the ones that exist (with what was sent), "remind me", and a deadline reminder when it makes sense. */
export function RemindersSection({ memory, reminders, actions, deliveries, tz, now }: { memory: Memory; reminders: Reminder[]; actions: Action[]; deliveries: Delivery[]; tz: string; now: Date }) {
  const v = effective(memory);
  const open = reminders.some((r) => r.status === "scheduled" || r.status === "snoozed");
  // only offered for a memory whose intent YOU confirmed, from a deadline the item itself states
  const deadlineDue = v.deadline && v.intentKind && !open ? reminderForDeadline(v.deadline, now) : null;
  if (memory.status !== "ready" && reminders.length === 0) return null;
  return (
    <section aria-labelledby="reminders-heading">
      <SectionHeading id="reminders-heading">Reminders</SectionHeading>
      <div className="space-y-3">
        {reminders.map((r) => (
          <ReminderCard key={r.id} r={r} memoryTitle={v.title} action={actions.find((a) => a.id === r.actionId)} deliveries={deliveries} tz={tz} now={now} />
        ))}
      </div>
      <div className="mt-5 space-y-4 rounded-3xl border-2 border-line/80 bg-card p-4">
        <NewReminderForm memoryId={memory.id} defaultTitle={v.title.slice(0, 120)} tz={tz} />
        {deadlineDue && v.deadline && <DeadlineReminderButton memoryId={memory.id} title={v.title.slice(0, 150)} dueAt={deadlineDue} deadline={v.deadline} />}
      </div>
    </section>
  );
}
