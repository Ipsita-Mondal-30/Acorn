-- Meta multimodal artifacts: voice notes, generated visual aids, image segmentations and region readings.
-- Additive; no existing row is touched. NOT applied by the app: run it deliberately (see docs/meta-multimodal.md).
--   * artifacts: one row per thing a Meta model made FROM a memory (or a voice note not yet saved as a memory)
--   * the private storage bucket also accepts WAV audio (original voice notes) and SVG (demo-mode diagrams)

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- null only for a voice note that has not become a memory yet
  memory_id uuid,
  parent_id uuid,
  kind text not null check (kind in ('voice', 'visual_aid', 'segmentation', 'region_reading')),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  provider text not null check (provider in ('mock', 'meta')),
  model text not null check (char_length(model) <= 80),
  -- the whole typed artifact (input/output metadata, error, usage, links), validated by the app
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- an artifact can only point at a memory (and a parent artifact) of the SAME user
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade,
  foreign key (parent_id, user_id) references public.artifacts (id, user_id) on delete cascade
);

create index artifacts_user_memory_idx on public.artifacts (user_id, memory_id);
create index artifacts_parent_idx on public.artifacts (parent_id);

create trigger artifacts_touch before update on public.artifacts
  for each row execute function public.touch_row();

alter table public.artifacts enable row level security;

create policy artifacts_select_own on public.artifacts for select to authenticated
  using (user_id = (select auth.uid()));
create policy artifacts_insert_own on public.artifacts for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy artifacts_update_own on public.artifacts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy artifacts_delete_own on public.artifacts for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.artifacts from anon;
grant select, insert, update, delete on public.artifacts to authenticated;

-- the same private bucket holds original voice notes (WAV) and generated pictures (PNG/WebP, or SVG in demo mode).
-- APPENDS to the allowed list (earlier migrations added PDFs and CV file types); it never replaces it.
update storage.buckets
   set allowed_mime_types = allowed_mime_types || array['audio/wav', 'image/svg+xml']
 where id = 'memory-images' and not (allowed_mime_types @> array['audio/wav', 'image/svg+xml']);
