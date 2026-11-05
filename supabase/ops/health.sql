-- READ-ONLY health queries for the scheduler and notifications. Run any of them in the SQL editor. They change nothing.

-- 1. Is the scheduler running, and succeeding? (needs pg_cron) Expect a row per minute with status = 'succeeded'.
select jobid, runid, status, return_message, start_time, end_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'acorn-tick')
 order by start_time desc
 limit 10;

-- 2. Did the app answer? (needs pg_net) 200 = ran. 401 = wrong secret. 404 = CRON_SECRET not set in the app. 500 = see the app log.
select id, status_code, left(content::text, 120) as body, created
  from net._http_response
 order by created desc
 limit 10;

-- 3. Backlog: deliveries that are due but not sent. Healthy: 0 rows older than 5 minutes.
select id, kind, channel, scheduled_for, attempts, left(coalesce(last_error, reason, ''), 80) as why
  from public.notification_deliveries
 where status = 'pending' and scheduled_for < now() - interval '5 minutes'
 order by scheduled_for
 limit 50;

-- 4. Failed deliveries (email gave up) in the last 7 days.
select id, channel, attempts, left(coalesce(last_error, ''), 80) as error, updated_at
  from public.notification_deliveries
 where status = 'failed' and updated_at > now() - interval '7 days'
 order by updated_at desc;

-- 5. Delivery outcomes per day (counts only).
select date_trunc('day', created_at) as day, channel, status, count(*) as n
  from public.notification_deliveries
 where created_at > now() - interval '14 days'
 group by 1, 2, 3
 order by 1 desc, 2, 3;

-- 6. Reminders that are overdue and open (what users will see under "Overdue").
select count(*) as overdue_open_reminders from public.reminders where status in ('scheduled', 'snoozed') and due_at < now();

-- 7. Database size and the biggest tables.
select pg_size_pretty(pg_database_size(current_database())) as database_size;
select relname, pg_size_pretty(pg_total_relation_size(oid)) as size from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by pg_total_relation_size(oid) desc limit 8;
