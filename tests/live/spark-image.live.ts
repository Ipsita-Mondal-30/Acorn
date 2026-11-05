import { readFileSync } from "node:fs";
import { it } from "vitest";
import { runAndReport } from "./report";

const SAMPLE = "public/samples/job-listing-screenshot.png";

// ONE real, paid Muse Spark IMAGE request, using Acorn's fictional sample job-listing screenshot (no personal data).
// Run with `npm run meta:check:image`. It refuses unless all four locks are open, and it makes exactly one request
// (the call budget is forced to 1 and retries can't exceed it). Saves everything that came back to artifacts/meta-live/ (never the key or the image).

it("one live Muse Spark image request", async () => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // no .env.local: the shell environment may carry the settings
  }
  process.env.ACORN_MAX_MODEL_CALLS = "1";
  const refuse = (why: string) => {
    throw new Error(`Refusing to call Meta: ${why}`);
  };
  if (process.env.AI_PROVIDER !== "meta") refuse("set AI_PROVIDER=meta in .env.local.");
  if (process.env.AI_ENABLE_REAL_CALLS !== "true") refuse("set AI_ENABLE_REAL_CALLS=true in .env.local (this request costs money).");
  if (!process.env.META_API_KEY) refuse("META_API_KEY is not set.");
  if (process.env.META_LIVE_IMAGE_CONFIRM !== "yes") refuse("run it as META_LIVE_IMAGE_CONFIRM=yes npm run meta:check:image to confirm you accept one paid request.");

  const bytes = new Uint8Array(readFileSync(SAMPLE));
  const { metaProvider } = await import("../../src/lib/ai/meta");
  const { extractValidated } = await import("../../src/lib/ai/provider");
  const { verifyExtraction } = await import("../../src/lib/verify");
  const provider = metaProvider();
  // the whole outcome, success or failure, goes to artifacts/meta-live/<timestamp>.json (vitest hides passing-test output)
  const { file, report } = await runAndReport({
    provider,
    // describes the input; the image bytes themselves are never written
    input: { kind: "image", file: SAMPLE, mimeType: "image/png", bytes: bytes.length, fictional: true },
    run: () =>
      extractValidated(provider, { kind: "image", image: { bytes, mimeType: "image/png" }, originalName: "job-listing-screenshot.png", now: new Date() }),
    // the same verification the app applies before anything is shown as a fact
    verify: (data) => verifyExtraction(data, { text: null, pixels: true, userText: null }).facts,
  });
  console.log(`result: ${file}`);
  console.log(JSON.stringify({ ok: report.ok, model: report.model, title: report.extraction?.title, facts: report.verifiedFacts?.length, latencyMs: report.latencyMs, usage: report.usage }, null, 2));
});
