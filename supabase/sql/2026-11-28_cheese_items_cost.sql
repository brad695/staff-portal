-- Cheese Entry: item cost (what GREYS pays per unit). Applied 2026-11-28.
-- Per lb / oz / g / kg for by-weight items, per each otherwise. Portal only; not sent to Square.
alter table public.cheese_items add column if not exists cost numeric(10,2) check (cost is null or cost >= 0);
comment on column public.cheese_items.cost is 'What GREYS pays per unit (per lb / oz / g / kg for by-weight items, per each otherwise). Entered on Cheese Entry. Portal only for now; not sent to Square.';
