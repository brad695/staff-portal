-- 2026-11-14 — Jackie's experience fixes (Maverick forwarded her list):
--   · Greysing Table and Raclette: 6 guests = $350 … 12 guests = $700; every guest in between is $58.33 (350 ÷ 6),
--     so 7 = $408.33. rb_experience_quote now prices "per N guests" by the guest (price × party ÷ N, to the cent)
--     instead of by whole groups of N (7 guests used to pay for two tables, $700).
--   · Fondue: 2, 4, 6 or 8 guests (booked by twos), $125 for every 2 — rb_experience_types.party_step = 2, max 8.
--   · Raclette at Home: 20 guests and up.
--   · A chocolate fondue add-on, $12.95 per guest, on any experience — rb_experience_types.addons; what a booking took
--     rides on rb_reservations.addons / addons_cents (total_cents = the package + add-ons, before gratuity and tax).
--   · Nashville Sundays: experiences start 12:30 – 4:00 PM (the shop closes at 6).
--   · Holidays: Nov 26, Nov 27, Dec 25, Dec 26 and Jan 1 are in rb_settings.closures too (Wix already closes them;
--     this keeps them closed even if the Wix copy ever stops refreshing).
-- The big functions change only by the lines inserted or replaced below: each anchor must be found exactly once,
-- or the whole migration stops.

-- 1. columns ------------------------------------------------------------------------------------------------------
alter table public.rb_experience_types add column if not exists party_step int not null default 1;
alter table public.rb_experience_types add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.rb_reservations add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.rb_reservations add column if not exists addons_cents int not null default 0;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'rb_experience_types_party_step_chk') then
    alter table public.rb_experience_types add constraint rb_experience_types_party_step_chk check (party_step between 1 and 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rb_experience_types_addons_chk') then
    alter table public.rb_experience_types add constraint rb_experience_types_addons_chk check (jsonb_typeof(addons) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rb_reservations_addons_chk') then
    alter table public.rb_reservations add constraint rb_reservations_addons_chk check (jsonb_typeof(addons) = 'array' and addons_cents >= 0);
  end if;
end $c$;
comment on column public.rb_experience_types.party_step is
  'Guests book in steps of this many from min_party (Fondue: 2 → 2, 4, 6, 8). 1 = any number.';
comment on column public.rb_experience_types.addons is
  'Extras a guest can add when booking: [{key, label, price_cents, per: guest|party}] (chocolate fondue, $12.95 per guest).';
comment on column public.rb_reservations.addons is
  'The add-ons this booking took: [{key, label, price_cents, per, qty, total_cents}]. total_cents includes them.';
comment on column public.rb_reservations.addons_cents is
  'What the add-ons cost (already inside total_cents; gratuity and tax are on top of total_cents).';

-- 2. helpers ------------------------------------------------------------------------------------------------------
-- "2, 4, 6 or 8 guests" for an experience booked in steps (the error guests see), "parties of 2 to 12" otherwise
create or replace function public.rb_party_sizes(p_min int, p_max int, p_step int)
returns text language sql immutable set search_path to 'public' as $f$
  select case
    when coalesce(p_step, 1) <= 1 then format('parties of %s to %s', p_min, p_max)
    when (p_max - p_min) / p_step >= 7 then format('parties of %s to %s, in steps of %s', p_min, p_max, p_step)
    else (select regexp_replace(string_agg(n::text, ', ' order by n), ', (\d+)$', ' or \1')
            from generate_series(p_min, p_max, p_step) n) || ' guests'
  end
$f$;

-- The price (before gratuity and tax). Per person; per N guests — charged by the guest, price × party ÷ N to the cent
-- (2026-11-14: Greysing / Raclette $350 for 6 → $408.33 for 7 → $700 for 12; Fondue $125 per 2); or per party.
create or replace function public.rb_experience_quote(p_experience uuid, p_party integer, p_option text default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare x record; base int; opt jsonb := null; total int;
begin
  select * into x from rb_experience_types where id = p_experience;
  if not found then return jsonb_build_object('ok', false, 'error', 'Experience not found'); end if;
  base := x.price_cents;
  if jsonb_typeof(x.options) = 'array' and jsonb_array_length(x.options) > 0 then
    select o into opt from jsonb_array_elements(x.options) o where o->>'key' = coalesce(p_option, '') limit 1;
    if opt is null then
      return jsonb_build_object('ok', false, 'error',
        'Pick ' || (select string_agg(o->>'label', ' or ') from jsonb_array_elements(x.options) o) || '.');
    end if;
    base := (opt->>'price_cents')::int;
  end if;
  total := case when x.per_person then base * p_party
                when coalesce(x.price_unit_guests, 0) > 0 then round(base::numeric * p_party / x.price_unit_guests)::int
                else base end;
  return jsonb_build_object('ok', true, 'total_cents', total, 'unit_cents', base,
                            'option_key', opt->>'key', 'option_label', opt->>'label');
end $f$;

-- The add-ons a guest picked, priced: per guest × the party, or once for the party. An unknown key is refused.
-- square-experience-pay and the inquiries function store the answer on the reservation (service role only).
create or replace function public.rb_experience_addons(p_experience uuid, p_party integer, p_keys text[])
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare x record; want text[]; a jsonb; items jsonb := '[]'::jsonb; cents int := 0; qty int; line int; k text;
begin
  select id, name, addons into x from rb_experience_types where id = p_experience;
  if not found then return jsonb_build_object('ok', false, 'error', 'Experience not found'); end if;
  select coalesce(array_agg(distinct btrim(u)), '{}') into want
    from unnest(coalesce(p_keys, '{}'::text[])) u where nullif(btrim(u), '') is not null;
  foreach k in array want loop
    if not exists (select 1 from jsonb_array_elements(coalesce(x.addons, '[]'::jsonb)) e where e->>'key' = k) then
      return jsonb_build_object('ok', false, 'error',
        format('That add-on isn''t available for the %s anymore. Refresh the page and try again.', x.name));
    end if;
  end loop;
  for a in select e from jsonb_array_elements(coalesce(x.addons, '[]'::jsonb)) e where e->>'key' = any(want) loop
    qty := case when a->>'per' = 'party' then 1 else greatest(coalesce(p_party, 1), 1) end;
    line := coalesce((a->>'price_cents')::int, 0) * qty;
    items := items || jsonb_build_array(jsonb_build_object('key', a->>'key', 'label', a->>'label',
      'price_cents', coalesce((a->>'price_cents')::int, 0), 'per', case when a->>'per' = 'party' then 'party' else 'guest' end,
      'qty', qty, 'total_cents', line));
    cents := cents + line;
  end loop;
  return jsonb_build_object('ok', true, 'items', items, 'cents', cents);
end $f$;
revoke all on function public.rb_experience_addons(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.rb_experience_addons(uuid, integer, text[]) to service_role;

-- BEO menu rows for a booking's add-ons (rb_experience_lead_sync): "6 · Chocolate fondue · Add-on, 1 per guest"
create or replace function public.rb_experience_addon_rows(p_addons jsonb)
returns jsonb language sql immutable set search_path to 'public' as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
           'qty', coalesce(a->>'qty', '1'), 'item', a->>'label',
           'notes', 'Add-on' || case when a->>'per' = 'guest' then ', 1 per guest' else '' end) order by ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_addons) = 'array' then p_addons else '[]'::jsonb end) with ordinality t(a, ord)
   where nullif(btrim(a->>'label'), '') is not null
$f$;
-- " + chocolate fondue $77.70" for the BEO's money line
create or replace function public.rb_experience_addon_money(p_addons jsonb)
returns text language sql immutable set search_path to 'public' as $f$
  select coalesce(string_agg(' + ' || lower(a->>'label') || ' $' || to_char(coalesce((a->>'total_cents')::numeric, 0) / 100.0, 'FM999,999,990.00'), '' order by ord), '')
    from jsonb_array_elements(case when jsonb_typeof(p_addons) = 'array' then p_addons else '[]'::jsonb end) with ordinality t(a, ord)
   where nullif(btrim(a->>'label'), '') is not null
$f$;
revoke all on function public.rb_experience_addon_rows(jsonb) from public, anon, authenticated;
revoke all on function public.rb_experience_addon_money(jsonb) from public, anon, authenticated;

-- The start times an experience can be ASKED for that day (a request-only one: Build a Board, Raclette at Home):
-- the same hours rule rb_get_availability uses — experience_rules.<Shop>.hours, else rb_settings.hours;
-- experience_earliest; slot_interval_min — with nothing checked or held. closed = rb_day_closed.
create or replace function public.rb_experience_start_times(p_location text, p_date date, p_experience uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare s jsonb; loc text; rules jsonb; windows jsonb; win jsonb; t time; t_end time;
        earliest time := '00:00'; step int; times jsonb := '[]'::jsonb;
begin
  if p_date is null then return jsonb_build_object('ok', false, 'error', 'Pick a date.'); end if;
  select data into s from rb_settings where id = 1;
  loc := coalesce(nullif(trim(p_location), ''), s->>'location');
  if rb_day_closed(loc, p_date, p_experience) then
    return jsonb_build_object('ok', true, 'closed', true, 'location', loc, 'times', '[]'::jsonb);
  end if;
  rules := coalesce(s->'experience_rules'->loc, '{}'::jsonb);
  windows := coalesce(rules->'hours'->(extract(dow from p_date)::int::text),
                      s->'hours'->(extract(dow from p_date)::int::text), '[]'::jsonb);
  if jsonb_typeof(windows) <> 'array' then windows := '[]'::jsonb; end if;
  if p_experience is not null then earliest := coalesce(nullif(s->>'experience_earliest', ''), '00:00')::time; end if;
  step := greatest(coalesce((s->>'slot_interval_min')::int, 30), 5);
  for win in select * from jsonb_array_elements(windows) loop
    t := (win->>0)::time;
    t_end := (win->>1)::time;
    while t <= t_end loop
      if t >= earliest then times := times || to_jsonb(to_char(t, 'HH24:MI')); end if;
      exit when t + make_interval(mins => step) <= t; -- past midnight
      t := t + make_interval(mins => step);
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'closed', jsonb_array_length(times) = 0, 'location', loc, 'times', times);
end $f$;
revoke all on function public.rb_experience_start_times(text, date, uuid) from public;
grant execute on function public.rb_experience_start_times(text, date, uuid) to anon, authenticated, service_role;

-- 3. booked by twos: rb_get_availability + rb_create_experience_v2 refuse a party that isn't a step ---------------
do $g$
declare
  anchor constant text := 'format(''%s is for parties of %s to %s.'', x.name, x.min_party, x.max_party));';
  fn text; src text; n int; p int; q int; at int; ins text;
begin
  foreach fn in array array['public.rb_get_availability(date,integer,text,uuid)',
                            'public.rb_create_experience_v2(uuid,date,text,integer,text,text,text,text,text,text,text)'] loop
    src := pg_get_functiondef(fn::regprocedure);
    if position('rb_party_sizes(' in src) > 0 then continue; end if; -- already in
    n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
    if n <> 1 then raise exception '% : party anchor found % times', fn, n; end if;
    p := position(anchor in src);
    q := position('end if;' in substr(src, p + length(anchor)));
    if q = 0 then raise exception '% : no end if after the party anchor', fn; end if;
    at := p + length(anchor) + q - 1 + length('end if;') - 1; -- the last character of that end if;
    ins := E'\n' ||
      E'  -- booked in steps (2026-11-14, Fondue: "2, 4, 6 or 8 guests")\n' ||
      E'  if coalesce(x.party_step, 1) > 1 and (p_party - x.min_party) % x.party_step <> 0 then\n' ||
      E'    return jsonb_build_object(''ok'', false, ''error'',\n' ||
      E'      format(''%s is for %s.'', x.name, rb_party_sizes(x.min_party, x.max_party, x.party_step)));\n' ||
      E'  end if;';
    src := substr(src, 1, at) || ins || substr(src, at + 1);
    execute src;
  end loop;
end $g$;

-- 4. the BEO lists the add-ons, and its money line splits them out --------------------------------------------------
do $g$
declare
  a1 constant text := 'then '' ($'' || to_char(coalesce(new.total_cents, 0) / 100.0, ''FM999,999,990.00'')';
  r1 constant text := 'then '' ($'' || to_char((coalesce(new.total_cents, 0) - coalesce(new.addons_cents, 0)) / 100.0, ''FM999,999,990.00'') || rb_experience_addon_money(new.addons)';
  a2 constant text := '|| rb_experience_included_rows(inc, new.party_size),';
  r2 constant text := '|| rb_experience_included_rows(inc, new.party_size) || rb_experience_addon_rows(new.addons),';
  src text; n int;
begin
  src := pg_get_functiondef('public.rb_experience_lead_sync()'::regprocedure);
  if position('rb_experience_addon_rows(' in src) > 0 then return; end if; -- already in
  n := (length(src) - length(replace(src, a1, ''))) / length(a1);
  if n <> 1 then raise exception 'rb_experience_lead_sync: money anchor found % times', n; end if;
  n := (length(src) - length(replace(src, a2, ''))) / length(a2);
  if n <> 1 then raise exception 'rb_experience_lead_sync: menu anchor found % times', n; end if;
  src := replace(replace(src, a1, r1), a2, r2);
  execute src;
end $g$;

-- 5. the experiences ----------------------------------------------------------------------------------------------
-- Greysing Table + Raclette: $350 for 6, by the guest after that, 12 at most ($700)
update public.rb_experience_types
   set price_cents = 35000, per_person = false, price_unit_guests = 6, options = null, min_party = 6, max_party = 12, party_step = 1,
       price_label = '$350 for 6 guests · $58.33 per extra guest · up to 12'
 where id in ('340f39c7-fcda-41a8-9aaa-841c973a2872', '4f22874e-7ae0-4e40-bec7-7d4e20be4cb1');
-- Fondue: by twos, 8 at most, $125 for every 2
update public.rb_experience_types
   set price_cents = 12500, per_person = false, price_unit_guests = 2, min_party = 2, max_party = 8, party_step = 2,
       price_label = '$125 per 2 guests · 2, 4, 6 or 8 guests',
       description = replace(description, 'For 2 to 12 guests.', 'For 2, 4, 6 or 8 guests.')
 where id = 'd3271965-6fa9-4951-b705-89ce01fb5ce4';
-- Raclette at Home: 20 guests and up
update public.rb_experience_types
   set min_party = 20, max_party = 100, party_step = 1,
       price_label = '$37 or $47 with wine, per person · 20 guests and up',
       description = case when description like '%For 20 guests and up.%' then description
                          else replace(description, 'Our cheesemonger arrives 1 hour early to set up.',
                                       'Our cheesemonger arrives 1 hour early to set up. For 20 guests and up.') end
 where id = 'df423077-3b36-452c-a196-50d2c6f7de07';
-- chocolate fondue, $12.95 per guest, on every experience (one switch per experience in ✨ Experiences → Edit)
update public.rb_experience_types
   set addons = '[{"key":"chocolate_fondue","label":"Chocolate fondue","price_cents":1295,"per":"guest"}]'::jsonb
 where addons = '[]'::jsonb;

-- 6. hours and holidays --------------------------------------------------------------------------------------------
-- Nashville Sundays: start 12:30 – 4:00 PM (open 12–6)
update public.rb_settings
   set data = jsonb_set(data, '{experience_rules,Nashville,hours,0}', '[["12:30","16:00"]]'::jsonb)
 where id = 1 and data #> '{experience_rules,Nashville,hours}' is not null;
-- the holidays Jackie listed, kept with any closures already there
update public.rb_settings
   set data = jsonb_set(data, '{closures}', (
         select coalesce(jsonb_agg(d order by d), '[]'::jsonb) from (
           select jsonb_array_elements_text(coalesce(data->'closures', '[]'::jsonb)) d
           union
           select unnest(array['2026-11-26', '2026-11-27', '2026-12-25', '2026-12-26', '2027-01-01'])) z))
 where id = 1;
