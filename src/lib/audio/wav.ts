// WAV helpers shared by the browser (to encode a recording) and the server (to validate before anything is sent).
// Muse Voice Transcribe accepts RIFF/WAVE, mono, 16-bit integer PCM at 16 kHz or 24 kHz, up to 10 minutes and 32 MB
// (https://dev.meta.ai/docs/speech-to-text). Acorn is stricter on size and length (see limits below).

export const ASR_SAMPLE_RATE = 16_000;
export const ALLOWED_SAMPLE_RATES = [16_000, 24_000] as const;
/** The API allows 10 minutes; Acorn records and accepts up to 5 so a request stays small and quick. */
export const MAX_AUDIO_SECONDS = 300;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export type WavInfo = { sampleRate: number; durationMs: number; dataBytes: number };

export class WavError extends Error {
  name = "WavError";
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Throws WavError (message safe to show) unless the bytes are a WAV the transcription API accepts. */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength === 0) throw new WavError("The recording is empty.");
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new WavError("The recording is too large (10 MB limit).");
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") throw new WavError("That is not a WAV recording.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let dataBytes = -1;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.byteLength) {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataBytes < 0) throw new WavError("That WAV file is damaged.");
  if (fmt.format !== 1) throw new WavError("The recording must be uncompressed PCM audio.");
  if (fmt.channels !== 1) throw new WavError("The recording must be mono.");
  if (fmt.bits !== 16) throw new WavError("The recording must be 16-bit audio.");
  if (!(ALLOWED_SAMPLE_RATES as readonly number[]).includes(fmt.rate)) throw new WavError("The recording must be 16 kHz or 24 kHz.");
  const durationMs = Math.round((dataBytes / 2 / fmt.rate) * 1000);
  if (durationMs < 300) throw new WavError("The recording is too short to transcribe.");
  if (durationMs > MAX_AUDIO_SECONDS * 1000) throw new WavError(`Recordings can be up to ${MAX_AUDIO_SECONDS / 60} minutes.`);
  return { sampleRate: fmt.rate, durationMs, dataBytes };
}

/** Float samples in [-1, 1] (mono) → 16-bit PCM WAV bytes. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const w = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Linear-interpolation resample (speech is band-limited well below 8 kHz, so this is enough for 16 kHz). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.max(1, Math.floor((input.length * to) / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}
