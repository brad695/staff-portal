// square-team-sync — keeps the staff portal's employee list in step with Square Team.
//
// Decided by Maverick 2026-11-01:
//   • Someone added in Square (ACTIVE, not the account owner) is added to portal_employees automatically:
//     name, role (first Square job title), location, login ID, email + mobile.
//       login ID = their Square "Employee ID" (reference_id); else the last 4 of their phone; else blank
//       (blank shows "no login ID yet" in the manager console). Never reuses an ID already in the portal.
//   • Deactivated in Square → deactivated in the portal; reactivated → back on. Only a CHANGE of Square
//     status is mirrored, so a manager flipping someone in the portal is never fought by the next run.
//   • People in both keep the PORTAL's name, role, location and contacts — Square never overwrites them.
//   • Scheduling is NOT linked ("staff only for now").
//   • A Square Owner or Admin job (or the account owner) comes in OFF the schedule (portal_employees.on_schedule = false):
//     in the portal for sign-in, Greys Chat and staff emails, but not on the schedule grids. Managers flip it in Employees.
//   • Square-only people present at setup were not auto-added; Maverick then had Kurt McGurt and Jacqueline Mau (owner)
//     added by hand, off the schedule (2026-11-01). A dismissed person is added later only if Square deactivates and
//     reactivates them (a rehire). Same for someone deleted from the portal after being linked.
//
// Triggers
//   • Square webhook team_member.created / team_member.updated → signed with app_secrets.square_team_webhook_key
//   • pg_cron safety net → { action:"sync", secret:<app_secrets.cc_cron_secret> }
//   • a manager session (is_app_admin) or the service role → any action
// Actions: setup (one-time: link existing staff + create the webhook subscription) · sync · status
//          add {dry:true} to setup/sync to preview without writing.
//   my-hours {login_id} — PUBLIC (staff portal "My Hours" tile, 2026-11-01): that employee's Square clock-ins for this
//          week and last week (Square workweek = Monday 00:00 Chicago), today, and the open timecard if they're on the clock.
//          Same trust level as the rest of the portal: the employee ID is the key. Hours only — never wages.
//   TIME FIXES (2026-11-02): staff ask from My Hours to fix a clock-in (wrong times / forgot to clock out) or add a missed
//          shift; a manager approves in manager.html (Staff → Time Off & Swaps) and the times are written into Square.
//     fix-request {login_id, timecard_id? | date, start "HH:MM", end "HH:MM", note, job?, location_id?} — PUBLIC (employee ID)
//       still_on: true (open clock-in only) = move just the clock-in; the clock-out stays whatever Square has at approval
//     fix-cancel {login_id, id} — PUBLIC, their own pending ask
//     fix-list {status:"pending"|"all"} · fix-decide {id, approve, note, dry?} — managers (is_app_admin) / service
//     fix-selftest — service only: create → edit → read → delete a timecard in the Square SANDBOX (checks the write shapes)
//     Table public.portal_time_fixes (service-role only). Only this week and last week; never in the future; ≤ 16 h;
//     breaks must stay inside the new times; no overlap with their other clock-ins. Decisions text + email the employee.
// Deploy with verify_jwt = FALSE — Square posts here with no Supabase JWT. Auth is done in code.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const SQUARE_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_TICKET_ACCESS_TOKEN") ?? "";
const SQUARE_BASE = "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";
const MERCHANT_ID = "ML6ZX2AV0XKFN"; // Greys Fine Cheeses — refuse to sync any other account's staff
const NOTIFY_URL = "https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/square-team-sync"; // must match the subscription exactly (it is part of the signature)
const EVENT_TYPES = ["team_member.created", "team_member.updated"];
const LOC: Record<string, string> = { LCXWZ0HAQ69RM: "memphis", LJ33VDYHS1JAR: "nashville" };
const DEFAULT_LOC = "memphis";
const KEY_NAME = "square_team_webhook_key";
const SUB_NAME = "square_team_webhook_id";
const LABOR_VERSION = "2025-05-21"; // Timecards API (Square renamed Shifts → Timecards); falls back to the old Shifts search
const TZ = "America/Chicago";       // both shops
const LOC_NAME: Record<string, string> = { LCXWZ0HAQ69RM: "Memphis", LJ33VDYHS1JAR: "Nashville" };
const LOC_ID: Record<string, string> = { memphis: "LCXWZ0HAQ69RM", nashville: "LJ33VDYHS1JAR" };
const SANDBOX_TOKEN = Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN") ?? "";
const SANDBOX_LOCATION = Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? "";
type Env = "production" | "sandbox";

class PublicError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

// ---------- http ----------
function originOk(origin: string) {
  return /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
}
function cors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && originOk(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

// ---------- small helpers ----------
const tidy = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const low = (s: unknown) => tidy(s).toLowerCase();
const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function national(p: unknown) { // 10-digit US number, or "" (also "" for 555 placeholders like 901-555-5555)
  const d = String(p ?? "").replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (n.length !== 10) return "";
  if (n.slice(3) === "5555555" || (n.slice(3, 6) === "555" && /^01\d\d$/.test(n.slice(6)))) return "";
  return n;
}
const e164 = (p: unknown) => { const n = national(p); return n ? "+1" + n : ""; };
const fullName = (m: any) => tidy(`${m?.given_name ?? ""} ${m?.family_name ?? ""}`);
const firstJob = (m: any) => tidy(m?.wage_setting?.job_assignments?.[0]?.job_title);
function locOf(m: any) {
  const ids: string[] = m?.assigned_locations?.location_ids ?? [];
  for (const id of ids) if (LOC[id]) return LOC[id];
  return DEFAULT_LOC;
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const enc = new TextEncoder();
async function hmacB64(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

// ---------- secrets (app_secrets is service-role only) ----------
async function secret(name: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("name", name).maybeSingle();
  return String(data?.value ?? "");
}
async function setSecret(name: string, value: string) {
  const { error } = await admin.from("app_secrets").upsert({ name, value });
  if (error) throw new Error("app_secrets: " + error.message);
}

// ---------- Square ----------
const sq = (path: string, init: RequestInit = {}, version = SQUARE_VERSION) => sqx("production", path, init, version);
async function sqx(env: Env, path: string, init: RequestInit = {}, version = SQUARE_VERSION) {
  const token = env === "sandbox" ? SANDBOX_TOKEN : SQUARE_TOKEN;
  if (!token) throw new Error(`Square ${env} access token is not set`);
  const res = await fetch((env === "sandbox" ? "https://connect.squareupsandbox.com" : SQUARE_BASE) + path, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Square-Version": version },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs: any[] = Array.isArray(data?.errors) ? data.errors : [];
    throw new Error(errs.length ? errs.map((x) => `${x.code}: ${x.detail || ""}`).join("; ") : `Square error ${res.status}`);
  }
  return data;
}
async function allTeam(): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const d = await sq("/v2/team-members/search", { method: "POST", body: JSON.stringify({ limit: 100, ...(cursor ? { cursor } : {}) }) });
    out.push(...(d.team_members ?? []));
    cursor = d.cursor;
    if (!cursor) break;
  }
  const foreign = out.find((m) => m.merchant_id && m.merchant_id !== MERCHANT_ID);
  if (foreign) throw new Error("The Square token belongs to a different Square account — nothing synced.");
  // oldest first, so an earlier hire gets first pick of a login ID
  return out.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

// ---------- portal ----------
type Emp = { id: number; name: string; login_id: string; role: string; location: string; active: boolean; email: string; phone: string };
async function loadEmps(): Promise<Emp[]> {
  const { data: emps, error } = await admin.from("portal_employees").select("id,name,login_id,role,location,active");
  if (error) throw new Error(error.message);
  const { data: cons } = await admin.from("portal_employee_contacts").select("employee_id,email,phone");
  const c = new Map((cons ?? []).map((r: any) => [Number(r.employee_id), r]));
  return (emps ?? []).map((e: any) => ({
    id: Number(e.id), name: e.name ?? "", login_id: e.login_id ?? "", role: e.role ?? "", location: e.location ?? "",
    active: e.active !== false, email: c.get(Number(e.id))?.email ?? "", phone: c.get(Number(e.id))?.phone ?? "",
  }));
}

// existing portal row for a Square person: Employee ID = login ID, then full name, then phone, then email.
// A rule must hit exactly ONE unlinked row; a tie falls through to the next rule.
function matchEmp(m: any, pool: Emp[]): { emp: Emp; rule: string } | null {
  const tries: [string, (e: Emp) => boolean][] = [];
  const ref = low(m.reference_id);
  if (ref) tries.push(["employee_id", (e) => low(e.login_id) === ref]);
  const nm = low(fullName(m));
  if (nm) tries.push(["name", (e) => low(e.name) === nm]);
  const ph = national(m.phone_number);
  if (ph) tries.push(["phone", (e) => national(e.phone) === ph]);
  const em = low(m.email_address);
  if (em) tries.push(["email", (e) => low(e.email) === em]);
  for (const [rule, hit] of tries) {
    const hits = pool.filter(hit);
    if (hits.length === 1) return { emp: hits[0], rule };
  }
  return null;
}

function pickLogin(m: any, used: Set<string>) {
  const cands = [tidy(m.reference_id), national(m.phone_number).slice(-4)].filter(Boolean);
  for (const c of cands) if (!used.has(c.toLowerCase())) return c;
  return "";
}

// only fills blanks — a manager clears a mobile on purpose to stop texts
async function fillContacts(emp: Emp, m: any) {
  const upd: Record<string, string> = {};
  const em = low(m.email_address), ph = e164(m.phone_number);
  if (!emp.email && em) upd.email = em;
  if (!emp.phone && ph) upd.phone = ph;
  if (!Object.keys(upd).length) return [];
  const { error } = await admin.from("portal_employee_contacts").upsert({ employee_id: emp.id, ...upd, updated_at: nowIso() });
  if (error) throw new Error(error.message);
  return Object.keys(upd);
}

// two runs (webhook created + updated arrive together) must not both create the same person
async function claim(tmId: string, hasRow: boolean, runId: string): Promise<boolean> {
  if (!hasRow) {
    const { error } = await admin.from("square_team_links").insert({ team_member_id: tmId, match_rule: "creating:" + runId, updated_at: nowIso() });
    if (!error) return true;
    if (error.code !== "23505") throw new Error(error.message);
  }
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, error } = await admin.from("square_team_links")
    .update({ match_rule: "creating:" + runId, updated_at: nowIso() })
    .eq("team_member_id", tmId).is("employee_id", null)
    .or(`match_rule.not.like.creating:*,updated_at.lt."${stale}"`)
    .select("team_member_id");
  if (error) throw new Error(error.message);
  return (data ?? []).length === 1;
}

type Report = {
  mode: string; dry: boolean; square_members: number;
  linked: string[]; created: string[]; deactivated: string[]; reactivated: string[];
  contacts_filled: string[]; not_added: string[]; unchanged: number; errors: string[];
};

async function reconcile(mode: "setup" | "sync", dry: boolean): Promise<Report> {
  const runId = crypto.randomUUID().slice(0, 8);
  const team = await allTeam();
  const { data: linkRows, error: le } = await admin.from("square_team_links").select("*");
  if (le) throw new Error(le.message);
  const links = new Map((linkRows ?? []).map((l: any) => [String(l.team_member_id), l]));
  if (mode === "sync" && !links.size) throw new PublicError("Run setup first — nothing is linked yet.", 409);
  const emps = await loadEmps();
  const empById = new Map(emps.map((e) => [e.id, e]));
  const taken = new Set((linkRows ?? []).filter((l: any) => l.employee_id != null).map((l: any) => Number(l.employee_id)));
  const used = new Set(emps.map((e) => low(e.login_id)).filter(Boolean));
  const r: Report = { mode, dry, square_members: team.length, linked: [], created: [], deactivated: [], reactivated: [], contacts_filled: [], not_added: [], unchanged: 0, errors: [] };
  const now = nowIso();
  const seen: string[] = [];
  const track = async (id: string, extra: Record<string, unknown> = {}) => { // per-row write only when something changed
    seen.push(id);
    if (dry || !Object.keys(extra).length) return;
    const { error } = await admin.from("square_team_links").update(extra).eq("team_member_id", id);
    if (error) throw new Error(error.message);
  };
  const setActive = async (empId: number, active: boolean) => {
    if (dry) return;
    const { error } = await admin.from("portal_employees").update({ active }).eq("id", empId);
    if (error) throw new Error(error.message);
  };

  for (const m of team) {
    const status = String(m.status ?? "");
    const name = fullName(m) || "(no name)";
    const base = { square_status: status, square_name: name, is_owner: !!m.is_owner };
    const link: any = links.get(m.id);
    try {
      // 1. already linked → mirror a CHANGE of Square status, nothing else
      if (link && link.employee_id != null) {
        const emp = empById.get(Number(link.employee_id));
        const was = String(link.square_status ?? "");
        let changed = false;
        if (emp && was && was !== status) {
          if (status === "INACTIVE" && emp.active) { await setActive(emp.id, false); r.deactivated.push(emp.name); changed = true; }
          else if (status === "ACTIVE" && !emp.active) { await setActive(emp.id, true); r.reactivated.push(emp.name); changed = true; }
        }
        await track(m.id, was !== status || link.square_name !== name || !!link.is_owner !== !!m.is_owner ? { ...base, updated_at: now } : {});
        if (!changed) r.unchanged++;
        continue;
      }
      // 2. dismissed at setup, or deleted from the portal after linking → leave out, unless Square just
      //    reactivated them (INACTIVE → ACTIVE = a rehire)
      const blocked = !!link && (link.dismissed || link.linked_at);
      const rehire = !!link && String(link.square_status) === "INACTIVE" && status === "ACTIVE";
      if (blocked && !rehire) {
        await track(m.id, link.square_status !== status || link.square_name !== name ? { ...base, updated_at: now } : {});
        r.unchanged++;
        continue;
      }
      // 3. never linked → match an existing portal row first (never make a duplicate)
      const hit = matchEmp(m, emps.filter((e) => !taken.has(e.id)));
      if (hit) {
        if (!dry) {
          const { error } = await admin.from("square_team_links").upsert({
            team_member_id: m.id, employee_id: hit.emp.id, ...base, dismissed: false, match_rule: hit.rule,
            linked_at: now, last_seen_at: now, updated_at: now,
          });
          if (error) throw new Error(error.message);
        }
        taken.add(hit.emp.id);
        r.linked.push(`${hit.emp.name} = ${name} (${hit.rule})`);
        const filled = dry ? [] : await fillContacts(hit.emp, m);
        if (filled.length) r.contacts_filled.push(`${hit.emp.name}: ${filled.join(", ")}`);
        // a person newly added (or rehired) in Square is meant to be working → switch their old row back on
        if (mode === "sync" && status === "ACTIVE" && !hit.emp.active) { await setActive(hit.emp.id, true); r.reactivated.push(hit.emp.name); }
        continue;
      }
      // 4. no portal row
      const addable = mode === "sync" && status === "ACTIVE" && !m.is_owner;
      if (!addable) {
        const dismiss = (mode === "setup" && status === "ACTIVE") || !!m.is_owner;
        if (!dry) {
          const { error } = await admin.from("square_team_links").upsert({
            team_member_id: m.id, employee_id: null, ...base, dismissed: dismiss,
            match_rule: m.is_owner ? "owner" : dismiss ? "setup-skip" : "", last_seen_at: now, updated_at: now,
          });
          if (error) throw new Error(error.message);
        }
        if (dismiss) r.not_added.push(name + (m.is_owner ? " (account owner)" : ""));
        else r.unchanged++;
        continue;
      }
      // 5. new Square hire → add to the portal
      if (dry) { r.created.push(`${name} (${locOf(m)}, ${firstJob(m) || "no job"}, login ${pickLogin(m, used) || "none"})`); continue; }
      if (!(await claim(m.id, !!link, runId))) { r.unchanged++; continue; }
      try {
        let role = firstJob(m);
        if (!role) {
          try { role = tidy((await sq(`/v2/team-members/${encodeURIComponent(m.id)}/wage-setting`))?.wage_setting?.job_assignments?.[0]?.job_title); } catch (_) { /* role stays blank */ }
        }
        const login = pickLogin(m, used);
        const offSched = !!m.is_owner || /^(owner|admin)$/i.test(role);     // owners and admins: chat + emails, not the schedule
        const row = { name: name.slice(0, 120), login_id: login, role: role.slice(0, 60), location: locOf(m), active: true, on_schedule: !offSched };
        const { data, error } = await admin.from("portal_employees").insert(row).select("id").single();
        if (error) throw new Error(error.message);
        const id = Number(data.id);
        if (login) used.add(login.toLowerCase());
        const em = low(m.email_address), ph = e164(m.phone_number);
        if (em || ph) {
          const c = await admin.from("portal_employee_contacts").upsert({ employee_id: id, email: em, phone: ph, updated_at: now });
          if (c.error) throw new Error(c.error.message);
        }
        const { error: lerr } = await admin.from("square_team_links").update({
          employee_id: id, ...base, dismissed: false, match_rule: "created", linked_at: now, last_seen_at: now, updated_at: now,
        }).eq("team_member_id", m.id);
        if (lerr) throw new Error(lerr.message);
        taken.add(id);
        r.created.push(`${row.name} (${row.location}, ${row.role || "no role"}, login ${login || "none — set one"}${offSched ? ", off the schedule" : ""})`);
      } catch (e) {
        await admin.from("square_team_links").update({ match_rule: "", updated_at: nowIso() })
          .eq("team_member_id", m.id).eq("match_rule", "creating:" + runId);
        throw e;
      }
    } catch (e) {
      r.errors.push(`${name}: ${errMsg(e)}`);
    }
  }
  if (!dry && seen.length) await admin.from("square_team_links").update({ last_seen_at: now }).in("team_member_id", seen);
  return r;
}

// ---------- webhook subscription ----------
async function ensureWebhook() {
  const have = await secret(KEY_NAME);
  const list = await sq("/v2/webhooks/subscriptions?include_disabled=true");
  const subs: any[] = list.subscriptions ?? [];
  let sub = subs.find((s) => s.notification_url === NOTIFY_URL);
  let key = have;
  if (!sub) {
    const d = await sq("/v2/webhooks/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        subscription: { name: "GREYS staff portal — team sync", event_types: EVENT_TYPES, notification_url: NOTIFY_URL, api_version: SQUARE_VERSION },
      }),
    });
    sub = d.subscription;
    key = String(sub?.signature_key ?? "");
  } else {
    const types = new Set(sub.event_types ?? []);
    if (!sub.enabled || EVENT_TYPES.some((t) => !types.has(t))) {
      const d = await sq(`/v2/webhooks/subscriptions/${sub.id}`, {
        method: "PUT",
        body: JSON.stringify({ subscription: { enabled: true, event_types: Array.from(new Set([...types, ...EVENT_TYPES])) } }),
      });
      sub = d.subscription ?? sub;
    }
    if (!key) {
      const d = await sq(`/v2/webhooks/subscriptions/${sub.id}/signature-key`, { method: "POST", body: JSON.stringify({ idempotency_key: crypto.randomUUID() }) });
      key = String(d.signature_key ?? "");
    }
  }
  if (!key) throw new Error("Square did not return a signature key");
  if (key !== have) await setSecret(KEY_NAME, key);
  await setSecret(SUB_NAME, String(sub?.id ?? ""));
  return { ok: true, subscription_id: sub?.id ?? null, enabled: sub?.enabled ?? true, events: sub?.event_types ?? EVENT_TYPES };
}

// ---------- my hours (staff portal tile) ----------
// Chicago wall-clock dates, DST-safe (Square stamps each timecard with its own offset; days are the shop's days)
const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const ymd = (d: Date) => ymdFmt.format(d);
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function offsetMin(d: Date) {
  const p = partsFmt.formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - d.getTime()) / 60000);   // whole minutes (a time with milliseconds would leave a fraction)
}
function midnight(day: string) {           // 00:00 in Chicago on YYYY-MM-DD
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d) - offsetMin(new Date(t)) * 60000;
  return new Date(t);
}
function addDays(day: string, n: number) { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function weekStart(day: string) {          // Square workweek config: starts MON 00:00
  const [y, m, d] = day.split("-").map(Number);
  return addDays(day, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

async function searchCards(tmId: string, fromIso: string): Promise<{ cards: any[]; src: string }> {
  const body = JSON.stringify({ query: { filter: { team_member_ids: [tmId], start: { start_at: fromIso } }, sort: { field: "START_AT", order: "ASC" } }, limit: 200 });
  try {
    const d = await sq("/v2/labor/timecards/search", { method: "POST", body }, LABOR_VERSION);
    return { cards: d.timecards ?? [], src: "timecards" };
  } catch (_) {
    const d = await sq("/v2/labor/shifts/search", { method: "POST", body });
    return { cards: d.shifts ?? [], src: "shifts" };
  }
}

// the active employee behind an employee ID (+ their Square team member, if linked)
async function empByLogin(b: any) {
  const login = low(b?.login_id);
  if (!login || login.length > 40) throw new PublicError("Sign in with your employee ID.", 400);
  const { data: rows, error } = await admin.from("portal_employees").select("id,name,login_id,location").eq("active", true);
  if (error) throw new Error(error.message);
  const hits = (rows ?? []).filter((r: any) => low(r.login_id) === login);
  if (hits.length !== 1) throw new PublicError("No active employee with that ID.", 404);
  const emp = hits[0];
  const { data: link } = await admin.from("square_team_links").select("team_member_id").eq("employee_id", emp.id).maybeSingle();
  return { emp, tm: link?.team_member_id ? String(link.team_member_id) : "" };
}
async function teamMember(env: Env, tmId: string) {
  const d = await sqx(env, `/v2/team-members/${encodeURIComponent(tmId)}`);
  const m = d.team_member ?? null;
  if (m && !m.wage_setting) {
    try { m.wage_setting = (await sqx(env, `/v2/team-members/${encodeURIComponent(tmId)}/wage-setting`)).wage_setting; } catch (_) { /* no jobs */ }
  }
  return m;
}
function jobsOf(m: any): { title: string; job_id: string | null; rate: any }[] {
  return (m?.wage_setting?.job_assignments ?? []).map((j: any) => ({ title: tidy(j.job_title), job_id: j.job_id ?? null, rate: j.hourly_rate ?? null })).filter((j: any) => j.title);
}
function locsOf(m: any): string[] {
  if (m?.assigned_locations?.assignment_type === "ALL_CURRENT_AND_FUTURE_LOCATIONS") return Object.keys(LOC_NAME);
  return (m?.assigned_locations?.location_ids ?? []).filter((id: string) => LOC_NAME[id]);
}

async function myHours(b: any) {
  const { emp, tm } = await empByLogin(b);
  if (!tm) return { ok: true, linked: false, name: emp.name };

  const now = new Date(), today = ymd(now), thisWk = weekStart(today), lastWk = addDays(thisWk, -7);
  const [{ cards, src }, m, fx] = await Promise.all([
    searchCards(tm, midnight(lastWk).toISOString()),
    teamMember("production", tm).catch(() => null),
    admin.from("portal_time_fixes").select("id,timecard_id,kind,work_date,req_start,req_end,orig_start,orig_end,job_title,location_id,note,status,manager_note,square_error,created_at,decided_at")
      .eq("employee_id", emp.id).neq("status", "cancelled").gte("work_date", lastWk).order("created_at", { ascending: false }).limit(40),
  ]);
  const weeks = [
    { start: thisWk, end: addDays(thisWk, 6), min: 0, days: [] as any[] },
    { start: lastWk, end: addDays(lastWk, 6), min: 0, days: [] as any[] },
  ];
  let open: any = null, todayMin = 0;
  for (const c of cards) {
    const st = new Date(c.start_at);
    if (!c.start_at || isNaN(+st)) continue;
    const isOpen = !c.end_at;
    const en = isOpen ? now : new Date(c.end_at);
    let ms = en.getTime() - st.getTime(), onBreak = false;
    for (const br of c.breaks ?? []) {           // unpaid breaks don't count; paid ones do
      if (br?.is_paid) continue;
      const bs = new Date(br?.start_at);
      if (isNaN(+bs)) continue;
      const be = br.end_at ? new Date(br.end_at) : now;
      if (!br.end_at && isOpen) onBreak = true;
      ms -= Math.max(0, Math.min(be.getTime(), en.getTime()) - Math.max(bs.getTime(), st.getTime()));
    }
    const min = Math.max(0, Math.round(ms / 60000)), day = ymd(st);
    const wk = weeks.find((w) => day >= w.start && day <= w.end);
    if (!wk) continue;
    let d = wk.days.find((x: any) => x.date === day);
    if (!d) wk.days.push(d = { date: day, min: 0, cards: [] });
    const job = tidy(c.wage?.title), loc = LOC_NAME[c.location_id] ?? "";
    d.cards.push({ id: c.id, in: c.start_at, out: isOpen ? null : c.end_at, min, job, loc, open: isOpen, on_break: onBreak });
    d.min += min; wk.min += min;
    if (day === today) todayMin += min;
    if (isOpen) open = { start_at: c.start_at, job, loc, on_break: onBreak, min };
  }
  const jobs = jobsOf(m).map((j) => j.title);
  const locs = (m ? locsOf(m) : []).map((id) => ({ id, name: LOC_NAME[id] }));
  return { ok: true, linked: true, name: emp.name, now: now.toISOString(), today, today_min: todayMin, week_min: weeks[0].min, last_week_min: weeks[1].min, open, weeks,
    jobs, locs, fixes: fx.data ?? [], src };
}

// ---------- time fixes ----------
const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const clock = (d: Date) => clockFmt.format(d).replace(" AM", "a").replace(" PM", "p");
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const dayLabel = (day: string) => dayFmt.format(new Date(day + "T12:00:00Z"));
function localAt(day: string, hhmm: string) {   // a Chicago wall-clock time on YYYY-MM-DD → the instant
  const [y, m, d] = day.split("-").map(Number), [hh, mi] = hhmm.split(":").map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mi);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d, hh, mi) - offsetMin(new Date(t)) * 60000;
  return new Date(t);
}
function rfc(d: Date) {                          // RFC 3339 with the Chicago offset, the way Square writes them
  const off = offsetMin(d), a = Math.abs(off);
  return new Date(d.getTime() + off * 60000).toISOString().slice(0, 19) + (off < 0 ? "-" : "+")
    + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
}
function hhmm(v: unknown) {
  const s = tidy(v);
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) throw new PublicError("Pick a clock-in and a clock-out time.", 400);
  return s.padStart(5, "0");
}

async function fixRequest(b: any) {
  const { emp, tm } = await empByLogin(b);
  if (!tm) throw new PublicError("You’re not linked to Square yet — ask a manager.", 409);
  const now = new Date(), today = ymd(now), lastWk = addDays(weekStart(today), -7);
  const tcId = tidy(b.timecard_id), note = tidy(b.note).slice(0, 300);
  let day = tidy(b.date), orig: any = null, loc = "", job = "";
  if (tcId) {
    orig = (await sqx("production", `/v2/labor/timecards/${encodeURIComponent(tcId)}`, {}, LABOR_VERSION)).timecard;
    if (!orig || String(orig.team_member_id) !== tm) throw new PublicError("That clock-in isn’t yours.", 403);
    day = ymd(new Date(orig.start_at)); loc = String(orig.location_id ?? ""); job = tidy(orig.wage?.title);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new PublicError("Pick the day you worked.", 400);
    const m = await teamMember("production", tm);
    const locs = m ? locsOf(m) : [];
    loc = locs.includes(tidy(b.location_id)) ? tidy(b.location_id) : (locs[0] ?? LOC_ID[emp.location] ?? "");
    const jobs = jobsOf(m);
    job = jobs.some((j) => j.title === tidy(b.job)) ? tidy(b.job) : (jobs[0]?.title ?? "");
    if (!loc) throw new PublicError("Couldn’t tell which shop — ask a manager.", 409);
  }
  if (day < lastWk || day > today) throw new PublicError("You can fix this week and last week.", 400);
  // still on the clock: only the clock-in moves (open clock-ins only)
  const stillOn = b.still_on === true || b.still_on === "true";
  if (stillOn && (!orig || orig.end_at)) throw new PublicError("That clock-in already has a clock-out — put in the clock-out time.", 409);
  const start = localAt(day, hhmm(b.start));
  let end: Date | null = null;
  if (stillOn) {
    if (start.getTime() > now.getTime() + 5 * 60000) throw new PublicError("The clock-in can’t be later than now.", 400);
    if (now.getTime() - start.getTime() > 16 * 3600000) throw new PublicError("That’s over 16 hours — check the times.", 400);
  } else {
    end = localAt(day, hhmm(b.end));
    if (end <= start) end = new Date(end.getTime() + 86400000);        // clocked out after midnight
    if (end.getTime() - start.getTime() > 16 * 3600000) throw new PublicError("That’s over 16 hours — check the times.", 400);
    if (end.getTime() > now.getTime() + 5 * 60000) throw new PublicError("The clock-out can’t be later than now.", 400);
  }
  for (const br of orig?.breaks ?? []) {                               // Square refuses breaks outside the shift
    const bs = new Date(br?.start_at);
    if (stillOn) {
      if (bs < start) throw new PublicError(`That clock-in has a break at ${clock(bs)} — the new clock-in has to be before it.`, 400);
      continue;
    }
    if (!br?.end_at) throw new PublicError("You’re on a break on that clock-in — end the break first.", 409);
    const be = new Date(br.end_at);
    if (bs < start || be > end!) throw new PublicError(`That clock-in has a break ${clock(bs)}–${clock(be)} — the new times have to cover it.`, 400);
  }
  const until = end ?? now;
  const { cards } = await searchCards(tm, midnight(addDays(day, -1)).toISOString());
  for (const c of cards) {
    if (c.id === tcId || !c.start_at) continue;
    const cs = new Date(c.start_at), ce = c.end_at ? new Date(c.end_at) : now;
    if (cs < until && ce > start) throw new PublicError(`That overlaps your clock-in at ${clock(cs)} on ${dayLabel(ymd(cs))}.`, 409);
  }
  const row = {
    employee_id: emp.id, team_member_id: tm, timecard_id: tcId || null, kind: tcId ? "edit" : "add", location_id: loc, work_date: day,
    orig_start: orig?.start_at ?? null, orig_end: orig?.end_at ?? null, req_start: start.toISOString(), req_end: end ? end.toISOString() : null,
    job_title: job, note, status: "pending", square_error: null, updated_at: nowIso(),
  };
  if (tcId) {                                                          // one pending ask per clock-in: asking again replaces it
    const { data: ex } = await admin.from("portal_time_fixes").select("id").eq("timecard_id", tcId).eq("status", "pending").maybeSingle();
    if (ex) {
      const { error } = await admin.from("portal_time_fixes").update(row).eq("id", ex.id);
      if (error) throw new Error(error.message);
      return { ok: true, id: ex.id, replaced: true };
    }
  }
  const { data, error } = await admin.from("portal_time_fixes").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return { ok: true, id: data.id };
}

async function fixCancel(b: any) {
  const { emp } = await empByLogin(b);
  const { data, error } = await admin.from("portal_time_fixes").update({ status: "cancelled", updated_at: nowIso() })
    .eq("id", Number(b.id)).eq("employee_id", emp.id).eq("status", "pending").select("id");
  if (error) throw new Error(error.message);
  if (!(data ?? []).length) throw new PublicError("That request isn’t pending anymore.", 409);
  return { ok: true };
}

async function fixList(b: any) {
  const all = b?.status === "all";
  let q = admin.from("portal_time_fixes").select("*").neq("status", "cancelled").order("created_at", { ascending: false }).limit(all ? 80 : 60);
  if (!all) q = q.eq("status", "pending");
  const [{ data, error }, pend] = await Promise.all([q, admin.from("portal_time_fixes").select("id", { count: "exact", head: true }).eq("status", "pending")]);
  if (error) throw new Error(error.message);
  const ids = [...new Set((data ?? []).map((r: any) => r.employee_id))];
  const { data: emps } = ids.length ? await admin.from("portal_employees").select("id,name").in("id", ids) : { data: [] as any[] };
  const nm = new Map((emps ?? []).map((e: any) => [e.id, e.name]));
  return { ok: true, pending: pend.count ?? 0, rows: (data ?? []).map((r: any) => ({ ...r, name: nm.get(r.employee_id) ?? "(removed)", shop: LOC_NAME[r.location_id] ?? "" })) };
}

// write an approved fix into Square (env lets the self-test run the same code in the sandbox)
async function applyFix(env: Env, r: any, dry = false) {
  const start = rfc(new Date(r.req_start)), startMs = +new Date(r.req_start);
  if (r.kind === "edit") {
    const path = `/v2/labor/timecards/${encodeURIComponent(r.timecard_id)}`;
    const cur = (await sqx(env, path, {}, LABOR_VERSION)).timecard;
    if (!cur) throw new Error("that timecard isn’t in Square anymore");
    // a clock-in-only fix (req_end null) keeps whatever clock-out Square has now — none if they're still on the clock
    const endAt: string | null = r.req_end ? rfc(new Date(r.req_end)) : (cur.end_at ?? null);
    const endMs = endAt ? +new Date(endAt) : null;
    if (endMs !== null && endMs <= startMs) throw new Error("the clock-out in Square is before the new clock-in");
    for (const br of cur.breaks ?? []) {
      if (+new Date(br?.start_at) < startMs) throw new Error("a break falls outside the new times");
      if (!br?.end_at) { if (endMs !== null) throw new Error("a break is still open on that timecard"); continue; }
      if (endMs !== null && +new Date(br.end_at) > endMs) throw new Error("a break falls outside the new times");
    }
    const tc: any = { location_id: cur.location_id, team_member_id: cur.team_member_id, start_at: start, status: endAt ? "CLOSED" : "OPEN", version: cur.version };
    if (endAt) tc.end_at = endAt;
    if (cur.wage) tc.wage = cur.wage;
    if (cur.breaks?.length) tc.breaks = cur.breaks;
    if (cur.declared_cash_tip_money) tc.declared_cash_tip_money = cur.declared_cash_tip_money;
    if (dry) return { dry: true, method: "PUT", path, body: { timecard: tc } };
    const u = (await sqx(env, path, { method: "PUT", body: JSON.stringify({ timecard: tc }) }, LABOR_VERSION)).timecard;
    return { timecard_id: u?.id ?? r.timecard_id, start_at: u?.start_at, end_at: u?.end_at };
  }
  if (!r.req_end) throw new Error("a missed shift needs a clock-out");
  const end = rfc(new Date(r.req_end));
  const m = await teamMember(env, r.team_member_id);
  const jobs = jobsOf(m), j = jobs.find((x) => x.title === r.job_title) ?? jobs[0];
  const tc: any = { location_id: r.location_id, team_member_id: r.team_member_id, start_at: start, end_at: end, status: "CLOSED" };
  if (j) tc.wage = { title: j.title, ...(j.job_id ? { job_id: j.job_id } : {}), ...(j.rate ? { hourly_rate: j.rate } : {}) };
  const body = { idempotency_key: `greys-timefix-${r.id}`, timecard: tc };
  if (dry) return { dry: true, method: "POST", path: "/v2/labor/timecards", body };
  const c = (await sqx(env, "/v2/labor/timecards", { method: "POST", body: JSON.stringify(body) }, LABOR_VERSION)).timecard;
  return { timecard_id: c?.id ?? null, start_at: c?.start_at, end_at: c?.end_at };
}

// tell the employee (same channels as time-off decisions: text if they get texts, and email)
async function notifyFix(r: any, approved: boolean, mnote: string) {
  try {
    const { data: c } = await admin.from("portal_employee_contacts").select("email,phone,sms_opt_in").eq("employee_id", r.employee_id).maybeSingle();
    const when = r.req_end ? `${dayLabel(r.work_date)} ${clock(new Date(r.req_start))}–${clock(new Date(r.req_end))}`
      : `${dayLabel(r.work_date)} (clock-in ${clock(new Date(r.req_start))})`;
    const word = approved ? "approved — it’s in Square now" : "declined";
    const phone = e164(c?.phone);
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "", tok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "", from = Deno.env.get("TWILIO_FROM") ?? "";
    if (phone && c?.sms_opt_in !== false && sid && tok && from) {
      const text = `GREYS: your time fix for ${when} was ${word}.${mnote ? " " + mnote : ""}`.slice(0, 600);
      const params = new URLSearchParams({ To: phone, Body: text });
      if (/^MG[0-9a-fA-F]{32}$/.test(from)) params.set("MessagingServiceSid", from); else params.set("From", from);
      let ok = false, err = "";
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
        });
        ok = res.ok; if (!ok) err = String(res.status);
      } catch (e) { err = errMsg(e); }
      await admin.from("portal_sms_log").insert({ employee_id: r.employee_id, kind: "timefix", ref: String(r.id), to_phone: phone, body: text, ok, error: err }).then(() => {}, () => {});
    }
    if (c?.email) {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await fetch(`${SUPABASE_URL}/functions/v1/send-confirmation`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
        body: JSON.stringify({ from: Deno.env.get("PORTAL_MAIL_FROM") ?? "GREYS Schedule <info@greyscheese.com>", to: c.email,
          subject: `Time fix ${approved ? "approved" : "declined"}`,
          html: `<p>Your time fix for <strong>${esc(when)}</strong> was <strong>${approved ? "approved" : "declined"}</strong>${approved ? " and is in Square now" : ""}.</p>`
            + (mnote ? `<p>${esc(mnote)}</p>` : "") + `<p style="color:#888;font-size:12px">GREYS staff portal — this is an automated message.</p>` }),
      }).catch(() => {});
    }
  } catch (_) { /* a missed notice never blocks the decision */ }
}

async function fixDecide(b: any, who: string) {
  const id = Number(b?.id), approve = b?.approve === true || b?.approve === "true", dry = b?.dry === true, mnote = tidy(b?.note).slice(0, 300);
  const { data: r } = await admin.from("portal_time_fixes").select("*").eq("id", id).maybeSingle();
  if (!r) throw new PublicError("That request is gone.", 404);
  if (r.status !== "pending") throw new PublicError(`That request was already ${r.status}.`, 409);
  if (!approve) {
    if (dry) return { ok: true, dry: true, status: "declined" };
    const { data: done, error } = await admin.from("portal_time_fixes").update({ status: "declined", decided_by: who, decided_at: nowIso(), manager_note: mnote, updated_at: nowIso() })
      .eq("id", id).eq("status", "pending").select("id");
    if (error) throw new Error(error.message);
    if (done?.length) await notifyFix(r, false, mnote);
    return { ok: true, status: "declined" };
  }
  let res: any;
  try { res = await applyFix("production", r, dry); }
  catch (e) {
    if (!dry) await admin.from("portal_time_fixes").update({ square_error: errMsg(e).slice(0, 500), updated_at: nowIso() }).eq("id", id);
    throw new PublicError("Square didn’t take it: " + errMsg(e), 502);
  }
  if (dry) return { ok: true, ...res };
  await admin.from("portal_time_fixes").update({ status: "approved", decided_by: who, decided_at: nowIso(), manager_note: mnote,
    square_timecard_id: res.timecard_id, square_error: null, updated_at: nowIso() }).eq("id", id);
  await notifyFix(r, true, mnote);
  return { ok: true, status: "approved", timecard_id: res.timecard_id, start_at: res.start_at, end_at: res.end_at };
}

// the Square write shapes, end to end, in the SANDBOX: add a missed shift → fix its times → read back → delete
async function fixSelftest() {
  const env: Env = "sandbox";
  const tms = (await sqx(env, "/v2/team-members/search", { method: "POST", body: JSON.stringify({ limit: 20, query: { filter: { status: "ACTIVE" } } }) })).team_members ?? [];
  const tm = tms.find((m: any) => !m.is_owner) ?? tms[0];
  if (!tm) throw new Error("no sandbox team member");
  const loc = SANDBOX_LOCATION || (await sqx(env, "/v2/locations")).locations?.[0]?.id;
  const day = addDays(ymd(new Date()), -2), steps: any[] = [];
  const r: any = { id: "selftest-" + Date.now(), kind: "add", team_member_id: tm.id, location_id: loc, job_title: "",
    req_start: localAt(day, "09:00").toISOString(), req_end: localAt(day, "12:00").toISOString() };
  const add = await applyFix(env, r); steps.push({ add });
  try {
    const edit = await applyFix(env, { ...r, kind: "edit", timecard_id: add.timecard_id, req_start: localAt(day, "09:30").toISOString(), req_end: localAt(day, "13:15").toISOString() });
    steps.push({ edit });
    const back = (await sqx(env, `/v2/labor/timecards/${encodeURIComponent(add.timecard_id)}`, {}, LABOR_VERSION)).timecard;
    steps.push({ readback: { start_at: back?.start_at, end_at: back?.end_at, status: back?.status, version: back?.version } });
  } finally {
    if (add?.timecard_id) { await sqx(env, `/v2/labor/timecards/${encodeURIComponent(add.timecard_id)}`, { method: "DELETE" }, LABOR_VERSION); steps.push({ deleted: add.timecard_id }); }
  }
  // still on the clock: open a timecard → move only its clock-in (stays OPEN, no clock-out) → read back → delete
  const t0 = Date.now() - 3 * 3600000;
  const open = (await sqx(env, "/v2/labor/timecards", { method: "POST", body: JSON.stringify({ idempotency_key: "greys-selftest-open-" + Date.now(),
    timecard: { location_id: loc, team_member_id: tm.id, start_at: rfc(new Date(t0)) } }) }, LABOR_VERSION)).timecard;
  steps.push({ open: { id: open?.id, status: open?.status, start_at: open?.start_at } });
  try {
    const moved = await applyFix(env, { id: "selftest-open", kind: "edit", timecard_id: open.id, req_start: new Date(t0 - 3600000).toISOString(), req_end: null });
    steps.push({ moved });
    const back = (await sqx(env, `/v2/labor/timecards/${encodeURIComponent(open.id)}`, {}, LABOR_VERSION)).timecard;
    steps.push({ readback_open: { start_at: back?.start_at, end_at: back?.end_at ?? null, status: back?.status, version: back?.version } });
  } finally {
    if (open?.id) { await sqx(env, `/v2/labor/timecards/${encodeURIComponent(open.id)}`, { method: "DELETE" }, LABOR_VERSION); steps.push({ deleted: open.id }); }
  }
  return { ok: true, team_member: tm.id, location: loc, day, steps };
}

// ---------- auth ----------
async function who(req: Request, b: any): Promise<string | null> {
  const sec = tidy(b?.secret);
  if (sec) {
    const want = await secret("cc_cron_secret");
    if (want && safeEq(sec, want)) return "cron";
  }
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === ANON || tok.startsWith("sb_publishable_")) return null;
  if (tok === SERVICE) return "service";
  const user = createClient(SUPABASE_URL, ANON || SERVICE, { global: { headers: { Authorization: "Bearer " + tok } }, auth: { persistSession: false } });
  const { data, error } = await user.rpc("is_app_admin");
  if (error || data !== true) return null;
  const { data: u } = await admin.auth.getUser(tok);
  return tidy(u?.user?.email) || "manager";
}

async function status() {
  const { data } = await admin.from("square_team_links").select("team_member_id,employee_id,square_name,square_status,is_owner,dismissed,match_rule,linked_at,last_seen_at").order("square_name");
  const rows = data ?? [];
  return {
    linked: rows.filter((r: any) => r.employee_id != null).length,
    not_in_portal: rows.filter((r: any) => r.employee_id == null).map((r: any) => `${r.square_name} (${r.square_status}${r.dismissed ? ", not auto-added" : ""})`),
    webhook: !!(await secret(KEY_NAME)),
    last_seen: rows.reduce((a: string, r: any) => (String(r.last_seen_at) > a ? String(r.last_seen_at) : a), ""),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  const raw = await req.text();
  let b: any = {};
  try { b = raw ? JSON.parse(raw) : {}; } catch (_) { return json(req, { error: "bad json" }, 400); }

  try {
    // Square webhook
    const sig = req.headers.get("x-square-hmacsha256-signature");
    if (sig) {
      const key = await secret(KEY_NAME);
      if (!key || !safeEq(await hmacB64(key, NOTIFY_URL + raw), sig)) return json(req, { error: "bad signature" }, 401);
      if (b.merchant_id && b.merchant_id !== MERCHANT_ID) return json(req, { ok: true, ignored: "other merchant" });
      if (!EVENT_TYPES.includes(String(b.type ?? ""))) return json(req, { ok: true, ignored: b.type ?? "" });
      const r = await reconcile("sync", false);
      console.log("webhook", b.type, b.data?.id ?? "", JSON.stringify(r));
      return json(req, { ok: true, created: r.created.length, deactivated: r.deactivated.length, reactivated: r.reactivated.length, errors: r.errors.length });
    }

    // staff portal "My Hours" tile — keyed by the employee ID, like the rest of the portal
    if (b.action === "my-hours") return json(req, await myHours(b));
    if (b.action === "fix-request") return json(req, await fixRequest(b));
    if (b.action === "fix-cancel") return json(req, await fixCancel(b));

    const caller = await who(req, b);
    if (!caller) return json(req, { error: "not allowed" }, 401);
    const action = String(b.action ?? new URL(req.url).searchParams.get("action") ?? "sync");
    const dry = b.dry === true || b.dry === "true";

    if (action === "status") return json(req, { ok: true, ...(await status()) });
    if (action === "fix-list") return json(req, await fixList(b));
    if (action === "fix-decide") return json(req, await fixDecide(b, caller));
    if (action === "fix-selftest") {
      if (caller !== "service" && caller !== "cron") return json(req, { error: "not allowed" }, 401);
      return json(req, await fixSelftest());
    }
    if (action === "setup") {
      const report = await reconcile("setup", dry);
      let webhook: any = { skipped: dry };
      if (!dry && b.webhook !== false) {
        try { webhook = await ensureWebhook(); } catch (e) { webhook = { ok: false, error: errMsg(e) }; }
      }
      console.log("setup", caller, JSON.stringify({ report, webhook }));
      return json(req, { ok: true, report, webhook });
    }
    if (action === "sync") {
      const report = await reconcile("sync", dry);
      if (report.created.length || report.deactivated.length || report.reactivated.length || report.errors.length) console.log("sync", caller, JSON.stringify(report));
      return json(req, { ok: true, report });
    }
    return json(req, { error: "unknown action" }, 400);
  } catch (e) {
    const status = e instanceof PublicError ? e.status : 500;
    console.error("square-team-sync", errMsg(e));
    return json(req, { error: errMsg(e) }, status);
  }
});
