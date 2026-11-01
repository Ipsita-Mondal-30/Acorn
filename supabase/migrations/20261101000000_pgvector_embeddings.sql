-- Move embeddings from real[] to pgvector. Additive and reversible: the old real[] column is KEPT until you have
-- verified the new one (see supabase/rollback/ and docs/pgvector.md). Nothing is dropped here.
--
-- DIMENSION: deliberately NOT fixed. No embedding model has been selected, and Meta's Model API documents none, so any
-- number here would be invented. The column is an untyped `vector`; the table's `dims` column and a check keep every
-- row self-consistent, and match_memories() refuses a query whose size differs from what is stored for that model.
-- Once a model is chosen: (1) optionally add `vector(N)` via a follow-up migration, and (2) for large corpora add a
-- per-model HNSW expression index, e.g.
--   create index on public.memory_embeddings using hnsw ((embedding_vec::extensions.vector(N)) extensions.vector_cosine_ops)
--   where model = '<model id>';
-- At personal scale the exact scan below (filtered to one user and model) is fast and has perfect recall.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Supabase grants these by default; stated so a plain Postgres behaves the same.
grant usage on schema extensions to anon, authenticated, service_role;

alter table public.memory_embeddings
  add column provider text not null default 'unknown' check (char_length(provider) between 1 and 100),
  add column embedding_vec extensions.vector;

-- Carry over every existing vector. real[] -> vector is an exact cast; rows whose array is empty/zero are skipped.
update public.memory_embeddings
   set embedding_vec = embedding::extensions.vector
 where embedding_vec is null and embedding is not null and array_length(embedding, 1) >= 1;

-- New rows write only embedding_vec, so the old column can no longer be mandatory (it stays for rollback).
alter table public.memory_embeddings alter column embedding drop not null;

alter table public.memory_embeddings
  add constraint memory_embeddings_has_vector_check check (embedding_vec is not null or embedding is not null),
  add constraint memory_embeddings_vec_dims_check check (embedding_vec is null or extensions.vector_dims(embedding_vec) = dims);

-- ───────────────────────── similarity search ─────────────────────────
-- Cosine similarity (1 - cosine distance), best first, for the signed-in user's own vectors of one model.
--
-- SECURITY INVOKER (not DEFINER): it runs with the caller's rights, so RLS on memory_embeddings is enforced by the
-- database itself, and the function needs no elevated privilege. `user_id = auth.uid()` is repeated in the query as
-- defence in depth. search_path is empty, so every name is schema-qualified and nothing can be shadowed.
create or replace function public.match_memories(
  p_model text,
  p_query extensions.vector,
  p_limit integer default 20,
  p_min_similarity double precision default null
)
returns table (memory_id uuid, similarity double precision)
language plpgsql
stable
set search_path = ''
as $$
declare
  qd integer := extensions.vector_dims(p_query);
  stored integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_model is null or char_length(p_model) = 0 then
    raise exception 'p_model is required' using errcode = '22023';
  end if;

  select e.dims into stored
    from public.memory_embeddings e
   where e.model = p_model and e.user_id = (select auth.uid()) and e.embedding_vec is not null
   limit 1;
  if stored is not null and stored <> qd then
    raise exception 'query vector has % dimensions but model % stores % dimensions', qd, p_model, stored
      using errcode = '22023';
  end if;

  return query
    select e.memory_id,
           (1 - (e.embedding_vec operator(extensions.<=>) p_query))::double precision as similarity
      from public.memory_embeddings e
     where e.model = p_model
       and e.user_id = (select auth.uid())
       and e.embedding_vec is not null
       and (p_min_similarity is null or (1 - (e.embedding_vec operator(extensions.<=>) p_query)) >= p_min_similarity)
     order by e.embedding_vec operator(extensions.<=>) p_query
     limit least(greatest(coalesce(p_limit, 20), 1), 200);
end;
$$;

revoke all on function public.match_memories(text, extensions.vector, integer, double precision) from public, anon;
grant execute on function public.match_memories(text, extensions.vector, integer, double precision) to authenticated;
