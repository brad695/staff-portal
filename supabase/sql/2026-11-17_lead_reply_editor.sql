-- 2026-11-17 — Catering Leads reply editor (Maverick: "when replying we need a full editor, add file, add link etc.")
-- Migration `lead_reply_editor`. Additive only — nothing is dropped or rewritten; old rows and old replies are untouched.
--
-- 1. A staff reply can now be formatted and carry files:
--      body         unchanged — the plain-text copy (Greys Chat's mirror, list previews and the booking-link
--                   check all keep reading it)
--      body_html    the sanitized HTML the customer was sent (edge-mirror/rich-reply.ts); null = a plain reply
--      attachments  [{ name, url, path, size, type, sent: "attached" | "link" }]; null = none
-- 2. `lead-files`: the public bucket the reply editor uploads to — files and pictures staff send to customers.
--    Public because the customer's email links straight to the file (and send-mail attaches from a public
--    Storage URL); every path carries a random 32-character folder, and nothing lists the bucket.
--    Paths: cat/<catering_leads.id>/<random>/<file>  ·  inq/<inquiries.id>/<random>/<file>
--    Only signed-in portal managers can upload (is_app_admin); nobody can overwrite or delete from the browser.

alter table public.catering_messages
  add column if not exists body_html text,
  add column if not exists attachments jsonb;
alter table public.inquiry_messages
  add column if not exists body_html text,
  add column if not exists attachments jsonb;

comment on column public.catering_messages.body_html is 'Sanitized HTML of a staff reply written in the reply editor (null = plain text; body always has the plain copy).';
comment on column public.catering_messages.attachments is 'Files sent with a staff reply: [{name,url,path,size,type,sent}] — sent = attached | link. Files live in the lead-files bucket.';
comment on column public.inquiry_messages.body_html is 'Sanitized HTML of a staff reply written in the reply editor (null = plain text; body always has the plain copy).';
comment on column public.inquiry_messages.attachments is 'Files sent with a staff reply: [{name,url,path,size,type,sent}] — sent = attached | link. Files live in the lead-files bucket.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lead-files', 'lead-files', true, 26214400, array[
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'text/plain', 'text/csv', 'text/calendar',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed'
])
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'lead-files admin upload') then
    create policy "lead-files admin upload" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'lead-files' and public.is_app_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'lead-files admin read') then
    create policy "lead-files admin read" on storage.objects
      for select to authenticated
      using (bucket_id = 'lead-files' and public.is_app_admin());
  end if;
end $$;
