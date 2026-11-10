-- Class emails (2026-11-09)
-- Maverick: "we need to be able to send emails to classes individually. build a template just like you did for
-- the newsletter, and add the ability to be able to email an entire class"
-- Staff write it in the manager console (a class → ✉ Email the class, or ✉ Email on one booking). The
-- class-email edge function saves drafts, previews, sends tests and sends one copy per guest (the person who
-- booked + every guest who gave an email), through send-mail.
--   class_emails.design   = { v:1, headline, hero:{url}|null, button:"directions"|"classes"|"none",
--                             blocks:[ {t:"text",title,html} | {t:"photo",url,caption} | {t:"class"} ] }
--   class_emails.audience = { who:"all" } (everyone booked when it sends) | { who:"some", emails:[…] }
-- Only the edge function (service role) reads or writes these tables.
-- Migration name: class_emails.

create table if not exists public.class_emails (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  subject text not null default '',
  preheader text,
  design jsonb,
  audience jsonb not null default '{"who":"all"}'::jsonb,
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','canceled')),
  send_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  last_error text
);
create index if not exists class_emails_event_idx on public.class_emails (event_id, created_at desc);
create index if not exists class_emails_due_idx on public.class_emails (send_at) where status = 'scheduled';
create index if not exists class_emails_sending_idx on public.class_emails (started_at) where status = 'sending';
comment on table public.class_emails is 'Emails to the guests of one class / Mahjong night / event, written in the manager console. Sent by the class-email edge function.';

create table if not exists public.class_email_sends (
  id bigserial primary key,
  email_id uuid not null references public.class_emails(id) on delete cascade,
  registration_id uuid,
  email text not null,
  first_name text,
  merge jsonb,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','skipped')),
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (email_id, email)
);
create index if not exists class_email_sends_queue_idx on public.class_email_sends (email_id, status);
comment on table public.class_email_sends is 'One row per guest a class email goes to (snapshot taken when it starts sending).';

alter table public.class_emails enable row level security;
alter table public.class_email_sends enable row level security;
revoke all on table public.class_emails from anon, authenticated;
revoke all on table public.class_email_sends from anon, authenticated;
revoke all on sequence public.class_email_sends_id_seq from anon, authenticated;

-- claim a batch to send (two runs never take the same row)
create or replace function public.class_em_claim(p_email uuid, p_limit integer)
returns setof public.class_email_sends
language sql security definer set search_path = public as $$
  update public.class_email_sends s set status = 'sending', claimed_at = now()
  where s.id in (
    select id from public.class_email_sends
    where email_id = p_email and status = 'queued'
    order by id limit greatest(1, least(p_limit, 200))
    for update skip locked)
  returning s.*;
$$;

-- recount, and mark it sent when nothing is left
create or replace function public.class_em_progress(p_email uuid)
returns public.class_emails
language plpgsql security definer set search_path = public as $$
declare r public.class_emails;
begin
  update public.class_email_sends
     set status = 'failed', error = coalesce(error, 'interrupted while sending (may not have gone out)')
   where email_id = p_email and status = 'sending' and claimed_at < now() - interval '10 minutes';
  update public.class_emails e set
    sent_count = c.sent, failed_count = c.failed, recipient_count = c.total,
    status = case when e.status = 'sending' and c.open = 0 then 'sent' else e.status end,
    finished_at = case when e.status = 'sending' and c.open = 0 then now() else e.finished_at end,
    updated_at = now()
  from (select count(*) filter (where status = 'sent') as sent,
               count(*) filter (where status = 'failed') as failed,
               count(*) filter (where status <> 'skipped') as total,
               count(*) filter (where status in ('queued','sending')) as open
          from public.class_email_sends where email_id = p_email) c
  where e.id = p_email
  returning e.* into r;
  return r;
end $$;

revoke all on function public.class_em_claim(uuid, integer) from public, anon, authenticated;
revoke all on function public.class_em_progress(uuid) from public, anon, authenticated;
grant execute on function public.class_em_claim(uuid, integer) to service_role;
grant execute on function public.class_em_progress(uuid) to service_role;

-- scheduled sends + carrying on a big send: every 2 minutes, only when something is due
-- (cron job, added after the function is deployed)
-- select cron.schedule('class-email-run', '*/2 * * * *', $cron$
--   select net.http_post(
--     url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/class-email?action=run',
--     body := jsonb_build_object('secret', (select value from public.app_secrets where name = 'cc_cron_secret')),
--     headers := jsonb_build_object('Content-Type','application/json'),
--     timeout_milliseconds := 120000)
--   where exists (select 1 from public.class_emails where status = 'sending' or (status = 'scheduled' and send_at <= now()))
-- $cron$);
