-- Greys Chat ⇄ experience inquiries (2026-10-12, migration chat_experience_inquiries)
-- Same setup as catering leads (2026-10-12_chat_catering_leads.sql). Every inquiries row (experiences and
-- private events from the inquiry form) gets one client conversation (chat_convos.inquiry_id) with every
-- active manager on it. Messages flow both ways:
--   inquiry_messages → chat_messages   (form message, Gmail-synced replies, manager-console replies, logged
--                                        replies, notes — incl. square-experience-pay's cancel / refund notes)
--   chat_messages → inquiry_messages   (texts, emails and internal notes sent from chat, client texts)
-- A booking link (…?book=…) sent from chat restarts the 48 h hold and moves the stage to Link sent, exactly
-- like a reply from the manager console. Paying online (square-experience-pay → stage 'booked') posts a card.
-- Loop guards: rows mirrored from inquiries carry chat_messages.ext_id 'iqm:<message id>' (intro card
-- 'inq:<inquiry id>'); rows mirrored from chat carry inquiry_messages.chat_message_id.

-- ---------- columns, indexes ----------
-- plain uuid links (no FK): a deleted inquiry leaves an ordinary client conversation behind
alter table public.chat_convos add column if not exists inquiry_id uuid;
create unique index if not exists chat_convos_inquiry_uidx on public.chat_convos(inquiry_id) where inquiry_id is not null;
alter table public.inquiry_messages add column if not exists chat_message_id uuid;
create unique index if not exists inquiry_messages_chat_uidx on public.inquiry_messages(chat_message_id) where chat_message_id is not null;

-- ---------- small helpers ----------
create or replace function public.chat_inq_stage_label(s text) returns text
language sql immutable set search_path to 'public' as $$
  select coalesce(jsonb_build_object('new','New','replied','Replied','link_sent','Link sent','booked','Booked','lost','Lost') ->> s,
                  initcap(replace(coalesce(s, ''), '_', ' '))) $$;

create or replace function public.chat_inq_kind(i public.inquiries) returns text
language sql immutable set search_path to 'public' as $$
  select case when coalesce(i.details ->> 'kind', '') = 'event' then 'Private event' else 'Experience' end $$;

create or replace function public.chat_inq_meta(i public.inquiries) returns text
language sql stable set search_path to 'public' as $$
  select concat_ws(' · ', chat_lead_when(i.preferred_date, i.preferred_time),
    case when i.party_size is not null then i.party_size || ' guests' end,
    case when coalesce(i.details ->> 'kind', '') <> 'event' then coalesce(nullif(btrim(i.experience_name), ''), 'Experience TBD') end) $$;

-- the subject the inquiries function uses, so the customer's reply comes back through the Gmail sync
create or replace function public.chat_inq_subject(i public.inquiries) returns text
language sql immutable set search_path to 'public' as $$
  select 'Re: Your GREYS ' || coalesce(nullif(btrim(i.experience_name), ''), 'experience') || ' question [#' || i.code || ']' $$;

-- ---------- one conversation per inquiry ----------
create or replace function public.chat_inq_convo(p_inq uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; i inquiries; k text; f jsonb;
begin
  select id into cid from chat_convos where inquiry_id = p_inq;
  if cid is not null then return cid; end if;
  select * into i from inquiries where id = p_inq;
  if i.id is null then return null; end if;
  k := chat_inq_kind(i);
  insert into chat_convos(kind, name, client_name, client_phone, client_email, client_via, client_tag, client_meta, inquiry_id, created_at)
  values ('client', i.name, i.name, chat_e164(i.phone), nullif(lower(btrim(i.email)), ''), 'email', k, chat_inq_meta(i), i.id, i.created_at)
  on conflict (inquiry_id) where inquiry_id is not null do nothing
  returning id into cid;
  if cid is null then
    select id into cid from chat_convos where inquiry_id = p_inq;
    return cid;
  end if;
  insert into chat_members(convo_id, emp_id)
    select cid, e.id from portal_employees e where e.active and coalesce(e.role, '') ~* 'manager|owner|admin'
  on conflict do nothing;
  f := case when k = 'Experience' then jsonb_build_array(jsonb_build_array('Experience', coalesce(nullif(btrim(i.experience_name), ''), 'Not sure yet'))) else '[]'::jsonb end
    || jsonb_build_array(
         jsonb_build_array('When', chat_lead_when(i.preferred_date, i.preferred_time)),
         jsonb_build_array('Guests', coalesce(i.party_size::text, '—')),
         jsonb_build_array('Shop', coalesce(initcap(nullif(btrim(i.location), '')), '—')))
    || case when nullif(btrim(i.option_label), '') is not null then jsonb_build_array(jsonb_build_array('Option', i.option_label)) else '[]'::jsonb end
    || case when nullif(btrim(i.event_address), '') is not null then jsonb_build_array(jsonb_build_array('Address', i.event_address)) else '[]'::jsonb end
    || case when i.hold_expires_at is not null then jsonb_build_array(jsonb_build_array('Hold',
         'Held until ' || to_char(i.hold_expires_at at time zone 'America/Chicago', 'Dy Mon FMDD, FMHH12:MI AM'))) else '[]'::jsonb end
    || jsonb_build_array(jsonb_build_array('Inquiry', '#' || i.code));
  insert into chat_messages(convo_id, author_kind, body_html, card, ext_id, created_at)
  values (cid, 'bot', '', jsonb_build_object(
      't', case k when 'Private event' then '🥂 New private event inquiry' else '✨ New experience inquiry' end,
      'f', f,
      'btn', 'Open in manager console',
      'url', 'https://staff.greyscheese.com/manager.html#inquiries/' || i.code),
    'inq:' || i.id, i.created_at);
  return cid;
end $$;

-- ---------- inquiries → chat ----------
create or replace function public.chat_inq_mirror(m public.inquiry_messages) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; i inquiries; html text; v text; emp bigint; mid uuid; st text;
begin
  if m.chat_message_id is not null then return null; end if;
  if exists (select 1 from chat_messages where ext_id = 'iqm:' || m.id) then return null; end if;
  cid := chat_inq_convo(m.inquiry_id);
  if cid is null then return null; end if;
  select * into i from inquiries where id = m.inquiry_id;
  html := chat_text_html(m.body);
  if m.direction = 'in' then
    v := case when m.gmail_id is not null then 'email'
              when m.sent_by in ('logged by staff', 'logged from email') then 'logged'
              when not exists (select 1 from inquiry_messages x where x.inquiry_id = m.inquiry_id and x.direction = 'in'
                               and x.id <> m.id and x.created_at < m.created_at) then 'web'
              else 'email' end;
    insert into chat_messages(convo_id, author_kind, body_html, via, subject, ext_id, created_at)
    values (cid, 'client', html, case when v = 'email' then 'email' end,
            case v when 'web' then 'Inquiry form' when 'logged' then 'Logged by staff from email' end, 'iqm:' || m.id, m.created_at)
    returning id into mid;
  elsif m.direction = 'out' then
    emp := chat_emp_by_email(m.sent_by);
    st := case when coalesce(m.email_status, 'sent') = 'sent' then 'delivered' when m.email_status = 'sending' then 'sending' else 'failed' end;
    insert into chat_messages(convo_id, author_kind, emp_id, body_html, via, subject, status, error, ext_id, created_at)
    values (cid, case when emp is null then 'system' else 'staff' end, emp, html, 'email', chat_inq_subject(i), st,
            case when st = 'failed' then left(m.email_status, 300) end, 'iqm:' || m.id, m.created_at)
    returning id into mid;
  else
    emp := chat_emp_by_email(m.sent_by);
    insert into chat_messages(convo_id, author_kind, emp_id, body_html, is_note, ext_id, created_at)
    values (cid, case when emp is null then 'system' else 'staff' end, emp, html, true, 'iqm:' || m.id, m.created_at)
    returning id into mid;
  end if;
  return mid;
end $$;

create or replace function public.chat_inq_msg_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.chat_message_id is null then
    begin perform chat_inq_mirror(new); exception when others then null; end;
  end if;
  return null;
end $$;
create trigger inquiry_messages_chat after insert on public.inquiry_messages
  for each row execute function chat_inq_msg_trg();

create or replace function public.chat_inq_insert_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin perform chat_inq_convo(new.id); exception when others then null; end;
  return null;
end $$;
create trigger inquiries_chat_convo after insert on public.inquiries
  for each row execute function chat_inq_insert_trg();

-- inquiry edits → the conversation; a person moving the stage → a card; paid online → a "Booked" card
create or replace function public.chat_inq_update_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; who text; claims jsonb; em text; rcode text; rcents integer; rstart timestamptz;
begin
  begin
    select id into cid from chat_convos where inquiry_id = new.id;
    if cid is null then return null; end if;
    if (old.name, old.email, old.phone, old.preferred_date, old.preferred_time, old.party_size, old.experience_name, old.location,
        old.option_label, old.event_address, old.stage, old.code, old.hold_expires_at, old.reservation_id, old.reservation_code, old.details)
       is distinct from
       (new.name, new.email, new.phone, new.preferred_date, new.preferred_time, new.party_size, new.experience_name, new.location,
        new.option_label, new.event_address, new.stage, new.code, new.hold_expires_at, new.reservation_id, new.reservation_code, new.details) then
      update chat_convos set name = new.name, client_name = new.name,
             client_email = nullif(lower(btrim(new.email)), ''), client_phone = chat_e164(new.phone),
             client_tag = chat_inq_kind(new), client_meta = chat_inq_meta(new)
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
        values (cid, 'bot', '', jsonb_build_object('t', '📌 Moved to ' || chat_inq_stage_label(new.stage),
          'f', jsonb_build_array(jsonb_build_array('From', chat_inq_stage_label(old.stage)), jsonb_build_array('By', who))));
      elsif new.stage = 'booked' then
        -- paid online through the booking link (square-experience-pay)
        select x.code, x.total_cents, x.starts_at into rcode, rcents, rstart from rb_reservations x where x.id = new.reservation_id;
        insert into chat_messages(convo_id, author_kind, body_html, card)
        values (cid, 'bot', '', jsonb_build_object('t', '🎉 Booked and paid online',
          'f', case when rcents is not null then jsonb_build_array(jsonb_build_array('Paid', '$' || to_char(rcents / 100.0, 'FM999,999,990.00'))) else '[]'::jsonb end
            || case when rstart is not null then jsonb_build_array(jsonb_build_array('When', to_char(rstart at time zone 'America/Chicago', 'Dy Mon FMDD · FMHH12:MI AM'))) else '[]'::jsonb end
            || case when rcode is not null then jsonb_build_array(jsonb_build_array('Reservation', '#' || rcode)) else '[]'::jsonb end));
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
create trigger inquiries_chat_update after update on public.inquiries
  for each row execute function chat_inq_update_trg();

-- a held / booked reservation changing (paid, cancelled, refunded, hold restarted or expired) → open chats refetch it
create or replace function public.chat_inq_res_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.inquiry_id is null then return null; end if;
  begin
    if (old.status, old.payment_status, old.total_cents, old.refunded_cents, old.hold_expires_at, old.starts_at)
       is not distinct from (new.status, new.payment_status, new.total_cents, new.refunded_cents, new.hold_expires_at, new.starts_at) then
      return null;
    end if;
    update chat_convos set client_meta = client_meta where inquiry_id = new.inquiry_id;
  exception when others then null;
  end;
  return null;
end $$;
create trigger rb_reservations_chat after update on public.rb_reservations
  for each row execute function chat_inq_res_trg();

-- ---------- chat → inquiries ----------
create or replace function public.chat_msg_to_inq_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare iid uuid; txt text; fl text; who text; i inquiries; hold_until timestamptz; rid uuid;
begin
  if coalesce(new.ext_id, '') like 'iqm:%' or coalesce(new.ext_id, '') like 'inq:%' or new.parent_id is not null
     or new.author_kind not in ('staff', 'client') or coalesce(new.also_channel, false) then
    return null;
  end if;
  begin
    select inquiry_id into iid from chat_convos where id = new.convo_id;
    if iid is null then return null; end if;
    txt := chat_html_text(new.body_html);
    select string_agg(coalesce(f ->> 'name', 'file'), ', ') into fl
      from jsonb_array_elements(case when jsonb_typeof(new.files) = 'array' then new.files else '[]'::jsonb end) f;
    if fl is not null then txt := concat_ws(E'\n', nullif(txt, ''), '📎 ' || fl); end if;
    txt := coalesce(txt, '');
    if new.author_kind = 'client' then
      insert into inquiry_messages(inquiry_id, direction, body, sent_by, chat_message_id, created_at)
      values (iid, 'in', case when new.via = 'sms' then '📱 ' || txt else txt end,
              case when new.via = 'sms' then 'text message' else 'Greys Chat' end, new.id, new.created_at);
      update inquiries set unread = true, last_from = 'customer', last_message_at = new.created_at where id = iid;
    else
      select name into who from portal_employees where id = new.emp_id;
      who := coalesce(who, 'Greys Chat');
      if new.is_note then
        insert into inquiry_messages(inquiry_id, direction, body, sent_by, chat_message_id, created_at)
        values (iid, 'note', txt, who, new.id, new.created_at);
      elsif new.via in ('email', 'sms') then
        insert into inquiry_messages(inquiry_id, direction, body, sent_by, email_status, chat_message_id, created_at)
        values (iid, 'out', case when new.via = 'sms' then '📱 Text: ' || txt else txt end, who,
                chat_lead_mail_status(new.status, new.error), new.id, new.created_at);
        if coalesce(new.body_html, '') ~ '[?&]book=' or txt ~ '[?&]book=' then
          -- a booking link restarts their 48 h hold, like a reply from the manager console
          select * into i from inquiries where id = iid;
          if i.reservation_id is not null then
            hold_until := now() + interval '48 hours';
            update rb_reservations set hold_expires_at = hold_until where id = i.reservation_id and status = 'pending' returning id into rid;
            if rid is not null then update inquiries set hold_expires_at = hold_until where id = iid; end if;
          end if;
          update inquiries set stage = 'link_sent', last_from = 'staff', unread = false, last_message_at = new.created_at where id = iid;
        else
          update inquiries set stage = case when stage = 'new' then 'replied' else stage end,
                 last_from = 'staff', unread = false, last_message_at = new.created_at
           where id = iid;
        end if;
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
create trigger chat_messages_to_inq after insert on public.chat_messages
  for each row execute function chat_msg_to_inq_trg();

-- delivery status of a text / email sent from chat → the console's copy (catering and inquiries)
create or replace function public.chat_msg_status_lead_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status is distinct from old.status and new.via in ('email', 'sms') then
    begin
      update catering_messages set email_status = chat_lead_mail_status(new.status, new.error) where chat_message_id = new.id;
      update inquiry_messages set email_status = chat_lead_mail_status(new.status, new.error) where chat_message_id = new.id;
    exception when others then null;
    end;
  end if;
  return null;
end $$;

-- ---------- RPCs for chat-api (service role only) ----------
create or replace function public.chat_inq_set_stage(p_inq uuid, p_stage text, p_by text) returns boolean
language plpgsql security definer set search_path to 'public' as $$
begin
  perform set_config('greys.stage_by', coalesce(nullif(btrim(p_by), ''), 'Greys Chat'), true);
  update inquiries set stage = p_stage where id = p_inq and stage is distinct from p_stage;
  perform set_config('greys.stage_by', '', true);
  return true;
end $$;

-- managers are on every lead and inquiry conversation (run when a manager opens chat)
create or replace function public.chat_lead_join(p_emp bigint) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  insert into chat_members(convo_id, emp_id)
    select c.id, p_emp from chat_convos c
     where not c.archived
       and ((c.lead_id is not null and exists (select 1 from catering_leads l where l.id = c.lead_id))
         or (c.inquiry_id is not null and exists (select 1 from inquiries q where q.id = c.inquiry_id)))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- #portal-alerts card for a new experience / private event inquiry (opens its conversation)
create or replace function public.chat_alert_inquiry() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    perform chat_bot_post('portal-alerts',
      case when coalesce(new.details ->> 'kind', '') = 'event' then '🥂 New private event inquiry' else '✨ New experience inquiry' end,
      jsonb_build_array(
        jsonb_build_array('Client', coalesce(nullif(btrim(new.name), ''), '—')),
        jsonb_build_array('Experience', coalesce(nullif(btrim(new.experience_name), ''), 'Not sure yet')),
        jsonb_build_array('When', chat_lead_when(new.preferred_date, new.preferred_time)),
        jsonb_build_array('Guests', coalesce(new.party_size::text, '—')),
        jsonb_build_array('Shop', coalesce(initcap(nullif(btrim(new.location), '')), '—'))),
      'Open conversation', 'https://staff.greyscheese.com/chat.html#lead=' || new.code, '');
  exception when others then null;
  end;
  return null;
end $$;
create trigger inquiries_chat_alert after insert on public.inquiries
  for each row execute function chat_alert_inquiry();

-- ---------- grants: nothing new is callable from the browser ----------
revoke execute on function public.chat_inq_stage_label(text), public.chat_inq_kind(public.inquiries), public.chat_inq_meta(public.inquiries),
  public.chat_inq_subject(public.inquiries), public.chat_inq_convo(uuid), public.chat_inq_mirror(public.inquiry_messages),
  public.chat_inq_msg_trg(), public.chat_inq_insert_trg(), public.chat_inq_update_trg(), public.chat_inq_res_trg(),
  public.chat_msg_to_inq_trg(), public.chat_inq_set_stage(uuid, text, text), public.chat_alert_inquiry()
  from public, anon, authenticated;
grant execute on function public.chat_inq_set_stage(uuid, text, text) to service_role;
