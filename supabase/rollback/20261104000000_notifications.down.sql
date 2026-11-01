-- Rollback for 20261104000000_notifications.sql. Run by hand. Deletes notification preferences and the delivery history
-- (what was sent, skipped or failed). Reminders and memories are kept; their kind, timezone and snooze count are dropped.
begin;
drop function if exists public.claim_deliveries(timestamptz, integer, integer);
drop table if exists public.notification_deliveries;
drop function if exists public.notification_deliveries_guard();
drop table if exists public.notification_preferences;
alter table public.reminders drop column if exists kind, drop column if exists timezone, drop column if exists snooze_count;
commit;
