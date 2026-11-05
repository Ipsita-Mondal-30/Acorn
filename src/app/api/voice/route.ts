import { z } from "zod";
import { WavError, MAX_AUDIO_BYTES } from "@/lib/audio/wav";
import { createVoiceDraft } from "@/lib/meta-services";
import { checkSize, errorResponse, HttpError, json } from "../_http";

const Langs = z.array(z.string().trim().min(2).max(30)).max(5);

/**
 * Upload a recorded voice note (multipart/form-data: `audio` = mono 16-bit PCM WAV at 16 or 24 kHz, up to 5 minutes;
 * optional `languages` = JSON list such as ["English","Hindi"]). The original audio is kept privately and transcribed
 * with Muse Voice Transcribe (or the clearly-labelled demo stand-in). The reply is the voice artifact: its transcript,
 * provenance and status. Nothing is saved as a memory until the user confirms (POST /api/voice/:id).
 */
export async function POST(req: Request) {
  try {
    if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) throw new HttpError(415, "Send the recording as multipart/form-data");
    checkSize(req, MAX_AUDIO_BYTES + 64 * 1024);
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) throw new HttpError(400, "audio: a recording is required");
    if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, "The recording is too large");
    let languages: string[] = [];
    const raw = form.get("languages");
    if (typeof raw === "string" && raw) {
      try {
        languages = Langs.parse(JSON.parse(raw));
      } catch {
        throw new HttpError(400, "languages: send a JSON list of language names");
      }
    }
    const artifact = await createVoiceDraft(new Uint8Array(await audio.arrayBuffer()), { languageBias: languages });
    return json({ artifact }, 201);
  } catch (e) {
    if (e instanceof WavError) return json({ error: e.message }, 400);
    return errorResponse(e);
  }
}
