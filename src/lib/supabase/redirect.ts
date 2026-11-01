/** Only same-site paths are valid post-login targets: blocks `//evil.com`, `https://evil.com`, `/\evil.com`. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
