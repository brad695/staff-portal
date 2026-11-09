-- GREYS shirt shop — shop.html (staff.greyscheese.com/shop) + the `shirt-shop` Edge Function. 2026-11-08.
-- Moved in from the tee-stores repo (Next.js + Stripe test mode): same six Greys designs, now paid through
-- Square and printed + shipped by Printful.
--
--   shirt_products / shirt_variants  the catalog. Public read (active rows). The page never reads it directly —
--                                    the function's `catalog` action does — but the console can.
--   shirt_orders                     one row per checkout (= one Square order). Written only by the function
--                                    (service role); app admins can read.
--   site_content 'shirt_shop'        the switches: live, paused, shipping, tax, Printful mode (see the function header).
--   cron 'shirt-orders-sweep'        cancels Square orders left unpaid for 30 minutes (and their Printful drafts).
--
-- PRINTFUL MAPPING: a variant ships only once it points at Printful — either
--   printful_sync_variant_id  (a product made in the Printful dashboard; preferred), or
--   printful_variant_id + print_file_url  (a Printful catalog blank + our own print-ready PNG).
-- On the live site an unmapped variant shows as unavailable; test (sandbox) checkouts don't need it.
--
-- Safe to re-run.

create table if not exists public.shirt_products (
  id uuid primary key default gen_random_uuid(),
  shop text not null default 'greys',              -- brand; the other tee shops can join later
  slug text not null,
  name text not null,
  tagline text not null default '',
  description text not null default '',
  image_url text,                                  -- shop photo (site path like /shop-img/x.webp, or a full URL)
  blank text,                                      -- the shirt it prints on, for setting it up in Printful
  price_cents integer not null check (price_cents > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop, slug)
);

create table if not exists public.shirt_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shirt_products(id) on delete cascade,
  size text not null,
  sku text not null unique,
  price_cents integer not null check (price_cents > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  printful_sync_variant_id bigint,
  printful_variant_id integer,
  print_file_url text,
  unique (product_id, size)
);

create table if not exists public.shirt_orders (
  id uuid primary key default gen_random_uuid(),
  code text not null,                              -- T + 5, what the customer sees; Printful external_id
  shop text not null default 'greys',
  env text not null,                               -- production | sandbox
  status text not null default 'pending',          -- pending | paid | failed | cancelled
  customer_name text,
  email text,
  phone text,
  ship_to jsonb,                                   -- { name, address1, address2, city, state_code, zip, country_code }
  lines jsonb not null default '[]'::jsonb,
  subtotal_cents integer,
  shipping_cents integer,
  tax_cents integer,
  total_cents integer,
  square_location_id text,
  square_order_id text unique,
  square_payment_id text,
  receipt_url text,
  card text,
  printful_order_id bigint,
  printful_status text,                            -- draft | pending | inprocess | fulfilled | shipped | failed | canceled | onhold | not sent | skipped
  printful_cost_cents integer,                     -- what Printful charges us (from the draft's costs)
  printful_error text,
  tracking jsonb,                                  -- [{ carrier, number, url, shipped_at }]
  email_sent boolean,
  shipped_email_sent boolean,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  shipped_at timestamptz
);
create index if not exists shirt_orders_code_idx on public.shirt_orders (code);
create index if not exists shirt_orders_status_idx on public.shirt_orders (status, updated_at);
create index if not exists shirt_orders_printful_idx on public.shirt_orders (printful_order_id);
create index if not exists shirt_variants_product_idx on public.shirt_variants (product_id);

alter table public.shirt_products enable row level security;
alter table public.shirt_variants enable row level security;
alter table public.shirt_orders enable row level security;

drop policy if exists shirt_products_read on public.shirt_products;
create policy shirt_products_read on public.shirt_products for select using (active);
drop policy if exists shirt_variants_read on public.shirt_variants;
create policy shirt_variants_read on public.shirt_variants for select using (active);
drop policy if exists shirt_products_admin on public.shirt_products;
create policy shirt_products_admin on public.shirt_products for all using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists shirt_variants_admin on public.shirt_variants;
create policy shirt_variants_admin on public.shirt_variants for all using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists shirt_orders_admin_select on public.shirt_orders;
create policy shirt_orders_admin_select on public.shirt_orders for select using (public.is_app_admin());

-- ---------- the six Greys designs (from tee-stores sites/greys/config.ts) ----------
insert into public.shirt_products (shop, slug, name, tagline, description, image_url, blank, price_cents, sort_order) values
  ('greys', 'brie-right-back', 'Brie Right Back', 'Natural tee, forest-green print',
   'For the friend who ducks out of the party and always returns with snacks.', '/shop-img/brie-right-back.webp', 'Bella+Canvas 3001 · Natural', 2800, 0),
  ('greys', 'up-to-no-gouda', 'Up to No Gouda', 'Forest tee, cream print',
   'Mild on the outside, trouble on the inside.', '/shop-img/up-to-no-gouda.webp', 'Bella+Canvas 3001 · Forest', 2800, 1),
  ('greys', 'cheddar-late-than-never', 'Cheddar Late Than Never', 'Black tee, gold print',
   'Better a sharp arrival than no cheese at all.', '/shop-img/cheddar-late-than-never.webp', 'Bella+Canvas 3001 · Black', 2800, 2),
  ('greys', 'curd-snack-emergency', 'Curd Snack Emergency', 'Maroon tee, cream print',
   'When the fridge is empty and only curds will do.', '/shop-img/curd-snack-emergency.webp', 'Bella+Canvas 3001 · Maroon', 2800, 3),
  ('greys', 'wheel-me-another', 'Wheel Me Another', 'Gold tee, navy print',
   'One wheel is never enough.', '/shop-img/wheel-me-another.webp', 'Bella+Canvas 3001 · Gold', 2800, 4),
  ('greys', 'cave-aged-to-perfection', 'Cave Aged to Perfection', 'Steel blue tee, cream print',
   'Patient, funky and worth the wait.', '/shop-img/cave-aged-to-perfection.webp', 'Bella+Canvas 3001 · Steel Blue', 2800, 5)
on conflict (shop, slug) do nothing;

-- S–XL at the product price, XXL $3 more (same as tee-stores)
insert into public.shirt_variants (product_id, size, sku, price_cents, sort_order)
select p.id, s.size, 'greys-' || p.slug || '-' || lower(s.size), p.price_cents + s.up, s.ord
from public.shirt_products p
cross join (values ('S', 0, 0), ('M', 0, 1), ('L', 0, 2), ('XL', 0, 3), ('XXL', 300, 4)) as s(size, up, ord)
where p.shop = 'greys'
on conflict (product_id, size) do nothing;

-- ---------- switches ----------
-- live:     false → every checkout is a Square SANDBOX test (test cards only), even on the live page.
--           true  → real cards on the live origins (SHIRT_LIVE_ORIGINS; default shop. + staff.greyscheese.com).
-- paused:   true → the shop still shows, checkout is off.
-- shipping: ship_first_cents for the first shirt + ship_each_cents for each one after; free at free_ship_over_cents (0 = never).
-- tax_rates: percent by ship-to state; states not listed pay none.
-- printful: "off" (record only) | "draft" (sent as a draft; confirm it in Printful) | "confirm" (sent and printed automatically).
-- printful_test: true → test (sandbox) checkouts also make a Printful draft (never confirmed). Handy for one dry run.
insert into public.site_content (key, data, updated_at, updated_by) values ('shirt_shop', '{
  "live": false,
  "paused": false,
  "ship_first_cents": 600,
  "ship_each_cents": 200,
  "free_ship_over_cents": 0,
  "tax_rates": { "TN": "9.75" },
  "printful": "draft",
  "printful_test": false
}'::jsonb, now(), 'shirt-shop setup')
on conflict (key) do nothing;

-- ---------- sweep: every 10 minutes, same shared secret as the order site's sweep ----------
select cron.schedule('shirt-orders-sweep', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/shirt-shop?action=sweep',
    body := jsonb_build_object('secret', (select value from public.app_secrets where name = 'cc_cron_secret')),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 60000)
$cron$);
