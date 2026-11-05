-- ORDER-FORM PHOTOS (2026-11-05): the staff portal's "Snap Order" home tile.
-- A server photographs a filled-in paper "Future Order" form; the order-photo edge function reads
-- it (Claude vision) and files it as a catering pre-order — a preorders row with status 'confirmed',
-- which puts it on the portal calendar (square-orders feed) and in Manager → Catering → Pre-Orders.
-- No Square order is made for these: the server already rang it on Square and wrote the ticket #
-- on the form, so square_order_id stays null (the Pre-Orders list hides "Charge" for them).
--
-- New and additive only: columns, an index, a log table, a private bucket and two read policies.

alter table public.preorders
  add column if not exists source text,               -- null = counter / order pad / manager; 'photo' = read from a form photo; 'form' = typed in on the Snap Order screen
  add column if not exists square_ticket_no text,     -- "Square Ticket #" written on the form
  add column if not exists fulfillment text,          -- 'pickup' | 'delivery' (null = pickup)
  add column if not exists delivery_address text,
  add column if not exists taken_by text,             -- "Taken By" on the form
  add column if not exists form_photo_path text,      -- path in the private bucket order-forms
  add column if not exists form_ref text;             -- <photo path>#<order index>: a double tap can't file the same form twice

create unique index if not exists preorders_form_ref_key on public.preorders (form_ref) where form_ref is not null;
create index if not exists preorders_ticket_idx on public.preorders (loc_slug, square_ticket_no) where square_ticket_no is not null;

-- Every read of a photo: what was read, by whom, how long it took and the tokens it used.
create table if not exists public.order_photo_reads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  emp_id        bigint,
  emp_name      text,
  loc_slug      text,
  photo_path    text,
  model         text,
  ms            integer,
  input_tokens  integer,
  output_tokens integer,
  orders_found  integer,
  result        jsonb,
  error         text,
  preorder_ids  uuid[] not null default '{}'
);
alter table public.order_photo_reads enable row level security;   -- no anon access; the function writes with the service role

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_photo_reads'
                 and policyname = 'order_photo_reads admin read') then
    create policy "order_photo_reads admin read" on public.order_photo_reads
      for select to authenticated using (public.is_app_admin());
  end if;
end $$;

-- Private bucket for the photos (the function uploads with the service role).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-forms', 'order-forms', false, 12582912, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Managers open a photo from the console (Pre-Orders → 📷 Form) with a signed URL.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'order-forms admin read') then
    create policy "order-forms admin read" on storage.objects
      for select to authenticated using (bucket_id = 'order-forms' and public.is_app_admin());
  end if;
end $$;
