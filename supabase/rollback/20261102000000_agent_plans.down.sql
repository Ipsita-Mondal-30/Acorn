-- Rollback for 20261102000000_agent_plans.sql. Run by hand. Deletes plan records and any CV text saved in profiles.cv_text;
-- no memory, action or reminder is touched (actions created for plans stay as ordinary actions).
begin;
drop table if exists public.plans;
alter table public.profiles drop column if exists cv_text, drop column if exists cv_updated_at;
commit;
