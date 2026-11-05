-- Turns the scheduler OFF. Safe to run any time; it only stops future calls. Nothing already queued is lost: pending
-- notifications simply wait and go out when you turn it back on (anything more than 72 hours overdue is shown as overdue instead).

-- pause (keeps the job so you can resume it):
select cron.alter_job((select jobid from cron.job where jobname = 'acorn-tick'), active := false);

-- resume:
-- select cron.alter_job((select jobid from cron.job where jobname = 'acorn-tick'), active := true);

-- remove completely:
-- select cron.unschedule('acorn-tick');
-- and the secret, if you are rotating it (then create the new one with schedule_tick.sql step 1):
-- delete from vault.secrets where name = 'acorn_cron_secret';
