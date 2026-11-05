# Two-account isolation test (manual, ~15 minutes)

Why manual: the RLS policies and ownership checks are tested in-process (46 RLS tests plus the cross-user cases in
`tests/cloud.test.ts`, `tests/semantic.test.ts`), but nobody has yet proved it on the real Supabase project with two
real accounts. This test does. Nothing here deletes data.

## What protects data (audited from the code and migrations)

| Layer | Mechanism |
|---|---|
| Database | RLS on `profiles`, `memories`, `actions`, `tags`, `memory_tags`, `reminders`, `memory_embeddings`; every policy is `user_id = auth.uid()` |
| Cross-user links | composite foreign keys `(id, user_id)` so a row can only reference its owner's rows |
| Files | private bucket `memory-images`; storage policies only allow the `<user-id>/…` folder; the app serves files through a signed URL created as the signed-in user |
| App | every store call runs on a client bound to the signed-in user's session; `requireUser()` → 401 when signed out; `proxy.ts` redirects pages to `/login` |

## Setup

Use two browser profiles (or one normal window and one private window) so the sessions don't mix.
Account A = the account you already have. Account B = a new sign-up with another email.
Run the app against the real project (`npm run dev`, `.env.local` with the Supabase URL and anon key), `AI_PROVIDER=mock`.

## Steps

1. **A:** save the note `ISOLATION-A secret lemon pasta`, and upload any harmless image. Open each memory and copy its URL (`/memories/<id>`); also copy the image's file URL (right-click the image → copy image address, it looks like `/api/files/<name>`).
2. **B:** sign up, confirm the email, sign in. Save the note `ISOLATION-B secret tax plan`.
3. **B — reads.** Expect each to be *not found / empty*, never A's data:
   - `/memories` lists only B's note.
   - `/search?q=ISOLATION-A` finds nothing; `/search?q=lemon` finds nothing of A's.
   - Open A's memory URL → 404 page.
   - Open A's file URL (`/api/files/<name>`) → 404.
4. **B — API.** In the browser console on B's tab (replace `<A-id>` with A's memory id):
   ```js
   await fetch('/api/memories/<A-id>').then(r => r.status)                       // expect 404
   await fetch('/api/memories/<A-id>', {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({title:'hacked'})}).then(r => r.status) // expect 404
   await fetch('/api/memories/<A-id>', {method:'DELETE'}).then(r => r.status)     // expect 404 (do not worry: nothing is deleted)
   await fetch('/api/actions').then(r => r.json())                               // expect only B's actions
   ```
5. **A — confirm nothing changed:** A's note still has its original title and still exists; A's file still opens.
6. **Signed URLs:** as B, `/api/files/<A's file name>` must not redirect to a `supabase.co/storage/...` URL. A 404 is the pass.
7. **Logout.** In A: click *Sign out*. Then press the browser Back button and reload `/memories`: you must land on `/login`. Open `/api/memories` in a new tab: expect `{"error":…}` with HTTP 401. Sign in as A again and confirm the data is there.
8. **Protected pages, signed out:** in a private window with no session open `/`, `/memories`, `/capture`, `/search`, `/memories/<A-id>`: each redirects to `/login`. `/login` and `/signup` load.

## Record the result

For each numbered step note PASS or FAIL. Any FAIL where B sees A's content is a security bug: stop and tell me.
I can then run `npm run supabase:check` and read-only SQL to confirm the rows and storage paths are under the right owners (I can't sign in as either user myself).

## Added in phases 4 to 5: plans, CV, reminders and notifications
Do these with the same two accounts (A and B). Every "expect" is "not found", "empty" or HTTP 401/404; anything else is a security bug.

| Step | As | Do | Expect |
|---|---|---|---|
| 9 | A | On a memory, confirm an intent, make a plan, approve it, create a reminder. Upload a CV. Run the scheduler once so A has a notification. Note the memory, plan and reminder ids from the URLs and `/api/plans`, `/api/reminders`. | |
| 10 | B | `/api/plans` and `/api/reminders` in the console: `await fetch('/api/plans').then(r => r.json())` | `{plans: []}`, `{reminders: []}` |
| 11 | B | `await fetch('/api/plans/<A plan id>', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({op:'approve'})}).then(r => r.status)` | 404 |
| 12 | B | `await fetch('/api/reminders/<A reminder id>', {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({op:'done'})}).then(r => r.status)` | 404 |
| 13 | B | `await fetch('/api/cv').then(r => r.json())` and open A's CV file URL `/api/files/<A cv file name>` | `{cv: null}` and 404 |
| 14 | B | `await fetch('/api/notifications').then(r => r.json())` | `{deliveries: [], unread: 0}` |
| 15 | B | `await fetch('/api/notifications', {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({op:'read', ids:['<A delivery id>']})}).then(r => r.json())` | `{changed: 0}` |
| 16 | B | `await fetch('/api/cron/tick', {method:'POST'}).then(r => r.status)` | 401 (or 404 if the secret is not set): a login does not open the scheduler |
| 17 | B | `/api/notifications/preferences` PUT with `{maxPerDay: 7}` | 200, and A's settings are unchanged |
| 18 | A | Re-check plan, reminder, CV and notification. | all unchanged |
Then, as the database owner (read-only): `select count(*) from plans p join auth.users u on u.id = p.user_id where u.email = '<B email>'` should be 0.

