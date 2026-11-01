import { daysAgo } from "./home";
import { effective, INTENT_LABEL, type IntentKind, type Memory } from "./schema";

export type SearchHit = {
  memory: Memory;
  score: number;
  reasons: string[];
  /** how many of the query's content words (not type/intent/time words) this memory actually contains */
  termsMatched: number;
  termsTotal: number;
  /** cosine similarity to the query when semantic search saw this memory (hybrid ranking), else undefined */
  semantic?: number;
};

// ponytail: local keyword scoring (field weights + light stemming + prefix match), O(memories × terms).
// Embedding similarity (opts.semantic) is blended in when an embedding provider is configured; see lib/indexing.ts.

const STOPWORDS = new Set(
  `a an the i me my mine we us our you your it its this that these those is am are was were be been
  do does did done doing have has had to of in on at for from with about into by and or but not
  find show get give see look looking search searching remember recall where which what whats who how
  when why saved save bookmarked kept stored want wanted wanting need plan planned going can could would
  should please some any all one ones thing things stuff item items there here again back up just
  mentioned mention mentions resource resources`.split(/\s+/),
);

type Hint = { label: string; test: (m: Memory) => boolean };
const ofType = (t: string) => (m: Memory) => effective(m).contentType === t;
const HINTS: Record<string, Hint> = {};
const hint = (words: string, h: Hint) => words.split(" ").forEach((w) => (HINTS[w] = h));
hint("recipe recipes cook cooking dish dishes meal meals", { label: "It's a recipe", test: ofType("recipe") });
hint("job jobs role roles listing listings opening openings position positions vacancy", {
  label: "It's a job listing",
  test: ofType("job"),
});
hint("screenshot screenshots image images photo photos pic pics picture pictures", {
  label: "Screenshot",
  test: (m) => m.source.kind === "image",
});
hint("article articles link links", { label: "Saved from a link", test: (m) => m.source.kind === "url" });
hint("person people reconnect contact", { label: "About a person", test: ofType("person") });
hint("event events meetup meetups conference webinar workshop", { label: "It's an event", test: ofType("event") });
hint("product products", { label: "It's a product", test: ofType("product") });
hint("technical tech", { label: "It's technical", test: ofType("technical") });
hint("pdf pdfs document documents paper papers", { label: "It's a document", test: (m) => m.source.kind === "document" });
hint("deadline deadlines due close closes closing expires expiry", {
  label: "Has a deadline",
  test: (m) => effective(m).contentType === "deadline" || effective(m).deadline !== null,
});

// Words that ask about WHY something was saved. A match on what the user confirmed counts for much more than
// on Acorn's unconfirmed guess, and the reason shown says which it was.
const INTENT_WORDS: Record<string, IntentKind> = {};
const intentWords = (words: string, kind: IntentKind) => words.split(" ").forEach((w) => (INTENT_WORDS[w] = kind));
intentWords("buy buying purchase purchasing shop shopping wishlist", "buy");
intentWords("learn learning study studying", "learn");
intentWords("try trying tried experiment", "try");
intentWords("reconnect reconnecting", "reconnect");
intentWords("pursue apply applying opportunity opportunities", "pursue");
intentWords("later someday eventually", "do_later");
intentWords("attend attending rsvp", "attend");
intentWords("explore exploring research researching", "explore");
intentWords("reference references", "reference");
intentWords("followup revisit", "follow_up");
const CONFIRMED_INTENT_SCORE = 6;
const GUESSED_INTENT_SCORE = 1.5;

/** Time phrases: `filter` excludes outside [min,max] days ago; otherwise it's a boost. */
const TIMES: { re: RegExp; label: string; min: number; max: number; filter: boolean }[] = [
  { re: /\btoday\b/, label: "today", min: 0, max: 0, filter: true },
  { re: /\byesterday\b/, label: "yesterday", min: 1, max: 1, filter: true },
  { re: /\bthis week\b/, label: "this week", min: 0, max: 6, filter: true },
  // ponytail: rolling window instead of calendar weeks, so "last week" works the same any weekday
  { re: /\b(?:last|past) week\b/, label: "last week", min: 1, max: 10, filter: true },
  { re: /\b(?:last|past|this) month\b/, label: "last month", min: 0, max: 31, filter: true },
  { re: /\b(?:recent|recently|latest|newest)\b/, label: "recent", min: 0, max: 7, filter: false },
];

const SYNONYMS: Record<string, string[]> = {
  db: ["database"],
  postgres: ["database", "postgresql"],
  postgresql: ["postgres", "database"],
  sql: ["database"],
  optimisation: ["optimization"],
};

function stem(w: string) {
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  return w;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((w) => w.length > 1);

type Field = { key: string; weight: number; texts: string[] };

function fields(m: Memory): Field[] {
  const x = m.extraction;
  const v = effective(m);
  return [
    { key: "title", weight: 5, texts: [v.title] },
    { key: "topic", weight: 4, texts: x?.topics ?? [] },
    { key: "entity", weight: 4, texts: x?.entities.map((e) => e.name) ?? [] },
    { key: "fact", weight: 3, texts: v.facts.map((f) => f.statement) },
    // the words the item itself uses, kept for facts read out of an image or PDF (which have no saved text of their own)
    { key: "quote", weight: 1, texts: v.facts.map((f) => f.quote ?? "") },
    { key: "summary", weight: 2, texts: [v.summary] },
    { key: "intent", weight: 2, texts: [v.intent ?? ""] },
    { key: "requirement", weight: 1, texts: x?.job?.requirements ?? [] },
    { key: "source", weight: 1, texts: [m.source.text ?? "", m.source.originalName ?? ""] },
    { key: "link", weight: 1, texts: [m.source.url ?? ""] },
  ];
}

/** 1 exact stem, 0.7 prefix (≥4 chars), 0.5 synonym, 0 none. */
function quality(term: string, tokens: string[]) {
  if (tokens.includes(term)) return 1;
  if (term.length >= 4 && tokens.some((t) => t.startsWith(term))) return 0.7;
  if (SYNONYMS[term]?.some((s) => tokens.includes(stem(s)))) return 0.5;
  return 0;
}

const EDITABLE: Record<string, "title" | "summary" | "intent"> = { title: "title", summary: "summary", intent: "intent" };

function fieldReason(key: string, terms: string[], text: string) {
  const q = terms.map((t) => `"${t}"`).join(" and ");
  switch (key) {
    case "title": return `Title mentions ${q}`;
    case "topic": return `Topic: ${text}`;
    case "entity": return `Mentions ${text}`;
    case "fact": return `A fact mentions ${q}`;
    case "quote": return `The item's own words mention ${q}`;
    case "summary": return `Summary mentions ${q}`;
    case "intent": return `Your plan mentions ${q}`;
    case "requirement": return `Requirement mentions ${q}`;
    case "link": return `Link contains ${q}`;
    default: return `Saved text mentions ${q}`;
  }
}

export type SearchOptions = {
  /** Database full-text ranks (memory id -> rank) from the store. Adds candidates and weight; never replaces the explanation. */
  fts?: Map<string, number>;
  /** Embedding similarity (memory id -> cosine, already thresholded). Adds candidates and weight; keywords still explain. */
  semantic?: Map<string, number>;
  /** What a perfect (1.0) semantic match adds. Default 10; configurable (SEARCH_SEMANTIC_WEIGHT). */
  semanticWeight?: number;
  /** Multiplies everything that isn't semantic. Default 1 (SEARCH_KEYWORD_WEIGHT). */
  keywordWeight?: number;
};

/** Default semantic weight. A strong keyword title hit is worth about 5–6, so a close meaning match ranks alongside one. */
const SEMANTIC_WEIGHT = 10;

export function searchMemories(memories: Memory[], query: string, now: Date, opts: SearchOptions = {}): SearchHit[] {
  let q = query.toLowerCase();
  const asksPlan = /\b(?:want|wanted|plan|planned|meant|intend|intended)\b/.test(q);
  const time = TIMES.find((t) => t.re.test(q));
  for (const t of TIMES) q = q.replace(new RegExp(t.re.source, "g"), " ");

  const hints: Hint[] = [];
  const intents: IntentKind[] = [];
  const terms: { raw: string; stem: string }[] = [];
  for (const w of words(q)) {
    if (STOPWORDS.has(w)) continue;
    const h = HINTS[w];
    const wanted = INTENT_WORDS[w];
    if (wanted && !intents.includes(wanted)) intents.push(wanted);
    if (h) {
      if (!hints.includes(h)) hints.push(h);
    } else if (wanted) {
      // intent words ("buy", "learn") ask about why it was saved; they are not text to match
    } else if (!terms.some((t) => t.raw === w)) terms.push({ raw: w, stem: stem(w) });
  }
  if (!terms.length && !hints.length && !intents.length && !time) return [];

  const hits: SearchHit[] = [];
  for (const memory of memories) {
    const ago = daysAgo(memory.createdAt, now);
    const inWindow = !!time && ago >= time.min && ago <= time.max;
    if (time?.filter && !inWindow) continue;

    const fs = fields(memory).map((f) => ({ ...f, tokens: f.texts.map((t) => words(t).map(stem)) }));
    let score = 0;
    // field key + matched text -> query words, to group reasons like `Title mentions "a" and "b"`
    const matched = new Map<string, { key: string; text: string; terms: string[] }>();
    for (const term of terms) {
      let best: { w: number; key: string; text: string } | null = null;
      for (const f of fs) {
        for (let i = 0; i < f.tokens.length; i++) {
          const w = f.weight * quality(term.stem, f.tokens[i]);
          if (w > (best?.w ?? 0)) best = { w, key: f.key, text: f.texts[i] };
        }
      }
      if (!best) continue;
      const { w, key, text } = best;
      score += w;
      const id = `${key}\u0000${key === "topic" || key === "entity" ? text : ""}`;
      const entry = matched.get(id) ?? { key, text, terms: [] };
      entry.terms.push(term.raw);
      matched.set(id, entry);
    }

    const hintHits = hints.filter((h) => h.test(memory));
    score += hintHits.length * 3;
    const v = effective(memory);
    // intent: confirmed beats guessed; a user who dismissed the guess (or chose another intent) is never matched on it
    const intentReasons: string[] = [];
    for (const kind of intents) {
      if (v.intentKind === kind) {
        score += CONFIRMED_INTENT_SCORE;
        intentReasons.push(`You marked it: ${INTENT_LABEL[kind]}`);
      } else if (v.suggestedIntent?.kind === kind) {
        score += GUESSED_INTENT_SCORE;
        intentReasons.push(`Acorn's guess (not confirmed): ${INTENT_LABEL[kind]}`);
      }
    }
    if (inWindow && !time?.filter) score += 1;
    const ftsRank = opts.fts?.get(memory.id);
    const ftsHit = terms.length > 0 && ftsRank !== undefined;
    if (ftsHit) score += 2 + Math.min(ftsRank!, 2);

    const sim = opts.semantic?.get(memory.id);
    score *= opts.keywordWeight ?? 1;
    if (sim !== undefined) score += sim * (opts.semanticWeight ?? SEMANTIC_WEIGHT);

    const intentOk = intentReasons.length > 0;
    const relevant = terms.length
      ? matched.size > 0 || hintHits.length > 0 || ftsHit || sim !== undefined // with other words in the query, intent only ranks, it doesn't qualify
      : hints.length || intents.length
        ? hintHits.length > 0 || intentOk
        : inWindow;
    if (!relevant) continue;

    const reasons = [
      ...[...matched.values()].map((e) => fieldReason(e.key, e.terms, e.text)),
      ...([...matched.values()].some((e) => EDITABLE[e.key] && v.edited.includes(EDITABLE[e.key])) ? ["Edited by you"] : []),
      ...intentReasons,
      ...(asksPlan && v.intent ? [v.edited.includes("intent") ? `Your plan: ${v.intent}` : `Acorn's reading of your intent: ${v.intent}`] : []),
      ...(sim !== undefined && matched.size === 0 ? ["Close in meaning to your search (no exact words needed)"] : []),
      ...(ftsHit && matched.size === 0 ? ["Matched by the database's full-text search of what it says"] : []),
      ...hintHits.map((h) => h.label),
      ...(inWindow ? [`Saved ${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`}${ago > 1 || time!.label === "recent" ? ` (${time!.label})` : ""}`] : []),
    ];
    const termsMatched = terms.filter((t) => [...matched.values()].some((e) => e.terms.includes(t.raw))).length;
    hits.push({ memory, score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)].slice(0, 4), termsMatched, termsTotal: terms.length, ...(sim !== undefined ? { semantic: sim } : {}) });
  }

  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.createdAt.localeCompare(a.memory.createdAt) ||
      a.memory.id.localeCompare(b.memory.id),
  );
}
