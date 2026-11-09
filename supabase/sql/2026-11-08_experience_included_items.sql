-- 2026-11-08 — what's in each experience package, listed on the BEO and on the Square sale.
-- Maverick: "experience packages need to have items listed being sold":
--   Fondue — one pot fondue · sausage · apples · cornichons · baguette · potatoes  (one pot per party)
--   Raclette — one burner per person · sliced raclette · Toscano picante · cornichons · potatoes · baguette
--   Greysing Table — 5 cheeses · 3 meats · accoutrements · bread
-- rb_experience_types.includes = [{ "item": text, "per"?: "party" | "guest" }], edited in manager.html
-- (Experiences → Edit → "What's included"). How many:
--   per "party" → 1 · per "guest" → the party size · no per → just listed (qty left blank on the BEO).
-- Used by rb_experience_lead_sync (the BEO menu of a paid booking) and square-experience-pay
-- (each item is a $0 modifier on the Square sale; the total is unchanged).

alter table public.rb_experience_types
  add column if not exists includes jsonb not null default '[]'::jsonb;
alter table public.rb_experience_types drop constraint if exists rb_experience_types_includes_array;
alter table public.rb_experience_types
  add constraint rb_experience_types_includes_array check (jsonb_typeof(includes) = 'array');
comment on column public.rb_experience_types.includes is
  'What the package includes: [{item, per?: party|guest}]. Listed on the BEO menu and as $0 modifiers on the Square sale (2026-11-08).';

update public.rb_experience_types set includes = '[
  {"item": "Raclette burner", "per": "guest"},
  {"item": "Sliced raclette"},
  {"item": "Toscano picante"},
  {"item": "Cornichons"},
  {"item": "Potatoes"},
  {"item": "Baguette"}]'::jsonb
 where name = 'Raclette';
update public.rb_experience_types set includes = '[
  {"item": "Pot of fondue", "per": "party"},
  {"item": "Sausage"},
  {"item": "Apples"},
  {"item": "Cornichons"},
  {"item": "Baguette"},
  {"item": "Potatoes"}]'::jsonb
 where name = 'Fondue';
update public.rb_experience_types set includes = '[
  {"item": "5 cheeses"},
  {"item": "3 meats"},
  {"item": "Accoutrements"},
  {"item": "Bread"}]'::jsonb
 where name = 'Greysing Table';

-- BEO menu rows for a package: {qty, item, notes}, in the order they were entered.
create or replace function public.rb_experience_included_rows(p_includes jsonb, p_party integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'qty',   case e->>'per' when 'guest' then coalesce(p_party::text, '') when 'party' then '1' else '' end,
           'item',  btrim(e->>'item'),
           'notes', case e->>'per' when 'guest' then '1 per guest' else '' end)
         order by o), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_includes) = 'array' then p_includes else '[]'::jsonb end)
         with ordinality as x(e, o)
   where jsonb_typeof(e) = 'object' and nullif(btrim(e->>'item'), '') is not null
$$;
revoke all on function public.rb_experience_included_rows(jsonb, integer) from public, anon, authenticated;

-- Same as before (experience_bookings_to_catering_leads_beo, 2026-11-03) except: the BEO menu is the
-- package row followed by what the package includes.
create or replace function public.rb_experience_lead_sync()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  lid uuid; lcode text; xname text; athome boolean := false; opt text; ttl text;
  st timestamp; en timestamp; tl jsonb; tbl text; inq text; money text; b jsonb; who text := 'FOH';
  inc jsonb := '[]'::jsonb;
begin
  if new.kind is distinct from 'experience' then return null; end if;
  -- never let this block the booking update: any error is logged and swallowed
  begin
    select id into lid from catering_leads where reservation_id = new.id;

    if lid is null then
      -- a booking that has just been paid becomes a lead with a BEO
      if not (new.payment_status = 'paid' and old.payment_status is distinct from 'paid'
              and new.status = 'confirmed' and new.starts_at is not null) then
        return null;
      end if;
      select t.name, coalesce(t.at_home, false), coalesce(t.includes, '[]'::jsonb) into xname, athome, inc
        from rb_experience_types t where t.id = new.experience_type_id;
      xname := coalesce(nullif(btrim(xname), ''), 'Experience');
      opt := nullif(btrim(new.option_label), '');
      ttl := xname || coalesce(' (' || opt || ')', '');
      st := new.starts_at at time zone 'America/Chicago';
      en := new.ends_at at time zone 'America/Chicago';
      money := '$' || to_char(coalesce(new.total_cents, 0) / 100.0, 'FM999,999,990.00');
      select string_agg(distinct n, ', ') into tbl
        from table_holds h, unnest(h.table_names) n
       where h.source = 'experience' and h.source_id = new.id::text and h.status = 'held';
      if athome then who := 'Cheesemonger'; end if;
      tl := jsonb_build_array(
              jsonb_build_object('t', to_char(st - case when athome then interval '60 minutes' else interval '30 minutes' end, 'HH24:MI'),
                                 'what', case when athome then 'Arrive at the guest''s address, set up' else 'Table set + ready' end,
                                 'who', who),
              jsonb_build_object('t', to_char(st, 'HH24:MI'), 'what', 'Guests arrive — ' || xname || ' begins', 'who', who))
         || case when en is not null then jsonb_build_array(jsonb_build_object('t', to_char(en, 'HH24:MI'),
                   'what', case when athome then 'Service ends — break down, pack out' else 'Experience ends — reset table' end,
                   'who', who)) else '[]'::jsonb end;
      b := jsonb_build_object(
        'event_name', ttl,
        'service_style', case when athome then 'At-home experience' else 'Dine-in experience' end,
        'onsite_name', coalesce(new.guest_name, ''),
        'onsite_phone', coalesce(new.phone, ''),
        'guests_expected', new.party_size,
        'guests_guaranteed', new.party_size,
        'guarantee_due', '',
        'prepared_by', 'Online booking',
        'timeline', tl,
        'menu', jsonb_build_array(jsonb_build_object('qty', '1', 'item', ttl, 'notes', 'Party of ' || coalesce(new.party_size::text, '?')))
                || rb_experience_included_rows(inc, new.party_size),
        'dietary', coalesce('Guest notes: ' || nullif(btrim(new.notes), ''), ''),
        'beverage', '',
        'staff', '[]'::jsonb,
        'equipment', '',
        'setup', case when athome then coalesce('At the guest''s address: ' || nullif(btrim(new.event_address), ''), 'At the guest''s address')
                      else coalesce('Tables: ' || tbl, '') end,
        'kitchen_notes', '',
        'foh_notes', 'Booked and paid online · ' || money || ' · confirmation ' || coalesce(new.code, ''));
      select i.code into inq from inquiries i where i.id = new.inquiry_id;
      -- BEO # = the guest's confirmation code when it is free
      lcode := upper(nullif(btrim(new.code), ''));
      if lcode is null or exists (select 1 from catering_leads where code = lcode)
                       or exists (select 1 from inquiries where code = lcode) then
        lcode := upper(substr(md5(gen_random_uuid()::text), 1, 6));
      end if;
      insert into catering_leads(code, name, email, phone, location, event_date, event_time, guests,
                                 fulfillment, address, occasion, stage, unread, last_from, last_message_at,
                                 hide_on_calendar, beo, beo_rev, beo_updated_at, reservation_id)
      values (lcode, coalesce(nullif(btrim(new.guest_name), ''), 'Guest'), nullif(lower(btrim(new.email)), ''),
              nullif(btrim(new.phone), ''), coalesce(nullif(btrim(new.location), ''), 'Memphis'),
              st::date, to_char(st, 'HH24:MI'), new.party_size,
              case when athome then 'onsite' end, case when athome then nullif(btrim(new.event_address), '') end,
              'Experience — ' || ttl, 'paid', true, 'customer', now(),
              true, b, 1, now(), new.id)   -- hidden on the calendar: the booking already has its experience tile
      returning id into lid;
      insert into catering_messages(lead_id, direction, body, sent_by)
      values (lid, 'note',
              '✨ Booked and paid online: ' || ttl || ', ' || to_char(st, 'Dy Mon FMDD, FMHH12:MI AM')
              || ', party of ' || coalesce(new.party_size::text, '?') || ', ' || money
              || ' · confirmation ' || coalesce(new.code, '') || coalesce(' · from inquiry #' || inq, '')
              || '. The BEO is on the 📋 BEO tab.',
              'system');
      return null;
    end if;

    -- the lead exists: keep it in step with the booking
    if new.status in ('cancelled', 'no_show') and old.status not in ('cancelled', 'no_show') then
      update catering_leads set stage = 'lost', last_message_at = now() where id = lid;
      insert into catering_messages(lead_id, direction, body, sent_by)
      values (lid, 'note', 'Experience booking ' || case when new.status = 'no_show' then 'marked no-show' else 'cancelled' end
              || coalesce(' — ' || nullif(btrim(new.cancel_reason), ''), '')
              || case when coalesce(new.refunded_cents, 0) > 0 then ' · refunded $' || to_char(new.refunded_cents / 100.0, 'FM999,999,990.00') else '' end,
              'system');
    elsif coalesce(new.refunded_cents, 0) > coalesce(old.refunded_cents, 0) then
      insert into catering_messages(lead_id, direction, body, sent_by)
      values (lid, 'note', 'Refunded $' || to_char((new.refunded_cents - coalesce(old.refunded_cents, 0)) / 100.0, 'FM999,999,990.00')
              || ' on the experience booking (booking kept)', 'system');
    end if;
    if new.starts_at is distinct from old.starts_at or new.party_size is distinct from old.party_size
       or new.location is distinct from old.location then
      update catering_leads
         set event_date = (new.starts_at at time zone 'America/Chicago')::date,
             event_time = to_char(new.starts_at at time zone 'America/Chicago', 'HH24:MI'),
             guests = new.party_size,
             location = coalesce(nullif(btrim(new.location), ''), location)
       where id = lid;
    end if;
  exception when others then
    raise warning 'rb_experience_lead_sync(%): %', new.id, sqlerrm;
  end;
  return null;
end $function$;

-- Upcoming experience BEOs nobody has edited yet (still rev 1, just the package row) get the list too.
update public.catering_leads l
   set beo = jsonb_set(l.beo, '{menu}', (l.beo->'menu') || public.rb_experience_included_rows(t.includes, r.party_size)),
       beo_rev = l.beo_rev + 1,
       beo_updated_at = now()
  from public.rb_reservations r
  join public.rb_experience_types t on t.id = r.experience_type_id
 where l.reservation_id = r.id
   and l.beo_rev = 1
   and jsonb_typeof(l.beo->'menu') = 'array' and jsonb_array_length(l.beo->'menu') = 1
   and jsonb_array_length(public.rb_experience_included_rows(t.includes, r.party_size)) > 0
   and l.event_date >= (now() at time zone 'America/Chicago')::date
   and l.stage <> 'lost';
