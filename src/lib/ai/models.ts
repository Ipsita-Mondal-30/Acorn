// Meta models relevant to Acorn, as documented at https://dev.meta.ai/docs (checked 2026-10-31).
// Nothing here is assumed: a field is only filled in when the documentation states it.

export type ModelInfo = {
  id: string;
  /** what the docs say it is for */
  role: string;
  input: readonly string[];
  output: readonly string[];
  endpoints: readonly string[];
  /** USD per 1M tokens (pay-as-you-go, Standard/Contributor as listed); null when the docs give no token price */
  price: { input: number; output: number; cachedInput: number } | null;
  /** how Acorn uses it */
  acorn: "in use" | "available, not used" | "planned" | "investigated, not integrated";
};

export const MODELS = {
  "muse-spark-1.3": {
    id: "muse-spark-1.3",
    role: "Agentic and coding model; recommended for new work. 1,048,576-token context.",
    input: ["text", "image", "pdf", "video", "audio (not fully supported)"],
    output: ["text"],
    endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
    price: { input: 1.25, output: 4.25, cachedInput: 0.15 },
    acorn: "in use",
  },
  "muse-spark-1.3-contributor": {
    id: "muse-spark-1.3-contributor",
    role: "Contributor-mode Muse Spark 1.3 (cheaper, lower rate limit; the docs do not explain Contributor mode).",
    input: ["text", "image", "pdf", "video", "audio (not fully supported)"],
    output: ["text"],
    endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
    price: { input: 0.1, output: 0.2, cachedInput: 0.002 },
    acorn: "available, not used",
  },
  "muse-spark-1.2": {
    id: "muse-spark-1.2",
    role: "Previous Muse Spark version.",
    input: ["text", "image", "pdf", "video", "audio"],
    output: ["text"],
    endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
    price: { input: 1.25, output: 4.25, cachedInput: 0.15 },
    acorn: "available, not used",
  },
  "muse-wonder-1.0": {
    id: "muse-wonder-1.0",
    role: "Most capable model, for complex software engineering and long-horizon agentic work (preview).",
    input: ["text", "image", "video", "audio", "pdf"],
    output: ["text"],
    endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
    price: { input: 4, output: 20, cachedInput: 0.2 },
    acorn: "available, not used", // usable for action plans via META_PLAN_MODEL; not the default
  },
  "sam-3.1": {
    id: "sam-3.1",
    role: "Image/video segmentation: boxes and masks for a text-prompted object. $2.50 per 1,000 images.",
    input: ["text prompt", "image", "video"],
    output: ["boxes and masks (as text)"],
    endpoints: ["/v1/responses"],
    price: null,
    acorn: "investigated, not integrated",
  },
  "muse-voice-transcribe-1.0": {
    id: "muse-voice-transcribe-1.0",
    role: "Speech to text only (no text-to-speech). File input: mono 16-bit PCM WAV, 16 or 24 kHz, up to 10 minutes. $0.18 per hour.",
    input: ["audio"],
    output: ["text"],
    endpoints: ["POST /v1/asr/transcribe", "wss /v1/asr/realtime"],
    price: null,
    acorn: "planned",
  },
  "muse-image-1.0": {
    id: "muse-image-1.0",
    role: "Image generation and editing. $0.01 per generated image.",
    input: ["text", "image"],
    output: ["image"],
    endpoints: ["/v1/responses", "/v1/images/generations", "/v1/images/edits"],
    price: null,
    acorn: "investigated, not integrated",
  },
} as const satisfies Record<string, ModelInfo>;

/** Open-weight models are downloaded and self-hosted. They are not served by the Meta Model API. */
export const OPEN_WEIGHT = [
  { name: "Muse Spark Open", detail: "816B-parameter mixture-of-experts (42B active); text, image, audio, video in. Self-hosted (SGLang, vLLM, TensorRT-LLM, llama.cpp) or a third-party provider." },
  { name: "Muse Glimmer", detail: "30B open-weight multimodal model distilled from Muse Spark; text and image in. Self-hosted (vLLM, SGLang, llama.cpp, ExecuTorch)." },
] as const;

// Kept for the "about models" panel on the capture page.
export const META_MODELS = {
  extraction: { model: "muse-spark-1.3", endpoint: "/v1/chat/completions", status: "in use" },
  agentReasoning: { model: "muse-wonder-1.0", endpoint: "/v1/chat/completions", status: "optional (META_PLAN_MODEL)" },
  transcription: { model: "muse-voice-transcribe-1.0", endpoint: "/v1/asr/transcribe", status: "planned" },
  segmentation: { model: "sam-3.1", endpoint: "/v1/responses", status: "not integrated" },
  imageGeneration: { model: "muse-image-1.0", endpoint: "/v1/images/generations", status: "not integrated" },
} as const;
export const OPEN_WEIGHT_ONLY = ["Muse Spark Open", "Muse Glimmer"] as const;

/** Estimated list-price cost in USD. Ignores prompt-cache discounts, so it can only overestimate. null = no documented price. */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | null {
  const info = (MODELS as Record<string, ModelInfo>)[model];
  if (!info?.price) return null;
  const usd = (promptTokens * info.price.input + completionTokens * info.price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
