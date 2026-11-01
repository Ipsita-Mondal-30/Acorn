-- Phase 3: multimodal memories. Additive on top of 20261031000000_initial_schema.sql.
--   * new content types (event, product) and a "document" source (PDF uploads)
--   * the wider set of intent kinds (attend, explore, reference, other)
--   * the private bucket also accepts PDFs
--   * PostgreSQL full-text search over what a memory says (search_text -> search_tsv, GIN index, RPC)
-- Still NO vector / embedding columns: those wait for a verified embedding model and its dimensions.

-- ───────────────────────── widen check constraints ─────────────────────────
-- Column checks have generated names and the table-level ones have none, so find them by what they test.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.memories'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%content_type%'
        or pg_get_constraintdef(oid) like '%source_kind%'
        or pg_get_constraintdef(oid) like '%intent_kind%')
  loop
    execute format('alter table public.memories drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.memories
  add constraint memories_content_type_check
    check (content_type in ('job','recipe','technical','article','person','idea','deadline','event','product','note','other')),
  add constraint memories_source_kind_check
    check (source_kind in ('note','url','image','document')),
  add constraint memories_intent_kind_check
    check (intent_kind is null or intent_kind in
      ('remember','learn','try','buy','reconnect','pursue','do_later','attend','explore','reference','other')),
  -- a file-backed memory must point at its stored original, which must live in its owner's folder
  add constraint memories_file_has_original_check
    check (source_kind not in ('image','document') or storage_path is not null);

-- ───────────────────────── private bucket: images and PDFs ─────────────────────────
-- 15 MB cap on the bucket; the app enforces the tighter 8 MB limit for images itself.
update storage.buckets
   set public = false,
       file_size_limit = 15728640,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']
 where id = 'memory-images';

-- ───────────────────────── full-text search ─────────────────────────
-- search_text is written by the app from the title, summary, facts, entities, topics and the user's own text.
alter table public.memories add column search_text text not null default '';
alter table public.memories
  add column search_tsv tsvector generated always as (to_tsvector('english', search_text)) stored;
create index memories_search_idx on public.memories using gin (search_tsv);

-- backfill rows saved before this migration, without touching their revision or updated_at
alter table public.memories disable trigger memories_touch;
update public.memories
   set search_text = left(concat_ws(E'\n', title, summary, original_text, original_name, source_url), 20000)
 where search_text = '';
alter table public.memories enable trigger memories_touch;

-- SECURITY INVOKER (default): runs as the caller, so RLS limits it to their own memories.
create or replace function public.search_memories_fts(p_query text, p_limit integer default 50)
returns table (id uuid, rank real)
language sql
stable
set search_path = ''
as $$
  select m.id, ts_rank_cd(m.search_tsv, q.query)::real as rank
    from public.memories m,
         websearch_to_tsquery('english', coalesce(p_query, '')) as q(query)
   where m.search_tsv @@ q.query
   order by rank desc, m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.search_memories_fts(text, integer) from public, anon;
grant execute on function public.search_memories_fts(text, integer) to authenticated;
