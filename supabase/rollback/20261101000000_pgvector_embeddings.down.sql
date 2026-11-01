-- Rollback for 20261101000000_pgvector_embeddings.sql. Run by hand (psql / SQL editor), never automatically.
-- Vectors written since the migration exist only in embedding_vec, so they are copied back to real[] first.
-- No memory is touched. The `vector` extension is left installed (other things may use it).

begin;
drop function if exists public.match_memories(text, extensions.vector, integer, double precision);

update public.memory_embeddings
   set embedding = embedding_vec::real[]
 where embedding is null and embedding_vec is not null;

alter table public.memory_embeddings drop constraint if exists memory_embeddings_vec_dims_check;
alter table public.memory_embeddings drop constraint if exists memory_embeddings_has_vector_check;
alter table public.memory_embeddings alter column embedding set not null;
alter table public.memory_embeddings drop column embedding_vec;
alter table public.memory_embeddings drop column provider;
commit;
