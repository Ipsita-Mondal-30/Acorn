import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvePlan, approveReview, createPlan, editStep, setStepInput, skipStep } from "@/lib/agent/executor";
import { intentSuggestion } from "@/lib/agent/intents";
import type { RequirementResult } from "@/lib/agent/match";
import type { Plan } from "@/lib/agent/schema";
import { cvSummary, pasteCv, removeAllCvs, reparseCv, uploadCv } from "@/lib/cv/service";
import { CvFileError } from "@/lib/cv/extract";
import { captureMemory } from "@/lib/process";
import { applyCorrection } from "@/lib/schema";
import { getCv, getCvDocument, getMemory, getPlan, listCvDocuments, listReminders, updateCvDocument, updateMemory, uploadsDir } from "@/lib/store";
import { pdf, scannedPdf } from "./helpers/office";

const saved = { ...process.env };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-45-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_STORAGE = "local";
  process.env.ACORN_MODE = "demo";
  delete process.env.EMBEDDING_PROVIDER;
});
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const fx = (n: string) => new Uint8Array(readFileSync(path.resolve(__dirname, "fixtures", n)));
const confirm = (id: string, kind: Parameters<typeof applyCorrection>[1]["userIntent"] extends infer U ? (U extends { kind: infer K } ? K : never) : never) =>
  updateMemory(id, (m) => applyCorrection(m, { userIntent: { kind } }, new Date()));
const step = (p: Plan, id: string) => p.steps.find((s) => s.id === id)!;
const stored = () => (existsSync(path.join(dir, "uploads")) ? readdirSync(path.join(dir, "uploads")) : []);

describe("CV upload, replacement, re-parsing and removal", () => {
  it("keeps the original file exactly as uploaded and reads the text from it", async () => {
    const bytes = fx("cv-sample.docx");
    const { cv, warning } = await uploadCv(bytes, "Asha Rao CV.docx");
    expect(warning).toBeNull();
    expect(cv).toMatchObject({ source: "upload", fileKind: "docx", originalName: "Asha Rao CV.docx", isCurrent: true, readable: true });
    expect(cv.fileName).toMatch(/^[0-9a-f-]{36}\.docx$/);
    expect(new Uint8Array(readFileSync(path.join(uploadsDir(), cv.fileName!)))).toEqual(bytes); // byte for byte
    expect(cv.parsed.experience).toHaveLength(2);
    expect(cvSummary(cv).counts).toEqual({ experience: 2, projects: 1, skills: 6, education: 1, certifications: 1 });
    expect((await getCv())!.text).toBe(cv.text);
  });

  it("a replacement becomes current and the old version and its file are kept", async () => {
    const first = (await getCvDocument())!;
    const { cv: second } = await uploadCv(fx("cv-sample.pdf"), "cv.pdf");
    expect(second).toMatchObject({ fileKind: "pdf", isCurrent: true });
    const all = await listCvDocuments();
    expect(all).toHaveLength(2);
    expect(all.filter((d) => d.isCurrent).map((d) => d.id)).toEqual([second.id]);
    expect(all.find((d) => d.id === first.id)).toMatchObject({ isCurrent: false });
    expect(all.find((d) => d.id === first.id)!.replacedAt).toBeTruthy();
    expect(stored()).toEqual(expect.arrayContaining([first.fileName!, second.fileName!]));
    expect((await getCvDocument())!.id).toBe(second.id);
  });

  it("re-reads the stored original with the current parser, in place", async () => {
    const cur = (await getCvDocument())!;
    await updateCvDocument(cur.id, (d) => ({ ...d, parsed: { ...d.parsed, experience: [], skills: [] }, parserVersion: "old" }));
    expect((await getCvDocument())!.parsed.experience).toEqual([]);
    const fresh = (await reparseCv())!;
    expect(fresh.id).toBe(cur.id);
    expect(fresh.parsed.experience).toHaveLength(2);
    expect(fresh.parserVersion).toBe("cv-rules-1");
    expect(await listCvDocuments()).toHaveLength(2); // no new version
  });

  it("pasted text is a CV too, and a missing original is reported, not hidden", async () => {
    const p = await pasteCv("Jo Lee\n\nExperience\nEngineer, Acme\nJan 2020 - Present\n- Built things");
    expect(p).toMatchObject({ source: "paste", fileName: null });
    expect((await reparseCv())!.id).toBe(p.id); // re-parse of pasted text uses the stored text
    await expect(pasteCv("too short")).rejects.toThrow(CvFileError);
  });

  it("rejects what it can't read, without storing anything", async () => {
    const before = stored().length;
    await expect(uploadCv(new Uint8Array(scannedPdf()), "scan.pdf")).rejects.toThrow(/little or no readable text/);
    await expect(uploadCv(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]), "evil.exe")).rejects.toThrow(/PDF, a Word document/);
    await expect(uploadCv(new Uint8Array(0), "empty.pdf")).rejects.toThrow(CvFileError);
    await expect(uploadCv(new Uint8Array(pdf(["secret text here for a CV document"], { encrypt: true })), "locked.pdf")).rejects.toThrow(/password-protected/);
    expect(stored().length).toBe(before);
  });

  it("the stored kind comes from the bytes: a PDF named .docx is stored as a PDF", async () => {
    const { cv } = await uploadCv(fx("cv-sample.pdf"), "pretend.docx");
    expect(cv.fileKind).toBe("pdf");
    expect(cv.fileName!.endsWith(".pdf")).toBe(true);
  });

  it("an upload feeds a plan: the comparison reads the uploaded CV and cites its words", async () => {
    await uploadCv(fx("cv-sample.docx"), "cv.docx");
    await confirm("sample-job-lumen", "pursue");
    const r = (await createPlan("sample-job-lumen"))!;
    const p = (await approvePlan(r.plan.id))!;
    expect(step(p, "s3").output).toMatchObject({ present: true, experience: 2 });
    const out = step(p, "s4").output as { results: RequirementResult[] };
    const cvText = (await getCv())!.text;
    expect(out.results[0].status).toBe("VERIFIED_MATCH"); // "3+ years ... React and TypeScript apps", backed by Jan 2021 - Present
    for (const x of out.results) for (const e of x.evidence) expect(cvText.slice(e.span.start, e.span.end)).toBe(e.quote);
  });

  it("removing the CV deletes every version and its files, and only then", async () => {
    expect(stored().length).toBeGreaterThan(0);
    const removed = await removeAllCvs();
    expect(removed).toBeGreaterThanOrEqual(3);
    expect(await getCv()).toBeNull();
    expect(await listCvDocuments()).toEqual([]);
    expect(stored().filter((f) => /\.(docx|pdf|txt)$/.test(f))).toEqual([]);
  });
});

describe("recipes: servings, normalisation and no silent substitutions", () => {
  let planId: string;
  const text = `Lemon garlic pasta (serves 4)\nIngredients: 200g spaghetti, 4 cloves garlic, 1 lemon, 2 tbsp butter, 1/2 cup parmesan\nMethod: Cook the pasta. Sizzle garlic in butter. Toss with parmesan.\n${randomUUID()}`;

  it("builds a shopping list with the recipe's own amounts, and instructions that quote the saved text", async () => {
    const { memory } = await captureMemory({ kind: "note", text });
    await confirm(memory.id, "try");
    const m = (await getMemory(memory.id))!;
    expect(m.extraction?.contentType).toBe("recipe");
    const r = (await createPlan(memory.id))!;
    planId = r.plan.id;
    const p = (await approvePlan(planId))!;
    const parsed = step(p, "s2").output as { servings: { value: number }; instructions: { text: string; span: { start: number; end: number } }[] };
    expect(parsed.servings.value).toBe(4);
    const source = (step(p, "s1").output as { readableText: string }).readableText;
    for (const s of parsed.instructions) expect(source.slice(s.span.start, s.span.end)).toBe(s.text);
    const list = step(p, "s3").output as { items: { name: string; quantity: number | null }[]; substitutions: { for: string; source: string }[] };
    expect(list.items.find((i) => i.name === "spaghetti")!.quantity).toBe(200);
    // Acorn's ideas exist, are labelled inferred, and never touch the list
    expect(list.substitutions.length).toBeGreaterThan(0);
    expect(list.substitutions.every((s) => s.source === "inferred")).toBe(true);
    expect(list.items.map((i) => i.name)).toContain("parmesan");
    expect(list.items.map((i) => i.name)).not.toContain("pecorino romano");
  });

  it("rescales from the extracted amounts, not from the last rescale, and never touches what you changed", async () => {
    let p = (await getPlan(planId))!;
    // change one amount yourself
    const items = (step(p, "s3").output as { items: { id: string; name: string; quantity: number | null; unit: string | null }[] }).items;
    p = (await editStep(planId, "s3", { items: items.map((i) => (i.name === "garlic" ? { id: i.id, name: i.name, quantity: 5, unit: i.unit } : { id: i.id })) as never }))!;
    p = (await editStep(planId, "s3", { servings: 8 }))!;
    const at8 = (step(p, "s3").output as { items: { name: string; quantity: number | null; source: string }[]; servings: { original: number; target: number } });
    expect(at8.servings).toEqual({ original: 4, target: 8 });
    expect(at8.items.find((i) => i.name === "spaghetti")!.quantity).toBe(400);
    expect(at8.items.find((i) => i.name === "garlic")).toMatchObject({ quantity: 5, source: "you" }); // your number stays
    p = (await editStep(planId, "s3", { servings: 2 }))!;
    const at2 = step(p, "s3").output as { items: { name: string; quantity: number | null }[] };
    expect(at2.items.find((i) => i.name === "spaghetti")!.quantity).toBe(100); // 200 * 2/4, not 400 * 2/8 compounded
    expect(at2.items.find((i) => i.name === "parmesan")!.quantity).toBe(0.25);
    expect(step(p, "s3").result!.passed).toBe(true);
  });

  it("refuses to scale a recipe that doesn't say how many it serves", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `Quick oats\nIngredients: 1 cup rolled oats, 1 onion, 1 tomato\nMethod: Cook it. ${randomUUID()}` });
    await confirm(memory.id, "try");
    const r = (await createPlan(memory.id))!;
    let p = (await approvePlan(r.plan.id))!;
    expect(step(p, "s3").state).toBe("awaiting_review");
    await expect(editStep(r.plan.id, "s3", { servings: 4 })).rejects.toThrow(/doesn't say how many it serves/);
    p = (await approveReview(r.plan.id, "s3"))!;
    p = (await skipStep(r.plan.id, "s4"))!;
    expect(p.status).toBe("completed");
  });

  it("an incomplete recipe says it is incomplete instead of filling gaps", async () => {
    const { memory } = await captureMemory({ kind: "note", text: `Mystery stew\nIngredients: 2 potatoes, 1 carrot\n${randomUUID()}` });
    await confirm(memory.id, "try");
    const r = (await createPlan(memory.id))!;
    const p = (await approvePlan(r.plan.id))!;
    const parsed = step(p, "s2").output as { warnings: string[]; instructions: unknown[] };
    expect(parsed.warnings.join(" ")).toMatch(/No method was found/);
    expect(parsed.instructions).toEqual([]);
  });
});

describe("follow-up intent", () => {
  const note = (t: string) => captureMemory({ kind: "note", text: `${t} ${randomUUID()}` });

  it("is suggested only from the user's own words, shows where it came from, and is not confirmed", async () => {
    const { memory } = await note("Need to follow up with the recruiter after the interview next Friday");
    const s = intentSuggestion(memory)!;
    expect(s).toMatchObject({ kind: "follow_up", status: "suggested", isSuggestion: true, basis: "stated", workflow: null });
    expect(s.evidence.some((e) => e.supports === "intent" && memory.source.text!.includes(e.quote))).toBe(true);
    await expect(createPlan(memory.id)).rejects.toThrow(/why you saved this/);
  });

  it("dismissing it leaves nothing to act on", async () => {
    const { memory } = await note("Revisit my application after a week");
    await updateMemory(memory.id, (m) => applyCorrection(m, { userIntent: { kind: "none" } }, new Date()));
    expect(intentSuggestion((await getMemory(memory.id))!)).toBeNull(); // a dismissed guess is gone, not hidden
    await expect(createPlan(memory.id)).rejects.toThrow(/why you saved this/);
  });

  it("a confirmed follow-up becomes a plan whose draft claims no past conversation, and whose reminder date you choose", async () => {
    const { memory } = await note("Need to follow up with Priya Nair about the intro she offered");
    await confirm(memory.id, "follow_up");
    const r = (await createPlan(memory.id))!;
    expect(r.plan.workflow).toBe("followup");
    let p = (await approvePlan(r.plan.id))!;
    const email = step(p, "s2").output as { subject: string; body: string; sent: boolean };
    expect(email.sent).toBe(false);
    expect(email.body).toContain("[what you are following up on]");
    expect(email.body).not.toMatch(/as we discussed|as promised|our (?:earlier|last|previous)/i);
    expect(step(p, "s2").result!.checks.every((c) => c.passed)).toBe(true);

    p = (await approveReview(r.plan.id, "s2"))!;
    p = (await approveReview(r.plan.id, "s3"))!;
    const reminder = p.steps.find((s) => s.tool === "create_reminder")!;
    expect(reminder.state).toBe("pending"); // no date was invented: it waits for you
    expect(await listReminders({ memoryId: memory.id })).toEqual([]);
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString(); // "in 1 week" preset
    p = (await setStepInput(r.plan.id, reminder.id, "dueAt", when))!;
    const [rem] = await listReminders({ memoryId: memory.id });
    expect(rem).toMatchObject({ memoryId: memory.id, actionId: p.actionId, status: "scheduled" });
    expect(rem.dueAt).toBe(when);
  });

  it("an email draft can't assert a promise even if the saved text mentions one", async () => {
    const { runTool } = await import("@/lib/agent/tools");
    const { makeIO } = await import("@/lib/agent/executor");
    const grant = { stepPermissions: ["compute" as const], approved: ["compute" as const] };
    const out = await runTool({ io: makeIO(new Date()), plan: { id: "p", memoryId: "m", actionId: "a", memoryIds: ["m"] }, stepId: "s" }, "draft_email", { purpose: "follow_up", name: null, context: "You promised to send the report" }, grant);
    expect((out.output as { body: string }).body).toContain("From my notes: You promised to send the report"); // quoted as the user's note, not asserted
    expect(out.result.checks.every((c) => c.passed)).toBe(true);
  });
});
