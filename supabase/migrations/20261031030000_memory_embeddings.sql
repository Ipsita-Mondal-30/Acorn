-- Semantic search: one embedding per (memory, model). Additive; no existing row is touched.
--
-- Vectors are stored as real[] rather than pgvector's vector type on purpose: Meta's Model API documents no
-- embedding model yet (so no dimension is known), and the extension cannot be verified in the test database.
-- Similarity is computed by the app over the signed-in user's own rows (RLS limits the read). Moving to
-- `vector(n)` + an HNSW index later is a column-type change once a model and its dimension are chosen.

create table public.memory_embeddings (
  memory_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model text not null check (char_length(model) between 1 and 200),
  dims integer not null check (dims between 1 and 4096),
  embedding real[] not null,
  -- hash of the text the vector was made from: a changed memory shows up as stale and is re-embedded
  source_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (memory_id, model),
  check (array_length(embedding, 1) = dims),
  -- an embedding can only belong to a memory of the SAME user
  foreign key (memory_id, user_id) references public.memories (id, user_id) on delete cascade
);

create index memory_embeddings_user_model_idx on public.memory_embeddings (user_id, model);

create trigger memory_embeddings_touch before update on public.memory_embeddings
  for each row execute function public.set_updated_at();

alter table public.memory_embeddings enable row level security;

create policy memory_embeddings_select_own on public.memory_embeddings for select to authenticated
  using (user_id = (select auth.uid()));
create policy memory_embeddings_insert_own on public.memory_embeddings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy memory_embeddings_update_own on public.memory_embeddings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy memory_embeddings_delete_own on public.memory_embeddings for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.memory_embeddings from anon;
grant select, insert, update, delete on public.memory_embeddings to authenticated;
