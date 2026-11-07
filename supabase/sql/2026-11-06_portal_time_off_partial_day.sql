-- 2026-11-06 — Part-day time off. Staff pick "Part of a day" on the Request time off card (schedule.html):
-- one date + Off from / Until. Full-day requests leave both times null (and the page doesn't send them at all).
-- Shown as "Off 2p–5p" on the staff + manager grids, the shift editor warning, the printable week, the portal
-- home calendar / Today card, and in the approve/deny text (portal-api set-timeoff).
-- Migration name: portal_time_off_partial_day. No grants needed (anon/authenticated have table-level grants).

alter table public.portal_time_off
  add column if not exists start_time time,
  add column if not exists end_time   time;

alter table public.portal_time_off drop constraint if exists portal_time_off_partial_check;
alter table public.portal_time_off add constraint portal_time_off_partial_check check (
  (start_time is null and end_time is null)
  or (start_time is not null and end_time is not null and end_time > start_time
      and (end_date is null or end_date = start_date))
);

comment on column public.portal_time_off.start_time is 'Part of a day: off from this time (null = the whole day). Needs end_time; one day only.';
comment on column public.portal_time_off.end_time   is 'Part of a day: off until this time (null = the whole day).';
