-- GREYS STUDIO (2026-11-14): the in-house Canva at staff.greyscheese.com/studio/.
-- Maverick: "do you think you could build me my own version of canva?" then "Yes, add it to the portal".
-- Managers only (is_app_admin), same sign-in as the manager console. New and additive only.

-- One row per design. pages = the whole design (pages -> elements) as JSON; thumb = small JPEG data URL for the list.
create table if not exists public.studio_designs (
  id          text primary key,
  name        text not null default 'Untitled design',
  w           integer not null,
  h           integer not null,
  unit        text not null default 'px',
  kind        text not null default '',
  page_count  integer not null default 1,
  thumb       text not null default '',
  pages       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists studio_designs_updated_idx on public.studio_designs (updated_at desc);

-- The shared photo library (files live in the public bucket studio-assets).
create table if not exists public.studio_uploads (
  id          uuid primary key default gen_random_uuid(),
  path        text not null,
  url         text not null,
  w           integer,
  h           integer,
  name        text,
  created_at  timestamptz not null default now()
);
create index if not exists studio_uploads_created_idx on public.studio_uploads (created_at desc);

-- Brand kit: one row, id 'kit'. colors = ["#E6B33C", ...]; logos = [{ref, w, h, name}, ...].
create table if not exists public.studio_brand (
  id          text primary key default 'kit',
  colors      jsonb not null default '[]'::jsonb,
  logos       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.studio_designs enable row level security;
alter table public.studio_uploads enable row level security;
alter table public.studio_brand   enable row level security;

drop policy if exists studio_designs_admin on public.studio_designs;
create policy studio_designs_admin on public.studio_designs for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists studio_uploads_admin on public.studio_uploads;
create policy studio_uploads_admin on public.studio_uploads for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists studio_brand_admin on public.studio_brand;
create policy studio_brand_admin on public.studio_brand for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- Public bucket: the editor and exports load photos by public URL. Only admins can add or change files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('studio-assets', 'studio-assets', true, 26214400, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "studio-assets admin upload" on storage.objects;
create policy "studio-assets admin upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'studio-assets' and public.is_app_admin());
drop policy if exists "studio-assets admin update" on storage.objects;
create policy "studio-assets admin update" on storage.objects for update to authenticated
  using (bucket_id = 'studio-assets' and public.is_app_admin())
  with check (bucket_id = 'studio-assets' and public.is_app_admin());
drop policy if exists "studio-assets admin read" on storage.objects;
create policy "studio-assets admin read" on storage.objects for select to authenticated
  using (bucket_id = 'studio-assets' and public.is_app_admin());
