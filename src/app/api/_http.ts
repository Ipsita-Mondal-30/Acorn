import { ZodError } from "zod";
import { ActionError } from "@/lib/actions";
import { AiError } from "@/lib/ai/errors";
import { AuthError, StoreError } from "@/lib/backends/types";
import { logError } from "@/lib/log";
import { CvFileError } from "@/lib/cv/extract";
import { UploadError } from "@/lib/uploads";
import { UrlError } from "@/lib/url";

export const JSON_LIMIT = 256 * 1024;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Reject oversized bodies up front (Content-Length) and after reading (chunked bodies). */
export function checkSize(req: Request, limit: number) {
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new HttpError(413, "Request body too large");
}

export async function readJson(req: Request, limit = JSON_LIMIT): Promise<unknown> {
  checkSize(req, limit);
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, "Request body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

const zodMessage = (e: ZodError) =>
  e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

/** Known input errors → 4xx with their message; anything else → generic 500 (logged). */
export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  if (e instanceof ZodError) return json({ error: zodMessage(e) }, 400);
  if (e instanceof UrlError || e instanceof UploadError || e instanceof CvFileError) return json({ error: e.message }, 400);
  if (e instanceof ActionError) return json({ error: e.message }, 409);
  if (e instanceof AuthError) return json({ error: e.message }, 401);
  if (e instanceof StoreError) return json({ error: e.message }, 503);
  if (e instanceof AiError) {
    // messages are written to be shown to the user; they never contain saved content, keys or raw API bodies
    const status = e.kind === "invalid_input" ? 400 : e.kind === "rate_limit" ? 429 : e.kind === "config" || e.kind === "budget" || e.kind === "auth" || e.kind === "billing" || e.kind === "model_unavailable" ? 503 : e.kind === "timeout" ? 504 : 502;
    return json({ error: e.message, kind: e.kind }, status);
  }
  logError("api_error", e); // name, clipped redacted message and file:line; never the request, its body or the response
  return json({ error: "Something went wrong on our side. Please try again." }, 500);
}
