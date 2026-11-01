import { localDay } from "./home";
import type { Action, Db, ExtractionOutput, IntentGuess, Memory, Source } from "./schema";

// Sample data for first run. Dates are relative to `now` so the demo always looks fresh;
// ids are fixed so demo URLs are stable. Every evidence quote appears verbatim in source.text.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Unconfirmed guesses on a few samples, so the demo shows the "Acorn's guess" flow. Nothing is pre-confirmed.
const guess = (kind: IntentGuess["kind"], confidence: number, rationale: string): IntentGuess => ({ kind, confidence, basis: "inferred", rationale, quote: null });
const SAMPLE_GUESSES: Record<string, IntentGuess> = {
  "sample-job-lumen": guess("pursue", 0.55, "It's a job listing with an application deadline."),
  "sample-person-priya": guess("reconnect", 0.6, "The note is about getting back in touch with someone."),
  "sample-recipe-pasta": guess("try", 0.45, "Recipes are usually saved to cook later."),
  "sample-article-idempotency": guess("learn", 0.4, "A technical article, probably saved to read and learn from."),
};

export function buildSeed(now: Date): Db {
  const [y, mo, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const day = (n: number) => new Date(y, mo, d + n, 12);
  /** YYYY-MM-DD, n days from today */
  const iso = (n: number) => localDay(day(n));
  /** "Nov 2", n days from today — used inside source text so evidence stays verbatim */
  const say = (n: number) => `${MONTHS[day(n).getMonth()]} ${day(n).getDate()}`;
  /** timestamp `ago` days back at hh:mm, never in the future */
  const at = (ago: number, hh: number, mm = 0) => {
    const t = new Date(y, mo, d - ago, hh, mm);
    return (t > now ? now : t).toISOString();
  };

  const mem = (id: string, createdAt: string, source: Source, x: Omit<ExtractionOutput, "intentGuess" | "alternativeIntents" | "facts"> & Partial<Pick<ExtractionOutput, "facts" | "alternativeIntents">>): Memory => ({
    id,
    createdAt,
    updatedAt: createdAt,
    source,
    status: "ready",
    contentHash: `sample:${id}`,
    extraction: { ...x, intentGuess: SAMPLE_GUESSES[id] ?? null, alternativeIntents: x.alternativeIntents ?? [], facts: (x.facts ?? []).map((f) => ({ ...f, checked: true })), producedBy: { provider: "mock", model: "sample-fixture", at: createdAt } },
    overrides: {},
    isSample: true,
  });

  const lumenText = `Lumen Robotics — Frontend Engineer, Growth
Location: Bengaluru (hybrid) or Remote (India)
About the role: Own the signup and onboarding funnel for our warehouse-robot fleet dashboard. You'll run experiments, ship fast, and work directly with the founders.
Requirements:
- 3+ years building production React and TypeScript apps
- Experience running A/B tests and reading funnel metrics
- Comfort with Next.js, server rendering and web performance
- Nice to have: product analytics or growth engineering background
Applications close ${say(6)}. Apply at https://jobs.example.com/lumen/frontend-growth`;

  const fernwayText = `Fernway Health is hiring: Backend Engineer – Data Platform
Remote (India) or Bengaluru office
You'll build the pipelines that turn clinic records into clean, queryable data for care teams.
What we're looking for:
- 4+ years of backend experience in Python or Go
- Strong PostgreSQL skills: schema design, indexing, query tuning
- Experience with Kafka or another event streaming system
- Familiarity with data privacy rules for health data
Last date to apply: ${say(20)}
https://careers.example.org/fernway-health/backend-data-platform`;

  const pastaText = `Creamy lemon garlic pasta in 20 minutes (no cream!)
Ingredients: 200g spaghetti, 4 cloves garlic, 1 lemon (zest + juice), 2 tbsp butter, 1/2 cup parmesan, 1 cup pasta water, chilli flakes, parsley.
Method: Cook the pasta and save a cup of the starchy water. Sizzle garlic in butter, add lemon zest, then toss the pasta with parmesan and pasta water until glossy. Finish with lemon juice and chilli flakes.
Save this for a quick weeknight dinner! #pasta #weeknightdinner`;

  const oatsText = `Mom's masala oats (breakfast, 10 min)
1 cup rolled oats, 1 onion, 1 tomato, handful of peas, 1 green chilli, 1/2 tsp mustard seeds, pinch of turmeric, salt, 2 cups water.
Temper mustard seeds, saute onion + chilli, add tomato and peas, then turmeric and salt. Add oats and water, cook 3-4 min till thick. Lemon + coriander on top.
Make this on weekdays instead of skipping breakfast.`;

  const dbText = `Postgres query optimization — notes
1. Run EXPLAIN ANALYZE before adding any index; look for Seq Scan on big tables.
2. Composite index column order matters: CREATE INDEX ON orders (customer_id, created_at DESC); equality column first, then the range/sort column.
3. N+1 queries: 1 query for the list + 1 per row. Batch with WHERE id = ANY($1) or use a JOIN.
4. Watch "Rows Removed by Filter" — a high number means the index isn't selective.`;

  const articleText = `Designing APIs with idempotency keys
Networks fail after the server has already done the work. If a client retries a payment request, you must not charge twice.
The fix: the client sends an Idempotency-Key header with a unique value per logical operation. The server stores the key with the first response and returns that same response for any retry with the same key.
Store keys for at least 24 hours, scope them per user, and reject a reused key whose request body differs.`;

  const priyaText = `Priya Nair on LinkedIn:
Excited to share that I've joined Mossbank Labs as a founding engineer! We're building offline-first tools for rural clinics. If you're into React Native, sync engines or healthtech in India, my DMs are open. #newbeginnings #hiring

My note: Priya was my teammate at my last job. Reconnect and ask whether Mossbank is hiring frontend folks.`;

  const passportText = `Passport renewal: submit the online form and pay the fee by ${say(2)} or the appointment slot gets released.
Documents to upload: old passport (first + last page), address proof, recent photo.`;

  const ideaText = `idea: a tiny CLI that turns EXPLAIN ANALYZE output into plain-English advice ("add an index on orders.customer_id"). weekend project? or just a blog post. not sure yet`;

  const meetupText = `Bengaluru Frontend Meetup #42
Talk: "Caching in React Server Components, explained" by Arjun Mehta
${say(11)}, 10:30 AM, Indiranagar. Free entry, RSVP on the meetup page.
Covers: fetch caching, revalidation, and when a component should stay dynamic.`;

  const memories: Memory[] = [
    mem("sample-talk-rsc", at(0, 9, 5), { kind: "url", url: "https://meetup.example.com/blr-frontend/42", text: meetupText }, {
      title: "Talk: Caching in React Server Components",
      contentType: "article",
      summary: "Bengaluru Frontend Meetup #42 talk by Arjun Mehta on fetch caching, revalidation and dynamic rendering in React Server Components.",
      entities: [
        { name: "Bengaluru Frontend Meetup", kind: "organization" },
        { name: "Arjun Mehta", kind: "person" },
        { name: "React Server Components", kind: "technology" },
      ],
      topics: ["react server components", "caching", "meetup", "frontend"],
      intent: "Attend the talk to learn RSC caching",
      nextActions: [{ label: "RSVP on the meetup page", kind: "remind" }],
      dates: [{ date: iso(11), label: "Meetup talk", isDeadline: false, evidence: `${say(11)}, 10:30 AM, Indiranagar` }],
      confidence: 0.86,
      uncertainties: ["Exact venue address isn't in the text"],
      evidence: [
        { quote: `Talk: "Caching in React Server Components, explained" by Arjun Mehta`, supports: "title" },
        { quote: "Free entry, RSVP on the meetup page.", supports: "nextActions" },
      ],
      job: null,
    }),
    mem("sample-deadline-passport", at(1, 21, 40), { kind: "note", text: passportText }, {
      title: "Passport renewal form and fee",
      contentType: "deadline",
      summary: "Submit the passport renewal form and pay the fee before the appointment slot is released. Upload old passport pages, address proof and a photo.",
      entities: [],
      topics: ["passport", "renewal", "paperwork"],
      intent: "Finish the passport renewal before the slot lapses",
      nextActions: [{ label: "Submit the form and pay the fee", kind: "remind" }],
      dates: [{ date: iso(2), label: "Form + fee due", isDeadline: true, evidence: `pay the fee by ${say(2)}` }],
      confidence: 0.93,
      uncertainties: [],
      evidence: [
        { quote: `submit the online form and pay the fee by ${say(2)}`, supports: "deadline" },
        { quote: "old passport (first + last page), address proof, recent photo", supports: "summary" },
      ],
      job: null,
    }),
    mem(
      "sample-screenshot-db",
      at(2, 10, 14),
      { kind: "image", text: dbText, mimeType: "image/png", originalName: `Screenshot ${iso(-2)} at 10.14.32.png` },
      {
        title: "Postgres query optimization cheatsheet",
        contentType: "technical",
        summary: "Notes on speeding up Postgres: check plans with EXPLAIN ANALYZE, order composite index columns equality-first, and batch N+1 queries.",
        entities: [{ name: "PostgreSQL", kind: "technology" }],
        topics: ["database optimization", "postgres", "indexing", "n+1 queries"],
        intent: "Keep as a reference for query tuning",
        nextActions: [{ label: "Review before the next performance task", kind: "review" }],
        dates: [],
        confidence: 0.81,
        uncertainties: ["Text was read from a screenshot and may contain OCR errors"],
        evidence: [
          { quote: "Run EXPLAIN ANALYZE before adding any index", supports: "summary" },
          { quote: "CREATE INDEX ON orders (customer_id, created_at DESC)", supports: "topics" },
          { quote: "N+1 queries: 1 query for the list + 1 per row.", supports: "topics" },
        ],
        job: null,
      },
    ),
    mem("sample-idea-explain-cli", at(3, 23, 10), { kind: "note", text: ideaText }, {
      title: "Idea: EXPLAIN ANALYZE to plain English",
      contentType: "idea",
      summary: "A small CLI that reads Postgres EXPLAIN ANALYZE output and suggests fixes in plain English.",
      entities: [{ name: "PostgreSQL", kind: "technology" }],
      topics: ["side project", "developer tools", "postgres"],
      intent: null,
      nextActions: [{ label: "Decide: build it or write a blog post", kind: "other" }],
      dates: [],
      confidence: 0.45,
      uncertainties: ["Unclear whether you want to build this or write about it"],
      evidence: [
        { quote: "a tiny CLI that turns EXPLAIN ANALYZE output into plain-English advice", supports: "summary" },
        { quote: "weekend project? or just a blog post. not sure yet", supports: "uncertainties" },
      ],
      job: null,
    }),
    mem("sample-article-idempotency", at(4, 13, 30), { kind: "url", url: "https://engineering.example.com/posts/idempotency-keys", text: articleText }, {
      title: "Designing APIs with idempotency keys",
      contentType: "technical",
      summary: "Clients send an Idempotency-Key per logical operation; the server stores the first response and replays it on retries so payments never run twice.",
      entities: [],
      topics: ["api design", "idempotency", "payments", "distributed systems"],
      intent: "Use this pattern for retry-safe endpoints",
      nextActions: [{ label: "Read the full article", kind: "read" }],
      dates: [],
      confidence: 0.9,
      uncertainties: [],
      evidence: [
        { quote: "If a client retries a payment request, you must not charge twice.", supports: "summary" },
        { quote: "Store keys for at least 24 hours, scope them per user", supports: "summary" },
      ],
      job: null,
    }),
    mem("sample-job-lumen", at(5, 19, 45), { kind: "url", url: "https://jobs.example.com/lumen/frontend-growth", text: lumenText }, {
      title: "Frontend Engineer, Growth at Lumen Robotics",
      contentType: "job",
      summary: "Growth-focused frontend role owning signup and onboarding for a warehouse-robot fleet dashboard. React, TypeScript, Next.js and A/B testing.",
      entities: [
        { name: "Lumen Robotics", kind: "organization" },
        { name: "Bengaluru", kind: "place" },
        { name: "React", kind: "skill" },
        { name: "TypeScript", kind: "skill" },
      ],
      topics: ["frontend", "growth engineering", "react", "job search"],
      intent: "Apply before applications close",
      nextActions: [{ label: "Tailor resume and apply", kind: "apply" }],
      dates: [{ date: iso(6), label: "Applications close", isDeadline: true, evidence: `Applications close ${say(6)}.` }],
      confidence: 0.92,
      uncertainties: ["Salary range not mentioned"],
      evidence: [
        { quote: "Lumen Robotics — Frontend Engineer, Growth", supports: "role" },
        { quote: "Bengaluru (hybrid) or Remote (India)", supports: "location" },
        { quote: `Applications close ${say(6)}.`, supports: "deadline" },
        { quote: "https://jobs.example.com/lumen/frontend-growth", supports: "applyUrl" },
      ],
      job: {
        company: "Lumen Robotics",
        role: "Frontend Engineer, Growth",
        location: "Bengaluru (hybrid) or Remote (India)",
        requirements: [
          "3+ years building production React and TypeScript apps",
          "Experience running A/B tests and reading funnel metrics",
          "Comfort with Next.js, server rendering and web performance",
          "Nice to have: product analytics or growth engineering background",
        ],
        applyUrl: "https://jobs.example.com/lumen/frontend-growth",
        deadline: iso(6),
      },
    }),
    mem("sample-person-priya", at(6, 18, 0), { kind: "url", url: "https://www.linkedin.com/posts/priya-nair-example", text: priyaText }, {
      title: "Reconnect with Priya Nair (now at Mossbank Labs)",
      contentType: "person",
      summary: "Former teammate Priya Nair joined Mossbank Labs as a founding engineer, building offline-first tools for rural clinics.",
      entities: [
        { name: "Priya Nair", kind: "person" },
        { name: "Mossbank Labs", kind: "organization" },
        { name: "React Native", kind: "technology" },
      ],
      topics: ["networking", "healthtech", "startups"],
      intent: "Reconnect and ask whether Mossbank is hiring frontend folks",
      nextActions: [{ label: "Send Priya a congratulations note", kind: "reconnect" }],
      dates: [],
      confidence: 0.88,
      uncertainties: [],
      evidence: [
        { quote: "I've joined Mossbank Labs as a founding engineer", supports: "summary" },
        { quote: "Priya was my teammate at my last job", supports: "entities" },
        { quote: "Reconnect and ask whether Mossbank is hiring frontend folks.", supports: "intent" },
      ],
      job: null,
    }),
    mem("sample-recipe-pasta", at(8, 20, 15), { kind: "url", url: "https://www.instagram.com/p/EXAMPLE1/", text: pastaText }, {
      title: "Creamy lemon garlic pasta",
      contentType: "recipe",
      summary: "20-minute spaghetti with garlic butter, lemon zest, parmesan and starchy pasta water instead of cream.",
      entities: [
        { name: "spaghetti", kind: "ingredient" },
        { name: "garlic", kind: "ingredient" },
        { name: "lemon", kind: "ingredient" },
        { name: "parmesan", kind: "ingredient" },
      ],
      topics: ["pasta", "weeknight dinner", "vegetarian"],
      intent: "Cook for a quick weeknight dinner",
      nextActions: [{ label: "Add ingredients to the grocery list", kind: "cook" }],
      dates: [],
      confidence: 0.95,
      uncertainties: [],
      evidence: [
        { quote: "Creamy lemon garlic pasta in 20 minutes (no cream!)", supports: "title" },
        { quote: "200g spaghetti, 4 cloves garlic, 1 lemon (zest + juice)", supports: "entities" },
        { quote: "Save this for a quick weeknight dinner!", supports: "intent" },
      ],
      job: null,
    }),
    mem(
      "sample-job-fernway",
      at(12, 11, 20),
      { kind: "url", url: "https://careers.example.org/fernway-health/backend-data-platform", text: fernwayText },
      {
        title: "Backend Engineer – Data Platform at Fernway Health",
        contentType: "job",
        summary: "Remote-friendly backend role building clinic-data pipelines in Python or Go on PostgreSQL and Kafka.",
        entities: [
          { name: "Fernway Health", kind: "organization" },
          { name: "PostgreSQL", kind: "technology" },
          { name: "Kafka", kind: "technology" },
        ],
        topics: ["backend", "data platform", "healthtech", "job search"],
        intent: "Consider applying",
        nextActions: [{ label: "Apply before the last date", kind: "apply" }],
        dates: [{ date: iso(20), label: "Last date to apply", isDeadline: true, evidence: `Last date to apply: ${say(20)}` }],
        confidence: 0.9,
        uncertainties: ["Seniority level not stated"],
        evidence: [
          { quote: "Backend Engineer – Data Platform", supports: "role" },
          { quote: "Remote (India) or Bengaluru office", supports: "location" },
          { quote: `Last date to apply: ${say(20)}`, supports: "deadline" },
        ],
        job: {
          company: "Fernway Health",
          role: "Backend Engineer – Data Platform",
          location: "Remote (India) or Bengaluru",
          requirements: [
            "4+ years of backend experience in Python or Go",
            "Strong PostgreSQL skills: schema design, indexing, query tuning",
            "Experience with Kafka or another event streaming system",
            "Familiarity with data privacy rules for health data",
          ],
          applyUrl: "https://careers.example.org/fernway-health/backend-data-platform",
          deadline: iso(20),
        },
      },
    ),
    mem("sample-recipe-masala-oats", at(16, 8, 30), { kind: "note", text: oatsText }, {
      title: "Mom's masala oats",
      contentType: "recipe",
      summary: "Ten-minute savoury oats with onion, tomato, peas, mustard seeds and turmeric.",
      entities: [
        { name: "rolled oats", kind: "ingredient" },
        { name: "peas", kind: "ingredient" },
        { name: "tomato", kind: "ingredient" },
      ],
      topics: ["breakfast", "indian", "quick meals"],
      intent: "Make on weekdays instead of skipping breakfast",
      nextActions: [{ label: "Cook it this week", kind: "cook" }],
      dates: [],
      confidence: 0.91,
      uncertainties: [],
      evidence: [
        { quote: "1 cup rolled oats, 1 onion, 1 tomato, handful of peas", supports: "entities" },
        { quote: "Make this on weekdays instead of skipping breakfast.", supports: "intent" },
      ],
      job: null,
    }),
  ];

  const action = (a: Omit<Action, "createdAt" | "updatedAt">): Action => ({
    ...a,
    createdAt: a.history[0].at,
    updatedAt: a.history[a.history.length - 1].at,
  });

  const actions: Action[] = [
    action({
      id: "sample-action-lumen-apply",
      memoryId: "sample-job-lumen",
      title: "Tailor resume and apply to Lumen Robotics",
      detail: "Highlight React/TypeScript growth work and A/B testing; apply at https://jobs.example.com/lumen/frontend-growth.",
      kind: "suggested",
      state: "proposed",
      history: [{ state: "proposed", at: at(5, 19, 46) }],
    }),
    action({
      id: "sample-action-priya-message",
      memoryId: "sample-person-priya",
      title: "Draft a reconnect message to Priya",
      detail: "Congratulate her on Mossbank Labs and ask if they're hiring frontend engineers.",
      kind: "simulated",
      state: "in_progress",
      history: [
        { state: "proposed", at: at(6, 18, 1) },
        { state: "awaiting_approval", at: at(6, 18, 2) },
        { state: "approved", at: at(5, 9, 0) },
        { state: "in_progress", at: at(5, 9, 1), note: "Simulated: drafting a message. Nothing is sent." },
      ],
    }),
    action({
      id: "sample-action-pasta-grocery",
      memoryId: "sample-recipe-pasta",
      title: "Add pasta ingredients to grocery list",
      detail: "spaghetti, garlic, lemon, butter, parmesan, parsley",
      kind: "simulated",
      state: "completed",
      history: [
        { state: "proposed", at: at(8, 20, 16) },
        { state: "awaiting_approval", at: at(8, 20, 17) },
        { state: "approved", at: at(7, 10, 0) },
        { state: "in_progress", at: at(7, 10, 1) },
        { state: "completed", at: at(7, 10, 2), note: "Simulated (demo only): no real grocery list was changed." },
      ],
    }),
  ];

  return { version: 1, memories, actions, embeddings: [] };
}
