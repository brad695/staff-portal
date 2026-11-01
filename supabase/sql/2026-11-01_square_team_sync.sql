-- 2026-11-01 — Square Team → staff portal employee sync (applied live via migrations
-- `square_team_links` and `square_team_sync_cron`). Edge function: supabase/functions/square-team-sync
-- (verify_jwt = FALSE — Square webhooks carry no Supabase JWT; the function checks the Square
-- signature, the cron secret, or a manager session itself).
--
-- What it does: a new ACTIVE Square team member (not the account owner) is added to portal_employees;
-- a Square status CHANGE (active <-> inactive) flips portal_employees.active. Portal names, roles,
-- locations and contacts are never overwritten. Scheduling is not linked.
--
-- Secrets (app_secrets, service-role only): square_team_webhook_key (Square signature key),
-- square_team_webhook_id (subscription wbhk_…), cc_cron_secret (shared cron secret).

create table if not exists public.square_team_links (
  team_member_id text primary key,
  employee_id    bigint unique references public.portal_employees(id) on delete set null,
  square_status  text not null default '',
  square_name    text not null default '',
  is_owner       boolean not null default false,
  dismissed      boolean not null default false,
  match_rule     text not null default '',
  linked_at      timestamptz,
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.square_team_links is
  'Square team member <-> portal_employees link, maintained by the square-team-sync edge function. '
  'dismissed = never auto-add (Square-only at setup, or deleted from the portal after linking). '
  'linked_at set + employee_id null = removed in the portal; not re-added.';
alter table public.square_team_links enable row level security;
revoke all on public.square_team_links from anon, authenticated;

-- safety net for missed webhooks (every 15 min, off the :00 rush)
select cron.schedule(
  'square-team-sync',
  '7,22,37,52 * * * *',
  $$select net.http_post(url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/square-team-sync', body := jsonb_build_object('action','sync','secret', (select value from app_secrets where name='cc_cron_secret')), headers := jsonb_build_object('Content-Type','application/json'), timeout_milliseconds := 60000)$$
);

-- One-time setup (already run 2026-11-01): links existing staff, skips Square-only people, creates the
-- Square webhook subscription and stores its key. Re-running is safe.
--   select net.http_post(url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/square-team-sync',
--     body := jsonb_build_object('action','setup','secret',(select value from app_secrets where name='cc_cron_secret')),
--     headers := jsonb_build_object('Content-Type','application/json'));
-- Preview without writing: add 'dry', true. Quick look: 'action','status'.
