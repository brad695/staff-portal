-- Cost on Cheese Case / Wine-Retail items (manager.html → Cheese Case tab).
-- Cost = what GREYS pays, per the unit the item sells by:
-- per lb/oz/g/kg when sold by weight, each otherwise. Portal-only (not sent to Square or DCG).
-- Note: cheese_items is anon-readable (cheese_items_read policy), so cost is too — Brad's call.
alter table public.cheese_items
  add column if not exists cost numeric
  constraint cheese_items_cost_check check (cost >= 0);

comment on column public.cheese_items.cost is
  'What GREYS pays: per unit_of_measure when sold by weight, each otherwise. Set from the Cheese Case tab in manager.html; not sent to Square or DateCodeGenie.';

-- The Cheese Case tab writes cost straight to the table (the cheese-items edge fn does not
-- know this column). Only this one column is writable from the browser, and only by app admins.
-- authenticated had table-wide UPDATE but no UPDATE policy, so nothing could update before this.
revoke update on table public.cheese_items from authenticated;
grant update (cost) on table public.cheese_items to authenticated;

drop policy if exists cheese_items_cost_update on public.cheese_items;
create policy cheese_items_cost_update on public.cheese_items
  for update to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());
