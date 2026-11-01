import { INTENT_LABEL, type ContentType, type DateMention, type Entity, type Evidence, type ExtractionOutput, type IntentGuess, type IntentKind, type JobDetails, type NextAction } from "../schema";
import type { ActionPlan, AnswerOutput, IntentClassification } from "./outputs";
import type { AiProvider, AnswerInput, ClassifyInput, ExtractInput, MemoryDigest, PlanInput } from "./provider";
import { walledNote, walledPlatform } from "../platforms";
import { sampleForBytes } from "./samples";

// Deterministic heuristic extractor for demo mode. No network, no model.
// ponytail: keyword + regex heuristics; ceiling is anything needing real reading comprehension — that's what meta mode is for.

// Order is the tie-break: an earlier type wins a tie. "event" sits above "job" so "shared an event" beats a stray "role".
const KEYWORDS: Record<Exclude<ContentType, "note" | "other">, RegExp[]> = {
  job: [/\bwe(?:'re| are) hiring\b/i, /\bhiring\b/i, /\brole\b/i, /\bapply\b/i, /\brequirements\b/i, /\byears? of experience\b/i, /\bposition\b/i, /\bresponsibilities\b/i, /\bfull[- ]time\b/i, /\bsalary\b/i, /\bqualifications\b/i, /\bjob\b/i],
  recipe: [/\bingredients\b/i, /\brecipe\b/i, /\bcook(?:ing)?\b/i, /\bbake\b/i, /\b\d+\s*(?:minutes|mins?)\b/i, /\b(?:tbsp|tsp|tablespoons?|teaspoons?|cups?)\b/i, /\boven\b/i, /\bsimmer\b/i, /\bpreheat\b/i, /\bserves \d+/i],
  technical: [/\bindex(?:es)?\b/i, /\bquery\b/i, /\bpostgres(?:ql)?\b/i, /\bsql\b/i, /\blatency\b/i, /\bdatabase\b/i, /\bapi\b/i, /\bcache\b/i, /\bkubernetes\b/i, /\bdocker\b/i, /\bstack trace\b/i, /\bmigration\b/i, /\bb-?tree\b/i, /\bthroughput\b/i, /\bp9[59]\b/i, /\btypescript\b/i, /\bexplain analyze\b/i, /\bredis\b/i],
  person: [/\breconnect\b/i, /\bcatch up with\b/i, /\bcoffee with\b/i, /\breach out to\b/i, /\bfollow up with\b/i, /\bintro(?:duce|duction)?\b/i, /\bmet [A-Z][a-z]+/, /\blinkedin\b/i],
  deadline: [/\bdeadline\b/i, /\bdue\b/i, /\bsubmit\b/i, /\bexpires?\b/i, /\brenew\b/i, /\bappointment\b/i, /\bremind me\b/i],
  idea: [/\bidea\b/i, /\b(?:product|app|business|startup) idea\b/i, /\bwhat if\b/i, /\bwe could build\b/i, /\bside project\b/i, /\bstartup\b/i, /\bbrainstorm\b/i],
  event: [/\bmeetup\b/i, /\bconference\b/i, /\bwebinar\b/i, /\bworkshop\b/i, /\bhackathon\b/i, /\bsummit\b/i, /\brsvp\b/i, /\bshared an event\b/i, /\bjoin us\b/i, /\bseminar\b/i, /\bpanel\b/i],
  product: [/\badd to cart\b/i, /\bbuy now\b/i, /\bin stock\b/i, /\bfree shipping\b/i, /\b\d+% off\b/i, /\bdiscount\b/i, /\bprice\b/i, /\bwishlist\b/i],
  article: [/\bread later\b/i, /\barticle\b/i, /\bblog\b/i, /\bpaper\b/i, /\bnewsletter\b/i, /\bessay\b/i, /\babstract\b/i, /\bconclusion\b/i, /\bet al\b/i],
};

const TECH = ["postgres", "postgresql", "mysql", "sqlite", "redis", "kafka", "kubernetes", "docker", "react", "next.js", "typescript", "python", "rust", "go", "java", "aws", "gcp", "graphql", "sql", "node.js", "pytorch", "b-tree", "gin", "brin"];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DEADLINE_CUE = /\b(deadline|due|by|before|until|closes?|closing|apply by|submit|expires?|no later than|last day)\b/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** Evidence must stay verbatim, so cut without adding an ellipsis. */
const quote = (s: string) => s.slice(0, 500);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function validDate(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m, d);
  return date.getMonth() === m && date.getDate() === d ? date : null;
}

/** No year given: pick the occurrence closest to `now` (handles "Jan 5" saved in December). */
function nearestYear(m: number, d: number, now: Date): Date | null {
  const candidates = [-1, 0, 1].map((dy) => validDate(now.getFullYear() + dy, m, d)).filter((x): x is Date => !!x);
  return candidates.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0] ?? null;
}

type Found = { date: Date; match: string; relative: boolean };

function findDatesInLine(line: string, now: Date): Found[] {
  const out: Found[] = [];
  const push = (date: Date | null, match: string, relative = false) => date && out.push({ date, match, relative });
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(validDate(+m[1], +m[2] - 1, +m[3]), m[0]);
  for (const m of line.matchAll(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,? (\\d{4}))?`, "gi"))) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    push(m[3] ? validDate(+m[3], mo, +m[2]) : nearestYear(mo, +m[2], now), m[0]);
  }
  for (const m of line.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}(?:,? (\\d{4}))?\\b`, "gi"))) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    push(m[3] ? validDate(+m[3], mo, +m[1]) : nearestYear(mo, +m[1], now), m[0]);
  }
  // a line with an explicit date ("Saturday, 14 November 2026") must not also yield a guessed weekday
  if (out.length) return out;
  for (const m of line.matchAll(/\b(today|tonight|tomorrow)\b/gi)) push(addDays(now, m[1].toLowerCase() === "tomorrow" ? 1 : 0), m[0], true);
  for (const m of line.matchAll(/\bnext week\b/gi)) push(addDays(now, 7), m[0], true);
  for (const m of line.matchAll(/\b(?:(next|this|by|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const delta = (WEEKDAYS.indexOf(m[2].toLowerCase()) - now.getDay() + 7) % 7;
    // "next Friday" = the coming Friday (never today); plain "Friday" on a Friday = today
    push(addDays(now, m[1]?.toLowerCase() === "next" ? delta || 7 : delta), m[0], true);
  }
  return out;
}

function extractDates(lines: string[], now: Date) {
  const dates: DateMention[] = [];
  const uncertainties: string[] = [];
  for (const line of lines) {
    for (const f of findDatesInLine(line, now)) {
      const date = iso(f.date);
      if (dates.some((d) => d.date === date)) continue;
      // judge each date by the words next to IT, not the whole line ("meetup Saturday 6 PM. RSVP by Friday" has one deadline)
      const at = line.indexOf(f.match);
      const near = at < 0 ? line : line.slice(Math.max(0, at - 30), at + f.match.length + 12);
      const isDeadline = DEADLINE_CUE.test(near);
      dates.push({ date, label: clip(isDeadline ? `Deadline (${f.match})` : f.match, 200), isDeadline, evidence: quote(line) });
      if (f.relative) uncertainties.push(`Relative date "${clip(f.match, 40)}" resolved to ${date} from the save date ${iso(now)}.`);
    }
  }
  return { dates: dates.slice(0, 10), uncertainties };
}

const isBullet = (l: string) => /^\s*(?:[-*•–]|\d+[.)])\s+/.test(l);
const unbullet = (l: string) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").trim();

/** Bullet lines under a header matching `header`, until the next non-bullet line. */
function section(lines: string[], header: RegExp): { header: string; items: string[] } | null {
  const i = lines.findIndex((l) => header.test(l) && !isBullet(l));
  if (i < 0) return null;
  const items: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!isBullet(l)) break;
    items.push(unbullet(l));
  }
  return items.length ? { header: lines[i], items } : null;
}

function firstMatch(text: string, res: RegExp[]): { value: string; line: string } | null {
  for (const re of res) {
    const m = text.match(re);
    if (m?.[1]) {
      const value = m[1].trim().replace(/[.,;:!]+$/, "").replace(/^(?:an?|the) /i, "");
      const line = text.split("\n").find((l) => l.includes(m[0].split("\n")[0])) ?? m[0];
      if (value) return { value: clip(value, 200), line: line.trim() };
    }
  }
  return null;
}

function extractJob(text: string, lines: string[], dates: DateMention[], url: string | undefined, ev: (q: string, s: string) => void): JobDetails {
  const NAME = "([A-Z][\\w&.'-]*(?: [A-Z][\\w&.'-]*){0,3})";
  const company = firstMatch(text, [
    /^\s*company:\s*(.+)$/im,
    /^\s*([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,3}) [—–] .+$/m, // "Northwind Labs — Senior Data Engineer"
    new RegExp(`${NAME} (?:is|are) hiring`),
    new RegExp(`\\b[Jj]oin ${NAME}(?= as |[\\s,.!)]|$)`),
    new RegExp(`\\b(?:at|@) ${NAME}(?=[\\s,.!)]|$)`),
  ]);
  const role = firstMatch(text, [
    /^\s*(?:role|position|title|job title):\s*(.+)$/im,
    /\bas an? ([A-Z][\w+#.-]*(?: [A-Z][\w+#.-]*){0,3})/,
    /\bhiring (?:an? |our first )?((?:senior |junior |staff |lead |principal )?[\w+#./ -]{2,60}?)(?= at | in | to |[,.!(\n]|$)/i,
    /\b((?:senior |junior |staff |lead |principal )?[A-Z]?[\w+#.-]*(?: [A-Z]?[\w+#.-]*)? (?:engineer|developer|designer|manager|scientist|analyst|researcher))\b/i,
  ]);
  const location = firstMatch(text, [/^\s*location:\s*(.+)$/im, /\b(remote(?:[- ]first| \([^)]+\))?)(?!\w)/i, /\bbased in ([A-Z][a-zA-Z]+(?:,? [A-Z][a-zA-Z]+)?)/, /\b(?:office|hybrid) in ([A-Z][a-zA-Z]+(?:,? [A-Z][a-zA-Z]+)?)/]);
  const reqSection = section(lines, /requirements|qualifications|must[- ]haves?|you have|looking for|what you'll need/i);
  const requirements = reqSection?.items ?? lines.filter((l) => /\d\+? years|experience (?:with|in)|proficien|familiar(?:ity)? with/i.test(l)).map(unbullet);
  const urls = text.match(URL_RE) ?? [];
  const applyUrl = urls.find((u) => /apply|careers|jobs|greenhouse|lever|workable|ashby/i.test(u)) ?? url ?? urls[0] ?? null;
  const deadline = dates.find((d) => d.isDeadline) ?? null;

  if (company) ev(company.line, "company");
  if (role) ev(role.line, "role");
  if (location) ev(location.line, "location");
  if (reqSection) ev(reqSection.header, "requirements");
  else if (requirements[0]) ev(requirements[0], "requirements");
  if (applyUrl && text.includes(applyUrl)) ev(applyUrl, "applyUrl");
  if (deadline) ev(deadline.evidence, "deadline");
  return {
    company: company?.value ?? null,
    role: role?.value ?? null,
    location: location?.value ?? null,
    requirements: requirements.slice(0, 30).map((r) => clip(r, 300)),
    applyUrl,
    deadline: deadline?.date ?? null,
  };
}

// Intent: what the user's OWN words say beats what the content type suggests. Neither is ever "confirmed" here.
const STATED_INTENT: [IntentKind, RegExp][] = [
  ["buy", /\b(?:buy|purchase|order|get myself|add to (?:my )?(?:cart|wishlist)|wishlist)\b/i],
  ["try", /\b(?:(?:want|wanna|going|gonna|plan|need|would like|hope) to try|let'?s try|try (?:it )?out|should try)\b/i],
  ["learn", /\b(?:(?:want|wanna|going|gonna|plan|need|would like|hope) to (?:learn|study|understand)|learn (?:more )?about|study up|read up on)\b/i],
  ["follow_up", /\b(?:(?:need|want|have|got|going|gonna|plan|remember|should|must|to|will|'ll) (?:to )?follow[\s-]?up|follow[\s-]?up (?:with|on|about|after|in|next|by|before)|circle back|check back|get back to (?:them|him|her|the|that)|hear back|revisit)\b/i],
  ["reconnect", /\b(?:reconnect|catch up with|reach out to|get back in touch|coffee with)\b/i],
  ["pursue", /\b(?:apply (?:for|to|by)|want to apply|going to apply|interested in (?:the |this )?(?:role|job|position|opportunity))\b/i],
  ["attend", /\b(?:(?:want|wanna|going|gonna|plan|need|would like|hope) to (?:attend|go to|join)|i(?:'ll| will) (?:be there|attend)|rsvp(?:'d| ed)?)\b/i],
  ["explore", /\b(?:(?:want|wanna|going|gonna|plan|need|would like|hope) to (?:explore|research|look into|investigate)|look into this|worth exploring)\b/i],
  ["do_later", /\b(?:later|someday|when i have time|remind me|read later|come back to)\b/i],
  ["reference", /\b(?:for reference|reference for|keep (?:this )?handy|bookmark(?:ed)? for)\b/i],
  ["remember", /\b(?:remember|don'?t forget|note to self|keep in mind)\b/i],
];
const TYPE_INTENT: Partial<Record<ContentType, [IntentKind, number, string]>> = {
  job: ["pursue", 0.55, "It's a job listing."],
  person: ["reconnect", 0.6, "It's about getting back in touch with someone."],
  recipe: ["try", 0.45, "Recipes are usually saved to cook later."],
  technical: ["learn", 0.4, "Technical content is usually saved to learn from."],
  article: ["do_later", 0.4, "Links are usually saved to read later."],
  idea: ["explore", 0.4, "Ideas are usually saved to research or revisit."],
  deadline: ["do_later", 0.4, "It has a date to act on."],
  event: ["attend", 0.5, "It's an event with a date."],
  product: ["buy", 0.45, "Product pages are usually saved to buy later."],
};
// A weaker second reading per type. Shown as "other possibilities", never as the user's intent.
const SECOND_INTENT: Partial<Record<ContentType, [IntentKind, number, string]>> = {
  job: ["reference", 0.3, "It could be saved as a reference for similar roles."],
  recipe: ["remember", 0.3, "It could be saved just to keep the recipe."],
  technical: ["reference", 0.35, "It could be saved as a technical reference."],
  event: ["remember", 0.3, "It could be saved just to remember the event exists."],
  person: ["remember", 0.25, "It could be saved just to remember who they are."],
  idea: ["reference", 0.3, "It could be saved as a reference for future work."],
  product: ["explore", 0.3, "It could be saved to compare options first."],
};

/** Strongest first. Stated (the user's own words) beats inferred (from the content type). */
function guessIntents(lines: string[], contentType: ContentType): IntentGuess[] {
  const out: IntentGuess[] = [];
  for (const [kind, re] of STATED_INTENT) {
    const line = lines.find((l) => re.test(l));
    if (line && !out.some((g) => g.kind === kind)) out.push({ kind, confidence: 0.8, basis: "stated", rationale: "Your own words say so.", quote: quote(line) });
  }
  for (const t of [TYPE_INTENT[contentType], SECOND_INTENT[contentType]]) {
    if (t && !out.some((g) => g.kind === t[0])) {
      out.push({ kind: t[0], confidence: t[1], basis: "inferred", rationale: `${t[2]} This is a guess from the content, not something you said.`, quote: null });
    }
  }
  return out.slice(0, 4);
}

/** What the demo may "read" from a file: only the known text of a built-in sample. Everything else is unreadable to it. */
type Known = { sampleId: string; pages: string[] } | null;

function extract(input: ExtractInput, known: Known = null): ExtractionOutput {
  const text = (input.text ?? "").trim();
  const isFile = input.kind === "image" || input.kind === "document";
  const fileName = isFile ? (input.originalName ?? input.document?.fileName ?? "") : "";
  // filename words count as (weak) signal for images: "job-posting_acme.png" → "job posting acme"
  const hay = [text, input.url ?? "", fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_.]+/g, " ")].join("\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  /** page number for a line, when the text came from a known multi-page sample */
  const pageOf = (line: string): number | null => {
    if (!known || input.kind !== "document") return null;
    const i = known.pages.findIndex((p) => p.split("\n").some((l) => l.trim() === line));
    return i >= 0 ? i + 1 : null;
  };
  const evidence: Evidence[] = [];
  const ev = (q: string, supports: string) => {
    if (q && evidence.length < 15 && !evidence.some((e) => e.quote === quote(q) && e.supports === supports)) evidence.push({ quote: quote(q), supports });
  };
  const uncertainties: string[] = [];

  // classify: most keyword hits wins; ties go to the earlier type in KEYWORDS
  let contentType: ContentType = input.kind === "url" ? "article" : isFile ? "other" : "note";
  let best: RegExp[] = [];
  for (const [type, res] of Object.entries(KEYWORDS) as [keyof typeof KEYWORDS, RegExp[]][]) {
    const hits = res.filter((re) => re.test(hay));
    if (hits.length > best.length) [contentType, best] = [type, hits];
  }
  const hitWords = best.map((re) => hay.match(re)![0].toLowerCase());
  const signal = best[0] ? (lines.find((l) => best[0].test(l)) ?? (input.url && best[0].test(input.url) ? input.url : fileName)) : "";
  if (signal) ev(signal, "contentType");

  const { dates, uncertainties: dateNotes } = extractDates(lines, input.now);
  uncertainties.push(...dateNotes);

  const entities: Entity[] = [];
  const addEntity = (name: string, kind: Entity["kind"]) => {
    const n = clip(name.trim(), 200);
    if (n && entities.length < 30 && !entities.some((e) => e.name.toLowerCase() === n.toLowerCase())) entities.push({ name: n, kind });
  };
  const lower = hay.toLowerCase();
  const tech = TECH.filter((t) => new RegExp(`(?:^|[^\\w.])${t.replace(/[.+]/g, "\\$&")}(?![\\w])`, "i").test(lower));
  tech.forEach((t) => addEntity(t, "technology"));

  let job: JobDetails | null = null;
  let ingItems: string[] = [];
  let venue: string | null = null;
  let titleCore = "";
  let intent: string | null = null;
  const nextActions: NextAction[] = [];
  let confidence = best.length >= 3 ? 0.8 : best.length === 2 ? 0.65 : best.length === 1 ? 0.5 : 0.35;

  switch (contentType) {
    case "job": {
      job = extractJob(text, lines, dates, input.url, ev);
      if (job.company) addEntity(job.company, "organization");
      if (job.location) addEntity(job.location, "place");
      for (const [k, label] of [["company", "Company"], ["role", "Role"], ["deadline", "Application deadline"]] as const) {
        if (!job[k]) {
          uncertainties.push(`${label} not found in the saved text.`);
          confidence -= 0.1;
        }
      }
      titleCore = job.role && job.company ? `${job.role} at ${job.company}` : (job.role ?? (job.company ? `Job at ${job.company}` : ""));
      intent = "Decide whether to apply for this role";
      nextActions.push({ kind: "apply", label: clip(`Apply${titleCore ? ` for ${titleCore}` : ""}${job.deadline ? ` by ${job.deadline}` : ""}`, 200) }, { kind: "review", label: "Compare with my CV" });
      break;
    }
    case "recipe": {
      const ing = section(lines, /ingredients/i);
      ing?.items.forEach((i) => addEntity(i.replace(/^[\d½¼¾/.,\s]+(?:g|kg|ml|l|tbsp|tsp|cups?|tablespoons?|teaspoons?|oz|lb|pinch of|cloves?)?\b\s*(?:of )?/i, ""), "ingredient"));
      if (ing) ev(ing.header, "ingredients");
      ingItems = ing?.items ?? [];
      const header = lines.findIndex((l) => /ingredients/i.test(l) && !isBullet(l));
      if (header > 0) titleCore = clip(lines[header - 1].replace(URL_RE, "").trim(), 80);
      const time = hay.match(/\b\d+\s*(?:minutes|mins?)\b/i);
      if (time) ev(lines.find((l) => l.includes(time[0])) ?? time[0], "cookingTime");
      intent = "Cook this later";
      nextActions.push({ kind: "cook", label: clip(`Cook ${lines[0] ?? "this recipe"}`, 200) });
      break;
    }
    case "technical":
      intent = "Understand and keep this as a technical reference";
      nextActions.push({ kind: "learn", label: clip(`Learn more about ${tech[0] ?? hitWords[0] ?? "this topic"}`, 200) });
      if (input.url) nextActions.push({ kind: "read", label: "Read the full page" });
      break;
    case "person": {
      // verbs in any case, but the name must be Capitalised ("reconnect with her" is not a name)
      const verbs = ["reconnect with", "catch up with", "coffee with", "reach out to", "follow up with", "intro to", "introduce me to", "met"].map((v) => `[${v[0].toUpperCase()}${v[0]}]${v.slice(1)}`);
      const who = firstMatch(text, [new RegExp(`\\b(?:${verbs.join("|")}) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)`)]);
      if (who) {
        addEntity(who.value, "person");
        ev(who.line, "person");
        titleCore = `Reconnect with ${who.value}`;
      } else uncertainties.push("Could not find who to reconnect with.");
      intent = who ? `Reconnect with ${who.value}` : "Reconnect with someone";
      nextActions.push({ kind: "reconnect", label: clip(intent, 200) });
      break;
    }
    case "deadline":
      intent = "Don't miss this deadline";
      if (!dates.length) uncertainties.push("Looks like a deadline, but no date was found.");
      break;
    case "idea":
      intent = "Revisit this idea";
      nextActions.push({ kind: "review", label: "Revisit this idea" });
      break;
    case "event": {
      const shared = text.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+) shared\b/m);
      if (shared) {
        addEntity(shared[1], "person");
        ev(lines.find((l) => l.startsWith(shared[1])) ?? shared[1], "sharedBy");
      }
      const titleLine = lines.find((l) => !/shared an event/i.test(l) && KEYWORDS.event.some((re) => re.test(l)));
      titleCore = titleLine ? clip(titleLine.replace(URL_RE, "").trim(), 80) : "";
      venue = lines.find((l) => /\b(hub|hall|centre|center|campus|caf[eé]|auditorium|office|hq|venue|stadium|library|theatre|theater)\b/i.test(l) && l !== titleLine) ?? null;
      if (venue) {
        addEntity(venue, "place");
        ev(venue, "venue");
      }
      if (!dates.length) uncertainties.push("No date was found for this event.");
      if (!shared) uncertainties.push("Who shared or organised this isn't stated.");
      intent = "Decide whether to attend";
      nextActions.push({ kind: "remind", label: "Decide whether to RSVP" });
      break;
    }
    case "product":
      intent = "Decide whether to buy this";
      nextActions.push({ kind: "review", label: "Compare options before buying" });
      break;
    case "article":
      intent = "Read this later";
      nextActions.push({ kind: "read", label: "Read this" });
      break;
  }
  const deadline = dates.find((d) => d.isDeadline);
  if (deadline && contentType !== "job") ev(deadline.evidence, "deadline");
  if (deadline && !nextActions.some((a) => a.kind === "remind")) nextActions.push({ kind: "remind", label: `Remind me before ${deadline.date}` });

  if (input.kind === "url") {
    ev(input.url ?? "", "url");
    const walled = walledPlatform(input.url);
    if (walled) {
      uncertainties.unshift(walledNote(walled));
      confidence = Math.min(confidence, 0.4);
    }
    if (!text) uncertainties.unshift("Demo mode does not fetch pages; extraction is based on the URL alone.");
    else if (!walled) uncertainties.unshift("Demo mode does not fetch pages; extraction is based on the link and your own text.");
  }
  if (isFile) {
    if (known) {
      uncertainties.unshift(`Demo mode recognised the built-in sample "${known.sampleId}" and used its known text. It cannot read any other ${input.kind === "image" ? "image" : "PDF"}.`);
      confidence = Math.min(confidence, 0.75);
    } else {
      uncertainties.unshift(
        input.kind === "image"
          ? "Demo mode cannot read image pixels; extraction based on caption/filename only."
          : "Demo mode cannot read PDF contents; extraction based on caption/filename only.",
      );
      confidence = Math.min(confidence, text ? 0.3 : 0.15);
    }
    if (fileName) ev(fileName, "fileName");
  }

  const firstLine = lines.find((l) => !/^https?:\/\/\S+$/.test(l))?.replace(URL_RE, "").trim();
  let host = "";
  try {
    if (input.url) host = new URL(input.url).hostname + new URL(input.url).pathname.replace(/\/$/, "");
  } catch {}
  const title = clip(titleCore || firstLine || host || (fileName && `${input.kind === "document" ? "Document" : "Image"}: ${fileName}`) || "Untitled note", 80);

  const TYPE_LABEL: Record<ContentType, string> = { job: "Job listing", recipe: "Recipe", technical: "Technical note", article: "Saved link", person: "Person to reconnect with", idea: "Idea", deadline: "Deadline", note: "Note", other: "Saved item", event: "Event", product: "Product" };
  const factLine =
    job ? [job.location && `Location: ${job.location}.`, job.requirements.length ? `${job.requirements.length} requirement(s) listed.` : "", job.deadline && `Apply by ${job.deadline}.`].filter(Boolean).join(" ") : "";
  const gist = clip(text.replace(/\s+/g, " "), 280);
  const summary = clip([`${TYPE_LABEL[contentType]}${titleCore ? `: ${titleCore}` : ""}.`, factLine, !job && gist && `“${gist}”`].filter(Boolean).join(" "), 1000);

  const topics = [...new Set([contentType, ...hitWords.filter((w) => !/\d/.test(w)), ...tech])]
    .filter((t) => t.length > 1)
    .map((t) => clip(t, 60))
    .slice(0, 12);

  // Facts: only what the text itself says, each with the line it came from. Nothing is listed without a quote.
  const facts: { statement: string; quote: string; page: number | null }[] = [];
  const fact = (statement: string, from: string) => {
    const q = from.trim();
    if (q && statement && facts.length < 20 && !facts.some((f) => f.statement === clip(statement, 300))) {
      facts.push({ statement: clip(statement, 300), quote: quote(q), page: pageOf(q) });
    }
  };
  const lineWith = (needle: string) => lines.find((l) => l.includes(needle)) ?? needle;
  const bare = (l: string) => unbullet(l).replace(/^\d+[.)]\s+/, "");
  if (job) {
    const e = (k: string) => evidence.find((x) => x.supports === k)?.quote;
    if (job.role && e("role")) fact(`Role: ${job.role}`, e("role")!);
    if (job.company && e("company")) fact(`Company: ${job.company}`, e("company")!);
    if (job.location && e("location")) fact(`Location: ${job.location}`, e("location")!);
    job.requirements.slice(0, 6).forEach((r) => fact(`Requirement: ${r}`, lineWith(r)));
  }
  ingItems.slice(0, 10).forEach((i) => fact(`Ingredient: ${i}`, lineWith(i)));
  if (contentType === "recipe") {
    const t = lines.find((l) => /\b\d+\s*(?:minutes|mins?)\b/i.test(l));
    if (t) fact(`Time: ${t.match(/\b\d+\s*(?:minutes|mins?)\b/i)![0]}`, t);
  }
  if (contentType === "event") {
    if (venue) fact(`Venue: ${venue}`, venue);
    if (titleCore) fact(`Event: ${titleCore}`, lineWith(titleCore.slice(0, 20)));
  }
  for (const d of dates.slice(0, 5)) fact(`${d.isDeadline ? "Deadline" : "Date"}: ${d.date} (${clip(d.label.replace(/^Deadline \((.*)\)$/, "$1"), 60)})`, d.evidence);
  if (contentType === "technical" || contentType === "article" || contentType === "idea" || contentType === "product") {
    const usable = (l: string) => !/^https?:\/\/\S+$/.test(l) && l.length > 12 && (contentType !== "technical" || best.some((re) => re.test(l)));
    if (known && input.kind === "document") {
      // a document: take a few lines from every page, so facts (and their page numbers) cover the whole file
      known.pages.forEach((p) =>
        p.split("\n").map((l) => l.trim()).filter(usable).slice(0, 3).forEach((l) => fact(bare(l), l)),
      );
    } else {
      lines.filter(usable).slice(0, contentType === "technical" ? 5 : 3).forEach((l) => fact(bare(l), l));
    }
  }

  const intents = isFile && !known && !text ? [] : guessIntents(lines, contentType);

  return {
    title,
    contentType,
    summary,
    entities,
    topics,
    intent,
    intentGuess: intents[0] ?? null,
    alternativeIntents: intents.slice(1, 4),
    facts,
    nextActions: nextActions.slice(0, 6),
    dates,
    confidence: Math.round(Math.max(0.05, Math.min(1, confidence)) * 100) / 100,
    uncertainties: uncertainties.map((u) => clip(u, 300)).slice(0, 10),
    evidence,
    job,
  };
}

/** Known text of a built-in sample, or null. The demo "reads" nothing else from files. */
function known(input: ExtractInput): Known {
  const bytes = input.image?.bytes ?? input.document?.bytes;
  const sample = bytes ? sampleForBytes(bytes) : null;
  return sample?.pages ? { sampleId: sample.id, pages: sample.pages } : null;
}

function extractMemory(input: ExtractInput) {
  const k = known(input);
  // the file's own text first (a title comes from the first line), then what the user typed alongside it
  const text = k ? [...k.pages, input.text].filter(Boolean).join("\n") : input.text;
  const data = extract({ ...input, text }, k);
  const note = k ? `Matched built-in sample "${k.sampleId}"; the demo does not read pixels or PDFs.` : undefined;
  return { data, note };
}

function classifyIntent(input: ClassifyInput) {
  const lines = input.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const candidates = guessIntents(lines, input.contentType).slice(0, 3);
  const data: IntentClassification = {
    candidates,
    question: candidates.length ? null : "What did you want to do with this?",
  };
  return { data };
}

const sentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).slice(0, 240);

function answerFromMemories(input: AnswerInput) {
  const q = input.question.toLowerCase();
  const none = (why: string): { data: AnswerOutput } => ({ data: { answer: why, citations: [], noReliableMatch: true } });
  const top = input.memories[0];
  if (!top) return none("I couldn't find a saved memory that matches that, so I won't guess.");

  const cite = (m: MemoryDigest, wanted?: (f: MemoryDigest["facts"][number]) => boolean) => {
    const f = m.facts.find((x) => x.quote && (!wanted || wanted(x)));
    if (f?.quote) return [{ memoryId: m.id, quote: f.quote }];
    const first = m.sourceText.split("\n").map((l) => l.trim()).find((l) => l.length > 8);
    return first ? [{ memoryId: m.id, quote: first.slice(0, 300) }] : [];
  };

  if (/\bingredients?\b/.test(q)) {
    const m = input.memories.find((x) => x.facts.some((f) => f.statement.startsWith("Ingredient:")));
    if (!m) return none("None of the memories I found list ingredients.");
    const items = m.facts.filter((f) => f.statement.startsWith("Ingredient:"));
    return {
      data: {
        answer: `${m.title} lists: ${items.map((f) => f.statement.replace("Ingredient: ", "")).join(", ")}.`,
        citations: items.slice(0, 3).map((f) => ({ memoryId: m.id, quote: f.quote! })),
        noReliableMatch: false,
      } satisfies AnswerOutput,
    };
  }
  if (/\b(want|wanted|plan|planned|intend|intended|meant)\b/.test(q)) {
    const c = cite(top);
    if (!c.length) return none("I found a memory but nothing in it I can quote.");
    return {
      data: {
        answer: top.userIntent
          ? `For “${top.title}”, you told Acorn you wanted to: ${INTENT_LABEL[top.userIntent].toLowerCase()}.`
          : `You haven't told Acorn why you saved “${top.title}”, so I can't say what you wanted. Open it to confirm or choose a reason.`,
        citations: c,
        noReliableMatch: false,
      } satisfies AnswerOutput,
    };
  }
  if (/\b(deadline|due|when|closes?|rsvp|date)\b/.test(q)) {
    const m = input.memories.find((x) => x.deadline || x.facts.some((f) => /^(Deadline|Date):/.test(f.statement)));
    if (m) {
      const f = m.facts.find((x) => /^(Deadline|Date):/.test(x.statement));
      const c = f?.quote ? [{ memoryId: m.id, quote: f.quote }] : cite(m);
      return {
        data: {
          answer: f ? `${m.title}: ${f.statement.replace(/^(Deadline|Date): /, "")}.` : `${m.title} has a deadline of ${m.deadline}.`,
          citations: c,
          noReliableMatch: !c.length,
        } satisfies AnswerOutput,
      };
    }
  }
  const c = cite(top);
  if (!c.length) return none("I found a memory that might match, but nothing in it I can quote, so I won't claim an answer.");
  const more = input.memories.length > 1 ? ` ${input.memories.length - 1} other saved item(s) matched less well.` : "";
  return {
    data: { answer: `Best match: “${top.title}”. ${sentence(top.summary)}${more}`, citations: c, noReliableMatch: false } satisfies AnswerOutput,
  };
}

function generateActionPlan(input: PlanInput) {
  const m = input.memory;
  const fq = (p: RegExp) => m.facts.find((f) => p.test(f.statement));
  const steps: ActionPlan["steps"] = [];
  const add = (label: string, kind: ActionPlan["steps"][number]["kind"], rationale: string) => steps.length < 6 && steps.push({ label: label.slice(0, 200), kind, rationale: rationale.slice(0, 300) });
  const dl = m.deadline;
  switch (m.contentType) {
    case "job":
      add("Check the requirements against your CV", "review", fq(/^Requirement:/)?.statement ?? "The listing has requirements to compare.");
      if (dl) add(`Apply by ${dl}`, "apply", `The listing's deadline is ${dl}.`);
      break;
    case "recipe":
      add("Check you have the ingredients", "review", fq(/^Ingredient:/)?.statement ?? "The recipe lists ingredients.");
      add(`Cook ${m.title}`, "cook", "Recipes are usually saved to cook.");
      break;
    case "event":
      if (dl) add(`RSVP by ${dl}`, "remind", `The post gives ${dl} as a date to act by.`);
      add("Put the event in your calendar if you're going", "remind", fq(/^Date:/)?.statement ?? "The event has a date.");
      break;
    case "technical":
      add(`Read more about ${m.entities[0] ?? "this topic"}`, "learn", fq(/./)?.statement ?? "It is technical reference material.");
      break;
    case "idea":
      add("Write down the first question to research", "review", fq(/./)?.statement ?? "It is an idea worth refining.");
      break;
    case "product":
      add("Compare prices before buying", "review", "It looks like a product listing.");
      break;
    default:
      add(m.sourceUrl ? "Open the link and read it" : "Review this memory", "read", "Nothing more specific is stated in it.");
  }
  if (dl && !steps.some((s) => s.kind === "remind" || s.kind === "apply")) add(`Remind me before ${dl}`, "remind", `It has a date: ${dl}.`);
  return { data: { steps } satisfies ActionPlan };
}

export const mockProvider: AiProvider = {
  name: "mock",
  model: "acorn-heuristics-v2",
  extractMemory: async (input) => extractMemory(input),
  classifyIntent: async (input) => classifyIntent(input),
  answerFromMemories: async (input) => answerFromMemories(input),
  generateActionPlan: async (input) => generateActionPlan(input),
};
