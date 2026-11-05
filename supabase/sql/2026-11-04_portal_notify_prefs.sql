-- NOTIFY-PREFS (2026-11-04): each person picks which texts and emails the portal sends them.
-- One row per employee: prefs = {"<kind>": {"sms": bool, "email": bool}}.
-- A missing kind or channel means ON, so nobody's notices change until they untick a box.
--
-- Kinds (keep in sync with NP_KINDS in schedule.html / manager.html and the senders):
--   schedule  — schedule posted / your week changed        portal-api publish-week
--   reminder  — reminder the day before you work            portal-api remind-shifts (text) + shift-reminder (email)
--   timeoff   — time-off request approved / denied          portal-api set-timeoff
--   swap      — shift swap offers and decisions             portal-api request-swap / set-swap
--   timefix   — time card fix approved / declined           square-team-sync notifyFix
--   announce  — team announcements                          portal-api send-announcement
--   quicktext — one-off texts from a manager (text only)    portal-api send-sms
--
-- Staff change their own boxes on schedule.html (employee ID check, same trust level as the rest
-- of the staff page); managers change anyone's in the manager console's employee editor (is_app_admin).

create table if not exists public.portal_notify_prefs (
  employee_id bigint primary key references public.portal_employees(id) on delete cascade,
  prefs       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.portal_notify_prefs enable row level security;   -- no anon access; writes only via the RPCs below

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'portal_notify_prefs'
                 and policyname = 'portal_notify_prefs admin read') then
    create policy "portal_notify_prefs admin read" on public.portal_notify_prefs
      for select to authenticated using (public.is_app_admin());
  end if;
end $$;

-- keep only known kinds/channels with true/false values
create function public.portal_notify_clean(p jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k.kind, ch.val), '{}'::jsonb)
  from (values ('schedule'),('reminder'),('timeoff'),('swap'),('timefix'),('announce'),('quicktext')) as k(kind)
  cross join lateral (
    select jsonb_object_agg(c.chan, (p -> k.kind ->> c.chan)::boolean) as val
    from (values ('sms'),('email')) as c(chan)
    where jsonb_typeof(p -> k.kind) = 'object'
      and jsonb_typeof(p -> k.kind -> c.chan) = 'boolean'
      and not (k.kind = 'quicktext' and c.chan = 'email')
  ) as ch
  where ch.val is not null;
$$;

-- a manager (is_app_admin), or the employee themself (active row + matching employee ID).
-- Runs as the caller: it only reads portal_employees, which the staff pages can already read.
create function public.portal_notify_can(p_emp bigint, p_login text)
returns boolean language sql stable set search_path = public as $$
  select coalesce(public.is_app_admin(), false)
      or exists (
        select 1 from public.portal_employees e
         where e.id = p_emp and e.active
           and coalesce(btrim(p_login), '') <> ''
           and lower(btrim(e.login_id)) = lower(btrim(p_login))
      );
$$;

create function public.portal_notify_get(p_emp bigint, p_login text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.portal_notify_can(p_emp, p_login) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select prefs from public.portal_notify_prefs where employee_id = p_emp), '{}'::jsonb);
end $$;

create function public.portal_notify_set(p_emp bigint, p_prefs jsonb, p_login text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v jsonb := public.portal_notify_clean(coalesce(p_prefs, '{}'::jsonb));
  who text;
begin
  if not public.portal_notify_can(p_emp, p_login) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  who := case when coalesce(public.is_app_admin(), false) then coalesce(nullif(auth.email(), ''), 'manager') else 'self' end;
  insert into public.portal_notify_prefs (employee_id, prefs, updated_at, updated_by)
  values (p_emp, v, now(), who)
  on conflict (employee_id) do update
    set prefs = excluded.prefs, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return v;
end $$;

grant execute on function public.portal_notify_get(bigint, text) to anon, authenticated, service_role;
grant execute on function public.portal_notify_set(bigint, jsonb, text) to anon, authenticated, service_role;
