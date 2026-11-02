-- 2026-11-01 — off-schedule staff (applied live as migration `portal_employees_on_schedule`).
-- Owners/admins (Jacqueline Mau, Kurt McGurt) are in the portal for sign-in, Greys Chat and staff emails,
-- but not on the schedule grids or swap lists. manager.html Employees → "On the schedule" (yes / no).
alter table public.portal_employees add column if not exists on_schedule boolean not null default true;
comment on column public.portal_employees.on_schedule is
  'false = in the portal (sign-in, Greys Chat, staff emails) but left off the schedule grids and swap lists - owners, admins. '
  'Set in manager.html Employees ("On the schedule") through portal_employee_set_schedule(). square-team-sync adds Square Owner/Admin jobs with false.';

-- portal-api's employee row doesn't carry on_schedule, so the manager console saves it here (managers only)
create or replace function public.portal_employee_set_schedule(p_id bigint, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_app_admin(), false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.portal_employees set on_schedule = coalesce(p_on, true) where id = p_id;
  return found;
end
$$;
revoke all on function public.portal_employee_set_schedule(bigint, boolean) from public, anon;
grant execute on function public.portal_employee_set_schedule(bigint, boolean) to authenticated, service_role;
