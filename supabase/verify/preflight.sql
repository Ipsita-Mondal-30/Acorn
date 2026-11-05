-- READ-ONLY pre-flight for the four pending migrations (20261102000000, 20261103000000, 20261103010000, 20261104000000).
-- Paste into Supabase Dashboard -> SQL editor and Run BEFORE applying anything. It changes nothing.
-- Every row in the "required" group must show ok = true. The "info" rows are for you to read.
select 'required' as grp, name, ok, detail from (
  values
    ('table profiles',            to_regclass('public.profiles') is not null,            'created by 20261031000000'),
    ('table memories',            to_regclass('public.memories') is not null,            'created by 20261031000000'),
    ('table actions',             to_regclass('public.actions') is not null,             'created by 20261031000000'),
    ('table reminders',           to_regclass('public.reminders') is not null,           'created by 20261031020000; notifications needs it'),
    ('table memory_embeddings',   to_regclass('public.memory_embeddings') is not null,   'created by 20261031030000 (not needed by the four, shown for completeness)'),
    ('actions (id, user_id) unique key', exists (select 1 from pg_constraint where conname = 'actions_id_user_key'),          'added by 20261031020000; agent_plans needs it'),
    ('reminders (id, user_id) unique key', exists (select 1 from pg_constraint where conrelid = to_regclass('public.reminders') and contype = 'u' and conkey @> array[(select attnum from pg_attribute where attrelid = to_regclass('public.reminders') and attname = 'id'), (select attnum from pg_attribute where attrelid = to_regclass('public.reminders') and attname = 'user_id')]), 'notifications needs it for its foreign key'),
    ('memories (id, user_id) unique key', exists (select 1 from pg_constraint where conrelid = to_regclass('public.memories') and contype = 'u' and conkey @> array[(select attnum from pg_attribute where attrelid = to_regclass('public.memories') and attname = 'id'), (select attnum from pg_attribute where attrelid = to_regclass('public.memories') and attname = 'user_id')]), 'agent_plans needs it for its foreign key'),
    ('function set_updated_at()', to_regprocedure('public.set_updated_at()') is not null, 'used by triggers in notifications'),
    ('function touch_row()',      to_regprocedure('public.touch_row()') is not null,      'used by plans'),
    ('memories intent check',     exists (select 1 from pg_constraint where conrelid = to_regclass('public.memories') and conname = 'memories_intent_kind_check'), '20261103010000 replaces it'),
    ('bucket memory-images is private', exists (select 1 from storage.buckets where id = 'memory-images' and public = false), '20261103000000 widens its allowed file types'),
    ('reminders has the columns the new code adds to', (select count(*) = 7 from information_schema.columns where table_schema = 'public' and table_name = 'reminders' and column_name in ('id', 'user_id', 'memory_id', 'action_id', 'status', 'history', 'rev')), 'id, user_id, memory_id, action_id, status, history, rev'),
    ('nothing pending is already applied', to_regclass('public.plans') is null and to_regclass('public.cv_documents') is null and to_regclass('public.notification_deliveries') is null and to_regclass('public.notification_preferences') is null, 'plans, cv_documents and the notification tables should not exist yet (if they do, skip that migration)'),
    ('no existing intent value would break', (select count(*) = 0 from public.memories where intent_kind is not null and intent_kind not in ('remember','learn','try','buy','reconnect','pursue','do_later','attend','explore','reference','other')), 'the new list only adds follow_up, so this should be 0 rows')
) as t(name, ok, detail)
union all
select 'info', 'rows in memories', true, case when to_regclass('public.memories') is null then 'table missing' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.memories', false, true, '')))[1]::text end
union all
select 'info', 'rows in actions', true, case when to_regclass('public.actions') is null then 'table missing' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.actions', false, true, '')))[1]::text end
union all
select 'info', 'rows in reminders', true, case when to_regclass('public.reminders') is null then 'table missing' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.reminders', false, true, '')))[1]::text end
union all
select 'info', 'rows in memory_embeddings', true, case when to_regclass('public.memory_embeddings') is null then 'table missing' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.memory_embeddings', false, true, '')))[1]::text end
union all
select 'info', 'bucket allowed types (20261103000000 REPLACES this list)', true, coalesce(array_to_string(allowed_mime_types, ' '), '(any)') from storage.buckets where id = 'memory-images'
union all
select 'info', 'bucket file size limit', true, coalesce(file_size_limit::text, '(none)') from storage.buckets where id = 'memory-images'
union all
select 'info', 'extension vector installed', true, coalesce((select extversion from pg_extension where extname = 'vector'), 'no') 
union all
select 'info', 'extension pg_cron installed (needed only to schedule)', true, coalesce((select extversion from pg_extension where extname = 'pg_cron'), 'no')
union all
select 'info', 'extension pg_net installed (needed only to schedule)', true, coalesce((select extversion from pg_extension where extname = 'pg_net'), 'no')
order by 1 desc, 2;
