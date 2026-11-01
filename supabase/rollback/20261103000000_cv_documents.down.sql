-- Rollback for 20261103000000_cv_documents.sql. Run by hand. Deletes the CV rows (extracted text and parse).
-- Original files stay in the private bucket until you delete them in Storage (Dashboard -> Storage -> memory-images -> your folder).
begin;
drop table if exists public.cv_documents;
update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']
 where id = 'memory-images';
commit;
