// Pasting from the clipboard into the capture form. On iPhone Safari, `navigator.clipboard.readText()` shows a small "Paste"
// bubble the user must tap; if they dismiss it, or the browser has no clipboard API, we say what to do instead.

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/i;

/** A pasted blob is a link, a link plus words, or just words. Nothing is invented or dropped: the words stay as typed. */
export function splitClipboard(raw: string): { url: string | null; text: string } {
  const text = raw.replace(/\r\n/g, "\n").trim().slice(0, 20_000);
  const m = text.match(URL_IN_TEXT);
  if (!m) return { url: null, text };
  const rest = text.replace(m[0], "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { url: m[0].slice(0, 2000), text: rest };
}

export type ClipboardResult = { ok: true; text: string } | { ok: false; message: string };

export async function readClipboard(nav: Pick<Navigator, "clipboard"> = navigator): Promise<ClipboardResult> {
  if (!nav.clipboard?.readText) return { ok: false, message: "This browser can't read the clipboard. Press and hold in the box and choose Paste." };
  try {
    const text = await nav.clipboard.readText();
    if (!text.trim()) return { ok: false, message: "The clipboard is empty." };
    return { ok: true, text };
  } catch {
    return { ok: false, message: "Couldn't read the clipboard. Press and hold in the box and choose Paste." };
  }
}
