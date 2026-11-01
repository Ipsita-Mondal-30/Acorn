-- OPTIONAL, run only AFTER the pgvector migration is verified in production (docs/pgvector.md, step "Verify").
-- This is the one destructive step: it removes the old real[] copy. After it, rolling back loses the vectors
-- (they can be regenerated with POST /api/embeddings; no memory is affected).
begin;
do $$
begin
  if exists (select 1 from public.memory_embeddings where embedding_vec is null) then
    raise exception 'refusing: some rows have no embedding_vec yet; backfill first';
  end if;
end $$;
alter table public.memory_embeddings drop constraint if exists memory_embeddings_has_vector_check;
alter table public.memory_embeddings drop column embedding;
alter table public.memory_embeddings alter column embedding_vec set not null;
commit;
