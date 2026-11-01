# Phase 4 / 4.5 database: readiness, steps, verification, rollback

**Status: none of the migrations below has been applied to your Supabase project by Acorn.** You apply them. Nothing in
the repository touches the live project. Until a migration is applied the matching feature stays off and the rest of the
app keeps working (memory pages fall back gracefully).

## The migrations, in the order to apply them
| # | File | Adds | Needs |
|---|---|---|---|
| 1 | `20261031020000_reminders.sql` | reminders table | (you applied it earlier) |
| 2 | `20261031030000_memory_embeddings.sql` | embeddings table | (applied) |
| 3 | `20261101000000_pgvector_embeddings.sql` | pgvector column + `match_memories` | (applied) |
| 4 | `20261102000000_agent_plans.sql` | `plans` table, `profiles.cv_text` (superseded, unused) | 1 |
| 5 | `20261103000000_cv_documents.sql` | `cv_documents` (CV text + parse, one current per user), bucket accepts .docx/.txt | 4 not required |
| 6 | `20261103010000_follow_up_intent.sql` | allows the `follow_up` intent on memories | none |
| 7 | `20261104000000_notifications.sql` | reminder kinds/timezone/snooze count, notification settings and delivery history, `claim_deliveries` | 1 (reminders) |

Apply 4, 5 and 6 (whichever you haven't). Each is additive: no existing row is changed or deleted.

## Required configuration
No new environment variables. The app already needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(the publishable key). Never put the service-role key or database password in `.env.local` for the app: it doesn't read them.
Optional, for comparing job requirements by meaning: the embedding settings from `docs/pgvector.md`, and you approve the
`embed:text` permission on each plan (a small paid call, only when an embedding service is configured).

## Before you start
1. **Back up**: Dashboard → Database → Backups (confirm a recent one exists), or `pg_dump` with your own connection string.
2. Check where you are: in the SQL editor,
   ```sql
   select to_regclass('public.reminders'), to_regclass('public.memory_embeddings'), to_regclass('public.plans'), to_regclass('public.cv_documents');
   ```
   A `null` means "not applied yet".

## Apply
Paste each file's full contents into Dashboard → SQL editor, in the order above, and Run. "Success. No rows returned" is expected.
(Or `supabase db push` if you use the CLI.) Re-running a file fails with "already exists": that means it already worked.

## Verify (read-only)
```sql
-- row-level security on, with four policies each
select c.relname, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.tablename = c.relname) as policies
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('plans', 'cv_documents');
-- expect: plans | true | 4, cv_documents | true | 4

-- the CV table keeps itself coherent
select conname from pg_constraint where conrelid = 'public.cv_documents'::regclass and contype = 'c';
select indexname from pg_indexes where tablename = 'cv_documents';  -- includes cv_documents_one_current_idx

-- the private bucket now accepts CV files, and is still private
select public, allowed_mime_types from storage.buckets where id = 'memory-images';  -- public = false

-- the follow_up intent is allowed
select pg_get_constraintdef(oid) from pg_constraint where conname = 'memories_intent_kind_check';  -- mentions follow_up

-- your data is unchanged
select count(*) from memories;
```
Then `npm run supabase:check` (names and verdicts only, no secrets): the new tables should say "exists, and returns no rows to an
anonymous request". In the app (signed in): open a job memory, confirm why you saved it, upload a CV, make a plan. To check
persistence, reload the page and restart the server: the CV, the plan and its drafts are still there.

## What was tested without your project
The same SQL runs in the test suite on an in-process Postgres (`tests/migrations45.test.ts`): objects, constraints, row-level
security, two-user isolation (`tests/agent-cloud.test.ts`), persistence through a fresh store, and every rollback. The pgvector
migration is tested on a real PostgreSQL (`tests/pgvector.integration.test.ts`). What can't be tested here is your actual
project: its extensions, roles and storage settings. That is what the verify queries are for.

## Rollback (each undoes only its own migration; memories are never touched)
| To undo | Run | Notes |
|---|---|---|
| 6 follow-up intent | `supabase/rollback/20261103010000_follow_up_intent.down.sql` | refuses while any memory uses `follow_up`: change those first |
| 5 CV documents | `supabase/rollback/20261103000000_cv_documents.down.sql` | deletes CV rows (text and parse); stored files stay in Storage until you delete them (Dashboard → Storage → memory-images → your folder) |
| 4 agent plans | `supabase/rollback/20261102000000_agent_plans.down.sql` | deletes plan records |
| 7 notifications | `supabase/rollback/20261104000000_notifications.down.sql` | deletes notification settings and delivery history; reminders stay (their kind, zone and snooze count are dropped) |
The app tolerates a rolled-back database: plan and CV features switch off, nothing crashes.
