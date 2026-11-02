-- 2026-11-02 — "Hours before the event to start blocking" (applied as migration
-- block_before_min_events_and_portal_items).
-- How many minutes before the start an event's Wix block begins.
-- null = the default for its block type: 60 ("Block during event") / 90 ("Block tables").
-- Set in manager.html: the Tickets editor (classes, Mahjong, ticketed events → events)
-- and the Events section editor (staff events → portal_items).

alter table public.events       add column if not exists block_before_min integer;
alter table public.portal_items add column if not exists block_before_min integer;

alter table public.events drop constraint if exists events_block_before_min_chk;
alter table public.events add constraint events_block_before_min_chk
  check (block_before_min is null or block_before_min between 0 and 1440);
alter table public.portal_items drop constraint if exists portal_items_block_before_min_chk;
alter table public.portal_items add constraint portal_items_block_before_min_chk
  check (block_before_min is null or block_before_min between 0 and 1440);

comment on column public.events.block_before_min is
  'Minutes before the start that the Wix block (window) or table hold begins; null = 60 for window, 90 for tables. Set in the manager console class/event editor.';
comment on column public.portal_items.block_before_min is
  'Staff events: minutes before the start that the Wix block (window) or table hold begins; null = 60 for window, 90 for tables. Saved via portal_item_set_block_before (portal-api''s item row does not carry it).';

-- Staff events save through portal-api, whose item row doesn't know this column,
-- so the manager console sets it here (admins only), same pattern as portal_employee_set_schedule.
create or replace function public.portal_item_set_block_before(p_id bigint, p_min integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not coalesce(public.is_app_admin(), false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_min is not null and (p_min < 0 or p_min > 1440) then
    raise exception 'hours before must be between 0 and 24' using errcode = '22023';
  end if;
  update public.portal_items set block_before_min = p_min where id = p_id;
  return found;
end
$function$;

revoke all on function public.portal_item_set_block_before(bigint, integer) from public, anon;
grant execute on function public.portal_item_set_block_before(bigint, integer) to authenticated, service_role;
