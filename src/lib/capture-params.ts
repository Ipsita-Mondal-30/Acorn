// What the capture form is pre-filled with when it is opened with ?url=&text=&title= (the Android share fallback and the
// iPhone Shortcut). Pre-filling NEVER saves: the person reads it and taps Save.

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
const URL_IN_TEXT = /\bhttps?:\/\/\S+/;

export const MAX_PARAM_TEXT = 20_000;
export const MAX_PARAM_URL = 2000;

export function initialFromParams(q: Query): { url: string; text: string } {
  const text = one(q, "text").slice(0, MAX_PARAM_TEXT);
  const url = (one(q, "url") || text.match(URL_IN_TEXT)?.[0] || "").slice(0, MAX_PARAM_URL);
  const title = one(q, "title").slice(0, 300);
  return { url, text: [title, text.replace(url, "").trim()].filter(Boolean).join("\n\n") };
}

/**
 * The address the iPhone Shortcut opens. `encodeURIComponent` is what the Shortcuts "URL Encode" action does, so this is also
 * the reference for what the capture page must be able to decode. Empty parts are left out.
 */
export function captureLink(origin: string, parts: { url?: string; title?: string; text?: string }): string {
  const q = (["url", "title", "text"] as const).filter((k) => parts[k]).map((k) => `${k}=${encodeURIComponent(parts[k]!)}`);
  return `${origin.replace(/\/+$/, "")}/capture${q.length ? `?${q.join("&")}` : ""}`;
}
