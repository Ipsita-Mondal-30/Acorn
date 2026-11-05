-- Rollback for 20261105000000_meta_artifacts.sql. Run by hand. Deletes artifact records (voice transcripts, visual-aid
-- metadata, segmentations, region readings). Memories are untouched. Stored files stay in the bucket until you remove them.
begin;
drop table if exists public.artifacts;
update storage.buckets
   set allowed_mime_types = array_remove(array_remove(allowed_mime_types, 'audio/wav'), 'image/svg+xml')
 where id = 'memory-images';
commit;
