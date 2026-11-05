import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../env";
import { AiError } from "./errors";
import type { AiProvider, ExtractInput, ProviderResult } from "./provider";
import { mockProvider } from "./mock";
import { sampleForBytes } from "./samples";

// DEMO ONLY, off by default (ACORN_DEMO_REPLAY=1, and only in demo mode). It replays the SAVED RESULT of the one real Muse
// Spark 1.3 image request that was verified live (artifacts/meta-live/<file>-ok.json) when, and only when, that exact
// built-in sample screenshot is uploaded. It makes no network call and needs no key. Every memory made this way carries
// the saved run's real model name, latency and token usage, and a note saying it is a replay of a saved result, so it can
// never be mistaken for a new Meta request. Every other input is read by the ordinary mock, labelled as the mock.

export const DEFAULT_REPLAY_FILE = "artifacts/meta-live/2026-11-03T17-55-24-748Z-ok.json";
const SAMPLE_ID = "job-listing";

export const replayEnabled = () => process.env.ACORN_DEMO_REPLAY === "1" && getEnv().ACORN_MODE !== "meta";

type Saved = { ok: boolean; provider: string; model: string; startedAt: string; latencyMs: number; usage?: unknown; extraction: unknown };

function loadSaved(): Saved {
  const file = path.resolve(process.cwd(), process.env.ACORN_DEMO_REPLAY_FILE ?? DEFAULT_REPLAY_FILE);
  let saved: Saved;
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
  } catch {
    throw new AiError(`ACORN_DEMO_REPLAY is on but the saved result ${path.relative(process.cwd(), file)} can't be read.`, "config");
  }
  if (saved.ok !== true || saved.provider !== "meta" || !saved.extraction) throw new AiError("The replay file is not a successful saved Meta result.", "config");
  return saved;
}

/** A fresh provider object per call: it relabels itself only while attributing the replayed result. */
export function replayProvider(): AiProvider {
  const p: AiProvider = {
    ...mockProvider,
    async extractMemory(this: AiProvider, input: ExtractInput): Promise<ProviderResult> {
      const sample = input.image ? sampleForBytes(input.image.bytes) : null;
      if (sample?.id !== SAMPLE_ID) {
        this.name = mockProvider.name;
        this.model = mockProvider.model;
        return mockProvider.extractMemory(input);
      }
      const saved = loadSaved();
      this.name = "meta";
      this.model = saved.model;
      return {
        data: saved.extraction,
        usage: saved.usage as ProviderResult["usage"],
        latencyMs: saved.latencyMs,
        note: `Replay of a saved real Meta ${saved.model} result (${saved.startedAt}). No new request was made.`,
      };
    },
  };
  return p;
}
