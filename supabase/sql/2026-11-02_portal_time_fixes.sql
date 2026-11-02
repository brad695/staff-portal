-- 2026-11-02 — Time card fixes (applied live via migrations `portal_time_fixes` and `portal_time_fixes_still_on`).
-- Staff ask from the My Hours tile (index.html): fix a clock-in's times, set a missed clock-out, move just the
-- clock-in while still on the clock (req_end null), or add a missed shift. A manager approves in manager.html
-- (Staff → Time Off & Swaps → Time Card Fixes) and square-team-sync (fix-decide) writes the times into Square:
-- UpdateTimecard for an edit, CreateTimecard for a missed shift. Decline leaves Square alone. The employee gets a
-- text (Twilio, portal_sms_log kind 'timefix') and an email either way. Edge function: supabase/functions/square-team-sync.
-- Rules (enforced in the function): this week and last week only, never in the future, ≤ 16 h, breaks stay inside the
-- new times, no overlap with their other clock-ins, one pending ask per clock-in (asking again replaces it).

create table if not exists public.portal_time_fixes (
  id             bigint generated always as identity primary key,
  employee_id    bigint not null references public.portal_employees(id) on delete cascade,
  team_member_id text   not null,
  timecard_id    text,                                   -- null = a missed shift to add
  kind           text   not null check (kind in ('edit','add')),
  location_id    text   not null,
  work_date      date   not null,                        -- Chicago date of the clock-in asked for
  orig_start     timestamptz,                            -- what Square had when they asked (edit only)
  orig_end       timestamptz,
  req_start      timestamptz not null,
  req_end        timestamptz,                            -- null = clock-in change only (still on the clock)
  job_title      text   not null default '',
  note           text   not null default '',
  status         text   not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  decided_by     text,
  decided_at     timestamptz,
  manager_note   text   not null default '',
  square_timecard_id text,
  square_error   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (req_end > req_start)
);
alter table public.portal_time_fixes add constraint portal_time_fixes_add_has_end check (req_end is not null or kind = 'edit');
create index if not exists portal_time_fixes_status_idx on public.portal_time_fixes (status, created_at desc);
create index if not exists portal_time_fixes_emp_idx on public.portal_time_fixes (employee_id, created_at desc);
create unique index if not exists portal_time_fixes_one_pending on public.portal_time_fixes (timecard_id) where status = 'pending' and timecard_id is not null;
comment on table public.portal_time_fixes is
  'Time card fix requests (staff portal My Hours -> manager console Time Off & Swaps). Approving writes the times into Square via square-team-sync. Service-role only.';
comment on column public.portal_time_fixes.req_end is
  'null = clock-in change only (they were still on the clock): the clock-out stays whatever Square has when it is approved';
alter table public.portal_time_fixes enable row level security;
revoke all on public.portal_time_fixes from anon, authenticated;

-- Check the Square write shapes end to end in the Square SANDBOX (add → edit → read back → delete, then an open
-- clock-in → move only its clock-in → read back → delete):
--   select net.http_post(url := 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/square-team-sync',
--     body := jsonb_build_object('action','fix-selftest','secret',(select value from app_secrets where name='cc_cron_secret')),
--     headers := jsonb_build_object('Content-Type','application/json'), timeout_milliseconds := 60000);
