import type { Plan, PlanStep, Reminder } from "../agent/schema";
import { effective, type Memory } from "../schema";
import { formatInZone } from "./time";
import type { Message } from "./types";

// What a notification says. Built ONLY from the user's own saved data: the memory, its plan and its reminder. It states
// what is there (company, role, deadline, unfinished steps, the shopping list, the draft) and nothing else. It never
// describes a conversation, a promise or a relationship that the user's data doesn't contain.

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const stepOutput = (p: Plan | undefined, tool: string): Record<string, unknown> | null => {
  const s = p?.steps.find((x: PlanStep) => x.tool === tool && (x.state === "succeeded" || x.state === "awaiting_review"));
  return s?.output ?? null;
};
const memLink = (m: Memory) => ({ label: "Original memory", href: `/memories/${m.id}` });

export function reminderMessage(input: { reminder: Reminder; memory: Memory; plans: Plan[]; tz: string }): Message {
  const { reminder, memory, tz } = input;
  const v = effective(memory);
  const x = memory.extraction;
  // the plan that created this reminder, or else the newest unfinished one for the memory
  const plan = input.plans.find((p) => p.actionId === reminder.actionId) ?? input.plans.find((p) => !["completed", "rejected"].includes(p.status)) ?? input.plans[0];
  const when = `Due ${formatInZone(new Date(reminder.dueAt), reminder.timezone ?? tz)}`;
  const links = [memLink(memory)];
  const lines: string[] = [];
  let kind: Message["kind"] = "generic";
  let draft: string | null = null;

  if (reminder.note.trim()) lines.push(clip(reminder.note.trim(), 300));

  if (x?.job || (v.contentType === "job" && plan?.workflow === "job_application")) {
    kind = "job";
    const company = x?.job?.company;
    const role = x?.job?.role;
    if (company || role) lines.push(`${[role, company].filter(Boolean).join(" at ")}`);
    if (v.deadline) lines.push(`Application deadline: ${v.deadline}`);
    const pending = plan?.steps.filter((s) => !["succeeded", "skipped"].includes(s.state)).slice(0, 4).map((s) => s.title) ?? [];
    if (pending.length) lines.push(`Still to do: ${pending.join("; ")}`);
    else if (plan?.status === "completed") lines.push("Your application plan is complete.");
    if (x?.job?.applyUrl) links.push({ label: "Application page", href: x.job.applyUrl });
  } else if (v.contentType === "recipe") {
    kind = "recipe";
    lines.push(`Recipe: ${v.title}`);
    const list = stepOutput(plan, "build_shopping_list");
    const items = ((list?.items as { name: string; quantity: number | null; unit: string | null; checked?: boolean }[] | undefined) ?? []).filter((i) => !i.checked);
    if (items.length) lines.push(`Shopping list (${items.length}): ${items.slice(0, 8).map((i) => [i.quantity, i.unit, i.name].filter((p) => p !== null && p !== "").join(" ")).join(", ")}${items.length > 8 ? ", …" : ""}`);
    if (memory.source.url) links.push({ label: "Saved link", href: memory.source.url });
    else if (memory.source.fileName) links.push({ label: "Saved screenshot", href: `/api/files/${memory.source.fileName}` });
  } else if (v.intentKind === "follow_up" || reminder.kind === "follow_up") {
    kind = "follow_up";
    const own = memory.source.kind === "note" || memory.source.text ? memory.source.text?.trim() : undefined;
    // the user's own words, quoted: Acorn doesn't describe what was said or promised
    lines.push(own ? `You saved: “${clip(own.replace(/\s+/g, " "), 240)}”` : `You wanted to follow up on: ${v.title}`);
    const email = stepOutput(plan, "draft_email") as { subject?: string; body?: string } | null;
    if (email?.body) draft = `Subject: ${email.subject ?? ""}\n\n${email.body}`;
  } else if (v.deadline) {
    lines.push(`Deadline: ${v.deadline}`);
  }

  lines.push(when);
  if (plan && !["completed", "rejected"].includes(plan.status)) links.push({ label: "Open the plan", href: `/memories/${memory.id}#agent-heading` });
  return { kind, title: clip(reminder.title, 160), lines: lines.slice(0, 12), links: links.slice(0, 6), draft };
}

/** Plain text for email: the message, its links as full URLs (needs APP_BASE_URL) and how to change settings. */
export function renderEmail(m: Message, baseUrl: string | null): { subject: string; text: string } {
  const abs = (h: string) => (/^https?:\/\//i.test(h) ? h : baseUrl ? `${baseUrl.replace(/\/+$/, "")}${h}` : h);
  const text = [
    m.title,
    "",
    ...m.lines,
    ...(m.draft ? ["", "A draft you can edit and send yourself (Acorn never sends it):", "", m.draft] : []),
    "",
    ...m.links.map((l) => `${l.label}: ${abs(l.href)}`),
    "",
    "—",
    `You get this because you turned on email notifications in Acorn. Change that in Settings${baseUrl ? `: ${abs("/settings/notifications")}` : ""}.`,
  ].join("\n");
  return { subject: m.kind === "briefing" ? m.title : `Reminder: ${m.title}`, text };
}
