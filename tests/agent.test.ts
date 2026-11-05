import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvePlan, approveReview, canComplete, completeUserStep, createPlan, editStep, makeIO, PlanError, rejectPlan, retryStep, setStepInput, skipStep } from "@/lib/agent/executor";
import { intentSuggestion, workflowFor } from "@/lib/agent/intents";
import { buildPlan, reminderForDeadline, validatePlan } from "@/lib/agent/planner";
import { Permission, Plan } from "@/lib/agent/schema";
import { runTool, ToolError, TOOLS, type ToolCtxIn } from "@/lib/agent/tools";
import { captureMemory } from "@/lib/process";
import { applyCorrection, effective, type IntentKind } from "@/lib/schema";
import { getAction, getCv, getMemory, getPlan, listReminders, setCv, updateMemory } from "@/lib/store";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-agent-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.ACORN_MODE = "demo";
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const JOB = "sample-job-lumen";
const RECIPE = "sample-recipe-pasta";
const PERSON = "sample-person-priya";
const confirm = async (id: string, kind: IntentKind) => {
  await updateMemory(id, (m) => applyCorrection(m, { userIntent: { kind } }, new Date()));
};
const CV = `Asha Rao
asha.rao@example.com | +91 98765 43210

Experience
Senior Frontend Engineer, Brightly Labs
Jan 2021 - Present
- Built React and TypeScript apps in production for the growth team
- Ran A/B tests on the signup funnel and reported funnel metrics weekly

Frontend Engineer, Kiln Studio
Jun 2018 - Dec 2020
- Led a Next.js migration with server rendering and web performance budgets

Skills
React, TypeScript, Next.js, SQL, A/B testing`;

const step = (p: Plan, id: string) => p.steps.find((s) => s.id === id)!;

describe("intent suggestions", () => {
  it("labels a guess as a suggestion and offers no workflow until the user confirms", async () => {
    const m = (await getMemory(JOB))!;
    const s = intentSuggestion(m)!;
    expect(s).toMatchObject({ kind: "pursue", status: "suggested", isSuggestion: true, relatedMemoryId: JOB, workflow: null });
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.nextSteps.length).toBeGreaterThan(0);
    // dates are only those the item states, each with its words
    expect(s.dates.every((d) => d.evidence.length > 0)).toBe(true);
    await expect(createPlan(JOB)).rejects.toThrow(/why you saved this/);
  });

  it("invents nothing for a note that points to no purpose, and never claims a stated intent without the user's own words", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `The meeting room is on the third floor. [${randomUUID()}]` });
    expect(memory.extraction?.intentGuess ?? null).toBeNull();
    expect(intentSuggestion(memory)).toBeNull();
    expect(workflowFor(memory)).toBeNull();
    expect(memory.extraction?.dates).toEqual([]); // no deadline, no date made up
  });

  it("maps a confirmed intent to the right workflow", async () => {
    await confirm(JOB, "pursue");
    await confirm(RECIPE, "try");
    await confirm(PERSON, "reconnect");
    expect(workflowFor((await getMemory(JOB))!)).toBe("job_application");
    expect(workflowFor((await getMemory(RECIPE))!)).toBe("recipe");
    expect(workflowFor((await getMemory(PERSON))!)).toBe("followup");
    expect(intentSuggestion((await getMemory(JOB))!)).toMatchObject({ status: "confirmed", isSuggestion: false, basis: "user" });
  });

  it("a dismissed guess yields no plan", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `Maybe look at https://example.com/${randomUUID()} someday` });
    await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "none" } }, new Date()));
    expect(workflowFor((await getMemory(memory.id))!)).toBeNull();
    await expect(createPlan(memory.id)).rejects.toThrow(PlanError);
  });
});

describe("planning and validation", () => {
  it("builds a typed plan that runs nothing and asks for approval", async () => {
    const m = (await getMemory(JOB))!;
    const plan = buildPlan(m, randomUUID(), new Date());
    expect(Plan.safeParse(plan).success).toBe(true);
    expect(plan.status).toBe("awaiting_approval");
    expect(plan.steps.every((s) => s.state === "pending" && s.attempts === 0 && !s.output)).toBe(true);
    expect(plan.steps.map((s) => s.tool ?? "you")).toEqual(["retrieve_memory", "search_memories", "read_cv", "compare_job_to_cv", "draft_resume", "draft_cover_letter", "create_checklist", "create_reminder", "you"]);
    expect(plan.permissionsRequested.sort()).toEqual(["compute", "memory:read", "profile:cv:read", "reminder:write"]);
    expect(plan.approvedPermissions).toEqual([]);
    // the last step is the user's: Acorn never submits an application
    expect(step(plan, "s9").kind).toBe("user");
  });

  it("only derives a reminder date from a real deadline", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    expect(reminderForDeadline("2026-11-10", now)).toBe("2026-11-09T09:00:00.000Z");
    expect(reminderForDeadline("2026-11-02", now)).toBe("2026-11-02T09:00:00.000Z");
    expect(reminderForDeadline("2026-10-30", now)).toBeNull();
    expect(reminderForDeadline("not-a-date", now)).toBeNull();
  });

  it("rejects invalid plans: unknown tools, hidden permissions, a user step naming a tool, bad references, loops, external permission", async () => {
    const m = (await getMemory(JOB))!;
    const good = buildPlan(m, randomUUID(), new Date());
    const clone = (f: (p: Plan) => void) => {
      const p = structuredClone(good);
      f(p);
      return p;
    };
    expect(() => validatePlan(clone((p) => { step(p, "s1").tool = "send_email" as never; }))).toThrow(/doesn't exist/);
    expect(() => validatePlan(clone((p) => { step(p, "s4").permissions = ["compute"]; }))).toThrow(/permissions/);
    expect(() => validatePlan(clone((p) => { step(p, "s9").tool = "retrieve_memory"; }))).toThrow(/yours to do/);
    expect(() => validatePlan(clone((p) => { step(p, "s5").dependsOn = []; }))).toThrow(/without depending/);
    expect(() => validatePlan(clone((p) => { step(p, "s1").dependsOn = ["s4"]; }))).toThrow(/loop/);
    expect(() => validatePlan(clone((p) => { p.permissionsRequested = ["compute"]; }))).toThrow(/permission list/);
    // there is simply no permission for the outside world
    expect(Permission.safeParse("external:send_email").success).toBe(false);
    expect(Permission.options).not.toContain("external");
    expect(Object.values(TOOLS).every((t) => t.external === false)).toBe(true);
  });
});

describe("tool authorization", () => {
  const ctx = async (memoryIds: string[]): Promise<ToolCtxIn> => ({
    io: makeIO(new Date()),
    plan: { id: "p", memoryId: memoryIds[0], actionId: "a", memoryIds },
    stepId: "s1",
  });
  const grant = (p: Permission[]) => ({ stepPermissions: p, approved: p });

  it("refuses a tool when the permission was not approved, declared, or the tool is unknown", async () => {
    const c = await ctx([JOB]);
    await expect(runTool(c, "retrieve_memory", { memoryId: JOB }, { stepPermissions: ["memory:read"], approved: [] })).rejects.toThrow(/Not permitted/);
    await expect(runTool(c, "retrieve_memory", { memoryId: JOB }, { stepPermissions: [], approved: ["memory:read"] })).rejects.toThrow(/Not permitted/);
    await expect(runTool(c, "send_email", {}, grant(["compute"]))).rejects.toThrow(/does not exist/);
  });

  it("validates input and refuses memories that are not part of the plan", async () => {
    const c = await ctx([JOB]);
    await expect(runTool(c, "retrieve_memory", {}, grant(["memory:read"]))).rejects.toThrow(/missing something/);
    await expect(runTool(c, "retrieve_memory", { memoryId: JOB, extra: 1 }, grant(["memory:read"]))).rejects.toThrow(/missing something/);
    await expect(runTool(c, "retrieve_memory", { memoryId: RECIPE }, grant(["memory:read"]))).rejects.toThrow(/not part of this plan/);
    await expect(runTool(c, "retrieve_memory", { memoryId: randomUUID() }, grant(["memory:read"]))).rejects.toThrow(ToolError);
    const ok = await runTool(c, "retrieve_memory", { memoryId: JOB }, grant(["memory:read"]));
    expect(ok.result.passed).toBe(true);
    expect(ok.output.memoryId).toBe(JOB);
  });

  it("a reminder can only be made for a memory in the plan, never in the past", async () => {
    const c = await ctx([JOB]);
    const g = grant(["reminder:write"]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(runTool(c, "create_reminder", { memoryId: RECIPE, title: "x", dueAt: future }, g)).rejects.toThrow(/not part of this plan/);
    await expect(runTool(c, "create_reminder", { memoryId: JOB, title: "x", dueAt: "2020-01-01T00:00:00Z" }, g)).rejects.toThrow(/in the past/);
    await expect(runTool(c, "create_reminder", { memoryId: JOB, title: "x", dueAt: "tomorrow" }, g)).rejects.toThrow(/missing something/);
  });

  it("update_action_status can never approve or complete", async () => {
    const c = await ctx([JOB]);
    for (const to of ["completed", "approved", "proposed"]) {
      await expect(runTool(c, "update_action_status", { to }, grant(["action:write"]))).rejects.toThrow(/Only you can approve/);
    }
  });
});

describe("job application workflow", () => {
  let planId: string;
  let actionId: string;
  const cvBullets = CV.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

  it("creating a plan runs nothing and is idempotent", async () => {
    await setCv(null);
    const r = (await createPlan(JOB))!;
    planId = r.plan.id;
    actionId = r.plan.actionId;
    expect(r.created).toBe(true);
    expect(r.plan.status).toBe("awaiting_approval");
    expect(r.plan.steps.every((s) => s.state === "pending")).toBe(true);
    expect((await getAction(actionId))!).toMatchObject({ state: "awaiting_approval", kind: "executed" });
    expect(await listReminders()).toEqual([]);
    const again = (await createPlan(JOB))!;
    expect(again).toMatchObject({ created: false });
    expect(again.plan.id).toBe(planId);
  });

  it("nothing executes before approval", async () => {
    const { advance } = await import("@/lib/agent/executor");
    const p = (await advance(planId))!;
    expect(p.status).toBe("awaiting_approval");
    expect(p.steps.every((s) => s.state === "pending")).toBe(true);
    await expect(approveReview(planId, "s4")).rejects.toThrow(PlanError);
  });

  it("without a CV the plan fails clearly, honestly and can be retried", async () => {
    const p = (await approvePlan(planId))!;
    expect(p.status).toBe("failed");
    expect(step(p, "s1").state).toBe("succeeded");
    expect(step(p, "s3")).toMatchObject({ state: "failed", attempts: 1 });
    expect(step(p, "s3").error).toMatch(/add it, then retry/i);
    expect(step(p, "s4").state).toBe("pending"); // nothing downstream ran on missing data
    expect((await getAction(actionId))!.state).toBe("failed");
    const again = (await retryStep(planId, "s3"))!;
    expect(step(again, "s3")).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("after adding the CV, retrying continues the same plan and stops at the comparison for review", async () => {
    await setCv(CV);
    const p = (await retryStep(planId, "s3"))!;
    expect(step(p, "s3")).toMatchObject({ state: "succeeded", attempts: 3 });
    expect(step(p, "s3").output).toMatchObject({ present: true, characters: CV.length, experience: 2, skills: 5 }); // never the CV text itself
    expect(JSON.stringify(step(p, "s3").output)).not.toContain("Brightly");
    expect(step(p, "s4").state).toBe("awaiting_review");
    expect(p.status).toBe("awaiting_you");
    expect((await getAction(actionId))!.state).toBe("in_progress");
    expect(step(p, "s5").state).toBe("pending"); // waits for your review of the comparison
  });

  it("grades each requirement against the CV's own words, and asks about what is ambiguous", async () => {
    const p = (await getPlan(planId))!;
    const out = step(p, "s4").output as { results: import("@/lib/agent/match").RequirementResult[]; counts: Record<string, number>; semantic: { used: boolean } };
    expect(out.semantic.used).toBe(false);
    expect(out.results.map((r) => r.status)).toEqual(["VERIFIED_MATCH", "POTENTIAL_MATCH", "VERIFIED_MATCH", "POTENTIAL_MATCH"]);
    for (const r of out.results) {
      for (const e of r.evidence) expect(CV.slice(e.span.start, e.span.end)).toBe(e.quote); // exact words, at the place they point to
      expect(r.needsConfirmation).toBe(r.status !== "VERIFIED_MATCH");
      expect(r.explanation.length).toBeGreaterThan(10);
      expect(r.confidence).toBeGreaterThan(0);
    }
    // years are backed by the dates on the role they appear under, not guessed
    const years = out.results[0];
    expect(years.years).toMatchObject({ required: 3 });
    expect(years.years!.shownMonthsMin).toBeGreaterThanOrEqual(36);
    expect(years.evidence[0].dates).toBe("Jan 2021 - Present");
    // an A/B experience line with some of the words is potential, never verified
    expect(out.results[1].missingTerms.length).toBeGreaterThan(0);
    expect(out.results[1].evidence[0].quote).toContain("A/B tests");
    expect(out.results[3].status).toBe("POTENTIAL_MATCH");
    expect(step(p, "s4").result!.passed).toBe(true);
  });

  it("only claims what is verified or what you confirmed, and leaves the rest as marked blanks", async () => {
    // you answer the ambiguous ones: #2 is true, #4 is not
    let p = (await editStep(planId, "s4", { decisions: { "1": "confirmed", "3": "rejected" } }))!;
    expect(step(p, "s4").edited).toBe(true);
    await expect(editStep(planId, "s4", { decisions: { "0": "confirmed" } })).rejects.toThrow(/Only a potential or unverified/);
    p = (await approveReview(planId, "s4"))!;
    for (const id of ["s5", "s6", "s7"]) expect(`${id}:${step(p, id).state}:${step(p, id).error ?? ""}`).toBe(`${id}:awaiting_review:`);

    const letter = step(p, "s6").output as import("@/lib/agent/draft").CoverLetter;
    const claims = letter.lines.filter((l) => l.requirement !== null);
    expect(claims.map((c) => c.basis)).toEqual(["verified", "confirmed_by_you", "verified"]);
    for (const c of claims) expect(CV.slice(c.evidence!.span.start, c.evidence!.span.end)).toBe(c.evidence!.quote);
    expect(letter.unsupported).toEqual(["Nice to have: product analytics or growth engineering background"]);
    expect(letter.text).toContain("[TO COMPLETE");
    expect(letter.text).not.toMatch(/analytics.*(?:I have|my experience in)/);
    expect(letter.flags).toEqual([]);
    expect(step(p, "s6").result!.checks.every((c) => c.passed)).toBe(true);
  });

  it("the resume is your CV laid out for the job: every line traces to the CV, no bullet is dropped, nothing is added", async () => {
    const p = (await getPlan(planId))!;
    const resume = step(p, "s5").output as import("@/lib/agent/draft").ResumeDraft;
    for (const l of resume.lines.filter((x) => x.kind === "cv")) {
      expect(CV.slice(l.evidence!.span.start, l.evidence!.span.end)).toBe(l.evidence!.quote);
      expect(l.text.replace(/^- /, "")).toBe(l.evidence!.quote);
    }
    for (const b of cvBullets) expect(resume.text).toContain(b);
    const computed = resume.lines.find((l) => l.kind === "computed")!;
    expect(computed.text).toMatch(/^Jan 2021 - Present \(\d+ years? \d+ months?\)$/);
    expect(resume.lines.filter((l) => l.kind === "heading").every((l) => ["Experience", "Skills most relevant to this role", "Other skills"].includes(l.text))).toBe(true);
    expect(resume.text).not.toMatch(/Kubernetes|Python|Staff|led a team of/i);
    // the role the job's requirements rest on comes first
    expect(resume.text.indexOf("Brightly Labs")).toBeLessThan(resume.text.indexOf("Kiln Studio"));
    expect(step(p, "s5").result!.checks.every((c) => c.passed)).toBe(true);

    const items = (step(p, "s7").output as { items: { text: string; done: boolean }[] }).items;
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items.some((i) => /Apply yourself on the employer's site/.test(i.text))).toBe(true);
    expect(items.some((i) => /Confirm yourself/.test(i.text))).toBe(false); // you already answered them
  });

  it("created a reminder from the real deadline, linked to the memory and the action", async () => {
    const [r] = await listReminders({ memoryId: JOB });
    const m = (await getMemory(JOB))!;
    expect(r).toMatchObject({ memoryId: JOB, actionId, status: "scheduled" });
    expect(r.dueAt.slice(0, 10) <= effective(m).deadline!).toBe(true);
  });

  it("an edited draft is marked as yours, and words that are in neither your CV nor the job are flagged for review", async () => {
    const p = (await editStep(planId, "s6", { text: "Dear team,\nI led a Kubernetes rollout that cut costs by 40%. [TO COMPLETE]" }))!;
    expect(step(p, "s6")).toMatchObject({ edited: true, state: "awaiting_review" });
    const out = step(p, "s6").output as { flags: string[] };
    expect(out.flags).toEqual(expect.arrayContaining(["40%"]));
    expect(step(p, "s6").result!.checks[0].name).toBe("Edited by you");
    expect(step(p, "s6").result!.checks[0].detail).toContain("40%");
    await expect(editStep(planId, "s6", { items: [{ text: "x" }] })).rejects.toThrow(/can't be edited/);
    await expect(editStep(planId, "s4", { text: "x" })).rejects.toThrow(/waiting for your review|can't be edited/);
  });

  it("does not complete from drafts alone: the application is the user's to do and to evidence", async () => {
    for (const id of ["s5", "s6", "s7"]) await approveReview(planId, id);
    let p = (await getPlan(planId))!;
    expect(p.status).toBe("awaiting_you");
    expect(canComplete(p)).toBe(false);
    expect(step(p, "s9").state).toBe("pending");
    await expect(completeUserStep(planId, "s9", "done")).rejects.toThrow(/at least 10 characters/);
    expect((await getAction(actionId))!.state).toBe("in_progress");

    p = (await completeUserStep(planId, "s9", "Applied on jobs.example.com, confirmation LUM-48213"))!;
    expect(p.status).toBe("completed");
    expect(canComplete(p)).toBe(true);
    const a = (await getAction(actionId))!;
    expect(a.state).toBe("completed");
    expect(a.evidence).toContain("LUM-48213");
    expect(a.evidence).toMatch(/verified 8 step/);
    await expect(completeUserStep(planId, "s9", "again with more text here")).rejects.toThrow(PlanError);
    await expect(rejectPlan(planId, "x")).rejects.toThrow(/already completed/);
  });
});

describe("recipe workflow", () => {
  let planId: string;

  it("extracts ingredients with quantities, labels substitutions as inferred, and keeps your edits distinct", async () => {
    const r = (await createPlan(RECIPE))!;
    planId = r.plan.id;
    expect(r.plan.workflow).toBe("recipe");
    let p = (await approvePlan(planId))!;
    expect(step(p, "s3").state).toBe("awaiting_review");
    expect(p.status).toBe("awaiting_you");

    const list = step(p, "s3").output as { items: { id: string; name: string; quantity: number | null; unit: string | null; source: string }[]; substitutions: { for: string; source: string }[] };
    const byName = Object.fromEntries(list.items.map((i) => [i.name, i]));
    expect(byName["spaghetti"]).toMatchObject({ quantity: 200, unit: "g", source: "extracted" });
    expect(byName["garlic"]).toMatchObject({ quantity: 4, unit: "clove" });
    expect(byName["parmesan"]).toMatchObject({ quantity: 0.5, unit: "cup" });
    expect(byName["chilli flakes"]).toMatchObject({ quantity: null, unit: null });
    expect(list.items.every((i) => i.source === "extracted")).toBe(true);
    expect(list.substitutions.length).toBeGreaterThan(0);
    expect(list.substitutions.every((s) => s.source === "inferred")).toBe(true);
    expect(list.items.map((i) => i.name)).not.toContain("pecorino romano");

    // edit: change one quantity, add one item, remove the rest of nothing; unchanged items stay "extracted"
    const next = list.items.map((i) => (i.name === "garlic" ? { ...i, quantity: 6 } : i));
    next.push({ id: "", name: "olive oil", quantity: 2, unit: "tbsp", source: "you" });
    p = (await editStep(planId, "s3", { items: next }))!;
    const edited = (step(p, "s3").output as { items: { name: string; source: string }[] }).items;
    expect(edited.find((i) => i.name === "garlic")!.source).toBe("you");
    expect(edited.find((i) => i.name === "olive oil")!.source).toBe("you");
    expect(edited.find((i) => i.name === "spaghetti")!.source).toBe("extracted");
    expect(step(p, "s3").edited).toBe(true);
  });

  it("the cooking reminder is optional: it waits for a date you choose, then is created and linked", async () => {
    let p = (await approveReview(planId, "s3"))!;
    expect(step(p, "s4").state).toBe("pending");
    expect(p.status).toBe("awaiting_you");
    await expect(setStepInput(planId, "s4", "dueAt", "2020-01-01T00:00:00Z")).rejects.toThrow(/future/);
    await expect(setStepInput(planId, "s4", "title", "x" as never)).rejects.toThrow(/can't be set/);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    p = (await setStepInput(planId, "s4", "dueAt", when))!;
    expect(step(p, "s4").state).toBe("succeeded");
    expect(p.status).toBe("completed");
    const rs = await listReminders({ memoryId: RECIPE });
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ actionId: p.actionId, status: "scheduled" });
    expect((await getAction(p.actionId))!.state).toBe("completed");
  });

  it("an optional step can be skipped, and skipping still completes the plan only when everything else is verified", async () => {
    await updateMemory(RECIPE, (m) => m); // new plan allowed once the first completed
    const r = (await createPlan(RECIPE))!;
    expect(r.created).toBe(true);
    let p = (await approvePlan(r.plan.id))!;
    p = (await approveReview(p.id, "s3"))!;
    await expect(skipStep(p.id, "s3")).rejects.toThrow(/optional/);
    p = (await skipStep(p.id, "s4"))!;
    expect(p.status).toBe("completed");
    expect(step(p, "s4").state).toBe("skipped");
  });

  it("fails clearly when the recipe has no ingredients to find", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `Remember to love cooking dinner, it is fun. ${randomUUID()}` });
    await updateMemory(memory.id, (m) => ({ ...m, extraction: m.extraction && { ...m.extraction, contentType: "recipe", entities: [] } }));
    await confirm(memory.id, "try");
    const r = (await createPlan(memory.id))!;
    expect(r.plan.workflow).toBe("recipe");
    const p = (await approvePlan(r.plan.id))!;
    expect(step(p, "s2")).toMatchObject({ state: "failed" });
    expect(step(p, "s2").error).toMatch(/couldn't find any ingredients/);
    expect(p.status).toBe("failed");
  });
});

describe("follow-through plan and rejection", () => {
  it("a reconnect plan drafts (never sends) a message and needs your evidence", async () => {
    const r = (await createPlan(PERSON))!;
    expect(r.plan.workflow).toBe("followup");
    let p = (await approvePlan(r.plan.id))!;
    const email = step(p, "s2");
    expect(email.state).toBe("awaiting_review");
    expect(email.output).toMatchObject({ sent: false });
    expect(JSON.stringify(email.result)).toContain("Acorn has no way to send email");
    p = (await rejectPlan(p.id, "Not now"))!;
    expect(p.status).toBe("rejected");
    expect((await getAction(p.actionId))!.state).toBe("cancelled");
    await expect(approveReview(p.id, "s2")).rejects.toThrow(/rejected/);
  });

  it("rejecting before approval cancels everything and nothing ever ran", async () => {
    await confirm(JOB, "pursue"); // new plan allowed: the first one completed
    const r = (await createPlan(JOB))!;
    const p = (await rejectPlan(r.plan.id, undefined))!;
    expect(p.status).toBe("rejected");
    expect(p.steps.every((s) => s.state === "pending")).toBe(true);
    expect((await getAction(p.actionId))!.state).toBe("cancelled");
    await expect(approvePlan(p.id)).rejects.toThrow(/already been decided/);
  });

  it("the CV round-trips and is cleared on request", async () => {
    await setCv(CV);
    expect((await getCv())!.text).toBe(CV);
    await setCv(null);
    expect(await getCv()).toBeNull();
  });
});
