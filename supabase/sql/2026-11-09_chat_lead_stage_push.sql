-- 2026-11-09 — phone / computer notification every time a catering lead changes stage
-- (Maverick: "push notifications for each time a catering lead moves into the next stage, like deposit paid,
-- contract signed").
--
-- Every stage change on catering_leads (customer signs, Square deposit / paid in full, a proposal or invoice
-- going out, a first reply, or someone moving it by hand in Greys Chat or the manager console) queues one
-- push to chat-notify ({stage: …}). chat-notify sends it to the managers on the lead's conversation, with the
-- usual skips (muted, in chat right now, no device) plus whoever moved it.
-- Bulk updates that should stay quiet: set_config('greys.no_notify', 'on', true) first.

-- 1. the push (pg_net → chat-notify, same secret as message pushes)
create or replace function public.chat_stage_notify(p_lead uuid, p_convo uuid, p_from text, p_to text, p_by text, p_by_emp bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare sec text;
begin
  if coalesce(current_setting('greys.no_notify', true), '') in ('on', '1', 'true') then return; end if;
  if p_convo is null or p_to is null or p_from is not distinct from p_to then return; end if;
  select value into sec from app_secrets where name = 'chat_notify_secret';
  if sec is null then return; end if;
  begin
    perform net.http_post(
      url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/chat-notify',
      body := jsonb_build_object('stage', jsonb_build_object('lead', p_lead, 'convo', p_convo, 'from', p_from, 'to', p_to,
                                                             'by', p_by, 'by_emp', p_by_emp)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-chat-secret', sec));
  exception when others then null;
  end;
end $function$;
revoke all on function public.chat_stage_notify(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.chat_stage_notify(uuid, uuid, text, text, text, bigint) to service_role;

-- 2. Greys Chat's stage dropdown also says WHO moved it (employee id), so their own phone stays quiet.
--    chat-api passes the name; it's matched only when exactly one active employee has it.
create or replace function public.chat_lead_set_stage(p_lead uuid, p_stage text, p_by text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare e bigint;
begin
  perform set_config('greys.stage_by', coalesce(nullif(btrim(p_by), ''), 'Greys Chat'), true);
  select min(id) into e from portal_employees
   where active and lower(btrim(name)) = lower(btrim(coalesce(p_by, ''))) having count(*) = 1;
  perform set_config('greys.stage_emp', coalesce(e::text, ''), true);
  update catering_leads set stage = p_stage where id = p_lead and stage is distinct from p_stage;
  perform set_config('greys.stage_by', '', true);
  perform set_config('greys.stage_emp', '', true);
  return true;
end $function$;

-- 3. the lead update trigger: unchanged, plus the push on every stage change
create or replace function public.chat_lead_update_trg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cid uuid; who text; claims jsonb; em text; by_name text; by_emp bigint;
begin
  begin
    select id into cid from chat_convos where lead_id = new.id;
    if cid is null then return null; end if;
    if (old.name, old.company, old.email, old.phone, old.event_date, old.event_time, old.guests, old.fulfillment,
        old.occasion, old.location, old.address, old.budget, old.stage, old.code)
       is distinct from
       (new.name, new.company, new.email, new.phone, new.event_date, new.event_time, new.guests, new.fulfillment,
        new.occasion, new.location, new.address, new.budget, new.stage, new.code) then
      update chat_convos set name = coalesce(nullif(btrim(new.company), ''), new.name), client_name = new.name,
             client_email = nullif(lower(btrim(new.email)), ''), client_phone = chat_e164(new.phone),
             client_tag = chat_lead_kind(new.occasion), client_meta = chat_lead_meta(new)
       where id = cid;
    end if;
    if new.stage is distinct from old.stage then
      who := nullif(current_setting('greys.stage_by', true), '');
      by_name := who;
      begin by_emp := nullif(current_setting('greys.stage_emp', true), '')::bigint; exception when others then by_emp := null; end;
      if who is null then
        begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
        if coalesce(claims ->> 'role', '') = 'authenticated' then
          em := claims ->> 'email';
          by_emp := chat_emp_by_email(em);
          select p.name into by_name from portal_employees p where p.id = by_emp;
          by_name := coalesce(by_name, nullif(em, ''), 'Someone');
          who := by_name || ' · manager console';
        end if;
      end if;
      if who is not null then
        insert into chat_messages(convo_id, author_kind, body_html, card)
        values (cid, 'bot', '', jsonb_build_object('t', '📌 Moved to ' || chat_lead_stage_label(new.stage),
          'f', jsonb_build_array(jsonb_build_array('From', chat_lead_stage_label(old.stage)), jsonb_build_array('By', who))));
      end if;
      -- 2026-11-09: tell the managers' phones (signed, deposit paid, paid in full, proposal / invoice sent, moved by hand …)
      perform chat_stage_notify(new.id, cid, old.stage, new.stage, by_name, by_emp);
    end if;
  exception when others then null;
  end;
  return null;
end $function$;
