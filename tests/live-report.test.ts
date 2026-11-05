import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redact, runAndReport } from "./live/report";
import { AiError } from "../src/lib/ai/errors";
import { mockProvider } from "../src/lib/ai/mock";
import { extractValidated } from "../src/lib/ai/provider";
import { ExtractionOutput } from "../src/lib/schema";
import { verifyExtraction } from "../src/lib/verify";

// No network and no model: the provider is the built-in mock or a stub. These tests only check what gets written.

const KEY = "sk-test-0123456789abcdef";
const env = { META_API_KEY: KEY, PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "meta-live-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const provider = { name: "meta", model: "muse-spark-test" };
const verify = (d: ExtractionOutput) => verifyExtraction(d, { text: null, pixels: true, userText: null }).facts;
const input = { kind: "image", fictional: true };
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

async function mockRun() {
  return extractValidated(mockProvider, {
    kind: "note",
    text: "Senior Engineer at Acme, apply by 30 June 2030. Remote. Salary 90k.",
    now: new Date("2030-06-01T00:00:00Z"),
  });
}

describe("live-test result file", () => {
  it("writes a timestamped JSON file with every extraction field, usage, latency and verified facts", async () => {
    const { file } = await runAndReport({
      provider, input, dir, env, verify,
      run: async () => ({ ...(await mockRun()), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 }, latencyMs: 1234 }),
    });
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-ok\.json$/);
    const r = read(file);
    expect(r).toMatchObject({ ok: true, provider: "meta", model: "muse-spark-test", schemaValidation: "passed", latencyMs: 1234, error: null });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 });
    // nothing the schema allows is dropped
    for (const field of Object.keys(ExtractionOutput.shape)) expect(r.extraction).toHaveProperty(field);
    expect(r.extraction.title).toBeTruthy();
    expect(Array.isArray(r.verifiedFacts)).toBe(true);
    expect(r.verifiedFacts.length).toBe(r.extraction.facts.length);
    expect(r.input).toEqual(input);
  });

  it("keeps fact quotes and their machine-check flag", async () => {
    const run = async () => {
      const m = await mockRun();
      m.data.facts = [{ claim: "Apply by 30 June 2030", quote: "apply by 30 June 2030", kind: "stated" } as never];
      return m;
    };
    const { report } = await runAndReport({ provider, input, dir, env, verify, run });
    expect(report.verifiedFacts?.[0]).toMatchObject({ claim: "Apply by 30 June 2030", quote: "apply by 30 June 2030" });
    expect(report.verifiedFacts?.[0]).toHaveProperty("checked");
  });

  it("is mode 0600 and refuses to overwrite an earlier result", async () => {
    const t = () => new Date("2030-01-01T00:00:00.000Z");
    const { file } = await runAndReport({ provider, input, dir, env, verify, run: mockRun, now: t });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(runAndReport({ provider, input, dir, env, verify, run: mockRun, now: t })).rejects.toThrow();
    // the earlier result is intact; the refused second write leaves its started marker as evidence, not a second result
    expect(readdirSync(dir).filter((n) => n.endsWith("-ok.json"))).toHaveLength(1);
  });

  it("captures the client's [meta] log lines without hiding them", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { report } = await runAndReport({
      provider, input, dir, env, verify,
      run: async () => {
        console.info("[meta] purpose=extract model=m status=200 attempts=1 latencyMs=5");
        console.info("unrelated");
        return mockRun();
      },
    });
    expect(report.clientLog).toEqual(["[meta] purpose=extract model=m status=200 attempts=1 latencyMs=5"]);
    expect(info).toHaveBeenCalledTimes(2);
    expect(console.info).toBe(info); // patched console restored
  });

  it("leaves a started marker while the request is in flight and removes it once the result is saved", async () => {
    let during: string[] = [];
    const run = async () => {
      during = readdirSync(dir);
      return mockRun();
    };
    await runAndReport({ provider, input, dir, env, verify, run });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(/-started\.json$/);
    const after = readdirSync(dir);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/-ok\.json$/);
  });

  it("the result file is complete the moment the promise resolves (writing is synchronous and awaited)", async () => {
    const { file, report } = await runAndReport({ provider, input, dir, env, verify, run: mockRun });
    expect(read(file)).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it("prints the saved path on stderr", async () => {
    const err = vi.spyOn(process.stderr, "write");
    const { file } = await runAndReport({ provider, input, dir, env, verify, run: mockRun });
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain(path.basename(file));
  });

  it("calls the run function exactly once", async () => {
    const run = vi.fn(mockRun);
    await runAndReport({ provider, input, dir, env, verify, run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("failures", () => {
  it("saves a failed file with the error kind, rethrows, and marks the schema as not reached", async () => {
    const run = async () => {
      throw new AiError("Meta API rejected the key.", "auth");
    };
    await expect(runAndReport({ provider, input, dir, env, verify, run })).rejects.toThrow(/Meta API rejected the key\. \(details saved to .*-failed\.json\)/);
    const [name] = readdirSync(dir);
    expect(name).toMatch(/-failed\.json$/);
    const r = read(path.join(dir, name));
    expect(r).toMatchObject({ ok: false, schemaValidation: "not-reached", extraction: null, error: { name: "AiError", kind: "auth" } });
  });

  it("reports a schema failure when the model answered in the wrong shape", async () => {
    const run = () => extractValidated({ ...mockProvider, extractMemory: async () => ({ data: { nope: true } as never }) }, { kind: "note", text: "x", now: new Date() });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runAndReport({ provider, input, dir, env, verify, run })).rejects.toThrow();
    const r = read(path.join(dir, readdirSync(dir)[0]));
    expect(r).toMatchObject({ ok: false, schemaValidation: "failed", error: { kind: "malformed" } });
  });

  it("keeps the log lines of a failed request", async () => {
    const run = async () => {
      console.info("[meta] purpose=extract model=m status=429 attempts=1 latencyMs=9");
      throw new AiError("Meta is busy.", "rate_limit");
    };
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(runAndReport({ provider, input, dir, env, verify, run })).rejects.toThrow();
    expect(read(path.join(dir, readdirSync(dir)[0])).clientLog).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("redacts the key, bearer tokens and secret-named env values from messages and output", async () => {
    const run = async () => {
      throw new Error(`401 for Authorization: Bearer abc.def-123 using ${KEY}`);
    };
    await expect(runAndReport({ provider, input, dir, env, verify, run })).rejects.toThrow(/^(?![\s\S]*sk-test)(?![\s\S]*abc\.def)/);
    const text = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("abc.def-123");
    expect(text).toContain("[redacted]");
  });

  it("redacts a key the model echoes inside a successful result", async () => {
    const run = async () => {
      const m = await mockRun();
      m.data.summary = `leaked ${KEY}`;
      return m;
    };
    const { file } = await runAndReport({ provider, input, dir, env, verify, run });
    expect(readFileSync(file, "utf8")).not.toContain(KEY);
  });

  it("redact() leaves ordinary text and short or non-secret env values alone", () => {
    expect(redact("hello world", { PATH: "/usr/bin", API_KEY: "short" } as never)).toBe("hello world");
    expect(redact("a short b", { API_KEY: "short" } as never)).toBe("a short b");
  });

  it("never writes the image bytes: only the descriptor the caller gave", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const { file } = await runAndReport({ provider, input: { kind: "image", bytes: bytes.length }, dir, env, verify, run: mockRun });
    expect(read(file).input).toEqual({ kind: "image", bytes: 8 });
  });
});
