-- ONLINE-ORDERING TIMER (2026-11-04): turning a shop's online ordering off can now be for
-- 1 / 2 / 3 / 4 hours or until the end of the day (manager console → Online Ordering).
--
-- site_content 'online_ordering' = { memphis:{paused, at, by, until?}, nashville:{…} }
--   until — when the shop turns itself back on (absent = stays off until someone turns it on).
--   set_online_ordering (unchanged) still flips a shop on/off with no time limit; turning a shop
--   on replaces its whole entry, so any `until` goes away with it.
-- pause_online_ordering(shop, until, by) — a timed pause, managers only (is_app_admin).
-- online_ordering_resume_due() + pg_cron job 'online-ordering-resume' (every minute) turn a shop
--   back on once its time is up, recorded as by = 'timer'. square-online-order keeps reading
--   `paused` (every ~10 s), so the order site reopens within about a minute of the time.

create function public.pause_online_ordering(p_shop text, p_until timestamptz, p_by text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_app_admin() then raise exception 'Manager sign-in required' using errcode = '42501'; end if;
  if p_shop is null or lower(p_shop) not in ('memphis','nashville') then raise exception 'Unknown shop'; end if;
  if p_until is null or p_until <= now() or p_until > now() + interval '7 days' then
    raise exception 'Pick a time later today (up to a week out)';
  end if;
  insert into public.site_content(key, data, updated_at, updated_by)
  values ('online_ordering',
          jsonb_build_object(lower(p_shop), jsonb_build_object('paused', true, 'at', now(), 'by', left(coalesce(p_by,''),80), 'until', p_until)),
          now(), left(coalesce(p_by,''),80))
  on conflict (key) do update
    set data = coalesce(public.site_content.data,'{}'::jsonb) || excluded.data,
        updated_at = now(), updated_by = excluded.updated_by
  returning data into v;
  return v;
end $$;
grant execute on function public.pause_online_ordering(text, timestamptz, text) to authenticated, service_role;

create function public.online_ordering_resume_due()
returns integer language plpgsql security definer set search_path = public as $$
declare v jsonb; k text; n integer := 0;
begin
  select data into v from public.site_content where key = 'online_ordering' for update;
  if v is null then return 0; end if;
  for k in select jsonb_object_keys(v) loop
    if jsonb_typeof(v -> k) = 'object' and (v -> k ->> 'paused') = 'true' and (v -> k) ? 'until'
       and (v -> k ->> 'until')::timestamptz <= now() then
      v := jsonb_set(v, array[k], jsonb_build_object('paused', false, 'at', now(), 'by', 'timer'));
      n := n + 1;
    end if;
  end loop;
  if n > 0 then
    update public.site_content set data = v, updated_at = now(), updated_by = 'timer' where key = 'online_ordering';
  end if;
  return n;
end $$;

select cron.schedule('online-ordering-resume', '* * * * *', $cron$select public.online_ordering_resume_due()$cron$);
