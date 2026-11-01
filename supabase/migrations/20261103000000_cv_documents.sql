-- Phase 4.5: CV documents. Additive; no existing row is touched.
--   * cv_documents: the user's CV (uploaded file or pasted text) with its extracted text and a structured parse. Every
--     version is kept; exactly one is current. The original file stays in the private bucket under the user's own folder.
--   * the private bucket also accepts .docx and plain text
-- Supersedes profiles.cv_text from 20261102000000, which is no longer read (the column is harmless and can be dropped later).

create table public.cv_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source text not null check (source in ('upload', 'paste')),
  -- the stored original: <uuid>.<ext> inside the user's folder of the memory-images bucket (null for pasted text)
  file_name text check (file_name is null or file_name ~ '^[0-9a-f-]{36}\.(pdf|docx|txt)$'),
  original_name text check (original_name is null or char_length(original_name) <= 255),
  file_kind text check (file_kind is null or file_kind in ('pdf', 'docx', 'txt')),
  mime_type text check (mime_type is null or char_length(mime_type) <= 100),
  byte_size integer check (byte_size is null or byte_size between 1 and 10485760),
  text_content text not null check (char_length(text_content) between 20 and 60000),
  text_sha256 text not null check (char_length(text_sha256) = 64),
  -- the structured parse; every item carries the character span of the words it came from
  parsed jsonb not null default '{}'::jsonb check (jsonb_typeof(parsed) = 'object'),
  parser_version text not null check (char_length(parser_version) between 1 and 40),
  readable boolean not null default true,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  replaced_at timestamptz,
  check ((source = 'upload') = (file_name is not null))
);

-- at most one current CV per user; replacing one flips the old row to is_current = false first
create unique index cv_documents_one_current_idx on public.cv_documents (user_id) where is_current;
create index cv_documents_user_created_idx on public.cv_documents (user_id, created_at desc);

alter table public.cv_documents enable row level security;

create policy cv_documents_select_own on public.cv_documents for select to authenticated
  using (user_id = (select auth.uid()));
create policy cv_documents_insert_own on public.cv_documents for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy cv_documents_update_own on public.cv_documents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cv_documents_delete_own on public.cv_documents for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.cv_documents from anon;
grant select, insert, update, delete on public.cv_documents to authenticated;

-- the private bucket (images, PDFs) also stores CV files
update storage.buckets
   set allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']
 where id = 'memory-images';
