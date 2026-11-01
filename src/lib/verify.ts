import type { ExtractionOutput, Fact, IntentGuess } from "./schema";

// Schema validation only proves the SHAPE of model output. This proves the claims that can be checked:
// a quote must really appear in what the user saved, and "you said so" must really be in their words.

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").trim();

export type VerifyResult = {
  output: ExtractionOutput;
  /** facts with `checked` set: true = the quote was found in the text Acorn sent; false = read from pixels, not machine-checked */
  facts: Fact[];
  notes: string[];
};

export type VerifyContext = {
  /** every piece of text the extractor was given (note, fetched page, caption, URL, file name); null if none */
  text: string | null;
  /** an image or PDF was attached: the model may legitimately quote text we can't search, so nothing is dropped for being unfound */
  pixels: boolean;
  /** only the user's OWN words (note text, caption, text they pasted). "Stated intent" must come from these, never from a fetched page. */
  userText: string | null;
};

export function verifyExtraction(out: ExtractionOutput, ctx: VerifyContext): VerifyResult {
  const hay = norm(ctx.text ?? "");
  const mine = norm(ctx.userText ?? "");
  const found = (q: string) => norm(q) === "" || (ctx.text !== null && hay.includes(norm(q)));
  const foundInMine = (q: string) => norm(q) !== "" && mine.includes(norm(q));
  const notes: string[] = [];
  // a text-only source can be fully checked: unsupported claims are removed. A file can't, so they're only marked.
  const strict = !ctx.pixels;

  const evidence = strict ? out.evidence.filter((e) => found(e.quote)) : out.evidence;
  const droppedEvidence = out.evidence.length - evidence.length;
  if (droppedEvidence) notes.push(`${droppedEvidence} quote(s) the model gave could not be found in your saved text and were removed.`);

  // a fact with no support in the source is not a fact Acorn can stand behind
  const facts: Fact[] = (strict ? out.facts.filter((f) => found(f.quote)) : out.facts).map((f) => ({ ...f, checked: found(f.quote) && ctx.text !== null }));
  const droppedFacts = out.facts.length - facts.length;
  if (droppedFacts) notes.push(`${droppedFacts} fact(s) had no supporting quote in your saved text and were removed.`);
  const unchecked = facts.filter((f) => !f.checked).length;
  if (!strict && unchecked) notes.push(`${unchecked} fact(s) were read from the image or document itself, so their quotes could not be checked against text.`);

  let unverifiedDeadlines = 0;
  const dates = strict
    ? out.dates.map((d) => {
        if (found(d.evidence)) return d;
        unverifiedDeadlines += d.isDeadline ? 1 : 0;
        return { ...d, isDeadline: false, evidence: "" };
      })
    : out.dates;
  if (unverifiedDeadlines) notes.push(`${unverifiedDeadlines} deadline(s) had no supporting text in your item, so they were not treated as deadlines.`);

  let downgraded = 0;
  const checkIntent = (g: IntentGuess): IntentGuess => {
    if (g.basis === "stated" && !(g.quote && foundInMine(g.quote))) {
      // The model claimed the user said it; their own words don't. Downgrade, don't believe it.
      downgraded++;
      return { ...g, basis: "inferred", quote: null, confidence: Math.min(g.confidence, 0.5) };
    }
    return g.quote && !foundInMine(g.quote) ? { ...g, quote: null } : g;
  };
  const intentGuess = out.intentGuess ? checkIntent(out.intentGuess) : null;
  const alternativeIntents = out.alternativeIntents.map(checkIntent);
  if (downgraded) notes.push("The model said you stated your intent, but those words aren't in what you wrote, so it's shown as a guess.");

  let job = out.job;
  if (strict && job?.deadline && !dates.some((d) => d.isDeadline && d.date === job!.deadline)) {
    // a job deadline with no verified supporting mention is not a deadline we can stand behind
    job = { ...job, deadline: null };
    notes.push("The job deadline wasn't backed by text in your item, so it was left blank.");
  }

  return { output: { ...out, evidence, facts, dates, intentGuess, alternativeIntents, job }, facts, notes };
}
