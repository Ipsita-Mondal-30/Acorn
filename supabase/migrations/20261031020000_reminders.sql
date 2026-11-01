-- Reminders and their follow-up history. Additive: no existing row is touched.
-- A reminder belongs to a memory (and optionally to the action that spawned it) of the SAME user, enforced by
-- composite foreign keys exactly as for actions and tags, so a reminder can never point across accounts.

-- actions needs the same (id, user_id) key memories and tags already have, so reminders can reference it
alter table public.actions add constraint actions_id_user_key unique (id, user_id);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  memory_id uuid not null,
  action_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  note text not null default '' check (char_length(note) <= 2000),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'snoozed', 'dismissed')),
  -- append-only log of what happened to it: [{at, status, note?}]
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade,
  foreign key (action_id, user_id) references public.actions (id, user_id) on delete cascade
);

create index reminders_user_due_idx on public.reminders (user_id, due_at) where status in ('scheduled', 'snoozed');
create index reminders_memory_idx on public.reminders (memory_id);

create trigger reminders_touch before update on public.reminders
  for each row execute function public.touch_row();

alter table public.reminders enable row level security;

create policy reminders_select_own on public.reminders for select to authenticated
  using (user_id = (select auth.uid()));
create policy reminders_insert_own on public.reminders for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy reminders_update_own on public.reminders for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy reminders_delete_own on public.reminders for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.reminders from anon;
grant select, insert, update, delete on public.reminders to authenticated;
