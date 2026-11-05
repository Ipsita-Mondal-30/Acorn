import "server-only";
import { z } from "zod";
import { getEnv } from "../env";
import type { Usage } from "../schema";
import { AiError } from "./errors";
import { metaRequest, requireMetaKey } from "./meta-client";

// Muse Image: POST /v1/images/generations (https://dev.meta.ai/docs/image-generation). JSON body: model, prompt, n,
// size (an aspect ratio, not pixels), response_format b64_json|url, output_format png|jpeg|webp. Billed per image
// ($0.01 at list price), so Acorn asks for exactly one image, and only when the user presses the button.

export const IMAGE_PRICE_USD = 0.01;
export type GeneratedImage = {
  bytes: Uint8Array;
  ext: "png" | "webp" | "jpg" | "svg";
  revisedPrompt: string | null;
  provider: "mock" | "meta";
  model: string;
  latencyMs: number;
  usage: Usage | null;
  note?: string;
};

const ImagesResponse = z.object({
  created: z.number().optional(),
  data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional(), revised_prompt: z.string().optional() })).min(1),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional(),
});

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b: Uint8Array) => PNG.every((x, i) => b[i] === x);

export async function generateImage(prompt: string, mockSvg: () => string): Promise<GeneratedImage> {
  const env = getEnv();
  if (env.ACORN_MODE !== "meta") {
    const started = Date.now();
    return {
      bytes: new TextEncoder().encode(mockSvg()),
      ext: "svg",
      revisedPrompt: null,
      provider: "mock",
      model: "mock-diagram",
      latencyMs: Date.now() - started,
      usage: null,
      note: "Demo diagram drawn by Acorn from the memory's statements. It is not a Muse Image result.",
    };
  }
  const key = requireMetaKey(env);
  const model = env.META_IMAGE_MODEL;
  const { res, latencyMs } = await metaRequest(env, key, {
    purpose: "image",
    model,
    path: "/images/generations",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    timeoutMs: Math.max(env.META_TIMEOUT_MS, 120_000),
    body: () => JSON.stringify({ model, prompt, n: 1, size: "1792x1024", response_format: "b64_json", output_format: "png" }),
  });
  const parsed = ImagesResponse.safeParse(await res.json().catch(() => null));
  const first = parsed.success ? parsed.data.data[0] : null;
  if (!parsed.success || !first?.b64_json) throw new AiError("Meta returned no image.", "malformed");
  const bytes = new Uint8Array(Buffer.from(first.b64_json, "base64"));
  // trust the bytes, not the response: only a real PNG is stored (it is what we asked for)
  if (!isPng(bytes)) throw new AiError("Meta returned an image Acorn could not recognise.", "malformed");
  const u = parsed.data.usage;
  const usage: Usage | null =
    u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
      ? { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: u.total_tokens ?? u.input_tokens + u.output_tokens, estimatedCostUsd: IMAGE_PRICE_USD }
      : null;
  return { bytes, ext: "png", revisedPrompt: first.revised_prompt ?? null, provider: "meta", model, latencyMs, usage };
}
