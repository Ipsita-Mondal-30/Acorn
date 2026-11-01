-- Phase 5: proactive reminders. Additive; no existing row is changed except that existing reminders get the default
-- kind 'manual' and a zero snooze count.
--   * reminders: kind (why it exists), timezone (the zone it was set in), snooze_count
--   * notification_preferences: per user switches, channels, timezone, quiet hours, daily limit, briefing
--   * notification_deliveries: one row per notification and channel: the delivery history, and the inbox
--   * claim_deliveries(): the atomic "take the next due deliveries" the scheduled worker uses (service role only)
-- Delivery is idempotent: (user_id, dedupe_key) is unique, so the same notification can never be queued twice.

alter table public.reminders
  add column kind text not null default 'manual'
    check (kind in ('manual', 'intent', 'deadline', 'follow_up', 'recipe', 'event')),
  add column timezone text check (timezone is null or char_length(timezone) <= 64),
  add column snooze_count integer not null default 0 check (snooze_count >= 0);

create table public.notification_preferences (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  in_app boolean not null default true,
  email boolean not null default false,
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  quiet_start time,
  quiet_end time,
  max_per_day integer not null default 10 check (max_per_day between 1 and 50),
  briefing_enabled boolean not null default false,
  briefing_hour smallint not null default 8 check (briefing_hour between 0 and 23),
  -- follow-through suggestions the user dismissed: { "<subject key>": "<hidden until, ISO>" }
  snoozed_suggestions jsonb not null default '{}'::jsonb check (jsonb_typeof(snoozed_suggestions) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((quiet_start is null) = (quiet_end is null))
);
create trigger notification_preferences_touch before update on public.notification_preferences
  for each row execute function public.set_updated_at();

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reminder_id uuid,
  kind text not null check (kind in ('reminder', 'briefing')),
  channel text not null check (channel in ('in_app', 'email')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  reason text check (reason is null or char_length(reason) <= 500),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  scheduled_for timestamptz not null,
  -- a worker that took this delivery holds it until here; a crashed worker's hold simply expires
  locked_until timestamptz,
  sent_at timestamptz,
  read_at timestamptz,
  -- the reminder's due time when this was queued: a rescheduled reminder gets a fresh delivery
  due_at timestamptz,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedupe_key),
  -- a delivery can only belong to a reminder of the SAME user, and goes with it
  foreign key (reminder_id, user_id) references public.reminders (id, user_id) on delete cascade
);
create index notification_deliveries_user_idx on public.notification_deliveries (user_id, created_at desc);
create index notification_deliveries_due_idx on public.notification_deliveries (scheduled_for) where status = 'pending';
create index notification_deliveries_reminder_idx on public.notification_deliveries (reminder_id);

create trigger notification_deliveries_touch before update on public.notification_deliveries
  for each row execute function public.set_updated_at();

-- A signed-in user may mark their own notifications read and cancel one that hasn't been sent. Nothing else: the
-- delivery history is the worker's record, so a user can't rewrite what was sent or fail. (The worker, using the service
-- role, has no auth.uid() and is not restricted by this.)
create or replace function public.notification_deliveries_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.user_id is distinct from old.user_id or new.reminder_id is distinct from old.reminder_id or new.kind is distinct from old.kind
     or new.channel is distinct from old.channel or new.dedupe_key is distinct from old.dedupe_key or new.payload is distinct from old.payload
     or new.attempts is distinct from old.attempts or new.sent_at is distinct from old.sent_at or new.scheduled_for is distinct from old.scheduled_for
     or new.due_at is distinct from old.due_at or new.locked_until is distinct from old.locked_until then
    raise exception 'only read state and cancellation can be changed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending' and new.status = 'skipped') then
    raise exception 'a delivery can only be cancelled while it is pending' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger notification_deliveries_guard before update on public.notification_deliveries
  for each row execute function public.notification_deliveries_guard();

alter table public.notification_preferences enable row level security;
alter table public.notification_deliveries enable row level security;

create policy notification_preferences_select_own on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_preferences_insert_own on public.notification_preferences for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy notification_preferences_update_own on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notification_preferences_delete_own on public.notification_preferences for delete to authenticated
  using (user_id = (select auth.uid()));

-- deliveries: read and update your own; only the worker inserts
create policy notification_deliveries_select_own on public.notification_deliveries for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_deliveries_update_own on public.notification_deliveries for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.notification_preferences, public.notification_deliveries from anon;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, update on public.notification_deliveries to authenticated;

-- The worker takes due deliveries atomically: two workers (or two overlapping runs) can never take the same one.
create or replace function public.claim_deliveries(p_now timestamptz, p_limit integer, p_lease_seconds integer)
returns setof public.notification_deliveries
language sql
set search_path = ''
as $$
  update public.notification_deliveries d
     set locked_until = p_now + make_interval(secs => greatest(p_lease_seconds, 30))
   where d.id in (
     select id from public.notification_deliveries
      where status = 'pending' and scheduled_for <= p_now and (locked_until is null or locked_until <= p_now)
      order by scheduled_for
      limit least(greatest(p_limit, 1), 200)
      for update skip locked)
  returning d.*;
$$;
revoke all on function public.claim_deliveries(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_deliveries(timestamptz, integer, integer) to service_role;
