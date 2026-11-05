import { deflateRawSync, deflateSync } from "node:zlib";

// Tiny builders for test files, so extraction is tested on files whose exact text is known.

function crc32(b: Buffer) {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function zip(files: Record<string, string | Buffer>, opts: { stored?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = opts.stored ? data : deflateRawSync(data);
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(opts.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    parts.push(local, nameB, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(opts.stored ? 0 : 8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A minimal .docx. A paragraph starting with "- " becomes a list item. */
export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => {
      const list = p.startsWith("- ");
      const text = list ? p.slice(2) : p;
      return `<w:p>${list ? "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>" : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    })
    .join("");
  return zip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

const pdfStr = (s: string) => `(${s.replace(/[\\()]/g, "\\$&")})`;

/** A minimal text PDF: one page, Helvetica (WinAnsi), Flate-compressed content. `lines` are shown top to bottom. */
export function pdf(lines: string[], opts: { compress?: boolean; encrypt?: boolean } = {}): Buffer {
  const content = `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `${pdfStr(l)} Tj T*`).join(" ")} ET`;
  const stream = opts.compress === false ? Buffer.from(content, "latin1") : deflateSync(Buffer.from(content, "latin1"));
  const filter = opts.compress === false ? "" : "/Filter /FlateDecode ";
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n5 0 obj\n<< ${filter}/Length ${stream.length} >>\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from(`\nendstream\nendobj\ntrailer\n<< /Root 1 0 R ${opts.encrypt ? "/Encrypt 9 0 R " : ""}>>\n%%EOF\n`, "latin1"),
  ]);
}

/** A PDF whose text is hex glyph ids that only its ToUnicode map can decode (what Word and Chrome produce). */
export function pdfWithToUnicode(lines: string[]): Buffer {
  const chars = [...new Set(lines.join(""))];
  const code = (c: string) => chars.indexOf(c) + 1;
  const hex = (s: string) => [...s].map((c) => code(c).toString(16).padStart(4, "0")).join("");
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chars.length} beginbfchar\n${chars.map((c) => `<${code(c).toString(16).padStart(4, "0")}> <${c.charCodeAt(0).toString(16).padStart(4, "0")}>`).join("\n")}\nendbfchar\nendcmap end end`;
  const content = `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `<${hex(l)}> Tj T*`).join(" ")} ET`;
  const cs = deflateSync(Buffer.from(content, "latin1"));
  const ms = deflateSync(Buffer.from(cmap, "latin1"));
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Sub /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>\nendobj\n7 0 obj\n<< /Type /Font /Subtype /CIDFontType2 >>\nendobj\n5 0 obj\n<< /Filter /FlateDecode /Length ${cs.length} >>\nstream\n`,
      "latin1",
    ),
    cs,
    Buffer.from(`\nendstream\nendobj\n6 0 obj\n<< /Filter /FlateDecode /Length ${ms.length} >>\nstream\n`, "latin1"),
    ms,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

/** A PDF with a page but no text at all (what a scan looks like). */
export const scannedPdf = () => pdf([]);
