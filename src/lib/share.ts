import "server-only";
import { parseSafeUrl } from "./url";

export type SharedFields = { title?: string; text?: string; url?: string };
export type SharedCapture = { kind: "note"; text: string } | { kind: "url"; url: string; text?: string };

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/i;

function safeUrl(raw: string): string | null {
  try {
    return parseSafeUrl(raw).toString();
  } catch {
    return null;
  }
}

/**
 * Turns what a phone's share sheet sends (title, text, url) into a capture. Android apps often put the link in `text`
 * rather than `url`, so a link found there is treated as a link. Nothing is invented: the shared words are kept as the
 * note text, and a link is only used if it parses as a safe http(s) URL. Returns null when nothing usable was shared.
 */
export function captureFromShare(f: SharedFields): SharedCapture | null {
  const title = clip(f.title, 300);
  const text = clip(f.text, 20_000);
  const url = clip(f.url, 2000);

  const link = (url && safeUrl(url)) || (text && safeUrl(text.match(URL_IN_TEXT)?.[0] ?? "")) || null;
  if (link) {
    const rest = text.replace(URL_IN_TEXT, "").replace(/\s+/g, " ").trim();
    const words = [title, rest].filter((x, i, a) => x && a.indexOf(x) === i).join("\n");
    return { kind: "url", url: link, ...(words ? { text: words.slice(0, 20_000) } : {}) };
  }
  const body = [title, text].filter((x, i, a) => x && a.indexOf(x) === i).join("\n\n");
  return body ? { kind: "note", text: body.slice(0, 20_000) } : null;
}
