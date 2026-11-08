-- Greys Chat: the inquiry form's donation requests and "Just Ask Us a Question" (Maverick 2026-11-08) are their own
-- lead kinds. Both arrive as catering_leads with occasion "Donation request" / "Question" and no date, guests or service,
-- so their cards show who and which shop instead of "Date TBD · — · —", and say what they are instead of "catering".
-- (chat.html KIND_ORDER has the two kinds for the Leads filter.)

create or replace function public.chat_lead_kind(occ text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when occ ~* '^\s*private event' then 'Private event'
              when occ ~* '^\s*table request' then 'Table request'
              when occ ~* '^\s*experience' then 'Experience'
              when occ ~* '^\s*donation' then 'Donation request'
              when occ ~* '^\s*question\M' then 'Question'
              else 'Catering' end
$function$;

-- #portal-alerts
create or replace function public.chat_alert_catering_lead()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare k text;
begin
  begin
    k := chat_lead_kind(new.occasion);
    perform chat_bot_post('portal-alerts',
      case k when 'Experience' then '✨ New experience booking' when 'Question' then '❓ New question'
             when 'Donation request' then '🎁 New donation request' else '💼 New catering lead' end,
      case when k in ('Question', 'Donation request') then
        jsonb_build_array(
          jsonb_build_array('Client', coalesce(nullif(new.company, ''), nullif(new.name, ''), '—')),
          jsonb_build_array('Shop', coalesce(initcap(nullif(new.location, '')), '—')))
      else
        jsonb_build_array(
          jsonb_build_array('Client', coalesce(nullif(new.company, ''), nullif(new.name, ''), '—')),
          jsonb_build_array('When', coalesce(to_char(new.event_date, 'Dy Mon FMDD'), 'Date TBD') || coalesce(' · ' || nullif(new.event_time, ''), '')),
          jsonb_build_array('Guests', coalesce(new.guests::text, '—')),
          jsonb_build_array('Shop', coalesce(initcap(nullif(new.location, '')), '—')),
          jsonb_build_array('Type', coalesce(initcap(nullif(new.fulfillment, '')), '—')),
          jsonb_build_array('Occasion', coalesce(nullif(new.occasion, ''), '—')))
      end,
      'Open conversation', 'https://staff.greyscheese.com/chat#lead=' || new.code, '');
  exception when others then null;
  end;
  return null;
end $function$;

-- the lead's conversation and its first card
create or replace function public.chat_lead_convo(p_lead uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare cid uuid; l catering_leads; k text;
begin
  select id into cid from chat_convos where lead_id = p_lead;
  if cid is not null then return cid; end if;
  select * into l from catering_leads where id = p_lead;
  if l.id is null then return null; end if;
  k := chat_lead_kind(l.occasion);
  insert into chat_convos(kind, name, client_name, client_phone, client_email, client_via, client_tag, client_meta, lead_id, created_at)
  values ('client', coalesce(nullif(btrim(l.company), ''), l.name), l.name, chat_e164(l.phone), nullif(lower(btrim(l.email)), ''),
          'email', k, chat_lead_meta(l), l.id, l.created_at)
  on conflict (lead_id) where lead_id is not null do nothing
  returning id into cid;
  if cid is null then
    select id into cid from chat_convos where lead_id = p_lead;
    return cid;
  end if;
  insert into chat_members(convo_id, emp_id)
    select cid, e.id from portal_employees e where e.active and coalesce(e.role, '') ~* 'manager|owner|admin'
  on conflict do nothing;
  insert into chat_messages(convo_id, author_kind, body_html, card, ext_id, created_at)
  values (cid, 'bot', '', jsonb_build_object(
      't', case k when 'Private event' then '🥂 New private event inquiry' when 'Table request' then '🍽️ New table request' when 'Experience' then '✨ Experience booked'
                  when 'Question' then '❓ New question' when 'Donation request' then '🎁 New donation request' else '💼 New catering inquiry' end,
      'f', case when k in ('Question', 'Donation request') then
             jsonb_build_array(
               jsonb_build_array('Shop', coalesce(initcap(nullif(btrim(l.location), '')), '—')),
               jsonb_build_array('Lead', '#' || l.code))
           else
             jsonb_build_array(
               jsonb_build_array('When', chat_lead_when(l.event_date, l.event_time)),
               jsonb_build_array('Guests', coalesce(l.guests::text, '—')),
               jsonb_build_array('Service', coalesce(case l.fulfillment when 'pickup' then 'Pick-up' when 'delivery' then 'Delivery' when 'onsite' then 'On-site service' end, '—')),
               jsonb_build_array('Shop', coalesce(initcap(nullif(btrim(l.location), '')), '—')),
               jsonb_build_array('Occasion', coalesce(nullif(btrim(l.occasion), ''), '—')),
               jsonb_build_array('Budget', coalesce(nullif(btrim(l.budget), ''), '—')))
             || case when nullif(btrim(l.address), '') is not null then jsonb_build_array(jsonb_build_array('Address', l.address)) else '[]'::jsonb end
             || jsonb_build_array(jsonb_build_array('Lead', '#' || l.code))
           end,
      'btn', 'Open in manager console',
      'url', 'https://staff.greyscheese.com/manager#catering/' || l.code),
    'lead:' || l.id, l.created_at);
  return cid;
end $function$;

-- the form's first message in the conversation: no "When: Date TBD" and no repeated "Occasion: Question"
create or replace function public.chat_form_html_lead(l catering_leads, body text)
 returns text
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare t record; occ text; lines text[]; ans text[]; svc boolean; undated boolean;
begin
  select * into t from chat_form_tail(body);
  -- the form's own "Time:" line repeats When; its own "Service:" line says more than the column
  ans := array(select a from unnest(t.answers) with ordinality u(a, n)
                where not (a like '<b>Time:</b>%' and nullif(btrim(coalesce(l.event_time, '')), '') is not null) order by n);
  svc := exists (select 1 from unnest(ans) a where a like '<b>Service:</b>%');
  occ := btrim(regexp_replace(coalesce(l.occasion, ''), '^\s*(private event|table request|donation request|question)\M\s*[—-]?\s*', '', 'i'));
  undated := l.event_date is null and chat_lead_kind(l.occasion) in ('Question', 'Donation request');
  lines := array_remove(array[
    chat_form_line('Kind', chat_lead_kind(l.occasion)),
    chat_form_line('Location', case when nullif(btrim(l.location), '') is not null then 'GREYS ' || initcap(btrim(l.location)) end),
    chat_form_line('When', case when not undated then chat_lead_when(l.event_date, l.event_time) end),
    chat_form_line('Guests', l.guests::text),
    chat_form_line('Service', case when not svc then case l.fulfillment when 'pickup' then 'Pick-up' when 'delivery' then 'Delivery' when 'onsite' then 'On-site service' end end),
    chat_form_line('Address', l.address),
    chat_form_line('Occasion', occ),
    chat_form_line('Budget', l.budget),
    chat_form_line('Company', l.company),
    chat_form_line('Phone', chat_form_phone(l.phone)),
    chat_form_line('Email', l.email)
  ], null) || ans;
  if t.typed <> '' then lines := lines || ('<b>Message:</b> ' || chat_text_html(t.typed)); end if;
  return array_to_string(lines, '<br>');
end $function$;
