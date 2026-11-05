import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { liveCheck, similarity } from "./evidence";

// CHECK 1: Muse Voice Transcribe, ONE paid request (about $0.001). A ~10 s WAV is made locally with the Mac's `say`
// (mono 16-bit PCM, 16 kHz) from a known sentence, so the transcript can be scored against what was actually said.
// Run: META_LIVE_CONFIRM=voice META_KEY_ROTATED=yes npm run meta:live:voice   (or META_LIVE_DRY_RUN=1 for the stubbed dry run)

const SENTENCE = "I want to learn Redis, build a project around it and finish it this week.";

it("check 1: Muse Voice Transcribe", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acorn-voice-"));
  try {
    const wavPath = path.join(dir, "sample.wav");
    execFileSync("say", ["-r", "105", "--file-format=WAVE", "--data-format=LEI16@16000", "-o", wavPath, SENTENCE]);
    const wav = new Uint8Array(readFileSync(wavPath));
    const { parseWav } = await import("../../src/lib/audio/wav");
    const info = parseWav(wav); // the same validation the app applies before sending
    await liveCheck({
      check: "voice",
      model: "muse-voice-transcribe-1.0",
      endpoint: "POST /v1/asr/transcribe",
      input: { generatedWith: "macOS say (local TTS)", expectedSentence: SENTENCE, wavBytes: wav.byteLength, sampleRate: info.sampleRate, durationMs: info.durationMs, mode: "PUSH_TO_TALK" },
      stubFetch: () => async () => Response.json({ sessionId: "dry-run-session", transcript: SENTENCE.replace(/,/g, ""), audioDurationMs: info.durationMs, turns: [] }),
      run: async () => {
        const { transcribeAudio } = await import("../../src/lib/ai/transcribe");
        const r = await transcribeAudio(wav, { languageBias: ["English"] });
        const score = similarity(SENTENCE, r.transcript);
        return {
          latencyMs: r.latencyMs,
          // ASR is billed by audio duration, not tokens: nothing to report as token usage, and none is invented
          usage: null,
          responseMeta: { sessionId: r.sessionId, audioDurationMsReturned: r.audioDurationMs, provider: r.provider, transcript: r.transcript },
          validation: {
            passed: r.provider === "meta" && score >= 0.8,
            details: { similarity: score, threshold: 0.8, transcriptWords: r.transcript.split(/\s+/).length, durationReturned: r.audioDurationMs !== null, sessionIdReturned: r.sessionId !== null },
          },
        };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
