import type { Memory } from "./schema";
import { effective } from "./schema";

// What a visual aid may draw from: the memory's own title, summary and its extracted statements (each with the quote it
// rests on). Nothing else goes into the prompt, so the picture cannot contain facts the memory does not.

export type VisualAidSource = { title: string; summary: string; statements: string[] };

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Words a title must never be: they say nothing about the memory, and a picture titled with one looks broken. */
const PLACEHOLDER = /^\s*(untitled|untitled note|untitled memory|no title|note|notes|image|screenshot|document|memory|item|\(?none\)?|-+)\s*$/i;
export const isPlaceholderTitle = (t: string | null | undefined) => !t || !t.trim() || PLACEHOLDER.test(t.trim());

const fileTitle = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_.]+/g, " ").trim();
const urlTitle = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
};

/**
 * The real title of a memory, or null when it genuinely has none. In order: what the user set, what the reading found,
 * the first line of what they wrote, the link, the file name. A placeholder such as "Untitled" is never returned.
 */
export function memoryTitle(m: Memory): string | null {
  const firstLine = (m.source.text ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^[-•*]\s/.test(l));
  const candidates = [m.overrides.title, m.extraction?.title, firstLine && clip(firstLine, 80), m.source.url && urlTitle(m.source.url), m.source.originalName && fileTitle(m.source.originalName)];
  const found = candidates.find((c): c is string => typeof c === "string" && !isPlaceholderTitle(c));
  return found ? clip(found.trim(), 120) : null;
}

/**
 * What a visual aid may draw from: the memory's title, summary and statements (extracted facts, the user's own bullet
 * points, and the notes of a study pack made from the same facts). Nothing else goes into the prompt, so the picture
 * cannot contain facts the memory does not. Returns null when there is nothing real to draw from.
 */
export function visualAidSource(memory: Memory, extra: string[] = []): VisualAidSource | null {
  const v = effective(memory);
  const facts = (memory.extraction?.facts ?? []).map((f) => f.statement.trim()).filter((s) => s.length >= 8);
  // the user's own bullet points in a saved note are part of what they saved
  const bullets = (memory.source.text ?? "").split("\n").map((l) => l.trim()).filter((l) => /^[-•*]\s+/.test(l)).map((l) => l.replace(/^[-•*]\s+/, ""));
  const statements = [...facts, ...bullets, ...extra.map((s) => s.trim()).filter((s) => s.length >= 8)].map((s) => clip(s, 240));
  const unique = [...new Set(statements)].slice(0, 10);
  const summary = isPlaceholderTitle(v.summary) ? "" : v.summary;
  if (unique.length === 0 && !summary) return null;
  const title = memoryTitle(memory) ?? (summary ? clip(summary.split(/(?<=[.!?])\s/)[0], 100) : null);
  if (!title) return null;
  return { title, summary: clip(summary, 400), statements: unique };
}

export function visualAidPrompt(src: VisualAidSource): string {
  if (isPlaceholderTitle(src.title)) throw new Error("A visual aid needs the memory's real title.");
  if (src.statements.length === 0 && !src.summary) throw new Error("A visual aid needs saved content to draw from.");
  return [
    "Create ONE clear, labeled educational illustration that helps a learner revise the topic below.",
    "FACTS: use ONLY the numbered statements provided. Every label must repeat a statement or a very close paraphrase of it. Do not add facts, numbers, names, logos, examples, definitions or sources that are not in the statements. Do not explain beyond them.",
    "RELATIONSHIPS: do NOT draw arrows, connectors, flows, steps, hierarchies or cause-and-effect between items unless a statement explicitly says so. If no statement states a relationship, show the items as separate, equal, labelled cards in a neat grid.",
    `HEADING: use exactly this title as the only heading: "${src.title}". Do not invent section headings, captions or subtitles.`,
    "STYLE: plain light background, large readable text that fits inside its shape, no people, no decorative imagery, no logos.",
    src.summary ? `Summary (context only, do not draw it): ${src.summary}` : "",
    "Statements:",
    ...src.statements.map((s, i) => `${i + 1}. ${s}`),
  ]
    .filter(Boolean)
    .join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if ((cur + " " + w).trim().length > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = clip(lines[maxLines - 1] + "…", width);
  }
  return lines;
}

/** Demo mode: a labeled flow diagram drawn by Acorn itself from the same statements. Not a Muse Image result, and says so. */
export function mockDiagramSvg(src: VisualAidSource): string {
  const items = (src.statements.length ? src.statements : [src.summary]).slice(0, 6);
  const cols = 3;
  const w = 1200;
  const cellW = 340;
  const cellH = 150;
  const gap = 40;
  const rows = Math.ceil(items.length / cols);
  const height = 180 + rows * (cellH + gap) + 70;
  const boxes = items
    .map((s, i) => {
      const x = 60 + (i % cols) * (cellW + gap);
      const y = 150 + Math.floor(i / cols) * (cellH + gap);
      const lines = wrap(s, 30, 4);
      const text = lines.map((l, j) => `<text x="${x + 20}" y="${y + 58 + j * 26}" font-size="20" fill="#263a22">${esc(l)}</text>`).join("");
      return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="22" fill="#e4f0d0" stroke="#5f9340" stroke-width="2"/><circle cx="${x + 28}" cy="${y + 28}" r="16" fill="#5f9340"/><text x="${x + 28}" y="${y + 34}" font-size="18" text-anchor="middle" fill="#fff" font-weight="700">${i + 1}</text>${text}`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" font-family="Helvetica, Arial, sans-serif"><rect width="${w}" height="${height}" fill="#fbf6ea"/><text x="60" y="70" font-size="36" font-weight="700" fill="#3b6623">${esc(clip(src.title, 60))}</text><text x="60" y="108" font-size="18" fill="#4f6046">Separate points saved with this memory. No order or connection is implied.</text>${boxes}<text x="60" y="${height - 28}" font-size="16" fill="#667460">Demo diagram made by Acorn (not Muse Image). Not source evidence.</text></svg>`;
}
