import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Message is safe to show the user. */
export class UrlError extends Error {
  name = "UrlError";
}

export function parseSafeUrl(raw: string): URL {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new UrlError("Enter a URL.");
  if (s.length > 2000) throw new UrlError("URLs must be 2000 characters or fewer.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UrlError("That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UrlError("Only http:// and https:// URLs are supported.");
  if (u.username || u.password) throw new UrlError("URLs with embedded credentials are not allowed.");
  return u;
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Expand any IPv6 form (incl. "::" and trailing dotted IPv4) to 8 numbers. */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

function privateV6(ip: string): boolean {
  const g = v6Groups(ip);
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embeddedV4()); // v4-mapped / v4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embeddedV4()); // NAT64
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00; // ULA, link-local, multicast
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? privateV4(ip) : v === 6 ? privateV6(ip) : true;
}

/** Throws UrlError unless every address the host resolves to is public. */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const blocked = new UrlError("That address points to a private or local network, which Acorn won't fetch.");
  if (!host || host === "localhost" || /\.(localhost|local|internal)$/.test(host)) throw blocked;
  if (isIP(host)) {
    if (isPrivateIp(host)) throw blocked;
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlError("Couldn't resolve that host name.");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw blocked;
}

const MAX_HOPS = 3;
const MAX_BYTES = 1024 * 1024;

export type FetchedPage = {
  /** the URL after redirects */
  finalUrl: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** readable text, capped */
  text: string;
  /** the response was longer than Acorn reads (1 MB) */
  truncated: boolean;
};

/** Fetch a public page as plain text. Meta mode only — demo mode never fetches. */
export async function fetchPublicPage(input: URL | string): Promise<string> {
  return (await fetchPage(input)).text;
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** `<title>` and the usual description / Open Graph tags. Attribute order and quote style vary, so match loosely. */
export function pageMeta(html: string): { title: string | null; description: string | null; siteName: string | null } {
  const meta = (names: string[]) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const key = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
      const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
      if (key && val && names.includes(key)) return decode(val).slice(0, 500) || null;
    }
    return null;
  };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: meta(["og:title", "twitter:title"]) ?? (title ? decode(title.replace(/\s+/g, " ")).slice(0, 300) || null : null),
    description: meta(["og:description", "description", "twitter:description"]),
    siteName: meta(["og:site_name"]),
  };
}

export async function fetchPage(input: URL | string): Promise<FetchedPage> {
  // ponytail: DNS is checked then fetch resolves again (rebinding window). Pin the IP via a custom undici dispatcher if this ever fetches attacker-chosen hosts at scale.
  let url = parseSafeUrl(String(input));
  const signal = AbortSignal.timeout(8_000);
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url);
      const res = await fetch(url, { redirect: "manual", signal, headers: { accept: "text/html,text/plain;q=0.9" } });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= MAX_HOPS) throw new UrlError("The page redirected too many times.");
        url = parseSafeUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new UrlError(`The page returned HTTP ${res.status}.`);
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "text/html" && type !== "text/plain") {
        await res.body?.cancel();
        throw new UrlError("The page isn't HTML or plain text.");
      }
      const { text: raw, truncated } = await readCapped(res);
      const meta = type === "text/html" ? pageMeta(raw) : { title: null, description: null, siteName: null };
      return { finalUrl: url.toString(), ...meta, text: type === "text/html" ? htmlToText(raw) : raw.trim(), truncated };
    }
  } catch (e) {
    if (e instanceof UrlError) throw e;
    if (e instanceof Error && e.name === "TimeoutError") throw new UrlError("The page took too long to load.");
    throw new UrlError("Couldn't fetch the page.");
  }
}

/** Read at most MAX_BYTES of the body; anything beyond is dropped. */
async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BYTES) {
      truncated = true;
      break;
    }
  }
  await reader.cancel().catch(() => {});
  return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES)), truncated };
}

// ponytail: regex tag stripping — fine for feeding a model, not a real HTML parser (no readability scoring).
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
