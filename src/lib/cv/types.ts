import { z } from "zod";
import { ParsedCv } from "./parse";

export const CvDocument = z.object({
  id: z.string(),
  source: z.enum(["upload", "paste"]),
  /** the stored original (uploads only): `<uuid>.<ext>` in the user's private folder */
  fileName: z.string().nullable(),
  originalName: z.string().nullable(),
  fileKind: z.enum(["pdf", "docx", "txt"]).nullable(),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  text: z.string().min(20).max(60_000),
  textSha256: z.string().length(64),
  parsed: ParsedCv,
  parserVersion: z.string(),
  readable: z.boolean(),
  isCurrent: z.boolean(),
  createdAt: z.string(),
  replacedAt: z.string().nullable(),
});
export type CvDocument = z.infer<typeof CvDocument>;
