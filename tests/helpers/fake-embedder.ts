import type { EmbeddingProvider } from "@/lib/ai/embeddings";

// TEST-ONLY embedder. It is NOT a model and says nothing about real embedding quality: it maps words from a small
// hand-written concept lexicon onto concept axes, so "citrus" and "lemon" land near each other deterministically.
// Used so the retrieval, ranking and isolation logic can be tested without any network call or cost.

const CONCEPTS: Record<string, string> = {
  citrus: "citrus lemon lime orange zest",
  pasta: "pasta spaghetti noodles noodle",
  italian: "italian pasta spaghetti parmesan",
  food: "food dish recipe cook cooking dinner meal garlic ingredient ingredients parmesan lemon spaghetti",
  job: "job hiring role engineer apply applications",
  database: "database postgresql postgres sql kafka index indexes",
  event: "event meetup conference startup",
};
const AXES = Object.keys(CONCEPTS);
const WORDS = new Map<string, number[]>();
AXES.forEach((axis, i) => {
  for (const w of CONCEPTS[axis].split(" ")) WORDS.set(w, [...(WORDS.get(w) ?? []), i]);
});

// words outside the lexicon land on a few extra axes by hash, so no text maps to the zero vector (real models never
// return one) while unrelated texts stay far apart
const RESIDUAL = 512;
const bucket = (w: string) => [...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 99991, 7) % RESIDUAL;

export function conceptVector(text: string): number[] {
  const v = new Array<number>(AXES.length + RESIDUAL).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const hits = WORDS.get(w);
    if (hits) for (const i of hits) v[i] += 1;
    else v[AXES.length + bucket(w)] += 0.3;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function fakeEmbedder(model = "test-concepts-1"): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return { name: "test", model, calls, embed: async (texts) => (calls.push(texts), texts.map(conceptVector)) };
}
