-- 2026-11-08 — Experiences follow Wix's table seating. Maverick: "thurs nov 26 is available to book a
-- experience. it should not we are closed, its set in Wix" → "reservations are blocked but not
-- experiences, they should follow the same table seating as reservations in wix".
--
-- Before: rb_get_availability / rb_create_experience_v2 checked their own rb_tables floor, so Wix
-- closures (holidays, buyouts, class and event blocks) and Wix bookings never reached experiences.
-- Now:
--   · wix_floor / wix_floor_bookings — a copy of each shop's Wix floor: active tables, table
--     combinations, special hours marked closed, live bookings for the next 75 days. Written by
--     table-holds ?action=floor (v14) with the service role; cron wix-floor-sync (job 24) runs it every
--     2 minutes, and table-holds adds / drops its own holds the moment it makes them.
--   · rb_wix_closed(loc, range) — a Wix closure touches the range.
--   · rb_wix_fits(loc, range, party) — Wix can seat the party for the whole range the way it seats a
--     reservation: one free table whose seats take the party, or a free table combination that does.
--   · rb_get_availability (migrations rb_get_availability_wix_seating + rb_get_availability_wix_closed_day)
--     and rb_create_experience_v2 (rb_create_experience_v2_wix_seating): in-store experiences at a shop
--     with a Wix copy are open only when both checks pass; a day Wix has closed at every start time
--     answers closed (the pages already say "We're closed that day"). rb_tables is only the fallback
--     for a shop with no Wix copy; rb_create_experience_v2 still claims rb tables as a best-effort copy.
--   · table-holds v14: an experience hold is refused when a Wix closure touches it (API bookings skip
--     Wix's online rules); Nashville's experience holds take the tables Wix itself would seat the party
--     at (wixSeat — one table, else the tightest free combination) instead of any free tables.
-- Checked against the old function for every experience × 3 party sizes × both shops, Nov 14 – Jan 7:
-- nothing newly opened; closed: Nov 26–27, Dec 24, Dec 26 (both shops); trimmed around Wix blocks
-- (Memphis classes / buyouts, Dec 31 from 3 PM; Nashville Craft Club, Nov 15 and Nov 22 events).

create table if not exists public.wix_floor (
  location        text primary key,              -- 'memphis' | 'nashville' (table-holds keys)
  wix_location_id text not null,
  mode            text,                          -- Wix tableManagement.mode
  tables          jsonb not null default '[]',   -- active tables  [{id, name, seats_min, seats_max}]
  combos          jsonb not null default '[]',   -- active table combinations [{table_ids, seats_min, seats_max}]
  closed          jsonb not null default '[]',   -- special hours marked closed [{start, end, comment}]
  synced_at       timestamptz not null default now()
);
create table if not exists public.wix_floor_bookings (
  wix_reservation_id text primary key,
  location   text not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  party      int,
  table_ids  text[] not null default '{}',
  status     text,
  synced_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists wix_floor_bookings_loc_time on public.wix_floor_bookings (location, starts_at);
-- RLS on, no policies: only the service role and the security-definer rb_* functions see them.
alter table public.wix_floor enable row level security;
alter table public.wix_floor_bookings enable row level security;

create or replace function public.rb_wix_closed(p_location text, p_range tstzrange)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from wix_floor f cross join lateral jsonb_array_elements(f.closed) c
    where f.location = lower(p_location)
      and tstzrange((c->>'start')::timestamptz, (c->>'end')::timestamptz, '[)') && p_range)
$$;

create or replace function public.rb_wix_fits(p_location text, p_range tstzrange, p_party int)
returns boolean language sql stable set search_path = public as $$
  with f as (
    select tables, combos from wix_floor where location = lower(p_location)
  ), busy as (
    select distinct u.tid
    from wix_floor_bookings b cross join lateral unnest(b.table_ids) as u(tid)
    where b.location = lower(p_location)
      and tstzrange(b.starts_at, b.ends_at, '[)') && p_range
  ), t as (
    select e->>'id' as id, coalesce((e->>'seats_min')::int, 1) as smin, coalesce((e->>'seats_max')::int, 2) as smax
    from f cross join lateral jsonb_array_elements(f.tables) e
  )
  select case
    when not exists (select 1 from t) then true   -- no tables to judge by
    else exists (select 1 from t
                 where p_party between t.smin and t.smax
                   and not exists (select 1 from busy where busy.tid = t.id))
      or exists (select 1 from f cross join lateral jsonb_array_elements(f.combos) c
                 where p_party between coalesce((c->>'seats_min')::int, 1) and coalesce((c->>'seats_max')::int, 0)
                   and jsonb_array_length(coalesce(c->'table_ids', '[]')) > 0
                   and not exists (select 1 from jsonb_array_elements_text(c->'table_ids') x(tid)
                                   where exists (select 1 from busy where busy.tid = x.tid)
                                      or not exists (select 1 from t where t.id = x.tid)))
  end
$$;

-- cron job 24
-- select cron.schedule('wix-floor-sync', '*/2 * * * *', $cmd$select net.http_post(
--   url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/table-holds?action=floor', body := '{}'::jsonb,
--   headers := jsonb_build_object('Content-Type','application/json'), timeout_milliseconds := 30000)$cmd$);
