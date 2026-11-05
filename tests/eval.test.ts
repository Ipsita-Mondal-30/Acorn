import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sampleById } from "@/lib/ai/samples";
import { answerQuestion } from "@/lib/answer";
import { captureMemory } from "@/lib/process";
import { effective, type Memory } from "@/lib/schema";
import { searchMemories } from "@/lib/search";
import { listMemories } from "@/lib/store";

// Evaluation harness. Runs the labelled cases in evals/dataset.json through the real capture pipeline with the DEMO
// reader, then scores classification, entities, deadlines, intent, evidence, retrieval and answers. The scores measure the
// mock heuristics on this small set, not any model. The assertions are regression floors, not accuracy claims.

type Expect = { contentType: string; entities: string[]; deadline: string | null; intent: string | null; maxConfidence?: number; limitation?: string };
type Case = { id: string; sample?: string; note?: string; url?: string; imageBase64?: string; fileName?: string; expect: Expect };
const data = JSON.parse(readFileSync("evals/dataset.json", "utf8")) as {
  today: string;
  cases: Case[];
  retrieval: { query: string; top1?: string | null; top2?: string[] }[];
  answers: { question: string; citesOnly?: string; mustMention?: string[]; noReliableMatch?: boolean }[];
};

let dir: string;
const saved = { ...process.env };
const mem: Record<string, Memory> = {};
const idOf = (m: Memory) => Object.entries(mem).find(([, v]) => v.id === m.id)?.[0];
const latencies: number[] = [];
const [yy, mm, dd] = data.today.split("-").map(Number);
const now = new Date(yy, mm - 1, dd, 12);

async function run(c: Case): Promise<Memory> {
  if (c.sample) {
    const s = sampleById(c.sample)!;
    if (s.kind === "note") return (await captureMemory({ kind: "note", text: s.text! })).memory;
    if (s.kind === "url") return (await captureMemory({ kind: "url", url: s.url!, text: s.text })).memory;
    const bytes = new Uint8Array(readFileSync(path.join("public/samples", s.fileName!)));
    return (await captureMemory({ kind: s.kind, bytes, originalName: s.fileName!, text: s.caption })).memory;
  }
  if (c.note) return (await captureMemory({ kind: "note", text: c.note })).memory;
  if (c.url) return (await captureMemory({ kind: "url", url: c.url })).memory;
  return (await captureMemory({ kind: "image", bytes: new Uint8Array(Buffer.from(c.imageBase64!, "base64")), originalName: c.fileName! })).memory;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acorn-eval-"));
  process.env.ACORN_DATA_DIR = dir;
  process.env.ACORN_MODE = "demo";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.ACORN_STORAGE;
  vi.useFakeTimers({ toFake: ["Date"] }); // relative dates ("Friday") resolve against the dataset's fixed "today"
  vi.setSystemTime(now);
  for (const c of data.cases) {
    const t0 = performance.now();
    mem[c.id] = await run(c);
    latencies.push(performance.now() - t0);
  }
  vi.useRealTimers();
}, 60_000);
afterAll(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${n}/${d} (${Math.round((100 * n) / d)}%)`);
const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

describe("evaluation (demo reader, labelled cases)", () => {
  const score = { type: 0, entHit: 0, entTotal: 0, dlOk: 0, intentOk: 0, intentTotal: 0, evOk: 0, evTotal: 0, ready: 0 };
  const misses: string[] = [];

  it("scores extraction", () => {
    for (const c of data.cases) {
      const m = mem[c.id];
      const x = m.extraction!;
      const v = effective(m);
      expect(m.status, c.id).toBe("ready");
      score.ready++;
      if (v.contentType === c.expect.contentType) score.type++;
      else misses.push(`${c.id}: type ${v.contentType} (expected ${c.expect.contentType})`);

      for (const e of c.expect.entities) {
        score.entTotal++;
        if (x.entities.some((y) => y.name.toLowerCase() === e.toLowerCase())) score.entHit++;
        else misses.push(`${c.id}: entity "${e}" not found`);
      }
      if (v.deadline === c.expect.deadline) score.dlOk++;
      else misses.push(`${c.id}: deadline ${v.deadline} (expected ${c.expect.deadline})`);

      score.intentTotal++;
      if ((x.intentGuess?.kind ?? null) === c.expect.intent) score.intentOk++;
      else misses.push(`${c.id}: intent ${x.intentGuess?.kind ?? null} (expected ${c.expect.intent})`);

      // evidence preservation: every fact quote must be words that really are in what was saved
      const source = c.sample && sampleById(c.sample)?.pages ? sampleById(c.sample)!.pages!.join("\n") : [m.source.text, m.source.url, m.source.originalName].filter(Boolean).join("\n");
      for (const f of x.facts) {
        score.evTotal++;
        if (source.includes(f.quote)) score.evOk++;
        else misses.push(`${c.id}: fact quote not in source: ${f.quote}`);
      }
      if (c.expect.maxConfidence !== undefined) expect(x.confidence, c.id).toBeLessThanOrEqual(c.expect.maxConfidence);
      if (c.expect.limitation) expect(x.uncertainties.join(" "), c.id).toContain(c.expect.limitation);
      // candidate intents are never confirmed
      expect(effective(m).intentKind, c.id).toBeNull();
    }
    // regression floors for the mock on this set (not accuracy claims)
    expect(ratio(score.type, data.cases.length)).toBeGreaterThanOrEqual(0.9);
    expect(ratio(score.entHit, score.entTotal)).toBeGreaterThanOrEqual(0.9);
    expect(ratio(score.dlOk, data.cases.length)).toBeGreaterThanOrEqual(0.9);
    expect(ratio(score.intentOk, score.intentTotal)).toBeGreaterThanOrEqual(0.85);
    expect(score.evOk).toBe(score.evTotal); // quotes are never invented, by construction
  });

  const ret = { top1Ok: 0, top1Total: 0, noOk: 0, noTotal: 0 };
  it("scores retrieval", async () => {
    const all = (await listMemories()).filter((m) => !m.isSample);
    for (const q of data.retrieval) {
      const hits = searchMemories(all, q.query, now);
      const got = hits[0] ? idOf(hits[0].memory) : null;
      if (q.top2) {
        ret.top1Total++;
        const two = hits.slice(0, 2).map((h) => idOf(h.memory));
        if (q.top2.every((id) => two.includes(id))) ret.top1Ok++;
        else misses.push(`search "${q.query}": top 2 were ${two.join(", ")}`);
      } else if (q.top1 === null) {
        ret.noTotal++;
        // for a question with no answer, nothing may be presented as reliable (the answer step decides; see below)
        const answer = await answerQuestion(q.query, all, { now });
        if (answer.noReliableMatch) ret.noOk++;
        else misses.push(`"${q.query}": expected no reliable match, got ${answer.matches[0]?.title}`);
      } else {
        ret.top1Total++;
        if (got === q.top1) ret.top1Ok++;
        else misses.push(`search "${q.query}": top was ${got} (expected ${q.top1})`);
      }
    }
    expect(ratio(ret.top1Ok, ret.top1Total)).toBeGreaterThanOrEqual(0.9);
    expect(ret.noOk).toBe(ret.noTotal);
  });

  const ans = { ok: 0, total: 0 };
  it("scores answers (grounding and honesty)", async () => {
    const all = (await listMemories()).filter((m) => !m.isSample);
    for (const a of data.answers) {
      ans.total++;
      const r = await answerQuestion(a.question, all, { now });
      let ok = true;
      if (a.noReliableMatch) ok = r.noReliableMatch && r.citations.length === 0;
      else {
        ok = !r.noReliableMatch && r.citations.length > 0 && r.citations.every((c) => idOf({ id: c.memoryId } as Memory) === a.citesOnly);
        for (const w of a.mustMention ?? []) ok = ok && r.answer.toLowerCase().includes(w.toLowerCase());
      }
      if (ok) ans.ok++;
      else misses.push(`answer "${a.question}": ${r.answer}`);
    }
    expect(ans.ok).toBe(ans.total);
  });

  it("reports the results", () => {
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const report = [
      `Evaluation of the DEMO reader (mock heuristics) on ${data.cases.length} labelled cases. Not a measure of any Meta model.`,
      `  content type     ${pct(score.type, data.cases.length)}`,
      `  entities         ${pct(score.entHit, score.entTotal)}`,
      `  deadlines        ${pct(score.dlOk, data.cases.length)}`,
      `  intent (top-1)   ${pct(score.intentOk, score.intentTotal)}`,
      `  quotes in source ${pct(score.evOk, score.evTotal)}`,
      `  search top-1     ${pct(ret.top1Ok, ret.top1Total)}`,
      `  no-match honesty ${pct(ret.noOk, ret.noTotal)}`,
      `  answers          ${pct(ans.ok, ans.total)}`,
      `  capture latency  mean ${mean.toFixed(0)} ms (local store + mock; no network, no cost)`,
      misses.length ? `  misses:\n${misses.map((m) => `    - ${m}`).join("\n")}` : "  misses: none",
    ].join("\n");
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, report + "\n");
    console.info(report);
    expect(report).toContain("content type");
  });
});
