-- Acorn cloud schema: profiles, memories, actions, tags, memory_tags, a private image bucket, and
-- Row-Level Security on everything a user owns. Apply with `supabase db push` or the SQL editor.
-- Deliberately NO pgvector / embedding columns: add them in a later migration once an embedding
-- provider and its dimensions are verified.

-- ───────────────────────── helpers ─────────────────────────

create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- memories and actions also carry a revision counter. The app updates them with "...where rev = <the rev I read>",
-- so two concurrent edits can't silently overwrite each other (compare-and-swap).
create or replace function public.touch_row() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.rev = old.rev + 1;
  return new;
end;
$$;

-- ───────────────────────── profiles ─────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 100),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile row appears with every new auth user. SECURITY DEFINER because the signing-up user has no
-- session yet; search_path is pinned so the function can't be hijacked.
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(split_part(coalesce(new.email, ''), '@', 1), 100), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── memories ─────────────────────────

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled' check (char_length(title) <= 500),
  content_type text not null default 'other'
    check (content_type in ('job','recipe','technical','article','person','idea','deadline','note','other')),
  source_kind text not null check (source_kind in ('note','url','image')),
  -- what the user saved, verbatim (note body, or the caption they typed for a link / image)
  original_text text check (original_text is null or char_length(original_text) <= 20000),
  -- text pulled out of the source (fetched page text, OCR); null until something extracts it
  extracted_text text,
  summary text not null default '' check (char_length(summary) <= 2000),
  -- the link the user saved, kept separate from any stored file
  source_url text check (source_url is null or char_length(source_url) <= 2000),
  -- object path inside the private `memory-images` bucket: <user_id>/<file>
  storage_path text check (storage_path is null or char_length(storage_path) <= 512),
  mime_type text,
  original_name text check (original_name is null or char_length(original_name) <= 255),
  -- the full app document (extraction, user corrections, intent decision, provenance); lossless round trip
  structured_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_metadata) = 'object'),
  -- effective free-text reading of why it was saved
  intent text check (intent is null or char_length(intent) <= 300),
  -- confidence of Acorn's UNCONFIRMED guess; null once the user has decided
  intent_confidence numeric(4, 3) check (intent_confidence is null or intent_confidence between 0 and 1),
  -- the USER's own decision, never a model guess
  intent_kind text check (intent_kind is null or intent_kind in ('remember','learn','try','buy','reconnect','pursue','do_later')),
  intent_status text check (intent_status is null or intent_status in ('confirmed','corrected','set','dismissed')),
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','ready','failed')),
  error text check (error is null or char_length(error) <= 500),
  content_hash text not null,
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- one copy of the same content per user; makes capture idempotent and race-safe
  unique (user_id, content_hash),
  -- a stored file must live under its owner's folder, enforced even for privileged writers
  check (storage_path is null or storage_path like user_id::text || '/%'),
  check (source_kind <> 'image' or storage_path is not null)
);

create index memories_user_created_idx on public.memories (user_id, created_at desc);
create index memories_user_status_idx on public.memories (user_id, processing_status);
create index memories_metadata_idx on public.memories using gin (structured_metadata jsonb_path_ops);

create trigger memories_touch before update on public.memories
  for each row execute function public.touch_row();

-- ───────────────────────── actions ─────────────────────────

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  memory_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  -- suggested = idea only; simulated = pretend (demo); executed = really happened (needs evidence)
  action_type text not null check (action_type in ('suggested','simulated','executed')),
  status text not null default 'proposed'
    check (status in ('proposed','awaiting_approval','approved','in_progress','completed','failed','cancelled')),
  related_memory_ids uuid[] not null default '{}',
  proposed_plan jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_plan) = 'object'),
  -- derived from the state history; kept as a column so approvals can be queried
  approval_status text not null default 'not_required'
    check (approval_status in ('not_required','pending','approved','rejected')),
  result text check (result is null or char_length(result) <= 500),
  verification_evidence text check (verification_evidence is null or char_length(verification_evidence) <= 2000),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- an action can only point at a memory its owner owns
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade
);

create index actions_user_updated_idx on public.actions (user_id, updated_at desc);
create index actions_memory_idx on public.actions (memory_id);
create index actions_user_status_idx on public.actions (user_id, status);

create trigger actions_touch before update on public.actions
  for each row execute function public.touch_row();

-- ───────────────────────── tags ─────────────────────────

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (name = lower(btrim(name)) and char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

create table public.memory_tags (
  memory_id uuid not null,
  tag_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (memory_id, tag_id),
  -- both ends must belong to the same user as this row, so a link can never cross accounts
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade,
  foreign key (tag_id, user_id) references public.tags (id, user_id) on delete cascade
);

create index memory_tags_tag_idx on public.memory_tags (tag_id);
create index memory_tags_user_idx on public.memory_tags (user_id);

-- ───────────────────────── atomic processing claim ─────────────────────────
-- SECURITY INVOKER (the default): runs as the caller, so RLS still limits it to their own rows.
-- Two concurrent callers can't both win, so one capture never triggers two (paid) model calls.
-- A "processing" row older than the lease is a crashed run and may be claimed again; a live run never is.

create or replace function public.claim_memory_processing(p_id uuid, p_force boolean, p_lease_seconds integer)
returns setof public.memories
language sql
set search_path = ''
as $$
  update public.memories m
     set processing_status = 'processing', error = null
   where m.id = p_id
     and (m.processing_status in ('pending', 'failed', 'processing') or p_force)
     and not (m.processing_status = 'processing'
              and m.updated_at > now() - make_interval(secs => p_lease_seconds))
  returning m.*;
$$;

-- ───────────────────────── Row-Level Security ─────────────────────────

alter table public.profiles enable row level security;
alter table public.memories enable row level security;
alter table public.actions enable row level security;
alter table public.tags enable row level security;
alter table public.memory_tags enable row level security;

-- Nothing is reachable without signing in.
revoke all on public.profiles, public.memories, public.actions, public.tags, public.memory_tags from anon;
revoke all on function public.claim_memory_processing(uuid, boolean, integer) from public, anon;
grant select, insert, update, delete on public.memories, public.actions, public.tags, public.memory_tags to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant execute on function public.claim_memory_processing(uuid, boolean, integer) to authenticated;

-- profiles: your own row only (created by the signup trigger, so no insert policy is needed to sign up)
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- memories / actions / tags / memory_tags: rows where user_id is you, for every command.
-- WITH CHECK on insert/update stops you creating or moving a row under someone else's id.
create policy memories_select_own on public.memories for select to authenticated
  using (user_id = (select auth.uid()));
create policy memories_insert_own on public.memories for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy memories_update_own on public.memories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy memories_delete_own on public.memories for delete to authenticated
  using (user_id = (select auth.uid()));

create policy actions_select_own on public.actions for select to authenticated
  using (user_id = (select auth.uid()));
create policy actions_insert_own on public.actions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy actions_update_own on public.actions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy actions_delete_own on public.actions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy tags_select_own on public.tags for select to authenticated
  using (user_id = (select auth.uid()));
create policy tags_insert_own on public.tags for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy tags_update_own on public.tags for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy tags_delete_own on public.tags for delete to authenticated
  using (user_id = (select auth.uid()));

-- memory_tags: you must own the link AND (by the composite foreign keys) both the memory and the tag.
-- The explicit EXISTS checks keep that true at the policy layer too, not only through constraints.
create policy memory_tags_select_own on public.memory_tags for select to authenticated
  using (user_id = (select auth.uid()));
create policy memory_tags_insert_own on public.memory_tags for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.memories m where m.id = memory_id and m.user_id = (select auth.uid()))
    and exists (select 1 from public.tags t where t.id = tag_id and t.user_id = (select auth.uid()))
  );
create policy memory_tags_delete_own on public.memory_tags for delete to authenticated
  using (user_id = (select auth.uid()));

-- ───────────────────────── private image storage ─────────────────────────
-- Private bucket (never public), 8 MB cap, images only. Objects live at <user_id>/<random>.<ext>;
-- the policies below let a user touch only their own folder. Access to a file is by short-lived signed URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memory-images', 'memory-images', false, 8388608, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy memory_images_select_own on storage.objects for select to authenticated
  using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_update_own on storage.objects for update to authenticated
  using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
