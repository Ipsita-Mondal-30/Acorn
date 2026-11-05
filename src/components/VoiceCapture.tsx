"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Artifact } from "@/lib/artifacts";
import { ASR_SAMPLE_RATE, encodeWav, MAX_AUDIO_SECONDS, resample } from "@/lib/audio/wav";
import { Aiko } from "./Aiko";
import { api, errorMessage } from "./api";
import { ModelNote } from "./ModelNote";
import { buttonClass, fieldClass } from "./ui";

// Voice capture: record → stop → preview (or discard) → transcribe → read and fix the transcript → save as a memory.
// The recording is encoded in the browser as the 16 kHz mono 16-bit WAV the transcription API accepts. Nothing becomes a
// memory until "Save as a memory" is pressed, and the intention Acorn suggests afterwards stays a suggestion.

type Phase = "idle" | "asking" | "recording" | "recorded" | "sending" | "transcript" | "saving" | "saved" | "failed";
type VoiceArtifact = Artifact & { output: { transcript?: string; note?: string } };

const noopSubscribe = () => () => {};
type AudioCtor = typeof AudioContext;
// Safari before 14.1 only has the prefixed constructor
const audioCtor = (): AudioCtor | undefined => (typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext));
const canRecord = () => !!navigator.mediaDevices?.getUserMedia && !!audioCtor();

export function VoiceCapture() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [wav, setWav] = useState<Uint8Array | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<VoiceArtifact | null>(null);
  const [text, setText] = useState("");
  const [memoryId, setMemoryId] = useState<string | null>(null);
  const rec = useRef<{ stop: () => Float32Array; cancel: () => void; rate: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // the server (and the first client render) assume yes; the browser then says for itself
  const supported = useSyncExternalStore(noopSubscribe, canRecord, () => true);

  useEffect(() => () => {
    rec.current?.cancel();
    if (timer.current) clearInterval(timer.current);
  }, []);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  const reset = () => {
    rec.current?.cancel();
    rec.current = null;
    if (timer.current) clearInterval(timer.current);
    setPhase("idle");
    setError(null);
    setSeconds(0);
    setWav(null);
    setPreviewUrl(null);
    setArtifact(null);
    setText("");
    setMemoryId(null);
  };

  async function start() {
    setError(null);
    setPhase("asking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const Ctx = audioCtor();
      if (!Ctx) throw new DOMException("no audio", "NotSupportedError");
      const ctx = new Ctx();
      // iOS Safari starts an AudioContext "suspended" until it is resumed from a tap; this is still inside that tap
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => void chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
      const release = () => {
        node.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      rec.current = {
        rate: ctx.sampleRate,
        cancel: release,
        stop: () => {
          release();
          const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.length;
          }
          return out;
        },
      };
      setSeconds(0);
      setPhase("recording");
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(denied ? "Microphone access was blocked. Allow it in your browser's site settings, then try again." : "Couldn't start the microphone on this device.");
      setPhase("failed");
    }
  }

  function stop() {
    if (!rec.current) return;
    if (timer.current) clearInterval(timer.current);
    const rate = rec.current.rate;
    const samples = rec.current.stop();
    rec.current = null;
    if (samples.length < rate * 0.4) {
      setError("That was too short to transcribe. Hold on a little longer.");
      setPhase("failed");
      return;
    }
    const bytes = encodeWav(resample(samples, rate, ASR_SAMPLE_RATE), ASR_SAMPLE_RATE);
    setWav(bytes);
    setPreviewUrl(URL.createObjectURL(new Blob([Buffer.from(bytes)], { type: "audio/wav" })));
    setPhase("recorded");
  }

  // stop by itself at the limit rather than lose what was said
  useEffect(() => {
    if (phase === "recording" && seconds >= MAX_AUDIO_SECONDS) stop();
  });

  async function transcribe() {
    if (!wav) return;
    setPhase("sending");
    setError(null);
    try {
      const form = new FormData();
      form.set("audio", new File([Buffer.from(wav)], "recording.wav", { type: "audio/wav" }));
      const { artifact: a } = await api<{ artifact: VoiceArtifact }>("/api/voice", { method: "POST", form, timeoutMs: 90_000 });
      setArtifact(a);
      setText(a.output.transcript ?? "");
      setPhase(a.status === "failed" ? "failed" : "transcript");
      if (a.status === "failed") setError(a.error?.message ?? "Transcription failed.");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("recorded"); // the recording is still here: try again
    }
  }

  async function retry() {
    if (!artifact) return;
    setPhase("sending");
    setError(null);
    try {
      const { artifact: a } = await api<{ artifact: VoiceArtifact }>(`/api/voice/${artifact.id}`, { method: "POST", body: { op: "retry" }, timeoutMs: 90_000 });
      setArtifact(a);
      setText(a.output.transcript ?? "");
      setPhase(a.status === "failed" ? "failed" : "transcript");
      if (a.status === "failed") setError(a.error?.message ?? "Transcription failed.");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("failed");
    }
  }

  async function save() {
    if (!artifact || !text.trim()) return;
    setPhase("saving");
    setError(null);
    try {
      const r = await api<{ memory: { id: string } }>(`/api/voice/${artifact.id}`, { method: "POST", body: { op: "save", text } });
      setMemoryId(r.memory.id);
      setPhase("saved");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("transcript");
    }
  }

  async function discard() {
    if (artifact) await api(`/api/voice/${artifact.id}`, { method: "DELETE" }).catch(() => {});
    reset();
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");

  return (
    <div className="space-y-4" data-testid="voice-capture">
      <div className="flex items-center gap-3">
        <Aiko mood={phase === "recording" ? "curious" : phase === "sending" || phase === "saving" ? "reading" : phase === "saved" ? "celebrating" : phase === "failed" ? "confused" : "happy"} size={72} />
        <p className="text-[15px] font-semibold text-ink-soft" role="status" aria-live="polite">
          {phase === "idle" && "Say it out loud and I'll write it down."}
          {phase === "asking" && "Waiting for your microphone…"}
          {phase === "recording" && "I'm listening…"}
          {phase === "recorded" && "Got it. Listen back, or send it to be written down."}
          {phase === "sending" && "Give me a second, I'm listening to this…"}
          {phase === "transcript" && "Here's what I heard. Fix anything, then save it."}
          {phase === "saving" && "Saving…"}
          {phase === "saved" && "Yay! I saved that for you."}
          {phase === "failed" && "Hmm, that didn't work."}
        </p>
      </div>

      {!supported && phase === "idle" && <p className="rounded-2xl bg-butter-soft px-3 py-2 text-sm text-butter-ink">This browser can&apos;t record audio. Try Chrome, Edge, Safari or Firefox over HTTPS or localhost.</p>}

      {(phase === "idle" || phase === "failed" || phase === "asking") && !artifact && (
        <button type="button" onClick={start} disabled={!supported || phase === "asking"} className={buttonClass.primary}>
          <MicIcon /> {phase === "failed" ? "Try again" : "Start recording"}
        </button>
      )}

      {phase === "recording" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-danger-soft px-3 py-1.5 text-sm font-bold text-danger tabular-nums">
            <span className="size-2.5 animate-pulse rounded-full bg-danger" aria-hidden="true" /> {mm}
          </span>
          <button type="button" onClick={stop} className={buttonClass.primary}>Stop</button>
          <button type="button" onClick={reset} className={buttonClass.quiet}>Cancel</button>
        </div>
      )}

      {(phase === "recorded" || phase === "sending") && previewUrl && (
        <div className="space-y-3">
          <audio controls src={previewUrl} className="w-full" aria-label="Preview your recording" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={transcribe} disabled={phase === "sending"} className={buttonClass.primary}>{phase === "sending" ? "Transcribing…" : "Transcribe"}</button>
            <button type="button" onClick={reset} disabled={phase === "sending"} className={buttonClass.secondary}>Discard</button>
          </div>
        </div>
      )}

      {artifact && (phase === "transcript" || phase === "saving" || phase === "saved" || phase === "failed") && (
        <div className="space-y-3">
          <ModelNote a={artifact} label={artifact.provider === "meta" ? "Transcription" : undefined} />
          {artifact.output.note && <p className="rounded-2xl bg-butter-soft px-3 py-2 text-sm text-butter-ink">{artifact.output.note}</p>}
          {phase !== "failed" && (
            <>
              <label htmlFor="voice-text" className="block text-sm font-bold">Transcript <span className="font-normal text-ink-faint">(yours to edit)</span></label>
              <textarea id="voice-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={20000} disabled={phase !== "transcript"} className={fieldClass} placeholder="Type what you said…" />
              {phase === "transcript" && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={save} disabled={!text.trim()} className={buttonClass.primary}>Save as a memory</button>
                  <button type="button" onClick={discard} className={buttonClass.secondary}>Discard</button>
                </div>
              )}
              <p className="text-xs text-ink-faint">Saving only stores your words. Acorn will suggest what you might want to do with it, but you decide.</p>
            </>
          )}
          {phase === "failed" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={retry} className={buttonClass.primary}>Try again</button>
              <button type="button" onClick={discard} className={buttonClass.secondary}>Discard</button>
            </div>
          )}
        </div>
      )}

      {phase === "saved" && memoryId && (
        <p>
          <Link href={`/memories/${memoryId}?saved=1`} className={buttonClass.primary}>See what I found</Link>
        </p>
      )}
      {error && <p role="alert" className="rounded-2xl bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  );
}
