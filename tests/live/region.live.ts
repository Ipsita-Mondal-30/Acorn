import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { latestVerified, liveCheck } from "./evidence";

// CHECK 4: Muse Spark reads the region check 3 found, ONE paid request (a few thousand tokens). It uses the newest VERIFIED
// SAM evidence file; if there is none it refuses, because a region is never made up.
// Run: META_LIVE_CONFIRM=region META_KEY_ROTATED=yes npm run meta:live:region

const IMAGE = path.resolve(import.meta.dirname, "../../public/samples/job-listing-screenshot.png");
const completion = () => Response.json({ choices: [{ message: { content: JSON.stringify({ reading: "A line saying when applications close: 15 January 2027.", quote: "Applications close 15 January 2027." }) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } });

it("check 4: Muse Spark region reading", async () => {
  const sam = latestVerified("sam");
  const best = (sam?.evidence.responseMeta as { regions?: { id: number; box: { x1: number; y1: number; x2: number; y2: number } }[]; bestRegionId?: number; frame?: { w: number; h: number } } | undefined);
  const region = best?.regions?.find((r) => r.id === best.bestRegionId);
  if (!sam || !region || !best?.frame) throw new Error("Refusing to run: check 3 (SAM) has no verified region, and a region is never made up. Run check 3 first.");
  const bytes = new Uint8Array(readFileSync(IMAGE));
  await liveCheck({
    check: "region",
    model: "muse-spark-1.3 (META_EXTRACTION_MODEL)",
    endpoint: "POST /v1/chat/completions",
    input: { image: "public/samples/job-listing-screenshot.png", regionFromSamEvidence: path.basename(sam.file), box: region.box, frame: best.frame, target: "the deadline" },
    stubFetch: () => async () => completion(),
    run: async () => {
      const { readRegion } = await import("../../src/lib/ai/region");
      const { getEnv } = await import("../../src/lib/env");
      const r = await readRegion(bytes, "image/png", { box: region.box, frame: best.frame!, target: "the deadline" });
      const text = `${r.reading} ${r.quote ?? ""}`.toLowerCase();
      const dateOk = /15 january 2027|january 15, 2027|2027-01-15|15 jan 2027/.test(text);
      const quoteOk = /applications close/i.test(r.quote ?? "");
      return {
        latencyMs: r.latencyMs,
        usage: r.usage,
        responseMeta: { provider: r.provider, model: r.model, reading: r.reading, quote: r.quote },
        validation: {
          passed: r.provider === "meta" && r.model === getEnv().META_EXTRACTION_MODEL && dateOk && quoteOk,
          details: { correctClosingDate: dateOk, quoteSupportsDate: quoteOk, attributedModel: r.model, attributionMatchesConfiguredModel: r.model === getEnv().META_EXTRACTION_MODEL, usageReturned: r.usage !== null },
        },
      };
    },
  });
});
