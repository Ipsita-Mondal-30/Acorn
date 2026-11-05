# End-to-end smoke test on your real project (A to J)

Run this **after** the four migrations are applied and verified (`docs/production-activation.md`, part 3). Do it with `npm run dev`
(or your deployed app) pointed at the real Supabase project. Nothing here is run automatically; you will be asked before running
anything that costs money, and will not run any step against real users.

## Settings for this test (`.env.local`, restart the server after changing)
```
AI_PROVIDER=meta
AI_ENABLE_REAL_CALLS=true        # also allows the embedding calls below
ACORN_MAX_MODEL_CALLS=3          # a hard cap on Meta calls for this server run
EMBEDDING_PROVIDER=http          # already configured (OpenAI text-embedding-3-small)
CRON_SECRET=<a fresh 32+ character value you generate: openssl rand -hex 32>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase, server side only>
EMAIL_PROVIDER=none              # email stays OFF for this test
```
Afterwards set `AI_PROVIDER=mock` and `AI_ENABLE_REAL_CALLS=false` again unless you want the real models on.

## What costs money
| Step | Calls | Expected cost |
|---|---|---|
| A. save a screenshot | 1 Meta image call, then 1 embedding call | about US$0.01 to 0.02 (the three live Muse Spark calls earlier were each in that range) + under US$0.0001 |
| C. search | 1 embedding call per search (a few tokens) | under US$0.0001 |
| D/E. plan, compare step | only if you approve the `embed:text` permission on the plan: 1 embedding call | under US$0.0001 |
| G to J. scheduler, inbox, snooze | none | 0 |
| email | none (off) | 0 |
So the whole test is roughly one to two US cents. Meta's price list is the authority; check your usage page afterwards.

## Pick a harmless screenshot
A screenshot of a made-up job post, recipe or event, with no personal data. (The demo samples in `public/samples/` are fictional and work well.)

## The steps
**A. Save a screenshot with Muse Spark.** Capture page → upload the screenshot → wait up to ~15 s. Expected: the memory opens with a real title, summary, facts with quotes, and the footer says it was read by `meta` / `muse-spark-1.3` (not "demo rules"). *(paid step: confirm before running)*

**B. It is stored in Supabase.** In the SQL editor (read-only):
```sql
select m.id, m.title, m.content_type, m.processing_status,
       m.structured_metadata->'extraction'->'producedBy'->>'provider' as read_by,
       m.structured_metadata->'extraction'->'producedBy'->>'model' as model,
       m.storage_path is not null as has_file, m.created_at
  from memories m join auth.users u on u.id = m.user_id
 where u.email = '<your email>' order by m.created_at desc limit 3;
```
Expected: your newest row, `processing_status = ready`, `read_by = meta`, `model = muse-spark-1.3`, `has_file = true`. Then
```sql
select e.model, e.dims, e.provider from memory_embeddings e join memories m on m.id = e.memory_id
  join auth.users u on u.id = m.user_id where u.email = '<your email>' order by e.created_at desc limit 3;
```
Expected: `text-embedding-3-small | 1536 | http`.

**C. Search with different wording.** Search page → describe it without using its words (for a pasta screenshot: "that citrus noodle dish"; for a job: "the engineering role I was keen on"). Expected: the memory is in the results, with a reason such as "Close in meaning to your search". Also try a nonsense query: expected "Nothing matched".

**D. Confirm an intent and make a plan.** Open the memory → "Why you saved this" → confirm → "Let Acorn help you act on it" → Make a plan. Expected: a plan marked "Waiting for your approval", nothing run, the permission list shown.

**E. Approve, run an approved step.** Approve. Expected: the read/compare steps run and show "Done and checked"; a draft step stops at "Review it"; nothing outside the app happened. Accept one draft.
```sql
select p.workflow, p.status, jsonb_array_length(p.doc->'steps') as steps,
       (select count(*) from jsonb_array_elements(p.doc->'steps') s where s->>'state' = 'succeeded') as done
  from plans p join auth.users u on u.id = p.user_id where u.email = '<your email>' order by p.created_at desc limit 3;
```

**F. Create a reminder.** On the memory page → Reminders → set one for **3 minutes from now** (your time zone is shown). Expected: it appears under "Upcoming" at /reminders, "Not announced yet".

**G. Run the scheduler once, by hand** (not pg_cron yet), from your machine:
```bash
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
```
Wait until the reminder is due, run it again. Expected JSON: `{"ok":true,"queued":1,"sent":1,...}`. Run a third time: `queued:0,sent:0`. A wrong secret gives `Unauthorized` (401); `GET` gives 405.
```sql
select d.channel, d.status, d.attempts, d.sent_at, d.reason
  from notification_deliveries d join auth.users u on u.id = d.user_id where u.email = '<your email>' order by d.created_at desc limit 5;
```
Expected: one `in_app | sent` row for the reminder.

**H. Open the notification.** /notifications (or the banner on the home page). Expected: the title, the company/role or recipe/shopping-list context, "Original memory" and (if there is a plan) "Open the plan" links; both open the right pages.

**I. Snooze, and check there is no duplicate.** /reminders → "In 1 hour" or "Tomorrow 9:00". Run the tick again. Expected: still one delivery for the old time, none new until the new time.
```sql
select dedupe_key, status, count(*) over () as total from notification_deliveries d join auth.users u on u.id = d.user_id
 where u.email = '<your email>' and d.kind = 'reminder' order by d.created_at;
```
Expected: every `dedupe_key` appears once. After the snooze time passes and another tick runs, there is exactly one new row with a different key.

**J. Another user can't see any of it.** Follow `docs/two-user-isolation-test.md` (it covers memories, files, plans, reminders, CV and notifications). Expected: every check there says "not found / empty / 401".

## After the test
- Set `AI_PROVIDER=mock`, `AI_ENABLE_REAL_CALLS=false` (or leave real on if you intend to).
- Delete the test memory if you like (memory page → Delete): its plan, reminders and notifications go with it.
- Only then think about the scheduled job (`docs/production-activation.md`, part 4).
