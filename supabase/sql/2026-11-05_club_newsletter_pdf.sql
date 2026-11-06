-- Cheese Club newsletter: send a PDF with the monthly email (2026-11-05)
-- ALREADY APPLIED to vdvtrevhqalmjwhjhjug (migration club_newsletter_pdf). Kept here as the record.
alter table public.club_newsletters
  add column if not exists pdf_url   text,
  add column if not exists pdf_name  text,
  add column if not exists pdf_bytes integer;

-- public bucket for the newsletter PDFs (members open the link; send-mail fetches it to attach)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-newsletter', 'club-newsletter', true, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- only managers (is_app_admin) can upload; anyone with the link can read it (public bucket)
create policy "club-newsletter admin upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'club-newsletter' and public.is_app_admin());
create policy "club-newsletter admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'club-newsletter' and public.is_app_admin());
