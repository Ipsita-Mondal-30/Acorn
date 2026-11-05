import { z } from "zod";
import { Usage } from "./schema";

// Things the Meta models make FROM a memory, kept apart from the memory's own source and facts so a generated picture or
// a transcript can never be mistaken for evidence. Each row records which model made it, how it went, and what it is linked to.

export const ArtifactKind = z.enum([
  "voice", // a spoken note: original audio + Muse Voice Transcribe's transcript (before and after it becomes a memory)
  "visual_aid", // an AI-created learning illustration made by Muse Image from a memory's own content
  "segmentation", // SAM 3.1 regions found in a saved image for a text target
  "region_reading", // Muse Spark's reading of one chosen region (a proposal until the user confirms it)
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ArtifactStatus = z.enum(["processing", "ready", "failed"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const ArtifactError = z.object({ kind: z.string().max(40), message: z.string().max(300), at: z.string() });

export const Artifact = z.object({
  id: z.string(),
  /** the memory this belongs to; null only for a voice note that has not been saved as a memory yet */
  memoryId: z.string().nullable(),
  /** region_reading → the segmentation it came from */
  parentId: z.string().nullable().default(null),
  kind: ArtifactKind,
  status: ArtifactStatus,
  provider: z.enum(["mock", "meta"]),
  model: z.string().max(80),
  /** private stored file (audio, generated image), as a `<uuid>.<ext>` name */
  fileName: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  /** what was asked (sizes, target, prompt text): metadata only, never keys or raw payloads */
  input: z.record(z.string(), z.unknown()).default({}),
  /** what came back, validated per kind by the code that wrote it */
  output: z.record(z.string(), z.unknown()).default({}),
  attempts: z.number().int().min(0).default(0),
  error: ArtifactError.nullable().default(null),
  latencyMs: z.number().nullable().default(null),
  usage: Usage.nullable().default(null),
  /** a region reading the user confirmed became this memory */
  confirmedMemoryId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

// ── per-kind outputs ──
export const VoiceOutput = z.object({
  transcript: z.string().max(40_000),
  audioDurationMs: z.number().nullable(),
  sessionId: z.string().nullable().default(null),
  languageBias: z.array(z.string()).default([]),
  /** the transcript the user saved (they may fix mistakes); the model's own text stays in `transcript` */
  confirmedText: z.string().max(20_000).nullable().default(null),
  /** mock only: what the demo did instead of listening */
  note: z.string().max(300).optional(),
});
export type VoiceOutput = z.infer<typeof VoiceOutput>;

export const VisualAidOutput = z.object({
  title: z.string().max(200),
  /** the evidence-backed statements it was drawn from, verbatim from the memory */
  basedOn: z.array(z.string().max(500)).max(20),
  prompt: z.string().max(4000),
  revisedPrompt: z.string().max(4000).nullable().default(null),
  /** always true: generated pictures are never source evidence */
  aiGenerated: z.literal(true).default(true),
  note: z.string().max(300).optional(),
});
export type VisualAidOutput = z.infer<typeof VisualAidOutput>;

export const Box = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() });
export type Box = z.infer<typeof Box>;
export const Region = z.object({ id: z.number().int(), box: Box, confidence: z.number().min(0).max(1).nullable() });
export type Region = z.infer<typeof Region>;
export const SegmentationOutput = z.object({
  target: z.string().max(120),
  frame: z.object({ w: z.number(), h: z.number() }),
  regions: z.array(Region).max(50),
  note: z.string().max(300).optional(),
});
export type SegmentationOutput = z.infer<typeof SegmentationOutput>;

export const RegionReadingOutput = z.object({
  regionId: z.number().int(),
  box: Box,
  target: z.string().max(120),
  /** Muse Spark's reading of what is in that region of the image */
  reading: z.string().max(1500),
  /** text it says it can read inside the region, verbatim */
  quote: z.string().max(500).nullable(),
  note: z.string().max(300).optional(),
});
export type RegionReadingOutput = z.infer<typeof RegionReadingOutput>;

/** What each model made, in words a user can read. */
export const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  voice: "Voice note",
  visual_aid: "Visual aid",
  segmentation: "Image regions",
  region_reading: "Region reading",
};
