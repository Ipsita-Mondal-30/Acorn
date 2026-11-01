import { createHash } from "node:crypto";
import hashes from "./sample-hashes.json";
import samples from "./samples.json";

/** Built-in demo inputs (all fictional). Image and PDF files live in public/samples; see scripts/make-samples.mjs. */
export type Sample = {
  id: string;
  kind: "image" | "document" | "note" | "url";
  label: string;
  blurb: string;
  fileName?: string;
  mimeType?: string;
  /** the exact text printed in the image / PDF; what the demo "reads" when it recognises the file */
  pages?: string[];
  text?: string;
  /** what the user typed when saving a screenshot, if anything (their own words, unlike the text in the image) */
  caption?: string;
  url?: string;
};

export const SAMPLES = samples as Sample[];
export const sampleById = (id: string) => SAMPLES.find((s) => s.id === id) ?? null;

/** Recognise a built-in sample by its exact bytes. Any other file is unknown to the demo. */
export function sampleForBytes(bytes: Uint8Array): Sample | null {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const id = Object.entries(hashes as Record<string, string>).find(([, h]) => h === hash)?.[0];
  return id ? sampleById(id) : null;
}
