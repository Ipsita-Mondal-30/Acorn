import path from "node:path";
import { describe, expect, it } from "vitest";
import { demoEnv, REPLAY_FILE } from "../scripts/demo-env.mjs";

// `npm run demo` must be safe by construction: whatever .env.local holds, the child process cannot call a model, send an
// email or touch the person's own data.

describe("demo environment", () => {
  const base = demoEnv({ cwd: "/work/acorn", secret: "s".repeat(48), exists: () => true });

  it("switches every paid or outward path off and uses a separate local folder", () => {
    expect(base.env).toMatchObject({
      ACORN_STORAGE: "local",
      AI_PROVIDER: "mock",
      AI_ENABLE_REAL_CALLS: "false",
      ACORN_MAX_MODEL_CALLS: "0",
      META_API_KEY: "",
      EMBEDDING_PROVIDER: "none",
      EMAIL_PROVIDER: "none",
      NOTIFICATIONS_ENABLE_SENDING: "false",
    });
    expect(base.env.ACORN_DATA_DIR).toBe(path.resolve("/work/acorn", ".demo-data"));
    expect(base.env.ACORN_DATA_DIR).not.toBe(path.resolve("/work/acorn", ".data"));
  });
  it("turns on the labelled replay only when the saved real result file exists", () => {
    expect(base.replay).toBe(true);
    expect(base.env.ACORN_DEMO_REPLAY).toBe("1");
    const none = demoEnv({ cwd: "/work/acorn", exists: () => false });
    expect(none.replay).toBe(false);
    expect(none.env.ACORN_DEMO_REPLAY).toBeUndefined();
    expect(REPLAY_FILE).toBe("artifacts/meta-live/2026-11-03T17-55-24-748Z-ok.json");
  });
  it("gives the reminder check a long local secret only when asked for one", () => {
    expect(base.env.CRON_SECRET).toHaveLength(48);
    expect(demoEnv({ cwd: "/work/acorn", exists: () => false }).env.CRON_SECRET).toBeUndefined();
  });
});
