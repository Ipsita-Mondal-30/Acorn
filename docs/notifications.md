# Proactive reminders and scheduled notifications (phase 5)

**Status:** built and tested with in-process databases and a mocked email provider. Not applied to your Supabase project,
and nothing has been sent to anyone: `20261104000000_notifications.sql` is unapplied and email is off.

## What it does
- **Reminders** (`/reminders`): yours, or created from an intent you confirmed (deadline, follow-up, recipe, event). Each one points at its memory (and the action/plan it came from), keeps a history, and can be edited, rescheduled, snoozed, completed, dismissed and reopened. Sections: Overdue, Today, Upcoming, Snoozed, Completed.
- **Notifications**: in-app inbox (`/notifications`) and optional email. Each reminder is announced **once per channel per due time**. Snooze or reschedule it and the new time gets a new notification.
- **Settings** (`/settings/notifications`): master switch, channels, time zone, quiet hours, daily limit, daily briefing.
- **Daily briefing** (`/briefing`, and optionally each morning): due today, overdue, plans waiting for approval, deadlines this week, memories you marked for follow-up. Empty days send nothing.
- **Follow-through suggestions**: overdue actions, reminders postponed 3+ times, plans stalled 5+ days, deadlines this week with nothing set. Read-only, at most three, never their own notification, hideable for 14 days.

## Rules that never bend
1. A reminder created by Acorn on the strength of an intent needs an intent **you confirmed** on that memory. A guess never counts (`assertKindAllowed`).
2. Acorn never moves a reminder date by itself, and never repeats itself: no re-notifying, no nagging.
3. A notification says only what your data says: company, role, deadline, unfinished steps, shopping list, your own saved words, a draft you send yourself. It never describes a conversation or a promise.
4. Quiet hours and the daily limit **hold** notifications, they don't drop them. Expired ones (more than 72 h overdue when first seen) are recorded as skipped with a reason and still show as overdue.
5. Phone calls and texts do not exist in Acorn.

## Architecture decision
| Option | Verdict |
|---|---|
| **pg_cron alone** (SQL inserts notifications) | Fine for in-app only, but can't send email, would duplicate the time-zone/DST/quiet-hours rules in SQL, and can't be tested with a mocked provider. |
| **Supabase Edge Function** | A second runtime (Deno) with its own deploy; the logic couldn't run in this repo's test suite. |
| **External worker process** | Needs a host to run and watch. Overkill for one tick a minute. |
| **Chosen: one idempotent HTTP tick, triggered by a scheduler** | The logic is ordinary TypeScript in this repo, fully tested. Supabase's own `pg_cron` + `pg_net` can call it every minute (no extra host), and so can any other pinger. |

How it stays correct:
- **Idempotency:** `(user_id, dedupe_key)` is unique, with the key `reminder:<id>:<due time>:<channel>` (briefing: `briefing:<local date>:<channel>`). Running the tick twice, or three at once, can't queue a second copy. Tested.
- **No double sends:** deliveries are taken with `claim_deliveries()` (`for update skip locked` plus a 5-minute lease), so two workers never hold the same one; a crashed worker's lease simply expires.
- **Retries:** email failures retry after 1 min, 5 min, 30 min, 2 h, 6 h, then stay `failed`. A refusal that can never work (bad address, unverified sender) fails at once. Every attempt and error is recorded.
- **Time zones:** the scheduler stores instants; "9am" and quiet hours are your wall clock in your zone, with clock changes handled (a time that doesn't exist moves forward, a time that happens twice means its first occurrence; a "day" can be 23 or 25 hours).
- **Delivery history:** every outcome (sent, held and why, skipped and why, failed and why) is a row you can read.
- **Cancelling:** completing, dismissing, snoozing or moving a reminder cancels what is still unsent, and the worker re-checks right before sending.

## Security
- The tick endpoint is **POST only**, needs `Authorization: Bearer <CRON_SECRET>` (compared in constant time; at least 32 characters; unset = 404), takes **no input**, uses the server's clock, and answers with counts only. A user's login is useless to it.
- It is the **only** place the service-role key is used (it has to see every user's due reminders). It reads one user's rows at a time, and every row it writes is for that row's owner. The key stays server-side.
- Users can read their own history, mark notifications read, and cancel a pending one. A database trigger refuses any other change: they can't rewrite what was sent or failed, or insert deliveries.
- Real email needs `EMAIL_PROVIDER`, a key, a From address and `NOTIFICATIONS_ENABLE_SENDING=true`. Tests stub the network, so they cannot send.

## Turning it on (when you decide to)
1. Apply `supabase/migrations/20261104000000_notifications.sql` (back up first; rollback: `supabase/rollback/20261104000000_notifications.down.sql`).
2. Set in the app's environment: `CRON_SECRET` (e.g. `openssl rand -hex 32`) and `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never `NEXT_PUBLIC`), then deploy.
3. In Supabase: Dashboard → Database → Extensions → enable `pg_cron` and `pg_net`. Store the secret once in Vault and schedule the call (replace the URL):
   ```sql
   select vault.create_secret('<the same CRON_SECRET>', 'acorn_cron_secret');
   select cron.schedule('acorn-tick', '* * * * *', $$
     select net.http_post(
       url := 'https://YOUR-APP-URL/api/cron/tick',
       headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'acorn_cron_secret')),
       timeout_milliseconds := 20000);
   $$);
   ```
   Any other scheduler works too: `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP-URL/api/cron/tick` every minute.
4. Optional email: set `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM` (a sender you verified), `APP_BASE_URL`, and finally `NOTIFICATIONS_ENABLE_SENDING=true`. Then each person opts in under Settings.
5. Check: `curl -X POST` with a wrong secret returns 401; with the right one returns counts. Set a reminder 2 minutes ahead and watch the inbox.

Locally (demo mode, no accounts) the same tick runs on the JSON store: set `CRON_SECRET` and `curl -X POST` it; email goes to `NOTIFY_LOCAL_EMAIL` if you configure a provider.

## Limits
- Delivery is as punctual as the scheduler (a minute, with pg_cron). A reminder is never lost if a minute is missed.
- The in-app inbox has no push notification: it appears when you open Acorn (home page and reminders page show a banner). Browser or phone push is not built.
- Email is plain text through one provider (Resend). Another provider is one small adapter in `src/lib/notify/providers.ts`.
- Recurring reminders do not exist yet: each reminder is one moment.
- The daily-limit counts deliveries per channel, so one reminder on two channels counts once on each.
