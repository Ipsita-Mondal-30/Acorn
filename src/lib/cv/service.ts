import "server-only";
import { createHash } from "node:crypto";
import { buildCvDocument, PARSER_VERSION } from "./build";
import { CvFileError, extractCvText } from "./extract";
import { parseCv } from "./parse";
import type { CvDocument } from "./types";
import { deleteCvDocuments, getCvDocument, saveCvDocument, updateCvDocument } from "../store";
import { deleteUpload, readUpload, saveCvFile } from "../uploads";

// CV upload, replacement, re-parsing and removal. The original file is kept as uploaded; what Acorn reads is the text
// extracted from it, and every structured item points back at that text. A new upload makes a new version and keeps
// the old one (and its file) as history; only "remove" deletes.

export const MIN_CV_CHARS = 20;

export async function uploadCv(bytes: Uint8Array, originalName: string): Promise<{ cv: CvDocument; warning: string | null }> {
  const x = extractCvText(bytes); // throws CvFileError for the wrong type, too big, password-protected, damaged
  if (!x.readable) throw new CvFileError(x.warning ?? "Acorn couldn't read any text in this file.");
  const { fileName } = await saveCvFile(bytes, x.kind);
  const doc = buildCvDocument({ source: "upload", text: x.text, readable: true, file: { name: fileName, originalName, kind: x.kind, byteSize: bytes.byteLength } });
  try {
    return { cv: await saveCvDocument(doc), warning: x.warning };
  } catch (e) {
    await deleteUpload(fileName); // don't leave an orphan file behind a failed save
    throw e;
  }
}

export async function pasteCv(text: string): Promise<CvDocument> {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (t.length < MIN_CV_CHARS) throw new CvFileError("Paste your CV text (at least a few lines).");
  return saveCvDocument(buildCvDocument({ source: "paste", text: t.slice(0, 60_000) }));
}

/** Read the stored original again with the current parser (e.g. after the parser improves). Updates the current CV in place. */
export async function reparseCv(): Promise<CvDocument | null> {
  const cur = await getCvDocument();
  if (!cur) return null;
  let text = cur.text;
  if (cur.source === "upload") {
    const file = cur.fileName ? await readUpload(cur.fileName) : null;
    if (!file) throw new CvFileError("The original file is missing. Upload your CV again.");
    const x = extractCvText(file.bytes);
    if (!x.readable) throw new CvFileError(x.warning ?? "Acorn couldn't read any text in this file.");
    text = x.text;
  }
  return updateCvDocument(cur.id, (d) => ({
    ...d,
    text,
    textSha256: createHash("sha256").update(text).digest("hex"),
    parsed: parseCv(text, new Date()),
    parserVersion: PARSER_VERSION,
  }));
}

/** Delete every CV version and its stored file. Only the user asks for this. */
export async function removeAllCvs(): Promise<number> {
  const { versions, files } = await deleteCvDocuments();
  await Promise.all(files.map((n) => deleteUpload(n)));
  return versions;
}

/** What the UI may show about a CV: metadata, counts and the structured parse (the owner's own data). */
export function cvSummary(d: CvDocument) {
  const p = d.parsed;
  return {
    id: d.id,
    source: d.source,
    originalName: d.originalName,
    fileKind: d.fileKind,
    byteSize: d.byteSize,
    createdAt: d.createdAt,
    parserVersion: d.parserVersion,
    characters: d.text.length,
    counts: { experience: p.experience.length, projects: p.projects.length, skills: p.skills.length, education: p.education.length, certifications: p.certifications.length },
    parsed: p,
    hasFile: Boolean(d.fileName),
    fileName: d.fileName,
  };
}
