-- Phase 4: agent plans and the user's CV. Additive; no existing row is touched.
--   * plans: one row per execution plan, tied to the memory and the action (the existing state machine) it belongs to
--   * profiles.cv_text: the CV the user chose to give Acorn (owner-only via the existing profile policies)
-- Reminders already exist (20261031020000); the app now reads and writes them.

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  memory_id uuid not null,
  action_id uuid not null,
  workflow text not null check (workflow in ('job_application', 'recipe', 'followup')),
  status text not null default 'awaiting_approval'
    check (status in ('awaiting_approval', 'approved', 'running', 'awaiting_you', 'completed', 'failed', 'rejected')),
  -- the whole typed plan (goal, context, steps with their state, outputs and verification), validated by the app
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- a plan can only point at a memory and an action of the SAME user
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade,
  foreign key (action_id, user_id) references public.actions (id, user_id) on delete cascade
);

create index plans_user_memory_idx on public.plans (user_id, memory_id);
create index plans_action_idx on public.plans (action_id);

create trigger plans_touch before update on public.plans
  for each row execute function public.touch_row();

alter table public.plans enable row level security;

create policy plans_select_own on public.plans for select to authenticated
  using (user_id = (select auth.uid()));
create policy plans_insert_own on public.plans for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy plans_update_own on public.plans for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy plans_delete_own on public.plans for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.plans from anon;
grant select, insert, update, delete on public.plans to authenticated;

-- the CV the user gave Acorn (plain text). profiles already allows select/insert/update of your own row only.
alter table public.profiles
  add column cv_text text check (cv_text is null or char_length(cv_text) <= 30000),
  add column cv_updated_at timestamptz;
