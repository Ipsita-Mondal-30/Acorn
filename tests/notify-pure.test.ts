import { describe, expect, it } from "vitest";
import { Plan, type PlanStep, type Reminder } from "@/lib/agent/schema";
import { buildBriefing } from "@/lib/notify/briefing";
import { incompletePlans, overdueActions, postponedReminders, suggestions, upcomingDeadlines, type Snapshot } from "@/lib/notify/followthrough";
import { reminderMessage, renderEmail } from "@/lib/notify/message";
import { DEFAULT_PREFS } from "@/lib/notify/types";
import { buildSeed } from "@/lib/seed";
import type { Action, Memory } from "@/lib/schema";

const NOW = new Date("2026-11-05T10:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const prefs = { ...DEFAULT_PREFS, timezone: "Asia/Kolkata" };
const seed = buildSeed(NOW).memories;
const get = (id: string, over: Partial<Memory> = {}): Memory => ({ ...structuredClone(seed.find((m) => m.id === id)!), isSample: false, ...over });
const confirmed = { kind: "pursue" as const, status: "confirmed" as const, at: NOW.toISOString() };

const reminder = (memoryId: string, over: Partial<Reminder> = {}): Reminder => ({
  id: crypto.randomUUID(), memoryId, actionId: null, title: "Apply to Lumen", note: "", dueAt: day(0.1), kind: "intent", timezone: "Asia/Kolkata", snoozeCount: 0, status: "scheduled",
  history: [], createdAt: day(-3), updatedAt: day(-3), ...over,
});
const step = (id: string, title: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id, title, why: "", kind: "tool", input: {}, dependsOn: [], permissions: [], expected: "", verification: "", failureConditions: [], reviewRequired: false, optional: false, userInputs: [],
  state: "pending", attempts: 0, edited: false, history: [], ...over,
});
const plan = (memoryId: string, workflow: "job_application" | "recipe" | "followup", steps: PlanStep[], over: Partial<Plan> = {}): Plan =>
  Plan.parse({ id: crypto.randomUUID(), memoryId, actionId: crypto.randomUUID(), workflow, intentKind: "pursue", goal: "Prepare a truthful application", context: { memoryIds: [memoryId], summary: "", evidence: [] }, status: "awaiting_you", permissionsRequested: [], approvedPermissions: [], steps, createdAt: day(-6), updatedAt: day(-6), history: [], ...over });
const action = (memoryId: string, over: Partial<Action> = {}): Action => ({ id: crypto.randomUUID(), memoryId, title: "Tailor resume and apply", detail: "", kind: "executed", state: "in_progress", history: [], createdAt: day(-9), updatedAt: day(-9), ...over });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ memories: [], reminders: [], actions: [], plans: [], prefs, now: NOW, ...over });

describe("reminder messages carry context from the user's own data", () => {
  it("job: company and role, the deadline, what is still to do, and the way back to the memory", () => {
    const m = get("sample-job-lumen", { userIntent: confirmed });
    const p = plan(m.id, "job_application", [step("s1", "Read the saved memory", { state: "succeeded" }), step("s4", "Compare requirements with your CV", { state: "awaiting_review" }), step("s9", "Apply yourself on the employer's site", { kind: "user" })]);
    const msg = reminderMessage({ reminder: reminder(m.id), memory: m, plans: [p], tz: "Asia/Kolkata" });
    expect(msg.kind).toBe("job");
    expect(msg.lines.join("\n")).toContain("Frontend Engineer, Growth at Lumen Robotics");
    expect(msg.lines.join("\n")).toMatch(/Application deadline: \d{4}-\d{2}-\d{2}/);
    expect(msg.lines.join("\n")).toContain("Still to do: Compare requirements with your CV; Apply yourself on the employer's site");
    expect(msg.lines.join("\n")).not.toContain("Read the saved memory"); // done steps aren't "to do"
    expect(msg.lines.at(-1)).toMatch(/^Due .*\(Asia\/Kolkata\)$/);
    expect(msg.links).toEqual(expect.arrayContaining([{ label: "Original memory", href: `/memories/${m.id}` }, { label: "Open the plan", href: `/memories/${m.id}#agent-heading` }]));
    expect(msg.links.some((l) => l.label === "Application page")).toBe(true);
  });

  it("recipe: the name, the shopping list, the time, and the saved link or screenshot", () => {
    const m = get("sample-recipe-pasta", { userIntent: { kind: "try", status: "confirmed", at: NOW.toISOString() } });
    const list = { items: [{ id: "i1", name: "spaghetti", quantity: 200, unit: "g", checked: false }, { id: "i2", name: "garlic", quantity: 4, unit: "clove", checked: false }, { id: "i3", name: "lemon", quantity: 1, unit: null, checked: true }] };
    const p = plan(m.id, "recipe", [step("s3", "Build a shopping list", { tool: "build_shopping_list", state: "succeeded", output: list })]);
    const msg = reminderMessage({ reminder: reminder(m.id, { title: "Cook: Creamy lemon garlic pasta", kind: "recipe" }), memory: m, plans: [p], tz: "Asia/Kolkata" });
    expect(msg.kind).toBe("recipe");
    expect(msg.lines.join("\n")).toContain("Recipe: Creamy lemon garlic pasta");
    expect(msg.lines.join("\n")).toContain("Shopping list (2): 200 g spaghetti, 4 clove garlic"); // the ticked item is already bought
    expect(msg.links).toContainEqual({ label: "Saved link", href: "https://www.instagram.com/p/EXAMPLE1/" });
    const shot = reminderMessage({ reminder: reminder(m.id), memory: { ...m, source: { kind: "image", fileName: "abc.png", mimeType: "image/png" } }, plans: [], tz: "UTC" });
    expect(shot.links).toContainEqual({ label: "Saved screenshot", href: "/api/files/abc.png" });
  });

  it("follow-up: quotes only the user's own words, includes the draft, and asserts no past conversation", () => {
    const m = get("sample-person-priya", { source: { kind: "note", text: "Follow up with the recruiter about the interview" }, userIntent: { kind: "follow_up", status: "confirmed", at: NOW.toISOString() } });
    const draft = { subject: "Following up", body: "Hi [name],\n\nI'm following up on [what you are following up on].", sent: false };
    const p = plan(m.id, "followup", [step("s2", "Draft a message", { tool: "draft_email", state: "awaiting_review", output: draft })]);
    const msg = reminderMessage({ reminder: reminder(m.id, { kind: "follow_up", title: "Follow up" }), memory: m, plans: [p], tz: "Asia/Kolkata" });
    expect(msg.kind).toBe("follow_up");
    expect(msg.lines[0]).toBe("You saved: “Follow up with the recruiter about the interview”");
    expect(msg.draft).toContain("[what you are following up on]");
    const all = JSON.stringify(msg);
    expect(all).not.toMatch(/as we discussed|you promised|your (?:last|earlier) (?:call|meeting|conversation)|we spoke/i);
  });

  it("with no plan or story it still says what is there and nothing more", () => {
    const m = get("sample-article-idempotency");
    const msg = reminderMessage({ reminder: reminder(m.id, { title: "Read later", note: "after lunch" }), memory: m, plans: [], tz: "UTC" });
    expect(msg.kind).toBe("generic");
    expect(msg.lines[0]).toBe("after lunch");
    expect(msg.links).toEqual([{ label: "Original memory", href: `/memories/${m.id}` }]);
  });

  it("renders a plain-text email with absolute links, the draft marked as yours to send, and how to turn emails off", () => {
    const m = get("sample-job-lumen", { userIntent: confirmed });
    const msg = reminderMessage({ reminder: reminder(m.id), memory: m, plans: [], tz: "UTC" });
    const mail = renderEmail({ ...msg, draft: "Subject: Hi\n\nBody" }, "https://acorn.example/");
    expect(mail.subject).toBe("Reminder: Apply to Lumen");
    expect(mail.text).toContain(`Original memory: https://acorn.example/memories/${m.id}`);
    expect(mail.text).toContain("Acorn never sends it");
    expect(mail.text).toContain("https://acorn.example/settings/notifications");
    expect(renderEmail(msg, null).text).toContain(`Original memory: /memories/${m.id}`);
  });
});

describe("daily briefing", () => {
  const job = get("sample-job-lumen", { userIntent: confirmed, overrides: { deadline: "2026-11-08" } });
  const fu = get("sample-person-priya", { createdAt: day(-2), userIntent: { kind: "follow_up", status: "confirmed", at: NOW.toISOString() } });

  it("lists what needs you, in short sections, with links", () => {
    const rs = [
      reminder(job.id, { title: "Apply to Lumen", dueAt: "2026-11-05T14:00:00Z" }), // 19:30 Kolkata, today
      reminder(job.id, { title: "Old one", dueAt: day(-2) }), // overdue
      reminder(job.id, { title: "Tomorrow", dueAt: day(1) }),
      reminder(job.id, { title: "Done", dueAt: day(-1), status: "done" }),
    ];
    const p = plan(job.id, "job_application", [step("s1", "x")], { status: "awaiting_approval" });
    const b = buildBriefing(snap({ memories: [job, fu], reminders: rs, plans: [p] }));
    expect(b.isEmpty).toBe(false);
    expect(b.counts).toMatchObject({ dueToday: 1, overdue: 1, approvals: 1, deadlines: 1, followUps: 1 });
    const text = b.message.lines.join("\n");
    expect(text).toContain("Due today:\n  • Apply to Lumen");
    expect(text).toContain("Overdue:\n  • Old one");
    expect(text).toContain("Waiting for your approval:\n  • Prepare a truthful application");
    expect(text).toContain("Deadlines this week:");
    expect(text).toContain("You marked these for follow-up:");
    expect(text).not.toContain("Done");
    expect(text).not.toContain("Tomorrow"); // not today
    expect(b.message.title).toBe("Your day: 1 due today, 1 overdue, 1 to approve, 1 deadline this week");
    expect(b.message.kind).toBe("briefing");
    expect(b.message.links.length).toBeGreaterThan(0);
  });

  it("is short: at most five items a section, and never a summary of everything saved", () => {
    const many = Array.from({ length: 9 }, (_, i) => reminder(job.id, { title: `Late ${i}`, dueAt: day(-1 - i * 0.01) }));
    const b = buildBriefing(snap({ memories: seed, reminders: many }));
    const lines = b.message.lines.filter((l) => l.startsWith("  •"));
    expect(lines.filter((l) => /Late/.test(l))).toHaveLength(5);
    expect(b.message.lines.join("\n")).toContain("and 4 more");
    // none of the other 9 saved memories is listed just for existing
    expect(b.message.lines.join("\n")).not.toMatch(/Postgres query optimization|Passport renewal/);
  });

  it("a quiet day is empty, and unconfirmed intentions never put anything in it", () => {
    expect(buildBriefing(snap({ memories: seed })).isEmpty).toBe(true); // the seeded memories have guesses and deadlines, but no confirmed intent
    const guessed = get("sample-job-lumen", { overrides: { deadline: "2026-11-08" } }); // intent only suggested
    const b = buildBriefing(snap({ memories: [guessed] }));
    expect(b.isEmpty).toBe(true);
    expect(b.counts.deadlines).toBe(0);
    expect(buildBriefing(snap()).message.title).toBe("Nothing needs you today");
  });

  it("'today' is the user's local day", () => {
    const r = reminder(job.id, { title: "Late night", dueAt: "2026-11-05T20:00:00Z" }); // 01:30 on 6 Nov in Kolkata
    expect(buildBriefing(snap({ reminders: [r] })).counts.dueToday).toBe(0);
    expect(buildBriefing(snap({ reminders: [r], prefs: { ...prefs, timezone: "America/Los_Angeles" } })).counts.dueToday).toBe(1);
  });
});

describe("follow-through checks look and suggest; they never change anything", () => {
  const job = get("sample-job-lumen", { userIntent: confirmed, overrides: { deadline: "2026-11-09" } });

  it("finds overdue actions: past their schedule, or untouched for a week; not ideas, not finished work", () => {
    const stale = action(job.id, { id: "stale", updatedAt: day(-8) });
    const scheduled = action(job.id, { id: "sched", scheduledFor: day(-1), updatedAt: day(-1) });
    const fresh = action(job.id, { id: "fresh", updatedAt: day(-2) });
    const idea = action(job.id, { id: "idea", kind: "suggested", state: "proposed", updatedAt: day(-30) });
    const done = action(job.id, { id: "done", state: "completed", updatedAt: day(-30) });
    const cancelled = action(job.id, { id: "gone", state: "cancelled", updatedAt: day(-30) });
    const found = overdueActions(snap({ actions: [stale, scheduled, fresh, idea, done, cancelled] }));
    expect(found.map((f) => f.action.id).sort()).toEqual(["sched", "stale"]);
    expect(found.find((f) => f.action.id === "stale")!.why).toMatch(/has not moved for 8 days/);
  });

  it("notices a reminder that keeps being put off, and a plan that has stalled", () => {
    const r = reminder(job.id, { snoozeCount: 3, status: "snoozed" });
    expect(postponedReminders(snap({ reminders: [r, reminder(job.id, { snoozeCount: 2 })] })).map((x) => x.id)).toEqual([r.id]);
    const old = plan(job.id, "job_application", [step("s1", "x")], { status: "awaiting_you", updatedAt: day(-6) });
    const recent = plan(job.id, "job_application", [step("s1", "x")], { status: "awaiting_you", updatedAt: day(-1) });
    const finished = plan(job.id, "job_application", [step("s1", "x")], { status: "completed", updatedAt: day(-40) });
    expect(incompletePlans(snap({ plans: [old, recent, finished] })).map((p) => p.id)).toEqual([old.id]);
  });

  it("flags an upcoming deadline only when you decided to act on it and nothing covers it", () => {
    expect(upcomingDeadlines(snap({ memories: [job] })).map((d) => [d.memory.id, d.daysLeft])).toEqual([[job.id, 4]]);
    expect(upcomingDeadlines(snap({ memories: [job], reminders: [reminder(job.id)] }))).toEqual([]); // a reminder covers it
    expect(upcomingDeadlines(snap({ memories: [job], plans: [plan(job.id, "job_application", [step("s1", "x")])] }))).toEqual([]);
    expect(upcomingDeadlines(snap({ memories: [{ ...job, userIntent: undefined }] }))).toEqual([]); // intent not confirmed
    expect(upcomingDeadlines(snap({ memories: [{ ...job, overrides: { deadline: "2026-12-30" } }] }))).toEqual([]); // not this week
    expect(upcomingDeadlines(snap({ memories: [{ ...job, overrides: { deadline: "2026-11-01" } }] }))).toEqual([]); // already past
  });

  it("gives at most three suggestions, most pressing first, and respects 'not now'", () => {
    const s = snap({
      memories: [job],
      actions: [action(job.id, { id: "a1", updatedAt: day(-10) }), action(job.id, { id: "a2", updatedAt: day(-11) })],
      reminders: [reminder("another-memory", { snoozeCount: 4, status: "snoozed", dueAt: day(2) })],
      plans: [plan("another-memory", "job_application", [step("s1", "Compare")], { status: "failed", updatedAt: day(-7) })],
    });
    const out = suggestions({ ...s, memories: [{ ...job, overrides: { deadline: "2026-11-07" } }] });
    expect(out).toHaveLength(3); // four things are wrong; only three are shown
    expect(out[0].kind).toBe("upcoming_deadline"); // the nearest deadline outranks the rest
    expect(out.map((x) => x.kind)).toEqual(["upcoming_deadline", "overdue_action", "overdue_action"]);
    const hidden = suggestions({ ...s, memories: [], prefs: { ...prefs, snoozedSuggestions: { "action:a1": day(5), "action:a2": day(-1) } } });
    expect(hidden.map((x) => x.key)).toContain("action:a2"); // an expired "not now" is shown again
    expect(hidden.map((x) => x.key)).not.toContain("action:a1");
    for (const x of out) expect(x.link.href).toMatch(/^\/memories\//);
  });

  it("is read-only: the snapshot is untouched by every check", () => {
    const s = snap({ memories: [job], actions: [action(job.id, { updatedAt: day(-10) })], reminders: [reminder(job.id, { snoozeCount: 5 })], plans: [plan(job.id, "job_application", [step("s1", "x")], { updatedAt: day(-9) })] });
    const before = JSON.stringify(s);
    suggestions(s);
    buildBriefing(s);
    overdueActions(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});
