-- Rollback for 20261103010000_follow_up_intent.sql. Run by hand. Refuses while any memory still uses the follow_up intent
-- (change those to another intent in the app first), because the old check would reject them.
begin;
do $$
begin
  if exists (select 1 from public.memories where intent_kind = 'follow_up') then
    raise exception 'refusing: some memories have the follow_up intent; change them first';
  end if;
end $$;
alter table public.memories drop constraint memories_intent_kind_check;
alter table public.memories
  add constraint memories_intent_kind_check
    check (intent_kind is null or intent_kind in
      ('remember','learn','try','buy','reconnect','pursue','do_later','attend','explore','reference','other'));
commit;
