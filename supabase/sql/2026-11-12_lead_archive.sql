-- migration lead_archive (2026-11-12)
--
-- Maverick: "add an archive button so that lost isnt the only way to remove it" (2026-11-08, built that day but never
-- deployed) and again 2026-11-12: "i asked for the ability to archive leads, both in the chat and in the catering leads".
--
-- catering_leads.archived_at / inquiries.archived_at. Set by 🗄 Archive in the manager console (lead / inquiry window,
-- straight update as the manager) or in Greys Chat (lead panel or ⋮ menu → chat-api lead_archive → chat_lead_archive).
-- An archived lead keeps everything; it only leaves the lists (console Catering Leads, Greys Chat's Leads, the portal
-- home tile and its counts) and sits under "Archived". ↩ Unarchive puts it back, and so does a new message from the
-- customer (form, email, text, or a reply staff log for them) — triggers below.
-- Archiving also clears its unread dot (an unread lead would otherwise stay under Open).
-- Every archive / unarchive posts a card in the lead's chat conversation: "🗄 Archived · By …" / "↩ Back in Leads ·
-- By …" (or "Why: They wrote again"), and touches the conversation so open chats refetch it.
-- The two chat triggers are changed in place by guarded replaces (each pattern must occur exactly once), so nothing
-- else in them moves.

alter table public.catering_leads add column if not exists archived_at timestamptz;
alter table public.inquiries add column if not exists archived_at timestamptz;

-- the customer wrote again: an archived lead comes back
create or replace function public.lead_unarchive_on_reply()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform set_config('greys.unarchive_why', 'reply', true);
    if tg_table_name = 'catering_messages' then
      update catering_leads set archived_at = null where id = new.lead_id and archived_at is not null;
    else
      update inquiries set archived_at = null where id = new.inquiry_id and archived_at is not null;
    end if;
  exception when others then null;   -- never block a message
  end;
  perform set_config('greys.unarchive_why', '', true);
  return null;
end $function$;
revoke all on function public.lead_unarchive_on_reply() from public, anon, authenticated;

drop trigger if exists catering_messages_unarchive on public.catering_messages;
create trigger catering_messages_unarchive after insert on public.catering_messages
  for each row when (new.direction = 'in') execute function public.lead_unarchive_on_reply();
drop trigger if exists inquiry_messages_unarchive on public.inquiry_messages;
create trigger inquiry_messages_unarchive after insert on public.inquiry_messages
  for each row when (new.direction = 'in') execute function public.lead_unarchive_on_reply();

-- Greys Chat's archive button (chat-api lead_archive, service role only): who did it rides in greys.stage_by,
-- the same way chat_lead_set_stage names the person on "📌 Moved to" cards. Only acts when it changes.
create or replace function public.chat_lead_archive(p_lead uuid, p_inq uuid, p_on boolean, p_by text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform set_config('greys.stage_by', coalesce(nullif(btrim(p_by), ''), 'Greys Chat'), true);
  if p_lead is not null then
    update catering_leads set archived_at = case when p_on then now() end, unread = unread and not p_on
     where id = p_lead and (archived_at is null) = p_on;
  elsif p_inq is not null then
    update inquiries set archived_at = case when p_on then now() end, unread = unread and not p_on
     where id = p_inq and (archived_at is null) = p_on;
  end if;
  perform set_config('greys.stage_by', '', true);
  return p_on;
end $function$;
revoke all on function public.chat_lead_archive(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.chat_lead_archive(uuid, uuid, boolean, text) to service_role;

-- the card's fields: "Why: They wrote again" (unarchived by a customer message), else "By: <who>" — Greys Chat passes
-- the name, the manager console is known by its sign-in email
create or replace function public.chat_archive_fields(p_back boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare who text; claims jsonb; em text;
begin
  if p_back and coalesce(current_setting('greys.unarchive_why', true), '') = 'reply' then
    return jsonb_build_array(jsonb_build_array('Why', 'They wrote again'));
  end if;
  who := nullif(current_setting('greys.stage_by', true), '');
  if who is null then
    begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
    if coalesce(claims ->> 'role', '') = 'authenticated' then
      em := claims ->> 'email';
      select p.name into who from portal_employees p where p.id = chat_emp_by_email(em);
      who := coalesce(who, nullif(em, ''), 'Someone') || ' · manager console';
    end if;
  end if;
  return case when who is null then '[]'::jsonb else jsonb_build_array(jsonb_build_array('By', who)) end;
end $function$;
revoke all on function public.chat_archive_fields(boolean) from public, anon, authenticated;

-- chat_lead_update_trg / chat_inq_update_trg: archived_at joins the compared columns (so the conversation is touched
-- and open chats refetch the lead) and archiving / unarchiving posts the card
do $mig$
declare
  d text; n text;
  card constant text := E'    if (new.archived_at is null) is distinct from (old.archived_at is null) then\n'
    || E'      insert into chat_messages(convo_id, author_kind, body_html, card)\n'
    || E'      values (cid, ''bot'', '''', jsonb_build_object(''t'', case when new.archived_at is not null then ''🗄 Archived'' else ''↩ Back in Leads'' end,\n'
    || E'        ''f'', chat_archive_fields(new.archived_at is null)));\n'
    || E'    end if;\n';
  tail constant text := E'  exception when others then null;\n  end;\n  return null;\nend';
  once text;
begin
  -- catering leads
  d := pg_get_functiondef('public.chat_lead_update_trg()'::regprocedure);
  if position('archived_at' in d) > 0 then raise exception 'chat_lead_update_trg already mentions archived_at'; end if;
  foreach once in array array['old.budget, old.stage, old.code)', 'new.budget, new.stage, new.code)', tail] loop
    if (length(d) - length(replace(d, once, ''))) / length(once) <> 1 then
      raise exception 'chat_lead_update_trg: % found % times', once, (length(d) - length(replace(d, once, ''))) / length(once);
    end if;
  end loop;
  n := replace(d, 'old.budget, old.stage, old.code)', 'old.budget, old.stage, old.code, old.archived_at)');
  n := replace(n, 'new.budget, new.stage, new.code)', 'new.budget, new.stage, new.code, new.archived_at)');
  n := replace(n, tail, card || tail);
  execute n;

  -- experience inquiries
  d := pg_get_functiondef('public.chat_inq_update_trg()'::regprocedure);
  if position('archived_at' in d) > 0 then raise exception 'chat_inq_update_trg already mentions archived_at'; end if;
  foreach once in array array['old.reservation_code, old.details)', 'new.reservation_code, new.details)', tail] loop
    if (length(d) - length(replace(d, once, ''))) / length(once) <> 1 then
      raise exception 'chat_inq_update_trg: % found % times', once, (length(d) - length(replace(d, once, ''))) / length(once);
    end if;
  end loop;
  n := replace(d, 'old.reservation_code, old.details)', 'old.reservation_code, old.details, old.archived_at)');
  n := replace(n, 'new.reservation_code, new.details)', 'new.reservation_code, new.details, new.archived_at)');
  n := replace(n, tail, card || tail);
  execute n;

  -- the portal home tile's counts for staff without a manager sign-in skip archived leads
  d := pg_get_functiondef('public.portal_catering_pulse(text)'::regprocedure);
  once := 'where p_loc is null or lower(l.location) = lower(p_loc);';
  if (length(d) - length(replace(d, once, ''))) / length(once) <> 1 then raise exception 'portal_catering_pulse: where clause not found once'; end if;
  execute replace(d, once, 'where (p_loc is null or lower(l.location) = lower(p_loc)) and l.archived_at is null;');
end $mig$;
