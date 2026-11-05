import "server-only";

// Structured, redacted logging. One JSON object per line (easy to search in any host's log viewer), and nothing that looks
// like a credential: the VALUE of every secret-named environment variable and every common secret shape is replaced
// before a line is written. Saved content (memory text, CVs) is never logged by this module; callers pass counts and ids.

const SECRET_NAME = /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|DIRECT_URL)/;
const SHAPES: [RegExp, string][] = [
  [/(postgres(?:ql)?:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1[redacted]@"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "[redacted-jwt]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bre_[A-Za-z0-9]{16,}/g, "[redacted-key]"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, "[redacted-key]"],
];

/** Replace secret values (from the environment) and secret-shaped strings. Safe to call on any text. */
export function redact(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name) && !name.startsWith("NEXT_PUBLIC_")) out = out.split(value).join(`[redacted ${name}]`);
  }
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What happened, not the object that did it: name, a clipped redacted message, and where (file:line, no arguments). */
export function errorSummary(e: unknown): { name: string; message: string; at: string | null } {
  if (e instanceof Error) {
    const frame = /\(?([^()\s]+:\d+:\d+)\)?\s*$/m.exec((e.stack ?? "").split("\n").slice(1).find((l) => l.includes("/src/") || l.includes("\\src\\")) ?? "");
    return { name: e.name, message: clip(redact(e.message), 300), at: frame ? redact(frame[1]).replace(/^.*\/(src\/)/, "$1") : null };
  }
  return { name: "NonError", message: clip(redact(String(e)), 300), at: null };
}

type Level = "info" | "warn" | "error";

export function logEvent(level: Level, evt: string, fields: Record<string, unknown> = {}): void {
  const safe = JSON.parse(redact(JSON.stringify(fields))) as Record<string, unknown>;
  const line = JSON.stringify({ t: new Date().toISOString(), level, evt, ...safe });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(line);
}

export const logError = (evt: string, e: unknown, fields: Record<string, unknown> = {}) => logEvent("error", evt, { ...fields, error: errorSummary(e) });
