import "server-only";
import { readRegion } from "./ai/region";
import { AiError } from "./ai/errors";
import { generateImage } from "./ai/image";
import { segmentImage } from "./ai/sam";
import { transcribeAudio } from "./ai/transcribe";
import {
  type Artifact,
  type ArtifactKind,
  RegionReadingOutput,
  SegmentationOutput,
  VisualAidOutput,
  VoiceOutput,
} from "./artifacts";
import { parseWav } from "./audio/wav";
import { effective, type Memory } from "./schema";
import { saveCapture } from "./process";
import { StudyPack } from "./agent/study";
import { deleteArtifact, getArtifact, getMemory, listArtifacts, listPlans, mutateArtifact, newId, upsertArtifact } from "./store";
import { deleteUpload, readUpload, saveGenerated } from "./uploads";
import { mockDiagramSvg, visualAidPrompt, visualAidSource } from "./visual-aid";

// One place that turns Meta model calls into persisted, linked artifacts. Every path follows the same shape:
//   1. a row is written first (status "processing"), so a crash or a timeout leaves a visible, retryable record
//   2. the model is called (real in Meta mode, the labelled demo stand-in otherwise)
//   3. the row becomes "ready" with its output, usage and timings, or "failed" with a short safe message and the attempt count
// Nothing here confirms an intention or takes an outside action: a voice note becomes a memory only when the user saves it.

export class ArtifactNotFound extends Error {
  name = "ArtifactNotFound";
}

const now = () => new Date().toISOString();
const fail = (e: unknown) => ({
  kind: e instanceof AiError ? e.kind : "error",
  message: (e instanceof AiError ? e.message : "Something went wrong. Please try again.").slice(0, 300),
  at: now(),
});

function fresh(kind: ArtifactKind, init: Partial<Artifact>): Artifact {
  const t = now();
  return {
    id: newId(), memoryId: null, parentId: null, kind, status: "processing", provider: "mock", model: "pending", fileName: null, mimeType: null,
    input: {}, output: {}, attempts: 0, error: null, latencyMs: null, usage: null, confirmedMemoryId: null, createdAt: t, updatedAt: t, ...init,
  };
}

const mustHave = async (id: string) => {
  const a = await getArtifact(id);
  if (!a) throw new ArtifactNotFound("That item wasn't found.");
  return a;
};

// ───────────────────────── voice ─────────────────────────

async function runTranscription(id: string): Promise<Artifact> {
  const a = await mustHave(id);
  if (!a.fileName) throw new AiError("The recording is missing. Please record it again.", "invalid_input");
  await mutateArtifact(id, (x) => ({ ...x, status: "processing", attempts: x.attempts + 1, error: null }));
  try {
    const file = await readUpload(a.fileName);
    if (!file) throw new AiError("The recording is missing. Please record it again.", "invalid_input");
    const languageBias = Array.isArray(a.input.languageBias) ? (a.input.languageBias as string[]) : [];
    const r = await transcribeAudio(file.bytes, { languageBias });
    const out: VoiceOutput = VoiceOutput.parse({ transcript: r.transcript, audioDurationMs: r.audioDurationMs, sessionId: r.sessionId, languageBias, confirmedText: null, note: r.note });
    return (await mutateArtifact(id, (x) => ({ ...x, status: "ready", provider: r.provider, model: r.model, output: out, latencyMs: r.latencyMs, error: null })))!;
  } catch (e) {
    return (await mutateArtifact(id, (x) => ({ ...x, status: "failed", error: fail(e) })))!;
  }
}

/** Keep the recording privately, then transcribe it. The artifact is returned either way (ready, or failed with a Retry). */
export async function createVoiceDraft(wav: Uint8Array, opts: { languageBias?: string[] } = {}): Promise<Artifact> {
  const info = parseWav(wav); // WavError → 400 by the route; nothing is stored for a file the API would reject
  const { fileName, mimeType } = await saveGenerated(wav, "wav");
  const a = await upsertArtifact(
    fresh("voice", { fileName, mimeType, input: { audioDurationMs: info.durationMs, sampleRate: info.sampleRate, bytes: wav.byteLength, languageBias: opts.languageBias ?? [] } }),
  );
  return runTranscription(a.id);
}

export const retryVoice = (id: string) => runTranscription(id);

/**
 * The user confirmed (and maybe corrected) the transcript. It becomes an ordinary note memory, understood by the normal
 * pipeline; the intention Acorn suggests for it stays a suggestion. Saving twice returns the same memory.
 */
export async function saveVoiceAsMemory(id: string, text: string): Promise<{ memory: Memory; artifact: Artifact; created: boolean }> {
  const a = await mustHave(id);
  if (a.kind !== "voice") throw new ArtifactNotFound("That item wasn't found.");
  if (a.memoryId) {
    const memory = await getMemory(a.memoryId);
    if (memory) return { memory, artifact: a, created: false };
  }
  const { memory, created } = await saveCapture({ kind: "note", text });
  const artifact = (await mutateArtifact(id, (x) => ({ ...x, memoryId: memory.id, output: { ...x.output, confirmedText: text.trim().slice(0, 20_000) } })))!;
  return { memory, artifact, created };
}

/** Throw away a recording that was never saved as a memory (the audio file goes too). */
export async function discardVoice(id: string): Promise<boolean> {
  const a = await getArtifact(id);
  if (!a || a.kind !== "voice") return false;
  if (a.memoryId) throw new AiError("This voice note is already saved as a memory. Delete the memory instead.", "invalid_input");
  const removed = await deleteArtifact(id);
  if (removed?.fileName) await deleteUpload(removed.fileName);
  return !!removed;
}

// ───────────────────────── visual aid ─────────────────────────

async function runVisualAid(id: string): Promise<Artifact> {
  const a = await mustHave(id);
  const memory = a.memoryId ? await getMemory(a.memoryId) : null;
  if (!memory) throw new ArtifactNotFound("That memory wasn't found.");
  await mutateArtifact(id, (x) => ({ ...x, status: "processing", attempts: x.attempts + 1, error: null }));
  try {
    // a study pack built from this memory adds its notes (which are the memory's own facts, not new material)
    const pack = (await listPlans(memory.id).catch(() => [])).flatMap((p) => p.steps).find((st) => st.tool === "build_study_pack" && st.output);
    const parsed = pack ? StudyPack.safeParse(pack.output) : null;
    const src = visualAidSource(memory, parsed?.success ? parsed.data.notes.map((n) => n.text) : []);
    if (!src) throw new AiError("There isn't enough in this memory yet to draw from. Let Acorn finish reading it first.", "invalid_input");
    const prompt = visualAidPrompt(src);
    const img = await generateImage(prompt, () => mockDiagramSvg(src));
    const stored = await saveGenerated(img.bytes, img.ext);
    if (a.fileName) await deleteUpload(a.fileName); // a retry replaces the previous attempt's file
    const out: VisualAidOutput = VisualAidOutput.parse({ title: src.title, basedOn: src.statements, prompt, revisedPrompt: img.revisedPrompt, aiGenerated: true, note: img.note });
    return (await mutateArtifact(id, (x) => ({ ...x, status: "ready", provider: img.provider, model: img.model, fileName: stored.fileName, mimeType: stored.mimeType, output: out, latencyMs: img.latencyMs, usage: img.usage, error: null })))!;
  } catch (e) {
    return (await mutateArtifact(id, (x) => ({ ...x, status: "failed", error: fail(e) })))!;
  }
}

/** User-triggered only. Regenerating makes a NEW visual aid and keeps the earlier ones. */
export async function createVisualAid(memoryId: string): Promise<Artifact> {
  const memory = await getMemory(memoryId);
  if (!memory) throw new ArtifactNotFound("That memory wasn't found.");
  const a = await upsertArtifact(fresh("visual_aid", { memoryId, input: { memoryTitle: effective(memory).title } }));
  return runVisualAid(a.id);
}
export const retryVisualAid = (id: string) => runVisualAid(id);

// ───────────────────────── explore an image (SAM 3.1 → Muse Spark) ─────────────────────────

export async function startSegmentation(memoryId: string, target: string): Promise<Artifact> {
  const memory = await getMemory(memoryId);
  if (!memory) throw new ArtifactNotFound("That memory wasn't found.");
  if (memory.source.kind !== "image" || !memory.source.fileName) throw new AiError("Explore image works on saved screenshots and images.", "invalid_input");
  const phrase = target.trim().slice(0, 120);
  if (!phrase) throw new AiError("Say what to look for, for example “the deadline”.", "invalid_input");
  const a = await upsertArtifact(fresh("segmentation", { memoryId, input: { target: phrase, sourceFile: memory.source.fileName } }));
  return runSegmentation(a.id);
}

async function runSegmentation(id: string): Promise<Artifact> {
  const a = await mustHave(id);
  await mutateArtifact(id, (x) => ({ ...x, status: "processing", attempts: x.attempts + 1, error: null }));
  try {
    const file = typeof a.input.sourceFile === "string" ? await readUpload(a.input.sourceFile) : null; // the ORIGINAL, never an annotated copy
    if (!file) throw new AiError("The saved image is missing.", "invalid_input");
    const target = String(a.input.target ?? "");
    const r = await segmentImage(file.bytes, file.mimeType, target);
    const frame = r.frame ?? { w: 0, h: 0 };
    const out: SegmentationOutput = SegmentationOutput.parse({ target, frame, regions: r.regions, note: r.note });
    return (await mutateArtifact(id, (x) => ({ ...x, status: "ready", provider: r.provider, model: r.model, output: out, latencyMs: r.latencyMs, error: null })))!;
  } catch (e) {
    return (await mutateArtifact(id, (x) => ({ ...x, status: "failed", error: fail(e) })))!;
  }
}
export const retrySegmentation = (id: string) => runSegmentation(id);

/** Muse Spark reads the region the user picked. It is a proposal until confirmRegionReading. */
export async function interpretRegion(segmentationId: string, regionId: number): Promise<Artifact> {
  const seg = await mustHave(segmentationId);
  if (seg.kind !== "segmentation" || seg.status !== "ready" || !seg.memoryId) throw new ArtifactNotFound("That item wasn't found.");
  const out = SegmentationOutput.parse(seg.output);
  const region = out.regions.find((r) => r.id === regionId);
  if (!region) throw new AiError("That region isn't part of these results.", "invalid_input");
  const a = await upsertArtifact(fresh("region_reading", { memoryId: seg.memoryId, parentId: seg.id, input: { regionId, box: region.box, target: out.target } }));
  await mutateArtifact(a.id, (x) => ({ ...x, attempts: 1 }));
  try {
    const file = typeof seg.input.sourceFile === "string" ? await readUpload(seg.input.sourceFile) : null;
    if (!file) throw new AiError("The saved image is missing.", "invalid_input");
    const r = await readRegion(file.bytes, file.mimeType, { box: region.box, frame: out.frame, target: out.target });
    const reading: RegionReadingOutput = RegionReadingOutput.parse({ regionId, box: region.box, target: out.target, reading: r.reading, quote: r.quote, note: r.note });
    return (await mutateArtifact(a.id, (x) => ({ ...x, status: "ready", provider: r.provider, model: r.model, output: reading, latencyMs: r.latencyMs, usage: r.usage })))!;
  } catch (e) {
    return (await mutateArtifact(a.id, (x) => ({ ...x, status: "failed", error: fail(e) })))!;
  }
}

/** The user confirmed this reading: it is saved as a linked note memory (so it is searchable and connected to its image). */
export async function confirmRegionReading(readingId: string): Promise<{ memory: Memory; artifact: Artifact; created: boolean }> {
  const a = await mustHave(readingId);
  if (a.kind !== "region_reading" || a.status !== "ready" || !a.memoryId) throw new ArtifactNotFound("That item wasn't found.");
  if (a.confirmedMemoryId) {
    const memory = await getMemory(a.confirmedMemoryId);
    if (memory) return { memory, artifact: a, created: false };
  }
  const out = RegionReadingOutput.parse(a.output);
  const source = await getMemory(a.memoryId);
  const title = source ? effective(source).title : "a saved image";
  const text = [
    `From the image in “${title}”, region for “${out.target}” (read by ${a.provider === "meta" ? a.model : "a demo stand-in"}, confirmed by me):`,
    out.reading,
    out.quote ? `Text in the region: “${out.quote}”` : "",
  ].filter(Boolean).join("\n\n");
  const { memory, created } = await saveCapture({ kind: "note", text });
  const artifact = (await mutateArtifact(readingId, (x) => ({ ...x, confirmedMemoryId: memory.id })))!;
  return { memory, artifact, created };
}

export async function deleteMyArtifact(id: string): Promise<boolean> {
  const a = await getArtifact(id);
  if (!a) return false;
  const kids = await listArtifacts({ parentId: id }).catch(() => []);
  const removed = await deleteArtifact(id);
  for (const f of [removed?.fileName, ...kids.map((k) => k.fileName)]) if (f) await deleteUpload(f);
  return !!removed;
}
