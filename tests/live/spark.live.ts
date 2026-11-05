import { it } from "vitest";

// ONE real, paid Muse Spark request. Run with `npm run meta:check`. It refuses to run unless real calls are enabled.
// Prints the model, latency, token counts and estimated cost. Never prints the key or the saved text.

it("one live Muse Spark request", async () => {
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

  const { metaProvider } = await import("../../src/lib/ai/meta");
  const { extractValidated } = await import("../../src/lib/ai/provider");
  const r = await extractValidated(metaProvider(), {
    kind: "note",
    text: "Reminder: renew passport before the March trip. Form is on the council website, takes about 3 weeks.",
    now: new Date(),
  });
  console.log(
    JSON.stringify(
      { ok: true, title: r.data.title, contentType: r.data.contentType, latencyMs: r.latencyMs, usage: r.usage },
      null,
      2,
    ),
  );
});
