import { z } from "zod";

// The study pack for a memory the user wants to LEARN from: a short session plan, revision notes, flashcards, practice
// questions and exercises. Everything is assembled from what the memory already holds (its facts with their quotes, its
// summary and entities). No model writes it, so it costs nothing and cannot invent a claim: a card is either a fact with
// one of its own words blanked out, or the fact itself. Progress (known / review, answered, done) is the only thing the
// user changes afterwards, and it never alters the content.

export const CardStatus = z.enum(["new", "known", "review"]);
export type CardStatus = z.infer<typeof CardStatus>;

export const StudyCard = z.object({
  id: z.string().max(12),
  front: z.string().max(600),
  back: z.string().max(600),
  /** the item's own words that the card rests on, when it rests on a quote */
  quote: z.string().max(500).nullable(),
  /** true: the front is a fact with one word blanked out and the back is that word */
  cloze: z.boolean(),
  status: CardStatus.default("new"),
});
export type StudyCard = z.infer<typeof StudyCard>;

export const StudyPack = z.object({
  title: z.string().max(200),
  sessions: z.array(z.object({ id: z.string().max(12), title: z.string().max(120), detail: z.string().max(400) })).min(1).max(8),
  notes: z.array(z.object({ id: z.string().max(12), text: z.string().max(600), quote: z.string().max(500).nullable() })).min(1).max(20),
  cards: z.array(StudyCard).min(1).max(20),
  questions: z.array(z.object({ id: z.string().max(12), text: z.string().max(700), answered: z.boolean().default(false) })).min(1).max(8),
  exercises: z.array(z.object({ id: z.string().max(12), text: z.string().max(500), done: z.boolean().default(false) })).min(1).max(5),
});
export type StudyPack = z.infer<typeof StudyPack>;

export const StudyInput = z
  .object({
    title: z.string(),
    summary: z.string(),
    facts: z.array(z.object({ statement: z.string(), quote: z.string().nullable() })),
    entities: z.array(z.object({ name: z.string(), kind: z.string() })).default([]),
    readableText: z.string().default(""),
  })
  .strict();
export type StudyInput = z.infer<typeof StudyInput>;

/** The only edits a user can make to a pack: progress. Keys are item ids. */
export const StudyProgress = z
  .object({
    cards: z.record(z.string().max(12), CardStatus).optional(),
    questions: z.record(z.string().max(12), z.boolean()).optional(),
    exercises: z.record(z.string().max(12), z.boolean()).optional(),
  })
  .strict();
export type StudyProgress = z.infer<typeof StudyProgress>;

const STOP = new Set(
  "about above after again also because before being between could during each other should their there these those through under which while would where when what that this with from have been into more most only over such than then they them very your will just like".split(" "),
);
const MAX_CARDS = 12;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const trimDot = (s: string) => s.trim().replace(/[.。]+$/, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const normalise = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** The word or phrase to blank out of a fact: a named thing first, then a number, then the longest plain word. */
export function pickBlank(statement: string, entities: { name: string }[]): string | null {
  const named = entities
    .map((e) => e.name)
    .filter((n) => n.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(statement))
    .sort((a, b) => b.length - a.length)[0];
  if (named) return statement.match(new RegExp(escapeRe(named), "i"))![0];
  const num = statement.match(/\b\d[\d,.]*\+?%?/);
  if (num && num.index !== 0) return num[0];
  const words = statement.match(/[\p{L}][\p{L}\p{N}'-]{6,}/gu)?.filter((w) => !STOP.has(w.toLowerCase())) ?? [];
  return words.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function blankOut(statement: string, term: string): string {
  return statement.replace(new RegExp(escapeRe(term), "i"), "_____");
}

export function buildStudyPack(input: StudyInput): StudyPack {
  const facts = input.facts.map((f) => ({ ...f, statement: f.statement.trim() })).filter((f) => f.statement.length >= 12).slice(0, MAX_CARDS);
  const summary = input.summary.trim();
  if (facts.length === 0 && !summary) throw new Error("There is nothing in this memory to study yet.");

  const notes = [
    ...(summary ? [{ text: summary, quote: null as string | null }] : []),
    ...facts.map((f) => ({ text: f.statement, quote: f.quote?.trim() || null })),
  ].map((n, i) => ({ id: `n${i + 1}`, text: clip(n.text, 600), quote: n.quote ? clip(n.quote, 500) : null }));

  const cards: StudyCard[] = [];
  const add = (c: Omit<StudyCard, "id" | "status">) => cards.push({ ...c, id: `c${cards.length + 1}`, status: "new" });
  if (summary) add({ front: `In a sentence or two: what is “${clip(input.title, 100)}” about?`, back: clip(summary, 600), quote: null, cloze: false });
  for (const f of facts) {
    if (cards.length >= MAX_CARDS) break;
    const term = pickBlank(f.statement, input.entities);
    const quote = f.quote?.trim() ? clip(f.quote.trim(), 500) : null;
    if (term) add({ front: clip(blankOut(f.statement, term), 600), back: term, quote, cloze: true });
    else add({ front: `Recall: ${clip(f.statement.split(/\s+/).slice(0, 5).join(" "), 80)}…`, back: clip(f.statement, 600), quote, cloze: false });
  }

  const questions = facts.slice(0, 4).map((f, i) => ({
    id: `q${i + 1}`,
    text: i % 2 === 0 ? `Explain in your own words: ${trimDot(f.statement)}.` : `Give an example, or a case where this would not hold: ${trimDot(f.statement)}.`,
    answered: false,
  }));
  questions.push({ id: `q${questions.length + 1}`, text: "What is still unclear after studying this? Write down one question to look up next.", answered: false });

  const tool = input.entities.find((e) => !["person", "organization", "place", "ingredient", "other"].includes(e.kind));
  const exercises = [
    { id: "e1", text: `Close the page and write down everything you remember about “${clip(input.title, 100)}”, then compare it with the notes.`, done: false },
    { id: "e2", text: "Teach it: explain the main idea to someone else, or to an empty room, in three sentences.", done: false },
    ...(tool ? [{ id: "e3", text: `Try it: build something very small with ${tool.name}, and note what behaved differently from what you expected.`, done: false }] : []),
  ];

  const sessions = [
    { id: "k1", title: "Skim", detail: "Read the summary and the notes once, without stopping." },
    { id: "k2", title: "Read the source", detail: "Open what you saved and read it with the practice questions in mind." },
    { id: "k3", title: "Flashcards", detail: `Go through the ${cards.length} cards and mark each one known or needs review.` },
    { id: "k4", title: "Practice questions", detail: "Answer them in your own words before you look at the notes." },
    { id: "k5", title: "Exercise", detail: "Do one exercise so the idea is used, not just read." },
    { id: "k6", title: "Revise", detail: "A day or two later, go through only the cards marked needs review." },
  ];

  return StudyPack.parse({ title: clip(input.title, 200), sessions, notes, cards, questions, exercises });
}

/** The pack with every progress field reset: two packs with the same content compare equal whatever the user has ticked. */
export const withoutProgress = (p: StudyPack): StudyPack => ({
  ...p,
  cards: p.cards.map((c) => ({ ...c, status: "new" as const })),
  questions: p.questions.map((q) => ({ ...q, answered: false })),
  exercises: p.exercises.map((e) => ({ ...e, done: false })),
});

export function applyProgress(pack: StudyPack, progress: StudyProgress): StudyPack {
  const has = (ids: string[], have: Set<string>) => ids.every((id) => have.has(id));
  if (!has(Object.keys(progress.cards ?? {}), new Set(pack.cards.map((c) => c.id)))) throw new Error("That card isn't part of this pack.");
  if (!has(Object.keys(progress.questions ?? {}), new Set(pack.questions.map((q) => q.id)))) throw new Error("That question isn't part of this pack.");
  if (!has(Object.keys(progress.exercises ?? {}), new Set(pack.exercises.map((e) => e.id)))) throw new Error("That exercise isn't part of this pack.");
  return {
    ...pack,
    cards: pack.cards.map((c) => (progress.cards?.[c.id] ? { ...c, status: progress.cards[c.id]! } : c)),
    questions: pack.questions.map((q) => (progress.questions?.[q.id] !== undefined ? { ...q, answered: progress.questions[q.id]! } : q)),
    exercises: pack.exercises.map((e) => (progress.exercises?.[e.id] !== undefined ? { ...e, done: progress.exercises[e.id]! } : e)),
  };
}

export function studyProgress(p: StudyPack) {
  const known = p.cards.filter((c) => c.status === "known").length;
  const review = p.cards.filter((c) => c.status === "review").length;
  const answered = p.questions.filter((q) => q.answered).length;
  const done = p.exercises.filter((e) => e.done).length;
  const total = p.cards.length + p.questions.length + p.exercises.length;
  const finished = known + answered + done;
  return { known, review, cards: p.cards.length, answered, questions: p.questions.length, done, exercises: p.exercises.length, percent: total ? Math.round((finished / total) * 100) : 0 };
}
