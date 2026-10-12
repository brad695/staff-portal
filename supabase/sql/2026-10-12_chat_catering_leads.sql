-- Greys Chat ⇄ catering leads (2026-10-12)
-- Every catering_leads row gets one client conversation in Greys Chat (chat_convos.lead_id), with
-- every active manager as a member. Messages flow both ways:
--   catering_messages → chat_messages   (form, Gmail-synced replies, manager-console replies/notes,
--                                        pipeline notes from the catering function → status cards)
--   chat_messages → catering_messages   (texts, emails and internal notes sent from chat, client texts)
-- Loop guards: rows mirrored from catering carry chat_messages.ext_id 'cat:<catering id>';
-- rows mirrored from chat carry catering_messages.chat_message_id.
-- Stage moves made by a person (chat or manager console) post a "Moved to …" card.

-- ---------- columns, indexes, checks ----------
-- plain uuid links (no FK): a deleted lead leaves an ordinary client conversation behind
alter table public.chat_convos add column if not exists lead_id uuid;
create unique index if not exists chat_convos_lead_uidx on public.chat_convos(lead_id) where lead_id is not null;
alter table public.catering_messages add column if not exists chat_message_id uuid;
create unique index if not exists catering_messages_chat_uidx on public.catering_messages(chat_message_id) where chat_message_id is not null;
create index if not exists chat_messages_ext_idx on public.chat_messages(ext_id) where ext_id is not null;

-- author 'system' = written in the manager console by a shared login (shown as "Manager console");
-- the form message and staff-logged replies have no via, just a subject label.

-- ---------- small helpers ----------
create or replace function public.chat_e164(p text) returns text
language sql immutable set search_path to 'public' as $$
  select case
    when p is null or btrim(p) = '' then null
    when btrim(p) like '+%' then case when regexp_replace(p, '\D', '', 'g') ~ '^\d{8,15}$' then '+' || regexp_replace(p, '\D', '', 'g') end
    when length(regexp_replace(p, '\D', '', 'g')) = 10 then '+1' || regexp_replace(p, '\D', '', 'g')
    when length(regexp_replace(p, '\D', '', 'g')) = 11 and regexp_replace(p, '\D', '', 'g') like '1%' then '+' || regexp_replace(p, '\D', '', 'g')
  end $$;

-- plain text → safe chat HTML (escaped, links, line breaks)
create or replace function public.chat_text_html(p text) returns text
language sql immutable set search_path to 'public' as $$
  select replace(
           regexp_replace(
             replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), E'\r', ''),
             '(https?://[^\s<]+)', '<a href="\1" target="_blank" rel="noopener">\1</a>', 'g'),
           E'\n', '<br>') $$;

-- chat HTML → plain text for the manager console
create or replace function public.chat_html_text(p text) returns text
language sql immutable set search_path to 'public' as $$
  select btrim(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
        '<br\s*/?>', E'\n', 'gi'), '</(li|blockquote|pre|div|p)>', E'\n', 'gi'), '<[^>]+>', '', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
    E' \n') $$;

create or replace function public.chat_lead_stage_label(s text) returns text
language sql immutable set search_path to 'public' as $$
  select coalesce(jsonb_build_object('new','New','replied','Replied','quoted','Quoting','contract_sent','Proposal sent','signed','Signed',
    'invoiced','Invoiced','deposit_paid','Deposit paid','paid','Paid','lost','Lost') ->> s, initcap(replace(coalesce(s, ''), '_', ' '))) $$;

create or replace function public.chat_lead_kind(occ text) returns text
language sql immutable set search_path to 'public' as $$
  select case when occ ~* '^\s*private event' then 'Private event' when occ ~* '^\s*table request' then 'Table request' else 'Catering' end $$;

create or replace function public.chat_lead_when(d date, t text) returns text
language plpgsql stable set search_path to 'public' as $$
declare tt text := '';
begin
  if coalesce(t, '') ~ '^\d{1,2}:\d{2}' then
    begin tt := ' · ' || to_char(t::time, 'FMHH12:MI AM'); exception when others then tt := ' · ' || t; end;
  elsif coalesce(t, '') <> '' then tt := ' · ' || t;
  end if;
  return coalesce(to_char(d, 'Dy Mon FMDD'), 'Date TBD') || tt;
end $$;

create or replace function public.chat_lead_meta(l public.catering_leads) returns text
language sql stable set search_path to 'public' as $$
  select concat_ws(' · ', chat_lead_when(l.event_date, l.event_time),
    case when l.guests is not null then l.guests || ' guests' end,
    case l.fulfillment when 'pickup' then 'Pick-up' when 'delivery' then 'Delivery' when 'onsite' then 'On-site' end) $$;

-- "Brad Barrow <bbearo@x.com>" or "brad@greyscheese.com" → active employee id
create or replace function public.chat_emp_by_email(e text) returns bigint
language sql stable security definer set search_path to 'public' as $$
  select c.employee_id from portal_employee_contacts c join portal_employees p on p.id = c.employee_id and p.active
  where lower(c.email) = lower(substring(coalesce(e, '') from '[^<>\s]+@[^<>\s]+')) limit 1 $$;

create or replace function public.chat_lead_mail_status(st text, err text) returns text
language sql immutable set search_path to 'public' as $$
  select case when st = 'failed' then left('failed: ' || coalesce(err, ''), 200)
              when st in ('sent', 'delivered') then 'sent' else coalesce(st, 'sending') end $$;

-- ---------- one conversation per lead ----------
create or replace function public.chat_lead_convo(p_lead uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
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
      't', case k when 'Private event' then '🥂 New private event inquiry' when 'Table request' then '🍽️ New table request' else '💼 New catering inquiry' end,
      'f', jsonb_build_array(
             jsonb_build_array('When', chat_lead_when(l.event_date, l.event_time)),
             jsonb_build_array('Guests', coalesce(l.guests::text, '—')),
             jsonb_build_array('Service', coalesce(case l.fulfillment when 'pickup' then 'Pick-up' when 'delivery' then 'Delivery' when 'onsite' then 'On-site service' end, '—')),
             jsonb_build_array('Shop', coalesce(initcap(nullif(btrim(l.location), '')), '—')),
             jsonb_build_array('Occasion', coalesce(nullif(btrim(l.occasion), ''), '—')),
             jsonb_build_array('Budget', coalesce(nullif(btrim(l.budget), ''), '—')))
           || case when nullif(btrim(l.address), '') is not null then jsonb_build_array(jsonb_build_array('Address', l.address)) else '[]'::jsonb end
           || jsonb_build_array(jsonb_build_array('Lead', '#' || l.code)),
      'btn', 'Open in manager console',
      'url', 'https://staff.greyscheese.com/manager.html#catering/' || l.code),
    'lead:' || l.id, l.created_at);
  return cid;
end $$;

-- ---------- catering → chat ----------
create or replace function public.chat_lead_mirror(m public.catering_messages) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; l catering_leads; html text; v text; emp bigint; mid uuid; st text;
begin
  if m.chat_message_id is not null then return null; end if;
  if exists (select 1 from chat_messages where ext_id = 'cat:' || m.id) then return null; end if;
  cid := chat_lead_convo(m.lead_id);
  if cid is null then return null; end if;
  select * into l from catering_leads where id = m.lead_id;
  html := chat_text_html(m.body);
  if m.direction = 'in' then
    v := case when m.gmail_id is not null then 'email'
              when m.sent_by in ('logged by staff', 'logged from email') then 'logged'
              when not exists (select 1 from catering_messages x where x.lead_id = m.lead_id and x.direction = 'in'
                               and x.id <> m.id and x.created_at < m.created_at) then 'web'
              else 'email' end;
    insert into chat_messages(convo_id, author_kind, body_html, via, subject, ext_id, created_at)
    values (cid, 'client', html, case when v = 'email' then 'email' end,
            case v when 'web' then 'Inquiry form' when 'logged' then 'Logged by staff from email' end, 'cat:' || m.id, m.created_at)
    returning id into mid;
  elsif m.direction = 'out' then
    emp := chat_emp_by_email(m.sent_by);
    st := case when coalesce(m.email_status, 'sent') = 'sent' then 'delivered' when m.email_status = 'sending' then 'sending' else 'failed' end;
    insert into chat_messages(convo_id, author_kind, emp_id, body_html, via, subject, status, error, ext_id, created_at)
    values (cid, case when emp is null then 'system' else 'staff' end, emp, html, 'email',
            'Re: Your GREYS catering question [#' || l.code || ']', st,
            case when st = 'failed' then left(m.email_status, 300) end, 'cat:' || m.id, m.created_at)
    returning id into mid;
  elsif coalesce(m.sent_by, '') = 'system' then
    insert into chat_messages(convo_id, author_kind, body_html, card, ext_id, created_at)
    values (cid, 'bot', '', jsonb_build_object('t', left(coalesce(m.body, ''), 400), 'f', '[]'::jsonb), 'cat:' || m.id, m.created_at)
    returning id into mid;
  else
    emp := chat_emp_by_email(m.sent_by);
    insert into chat_messages(convo_id, author_kind, emp_id, body_html, is_note, ext_id, created_at)
    values (cid, case when emp is null then 'system' else 'staff' end, emp, html, true, 'cat:' || m.id, m.created_at)
    returning id into mid;
  end if;
  return mid;
end $$;

create or replace function public.chat_lead_msg_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.chat_message_id is null then
    begin perform chat_lead_mirror(new); exception when others then null; end;
  end if;
  return null;
end $$;
create trigger catering_messages_chat after insert on public.catering_messages
  for each row execute function chat_lead_msg_trg();

create or replace function public.chat_lead_insert_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin perform chat_lead_convo(new.id); exception when others then null; end;
  return null;
end $$;
create trigger catering_leads_chat_convo after insert on public.catering_leads
  for each row execute function chat_lead_insert_trg();

-- lead edits → the conversation (name, contact, summary); a person moving the stage → a card
create or replace function public.chat_lead_update_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; who text; claims jsonb; em text;
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
      if who is null then
        begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
        if coalesce(claims ->> 'role', '') = 'authenticated' then
          em := claims ->> 'email';
          select p.name into who from portal_employees p where p.id = chat_emp_by_email(em);
          who := coalesce(who, nullif(em, ''), 'Someone') || ' · manager console';
        end if;
      end if;
      if who is not null then
        insert into chat_messages(convo_id, author_kind, body_html, card)
        values (cid, 'bot', '', jsonb_build_object('t', '📌 Moved to ' || chat_lead_stage_label(new.stage),
          'f', jsonb_build_array(jsonb_build_array('From', chat_lead_stage_label(old.stage)), jsonb_build_array('By', who))));
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
create trigger catering_leads_chat_update after update on public.catering_leads
  for each row execute function chat_lead_update_trg();

-- proposal / invoice changes → the chat refetches that lead (no-op update fires chat_convos_ping)
create or replace function public.chat_lead_quote_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    if tg_op = 'UPDATE' and (old.status, old.total_cents, old.amount_paid_cents, old.invoice_status, old.invoice_url, old.invoice_number,
                             old.signed_at, old.sent_at, old.deposit_pct, old.balance_due_date)
       is not distinct from (new.status, new.total_cents, new.amount_paid_cents, new.invoice_status, new.invoice_url, new.invoice_number,
                             new.signed_at, new.sent_at, new.deposit_pct, new.balance_due_date) then
      return null;
    end if;
    update chat_convos set client_meta = client_meta where lead_id = new.lead_id;
  exception when others then null;
  end;
  return null;
end $$;
create trigger catering_quotes_chat after insert or update on public.catering_quotes
  for each row execute function chat_lead_quote_trg();

-- ---------- chat → catering ----------
create or replace function public.chat_msg_to_lead_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare lid uuid; txt text; fl text; who text;
begin
  if coalesce(new.ext_id, '') like 'cat:%' or coalesce(new.ext_id, '') like 'lead:%' or new.parent_id is not null
     or new.author_kind not in ('staff', 'client') or coalesce(new.also_channel, false) then
    return null;
  end if;
  begin
    select lead_id into lid from chat_convos where id = new.convo_id;
    if lid is null then return null; end if;
    txt := chat_html_text(new.body_html);
    select string_agg(coalesce(f ->> 'name', 'file'), ', ') into fl
      from jsonb_array_elements(case when jsonb_typeof(new.files) = 'array' then new.files else '[]'::jsonb end) f;
    if fl is not null then txt := concat_ws(E'\n', nullif(txt, ''), '📎 ' || fl); end if;
    txt := coalesce(txt, '');
    if new.author_kind = 'client' then
      insert into catering_messages(lead_id, direction, body, sent_by, chat_message_id, created_at)
      values (lid, 'in', case when new.via = 'sms' then '📱 ' || txt else txt end,
              case when new.via = 'sms' then 'text message' else 'Greys Chat' end, new.id, new.created_at);
      update catering_leads set unread = true, last_from = 'customer', last_message_at = new.created_at where id = lid;
    else
      select name into who from portal_employees where id = new.emp_id;
      who := coalesce(who, 'Greys Chat');
      if new.is_note then
        insert into catering_messages(lead_id, direction, body, sent_by, chat_message_id, created_at)
        values (lid, 'note', txt, who, new.id, new.created_at);
      elsif new.via in ('email', 'sms') then
        insert into catering_messages(lead_id, direction, body, sent_by, email_status, chat_message_id, created_at)
        values (lid, 'out', case when new.via = 'sms' then '📱 Text: ' || txt else txt end, who,
                chat_lead_mail_status(new.status, new.error), new.id, new.created_at);
        update catering_leads set stage = case when stage = 'new' then 'replied' else stage end,
               last_from = 'staff', unread = false, last_message_at = new.created_at
         where id = lid;
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
create trigger chat_messages_to_lead after insert on public.chat_messages
  for each row execute function chat_msg_to_lead_trg();

create or replace function public.chat_msg_status_lead_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status is distinct from old.status and new.via in ('email', 'sms') then
    begin
      update catering_messages set email_status = chat_lead_mail_status(new.status, new.error) where chat_message_id = new.id;
    exception when others then null;
    end;
  end if;
  return null;
end $$;
create trigger chat_messages_lead_status after update of status on public.chat_messages
  for each row execute function chat_msg_status_lead_trg();

-- ---------- RPCs for chat-api (service role only) ----------
-- a stage move from chat: the update trigger reads greys.stage_by for the card
create or replace function public.chat_lead_set_stage(p_lead uuid, p_stage text, p_by text) returns boolean
language plpgsql security definer set search_path to 'public' as $$
begin
  perform set_config('greys.stage_by', coalesce(nullif(btrim(p_by), ''), 'Greys Chat'), true);
  update catering_leads set stage = p_stage where id = p_lead and stage is distinct from p_stage;
  perform set_config('greys.stage_by', '', true);
  return true;
end $$;

-- managers are on every lead conversation (run when a manager opens chat)
create or replace function public.chat_lead_join(p_emp bigint) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  insert into chat_members(convo_id, emp_id)
    select c.id, p_emp from chat_convos c
     where c.lead_id is not null and not c.archived and exists (select 1 from catering_leads l where l.id = c.lead_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- the last few top-level messages of each conversation (boot, for conversations quiet for 45 days)
create or replace function public.chat_tail(p_convos uuid[], p_n integer default 25) returns setof public.chat_messages
language sql stable security definer set search_path to 'public' as $$
  select m.* from unnest(p_convos) as u(cid)
  cross join lateral (select * from chat_messages x where x.convo_id = u.cid and x.deleted_at is null and x.parent_id is null
                      order by x.created_at desc limit greatest(1, least(p_n, 100))) m $$;

-- ---------- notifications: never for history (backfills, late mirrors) ----------
create or replace function public.chat_notify_queue() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare sec text;
begin
  if new.author_kind in ('bot', 'system') or coalesce(new.also_channel, false) then return null; end if;
  if new.created_at < now() - interval '10 minutes' then return null; end if;
  select value into sec from app_secrets where name = 'chat_notify_secret';
  begin
    perform net.http_post(
      url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/chat-notify',
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-chat-secret', sec));
  exception when others then null;
  end;
  return null;
end $$;

-- #portal-alerts card now opens the lead's conversation
create or replace function public.chat_alert_catering_lead() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    perform chat_bot_post('portal-alerts', '💼 New catering lead',
      jsonb_build_array(
        jsonb_build_array('Client', coalesce(nullif(new.company, ''), nullif(new.name, ''), '—')),
        jsonb_build_array('When', coalesce(to_char(new.event_date, 'Dy Mon FMDD'), 'Date TBD') || coalesce(' · ' || nullif(new.event_time, ''), '')),
        jsonb_build_array('Guests', coalesce(new.guests::text, '—')),
        jsonb_build_array('Shop', coalesce(initcap(nullif(new.location, '')), '—')),
        jsonb_build_array('Type', coalesce(initcap(nullif(new.fulfillment, '')), '—')),
        jsonb_build_array('Occasion', coalesce(nullif(new.occasion, ''), '—'))),
      'Open conversation', 'https://staff.greyscheese.com/chat.html#lead=' || new.code, '');
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- grants: nothing new is callable from the browser ----------
revoke execute on function public.chat_e164(text), public.chat_text_html(text), public.chat_html_text(text),
  public.chat_lead_stage_label(text), public.chat_lead_kind(text), public.chat_lead_when(date, text),
  public.chat_lead_meta(public.catering_leads), public.chat_emp_by_email(text), public.chat_lead_mail_status(text, text),
  public.chat_lead_convo(uuid), public.chat_lead_mirror(public.catering_messages), public.chat_lead_msg_trg(),
  public.chat_lead_insert_trg(), public.chat_lead_update_trg(), public.chat_lead_quote_trg(), public.chat_msg_to_lead_trg(),
  public.chat_msg_status_lead_trg(), public.chat_lead_set_stage(uuid, text, text), public.chat_lead_join(bigint),
  public.chat_tail(uuid[], integer)
  from public, anon, authenticated;
grant execute on function public.chat_lead_set_stage(uuid, text, text), public.chat_lead_join(bigint), public.chat_tail(uuid[], integer)
  to service_role;
