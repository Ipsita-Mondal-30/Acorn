import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { centreInside, iou, liveCheck } from "./evidence";

// CHECK 3: SAM 3.1, ONE paid request (about $0.0025). SAM only says WHERE; it does not read the date. The question this
// check answers is whether its boxes are useful for "the deadline" on Acorn's sample job screenshot.
// Run: META_LIVE_CONFIRM=sam META_KEY_ROTATED=yes npm run meta:live:sam

const IMAGE = path.resolve(import.meta.dirname, "../../public/samples/job-listing-screenshot.png");
// attempt 1 used "the deadline" (an idea, not an object) and returned HTTP 200 with no regions. The docs ask for one concrete noun phrase.
const TARGET = "the line of text that starts with Applications close";
// where "Applications close 15 January 2027." is in the 900x600 image (hand-measured; see src/lib/ai/sam-fixtures.ts)
const EXPECTED = { x1: 36, y1: 458, x2: 446, y2: 492 };

const record = `<0f>1<|box;x1=40;y1=462;x2=442;y2=490;w=900;h=600;c=0.93|>,~dryrun-mask-payload`;
const sse = () => new Response([`data: ${JSON.stringify({ type: "response.output_text.delta", delta: record })}`, "data: [DONE]", ""].join("\n\n"), { status: 200 });

it("check 3: SAM 3.1", async () => {
  const bytes = new Uint8Array(readFileSync(IMAGE));
  await liveCheck({
    check: "sam",
    model: "sam-3.1",
    endpoint: "POST /v1/responses (stream)",
    input: { image: "public/samples/job-listing-screenshot.png", imageBytes: bytes.byteLength, target: TARGET, expectedRegion: EXPECTED, expectedText: "Applications close 15 January 2027." },
    stubFetch: () => async () => sse(),
    run: async () => {
      const { segmentImage } = await import("../../src/lib/ai/sam");
      const r = await segmentImage(bytes, "image/png", TARGET);
      const ranked = r.regions.map((g) => ({ ...g, iou: iou(g.box, EXPECTED), centreOnDeadline: centreInside(g.box, { x1: EXPECTED.x1 - 30, y1: EXPECTED.y1 - 30, x2: EXPECTED.x2 + 30, y2: EXPECTED.y2 + 30 }), coverage: Math.round((((g.box.x2 - g.box.x1) * (g.box.y2 - g.box.y1)) / ((r.frame?.w ?? 1) * (r.frame?.h ?? 1))) * 1000) / 1000 })).sort((a, b) => b.iou - a.iou);
      const best = ranked[0];
      return {
        latencyMs: r.latencyMs,
        usage: null, // SAM is billed per image; the stream reports no token usage here and none is invented
        responseMeta: { provider: r.provider, frame: r.frame, regionCount: r.regions.length, regions: ranked, bestRegionId: best?.id ?? null, coordinateSystem: "xyxy source pixels (documented); frame from the w/h in the box token", masksStored: false, diagnostics: r.diagnostics ?? null },
        validation: {
          passed: r.provider === "meta" && r.regions.length > 0 && !!best && best.centreOnDeadline && best.coverage < 0.5,
          details: {
            regionCount: r.regions.length,
            frameMatchesImage: r.frame?.w === 900 && r.frame?.h === 600,
            bestIoUWithExpectedLine: best?.iou ?? null,
            bestCentreOnDeadlineLine: best?.centreOnDeadline ?? false,
            bestCoverageOfImage: best?.coverage ?? null,
            confidenceReturned: best ? best.confidence !== null : false,
            usefulness: best ? (best.centreOnDeadline ? "box lands on the deadline line" : "box found but NOT on the deadline line") : "no regions returned",
          },
        },
      };
    },
  });
});
