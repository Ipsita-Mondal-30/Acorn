import { inflateRawSync, inflateSync } from "node:zlib";

// Text extraction for CV uploads with no extra dependency: PDF (text-based, via node:zlib), DOCX (a zip of XML) and
// plain text. It reads text that is really in the file. It does not OCR: a scanned PDF yields (almost) no text and the
// caller says so rather than guessing.

export type CvFileKind = "pdf" | "docx" | "txt";
export const CV_MIME: Record<CvFileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};
export const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_INFLATED = 20 * 1024 * 1024;

export class CvFileError extends Error {
  override name = "CvFileError";
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

// ───────────────────────── zip (just enough for DOCX) ─────────────────────────

type ZipEntry = { name: string; method: number; compSize: number; offset: number };

function zipEntries(b: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CvFileError("This isn't a valid .docx file.");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && n < 5_000; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const offset = b.readUInt32LE(p + 42);
    out.push({ name: b.toString("utf8", p + 46, p + 46 + nameLen), method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipRead(b: Buffer, e: ZipEntry): Buffer {
  if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) throw new CvFileError("This .docx file is damaged.");
  const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
  const data = b.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_INFLATED });
    } catch {
      throw new CvFileError("This .docx file is damaged or too large to read.");
    }
  }
  throw new CvFileError("This .docx file uses a compression Acorn can't read.");
}

export function isDocx(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
  try {
    return zipEntries(Buffer.from(bytes)).some((e) => e.name === "word/document.xml");
  } catch {
    return false;
  }
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[e.toLowerCase()] ?? m;
  });

export function extractDocx(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  const entry = zipEntries(b).find((e) => e.name === "word/document.xml");
  if (!entry) throw new CvFileError("This isn't a Word document (.docx).");
  const xml = zipRead(b, entry).toString("utf8");
  const lines: string[] = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const para = m[0];
    const listed = /<w:numPr>/.test(para);
    let text = "";
    for (const t of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g)) {
      text += t[0].startsWith("<w:tab") ? "\t" : t[0].startsWith("<w:br") || t[0].startsWith("<w:cr") ? "\n" : unxml(t[1] ?? "");
    }
    text = text.replace(/[ \t]+/g, " ").trim();
    if (text) lines.push(listed && !/^[-•*]/.test(text) ? `- ${text}` : text);
    else if (lines.at(-1) !== "") lines.push("");
  }
  return lines.join("\n");
}

// ───────────────────────── PDF ─────────────────────────

type Obj = { dict: string; stream?: Buffer };

function parseObjects(raw: Buffer): Map<number, Obj> {
  const s = raw.toString("latin1");
  const objs = new Map<number, Obj>();
  for (const m of s.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const num = Number(m[1]);
    const from = m.index! + m[0].length;
    const end = s.indexOf("endobj", from);
    const body = s.slice(from, end < 0 ? undefined : end);
    const sm = /stream\r?\n/.exec(body);
    let dict = body;
    let stream: Buffer | undefined;
    if (sm) {
      dict = body.slice(0, sm.index);
      const dataStart = from + sm.index + sm[0].length;
      let dataEnd = s.indexOf("endstream", dataStart);
      if (dataEnd < 0) dataEnd = end < 0 ? s.length : end;
      stream = raw.subarray(dataStart, dataEnd);
    }
    objs.set(num, { dict, stream });
  }
  return objs;
}

function decodeStream(o: Obj): Buffer | null {
  if (!o.stream) return null;
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict)?.[1] ?? "";
  if (!f) return o.stream;
  if (/ASCII85|LZW|DCT|JPX|CCITT|JBIG2|RunLength|Crypt/.test(f) || !/Flate/.test(f)) return null;
  try {
    return inflateSync(o.stream, { maxOutputLength: MAX_INFLATED, finishFlush: 2 /* Z_SYNC_FLUSH: tolerate a truncated tail */ });
  } catch {
    return null;
  }
}

/** Objects packed inside /Type /ObjStm streams (PDF 1.5+), added to the table as dictionary-only objects. */
function expandObjStreams(objs: Map<number, Obj>) {
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decodeStream(o);
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1]);
    if (!data || !n || !first) continue;
    const text = data.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = head[i * 2 + 1];
      const next = i + 1 < n ? head[(i + 1) * 2 + 1] : text.length - first;
      if (Number.isFinite(num) && Number.isFinite(off) && !objs.has(num)) objs.set(num, { dict: text.slice(first + off, first + next) });
    }
  }
}

type CMap = { map: Map<number, string>; twoByte: boolean };

function parseToUnicode(text: string): CMap {
  const map = new Map<number, string>();
  const hex = (h: string) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hex(m[2].padEnd(Math.ceil(m[2].length / 4) * 4, "0")));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 0xffff);
      if (m[3].startsWith("[")) {
        [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => map.set(lo + i, hex(d[1])));
      } else {
        const base = parseInt(m[3].slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(base + (c - lo)));
      }
    }
  }
  const codespace = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text)?.[1];
  return { map, twoByte: codespace ? codespace.length >= 4 : [...map.keys()].some((k) => k > 255) };
}

type Font = { cmap: CMap | null; type0: boolean; decoder: TextDecoder };

const decoderFor = (dict: string) => new TextDecoder(/MacRomanEncoding/.test(dict) ? "macintosh" : "windows-1252");
const refNum = (s: string | undefined) => (s ? Number(/(\d+)\s+\d+\s+R/.exec(s)?.[1]) : NaN);
const objOf = (objs: Map<number, Obj>, ref: string | undefined) => objs.get(refNum(ref));

function loadFont(objs: Map<number, Obj>, fontObj: Obj): Font {
  const tu = objOf(objs, /\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(fontObj.dict)?.[1]);
  const data = tu ? decodeStream(tu) : null;
  const type0 = /\/Subtype\s*\/Type0/.test(fontObj.dict);
  let dict = fontObj.dict;
  const desc = /\/DescendantFonts\s*\[?\s*(\d+\s+\d+\s+R)/.exec(dict)?.[1];
  if (desc) dict += objOf(objs, desc)?.dict ?? "";
  return { cmap: data ? parseToUnicode(data.toString("latin1")) : null, type0, decoder: decoderFor(dict) };
}

type Tok = { t: "num"; v: number } | { t: "name"; v: string } | { t: "str"; v: Buffer } | { t: "op"; v: string } | { t: "arr"; v: Tok[] };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[][] = [out];
  const push = (t: Tok) => stack[stack.length - 1].push(t);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (c === "%") i = s.indexOf("\n", i) < 0 ? s.length : s.indexOf("\n", i);
    else if (c === "(") {
      let depth = 1;
      const bytes: number[] = [];
      i++;
      while (i < s.length && depth > 0) {
        const ch = s[i];
        if (ch === "\\") {
          const n = s[i + 1];
          if (/[0-7]/.test(n)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))![0];
            bytes.push(parseInt(oct, 8) & 255);
            i += 1 + oct.length;
          } else {
            const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
            if (n === "\r" || n === "\n") i += n === "\r" && s[i + 2] === "\n" ? 3 : 2;
            else {
              bytes.push(map[n] ?? n.charCodeAt(0));
              i += 2;
            }
          }
        } else {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth > 0) bytes.push(ch.charCodeAt(0) & 255);
          i++;
        }
      }
      push({ t: "str", v: Buffer.from(bytes) });
    } else if (c === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      const h = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s+/g, "");
      push({ t: "str", v: Buffer.from(h.length % 2 ? `${h}0` : h, "hex") });
      i = end < 0 ? s.length : end + 1;
    } else if (c === "<" || c === ">") i += s[i + 1] === c ? 2 : 1;
    else if (c === "[") {
      const arr: Tok[] = [];
      push({ t: "arr", v: arr });
      stack.push(arr);
      i++;
    } else if (c === "]") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === "/") {
      const m = /^\/[^\s/<>[\]()%]*/.exec(s.slice(i))!;
      push({ t: "name", v: m[0].slice(1) });
      i += m[0].length;
    } else {
      const m = /^[^\s/<>[\]()%]+/.exec(s.slice(i));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const n = Number(m[0]);
      push(Number.isFinite(n) && /^[+-]?[\d.]+$/.test(m[0]) ? { t: "num", v: n } : { t: "op", v: m[0] });
    }
  }
  return out;
}

function showText(font: Font | undefined, bytes: Buffer): string {
  if (font?.cmap && font.cmap.map.size) {
    const step = font.cmap.twoByte ? 2 : 1;
    let s = "";
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = step === 2 ? bytes.readUInt16BE(i) : bytes[i];
      s += font.cmap.map.get(code) ?? "";
    }
    return s;
  }
  if (font?.type0) return ""; // composite font without a usable map: the codes are glyph ids, not text
  return (font?.decoder ?? new TextDecoder("windows-1252")).decode(bytes);
}

function pageText(content: string, fonts: Map<string, Font>): string {
  const toks = tokenize(content);
  let out = "";
  let font: Font | undefined;
  let y: number | null = null;
  const nl = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !/[\s]$/.test(out)) out += " ";
  };
  const args: Tok[] = [];
  const num = (k: number) => (args[k]?.t === "num" ? (args[k] as { v: number }).v : 0);
  for (const t of toks) {
    if (t.t !== "op") {
      args.push(t);
      continue;
    }
    switch (t.v) {
      case "BT":
      case "ET":
        nl();
        break;
      case "Tf":
        font = fonts.get((args[0] as { v: string })?.v);
        break;
      case "Td":
      case "TD":
        if (Math.abs(num(1)) > 0.5) nl();
        else if (num(0) > 0) space();
        break;
      case "Tm": {
        const ny = num(5);
        if (y !== null && Math.abs(ny - y) > 1) nl();
        else if (y !== null) space();
        y = ny;
        break;
      }
      case "T*":
        nl();
        break;
      case "Tj":
        if (args[0]?.t === "str") out += showText(font, args[0].v);
        break;
      case "'":
      case '"':
        nl();
        if (args.at(-1)?.t === "str") out += showText(font, (args.at(-1) as { v: Buffer }).v);
        break;
      case "TJ":
        if (args[0]?.t === "arr") {
          for (const e of args[0].v) {
            if (e.t === "str") out += showText(font, e.v);
            else if (e.t === "num" && e.v < -250) space();
          }
        }
        break;
    }
    args.length = 0;
  }
  return out;
}

export function extractPdf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  if (!latin1(bytes.subarray(0, 1024)).includes("%PDF-")) throw new CvFileError("This isn't a PDF.");
  const objs = parseObjects(raw);
  if (/\/Encrypt\b/.test(raw.toString("latin1", Math.max(0, raw.length - 4096)))) throw new CvFileError("This PDF is password-protected. Remove the protection or paste the text instead.");
  expandObjStreams(objs);

  const fontCache = new Map<number, Font>();
  const fontsFor = (resDict: string): Map<string, Font> => {
    const m = new Map<string, Font>();
    let fd = /\/Font\s*<<([\s\S]*?)>>/.exec(resDict)?.[1];
    if (!fd) {
      const o = objOf(objs, /\/Font\s+(\d+\s+\d+\s+R)/.exec(resDict)?.[1]);
      fd = o?.dict;
    }
    for (const f of (fd ?? "").matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const n = Number(f[2]);
      const fo = objs.get(n);
      if (!fo) continue;
      if (!fontCache.has(n)) fontCache.set(n, loadFont(objs, fo));
      m.set(f[1], fontCache.get(n)!);
    }
    return m;
  };

  const pages: number[] = [];
  const seen = new Set<number>();
  const walk = (n: number, depth = 0) => {
    const o = objs.get(n);
    if (!o || seen.has(n) || depth > 30) return;
    seen.add(n);
    if (/\/Type\s*\/Pages\b/.test(o.dict) || /\/Kids\s*\[/.test(o.dict)) {
      for (const k of /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1].matchAll(/(\d+)\s+\d+\s+R/g) ?? []) walk(Number(k[1]), depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);
  };
  const root = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  const rootPages = refNum(/\/Pages\s+(\d+\s+\d+\s+R)/.exec(root?.[1] !== undefined ? root[1] && objs.get(root[0])!.dict : "")?.[1]);
  if (Number.isFinite(rootPages)) walk(rootPages);
  if (pages.length === 0) for (const [n, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);

  const resourcesOf = (o: Obj, depth = 0): string => {
    const inline = /\/Resources\s*<<([\s\S]*?)>>\s*(?:\/|>>|$)/.exec(o.dict);
    const ref = /\/Resources\s+(\d+\s+\d+\s+R)/.exec(o.dict)?.[1];
    if (ref) return objOf(objs, ref)?.dict ?? "";
    if (inline) return o.dict.slice(o.dict.indexOf("/Resources"));
    const parent = objOf(objs, /\/Parent\s+(\d+\s+\d+\s+R)/.exec(o.dict)?.[1]);
    return parent && depth < 10 ? resourcesOf(parent, depth + 1) : "";
  };

  const texts: string[] = [];
  for (const n of pages) {
    const page = objs.get(n)!;
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(page.dict)?.[1] ?? "";
    const fonts = fontsFor(resourcesOf(page));
    let content = "";
    for (const r of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const d = objs.get(Number(r[1]));
      const data = d ? decodeStream(d) : null;
      if (data) content += `${data.toString("latin1")}\n`;
    }
    texts.push(pageText(content, fonts));
  }
  return texts.join("\n\n");
}

// ───────────────────────── entry points ─────────────────────────

export function sniffCv(bytes: Uint8Array): CvFileKind | null {
  if (bytes.byteLength === 0) return null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (isDocx(bytes)) return "docx";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return null; // some other zip / old .doc
  const head = Buffer.from(bytes.subarray(0, 4096));
  if (head.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "txt";
  } catch {
    return null;
  }
}

const clean = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Words that suggest the extraction produced readable text rather than garbage. */
export const looksReadable = (t: string) => {
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  return t.length >= 40 && letters / Math.max(1, t.replace(/\s/g, "").length) >= 0.6;
};

export type Extracted = { kind: CvFileKind; text: string; readable: boolean; warning: string | null };

export function extractCvText(bytes: Uint8Array): Extracted {
  const kind = sniffCv(bytes);
  if (!kind) throw new CvFileError("Upload a PDF, a Word document (.docx) or a plain-text file.");
  if (bytes.byteLength > MAX_CV_BYTES) throw new CvFileError("CV files must be 5 MB or smaller.");
  const raw = kind === "pdf" ? extractPdf(bytes) : kind === "docx" ? extractDocx(bytes) : new TextDecoder().decode(bytes);
  const text = clean(raw).slice(0, 60_000);
  const readable = looksReadable(text);
  return {
    kind,
    text,
    readable,
    warning: readable
      ? null
      : kind === "pdf"
        ? "Acorn found little or no readable text in this PDF. It may be a scan or use an unusual font. Upload a .docx, or paste the text instead."
        : "Acorn found very little text in this file.",
  };
}
