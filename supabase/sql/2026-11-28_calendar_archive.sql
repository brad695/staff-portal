-- Calendar archive (2026-11-28, Maverick: "add the option to archive any entry on the calendar").
-- Hides a calendar row without deleting what it came from (an order, reservation, event, shift...).
-- entry_key is built by the staff calendar (index.html, calKey): "<YYYY-MM-DD>|<kind>|<stable text>".
-- Anyone on the staff calendar can read the keys (so archived rows stay hidden for everyone);
-- only a manager sign-in (is_app_admin) can archive or unarchive.
create table if not exists public.portal_calendar_archive (
  location    text        not null,
  entry_key   text        not null,
  entry_date  date,
  label       text,
  archived_at timestamptz not null default now(),
  archived_by uuid        default auth.uid(),
  primary key (location, entry_key)
);

alter table public.portal_calendar_archive enable row level security;

drop policy if exists portal_calendar_archive_read on public.portal_calendar_archive;
create policy portal_calendar_archive_read on public.portal_calendar_archive
  for select using (true);

drop policy if exists portal_calendar_archive_admin on public.portal_calendar_archive;
create policy portal_calendar_archive_admin on public.portal_calendar_archive
  for all to authenticated using (public.is_app_admin()) with check (public.is_app_admin());

grant select on public.portal_calendar_archive to anon, authenticated;
grant insert, update, delete on public.portal_calendar_archive to authenticated;
