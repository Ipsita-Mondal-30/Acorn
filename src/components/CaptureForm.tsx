"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Memory } from "@/lib/schema";
import { Aiko } from "./Aiko";
import { readClipboard, splitClipboard } from "./clipboard";
import { convertHeicToJpeg, HEIC_HELP, HeicError, isHeicFile } from "./heic";
import { VoiceCapture } from "./VoiceCapture";
import { api, errorMessage } from "./api";
import { buttonClass, fieldClass } from "./ui";

type Phase = "idle" | "saving" | "saved" | "failed";
type Captured = { memory: Memory; created: boolean };

/**
 * Capture only SAVES: the server replies as soon as the original is stored and understands it afterwards. So there is
 * one short "saving" phase, then a confirmation; progress (queued → understanding → understood | couldn't understand)
 * is shown by the memory itself, which the pages keep fresh while it is working.
 */
function useCapture() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<{ id: string; created: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function run(save: () => Promise<Captured>): Promise<Captured | null> {
    if (inFlight.current) return null; // a double tap must not save twice
    inFlight.current = true;
    setError(null);
    setResult(null);
    setPhase("saving");
    try {
      const saved = await save();
      setResult({ id: saved.memory.id, created: saved.created });
      setPhase("saved");
      return saved;
    } catch (e) {
      setError(errorMessage(e));
      setPhase("failed");
      return null;
    } finally {
      inFlight.current = false;
    }
  }

  return { phase, result, error, run, busy: phase === "saving" };
}

function CaptureStatus({ phase, result, error, retry }: ReturnType<typeof useCapture> & { retry?: () => void }) {
  return (
    <div role="status" aria-live="polite" className="min-h-6 text-[15px]">
      {phase === "saving" && (
        <p className="flex items-center gap-2 font-semibold text-ink-soft">
          <Aiko mood="reading" size={44} />
          Give me a second, I&apos;m reading this…
        </p>
      )}
      {phase === "saved" && result?.created && (
        <p className="flex items-center gap-2 font-semibold text-moss-ink">
          <Aiko key={result.id} mood="celebrating" motion="jump" size={52} />
          <span>
            Yay! I saved that for you.{" "}
            <Link href={`/memories/${result.id}`} className="underline underline-offset-4">
              See what I found
            </Link>
          </span>
        </p>
      )}
      {phase === "saved" && result?.created === false && (
        <p className="flex items-center gap-2 rounded-2xl bg-butter-soft px-3 py-2 text-butter-ink">
          <Aiko mood="curious" size={44} />
          <span>
            You&apos;ve already saved this, so I kept the one I had instead of making a copy.{" "}
            <Link href={`/memories/${result.id}`} className="font-bold underline underline-offset-4">
              Open it
            </Link>
          </span>
        </p>
      )}
      {phase === "failed" && (
        <p className="flex items-center gap-2 rounded-2xl bg-danger-soft px-3 py-2 text-danger">
          <Aiko mood="confused" size={48} />
          <span>
            Hmm, that didn&apos;t work: {error} Nothing was saved.{" "}
            {retry && (
              <button type="button" onClick={retry} className="font-bold underline underline-offset-4">
                Try again
              </button>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

const postJson = (body: unknown) => api<Captured>("/api/memories", { method: "POST", body });

export function QuickCapture() {
  const router = useRouter();
  const capture = useCapture();
  const [text, setText] = useState("");

  return (
    <form
      className="rounded-3xl border-2 border-line bg-card p-3 shadow-lift focus-within:border-moss/70 sm:p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const done = await capture.run(() => postJson({ kind: "note", text }));
        if (done) setText("");
        router.refresh();
      }}
    >
      <label htmlFor="quick-note" className="sr-only">
        Quick note
      </label>
      <textarea
        id="quick-note"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={20000}
        placeholder="What's on your mind? Save anything..."
        className="block w-full resize-none bg-transparent px-2 py-1.5 text-base leading-relaxed placeholder:text-ink-faint focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 px-1">
        <nav aria-label="Other things to save" className="flex flex-wrap gap-1.5">
          {[
            ["voice", "Voice", "M9 3.5h6v11H9zM5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3"],
            ["url", "Link", "M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"],
            ["image", "Image", "M4 6.500a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-11ZM4 16l4.500-4.500 4 4 2.500-2.500L20 17M15 9.500h.01"],
            ["image", "PDF", "M7 3.500h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.500a1 1 0 0 1 1-1ZM14 3.500V8h4M9 13h6M9 16.500h4"],
          ].map(([kind, label, d]) => (
            <Link key={label} href={`/capture?kind=${kind}`} className="inline-flex items-center gap-1.5 rounded-full bg-paper-deep px-3 py-1.5 text-sm font-bold text-ink-soft hover:bg-moss-soft hover:text-moss-ink">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button type="submit" disabled={capture.busy || !text.trim()} className={buttonClass.primary}>
            Save note
          </button>
        </div>
      </div>
      <CaptureStatus {...capture} />
    </form>
  );
}

type Kind = "note" | "url" | "image" | "voice";
const KINDS: { value: Kind; label: string }[] = [
  { value: "note", label: "Note" },
  { value: "url", label: "Link" },
  { value: "image", label: "Image or PDF" },
  { value: "voice", label: "Voice" },
];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const FILE_TYPES = [...IMAGE_TYPES, "application/pdf"];

function PasteButton({ onPaste, message }: { onPaste: () => void; message: string | null }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" onClick={onPaste} className={buttonClass.secondary}>
        Paste from clipboard
      </button>
      {message && <span role="status" className="text-sm text-ink-soft">{message}</span>}
    </div>
  );
}

export function CaptureForm({
  maxUploadBytes,
  maxDocumentBytes,
  storageNote,
  initial = { url: "", text: "" },
  initialKind,
}: {
  maxUploadBytes: number;
  maxDocumentBytes: number;
  storageNote: string;
  /** shared into the form from the phone's share sheet: filled in, never saved until the user taps Save */
  initial?: { url: string; text: string };
  initialKind?: "note" | "url" | "image" | "voice";
}) {
  const router = useRouter();
  const capture = useCapture();
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<Kind>(initialKind ?? (initial.url ? "url" : "note"));
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  const limitFor = (f: File) => (f.type === "application/pdf" ? maxDocumentBytes : maxUploadBytes);
  const [fileName, setFileName] = useState<string | null>(null);
  // an Apple HEIC photo that was turned into a JPEG on this device (only Safari can decode HEIC); this is what gets uploaded
  const [converted, setConverted] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  async function pasteFromClipboard() {
    setPasteMsg(null);
    const r = await readClipboard();
    if (!r.ok) return setPasteMsg(r.message);
    const { url, text } = splitClipboard(r.text);
    // in the link form a pasted link fills the link box and the rest fills the text box; elsewhere it all stays as text
    if (kind === "url" && urlRef.current && url) {
      urlRef.current.value = url;
      if (textRef.current && text) textRef.current.value = text;
    } else if (textRef.current) {
      textRef.current.value = url && kind === "note" ? r.text.trim().slice(0, 20_000) : text || r.text.trim().slice(0, 20_000);
    }
    setPasteMsg("Pasted. Check it, then save.");
  }

  async function onFilePicked(f: File | undefined) {
    setConverted(null);
    setFileError(null);
    if (f && isHeicFile(f)) {
      setConverting(true);
      try {
        const jpeg = await convertHeicToJpeg(f);
        setConverted(jpeg);
        f = jpeg;
      } catch (e) {
        setPreview(null);
        setFileName(null);
        setFileError(e instanceof HeicError ? `${e.message} ${HEIC_HELP}` : HEIC_HELP);
        return;
      } finally {
        setConverting(false);
      }
    }
    setFileError(f && f.size > limitFor(f) ? `That file is larger than ${mb(limitFor(f))} MB.` : null);
    setPreview(f && IMAGE_TYPES.includes(f.type) ? URL.createObjectURL(f) : null);
    setFileName(f && f.type === "application/pdf" ? f.name : null);
  }

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const text = String(fd.get("text") ?? "").trim() || undefined;
    let save: () => Promise<Captured>;
    if (kind === "note") save = () => postJson({ kind: "note", text: text ?? "" });
    else if (kind === "url") save = () => postJson({ kind: "url", url: String(fd.get("url") ?? "").trim(), text });
    else {
      if (converting) return setFileError("Still converting your photo. One moment.");
      const file = converted ?? fd.get("file");
      if (!(file instanceof File) || file.size === 0) return setFileError("Choose an image or PDF first.");
      if (file.size > limitFor(file)) return setFileError(`That file is larger than ${mb(limitFor(file))} MB.`);
      const form = new FormData();
      form.set("file", file);
      if (text) form.set("text", text);
      save = () => api<Captured>("/api/memories", { method: "POST", form });
    }
    const done = await capture.run(save);
    // straight to the new memory, which shows its own progress and refreshes itself until it is understood
    if (done?.created) router.push(`/memories/${done.memory.id}?saved=1`);
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-6">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink-soft">What are you saving?</legend>
        <div className="inline-flex flex-wrap rounded-full bg-paper-deep p-1">
          {KINDS.map((k) => (
            <label
              key={k.value}
              className="cursor-pointer rounded-full px-4 py-2 text-[15px] font-bold text-ink-soft transition-colors has-checked:bg-card has-checked:text-ink has-checked:shadow-card has-focus-visible:outline-2 has-focus-visible:outline-moss"
            >
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => {
                  setKind(k.value);
                  setFileError(null);
                }}
                className="sr-only"
              />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "voice" && <VoiceCapture />}

      {kind === "note" && (
        <div>
          <label htmlFor="cap-text" className="mb-1.5 block text-sm font-medium">
            Note
          </label>
          <textarea id="cap-text" ref={textRef} name="text" required rows={7} maxLength={20000} defaultValue={initial.text} className={fieldClass} autoCapitalize="sentences"
            placeholder="Anything worth remembering — a plan, a thought, a list…" />
          <PasteButton onPaste={pasteFromClipboard} message={pasteMsg} />
        </div>
      )}

      {kind === "url" && (
        <>
          <div>
            <label htmlFor="cap-url" className="mb-1.5 block text-sm font-medium">
              Link
            </label>
            <input id="cap-url" ref={urlRef} name="url" type="url" required inputMode="url" maxLength={2000} defaultValue={initial.url} className={fieldClass}
              autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" placeholder="https://…" />
            <PasteButton onPaste={pasteFromClipboard} message={pasteMsg} />
          </div>
          <div>
            <label htmlFor="cap-text" className="mb-1.5 block text-sm font-medium">
              Text from the page <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <textarea id="cap-text" ref={textRef} name="text" rows={6} maxLength={20000} defaultValue={initial.text} className={fieldClass} aria-describedby="cap-url-hint" autoCapitalize="sentences"
              placeholder="Paste the job description, recipe, or the paragraph that matters…" />
            <p id="cap-url-hint" className="mt-2 text-sm text-ink-soft">
              In demo mode Acorn doesn&apos;t fetch pages — it only reads the link and whatever you paste here, so paste the
              part you care about. In Meta mode it also tries to read the public page.
            </p>
          </div>
        </>
      )}

      {kind === "image" && (
        <>
          <div>
            <label htmlFor="cap-file" className="mb-1.5 block text-sm font-medium">
              Screenshot, photo or PDF
            </label>
            <input
              id="cap-file"
              name="file"
              type="file"
              required
              accept={FILE_TYPES.join(",")}
              aria-describedby="cap-file-hint"
              className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-moss file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-moss-ink"
              onChange={(e) => void onFilePicked(e.target.files?.[0])}
            />
            <p id="cap-file-hint" className="mt-2 text-sm text-ink-soft">
              PNG, JPEG, WebP or GIF up to {mb(maxUploadBytes)} MB, or a PDF up to {mb(maxDocumentBytes)} MB. {storageNote} The original is
              always kept as you uploaded it.
            </p>
            {converting && <p role="status" className="mt-3 text-sm text-ink-soft">Converting your HEIC photo to JPEG on this device…</p>}
            {converted && <p className="mt-3 rounded-xl border border-line bg-paper-deep px-3 py-2 text-sm">Your HEIC photo was converted to JPEG on this device, and the JPEG is what Acorn keeps.</p>}
            {fileName && <p className="mt-3 rounded-xl border border-line bg-paper-deep px-3 py-2 text-sm">PDF: {fileName}</p>}
            {fileError && <p className="mt-2 text-sm text-danger">{fileError}</p>}
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
              <img src={preview} alt="Preview of the selected image" className="mt-4 max-h-72 rounded-xl border border-line object-contain" />
            )}
          </div>
          <div>
            <label htmlFor="cap-text" className="mb-1.5 block text-sm font-medium">
              Caption <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <textarea id="cap-text" name="text" rows={3} maxLength={2000} className={fieldClass}
              placeholder="Why did you save this? (Your own words here are what Acorn treats as your intent.)" />
          </div>
        </>
      )}

      {kind !== "voice" && (
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={capture.busy} className={buttonClass.primary}>
          {capture.busy ? "Saving…" : "Save to Acorn"}
        </button>
        <CaptureStatus {...capture} retry={() => formRef.current?.requestSubmit()} />
      </div>
      )}
    </form>
  );
}
