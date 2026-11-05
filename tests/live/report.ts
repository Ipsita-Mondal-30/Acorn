import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExtractionOutput, type Fact, type Usage } from "../../src/lib/schema";

// Result reporting for the manual, paid live checks. Vitest's agent/CI reporters hide console output of PASSING tests,
// so a successful paid request could leave nothing behind. This writes the full outcome to a timestamped JSON file
// first, and makes no model call of its own: it only serialises what the one request already returned.

export const REPORT_DIR = path.resolve(import.meta.dirname, "../../artifacts/meta-live");

export type LiveRun = { data: ExtractionOutput; usage?: Usage; latencyMs?: number };
export type SchemaState = "passed" | "failed" | "not-reached";

export type LiveReport = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  input: Record<string, unknown>;
  schemaValidation: SchemaState;
  latencyMs: number | null;
  usage: Usage | null;
  /** the validated model output, every field (facts, evidence quotes, dates, next actions, job, uncertainties, …) */
  extraction: ExtractionOutput | null;
  /** facts after Acorn's own verification: with their quote, and whether a machine check could confirm it */
  verifiedFacts: Fact[] | null;
  /** the client's own "[meta] …" log lines for this run: model, status, attempts, latency, tokens. No secrets. */
  clientLog: string[];
  error: { name: string; kind: string | null; message: string } | null;
};

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|DATABASE_URL|DIRECT_URL)/i;

/** Remove anything that looks like a credential: the value of any secret-named env var, bearer tokens, sk-style keys. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name)) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

function describeError(e: unknown): { error: NonNullable<LiveReport["error"]>; schema: SchemaState } {
  const name = e instanceof Error ? e.name : "Error";
  const kind = typeof (e as { kind?: unknown } | null)?.kind === "string" ? (e as { kind: string }).kind : null;
  const message = e instanceof Error ? e.message : String(e);
  // "malformed" = the model answered but not in our shape (or not JSON). Anything else failed before there was output.
  return { error: { name, kind, message }, schema: kind === "malformed" ? "failed" : "not-reached" };
}

export async function runAndReport(opts: {
  provider: { name: string; model: string };
  input: Record<string, unknown>;
  run: () => Promise<LiveRun>;
  verify: (data: ExtractionOutput) => Fact[];
  dir?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<{ file: string; report: LiveReport }> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const clientLog: string[] = [];
  const realInfo = console.info;
  console.info = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[meta]")) clientLog.push(line);
    realInfo(...args);
  };

  // Written BEFORE the request, so a process that dies mid-request still leaves proof on disk that one was attempted.
  const dir = opts.dir ?? REPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, `${stamp(startedAt)}-started.json`);
  writeFileSync(
    marker,
    JSON.stringify({ startedAt: startedAt.toISOString(), provider: opts.provider.name, model: opts.provider.model, input: opts.input, note: "request about to be sent; if this file is still here, the run ended before a result was saved" }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );

  let outcome: Pick<LiveReport, "ok" | "schemaValidation" | "latencyMs" | "usage" | "extraction" | "verifiedFacts" | "error">;
  let failure: unknown;
  try {
    const r = await opts.run();
    outcome = {
      ok: true,
      schemaValidation: "passed",
      latencyMs: r.latencyMs ?? null,
      usage: r.usage ?? null,
      extraction: r.data,
      verifiedFacts: opts.verify(r.data),
      error: null,
    };
  } catch (e) {
    failure = e;
    const { error, schema } = describeError(e);
    outcome = { ok: false, schemaValidation: schema, latencyMs: null, usage: null, extraction: null, verifiedFacts: null, error };
  } finally {
    console.info = realInfo;
  }

  const report: LiveReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    provider: opts.provider.name,
    model: opts.provider.model,
    input: opts.input,
    clientLog,
    ...outcome,
  };
  const file = path.join(dir, `${stamp(startedAt)}-${report.ok ? "ok" : "failed"}.json`);
  writeFileSync(file, redact(JSON.stringify(report, null, 2), opts.env) + "\n", { flag: "wx", mode: 0o600 });
  unlinkSync(marker); // only once the result is safely on disk

  // the file is the record; this line is a pointer. A failure is rethrown so the test still fails, with the path in it.
  process.stderr.write(`[meta-live] result saved to ${path.relative(process.cwd(), file)}\n`);
  if (failure) {
    const msg = redact(outcome.error?.message ?? "request failed", opts.env);
    throw new Error(`${msg} (details saved to ${path.relative(process.cwd(), file)})`);
  }
  return { file, report };
}
