# GREYS Staff Portal — How it works

**Live:** https://staff.greyscheese.com  ·  **Manager console:** https://staff.greyscheese.com/manager.html (password `grey709`)

Two static pages, no app server (nothing to cold-start):

- **`index.html`** — the staff portal. View-only: notes & specials tiles, events, schedule, calendar, Memphis reservations, music, plus the time-off request form. A "🔐 Manager" link opens the console.
- **`manager.html`** — the manager console. Password login, then **one bulk editor** for all content (a Type dropdown per row: `note` / `special` / `event`), a bulk editor for schedules, and time-off approvals. Inline edit, add rows, CSV import, and downloadable CSV templates.

## Hosting

- Repo: **`github.com/brad695/staff-portal`** → Render **Static Site** `greys-staff-portal` (publish dir `.`, auto-deploys on commit). To update the live site, commit/upload the changed file to the repo.
- Custom domain `staff.greyscheese.com` is registered on `greys-staff-portal` (CNAME → `greys-staff-portal.onrender.com`).

## Data (Supabase, project `vdvtrevhqalmjwhjhjug`)

Pages read directly via the publishable key; all writes go through the **`portal-api` Edge Function** (password-checked server-side).

- **`portal_items`** — unified content. Columns: `type` (note/special/event), `title`, `body`, `date`, `time`, `end_date`, `repeat` (none/weekly/biweekly/monthly), `repeat_until`. Notes need only a title; specials/events need a date.
- **`portal_schedules`** — schedule entries (`name, date, end_date, note`).
- **`portal_time_off`** — staff time-off requests (public insert; approvals via the function).

**Recurrence:** set `repeat` + `repeat_until` on a special or event and it expands automatically on the staff page and calendar (e.g. a weekly Tuesday special shows every Tuesday until the end date).

**CSV columns** — Content: `type, title, date, time, end_date, repeat, repeat_until, details`. Schedules: `name, date, end_date, note`. Dates `YYYY-MM-DD`, times `HH:MM` (24h) or blank.

## Reservations (Wix)

The Reservations/Resys tab and the calendar pull from Wix Table Reservations via the Edge Function, **filtered to the Memphis location only** (`WIX_LOCATION_ID`, default hard-coded to Memphis). On the calendar each reservation shows as its own tile (time · name · party size); cancelled/declined/no-shows are hidden.

## Edge Function secrets

Set in Supabase → Edge Functions → Secrets:

| Secret | Purpose |
|---|---|
| `NOTES_PASS` | manager password (currently `grey709`) |
| `WIX_API_KEY` | Wix API key |
| `WIX_SITE_ID` | Wix site ID |
| `WIX_LOCATION_ID` | (optional) Wix reservation location to show; defaults to Memphis |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Notes / follow-ups

- **Edit protection:** the manager password is verified inside the Edge Function, so it never ships in the page. Reads are open to anyone with the URL (internal staff tool).
- **Legacy files:** `server.js` and `notes.json` are the old Node app and are no longer used (the live site serves only `index.html` + `manager.html`). Left in place for reference.
- **Security advisory (tickets side, unrelated):** the `holds` table has Row Level Security **disabled** — anyone with the anon key can read/write it. To lock down: `ALTER TABLE public.holds ENABLE ROW LEVEL SECURITY;` plus policies.
