import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { evidenceDir, liveCheck, pngSize } from "./evidence";

// CHECK 2: Muse Image, ONE paid request ($0.01 at list price). The prompt is built by Acorn's own visual-aid code from the
// bullet points of a real Redis note, exactly as the app does. The image is saved as a separate review file (never inside the
// JSON) so a person can check it for invented labels. Run: META_LIVE_CONFIRM=image META_KEY_ROTATED=yes npm run meta:live:image

const NOTE = `Learn Redis caching
- allkeys-lru evicts the least recently used keys when memory is full
- volatile-ttl evicts the keys that will expire soonest
- maxmemory sets the memory limit for the dataset
- Cache-aside reads the cache first, then falls back to the database
I want to learn how these fit together.`;

// a 2x2 valid PNG, for the dry run only
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDEgAVgkAFgNA/9kTlG/AAAAAElFTkSuQmCC";

it("check 2: Muse Image", async () => {
  const { visualAidSource, visualAidPrompt } = await import("../../src/lib/visual-aid");
  const now = new Date().toISOString();
  const memory = { id: "live-check", createdAt: now, updatedAt: now, source: { kind: "note" as const, text: NOTE }, status: "ready" as const, contentHash: "live", extraction: null, overrides: {}, isSample: false };
  const src = visualAidSource(memory);
  if (!src) throw new Error("no statements to draw from");
  const prompt = visualAidPrompt(src);
  await liveCheck({
    check: "image",
    model: "muse-image-1.0",
    endpoint: "POST /v1/images/generations",
    input: { source: "bullet points of a Redis caching note", statements: src.statements, promptChars: prompt.length, size: "1792x1024", n: 1, output_format: "png", response_format: "b64_json" },
    stubFetch: () => async () => Response.json({ created: 1, data: [{ b64_json: TINY_PNG, revised_prompt: "dry run" }], usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 } }),
    run: async () => {
      const { generateImage } = await import("../../src/lib/ai/image");
      const r = await generateImage(prompt, () => "");
      const pngOk = r.ext === "png" && r.provider === "meta";
      const dims = pngOk ? pngSize(r.bytes) : null;
      // the picture itself goes to a separate review file, mode 0600, never into the JSON
      const dir = path.join(evidenceDir(), "review");
      mkdirSync(dir, { recursive: true });
      const reviewFile = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-visual-aid.png`);
      writeFileSync(reviewFile, r.bytes, { flag: "wx", mode: 0o600 });
      return {
        latencyMs: r.latencyMs,
        usage: r.usage,
        responseMeta: { provider: r.provider, format: r.ext, bytes: r.bytes.byteLength, dimensions: dims, revisedPrompt: r.revisedPrompt, reviewFile: path.relative(process.cwd(), reviewFile) },
        validation: {
          passed: pngOk && !!dims && dims.w > 1 && dims.h > 1,
          details: { validPng: pngOk, dimensions: dims, usageReturned: r.usage !== null, labelAccuracy: "NOT assessed automatically: a person must compare the picture's labels with the statements" },
        },
      };
    },
  });
});
