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
