// One-off generator for the demo sample files in public/samples (fictional content only).
// Needs `sharp`, which Next.js already installs. Re-run after editing src/lib/ai/samples.json:
//   node scripts/make-samples.mjs
// It also writes src/lib/ai/sample-hashes.json, which the mock provider uses to recognise these exact files.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const sharp = createRequire(import.meta.url)("sharp");
const samples = JSON.parse(readFileSync("src/lib/ai/samples.json", "utf8"));
mkdirSync("public/samples", { recursive: true });
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hashes = {};

async function png(s) {
  const lines = s.pages[0].split("\n");
  const W = 900;
  const H = 150 + lines.length * 44;
  const text = lines
    .map((l, i) => `<text x="40" y="${130 + i * 44}" font-family="Helvetica, Arial, sans-serif" font-size="${i === 0 ? 30 : 25}" font-weight="${i === 0 ? 700 : 400}" fill="#1b1b1f">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/><rect width="100%" height="64" fill="${s.style.bar}"/><text x="40" y="42" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">${esc(s.style.title)}</text>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function pdf(pages) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  add("<</Type/Catalog/Pages 2 0 R>>");
  add(`<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}]/Count ${pages.length}>>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((p, i) => {
    add(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`);
    const stream = "BT /F1 12 Tf 50 740 Td 16 TL " + p.split("\n").map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ") + " ET";
    add(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  });
  add("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((b, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

for (const s of samples) {
  if (s.kind !== "image" && s.kind !== "document") continue;
  const bytes = s.kind === "image" ? await png(s) : pdf(s.pages);
  writeFileSync(`public/samples/${s.fileName}`, bytes);
  hashes[s.id] = createHash("sha256").update(bytes).digest("hex");
  console.log(s.fileName, bytes.length, "bytes");
}
writeFileSync("src/lib/ai/sample-hashes.json", JSON.stringify(hashes, null, 2) + "\n");
