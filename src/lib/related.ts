import { effective, type ContentType, type Memory } from "./schema";

export type Related = { memory: Memory; score: number; reasons: string[] };

// Connections start simple and inspectable: shared entities, shared topics and a shared source site. No graph, no
// embeddings. Every link says why it exists, so the user can judge it. A single weak overlap is not a connection.

const GENERIC_TOPICS = new Set<string>(["job", "recipe", "technical", "article", "person", "idea", "deadline", "event", "product", "note", "other"] satisfies ContentType[]);
const host = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
// Different spellings of the same thing: "PostgreSQL" and "Postgres" are one technology.
const ALIASES: Record<string, string> = { postgresql: "postgres", "node.js": "node", nodejs: "node", "next.js": "nextjs", golang: "go", k8s: "kubernetes" };
const key = (s: string) => {
  const k = s.trim().toLowerCase();
  return ALIASES[k] ?? k;
};

export function relatedMemories(target: Memory, all: Memory[], limit = 5): Related[] {
  const tEntities = new Map((target.extraction?.entities ?? []).map((e) => [key(e.name), e.name]));
  const tTopics = new Map((target.extraction?.topics ?? []).filter((t) => !GENERIC_TOPICS.has(key(t))).map((t) => [key(t), t]));
  const tHost = host(target.source.url);

  const out: Related[] = [];
  for (const m of all) {
    if (m.id === target.id) continue;
    const reasons: string[] = [];
    let score = 0;
    for (const e of m.extraction?.entities ?? []) {
      const shared = tEntities.get(key(e.name));
      if (shared) {
        reasons.push(`Both mention “${shared}”`);
        score += 3;
      }
    }
    const topics = (m.extraction?.topics ?? []).filter((t) => tTopics.has(key(t)));
    for (const t of topics) {
      reasons.push(`Same topic: ${tTopics.get(key(t))}`);
      score += 1;
    }
    const h = host(m.source.url);
    if (h && h === tHost) {
      reasons.push(`Both saved from ${h}`);
      score += 1;
    }
    if (score >= 2 && effective(m).contentType === effective(target).contentType) score += 0.5;
    // one shared topic or one shared site on its own is too weak to call a connection
    if (score >= 2) out.push({ memory: m, score, reasons: [...new Set(reasons)].slice(0, 4) });
  }
  return out.sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt)).slice(0, limit);
}
