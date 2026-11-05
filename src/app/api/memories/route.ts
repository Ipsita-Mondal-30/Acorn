import { after, connection } from "next/server";
import { z } from "zod";
import { CaptureFields, processMemory, saveCapture } from "@/lib/process";
import { listMemories } from "@/lib/store";
import { HEIC_MESSAGE, isHeic, MAX_DOCUMENT_BYTES, MAX_UPLOAD_BYTES, UploadError, uploadKind } from "@/lib/uploads";
import { checkSize, errorResponse, HttpError, json, readJson } from "../_http";

export async function GET() {
  await connection();
  try {
    return json({ memories: await listMemories() });
  } catch (e) {
    return errorResponse(e);
  }
}

const Caption = z.string().max(2000).optional();

/**
 * Capture a note/link (JSON `{kind:"note",text}` | `{kind:"url",url,text?}`) or an image
 * or PDF (multipart/form-data: `file`, optional `text`). Replies as soon as the original is stored, with the memory
 * "pending"; it is understood after the response (poll GET /api/memories/:id for pending → processing → ready | failed).
 * An extraction failure is recorded on the memory (status "failed"), never lost.
 * 201 when created, 200 when the same content was already saved (`created: false`).
 */
export async function POST(req: Request) {
  try {
    const type = req.headers.get("content-type") ?? "";
    let result;
    if (type.startsWith("multipart/form-data")) {
      checkSize(req, MAX_DOCUMENT_BYTES + 64 * 1024);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "file: an image or PDF is required");
      if (file.size > MAX_DOCUMENT_BYTES) throw new HttpError(413, "File is too large");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // the kind comes from the file's bytes, never from its name or the browser's MIME type
      const kind = uploadKind(bytes);
      if (!kind) throw new UploadError(isHeic(bytes) ? HEIC_MESSAGE : "Only PNG, JPEG, WebP or GIF images, and PDF documents, are supported.");
      if (kind === "image" && file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Image is too large");
      result = await saveCapture({ kind, bytes, originalName: file.name, text: Caption.parse(form.get("text") ?? undefined) });
    } else if (type.startsWith("application/json")) {
      const body = CaptureFields.parse(await readJson(req));
      if (body.kind === "image" || body.kind === "document") throw new HttpError(400, "Send images and PDFs as multipart/form-data");
      result = await saveCapture(body);
    } else {
      throw new HttpError(415, "Send JSON for notes and links, or multipart/form-data for images");
    }
    // Reply as soon as the original is safely stored; understanding it happens after the response, so a slow or failed
    // model call never delays or loses the save. A failure is recorded on the memory (status "failed") and can be retried.
    // A repeat of something already saved that was never understood is picked up again here (the claim is atomic).
    const { memory } = result;
    if (memory.status === "pending") {
      after(() => processMemory(memory.id).catch((e) => console.error(`[capture] background processing failed: ${e instanceof Error ? e.name : "error"}`)));
    }
    return json(result, result.created ? 201 : 200);
  } catch (e) {
    return errorResponse(e);
  }
}
