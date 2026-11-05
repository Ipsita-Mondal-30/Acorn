# Production activation: the safe, reproducible plan

Nothing in this guide has been done for you. No migration is applied, the scheduler is off, no email is configured, no paid call
was made, and nothing was changed in your credentials. Every step is yours, in this order.

## 1. Git readiness

**State now** (`git status`): 5 commits on `origin/main` and your local `main` (scaffold, migrations, core library, plus the two earlier ones). Staged but
not committed: 14 files in `src/lib` (memory processing and search). Modified: `.gitignore`, `README.md`, `package.json`. Everything else is untracked.

**Must never be committed** (all ignored, and checked by `npm run audit:secrets` and `tests/secrets-audit.test.ts`): `.env.local` (your keys and database URLs),
`.data/` (local memories, uploads, CVs), `.next/`, `node_modules/`, `.claude/`, `.DS_Store`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, real `*.pdf`/`*.docx` files.
Two deliberate exceptions, both fictional: `tests/fixtures/*.pdf|docx` (CV test files) and `public/samples/*.pdf` (the demo paper). Before this audit `.gitignore`
would have silently dropped them and broken a fresh clone's tests and demo; that is fixed (uncommitted, in `.gitignore`).

**Generated, safe to commit:** `evals/agent-results.md` (rewritten by `npm run eval:agent`). **Migration and rollback files:** `supabase/migrations/*`, `supabase/rollback/*`
(committed already); new read-only SQL in `supabase/verify/` and `supabase/ops/` is not yet committed. `supabase/ops/*.sql` are NOT migrations and must never be moved into `migrations/`.

**Recommended remaining commits** (small, in this order; commit with `git commit -m "..."` after each `git add`; none of these builds on its own until all are in):

| # | Message | Files |
|---|---|---|
| 4 | Add memory processing, hybrid and semantic search, actions state machine | already staged |
| 5 | Add agent engine: plans, tools, executor, job and recipe workflows | `git add src/lib/agent src/lib/reminders.ts src/app/api/plans src/app/api/reminders src/components/AgentControls.tsx src/components/PlanPanel.tsx` |
| 6 | Add CV upload, parsing and requirement matching routes | `git add src/lib/cv src/app/api/cv` |
| 7 | Add notification system: worker, preferences, inbox, briefing, scheduler endpoint | `git add src/lib/notify src/lib/log.ts src/app/api/notifications src/app/api/cron src/app/api/briefing src/app/api/followthrough src/app/reminders src/app/notifications src/app/settings src/app/briefing src/components/NotifyControls.tsx src/components/ReminderCard.tsx src/components/RemindersSection.tsx` |
| 8 | Add app routes and UI | `git add src/app src/components public` (what is left after 5 to 7) |
| 9 | Add tests and evaluation data | `git add tests evals` |
| 10 | Add docs, operator scripts, verification SQL and config updates | `git add docs scripts supabase/verify supabase/ops README.md package.json .gitignore` |

Before pushing: `npm run audit:secrets` (should say "No secret exposure found") and `git diff --cached --stat` to see what goes up.

## 2. Credential security

`npm run audit:secrets` compares every value in `.env.local` against everything git could commit and everything the browser downloads (without printing a value). Result today: **no secret in any committable file, none in the 22 browser files (`.next/static`, `public`), and every source file that reads a secret variable is server code (the script lists them).**

| Variable | Read by | Exposure |
|---|---|---|
| `META_API_KEY` | `src/lib/ai/meta.ts`, `health.ts` (only "is it set", never the value) | server-only module |
| `EMBEDDING_API_KEY` | `src/lib/ai/embeddings.ts` | server-only module |
| `EMAIL_API_KEY` | `src/lib/notify/providers.ts` | server-only module |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/admin.ts`, used by `notify/service.ts` (the scheduler) and operator scripts | server-only; no user request uses it |
| `CRON_SECRET` | `src/lib/notify/service.ts`, `src/app/api/cron/tick/route.ts` | server-only; compared in constant time; unset means the endpoint doesn't exist |
| `DATABASE_URL`, `DIRECT_URL` | not read by the app at all (psql and operator use) | `.env.local` only |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser and server | public by design (the anon key is protected by row-level security) |

**Logs and error responses.** `src/lib/log.ts` writes one JSON line per event and replaces the value of every secret-named environment variable and every common secret shape (API keys, bearer tokens, JWTs, database URLs with passwords) before writing. Unexpected API errors answer with a fixed sentence and log only name, a clipped redacted message and `file:line`. The scheduler logs counts and duration only (never titles, ids or text), and a rejected call logs nothing the caller sent. All of this is tested (`tests/log.test.ts`, `tests/secrets-audit.test.ts`).

**Credentials to rotate** (you change them; I did not and cannot):
1. **OpenAI key**: you pasted it into this chat. Revoke it at platform.openai.com, create a new one, put it in `.env.local` as `EMBEDDING_API_KEY`, and set a monthly spend limit (for example US$5).
2. **Meta API key**: it appeared in my reads of `.env.local`. Revoke and recreate it in the Meta developer console; update `META_API_KEY`.
3. **Supabase database password**: it appeared in my reads of `.env.local` (inside `DIRECT_URL`). Dashboard → Project Settings → Database → Reset database password; update `DIRECT_URL` and fix `DATABASE_URL` (its host part is malformed; the app does not read it, but psql would).
4. **Supabase service-role key**: never shown to me and not set yet. When you set it for the scheduler, keep it in the server environment only. Never in a `NEXT_PUBLIC_` variable, never in a chat.
5. **`CRON_SECRET`**: not created yet. Generate with `openssl rand -hex 32` when you activate. Never paste it in a chat or a file in git. The same value goes in the app's environment and in Supabase Vault.
6. **Email provider key**: not set; when you add one, same rules.
The Supabase anon (publishable) key is public by design and does not need rotating.

## 3. Migration readiness

Four migrations are pending, in this exact order:
1. `20261102000000_agent_plans.sql`
2. `20261103000000_cv_documents.sql`
3. `20261103010000_follow_up_intent.sql`
4. `20261104000000_notifications.sql`

**Verified on a real PostgreSQL** (`tests/pending-migrations.integration.test.ts`, with pgvector, three users' worth of data shaped like yours: pursuing intent, a done and a snoozed reminder, an embedding): the pre-flight passes; the four apply one at a time with **no row changing at any step**; the post-check passes; old reminders get safe defaults; new intents are accepted and invalid ones refused; security holds (users see only their own rows, only the service role can claim deliveries, history can't be rewritten); the rollbacks, run in reverse order, restore **exactly** the original schema (a fingerprint of columns, constraints, indexes, policies, triggers, functions and bucket types is identical); applying again works; a second apply of a file fails loudly without changing anything.

| Migration | Depends on | Adds | Risk |
|---|---|---|---|
| agent_plans | `actions_id_user_key` (from the reminders migration), `touch_row()` | `plans` (RLS, composite foreign keys to your memory and action), `profiles.cv_text` columns | none: additive |
| cv_documents | nothing new | `cv_documents` (RLS, one current CV per user), and the private bucket also accepts `.docx` and text | **replaces `storage.buckets.allowed_mime_types` for `memory-images`** with a fixed list (images, PDF, docx, text). If you added other types by hand they are dropped. The pre-flight prints the current list. |
| follow_up_intent | none | allows the `follow_up` intent | swaps a check constraint: a brief table lock and a validation scan (fast at your size). Safe to run twice. |
| notifications | `reminders (id, user_id)` key, `set_updated_at()` | reminder kind/zone/snooze count (existing rows: `manual`, no zone, 0), settings, delivery history, `claim_deliveries()` | adds columns with constant defaults to `reminders` (instant on PostgreSQL 11 and later) |

**No forward migration drops or rewrites data.** The rollback scripts are destructive by design (they drop the new tables) and exist for undoing.

**Back up first.** Supabase free projects have no automatic backups, so make your own:
```bash
set -a; . ./.env.local; set +a
pg_dump "$DIRECT_URL" --schema=public --format=custom --file="$HOME/acorn-before-phase5.dump"
pg_restore --list "$HOME/acorn-before-phase5.dump" | head
```
(`DIRECT_URL` holds your password: this prints none of it. Reset the password first, part 2.) The dump covers your tables; stored files (screenshots) are not changed by these migrations. On a paid plan also check Dashboard → Database → Backups.

**Then, in the Supabase SQL editor, one at a time:**
1. Paste `supabase/verify/preflight.sql` and Run. Every row in the `required` group must be `true`; write down the `info` row counts. If a required row is false, stop and tell me which.
2. For each of the four files in order: paste the whole file, Run ("Success. No rows returned"), then Run `supabase/verify/after_pending.sql` and look at the rows for the migrations applied so far. (After the last one, **every** `check` row must be `true`, and the row counts must equal the pre-flight's.)
3. If a file fails: do not retry blindly. Run the pre-flight again to see what state you are in, and tell me the error text.

**Roll back** (only if you want one gone; newest first; none touches your memories): `supabase/rollback/20261104000000_notifications.down.sql`, then `...20261103010000_follow_up_intent.down.sql` (refuses while a memory uses `follow_up`), then `...20261103000000_cv_documents.down.sql` (deletes CV rows; files stay in Storage until you delete them), then `...20261102000000_agent_plans.down.sql`. The app keeps working with any of them rolled back (the features switch off).

## 4. Scheduler readiness

`POST /api/cron/tick`, reviewed against your list (every row is a test, in `tests/notify-*.test.ts`, `tests/log.test.ts`, `tests/agent-cloud.test.ts`, `tests/pending-migrations.integration.test.ts`):

| Requirement | How it is met |
|---|---|
| `CRON_SECRET` validation | bearer token required; at least 32 characters (startup refuses less); unset means 404; wrong, missing, malformed or different-case token is 401 |
| Constant-time comparison | both sides are SHA-256 hashed, then `timingSafeEqual` |
| Service-role access | only here (`workerStore()`); never reachable without the secret; a login is useless; with no service key the run answers 500 with a fixed message and logs why |
| No input | the request body and headers beyond the token are ignored; the clock is the server's; the response is counts only |
| Idempotency | unique `(user_id, dedupe_key)`; running it twice, or three at once, creates one notification |
| Worker locking | `claim_deliveries()` uses `for update skip locked` plus a 5-minute lease: two workers never hold the same delivery; a crashed worker's lease expires |
| Failure recovery | email retries after 1, 5, 30 minutes, 2 and 6 hours; a run that dies halfway is finished by the next one with no duplicates; a backlog of old reminders can't starve new ones (found and fixed in this review) |
| Delivery history | every outcome is a row with a reason (inbox page and each reminder show it) |
| Time zones, quiet hours, daily limits | evaluated in the user's zone, with daylight-saving cases; held, never dropped |

**Prepared, not enabled:** `supabase/ops/schedule_tick.sql` (schedule, with `<PLACEHOLDERS>` only: no secret, no URL), `supabase/ops/unschedule_tick.sql` (pause, resume, remove), `supabase/ops/health.sql` (read-only checks). The secret is read from Supabase Vault at run time, so it never appears in `cron.job`.

**A real constraint:** `pg_net` calls the app over the internet, so the app must be deployed at a public URL. A laptop's `localhost` is not reachable from Supabase. Until you deploy, test with the `curl` command in `docs/e2e-smoke-test.md` step G.

## 5. End-to-end tests

`docs/e2e-smoke-test.md` (steps A to J with the exact settings, SQL checks and expected results) and `docs/two-user-isolation-test.md` (step J in detail). Paid calls are marked; confirm before each.

## 6. Monitoring (only what was missing)

| Need | Status |
|---|---|
| Structured logs | added: `src/lib/log.ts`, one redacted JSON line per event |
| Scheduler health | each run logs `tick` with counts and milliseconds (a failed delivery makes it a warning); `supabase/ops/health.sql` shows pg_cron runs, the app's HTTP answers and any backlog |
| Failed delivery visibility | already in the app (inbox "Waiting, skipped or failed", per-reminder status) and in `health.sql` |
| API error tracking | unexpected errors log `api_error` with name, redacted message and file:line; a hosted log viewer can alert on that string. No third-party tracker added. |
| Model usage and cost | each Meta call logs tokens and estimated cost; totals per server run on `/api/health`; set spend limits at Meta and OpenAI. There is no stored cost ledger across restarts. |
| Database health | `health.sql` (size, biggest tables) and the Supabase dashboard |

## 7. Expected costs
About US$0.01 to 0.02 per screenshot read by Muse Spark; embeddings about US$0.00001 per memory and less per search; scheduler and notifications cost nothing beyond your hosting and Supabase plan; email is your provider's price (not configured). The whole smoke test is roughly one to two US cents.

## 8. What is still blocking real use
1. Rotate the credentials (part 2).
2. Back up and apply the four migrations (part 3). Until then plans, CV upload, follow-up intent and notifications are off on your project.
3. Deploy the app at a public URL with `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` and the other server variables, so the scheduler can reach it.
4. Run the smoke test, including the one live Meta capture (still unverified in the app).
5. Only then create the pg_cron job.
6. Commit the remaining groups and push.
7. Email has never been tried against a real provider.
