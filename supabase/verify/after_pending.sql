-- READ-ONLY verification AFTER applying the four pending migrations. Paste into the SQL editor and Run. It changes nothing.
-- Every row must show ok = true. Compare the "info" row counts with what the pre-flight showed (they must be equal).
select 'check' as grp, name, ok, detail from (
  values
    ('plans: table, RLS on, 4 policies', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.plans')), false) and (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'plans'), 'select, insert, update, delete: all owner-only'),
    ('plans: foreign keys to memories and actions', (select count(*) = 3 from pg_constraint where conrelid = to_regclass('public.plans') and contype = 'f'), 'user, (memory, user), (action, user)'),
    ('plans: touch trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.plans') and tgname = 'plans_touch'), 'bumps rev and updated_at'),
    ('profiles: CV columns', (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('cv_text', 'cv_updated_at')), 'superseded by cv_documents, harmless'),
    ('cv_documents: table, RLS on, 4 policies', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.cv_documents')), false) and (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'cv_documents'), 'owner-only'),
    ('cv_documents: one current CV per user', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'cv_documents_one_current_idx'), 'unique partial index'),
    ('bucket still private, now accepts CV files', exists (select 1 from storage.buckets where id = 'memory-images' and public = false and 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' = any (allowed_mime_types) and 'text/plain' = any (allowed_mime_types) and 'application/pdf' = any (allowed_mime_types) and 'image/png' = any (allowed_mime_types)), 'images, PDF, docx, text'),
    ('follow_up intent allowed', exists (select 1 from pg_constraint where conname = 'memories_intent_kind_check' and pg_get_constraintdef(oid) like '%follow_up%'), 'memories_intent_kind_check'),
    ('reminders: kind, timezone, snooze_count', (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'reminders' and column_name in ('kind', 'timezone', 'snooze_count')), 'existing rows got kind = manual'),
    ('reminders: every existing row has a valid kind', (select count(*) = 0 from public.reminders where kind is null or snooze_count < 0), 'defaults applied'),
    ('notification_preferences: RLS on, 4 policies', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.notification_preferences')), false) and (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'notification_preferences'), 'owner-only'),
    ('notification_deliveries: RLS on, only select + update for users', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.notification_deliveries')), false) and (select array_agg(cmd order by cmd) = array['SELECT', 'UPDATE'] from pg_policies where schemaname = 'public' and tablename = 'notification_deliveries'), 'users cannot insert or delete history'),
    ('notification_deliveries: dedupe key is unique', exists (select 1 from pg_constraint where conrelid = to_regclass('public.notification_deliveries') and contype = 'u' and pg_get_constraintdef(oid) like '%user_id, dedupe_key%'), 'the same notification cannot be queued twice'),
    ('notification_deliveries: guard trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.notification_deliveries') and tgname = 'notification_deliveries_guard'), 'users may only mark read or cancel a pending one'),
    ('notification_deliveries: due-queue index', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notification_deliveries_due_idx'), 'partial index on pending'),
    ('claim_deliveries: only the service role can run it', to_regprocedure('public.claim_deliveries(timestamptz, integer, integer)') is not null and not has_function_privilege('anon', 'public.claim_deliveries(timestamptz, integer, integer)', 'execute') and not has_function_privilege('authenticated', 'public.claim_deliveries(timestamptz, integer, integer)', 'execute') and has_function_privilege('service_role', 'public.claim_deliveries(timestamptz, integer, integer)', 'execute'), 'anon: no, signed-in users: no, service role: yes'),
    ('anonymous users still see nothing', not has_table_privilege('anon', 'public.plans', 'select') and not has_table_privilege('anon', 'public.cv_documents', 'select') and not has_table_privilege('anon', 'public.notification_deliveries', 'select') and not has_table_privilege('anon', 'public.notification_preferences', 'select'), 'no grants to anon')
) as t(name, ok, detail)
union all
select 'info', 'rows in memories (must equal the pre-flight count)', true, count(*)::text from public.memories
union all
select 'info', 'rows in actions (must equal the pre-flight count)', true, count(*)::text from public.actions
union all
select 'info', 'rows in reminders (must equal the pre-flight count)', true, count(*)::text from public.reminders
union all
select 'info', 'rows in memory_embeddings (must equal the pre-flight count)', true, count(*)::text from public.memory_embeddings
order by 1, 2;
