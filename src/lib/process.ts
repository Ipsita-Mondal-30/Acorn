import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AiError, extractValidated, getProvider, type ExtractInput } from "./ai/provider";
import { walledNote, walledPlatform } from "./platforms";
import type { Memory } from "./schema";
import { indexMemory } from "./indexing";
import { claimProcessing, deleteMemory, hashContent, insertMemory, newId, updateMemory } from "./store";
import { deleteUpload, estimatePdfPages, readUpload, saveUpload, UploadError } from "./uploads";
import { fetchPage, parseSafeUrl, UrlError } from "./url";
import { verifyExtraction } from "./verify";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => s || undefined);

/** Validates the non-binary capture fields (use it in route handlers for 400s). */
export const CaptureFields = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), text: z.string().trim().min(1, "Write something to save.").max(20_000) }),
  z.object({
    kind: z.literal("url"),
    url: z.string().transform((raw, ctx) => {
      try {
        return parseSafeUrl(raw).toString();
      } catch (e) {
        ctx.addIssue({ code: "custom", message: e instanceof UrlError ? e.message : "Invalid URL." });
        return z.NEVER;
      }
    }),
    text: optionalText(20_000),
  }),
  z.object({ kind: z.literal("image"), text: optionalText(2_000) }),
  z.object({ kind: z.literal("document"), text: optionalText(2_000) }),
]);
export type CaptureFields = z.infer<typeof CaptureFields>;

export type CaptureInput =
  | { kind: "note"; text: string }
  | { kind: "url"; url: string; text?: string }
  | { kind: "image"; bytes: Uint8Array; originalName: string; text?: string }
  | { kind: "document"; bytes: Uint8Array; originalName: string; text?: string };

export async function captureMemory(input: CaptureInput): Promise<{ memory: Memory; created: boolean }> {
  const fields = CaptureFields.parse(input.kind === "image" || input.kind === "document" ? { kind: input.kind, text: input.text } : input);
  const now = new Date().toISOString();
  const base = { id: newId(), createdAt: now, updatedAt: now, status: "pending" as const, extraction: null, overrides: {}, isSample: false };

  let memory: Memory;
  if (fields.kind === "image" || fields.kind === "document") {
    const { bytes, originalName } = input as Extract<CaptureInput, { kind: "image" | "document" }>;
    const bytesHash = createHash("sha256").update(bytes).digest("hex");
    // the original is stored first and kept as it was uploaded: nothing below ever replaces it with a summary
    const { fileName, mimeType } = await saveUpload(bytes, [fields.kind]);
    const name = originalName.replace(/[\u0000-\u001f]/g, "").slice(0, 255) || undefined;
    memory = {
      ...base,
      source: { kind: fields.kind, text: fields.text, fileName, mimeType, originalName: name },
      contentHash: hashContent(fields.kind, bytesHash, fields.text),
    };
    let r;
    try {
      r = await insertMemory(memory);
    } catch (e) {
      await deleteUpload(fileName); // don't leave an orphan file behind a failed save
      throw e;
    }
    if (!r.created) {
      await deleteUpload(fileName);
      return r;
    }
  } else {
    const source = fields.kind === "note" ? { kind: fields.kind, text: fields.text } : { kind: fields.kind, url: fields.url, text: fields.text };
    memory = { ...base, source, contentHash: hashContent(source.kind, source.url, source.text) };
    const r = await insertMemory(memory);
    if (!r.created) return r;
  }
  return { memory: (await processMemory(memory.id)) ?? memory, created: true };
}

const userMessage = (e: unknown) =>
  e instanceof AiError || e instanceof UploadError || e instanceof UrlError ? e.message : "Something went wrong while processing this item. Try again.";

// Meta documents these limits for PDFs: text from the first 100 pages, page images for the first 50.
const PDF_TEXT_PAGES = 100;
const PDF_IMAGE_PAGES = 50;

// ponytail: runs synchronously inside the request; swap for a job queue when processing gets slow.
// The memory's status (pending → processing → ready | failed) plus the claim lease is the processing job.
/** Never throws for processing failures — they're stored as status "failed". Returns null if the id is unknown. */
export async function processMemory(id: string, opts: { force?: boolean } = {}): Promise<Memory | null> {
  // Atomic claim: concurrent callers can't both run (and pay for) the same extraction.
  const { memory: current, claimed } = await claimProcessing(id, opts);
  if (!current) return null;
  if (!claimed) return current;

  try {
    const provider = getProvider();
    const { source } = current;
    const notes: string[] = [];
    const input: ExtractInput = { kind: source.kind, text: source.text, url: source.url, originalName: source.originalName, now: new Date() };

    if (source.kind === "image" || source.kind === "document") {
      const file = source.fileName ? await readUpload(source.fileName) : null;
      if (!file) throw new UploadError("The uploaded file is missing. Please upload it again.");
      if (source.kind === "image") input.image = file;
      else {
        input.document = { bytes: file.bytes, mimeType: "application/pdf", fileName: source.originalName ?? "document.pdf" };
        const pages = estimatePdfPages(file.bytes);
        if (provider.name === "meta" && pages > PDF_IMAGE_PAGES) {
          notes.push(
            pages > PDF_TEXT_PAGES
              ? `This PDF has about ${pages} pages. The model reads text from the first ${PDF_TEXT_PAGES} pages and sees page images for the first ${PDF_IMAGE_PAGES}, so the rest was not understood.`
              : `This PDF has about ${pages} pages. The model sees page images for the first ${PDF_IMAGE_PAGES}; later pages are read as text only.`,
          );
        }
      }
    }

    if (source.kind === "url" && source.url) {
      const walled = walledPlatform(source.url);
      if (walled) {
        // Never pretend to have seen a private post: don't even try, and say so.
        notes.push(walledNote(walled));
      } else if (provider.name === "meta") {
        try {
          const page = await fetchPage(source.url);
          input.text = [
            source.text,
            page.title && `Page title: ${page.title}`,
            page.description && `Page description: ${page.description}`,
            page.siteName && `Site: ${page.siteName}`,
            page.text && `Fetched page text:\n${page.text.slice(0, 20_000)}`,
          ]
            .filter(Boolean)
            .join("\n\n");
          if (page.truncated || page.text.length > 20_000) notes.push("The page was long, so only its beginning was read.");
        } catch (e) {
          notes.push(`Couldn't fetch the page (${userMessage(e)}); extracted from the URL${source.text ? " and your note" : ""} only.`);
        }
      }
    }

    const started = Date.now();
    const { data: raw, usage, latencyMs, note } = await extractValidated(provider, input);
    const measured = Date.now() - started;

    const pixels = source.kind === "image" || source.kind === "document";
    const text = [input.text, input.url, input.originalName].filter(Boolean).join("\n");
    const { output: out, facts, notes: verifyNotes } = verifyExtraction(raw, {
      text: text || null,
      pixels,
      // "you said so" may only rest on the user's own words, never on a fetched page or text in a screenshot
      userText: source.text ?? null,
    });
    const extraction = {
      ...out,
      facts,
      uncertainties: [...notes, ...verifyNotes, ...out.uncertainties].slice(0, 10),
      producedBy: { provider: provider.name, model: provider.model, at: new Date().toISOString(), latencyMs: latencyMs ?? measured, ...(usage ? { usage } : {}), ...(note ? { note } : {}) },
    };
    const ready = await updateMemory(id, (m) => ({ ...m, status: "ready", error: undefined, extraction }));
    if (ready) await indexMemory(ready); // best-effort; no-op without an embedding provider, never fails the capture
    return ready;
  } catch (e) {
    // AiError/UrlError messages never contain saved content; other errors are fs/env/store failures
    console.error(`[process] memory=${id} failed: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : String(e)}`);
    return updateMemory(id, (m) => ({ ...m, status: "failed", error: userMessage(e) }));
  }
}

/** Delete a memory with its actions and (when it has one) its stored file. Returns false if it doesn't exist. */
export async function removeMemory(id: string): Promise<boolean> {
  const removed = await deleteMemory(id);
  if (!removed) return false;
  if (removed.source.fileName) await deleteUpload(removed.source.fileName);
  return true;
}
