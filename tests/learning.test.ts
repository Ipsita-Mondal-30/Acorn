import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvePlan, approveReview, completeUserStep, createPlan, editStep, PlanError, setStepInput } from "@/lib/agent/executor";
import { buildPlan } from "@/lib/agent/planner";
import { StudyPack, applyProgress, blankOut, buildStudyPack, normalise, pickBlank, studyProgress, withoutProgress } from "@/lib/agent/study";
import { TOOLS } from "@/lib/agent/tools";
import { nextUp } from "@/lib/home";
import { captureMemory } from "@/lib/process";
import { applyCorrection, effective } from "@/lib/schema";
import { getAction, getMemory, getPlan, listPlans, listReminders, updateMemory } from "@/lib/store";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-learning-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.ACORN_MODE = "demo";
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const ARTICLE = `Redis persistence explained. Redis keeps data in memory, and offers two ways to save it to disk: RDB snapshots and the append-only file (AOF). RDB snapshots are compact and fast to restore. The append-only file logs every write, so it loses less data after a crash. I want to learn how to choose between them.`;

const input = {
  title: "Redis persistence",
  summary: "How Redis saves its in-memory data to disk, with RDB snapshots or an append-only file.",
  facts: [
    { statement: "Redis offers two ways to save data to disk: RDB snapshots and the append-only file.", quote: "offers two ways to save it to disk: RDB snapshots and the append-only file (AOF)" },
    { statement: "RDB snapshots are compact and fast to restore.", quote: "RDB snapshots are compact and fast to restore" },
    { statement: "The append-only file logs every write, so it loses less data after a crash.", quote: null },
  ],
  entities: [{ name: "Redis", kind: "technology" }, { name: "RDB", kind: "technology" }],
  readableText: ARTICLE,
};

describe("study pack content", () => {
  it("is built only from the memory: every card, note and blank traces to it", () => {
    const pack = buildStudyPack(input);
    const source = normalise([ARTICLE, input.summary, ...input.facts.map((f) => f.statement)].join(" "));
    expect(pack.cards.length).toBeGreaterThanOrEqual(3);
    for (const c of pack.cards) {
      expect(c.status).toBe("new");
      if (c.quote) expect(source).toContain(normalise(c.quote));
      if (c.cloze) {
        expect(source).toContain(normalise(c.back));
        expect(c.front).toContain("_____");
        expect(c.front).not.toContain(c.back); // the answer is not given away on the front
      }
    }
    for (const n of pack.notes) expect(source).toContain(normalise(n.text.slice(0, 40)));
    expect(pack.questions.length).toBeGreaterThanOrEqual(2);
    expect(pack.exercises.length).toBeGreaterThanOrEqual(2);
    expect(pack.sessions.map((s) => s.title)).toEqual(["Skim", "Read the source", "Flashcards", "Practice questions", "Exercise", "Revise"]);
    expect(StudyPack.safeParse(pack).success).toBe(true);
  });

  it("is deterministic, and invents nothing when there is nothing to study", () => {
    expect(buildStudyPack(input)).toEqual(buildStudyPack(input));
    expect(() => buildStudyPack({ ...input, summary: "", facts: [] })).toThrow(/nothing/i);
  });

  it("blanks a named thing first, then a number, then a long plain word", () => {
    expect(pickBlank("Redis keeps data in memory", [{ name: "Redis" }])).toBe("Redis");
    expect(pickBlank("The server restarts after 30 seconds", [])).toBe("30");
    expect(pickBlank("It is a very helpful approach", [])).toBe("approach");
    expect(blankOut("Redis keeps data", "Redis")).toBe("_____ keeps data");
    expect(pickBlank("a b c", [])).toBeNull();
  });

  it("tracks progress without ever changing content, and rejects ids that don't exist", () => {
    const pack = buildStudyPack(input);
    const next = applyProgress(pack, { cards: { c1: "known", c2: "review" }, questions: { q1: true }, exercises: { e1: true } });
    expect(studyProgress(next)).toMatchObject({ known: 1, review: 1, answered: 1, done: 1 });
    expect(withoutProgress(next)).toEqual(withoutProgress(pack));
    expect(studyProgress(pack).percent).toBe(0);
    expect(() => applyProgress(pack, { cards: { c99: "known" } })).toThrow(/card/);
    expect(() => applyProgress(pack, { questions: { q99: true } })).toThrow(/question/);
  });
});

describe("the learn journey end to end (local store, no model)", () => {
  it("saves, needs a confirmed intent, plans, waits for approval, builds a verified pack, keeps progress, and finishes only with your evidence", async () => {
    const { memory } = await captureMemory({ kind: "note", text: ARTICLE });
    expect(memory.status).toBe("ready");

    // no confirmed intent -> no plan
    await expect(createPlan(memory.id)).rejects.toThrow(/why you saved this/);
    await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "learn" } }, new Date()));
    const ready = (await getMemory(memory.id))!;
    expect(effective(ready).intentKind).toBe("learn");

    // the plan is a learning plan; it uses only the typed tools and asks for nothing outside Acorn
    const draft = buildPlan(ready, "act-x", new Date());
    expect(draft.steps.map((s) => s.tool ?? "you")).toEqual(["retrieve_memory", "build_study_pack", "create_reminder", "you"]);
    expect(draft.permissionsRequested.sort()).toEqual(["compute", "memory:read", "reminder:write"].sort());
    expect(draft.steps[2]!.input.dueAt).toBeUndefined(); // no revision date is invented

    const created = (await createPlan(memory.id))!;
    expect(created.created).toBe(true);
    let plan = created.plan;
    expect(plan.status).toBe("awaiting_approval");
    expect(plan.steps.every((s) => s.state === "pending")).toBe(true); // creating a plan runs nothing
    expect(await listReminders({ memoryId: memory.id })).toHaveLength(0);

    plan = (await approvePlan(plan.id))!;
    const pack = plan.steps[1]!;
    expect(pack.state).toBe("awaiting_review");
    expect(pack.result?.passed).toBe(true);
    const parsed = StudyPack.parse(pack.output);
    expect(parsed.cards.every((c) => c.status === "new")).toBe(true);

    // progress while the pack is still waiting for review, and again after accepting it
    plan = (await editStep(plan.id, "s2", { study: { cards: { c1: "known" } } }))!;
    expect(plan.steps[1]!.edited).toBe(false); // marking progress isn't editing the pack
    plan = (await approveReview(plan.id, "s2"))!;
    expect(plan.steps[1]!.state).toBe("succeeded");
    plan = (await editStep(plan.id, "s2", { study: { cards: { c2: "review" }, questions: { q1: true } } }))!;
    const after = StudyPack.parse(plan.steps[1]!.output);
    expect(studyProgress(after)).toMatchObject({ known: 1, review: 1, answered: 1 });
    // persisted, not just returned
    expect(StudyPack.parse((await getPlan(plan.id))!.steps[1]!.output).cards[0]!.status).toBe("known");

    // it can't be used to rewrite the pack
    await expect(editStep(plan.id, "s2", { study: { cards: { c99: "known" } } })).rejects.toThrow(PlanError);
    await expect(editStep(plan.id, "s2", { text: "new text" } as never)).rejects.toThrow(PlanError);

    // revision reminder: waits for a date you choose, then is created and verified
    expect(plan.steps[2]!.state).toBe("pending");
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    plan = (await setStepInput(plan.id, "s3", "dueAt", when))!;
    expect(plan.steps[2]!.state).toBe("succeeded");
    const reminders = await listReminders({ memoryId: memory.id });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toMatch(/^Revise:/);
    expect(reminders[0]!.status).toBe("scheduled");

    // the plan isn't done until you say what you learned
    expect(plan.status).toBe("awaiting_you");
    await expect(completeUserStep(plan.id, "s4", "ok")).rejects.toThrow(PlanError);
    plan = (await completeUserStep(plan.id, "s4", "Learned when to pick RDB versus AOF"))!;
    expect(plan.status).toBe("completed");
    expect((await getAction(plan.actionId))!.state).toBe("completed");
  });

  it("the home list says what to do next, and it follows the journey", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `${ARTICLE} Also: Redis Streams are an append-only log structure.` });
    const now = new Date();
    const all = async () => (await import("@/lib/store")).listMemories();
    let items = nextUp(await all(), await listPlans(), [], now, 20);
    expect(items.find((i) => i.memoryId === memory.id)).toMatchObject({ verb: "Tell Acorn why you saved this" });
    await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "learn" } }, new Date()));
    items = nextUp(await all(), await listPlans(), [], now, 20);
    expect(items.find((i) => i.memoryId === memory.id)).toMatchObject({ verb: "Make a plan" });
    const { plan } = (await createPlan(memory.id))!;
    items = nextUp(await all(), await listPlans(), [], now, 20);
    expect(items.find((i) => i.memoryId === memory.id)).toMatchObject({ verb: "Approve or reject the plan" });
    await approvePlan(plan.id);
    items = nextUp(await all(), await listPlans(), [], now, 20);
    expect(items.find((i) => i.memoryId === memory.id)).toMatchObject({ verb: "Review what Acorn prepared" });
  });
});

describe("the study tool", () => {
  it("is registered, compute-only and never external", () => {
    expect(TOOLS.build_study_pack).toMatchObject({ permissions: ["compute"], external: false });
  });
});
