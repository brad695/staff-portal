-- GREYS STUDIO version history (2026-11-15). Canva keeps version history behind Pro; ours is free.
-- Studio saves a copy of a design when someone starts editing it, every 10 minutes while they edit,
-- before a restore, and when they press "Save a version". The newest 40 per design are kept (Studio
-- trims the rest). Deleting a design deletes its versions. Managers only, like the other studio_ tables.

create table if not exists public.studio_versions (
  id          uuid primary key default gen_random_uuid(),
  design_id   text not null references public.studio_designs(id) on delete cascade,
  name        text not null default '',
  w           integer not null,
  h           integer not null,
  unit        text not null default 'px',
  page_count  integer not null default 1,
  thumb       text not null default '',
  pages       jsonb not null default '[]'::jsonb,
  reason      text not null default 'auto',
  created_at  timestamptz not null default now()
);
create index if not exists studio_versions_design_idx on public.studio_versions (design_id, created_at desc);

alter table public.studio_versions enable row level security;
drop policy if exists studio_versions_admin on public.studio_versions;
create policy studio_versions_admin on public.studio_versions for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
