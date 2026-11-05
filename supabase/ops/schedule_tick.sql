-- Turns the scheduler ON: calls POST /api/cron/tick every minute. NOT run by anything automatically (it is not a migration).
-- Run it yourself, in the Supabase SQL editor, ONLY after the four migrations are applied and the app is deployed with
-- CRON_SECRET and SUPABASE_SERVICE_ROLE_KEY set. Needs the pg_cron, pg_net and (for the secret) Vault extensions
-- (Dashboard -> Database -> Extensions).
--
-- NEVER save this file with real values in it, and never commit them. The two <PLACEHOLDERS> below are the only things you fill in.

-- STEP 1 (once): keep the secret in Vault, not in the schedule. Use the SAME value as the app's CRON_SECRET.
select vault.create_secret('<PASTE-THE-SAME-VALUE-AS-CRON_SECRET>', 'acorn_cron_secret', 'Bearer secret for the Acorn scheduler');

-- STEP 2: call the app once a minute. The secret is read from Vault at run time, so it never appears in cron.job.
select cron.schedule(
  'acorn-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://<YOUR-APP-HOST>/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'acorn_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $job$
);

-- STEP 3: check it (read-only; see supabase/ops/health.sql for more)
select jobid, jobname, schedule, active from cron.job where jobname = 'acorn-tick';
