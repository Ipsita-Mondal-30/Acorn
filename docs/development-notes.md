# Acorn development notes

> These are the running notes kept while Acorn was built (they were the README until the hackathon submission).
> They hold the detailed Supabase setup, security model and phase-by-phase design. Some statuses here are older than
> the code: where they differ, the top-level [README](../README.md) is the current, verified description.

A personal multimodal memory and action agent.

**CAPTURE → UNDERSTAND → REMEMBER → DECIDE → ACT → VERIFY → FOLLOW THROUGH**

You save a note, a link, or a screenshot. Acorn pulls out a structured, evidence-backed understanding of it: the type, entities, intent, deadlines, and next actions. You can find it again with ordinary language and turn it into an action whose lifecycle is tracked. Acorn never claims an action happened without evidence.

## Quick start (demo mode: no keys, no network, no cost)

```bash
npm install
npm run dev          # http://localhost:3000
```

The first request seeds `.data/acorn.json` with sample memories, all labelled **Sample**. Run `npm run reset-demo` to wipe local data and start fresh.

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run check` | Run lint, typecheck, tests, and the production build |
| `npm test` | Run the Vitest unit and integration tests |
| `npm run reset-demo` | Delete `.data/` (memories, actions, uploads) |

## Modes

| | Demo (default) | Meta |
|---|---|---|
| `AI_PROVIDER` | `mock` | `meta` (also needs `AI_ENABLE_REAL_CALLS=true`) |
| Extraction | Deterministic heuristics (`src/lib/ai/mock.ts`) | `muse-spark-1.3` via `https://api.meta.ai/v1/chat/completions` with a JSON-schema response |
| Network | None | Meta API, plus guarded URL fetches |
| Cost | $0 | Capped by `ACORN_MAX_MODEL_CALLS` |

The current mode is always shown in the header. Mock extractions are labelled as such and are never presented as model output. If you set Meta mode without a key, processing fails with a clear message. It does not quietly fall back to the mock.

To use real models, copy `.env.example` to `.env.local`, set `AI_PROVIDER=meta`, `AI_ENABLE_REAL_CALLS=true` and `META_API_KEY`, and restart. With a key but `AI_ENABLE_REAL_CALLS` not `true`, nothing is sent and the header says "Meta mode — real calls off". **Live check (2026-10-31):** one text extraction through `muse-spark-1.3` worked end to end (request accepted, JSON-schema output valid, quotes verbatim, 1 attempt, 15.3 s, 3,426 tokens, about $0.009 at list price). A live image check on the job-listing sample screenshot also worked (all 9 fact quotes matched the text printed in the image, deadline 2027-01-15 correct, intent a modest inferred "pursue" with no invented quote; 9.2 s, 4,427 tokens, about $0.011). A live PDF check on the two-page sample paper also worked (`file` content block accepted, all 8 fact quotes found verbatim in the PDF text, authors and figures correct; 12.2 s, 8,289 tokens, about $0.015). The model returned no page numbers (`page` was null on every fact), so Acorn shows none for PDFs unless a model supplies them.

## Meta models: where each one fits

The details below are verified against https://dev.meta.ai/docs (Oct 2026). The API is OpenAI-compatible and authenticates with `Authorization: Bearer`.

| Model | API id | Role in Acorn | Status |
|---|---|---|---|
| Muse Spark | `muse-spark-1.3` | Multimodal extraction (text + screenshot → validated JSON) | Wired, awaiting credits |
| Muse Wonder | `muse-wonder-1.0` | Long agentic reasoning: job ↔ CV fit, application plan | Milestone 4 |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Voice notes and call transcripts (`/v1/asr/transcribe`, mono 16-bit WAV) | Milestone 5 |
| SAM 3.1 | `sam-3.1` | Segment the relevant region of a screenshot as visual evidence | Planned |
| Muse Image | `muse-image-1.0` | Optional visuals (e.g. a recipe card) | Optional |
| Muse Spark Open / Muse Glimmer | open weights, not on the API | Self-hosted experiments only | Not used |

The cheaper `-contributor` variants let Meta train on request data, so Acorn does not use them for private content.

## Storage: local demo or Supabase cloud

| | Local demo (default) | Cloud |
|---|---|---|
| Turned on by | no Supabase keys | `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Data | JSON file + uploads in `.data/` | Postgres tables + private Storage bucket |
| Accounts | none | email + password (Supabase Auth); every row belongs to a user |
| Header label | "Local demo storage" | "Cloud · you@example.com" or "Cloud · signed out" |

The two never mix: with Supabase configured, every page and API call needs a signed-in user, and there is no way to reach the local file from the browser. Set `ACORN_STORAGE=local` to force the demo store (for example to develop offline). Setting only one of the two Supabase values is an error, so a half-finished deploy can't quietly fall back to a shared local file.

### Set up Supabase

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Pick a region near you and save the database password.
2. **Copy the keys**: Project Settings → API. Put the Project URL and the `anon` (publishable) key in `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```
   The newer `sb_publishable_…` key also goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `DATABASE_URL` / `DIRECT_URL` are for applying migrations from your machine only; the running app never reads them, and a password containing `@ / ? # [ ]` must be percent-encoded. `SUPABASE_SERVICE_ROLE_KEY` is optional and never used by the running app (see Security below).
3. **Apply the migrations**, in filename order (`20261031000000_initial_schema.sql`, `20261031010000_multimodal_memory.sql`, `20261031020000_reminders.sql`, and for semantic search only `20261031030000_memory_embeddings.sql` then `20261101000000_pgvector_embeddings.sql`, and for plans/reminders/CV `20261102000000_agent_plans.sql`; see [docs/pgvector.md](docs/pgvector.md)). Either use the CLI, or paste each file into Dashboard → SQL editor and run it:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   The migrations create the tables (profiles, memories, actions with approval/verification evidence/history, tags, reminders with follow-up history), constraints, indexes, Row-Level Security policies, the atomic `claim_memory_processing` function **and the private `memory-images` bucket** with its policies (`supabase/migrations/`). Reminders are schema-only so far: the table, RLS and tests exist, but no screen creates them yet. Never change the schema by hand; add a new migration file instead.
4. **Check the bucket**: Dashboard → Storage → `memory-images` should exist, be **private**, private, 15 MB cap, images and PDFs only (the app enforces 8 MB for images). If you ever create it by hand, those are the settings.
5. **Configure Auth**: Authentication → Providers → Email is on by default.
   - Authentication → URL Configuration: set **Site URL** to where the app runs (`http://localhost:3000` for development) and add `http://localhost:3000/auth/callback` (and your deployed URL's `/auth/callback`) to **Redirect URLs**.
   - "Confirm email" is on by default: new users get a link they must open before signing in. Turn it off in Providers → Email for quick local testing.
6. **Verify**: `npm run supabase:check` validates every Supabase variable in `.env.local` (names and verdicts only, never values), checks the database host answers, and makes read-only anonymous requests to confirm each table exists, anonymous reads return nothing and the bucket is not public. It cannot sign in as a user, so also do step 7.
7. **Run**: `npm run dev`, open `/signup`, create an account, and the header will read "Cloud · your email".

### Security model

- **Row-Level Security is the access control**, not frontend filtering. Every user-owned table has RLS with policies for `auth.uid()`; the server queries as the signed-in user (anon key plus their session), so Postgres refuses anything that isn't theirs. `memory_tags` and `actions` use composite foreign keys, so a link or action can never point at another user's memory or tag, even for a privileged writer.
- **The service-role key is never used while serving requests** and is read only from a non-`NEXT_PUBLIC_` variable in a `server-only` module.
- **Files are private.** Uploads are checked by their bytes (PNG, JPEG, WebP, GIF, up to 8 MB), stored at `<user id>/<random>.<ext>`, and viewed through a 5-minute signed URL that is created only for the signed-in owner. The original link a user saved (`source_url`) is a separate column from the stored file (`storage_path`).
- **Deleting a memory** removes its actions and tag links (cascade) and its stored image.
- Sessions live in HTTP cookies refreshed by `src/proxy.ts`; the server verifies the token (`getClaims()`) on each request and RLS checks it again in the database.

### Tests without credentials

`npm test` needs no Supabase project. The migration is applied to an in-process Postgres (PGlite) with stand-ins for `auth.users`, `auth.uid()` and `storage.objects`, and the real store code runs against it as different users (`tests/rls.test.ts`, `tests/supabase-store.test.ts`, `tests/cloud.test.ts`). That proves the schema, RLS, constraints, triggers and store logic. It does **not** prove the connection to a real Supabase project, Supabase Auth, or the Storage service; do a manual run (sign up, capture a note and an image, sign out and back in, check the data is there) after setting up.

## Multimodal memory (phase 3)

Acorn reads what you save and turns it into a structured memory: a title, a category, a summary, **facts the item states (each with the words it rests on)**, dates and deadlines, people/places/things, a **guess** about why you saved it, and suggested next steps. The original (note text, link, image, PDF) is always kept as you saved it and never replaced by a summary.

| Input | What happens |
|---|---|
| Screenshot / photo | Stored privately, then sent (Meta mode) as an `image_url` part to the extraction model. Demo mode recognises only the built-in sample screenshots. |
| PDF | Stored privately, sent as a documented `file` part. Page numbers are kept on facts when the model reports one. A PDF over 50 pages gets a warning that the model only sees page images for the first 50 (and text for the first 100). Demo mode recognises only the built-in sample PDF. |
| Link | The link is validated and kept. In Meta mode a public page is fetched with an SSRF guard (private IPs, unsafe redirects, size and time caps) and its title, description and text are passed on. Sign-in-walled sites (Instagram, LinkedIn, Facebook, TikTok, X) are never fetched, and the memory says it only has the link and what you typed. Demo mode never fetches. |
| Note | Saved as written; the interpretation is stored separately. |

**Facts versus guesses.** A *fact* is something the content says, with a verbatim quote. A *candidate intent* is a guess, shown as "not confirmed", with its basis (your own words, or inferred) and other possibilities Acorn considered. Only what you confirm, correct or set becomes your intent. If nothing points to a purpose Acorn asks instead of guessing. For text sources (notes, fetched pages) a quote that isn't in your text is removed. For an image or PDF Acorn can't search the pixels, so facts are kept and marked "read from the file, not machine-checked". "You said so" only counts if it is in *your own words* (note, caption, text you pasted), never in a fetched page or text inside a screenshot. Confidence is a rough indication, not a calibrated probability.

**Intents.** remember, learn, try, buy, reconnect (CONNECT), pursue (APPLY), do later, attend, explore, reference, other. Several can be candidates at once.

**Search and answers.** Search combines keyword scoring (with the memory's facts and quoted words), type and time hints, and, in cloud mode, PostgreSQL full-text search (`search_memories_fts`, a GIN index over what each memory says). There is no semantic/embedding search: no embedding model has been verified, so no vector columns exist. "Answer from your memories" retrieves first, then lets the provider answer using only those memories, then checks every citation against the saved memory. Citations that aren't in it are dropped, and an answer left with none becomes "no reliable match". With nothing retrieved no model is called. A memory that fits only the *type* of your question ("technical") but none of its specific words ("Redis") is not treated as an answer.

**Connected memories** are inferred from shared entities, topics and source sites, never from similarity of meaning, and each link says why. One weak overlap isn't a link. A saved job and your CV can't be linked yet: CVs aren't a memory type.

### Meta models (checked against dev.meta.ai/docs on 2026-10-31)

| Model | What the docs say | Acorn |
|---|---|---|
| `muse-spark-1.3` | text, image, PDF, video (audio "not fully supported") in, text out; 1,048,576-token context; Responses, Chat Completions and Messages APIs; $1.25 in / $4.25 out per 1M tokens; 3,000 requests/min and 4M tokens/min per team | **Used** for extraction, intent, answers and plans through Chat Completions with a JSON-schema response |
| `muse-spark-1.3-contributor` | same inputs; $0.10 / $0.20 per 1M; 150 requests/min. The docs don't explain Contributor mode | Selectable with `META_EXTRACTION_MODEL`; not the default |
| `muse-wonder-1.0` | most capable, for complex software engineering and long-horizon agentic work (preview); $4 / $20 per 1M | Optional for action plans via `META_PLAN_MODEL`; not default (Spark covers these tasks) |
| `sam-3.1` | segmentation: boxes and masks for a prompted object; $2.50 per 1,000 images | **Not integrated.** No current feature needs a region cut out of an image |
| `muse-voice-transcribe-1.0` | speech to text only (no text-to-speech); mono 16-bit PCM WAV, 16/24 kHz, up to 10 min; $0.18/hour | Not integrated; planned for voice input |
| `muse-image-1.0` | image generation/editing; $0.01 per image | **Not integrated.** Nothing in Acorn needs a generated picture yet |
| Muse Spark Open, Muse Glimmer | open weights (816B MoE / 30B), self-hosted; not on the Model API | **Not integrated.** Needs your own GPUs and a serving stack; Glimmer (text + image) could be a local extraction option later |

Not stated in the docs, so not assumed: whether Muse Spark returns page references for PDFs, what Contributor mode is, any account-specific model availability (call `GET /v1/models` with your key to check). Token usage and an estimated list-price cost are recorded per extraction (ignoring cache discounts, so only ever an overestimate) and shown on the memory page.

**Configuration** (`.env.local`): `AI_PROVIDER=meta`, `AI_ENABLE_REAL_CALLS=true`, `META_API_KEY`, and optionally `META_PRIMARY_MODEL` (default `muse-spark-1.3`), `META_BASE_URL`, `META_REASONING_MODEL` + `META_REASONING_FOR_PLANS=true` (Wonder writes action plans), `META_IMAGE_MODEL` / `META_TRANSCRIPTION_MODEL` / `META_SEGMENTATION_MODEL` (configurable, not called yet). The older names `ACORN_MODE`, `META_API_BASE_URL`, `META_EXTRACTION_MODEL` still work; the new ones win when both are set, `META_REASONING_EFFORT` (default `low`; the docs say Muse Spark always reasons and rejects `none`), `META_TIMEOUT_MS`, `META_PLAN_MODEL`, `META_STRICT_SCHEMA`, `ACORN_MAX_MODEL_CALLS`, `META_API_BASE_URL`. Retries follow the documented rules: 429, 500 and 503 are retried up to 3 times with exponential backoff and jitter, honouring `Retry-After`; 400, 401, 402, 403, 404 and 413 are not retried; a 504 is not retried because the same request would likely time out again. Error messages shown to you never contain the API's own text, your content, or the key.

### Checking the configuration (free) and one manual request (paid)

`GET /api/health` reports the provider, whether a key is present (yes/no, never the value), whether real calls are enabled, the model for each capability, and this process's call count. It reads env only and never calls a model. In cloud mode it needs a signed-in user.

`npm run meta:check` sends exactly one real Muse Spark request (a short note, about 1 to 2 cents at most) and prints the model, latency, tokens and estimated cost. It refuses to run unless `AI_PROVIDER=meta`, `AI_ENABLE_REAL_CALLS=true` and `META_API_KEY` are all set in `.env.local`, and it caps itself at one call. It is not part of `npm test`.

### Evaluation

`npm run eval` (or `npx vitest run tests/eval.test.ts`) runs the labelled cases in `evals/dataset.json` through the real capture pipeline in demo mode and prints scores for classification, entities, deadlines, intent, quote preservation, retrieval and answers, with every miss listed. **These measure the demo heuristics on 18 cases that the heuristics were developed alongside, so they are not held-out and not a measure of any Meta model.** The assertions are regression floors, not accuracy claims. When credits exist, point the same dataset at Meta mode to get real numbers.

## Semantic (meaning-based) search

Search is **hybrid**: keyword matching (stemming, field weights, Postgres full-text) plus embedding similarity, blended
into one ranking. Semantic scores add candidates and weight; the reasons shown still say *why* each memory matched
("Close in meaning to your search" when no exact word did).

**Status: the code is complete, but semantic search is awaiting an embedding provider.** Meta's Model API
(dev.meta.ai/docs, checked 2026-10-31) documents no embeddings endpoint and no embedding model: only chat completions,
responses, messages, images, voice, files and models. Nothing is faked: with `EMBEDDING_PROVIDER=none` (default)
search is keyword-only and says so.

To enable it you must choose a provider that exposes an OpenAI-compatible `POST {base}/embeddings` and accept its price
(embeddings are billed per input token; a memory is ~100–1500 tokens, so indexing hundreds of memories is typically
cents, but check your provider's rate). Then set in `.env.local`:

```
EMBEDDING_PROVIDER=http
EMBEDDING_BASE_URL=https://<provider>/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=<model id>
EMBEDDING_DIMENSIONS=        # optional
AI_ENABLE_REAL_CALLS=true    # embeddings are paid calls, behind the same switch
```

Embeddings live in Supabase Postgres with **pgvector** (`20261031030000_memory_embeddings.sql` creates the table,
`20261101000000_pgvector_embeddings.sql` adds the `vector` column and the `match_memories` similarity function, both with
RLS and composite foreign keys). The vector dimension is deliberately not fixed until a model is chosen. Migration,
backfill (`POST /api/embeddings`, safe to repeat), verification, rollback, ranking settings and testing are in
[docs/pgvector.md](docs/pgvector.md). Failure to embed never fails a capture or a search.

Tests use a deterministic, clearly labelled concept embedder (`tests/helpers/fake-embedder.ts`); no network, no cost.
The pgvector SQL is tested against a real throwaway PostgreSQL (`tests/pgvector.integration.test.ts`; skipped, visibly, if PostgreSQL with pgvector isn't installed).
The HTTP provider itself has only been tested against a stubbed `fetch`, not a live service.

### Two-account isolation test
See [docs/two-user-isolation-test.md](docs/two-user-isolation-test.md).

## The agent: from a saved memory to an approved plan (phase 4)

Acorn's loop is capture → understand → remember → decide → act → verify → follow through. The "act" part is deliberately
small and honest: Acorn prepares things inside the app and never acts on the outside world.

- **Intent first.** Acorn only *suggests* why you saved something (labelled "not confirmed", with its evidence and confidence). A plan is made only after **you** confirm the intent.
- **Plans are data.** A typed `Plan` (goal, context, ordered steps, dependencies, permissions, expected outcome, verification, failure conditions) built from fixed templates over real data in the memory, validated before it is stored. No model writes steps or picks tools.
- **A controlled tool registry** (`src/lib/agent/tools.ts`): retrieve memory, search memories, read document, read CV, compare job to CV, extract recipe, build shopping list, draft resume, draft cover letter, draft email, create checklist, create reminder, update action status. Each has typed input and output, declared permissions, owner-scoped data access, and a separate `verify()` that re-checks the result.
- **No outside actions exist.** There is no tool or permission for sending, submitting, paying or contacting anyone. Steps like "apply on the employer's site" belong to you, and finish only when you record what happened.
- **Approval and verification.** Nothing runs until you approve the plan and its permission list. Each draft waits for your review (you can edit it; your changes are marked as yours). The plan's action goes through the existing state machine and can only be completed from verified evidence; the actions API refuses to move a plan's action by hand.
- **Workflows:** job application (compare requirements with your CV, tailored resume, cover letter, checklist, deadline reminder, your own "I applied" evidence), recipe (ingredients with parsed quantities, shopping list you can edit, optional cooking reminder; substitutions are labelled *inferred*), and a generic follow-through plan for the other intents (reconnect, attend, learn, buy, ...).
- **Honest by construction.** Resume and cover letter are built only from lines of **your** CV, copied unchanged; requirements your CV doesn't show become gaps and `[TO COMPLETE]` markers; "3+ years" claims are flagged for you to check. These drafts are deterministic (no model call, no cost).
- **Reminders** (`/reminders`): create, edit, complete, snooze, dismiss, reopen; linked to the memory and the action.

Needs migrations `20261102000000_agent_plans.sql`, `20261103000000_cv_documents.sql` and `20261103010000_follow_up_intent.sql`. Until they are applied the memory page still works; plans can't be made. Backup, apply, verify and rollback steps: [docs/phase4-migration.md](docs/phase4-migration.md).
Details and the guarantees are in [docs/agent.md](docs/agent.md).

### Phase 4.5: your CV, better matching, follow-ups
- **CV upload:** a PDF, Word (.docx) or text file, or pasted text. The original is kept as uploaded in private storage under your own folder; Acorn reads the text out of it (no OCR: a scanned PDF is refused with a clear message), then parses name and contact, roles with dates, projects, skills, education and certifications. Every parsed item points to its place in the text. Replacing a CV keeps the old version; "Read the original again" re-parses; "Remove" deletes every version and file.
- **Matching:** each job requirement becomes VERIFIED_MATCH, POTENTIAL_MATCH, UNVERIFIED or MISSING with the CV's exact words as evidence, an explanation, a rule-based confidence and whether you must confirm. Years need dates; a similar meaning (embeddings, optional, paid, needs your approval on the plan) can only ever be a potential match. Results: `npm run eval:agent` (see `evals/agent-results.md`).
- **Drafts:** the resume and cover letter use only your CV's own words (every line has a span into your CV); what your CV doesn't back is left as `[TO COMPLETE]` and listed. You confirm or reject each ambiguous match, and anything you edit is scanned for words and numbers that are in neither your CV nor the job.
- **Follow-up** is its own intent ("follow up on it"): suggested only from your own words (with the quote shown), drafts that claim no past conversation, and a reminder date you choose.
- **Recipes:** ingredient names normalised and merged, ranges and fractions read, servings rescaled from the extracted amounts, instructions quoted from the saved text, and substitutions kept apart and labelled inferred.


## Proactive reminders and notifications (phase 5)

Acorn can nudge you, within limits you set: in-app inbox and optional email, with quiet hours, a daily limit, your own time zone and an optional morning briefing. A reminder is announced once; snoozing or moving it gives the new time its own notification; Acorn never moves your dates or repeats itself. Reminders created from an intent need an intent **you confirmed**. A scheduled worker (`POST /api/cron/tick`, protected by `CRON_SECRET`) does the delivery, idempotently, with retries and a readable history. Real email is off unless four separate settings are on. Design, rules, security and the steps to switch it on are in [docs/notifications.md](docs/notifications.md); the migration is `20261104000000_notifications.sql` (unapplied).

## Going live

The safe, ordered plan for real use (credentials to rotate, backing up and applying the four pending migrations with verification and rollback, scheduler activation, end-to-end smoke tests, monitoring, costs and what still blocks) is in [docs/production-activation.md](docs/production-activation.md). `npm run audit:secrets` checks that no secret is in anything git could commit or the browser downloads.

## Architecture

```
src/lib/schema.ts     Zod contract: Memory, Extraction, Action, state enums
src/lib/store.ts      persistence boundary: picks the backend per request (local JSON or Supabase as the signed-in user)
src/lib/backends/     local.ts (JSON file, atomic writes), supabase.ts (Postgres + Storage, row mapping), types.ts
src/lib/supabase/     config + env validation, browser / server / admin clients, session user
src/proxy.ts          cloud mode: refresh the session, send signed-out visitors to /login
supabase/migrations/  version-controlled SQL: tables, RLS, storage bucket
src/lib/process.ts    capture → atomic claim → extract → validate → verify pipeline (synchronous for now)
src/lib/verify.ts     checks model claims against the saved text (quotes, deadlines, "you said so")
src/lib/ai/           provider interface (extractMemory, classifyIntent, answerFromMemories, generateActionPlan), prompts, Meta HTTP client
                      (timeouts, retries, usage and cost), Meta + mock providers, model registry, output schemas, built-in samples
src/lib/answer.ts     retrieval-then-answer with citation checking; intent.ts, plan.ts, related.ts, digest.ts
src/lib/search.ts     local keyword search with type/time hints and "why it matched"
src/lib/actions.ts    action state machine (suggested / simulated / executed)
src/lib/home.ts       needs-attention + upcoming deadline logic
src/lib/url.ts        URL validation + SSRF guard
src/lib/uploads.ts    image upload sniffing, size limits, private storage
src/app/              pages (home, capture, memories, search) + JSON API routes
```

**Safety defaults**
- Secrets stay on the server.
- Every boundary is validated with Zod.
- Uploads are limited to PNG, JPEG, WebP, and GIF up to 8 MB. Each file is identified by its magic bytes, stored under a random name outside `public/`, and served with `nosniff`.
- Demo mode never fetches URLs. Meta mode blocks private, loopback, and link-local hosts and re-validates every redirect.
- Saved content is treated as untrusted data: it is fenced in delimiters, and the model is told never to follow instructions found inside it.
- Model calls log only the model, latency, and token usage, never content.

**Intent is a guess until you say otherwise.** Acorn records *why you might have saved something* as one of: remember, learn, try, buy, reconnect, pursue, do later. That is stored as an `intentGuess` (with a confidence, and whether it came from your own words or was inferred from content). It only becomes your intent when you confirm, change or dismiss it on the memory page; your answer is stored separately, survives re-reading, and can be undone. Search treats "You marked it" and "Acorn's guess (not confirmed)" differently.

**Action honesty.** Every action is one of three kinds: *Suggested* (an idea only), *Simulated* (demo only), or *Executed* (it really happened). An executed action cannot be marked complete without written evidence (at least 10 characters; Acorn can't check it, so it is recorded as your claim), and a suggested action cannot be completed at all.

## Roadmap

1. ✅ Foundation: shell, capture, detail, local search, seeded demo
2. ◐ Memory intelligence: multimodal pipeline, facts with evidence, candidate intents, evidence-grounded answers, connections and evaluation set done in demo mode; Meta adapter verified live for text, image and PDF extraction (one call each)
3. ◐ Persistence: Supabase Auth, Postgres, and private storage built and tested against in-process Postgres, demo mode kept; needs a first run against a real project
4. ☐ Agent workflow: saved job + voluntary CV → requirement gap analysis → tailored drafts → checklist → user-approved submission → verification
5. ☐ Voice and follow-through: reminders, then browser voice via MediaRecorder + Muse Voice Transcribe

### Telephony notes (India)
Indian caller IDs require a business registered in India with KYC (Exotel, Plivo). An individual developer can realistically call Indian numbers only through Twilio or Vonage, using an international caller ID, and only with explicit recipient consent. Any calling feature will ship with consent, quiet hours, cancellation, and retry limits.

## Privacy

The repository is public. Never commit `.env*` (except `.env.example`), `.data/`, CVs, or personal screenshots. All sample data in `src/lib/seed.ts` is fictional.
