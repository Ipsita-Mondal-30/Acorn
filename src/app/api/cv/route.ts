import { connection } from "next/server";
import { z } from "zod";
import { CvFileError, MAX_CV_BYTES } from "@/lib/cv/extract";
import { cvSummary, pasteCv, removeAllCvs, reparseCv, uploadCv } from "@/lib/cv/service";
import { getCvDocument, listCvDocuments } from "@/lib/store";
import { checkSize, errorResponse, HttpError, json, readJson } from "../_http";

// The CV you give Acorn: an uploaded PDF / Word / text file, or pasted text. Private to your account (private storage,
// row-level security), read only by plans you approve. The original file is kept; replacing it keeps the old version.

export async function GET() {
  await connection();
  try {
    const cur = await getCvDocument();
    const history = (await listCvDocuments()).filter((d) => !d.isCurrent).map((d) => ({ id: d.id, originalName: d.originalName, source: d.source, createdAt: d.createdAt, replacedAt: d.replacedAt }));
    return json({ cv: cur ? cvSummary(cur) : null, history });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Upload a CV file (multipart/form-data, field `file`). It replaces the current CV; the old one is kept as history. */
export async function POST(req: Request) {
  try {
    checkSize(req, MAX_CV_BYTES + 64 * 1024);
    if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) throw new HttpError(415, "Send the file as multipart/form-data");
    const file = (await req.formData()).get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "file: a PDF, .docx or text file is required");
    if (file.size > MAX_CV_BYTES) throw new HttpError(413, "CV files must be 5 MB or smaller");
    const { cv, warning } = await uploadCv(new Uint8Array(await file.arrayBuffer()), file.name);
    return json({ cv: cvSummary(cv), warning }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { text } = z.object({ text: z.string().max(60_000) }).strict().parse(await readJson(req));
    return json({ cv: cvSummary(await pasteCv(text)) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** `{op:"reparse"}`: read the stored original again with the current parser. */
export async function PATCH(req: Request) {
  try {
    z.object({ op: z.literal("reparse") }).strict().parse(await readJson(req));
    const cv = await reparseCv();
    if (!cv) throw new HttpError(404, "No CV on file");
    return json({ cv: cvSummary(cv) });
  } catch (e) {
    if (e instanceof CvFileError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function DELETE() {
  try {
    return json({ removed: await removeAllCvs() });
  } catch (e) {
    return errorResponse(e);
  }
}
