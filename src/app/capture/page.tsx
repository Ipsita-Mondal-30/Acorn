import type { Metadata } from "next";
import { CaptureForm } from "@/components/CaptureForm";
import { Suspense } from "react";
import { connection } from "next/server";
import { AikoSays } from "@/components/Aiko";
import { initialFromParams } from "@/lib/capture-params";
import { SamplePicker } from "@/components/SamplePicker";
import { META_MODELS } from "@/lib/ai/models";
import { SAMPLES } from "@/lib/ai/samples";
import { getEnv, storageMode } from "@/lib/env";
import { MAX_DOCUMENT_BYTES, MAX_UPLOAD_BYTES } from "@/lib/uploads";

export const metadata: Metadata = { title: "Capture" };

const MODEL_ROLES: Record<keyof typeof META_MODELS, string> = {
  extraction: "Understanding notes, links, screenshots & PDFs",
  agentReasoning: "Reasoning across memories",
  transcription: "Voice notes",
  segmentation: "Cropping screenshots",
  imageGeneration: "Image generation",
};

const SHARE_PROBLEM: Record<string, string> = {
  empty: "Nothing usable was shared. Paste it below instead.",
  type: "Acorn can save PNG, JPEG, WebP or GIF images and PDFs. That file is a different type.",
  large: "That file is too large to save.",
  heic: "That photo is in Apple's HEIC format, which Acorn can't read yet. Pick it from the Photos picker on this page (Safari usually converts it), or share it as a JPEG.",
  signin: "Sign in first, then share the file again. A file can't be kept while you sign in, so nothing was saved.",
  failed: "Acorn couldn't save what was shared. Nothing was lost on your phone; try again or paste it below.",
};

async function CaptureBody({ searchParams }: Pick<PageProps<"/capture">, "searchParams">) {
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const problem = SHARE_PROBLEM[one("share")];
  // values handed over by the share sheet or a shortcut only FILL the form; saving is always the user's tap
  const initial = initialFromParams(q);
  await connection(); // env is runtime config
  const demo = getEnv().ACORN_MODE === "demo";
  const storageNote = storageMode() === "local" ? "Stays on this machine." : "Stored privately in your account.";
  return (
    <>
      {problem && <p role="alert" className="mt-8 rounded-xl bg-danger-soft px-4 py-3 text-[15px] text-danger">{problem}</p>}
      <div className="mt-8 rounded-3xl border-2 border-line bg-card p-5 shadow-lift sm:p-8">
        <CaptureForm initialKind={one("kind") === "url" ? "url" : one("kind") === "image" ? "image" : one("kind") === "voice" ? "voice" : undefined} maxUploadBytes={MAX_UPLOAD_BYTES} maxDocumentBytes={MAX_DOCUMENT_BYTES} storageNote={storageNote} initial={initial} />
      </div>
      {demo && <SamplePicker samples={SAMPLES.map(({ id, label, blurb, kind }) => ({ id, label, blurb, kind }))} />}
    </>
  );
}

export default function CapturePage({ searchParams }: PageProps<"/capture">) {
  return (
    <div className="max-w-2xl">
      <h1 className="sr-only">Capture</h1>
      <AikoSays mood="curious" size={104} title="What did you find?">
        Drop it here, a note, a link, a screenshot or a PDF. Save it now and I&apos;ll read it, work out what it is and
        remember the parts that matter.
      </AikoSays>
      <Suspense fallback={<div className="mt-8 h-96 animate-pulse rounded-3xl bg-paper-deep" aria-hidden="true" />}>
        <CaptureBody searchParams={searchParams} />
      </Suspense>
      <p className="mt-6 text-sm text-ink-soft">
        On an iPhone? Safari can&apos;t add Acorn to the share sheet by itself.{" "}
        <a href="/shortcut" className="font-bold text-moss-ink underline underline-offset-4">Set up the Save to Acorn shortcut</a>.
      </p>
      <details className="mt-8 text-sm text-ink-soft">
        <summary className="cursor-pointer font-medium hover:text-ink">About the models</summary>
        <p className="mt-3">
          In Meta mode, Acorn uses Meta&apos;s models for these jobs. In demo mode nothing is sent anywhere — built-in rules
          produce a clearly labelled mock reading.
        </p>
        <dl className="mt-3 divide-y divide-line/70 rounded-3xl border-2 border-line/80 bg-card">
          {Object.entries(MODEL_ROLES).map(([key, role]) => {
            const m = META_MODELS[key as keyof typeof META_MODELS];
            return (
              <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                <dt>{role}</dt>
                <dd className="flex items-center gap-2">
                  <code className="text-ink">{m.model}</code>
                  <span className={m.status === "in use" ? "text-moss-ink" : "text-ink-faint"}>{m.status}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    </div>
  );
}
