-- 2026-11-21 — new Wix table reservations + paid experience bookings post to #memphis / #nashville in Greys Chat,
-- with a phone push to everyone in that channel (Maverick: "reservations and experiences need to be added to the
-- chat so staff can get notifications").
-- Posts are bot cards with card.alert = true; chat-notify pushes those to every unmuted channel member.
-- Wix side: the booking-alerts edge function (cron every 2 min) calls chat_booking_post for each new reservation.
-- Experience side: trigger on rb_reservations when a production experience becomes paid.
-- One post per booking: chat_messages.ext_id ('wix:<id>' / 'exp:<id>').

create or replace function public.chat_booking_post(p_loc text, p_ext text, p_title text, p_fields jsonb, p_at timestamptz default now())
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare cid uuid; mid uuid;
begin
  if p_ext is null or exists (select 1 from chat_messages where ext_id = p_ext) then return null; end if;
  select id into cid from chat_convos where kind = 'channel' and not archived and name = lower(btrim(coalesce(p_loc, '')));
  if cid is null then return null; end if;
  insert into chat_messages(convo_id, author_kind, body_html, card, ext_id, created_at)
  values (cid, 'bot', '', jsonb_build_object('t', p_title, 'f', coalesce(p_fields, '[]'::jsonb), 'alert', true), p_ext, coalesce(p_at, now()))
  returning id into mid;
  return mid;
end $$;
revoke all on function public.chat_booking_post(text, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.chat_booking_post(text, text, text, jsonb, timestamptz) to service_role;

create or replace function public.chat_exp_booking_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare x text; f jsonb;
begin
  if new.kind <> 'experience' or new.status <> 'confirmed' or new.payment_status <> 'paid'
     or coalesce(new.payment_env, 'production') <> 'production' then return null; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return null; end if;
  select name into x from rb_experience_types where id = new.experience_type_id;
  f := jsonb_build_array(
        jsonb_build_array('Experience', coalesce(x, 'Experience') || coalesce(' · ' || nullif(btrim(new.option_label), ''), '')),
        jsonb_build_array('When', coalesce(to_char(new.starts_at at time zone 'America/Chicago', 'Dy Mon FMDD, FMHH12:MI AM'), '—')),
        jsonb_build_array('Guest', coalesce(nullif(btrim(new.guest_name), ''), '—')),
        jsonb_build_array('Party', coalesce(new.party_size::text, '—')));
  if coalesce(new.total_cents, 0) > 0 then
    f := f || jsonb_build_array(jsonb_build_array('Paid', '$' || to_char(coalesce(nullif(new.paid_cents, 0), new.total_cents) / 100.0, 'FM999,990.00')));
  end if;
  if nullif(btrim(new.event_address), '') is not null then f := f || jsonb_build_array(jsonb_build_array('Address', new.event_address)); end if;
  perform chat_booking_post(new.location, 'exp:' || new.id, '✨ New experience booked', f, now());
  return null;
exception when others then return null;
end $$;

drop trigger if exists rb_reservations_chat_exp on public.rb_reservations;
create trigger rb_reservations_chat_exp after insert or update of payment_status, status on public.rb_reservations
  for each row execute function public.chat_exp_booking_trg();

select cron.schedule('chat-booking-alerts', '*/2 * * * *', $c$
  select net.http_post(url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/booking-alerts',
    body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json',
      'x-chat-secret', (select value from app_secrets where name = 'chat_notify_secret')), timeout_milliseconds := 30000)
$c$);

-- the insert trigger skipped every bot message; let alert cards through
create or replace function public.chat_notify_queue() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare sec text;
begin
  if (new.author_kind in ('bot', 'system') and not coalesce((new.card->>'alert')::boolean, false))
     or coalesce(new.also_channel, false) then return null; end if;
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
end $function$;
