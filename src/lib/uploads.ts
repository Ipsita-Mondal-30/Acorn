import "server-only";
import { randomUUID } from "node:crypto";
import { StoreError } from "./backends/types";
import { CV_MIME } from "./cv/extract";
import { backend } from "./store";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** PDFs may be bigger than screenshots. (The Meta API accepts 50 MB inline; Acorn keeps its own, lower cap.) */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export type UploadKind = "image" | "document";

/** Message is safe to show the user. */
export class UploadError extends Error {
  name = "UploadError";
}

const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" } as const;
type Ext = keyof typeof MIME;
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|gif|pdf|docx|txt|wav|svg)$/;

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Trust the bytes, never the client-supplied MIME type or extension. */
function sniff(b: Uint8Array): Ext | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "webp";
  if (startsWith(b, ascii("%PDF-"))) return "pdf";
  return null;
}

/** An Apple HEIC/HEIF photo (an ISO "ftyp" box with a HEIF brand). Acorn can't read these; saying so beats a vague "unsupported type". */
export function isHeic(b: Uint8Array): boolean {
  if (b.length < 12 || !startsWith(b, ascii("ftyp"), 4)) return false;
  const brand = String.fromCharCode(...b.subarray(8, 12));
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
}

export const HEIC_MESSAGE =
  "That photo is in Apple's HEIC format, which Acorn can't read yet. Pick it from the Photos picker on the capture page (Safari usually converts it), or share it as a JPEG.";

/** What kind of upload these bytes are, judged by content alone. */
export const uploadKind = (bytes: Uint8Array): UploadKind | null => {
  const ext = sniff(bytes);
  return ext === "pdf" ? "document" : ext ? "image" : null;
};

/** Rough page count of a PDF: counts page objects. Good enough to warn about a model's page limits; not exact. */
export function estimatePdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

export async function saveUpload(
  bytes: Uint8Array,
  allow: UploadKind[] = ["image"],
): Promise<{ fileName: string; mimeType: string; kind: UploadKind }> {
  if (bytes.byteLength === 0) throw new UploadError("The file is empty.");
  const ext = sniff(bytes);
  const kind = ext === "pdf" ? "document" : ext ? "image" : null;
  if (!ext && isHeic(bytes)) throw new UploadError(HEIC_MESSAGE);
  if (!ext || !kind || !allow.includes(kind)) {
    throw new UploadError(allow.includes("document") ? "Only PNG, JPEG, WebP or GIF images, and PDF documents, are supported." : "Only PNG, JPEG, WebP or GIF images are supported.");
  }
  if (kind === "image" && bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError("Images must be 8 MB or smaller.");
  if (kind === "document" && bytes.byteLength > MAX_DOCUMENT_BYTES) throw new UploadError("PDFs must be 15 MB or smaller.");
  const fileName = `${randomUUID()}.${ext}`;
  const { files } = await backend(); // cloud: also requires a signed-in user, before anything is written
  try {
    await files.put(fileName, bytes, MIME[ext]);
  } catch (e) {
    if (e instanceof UploadError) throw e;
    console.error(`[uploads] store failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    throw new UploadError(e instanceof StoreError ? e.message : "Couldn't store the file. Please try again.");
  }
  return { fileName, mimeType: MIME[ext], kind };
}

/** Store a CV file (already validated and parsed by cv/extract). The kind comes from its bytes, never its name. */
export async function saveCvFile(bytes: Uint8Array, kind: "pdf" | "docx" | "txt"): Promise<{ fileName: string; mimeType: string }> {
  const mimeType = CV_MIME[kind];
  const fileName = `${randomUUID()}.${kind}`;
  const { files } = await backend(); // cloud: also requires a signed-in user, before anything is written
  try {
    await files.put(fileName, bytes, mimeType);
  } catch (e) {
    console.error(`[uploads] cv store failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    throw new UploadError(e instanceof StoreError ? e.message : "Couldn't store the file. Please try again.");
  }
  return { fileName, mimeType };
}

/** Store something Acorn generated or recorded (a voice note, a generated picture). Its type is fixed by the caller, not guessed from a user file. */
export async function saveGenerated(bytes: Uint8Array, ext: "wav" | "png" | "webp" | "jpg" | "svg"): Promise<{ fileName: string; mimeType: string }> {
  const mimeType = { wav: "audio/wav", png: "image/png", webp: "image/webp", jpg: "image/jpeg", svg: "image/svg+xml" }[ext];
  const fileName = `${randomUUID()}.${ext}`;
  const { files } = await backend();
  try {
    await files.put(fileName, bytes, mimeType);
  } catch (e) {
    console.error(`[uploads] generated store failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    throw new UploadError(e instanceof StoreError ? e.message : "Couldn't store the file. Please try again.");
  }
  return { fileName, mimeType };
}

export async function readUpload(fileName: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (!SAFE_NAME.test(fileName)) return null; // also blocks path traversal: no slashes or dots beyond the extension
  return (await backend()).files.get(fileName);
}

/** A short-lived URL for a private cloud file; null for local files (the app serves those itself) or if missing. */
export async function signedUploadUrl(fileName: string, expiresInSeconds = 300): Promise<string | null> {
  if (!SAFE_NAME.test(fileName)) return null;
  const { files } = await backend();
  return files.signedUrl ? files.signedUrl(fileName, expiresInSeconds) : null;
}

/** Best-effort cleanup (e.g. a duplicate upload, or a deleted memory). */
export async function deleteUpload(fileName: string): Promise<void> {
  if (SAFE_NAME.test(fileName)) await (await backend()).files.remove(fileName).catch(() => {});
}
