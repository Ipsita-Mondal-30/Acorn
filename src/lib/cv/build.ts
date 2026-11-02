import { createHash, randomUUID } from "node:crypto";
import type { CvFileKind } from "./extract";
import { CV_MIME } from "./extract";
import { parseCv } from "./parse";
import type { CvDocument } from "./types";

export const PARSER_VERSION = "cv-rules-1";

/** Build a CV record (parsed, hashed, not yet stored) from extracted or pasted text. Pure apart from the id and clock. */
export function buildCvDocument(input: {
  source: "upload" | "paste";
  text: string;
  file?: { name: string; originalName: string; kind: CvFileKind; byteSize: number };
  readable?: boolean;
  now?: Date;
}): CvDocument {
  const now = input.now ?? new Date();
  return {
    id: randomUUID(),
    source: input.source,
    fileName: input.file?.name ?? null,
    originalName: input.file?.originalName.replace(/[\u0000-\u001f]/g, "").slice(0, 255) ?? null,
    fileKind: input.file?.kind ?? null,
    mimeType: input.file ? CV_MIME[input.file.kind] : null,
    byteSize: input.file?.byteSize ?? null,
    text: input.text,
    textSha256: createHash("sha256").update(input.text).digest("hex"),
    parsed: parseCv(input.text, now),
    parserVersion: PARSER_VERSION,
    readable: input.readable ?? true,
    isCurrent: true,
    createdAt: now.toISOString(),
    replacedAt: null,
  };
}
