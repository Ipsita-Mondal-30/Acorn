// The environment for the demo run (npm run demo). Pure, so it can be tested. Everything that could spend money or reach a real
// account is forced off here, whatever .env.local says: process environment beats .env files in Next.js.
import { existsSync } from "node:fs";
import path from "node:path";

export const REPLAY_FILE = "artifacts/meta-live/2026-11-03T17-55-24-748Z-ok.json";

/** @param {{ cwd?: string, dataDir?: string, secret?: string, exists?: (p: string) => boolean }} [opts] */
export function demoEnv({ cwd = process.cwd(), dataDir = ".demo-data", secret, exists = existsSync } = {}) {
  const replay = exists(path.resolve(cwd, REPLAY_FILE));
  return {
    replay,
    env: {
      ACORN_STORAGE: "local", // no accounts, no Supabase: a private folder on this machine
      ACORN_DATA_DIR: path.resolve(cwd, dataDir), // not .data: your own saved items are never touched
      AI_PROVIDER: "mock",
      AI_ENABLE_REAL_CALLS: "false",
      ACORN_MAX_MODEL_CALLS: "0",
      META_API_KEY: "", // empty counts as unset: no key can be used even by mistake
      EMBEDDING_PROVIDER: "none",
      EMAIL_PROVIDER: "none",
      NOTIFICATIONS_ENABLE_SENDING: "false",
      ...(replay ? { ACORN_DEMO_REPLAY: "1" } : {}),
      ...(secret ? { CRON_SECRET: secret } : {}),
    },
  };
}
