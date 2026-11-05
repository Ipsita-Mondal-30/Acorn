import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./report";

// Shared harness for the four manual, paid Meta checks (voice, image, SAM, region reading). It makes NO model call of its own.
//
// Safety, in the order it is enforced:
//   1. A check refuses unless META_LIVE_CONFIRM=<its name> AND META_KEY_ROTATED=yes are set on the command line.
//   2. It reads .env.local into THIS PROCESS ONLY and overrides the switches in memory (AI_PROVIDER=meta,
//      AI_ENABLE_REAL_CALLS=true, ACORN_MAX_MODEL_CALLS=1). .env.local itself is never written or copied.
//   3. ACORN_MAX_MODEL_CALLS=1 means a second attempt (a retry) is refused by the client before it is sent.
//   4. A `finally` puts process.env back exactly as it was, and drops the confirmation variables.
//   5. A started marker is written before the request, and the sanitised result after it. Keys, raw audio and raw
//      image bytes are never written; secrets are redacted from everything.
// META_LIVE_DRY_RUN=1 runs the same code against a stubbed fetch shaped like the documented API, with a fake key and no
// network. Dry-run results go to artifacts/meta-live/dry-run/ so they can never be mistaken for live evidence.

export const LIVE_DIR = path.resolve(import.meta.dirname, "../../artifacts/meta-live");
export const dryRun = () => process.env.META_LIVE_DRY_RUN === "1";
export const evidenceDir = () => (dryRun() ? path.join(LIVE_DIR, "dry-run") : LIVE_DIR);

export type Verdict = "verified" | "failed";
export type Evidence = {
  check: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  model: string;
  endpoint: string;
  httpStatus: number | null;
  attempts: number | null;
  latencyMs: number | null;
  /** exactly what the API returned that we can show without bytes: ids, durations, sizes, formats */
  responseMeta: Record<string, unknown>;
  usage: unknown;
  input: Record<string, unknown>;
  validation: { passed: boolean; details: Record<string, unknown> };
  verdict: Verdict;
  /** the client's own "[meta] ..." lines for this run: model, status, attempts, latency */
  clientLog: string[];
  error: { name: string; kind: string | null; message: string } | null;
};

export type CheckResult = {
  httpStatus?: number;
  latencyMs: number | null;
  responseMeta: Record<string, unknown>;
  usage?: unknown;
  validation: { passed: boolean; details: Record<string, unknown> };
};

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

/** Run one check under every guard. Throws (so the test fails and the chain stops) unless the check is verified. */
export async function liveCheck(opts: {
  check: "voice" | "image" | "sam" | "region";
  model: string;
  endpoint: string;
  input: Record<string, unknown>;
  /** Performs exactly one request via the app's own code. Runs with the guarded environment already in place. */
  run: () => Promise<CheckResult>;
  /** dry run only: the stubbed fetch that stands in for Meta */
  stubFetch: () => typeof fetch;
}): Promise<{ file: string; evidence: Evidence }> {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const clientLog: string[] = [];
  const realInfo = console.info;
  const startedAt = new Date();
  const dry = dryRun();
  let marker: string | null = null;
  try {
    // ── 1. explicit confirmation, before anything else is read
    if (!dry) {
      if (process.env.META_LIVE_CONFIRM !== opts.check) throw new Error(`Refusing to call Meta: run it as META_LIVE_CONFIRM=${opts.check} (one paid request).`);
      if (process.env.META_KEY_ROTATED !== "yes") throw new Error("Refusing to call Meta: confirm the API key was rotated by setting META_KEY_ROTATED=yes.");
      try {
        process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env.local")); // into this process only
      } catch {
        // the shell may carry the key instead
      }
      if (!process.env.META_API_KEY) throw new Error("Refusing to call Meta: META_API_KEY is not set.");
    } else {
      process.env.META_API_KEY = "DRY_RUN_FAKE_KEY_NOT_A_SECRET";
      globalThis.fetch = opts.stubFetch();
    }
    // ── 2/3. in-memory overrides: the one request this check is allowed to make
    Object.assign(process.env, {
      AI_PROVIDER: "meta",
      AI_ENABLE_REAL_CALLS: "true",
      ACORN_MAX_MODEL_CALLS: "1",
      ACORN_RETRY_BASE_MS: "0",
      META_API_BASE_URL: dry ? "https://api.meta.invalid/v1" : (saved.META_API_BASE_URL ?? "https://api.meta.ai/v1"),
      META_TIMEOUT_MS: "90000",
    });
    delete process.env.ACORN_STORAGE;

    console.info = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[meta]")) clientLog.push(line);
      realInfo(...args);
    };

    // ── 5. started marker (so a process that dies mid-request still leaves proof one was attempted)
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });
    marker = path.join(dir, `${stamp(startedAt)}-${opts.check}-started.json`);
    writeFileSync(marker, JSON.stringify({ check: opts.check, startedAt: startedAt.toISOString(), dryRun: dry, model: opts.model, endpoint: opts.endpoint, note: "request about to be sent; if this file is still here the run ended before a result was saved" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });

    let outcome: Pick<Evidence, "httpStatus" | "latencyMs" | "responseMeta" | "usage" | "validation" | "error">;
    let failure: unknown = null;
    try {
      const r = await opts.run();
      outcome = { httpStatus: r.httpStatus ?? null, latencyMs: r.latencyMs, responseMeta: r.responseMeta, usage: r.usage ?? null, validation: r.validation, error: null };
    } catch (e) {
      failure = e;
      outcome = {
        httpStatus: null, latencyMs: null, responseMeta: {}, usage: null, validation: { passed: false, details: {} },
        error: { name: e instanceof Error ? e.name : "Error", kind: typeof (e as { kind?: unknown })?.kind === "string" ? (e as { kind: string }).kind : null, message: e instanceof Error ? e.message : String(e) },
      };
    }
    const logged = clientLog.map((l) => /status=(\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
    const attempts = clientLog.map((l) => /attempts=(\d+)/.exec(l)?.[1]).filter(Boolean).map(Number).at(-1) ?? null;
    const evidence: Evidence = {
      check: opts.check, dryRun: dry, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), model: opts.model, endpoint: opts.endpoint,
      ...outcome, httpStatus: outcome.httpStatus ?? logged.at(-1) ?? null, attempts, input: opts.input,
      verdict: !failure && outcome.validation.passed ? "verified" : "failed", clientLog,
    };
    const file = path.join(dir, `${stamp(startedAt)}-${opts.check}-${evidence.verdict === "verified" ? "ok" : "failed"}.json`);
    writeFileSync(file, redact(JSON.stringify(evidence, null, 2), process.env) + "\n", { flag: "wx", mode: 0o600 });
    unlinkSync(marker);
    marker = null;
    process.stderr.write(`[meta-live] ${dry ? "DRY RUN " : ""}${opts.check}: ${evidence.verdict}, saved to ${path.relative(process.cwd(), file)}\n`);
    if (failure || !outcome.validation.passed) {
      const why = failure ? redact(String((failure as Error).message), process.env) : `validation failed: ${JSON.stringify(outcome.validation.details)}`;
      throw new Error(`${opts.check} check did not pass: ${why} (details saved to ${path.relative(process.cwd(), file)})`);
    }
    return { file, evidence };
  } finally {
    // ── 4. restore, whatever happened
    console.info = realInfo;
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete process.env.META_LIVE_CONFIRM;
    delete process.env.META_KEY_ROTATED;
  }
}

/** The newest evidence file for a check that passed (live, or dry-run when dry-running). */
export function latestVerified(check: string): { file: string; evidence: Evidence } | null {
  const dir = evidenceDir();
  try {
    const f = readdirSync(dir).filter((n) => n.endsWith(`-${check}-ok.json`)).sort().at(-1);
    return f ? { file: path.join(dir, f), evidence: JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Evidence } : null;
  } catch {
    return null;
  }
}

// ── small pure helpers the checks share ──
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
/** Word-level similarity in [0, 1]: 1 - editDistance / longer length. Order matters, case and punctuation do not. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return Math.round((1 - d[x.length][y.length] / Math.max(x.length, y.length)) * 1000) / 1000;
}
export type XYXY = { x1: number; y1: number; x2: number; y2: number };
export function iou(a: XYXY, b: XYXY): number {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = w * h;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? Math.round((inter / union) * 1000) / 1000 : 0;
}
export const centreInside = (box: XYXY, outer: XYXY) => {
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  return cx >= outer.x1 && cx <= outer.x2 && cy >= outer.y1 && cy <= outer.y2;
};
/** width and height from a PNG's IHDR chunk */
export const pngSize = (b: Uint8Array) => ({ w: new DataView(b.buffer, b.byteOffset).getUint32(16), h: new DataView(b.buffer, b.byteOffset).getUint32(20) });
