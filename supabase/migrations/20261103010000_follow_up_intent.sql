-- Phase 4.5: a separate "follow_up" intent. Widens the check on memories.intent_kind; no row is changed.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.memories'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%intent_kind%'
  loop
    execute format('alter table public.memories drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.memories
  add constraint memories_intent_kind_check
    check (intent_kind is null or intent_kind in
      ('remember','learn','try','buy','reconnect','pursue','do_later','attend','explore','reference','follow_up','other'));
