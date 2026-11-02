import { z } from "zod";

// Job helpers shared by matching and drafting: the job input, key-term extraction, CV line splitting and the checklist.

export const JobInput = z.object({
  company: z.string().nullable(),
  role: z.string().nullable(),
  location: z.string().nullable(),
  requirements: z.array(z.string()),
  deadline: z.string().nullable(),
  applyUrl: z.string().nullable(),
});
export type JobInput = z.infer<typeof JobInput>;

const STOP = new Set(
  `a an the and or of to in on for with from by at as is are be been this that these those you your our we will can may must should have has had
  experience experienced building production strong good great proven demonstrated ability able skills skill knowledge understanding familiarity familiar
  working work comfort comfortable background nice plus preferred required requirements role team teams using use used including such etc years year
  proficiency proficient expertise expert handson solid deep excellent fluency fluent exposure hands-on`.split(/\s+/),
);

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'");

/** Words worth looking for: tech-ish tokens (react, next.js, a/b, c++) and plain words, minus filler and bare numbers. */
export function keyTerms(requirement: string): string[] {
  const out: string[] = [];
  for (const raw of norm(requirement).split(/[^\p{L}\p{N}+#./-]+/u)) {
    const w = raw.replace(/^[./-]+|[./-]+$/g, "");
    if (w.length < 2 || STOP.has(w) || /^\d+\+?$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export function cvLines(cv: string): string[] {
  return cv
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•*·]\s*/, "").trim())
    .filter((l) => l.length >= 3);
}

// ───────────────────────── checklist ─────────────────────────

export const ChecklistItem = z.object({ id: z.string(), text: z.string().min(1).max(300), done: z.boolean(), by: z.enum(["acorn", "you"]) });
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export function jobChecklist(job: JobInput, results: { requirement: string; status: string; userDecision: string | null }[]): ChecklistItem[] {
  const items: string[] = [];
  if (job.applyUrl) items.push(`Open the official application page: ${job.applyUrl}`);
  if (job.deadline) items.push(`Submit before the deadline on ${job.deadline}`);
  items.push("Read the tailored resume draft and fix anything that is not accurate");
  items.push("Read the cover letter draft and replace every [TO COMPLETE] marker (or delete that part)");
  for (const r of results.filter((r) => (r.status === "POTENTIAL_MATCH" || r.status === "UNVERIFIED") && r.userDecision === null)) items.push(`Confirm yourself: ${r.requirement}`);
  const gaps = results.filter((r) => r.status === "MISSING" || r.userDecision === "rejected");
  if (gaps.length) items.push(`Decide how to address ${gaps.length} requirement${gaps.length === 1 ? "" : "s"} your CV does not show`);
  items.push("Apply yourself on the employer's site (Acorn never submits anything)");
  items.push("Save the confirmation (email, reference number or screenshot)");
  return items.map((text, i) => ({ id: `c${i + 1}`, text, done: false, by: "acorn" as const }));
}
