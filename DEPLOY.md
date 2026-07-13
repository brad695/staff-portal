# GREYS Staff Portal — How it works

**Live:** https://staff.greyscheese.com  ·  **Manager console:** https://staff.greyscheese.com/manager.html (password `grey709`)

Three static pages, no app server (nothing to cold-start):

- **`index.html`** — the staff portal. View-only: notes & specials tiles, events, schedule, calendar, Memphis reservations, music, plus the time-off request form. A "🔐 Manager" link opens the console. The **My Shifts** tile opens `schedule.html`.
- **`manager.html`** — the manager console. Password login, then **one bulk editor** for all content (a Type dropdown per row: `note` / `special` / `event`), a bulk editor for schedules, time-off approvals, and the **Staff Scheduling** tab (employee roster + weekly shift grid).
- **`schedule.html`** — the employee schedule view. Staff "log in" by typing the email on their employee record (no password — internal tool, read-only data). They see their own week (shifts, roles, hours) plus the full weekly grid for their location; approved time off shows as OFF badges.

## Staff scheduling

- **Roster:** Manager console → Staff Scheduling → Employees. Name, email (the staff login), role, active/inactive. Per location. CSV import supported (`name, email, role, active`).
- **Weekly grid:** click any cell to add a shift (start, end, role, note); click a shift chip to edit or delete. The editor's **Copy this shift to…** row duplicates it to any employee/day of the week (defaults to the next day; repeat for multiple copies). **⧉ Copy previous week** clones last week's shifts into the current week. Week starts Monday.
- **Time off:** approved requests (Time Off tab) automatically show as red **OFF** badges on both the manager grid and schedule.html, matched by employee **name** (case-insensitive) — keep roster names identical to the names staff use on the request form. The shift editor warns if you schedule someone on an approved off day.
- **Employee login:** schedule.html looks the email up in `portal_employees` (active only) — no password, no signup. Remembered in the browser; "Not you?" switches user.

## Hosting

- Repo: **`github.com/brad695/staff-portal`** → Render **Static Site** `greys-staff-portal` (publish dir `.`, auto-deploys on commit). To update the live site, commit/upload the changed file to the repo.
- Custom domain `staff.greyscheese.com` is registered on `greys-staff-portal` (CNAME → `greys-staff-portal.onrender.com`).

## Data (Supabase, project `vdvtrevhqalmjwhjhjug`)

Pages read directly via the publishable key; all writes go through the **`portal-api` Edge Function** (password-checked server-side).

- **`portal_items`** — unified content. Columns: `type` (note/special/event), `title`, `body`, `date`, `time`, `end_date`, `repeat` (none/weekly/biweekly/monthly), `repeat_until`. Notes need only a title; specials/events need a date.
- **`portal_schedules`** — schedule entries (`name, date, end_date, note`).
- **`portal_time_off`** — staff time-off requests (public insert; approvals via the function).
- **`portal_employees`** — scheduling roster (`name, email, role, location, active`). Email is unique per location; used as the passwordless staff login on schedule.html.
- **`portal_shifts`** — individual shifts (`employee_id → portal_employees, date, start_time, end_time, role, note, location`). Deleting an employee cascades to their shifts. Function actions: `add/update/delete-employee`, `bulk-add-employees`, `add/update/delete-shift`, `bulk-add-shifts`, `copy-week`.

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
