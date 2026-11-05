import "server-only";
import type { Box, Region } from "../artifacts";
import { getEnv } from "../env";
import { AiError } from "./errors";
import { metaRequest, requireMetaKey } from "./meta-client";
import { sampleForBytes } from "./samples";
import { SAM_FIXTURES } from "./sam-fixtures";

// SAM 3.1: POST /v1/responses with model sam-3.1 (https://dev.meta.ai/docs/media-segmentation, /docs/sam/segmenting).
// The text prompt and the image are two parts of one user message. One short noun phrase per request: SAM finds every
// instance of that concept and says WHERE (a box and a mask per match). It returns no meaning, no text and no labels,
// and Acorn claims nothing beyond that. Acorn draws the boxes; it does not decode the masks (see docs/meta-multimodal.md).

export type SegmentResult = {
  frame: { w: number; h: number } | null;
  regions: Region[];
  provider: "mock" | "meta";
  model: string;
  latencyMs: number;
  note?: string;
  /** what the stream actually contained, so an empty result can be told apart from an unreadable one (no content, no masks) */
  diagnostics?: { eventTypes: string[]; textChars: number; boxTokens: number };
};

/**
 * Reads segmentation text such as `<0f>3<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200;c=0.91|><mask…>`.
 * Boxes are xyxy corners in source pixels; w and h are the source frame size. Fields are read by key, not position, and
 * the base85 mask payload (which may contain any character) is never interpreted.
 */
export function parseBoxes(text: string): { frame: { w: number; h: number } | null; regions: Region[] } {
  const regions: Region[] = [];
  let frame: { w: number; h: number } | null = null;
  const re = /(\d+)<\|box;([^|]*)\|>/g;
  for (const m of text.matchAll(re)) {
    const kv = Object.fromEntries(m[2].split(";").map((p) => p.split("=") as [string, string]));
    const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((k) => Number(kv[k]));
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite) || x2 <= x1 || y2 <= y1 || w <= 0 || h <= 0) continue;
    frame ??= { w, h };
    const c = kv.c === undefined ? null : Number(kv.c);
    regions.push({ id: Number(m[1]), box: { x1, y1, x2, y2 }, confidence: c !== null && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null });
  }
  return { frame, regions };
}

/** Text carried by `response.output_text.delta` events of a Server-Sent Events body. */
export function sseEventTypes(body: string): string[] {
  const seen = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const t = (JSON.parse(line.slice(5).trim()) as { type?: unknown }).type;
      if (typeof t === "string") seen.add(t);
    } catch {
      // not JSON: not an event
    }
  }
  return [...seen];
}

export function sseText(body: string): string {
  let deltas = "";
  let done = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const e = JSON.parse(payload) as { type?: string; delta?: unknown; text?: unknown };
      if (e.type === "response.output_text.delta" && typeof e.delta === "string") deltas += e.delta;
      // the closing event repeats the whole text: used only if no deltas were streamed, so nothing is counted twice
      else if (e.type === "response.output_text.done" && typeof e.text === "string") done += e.text;
    } catch {
      // a partial or non-JSON line is not an event
    }
  }
  return deltas || done;
}

export async function segmentImage(bytes: Uint8Array, mimeType: string, target: string): Promise<SegmentResult> {
  const env = getEnv();
  const phrase = target.trim();
  if (!phrase) throw new AiError("Say what to look for, for example “the deadline”.", "invalid_input");
  if (env.ACORN_MODE !== "meta") return fixtureSegmentation(bytes, phrase);

  const key = requireMetaKey(env);
  const model = env.META_SEGMENTATION_MODEL;
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  const { res, latencyMs } = await metaRequest(env, key, {
    purpose: "segment",
    model,
    path: "/responses",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: () =>
      JSON.stringify({
        model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: phrase }, { type: "input_image", image_url: dataUrl }] }],
        stream: true,
        store: false,
        metadata: { include_confidence: "true" },
      }),
  });
  const raw = await res.text();
  const text = sseText(raw);
  // zero matches is a valid answer: the stream completes with no text
  const { frame, regions } = parseBoxes(text);
  return { frame, regions, provider: "meta", model, latencyMs, diagnostics: { eventTypes: sseEventTypes(raw), textChars: text.length, boxTokens: (text.match(/<\|box;/g) ?? []).length } };
}

function fixtureSegmentation(bytes: Uint8Array, phrase: string): SegmentResult {
  const started = Date.now();
  const sample = sampleForBytes(bytes);
  const fx = sample ? SAM_FIXTURES[sample.id] : undefined;
  const base = { provider: "mock" as const, model: "mock-fixture", latencyMs: Date.now() - started };
  if (!fx) {
    return { ...base, frame: null, regions: [], note: "Demo mode does not run SAM 3.1, so it can only show regions for Acorn's built-in sample screenshots. Switch to Meta mode to segment your own images." };
  }
  const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["the", "and", "for"].includes(w));
  const hits = fx.regions.filter((r) => r.keywords.some((k) => words.includes(k)));
  return {
    ...base,
    frame: fx.frame,
    regions: hits.map((r, i) => ({ id: i + 1, box: r.box as Box, confidence: null })),
    note: "Fixture boxes for a built-in sample screenshot: demo mode does not run SAM 3.1.",
  };
}
