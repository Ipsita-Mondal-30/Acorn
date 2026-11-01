export type AiErrorKind =
  | "config" // no key / bad setup
  | "budget" // ACORN_MAX_MODEL_CALLS reached
  | "auth" // 401 / 403
  | "billing" // 402
  | "model_unavailable" // 404 model_not_found
  | "rate_limit" // 429 after retries
  | "unavailable" // 500 / 503 after retries
  | "timeout" // our timeout, or HTTP 504
  | "network"
  | "bad_request" // 400: bad parameters, corrupt or oversized input
  | "too_large" // 413
  | "truncated" // finish_reason "length"
  | "malformed" // not JSON, or JSON that fails our schema
  | "unsupported"; // this provider can't do that (e.g. demo mode and a PDF)

/** Error whose message is safe to show the user (no saved content, no secrets, no raw API bodies). */
export class AiError extends Error {
  name = "AiError";
  constructor(
    message: string,
    public kind: AiErrorKind = "unavailable",
  ) {
    super(message);
  }
}
