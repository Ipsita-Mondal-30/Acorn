import "server-only";
import { z } from "zod";
import { WavError, parseWav } from "../audio/wav";
import { getEnv } from "../env";
import { AiError } from "./errors";
import { metaRequest, requireMetaKey } from "./meta-client";

// Muse Voice Transcribe: POST /v1/asr/transcribe, multipart/form-data with a JSON `request` part and the WAV `audio`
// part (https://dev.meta.ai/docs/speech-to-text). Mono 16-bit PCM WAV at 16 or 24 kHz, up to 10 min / 32 MB.
// languageBias is a hint, not a forced language, and the model code-switches by itself when it is omitted.

export type TranscribeResult = {
  transcript: string;
  audioDurationMs: number | null;
  sessionId: string | null;
  provider: "mock" | "meta";
  model: string;
  latencyMs: number;
  /** mock only */
  note?: string;
};

const TranscribeResponse = z.object({
  sessionId: z.string().optional(),
  transcript: z.string(),
  audioDurationMs: z.number().optional(),
});

export type TranscribeOptions = { languageBias?: string[]; keywords?: string[] };

export async function transcribeAudio(wav: Uint8Array, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  let info;
  try {
    info = parseWav(wav);
  } catch (e) {
    if (e instanceof WavError) throw new AiError(e.message, "invalid_input");
    throw e;
  }
  const env = getEnv();
  if (env.ACORN_MODE !== "meta") {
    // Demo mode has no speech recognition and does not pretend to: the transcript stays empty and the user types what they said.
    return {
      transcript: "",
      audioDurationMs: info.durationMs,
      sessionId: null,
      provider: "mock",
      model: "mock-no-transcription",
      latencyMs: 0,
      note: "Demo mode does not listen to audio. Type what you said, or switch to Meta mode for real transcription.",
    };
  }
  const key = requireMetaKey(env);
  const model = env.META_TRANSCRIPTION_MODEL;
  const settings = {
    model,
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
    ...(opts.languageBias?.length ? { languageBias: opts.languageBias.slice(0, 5) } : {}),
    ...(opts.keywords?.length ? { keywords: opts.keywords.slice(0, 50) } : {}),
  };
  const { res, latencyMs } = await metaRequest(env, key, {
    purpose: "transcribe",
    model,
    path: "/asr/transcribe",
    headers: { Accept: "application/json" },
    body: () => {
      const form = new FormData(); // rebuilt per attempt: a FormData body can be sent only once
      form.set("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
      form.set("audio", new Blob([Buffer.from(wav)], { type: "audio/wav" }), "recording.wav");
      return form;
    },
  });
  const parsed = TranscribeResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new AiError("Meta returned a transcription in an unexpected shape.", "malformed");
  return {
    transcript: parsed.data.transcript.trim(),
    audioDurationMs: parsed.data.audioDurationMs ?? info.durationMs,
    sessionId: parsed.data.sessionId ?? null,
    provider: "meta",
    model,
    latencyMs,
  };
}
