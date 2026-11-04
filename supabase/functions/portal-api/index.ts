import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PASS = Deno.env.get("NOTES_PASS") ?? "";
const WIX_API_KEY = Deno.env.get("WIX_API_KEY") ?? "";
const WIX_SITE_ID = Deno.env.get("WIX_SITE_ID") ?? "";
const WIX_LOCATION_ID = Deno.env.get("WIX_LOCATION_ID") ?? "908a32b3-cd51-490f-b1cb-635321094200";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const WIX_HEADERS = { "Authorization": WIX_API_KEY, "wix-site-id": WIX_SITE_ID, "Content-Type": "application/json" };
const WIX_RES_URL = "https://www.wixapis.com/table-reservations/reservations/v1/reservations";
// "Book it anyway" override — Wix wants ARRAYS of conflict types to ignore, not booleans.
const WIX_FORCE = {
  ignoreReservationLocationConflicts: ["PARTY_PACING", "SEAT_PACING"],
  ignoreTableCombinationConflicts: ["RESERVED", "TOO_BIG", "TOO_SMALL", "OFFLINE_ONLY"],
};
const WIX_LOC_URL = "https://www.wixapis.com/table-reservations/reservation-locations/v1/reservation-locations";

// ── Twilio SMS ─────────────────────────────────────────────────
const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TW_FROM = Deno.env.get("TWILIO_FROM") ?? ""; // +1XXXXXXXXXX, or a Messaging Service SID (MG…)
const smsConfigured = () => !!(TW_SID && TW_TOKEN && TW_FROM);
// Shared key that lets the pg_cron job call action=remind-shifts (and nothing else)
const CRON_KEY = Deno.env.get("PORTAL_CRON_KEY") ?? "";

// ── Shared admin check ────────────────────────────────────────────
// An authenticated Supabase user whose email is the master email, or is
// 'approved' in public.app_users, is an admin on every Greys site.
const MASTER_EMAIL = "bbearo@gmail.com";
async function requesterEmail(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  // Ignore the public/anon api keys — only real user JWTs identify someone.
  if (!token || token.startsWith("sb_publishable_") || token === (Deno.env.get("SUPABASE_ANON_KEY") ?? "__none__")) return "";
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error) return "";
    return (data.user?.email || "").toLowerCase();
  } catch (_) {
    return "";
  }
}
async function isAdminEmail(email: string): Promise<boolean> {
  if (!email) return false;
  if (email === MASTER_EMAIL) return true;
  const { data } = await admin
    .from("app_users")
    .select("email")
    .eq("status", "approved")
    .ilike("email", email)
    .maybeSingle();
  return !!data;
}

const REPEATS = ["none", "weekly", "biweekly", "monthly"];
const TYPES = ["note", "special", "event", "onboard", "info"];
const LOCATIONS = ["memphis", "nashville", "franklin"];
const DATED = ["special", "event"];
const norm = (v: any, allow: string[], def: string) =>
  allow.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : def;
const str = (v: any) => (v == null ? "" : String(v)).slice(0, 4000);

const itemRow = (r: Record<string, any>) => ({
  type: norm(r.type, TYPES, "note"),
  title: (r.title ?? r.name) ?? "",
  body: (r.body ?? r.desc ?? r.description) ?? "",
  date: r.date || null,
  time: r.time ?? "",
  end_date: (r.endDate || r.end_date) || null,
  repeat: norm(r.repeat, REPEATS, "none"),
  repeat_until: (r.repeatUntil || r.repeat_until) || null,
  location: norm(r.location, LOCATIONS, "memphis"),
  // Wix reservation blocking (staff-portal events): none | window | day
  block_scope: norm(r.blockScope ?? r.block_scope, ["none", "window", "day"], "none"),
  block_to: ((r.blockTo || r.block_to) || null),
  // Booking status shown on the portal: none | confirmed | tentative
  status: norm(r.status, ["none", "confirmed", "tentative"], "none"),
  // Archived rows stay in the table but drop off the staff portal.
  // The console sends "archived"/"live"; a nightly cron archives past events.
  archived: r.archived === true || r.archived === "archived" || r.archived === "true",
});
const schRow = (r: Record<string, any>) => ({
  name: r.name, date: r.date,
  end_date: (r.endDate || r.end_date) || null, note: r.note ?? "",
  location: norm(r.location, LOCATIONS, "memphis"),
});
const itemValid = (r: any) => {
  if (!r || !(r.title || r.name)) return false;
  const t = norm(r.type, TYPES, "note");
  return DATED.includes(t) ? !!r.date : true;
};

// ── Scheduling app: employees + shifts ────────────────────────────
// login_id is the free-text "Employee ID" staff type to open their schedule
// (kept exactly as entered, matched case-insensitively on the client).
const empRow = (r: Record<string, any>) => ({
  name: str(r.name).trim(),
  login_id: str(r.login_id ?? r.email).trim(),
  role: str(r.role).trim(),
  active: !(r.active === false || ["false", "inactive", "no"].includes(String(r.active).toLowerCase())),
  location: norm(r.location, LOCATIONS, "memphis"),
});
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// kind: 'shift' = regular hours · 'oncall' = on call (times optional)
//     · 'offsite' = working away from the shop, e.g. catering/market (times optional)
//     · 'off' = scheduled day off
const SHIFT_KINDS = ["shift", "oncall", "offsite", "off"];
const shiftRow = (r: Record<string, any>) => {
  const kind = norm(r.kind, SHIFT_KINDS, "shift");
  // off/oncall rows may omit times — stored as 00:00–00:00 (NOT NULL columns)
  const st = String(r.start_time ?? r.startTime ?? "");
  const en = String(r.end_time ?? r.endTime ?? "");
  return {
    employee_id: Number(r.employee_id ?? r.employeeId),
    date: r.date,
    start_time: TIME_RE.test(st) ? st : "00:00",
    end_time: TIME_RE.test(en) ? en : "00:00",
    kind,
    role: kind === "off" ? "" : str(r.role).trim(),
    note: str(r.note).trim(),
    location: norm(r.location, LOCATIONS, "memphis"),
  };
};
const shiftValid = (r: any) => {
  if (!r || !(Number(r.employee_id ?? r.employeeId) > 0) || !DATE_RE.test(String(r.date ?? ""))) return false;
  const kind = norm(r.kind, SHIFT_KINDS, "shift");
  const st = String(r.start_time ?? r.startTime ?? "");
  const en = String(r.end_time ?? r.endTime ?? "");
  if (kind === "shift") return TIME_RE.test(st) && TIME_RE.test(en);
  return (st === "" && en === "") || (TIME_RE.test(st) && TIME_RE.test(en));
};
const kindOf = (s: any) =>
  s?.kind === "oncall" || s?.kind === "off" || s?.kind === "offsite" ? s.kind : "shift";
// human label for a shift row in emails/texts, e.g. "5pm–10pm", "On call", "Offsite 9am–2pm", "Off"
const shiftLabel = (s: any): string => {
  const k = kindOf(s);
  const noTimes = String(s.start_time).slice(0, 5) === "00:00" && String(s.end_time).slice(0, 5) === "00:00";
  const times = `${fmtTime(String(s.start_time).slice(0, 5))}–${fmtTime(String(s.end_time).slice(0, 5))}`;
  if (k === "off") return "Off";
  if (k === "oncall") return "On call" + (noTimes ? "" : " " + times);
  if (k === "offsite") return "Offsite" + (noTimes ? "" : " " + times);
  return times;
};
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Notifications (reuses the send-confirmation relay: SMTP2GO / SendGrid) ──
const MAIL_FROM = Deno.env.get("PORTAL_MAIL_FROM") ?? "GREYS Schedule <info@greyscheese.com>";
const LOC_NAMES: Record<string, string> = { memphis: "Memphis", nashville: "Nashville", franklin: "Franklin" };
const LOC_GROUPS: Record<string, string[]> = { memphis: ["memphis"], nashville: ["nashville", "franklin"], franklin: ["nashville", "franklin"] };
const escHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const fmtShortD = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
const fmtTime = (t: string) => { const p = String(t).split(":").map(Number); const ap = p[0] >= 12 ? "pm" : "am"; return (((p[0] + 11) % 12) + 1) + (p[1] ? ":" + String(p[1]).padStart(2, "0") : "") + ap; };
const likeLit = (s: string) => String(s).replace(/([\\%_])/g, "\\$1");

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/send-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_SERVICE}` },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html: html + `<p style="color:#888;font-size:12px">GREYS staff portal — this is an automated message.</p>` }),
    });
    return r.ok;
  } catch (_) { return false; }
}

// ── SMS via Twilio ─────────────────────────────────────────────────
// US numbers: 10 digits get +1. Stored/sent in E.164.
const e164 = (p: any) => {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return /^\d{8,15}$/.test(digits) ? "+" + digits : "";
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
};
async function sendSMS(to: string, body: string, log: { employee_id?: number | null; kind: string; ref?: string }): Promise<boolean> {
  const phone = e164(to);
  if (!phone || !smsConfigured()) return false;
  const text = body.slice(0, 1400);
  let ok = false, err = "";
  try {
    const params = new URLSearchParams({ To: phone, Body: text });
    if (/^MG[0-9a-fA-F]{32}$/.test(TW_FROM)) params.set("MessagingServiceSid", TW_FROM);
    else params.set("From", TW_FROM);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
      method: "POST",
      headers: { "Authorization": "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    ok = r.ok;
    if (!r.ok) { const d = await r.json().catch(() => ({})); err = String((d as any).message || r.status); }
  } catch (e) { err = String((e as Error)?.message ?? e); }
  try {
    await admin.from("portal_sms_log").insert({
      employee_id: log.employee_id ?? null, kind: log.kind, ref: log.ref ?? "",
      to_phone: phone, body: text, ok, error: err,
    });
  } catch (_) { /* dedupe index may reject repeats — fine */ }
  return ok;
}
async function phonesFor(ids: number[], kind = "", skipped?: Set<number>): Promise<Record<number, string>> {
  const map: Record<number, string> = {};
  if (!ids.length) return map;
  const { data } = await admin.from("portal_employee_contacts").select("employee_id,phone,sms_opt_in").in("employee_id", ids);
  const off = await notifyOff(ids, kind, "sms");
  (data || []).forEach((r: any) => {
    const p = e164(r.phone);
    if (!p || r.sms_opt_in === false) return;
    if (off.has(Number(r.employee_id))) { skipped?.add(Number(r.employee_id)); return; }
    map[r.employee_id] = p;
  });
  return map;
}

// ── NOTIFY-PREFS (2026-11-04): each person's Text / Email checkboxes ──────────
// portal_notify_prefs.prefs = {"<kind>": {"sms": bool, "email": bool}}. A missing kind or channel
// means ON, and so does a failed lookup — a hiccup never silences schedule notices.
// Kinds: schedule · reminder · timeoff · swap · timefix (square-team-sync) · announce · quicktext
async function notifyOff(ids: number[], kind: string, channel: "sms" | "email"): Promise<Set<number>> {
  const off = new Set<number>();
  if (!kind || !ids.length) return off;
  try {
    const { data, error } = await admin.from("portal_notify_prefs").select("employee_id,prefs").in("employee_id", ids);
    if (error) return off;
    (data || []).forEach((r: any) => { if (r.prefs?.[kind]?.[channel] === false) off.add(Number(r.employee_id)); });
  } catch (_) { /* everyone stays on */ }
  return off;
}

// Verify an "employee ID" login against a specific employee row.
// Same trust level as the rest of the staff portal (no passwords — internal tool).
async function verifyEmp(login_id: any, employee_id: any) {
  const id = str(login_id).trim();
  const empId = Number(employee_id);
  if (!id || !empId) return null;
  const { data } = await admin.from("portal_employees").select("*").ilike("login_id", likeLit(id)).eq("active", true);
  return (data || []).find((e: any) => e.id === empId) || null;
}
async function contactsFor(ids: number[], kind = "", skipped?: Set<number>): Promise<Record<number, string>> {
  const map: Record<number, string> = {};
  if (!ids.length) return map;
  const { data } = await admin.from("portal_employee_contacts").select("*").in("employee_id", ids);
  const off = await notifyOff(ids, kind, "email");
  (data || []).forEach((r: any) => {
    if (!r.email) return;
    if (off.has(Number(r.employee_id))) { skipped?.add(Number(r.employee_id)); return; }
    map[r.employee_id] = r.email;
  });
  return map;
}

function b64ToBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma);
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ct = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  return { bytes, ct };
}
const onbRow = (p: Record<string, any>, id_path: string) => ({
  full_name: str(p.full_name), preferred_name: str(p.preferred_name), dob: p.dob || null,
  email: str(p.email), phone: str(p.phone), address: str(p.address),
  emergency_name: str(p.emergency_name), emergency_phone: str(p.emergency_phone),
  ssn: str(p.ssn), bank_name: str(p.bank_name), routing: str(p.routing),
  account: str(p.account), account_type: str(p.account_type),
  availability: str(p.availability), start_date: p.start_date || null, shirt_size: str(p.shirt_size),
  ack_handbook: !!p.ack_handbook, ack_safety: !!p.ack_safety, ack_policies: !!p.ack_policies,
  ack_signature: str(p.ack_signature), id_path,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (action === "reservations") {
    if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
    // Wix Search Reservations: filters by location + date range server-side, cursor-paged,
    // so every location gets its complete set (the old list endpoint capped at 100 across all locations).
    // Wix only allows one operator per field instance, so range bounds go in separate $and conditions.
    const sp = url.searchParams;
    const locId = sp.get("location_id") || WIX_LOCATION_ID;
    const from = sp.get("startDateFrom");
    const to = sp.get("startDateTo");
    const status = sp.get("status");
    const conds: Record<string, any>[] = [{ "details.reservationLocationId": { "$eq": locId } }];
    if (from) conds.push({ "details.startDate": { "$gte": from } });
    if (to) conds.push({ "details.startDate": { "$lte": to } });
    const filter = conds.length > 1 ? { "$and": conds } : conds[0];

    const all: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const body = cursor
        ? { search: { cursorPaging: { limit: 100, cursor } } }
        : { search: { filter, sort: [{ fieldName: "details.startDate", order: "ASC" }], cursorPaging: { limit: 100 } } };
      const r = await fetch(WIX_RES_URL + "/search", {
        method: "POST", headers: WIX_HEADERS, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json(data, r.status);
      all.push(...(data.reservations || []));
      cursor = data.pagingMetadata?.cursors?.next || null;
      if (!data.pagingMetadata?.hasNext || !cursor) break;
    }
    // HELD / PAYMENT_INFORMATION_PENDING are 10-minute checkout holds, not real bookings
    const visible = all.filter((x: any) => x?.status !== "HELD" && x?.status !== "PAYMENT_INFORMATION_PENDING");
    const rows = status
      ? visible.filter((x: any) => x?.status === status || (status === "CANCELLED" && x?.status === "CANCELED"))
      : visible;
    // Guest privacy: the portal only ever shows a name, a time and a party size,
    // so each row is mapped to this whitelist before it leaves the function.
    // Phone, email, teamMessage, contactId, customFields, reservedBy, marketing
    // consent and anything else Wix returns stay server-side. Actions that need
    // the guest's phone (cancel-reservation) read it from Wix themselves.
    const slim = (x: any) => ({
      id: x?.id,
      status: x?.status,
      createdDate: x?.createdDate,
      source: x?.source,
      details: {
        reservationLocationId: x?.details?.reservationLocationId,
        startDate: x?.details?.startDate,
        endDate: x?.details?.endDate,
        partySize: x?.details?.partySize,
      },
      reservee: { firstName: x?.reservee?.firstName, lastName: x?.reservee?.lastName },
    });
    return json({ reservations: rows.map(slim) });
  }

  if (action === "locations") {
    if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
    const r = await fetch("https://www.wixapis.com/table-reservations/reservation-locations/v1/reservation-locations", { headers: WIX_HEADERS });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let payload: Record<string, any> = {};
  try { payload = await req.json(); } catch (_) { /* ignore */ }
  const pass = payload.password ?? "";

  // ---- Public: approve / decline a requested reservation (staff portal has no login) ----
  // Can only move a REQUESTED reservation to RESERVED or DECLINED — nothing else is reachable.
  if (action === "set-reservation") {
    try {
      if (!payload.id) return json({ error: "id required" }, 400);
      if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
      const st = payload.status === "DECLINED" ? "DECLINED" : "RESERVED";
      // Wix requires the current revision on every update; fetch it fresh
      const g = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}`, { headers: WIX_HEADERS });
      const gd = await g.json().catch(() => ({}));
      if (!g.ok) return json({ error: gd.message || "Could not load reservation" }, g.status);
      const cur = gd.reservation;
      if (!cur || cur.revision == null) return json({ error: "Could not read reservation" }, 500);
      if (cur.status !== "REQUESTED") return json({ error: "Only requested reservations can be approved or declined here (current status: " + cur.status + ")." }, 409);
      const resBody: Record<string, any> = { status: st, revision: cur.revision };
      if (st === "DECLINED" && payload.reason) resBody.declineReason = str(payload.reason);
      const r = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}`, {
        method: "PATCH", headers: WIX_HEADERS, body: JSON.stringify({ reservation: resBody }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data.message || "Wix update failed" }, r.status);
      return json({ ok: true, status: data.reservation?.status });
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  }

  // ---- Public: new-hire onboarding submission (no password) ----
  if (action === "submit-onboarding") {
    try {
      if (!payload.full_name || !String(payload.full_name).trim())
        return json({ error: "Your full name is required." }, 400);
      let id_path = "";
      if (typeof payload.idImage === "string" && payload.idImage.startsWith("data:")) {
        const { bytes, ct } = b64ToBytes(payload.idImage);
        if (bytes.length > 8 * 1024 * 1024) return json({ error: "ID image is too large (max 8MB)." }, 400);
        const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
        id_path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const up = await admin.storage.from("onboarding-ids").upload(id_path, bytes, { contentType: ct, upsert: false });
        if (up.error) return json({ error: "ID upload failed: " + up.error.message }, 500);
      }
      const ins = await admin.from("portal_onboarding").insert(onbRow(payload, id_path));
      if (ins.error) return json({ error: ins.error.message }, 500);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  }

  // ---- Employee self-service actions ------------------------------------
  // Verified by employee ID (login_id) — same trust level as time-off requests.
  try {
    if (action === "set-my-email") {
      const emp = await verifyEmp(payload.login_id, payload.employee_id);
      if (!emp) return json({ error: "Employee not found — check your employee ID." }, 403);
      const em = str(payload.email).trim().toLowerCase();
      if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: "That email doesn't look right." }, 400);
      const { error } = await admin.from("portal_employee_contacts").upsert({ employee_id: emp.id, email: em, updated_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "set-my-phone") {
      const emp = await verifyEmp(payload.login_id, payload.employee_id);
      if (!emp) return json({ error: "Employee not found — check your employee ID." }, 403);
      const raw = str(payload.phone).trim();
      const phone = raw ? e164(raw) : "";
      if (raw && !phone) return json({ error: "That phone number doesn't look right — use 10 digits, e.g. 901-555-1234." }, 400);
      const opt = !(payload.sms_opt_in === false || payload.sms_opt_in === "false");
      const { error } = await admin.from("portal_employee_contacts").upsert({ employee_id: emp.id, phone, sms_opt_in: opt, updated_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, phone });
    }
    if (action === "get-my-email") {
      const emp = await verifyEmp(payload.login_id, payload.employee_id);
      if (!emp) return json({ error: "Employee not found" }, 403);
      const { data } = await admin.from("portal_employee_contacts").select("email,phone,sms_opt_in").eq("employee_id", emp.id).maybeSingle();
      return json({ ok: true, email: data?.email || "", phone: data?.phone || "", sms_opt_in: data?.sms_opt_in !== false });
    }
    if (action === "set-availability") {
      const emp = await verifyEmp(payload.login_id, payload.employee_id);
      if (!emp) return json({ error: "Employee not found — check your employee ID." }, 403);
      const rows = (Array.isArray(payload.rows) ? payload.rows : [])
        .filter((r: any) => r && Number(r.weekday) >= 0 && Number(r.weekday) <= 6)
        .slice(0, 40)
        .map((r: any) => ({
          employee_id: emp.id,
          weekday: Number(r.weekday),
          kind: ["unavailable", "preferred"].includes(String(r.kind)) ? String(r.kind) : "unavailable",
          start_time: TIME_RE.test(String(r.start_time ?? "")) ? r.start_time : null,
          end_time: TIME_RE.test(String(r.end_time ?? "")) ? r.end_time : null,
          note: str(r.note).slice(0, 200),
        }));
      const del = await admin.from("portal_availability").delete().eq("employee_id", emp.id);
      if (del.error) return json({ error: del.error.message }, 500);
      if (rows.length) {
        const ins = await admin.from("portal_availability").insert(rows);
        if (ins.error) return json({ error: ins.error.message }, 500);
      }
      return json({ ok: true, saved: rows.length });
    }
    if (action === "request-swap") {
      const shiftId = Number(payload.shift_id);
      const toId = Number(payload.to_employee_id);
      if (!shiftId || !toId) return json({ error: "shift_id and to_employee_id required" }, 400);
      const { data: shift } = await admin.from("portal_shifts").select("*").eq("id", shiftId).maybeSingle();
      if (!shift) return json({ error: "Shift not found" }, 404);
      const emp = await verifyEmp(payload.login_id, shift.employee_id);
      if (!emp) return json({ error: "You can only offer your own shifts." }, 403);
      if (toId === emp.id) return json({ error: "Pick a different employee." }, 400);
      const { data: toEmp } = await admin.from("portal_employees").select("*").eq("id", toId).eq("active", true).maybeSingle();
      if (!toEmp) return json({ error: "That employee isn't available." }, 404);
      const group = LOC_GROUPS[shift.location] || [shift.location];
      if (!group.includes(toEmp.location)) return json({ error: "That employee works at a different location." }, 400);
      const { data: open } = await admin.from("portal_swaps").select("id").eq("shift_id", shiftId).in("status", ["pending_peer", "accepted"]);
      if (open && open.length) return json({ error: "There's already an open swap request for this shift." }, 409);
      const { error } = await admin.from("portal_swaps").insert({
        shift_id: shiftId, from_employee_id: emp.id, to_employee_id: toId,
        note: str(payload.note).slice(0, 300), location: shift.location,
      });
      if (error) return json({ error: error.message }, 500);
      const emails = await contactsFor([toId], "swap");
      if (emails[toId]) {
        await sendMail(emails[toId], `${emp.name} asked to swap a shift with you`,
          `<p>${escHtml(emp.name)} wants you to take their shift on <strong>${fmtDate(shift.date)}</strong>, ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}${shift.role ? ` (${escHtml(shift.role)})` : ""} at ${LOC_NAMES[shift.location] || shift.location}.</p>${payload.note ? `<p>“${escHtml(str(payload.note).slice(0, 300))}”</p>` : ""}<p>Open the schedule page and enter your employee ID to accept or decline.</p>`);
      }
      const phones = await phonesFor([toId], "swap");
      if (phones[toId]) {
        await sendSMS(phones[toId], `GREYS: ${emp.name} asked you to take their shift ${fmtShortD(shift.date)} ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)} at ${LOC_NAMES[shift.location] || shift.location}. Open staff.greyscheese.com/schedule.html to accept or decline.`, { employee_id: toId, kind: "swap", ref: "req:" + shiftId });
      }
      return json({ ok: true });
    }
    if (action === "respond-swap") {
      const swapId = Number(payload.swap_id);
      const { data: swap } = await admin.from("portal_swaps").select("*").eq("id", swapId).maybeSingle();
      if (!swap) return json({ error: "Swap not found" }, 404);
      if (swap.status !== "pending_peer") return json({ error: "This request was already handled." }, 409);
      const emp = await verifyEmp(payload.login_id, swap.to_employee_id);
      if (!emp) return json({ error: "This request isn't addressed to you." }, 403);
      const accept = payload.accept === true || payload.accept === "true";
      const { error } = await admin.from("portal_swaps").update({ status: accept ? "accepted" : "declined", decided_at: accept ? null : new Date().toISOString() }).eq("id", swapId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, status: accept ? "accepted" : "declined" });
    }
    if (action === "cancel-swap") {
      const swapId = Number(payload.swap_id);
      const { data: swap } = await admin.from("portal_swaps").select("*").eq("id", swapId).maybeSingle();
      if (!swap) return json({ error: "Swap not found" }, 404);
      const emp = await verifyEmp(payload.login_id, swap.from_employee_id);
      if (!emp) return json({ error: "Only the requester can cancel." }, 403);
      if (!["pending_peer", "accepted"].includes(swap.status)) return json({ error: "This request was already handled." }, 409);
      await admin.from("portal_swaps").update({ status: "cancelled", decided_at: new Date().toISOString() }).eq("id", swapId);
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }

  // ---- Admin gate: signed-in approved admin (shared app_users allow-list)
  //      OR the legacy manager password (kept for transition; remove NOTES_PASS to retire it).
  //      The pg_cron shift-reminder job authenticates with PORTAL_CRON_KEY and can
  //      only reach action=remind-shifts.
  const email = await requesterEmail(req);
  const cronOk = action === "remind-shifts" && CRON_KEY !== "" && str(payload.cron_key) === CRON_KEY;
  const isAdmin = (await isAdminEmail(email)) || (PASS !== "" && pass === PASS) || cronOk;

  if (action === "verify") {
    return isAdmin ? json({ ok: true, email }) : json({ error: "Not authorized" }, 403);
  }
  if (!isAdmin) return json({ error: "Not authorized" }, 403);

  try {
    switch (action) {
      // ── Manager reservation editor (Wix Table Reservations) ─────────
      // create-reservation: manager phone-in/walk-in bookings, created RESERVED.
      // update-reservation: edit date/time, party size, or guest info.
      // cancel-reservation: cancel with fresh revision; Wix notifies the guest.
      // payload.force=true retries past Wix conflict checks (double-book override).
      case "create-reservation": {
        if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
        const locId = str(payload.location_id) || WIX_LOCATION_ID;
        const start = str(payload.start);
        const party = Number(payload.party);
        const firstName = str(payload.first_name).trim();
        // Wix requires international format — e164() turns 10-digit US numbers into +1XXXXXXXXXX
        const phone = e164(str(payload.phone).trim());
        if (!start || !party || party < 1) return json({ error: "Start time and party size are required." }, 400);
        if (!firstName) return json({ error: "Guest first name is required." }, 400);
        if (!phone) return json({ error: "That phone number doesn't look right — use 10 digits, e.g. 901-555-1234." }, 400);
        const details: Record<string, any> = { reservationLocationId: locId, startDate: start, partySize: party };
        if (payload.end) details.endDate = str(payload.end);
        const reservee: Record<string, any> = { firstName, phone };
        if (payload.last_name) reservee.lastName = str(payload.last_name).trim();
        if (payload.email) reservee.email = str(payload.email).trim();
        const body: Record<string, any> = { reservation: { status: "RESERVED", details, reservee } };
        if (payload.force === true) Object.assign(body, WIX_FORCE);
        const r = await fetch(WIX_RES_URL, { method: "POST", headers: WIX_HEADERS, body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data.message || "Wix could not create the reservation.", conflict: r.status === 428 }, r.status);
        return json({ ok: true, reservation: data.reservation });
      }

      case "update-reservation": {
        if (!payload.id) return json({ error: "id required" }, 400);
        if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
        // Wix requires the current revision; fetch fresh, then send full merged
        // details/reservee objects so a partial PATCH can't drop sub-fields.
        const g = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}`, { headers: WIX_HEADERS });
        const gd = await g.json().catch(() => ({}));
        if (!g.ok) return json({ error: gd.message || "Could not load reservation" }, g.status);
        const cur = gd.reservation;
        if (!cur || cur.revision == null) return json({ error: "Could not read reservation" }, 500);
        if (["CANCELED", "CANCELLED", "NO_SHOW", "FINISHED"].includes(cur.status)) {
          return json({ error: "This reservation is " + cur.status.toLowerCase() + " and can no longer be edited." }, 409);
        }
        const details: Record<string, any> = { ...(cur.details || {}) };
        if (payload.start) details.startDate = str(payload.start);
        if (payload.end) details.endDate = str(payload.end);
        else if (payload.start && cur.details?.startDate && cur.details?.endDate) {
          // keep the original duration when only the start moves
          const dur = Date.parse(cur.details.endDate) - Date.parse(cur.details.startDate);
          if (dur > 0 && !isNaN(Date.parse(str(payload.start)))) details.endDate = new Date(Date.parse(str(payload.start)) + dur).toISOString();
        }
        if (payload.party != null && Number(payload.party) >= 1) details.partySize = Number(payload.party);
        const reservee: Record<string, any> = { ...(cur.reservee || {}) };
        if (payload.first_name != null) reservee.firstName = str(payload.first_name).trim();
        if (payload.last_name != null) reservee.lastName = str(payload.last_name).trim();
        if (payload.phone != null) {
          const ph = e164(str(payload.phone).trim());
          if (!ph) return json({ error: "That phone number doesn't look right — use 10 digits, e.g. 901-555-1234." }, 400);
          reservee.phone = ph;
        }
        if (payload.email != null) reservee.email = str(payload.email).trim();
        if (!reservee.firstName || !reservee.phone) return json({ error: "Guest first name and phone are required." }, 400);
        const resBody: Record<string, any> = { revision: cur.revision, details, reservee };
        const body: Record<string, any> = { reservation: resBody };
        if (payload.force === true) Object.assign(body, WIX_FORCE);
        const r = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}`, {
          method: "PATCH", headers: WIX_HEADERS, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data.message || "Wix update failed", conflict: r.status === 428 }, r.status);
        return json({ ok: true, reservation: data.reservation });
      }

      case "cancel-reservation": {
        if (!payload.id) return json({ error: "id required" }, 400);
        if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
        const g = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}`, { headers: WIX_HEADERS });
        const gd = await g.json().catch(() => ({}));
        if (!g.ok) return json({ error: gd.message || "Could not load reservation" }, g.status);
        const cur = gd.reservation;
        if (!cur || cur.revision == null) return json({ error: "Could not read reservation" }, 500);
        if (["CANCELED", "CANCELLED"].includes(cur.status)) return json({ ok: true, already: true });
        // Wix's cancel requires the reservee's phone but is picky about its FORMAT
        // (PHONE_NUMBER_REQUIRED even when a "+1..." phone is sent). Try each
        // plausible format until one is accepted: as stored → digits only →
        // 10-digit local → no phone.
        const tryCancel = async (phone?: string) => {
          const b: Record<string, any> = { revision: cur.revision };
          if (phone) b.phone = phone;
          const r = await fetch(`${WIX_RES_URL}/${encodeURIComponent(payload.id)}/cancel`, {
            method: "POST", headers: WIX_HEADERS, body: JSON.stringify(b),
          });
          const data = await r.json().catch(() => ({}));
          return { ok: r.ok, status: r.status, data };
        };
        // The single-reservation GET can omit/mask reservee.phone — fall back to
        // the client-provided phone, then to a search by id (search returns full reservee).
        let stored = String(cur.reservee?.phone || str(payload.phone) || "").trim();
        if (!stored) {
          try {
            const sr = await fetch(WIX_RES_URL + "/search", {
              method: "POST", headers: WIX_HEADERS,
              body: JSON.stringify({ search: { filter: { "_id": { "$eq": payload.id } }, cursorPaging: { limit: 1 } } }),
            });
            const sd = await sr.json().catch(() => ({}));
            stored = String(sd.reservations?.[0]?.reservee?.phone || "").trim();
          } catch (_) { /* fall through to no-phone attempt */ }
        }
        const digits = stored.replace(/\D/g, "");
        const variants: (string | undefined)[] = [];
        if (stored) variants.push(stored);
        if (digits && digits !== stored) variants.push(digits);
        if (digits.length === 11 && digits.startsWith("1")) variants.push(digits.slice(1));
        variants.push(undefined);
        let last: { ok: boolean; status: number; data: any } | null = null;
        for (const v of variants) {
          last = await tryCancel(v);
          if (last.ok) break;
        }
        if (!last || !last.ok) {
          const d = last?.data || {};
          const detail = d.details?.applicationError?.code || d.details?.applicationError?.description || "";
          return json({ error: (d.message || "Wix could not cancel the reservation.") + (detail ? " (" + detail + ")" : "") }, last?.status || 500);
        }
        return json({ ok: true, reservation: last.data.reservation });
      }

      // ── Blocked dates (online reservations) ─────────────────────────
      // block-reservations: closes the Wix online-reservation widget for a
      // time window by writing a specialHourPeriod (isClosed) onto the
      // location's online-reservations business schedule — the same mechanism
      // as the Wix dashboard's "block". Manager/phone-in bookings still work.
      // Also prunes blocks that ended 2+ days ago (Wix caps the list at 50).
      // payload: { location_id, start, end (ISO instants), comment,
      //            replace_prefix? (drop existing blocks whose comment starts with this) }
      case "block-reservations": {
        if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
        const locId = str(payload.location_id) || WIX_LOCATION_ID;
        const start = str(payload.start), end = str(payload.end);
        const comment = (str(payload.comment).trim() || "Blocked from portal").slice(0, 200);
        const replacePrefix = str(payload.replace_prefix);
        if (!start || !end || isNaN(Date.parse(start)) || isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(start))
          return json({ error: "A valid start and end are required." }, 400);
        const g = await fetch(`${WIX_LOC_URL}/${encodeURIComponent(locId)}`, { headers: WIX_HEADERS });
        const gd = await g.json().catch(() => ({}));
        if (!g.ok) return json({ error: gd.message || "Could not load the reservation location." }, g.status);
        const cur = gd.reservationLocation;
        if (!cur || cur.revision == null) return json({ error: "Could not read the reservation location." }, 500);
        const bs = cur.configuration?.onlineReservations?.businessSchedule || {};
        const cutoff = Date.now() - 2 * 86400000;
        const keep = (bs.specialHourPeriod || []).filter((p: any) => {
          const c = String(p.comment || "");
          if (p.endDate && !isNaN(Date.parse(p.endDate)) && Date.parse(p.endDate) < cutoff) return false; // expired
          if (replacePrefix && c.startsWith(replacePrefix)) return false; // being replaced
          if (c === comment) return false; // exact re-block of the same window
          return true;
        });
        keep.push({ startDate: start, endDate: end, isClosed: true, comment });
        const body = { reservationLocation: { revision: cur.revision, configuration: { onlineReservations: { businessSchedule: { periods: bs.periods || [], specialHourPeriod: keep } } } } };
        const r = await fetch(`${WIX_LOC_URL}/${encodeURIComponent(locId)}`, {
          method: "PATCH", headers: WIX_HEADERS, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data.message || "Wix could not save the block." }, r.status);
        return json({ ok: true, blocks: keep });
      }

      // unblock-reservations: removes matching blocks.
      // payload: { location_id, comment? (exact match, optionally with start),
      //            comment_prefix? (remove all whose comment starts with this) }
      case "unblock-reservations": {
        if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 400);
        const locId = str(payload.location_id) || WIX_LOCATION_ID;
        const comment = str(payload.comment);
        const prefix = str(payload.comment_prefix);
        const start = str(payload.start);
        if (!comment && !prefix) return json({ error: "comment or comment_prefix required" }, 400);
        const g = await fetch(`${WIX_LOC_URL}/${encodeURIComponent(locId)}`, { headers: WIX_HEADERS });
        const gd = await g.json().catch(() => ({}));
        if (!g.ok) return json({ error: gd.message || "Could not load the reservation location." }, g.status);
        const cur = gd.reservationLocation;
        if (!cur || cur.revision == null) return json({ error: "Could not read the reservation location." }, 500);
        const bs = cur.configuration?.onlineReservations?.businessSchedule || {};
        const all = bs.specialHourPeriod || [];
        const keep = all.filter((p: any) => {
          const c = String(p.comment || "");
          if (prefix && c.startsWith(prefix)) return false;
          if (comment && c === comment && (!start || String(p.startDate || "") === start)) return false;
          return true;
        });
        if (keep.length === all.length) return json({ ok: true, removed: 0 });
        const body = { reservationLocation: { revision: cur.revision, configuration: { onlineReservations: { businessSchedule: { periods: bs.periods || [], specialHourPeriod: keep } } } } };
        const r = await fetch(`${WIX_LOC_URL}/${encodeURIComponent(locId)}`, {
          method: "PATCH", headers: WIX_HEADERS, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: data.message || "Wix could not remove the block." }, r.status);
        return json({ ok: true, removed: all.length - keep.length });
      }

      case "add-item": {
        if (!itemValid(payload)) return json({ error: "Title required (and a date for specials/events)." }, 400);
        // returns the new row id so the console can tag Wix blocks with it
        const { data, error } = await admin.from("portal_items").insert(itemRow(payload)).select("id").single();
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, id: data?.id });
      }
      case "update-item":
        if (!payload.id) return json({ error: "id required" }, 400);
        await admin.from("portal_items").update(itemRow(payload)).eq("id", payload.id);
        return json({ ok: true });
      case "delete-item":
        await admin.from("portal_items").delete().eq("id", payload.id);
        return json({ ok: true });
      case "bulk-add-items": {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const clean = rows.filter(itemValid).map((r: any) => itemRow({ location: loc, ...r }));
        if (!clean.length) return json({ error: "No valid rows (need a title, plus a date for specials/events)." }, 400);
        await admin.from("portal_items").insert(clean);
        return json({ ok: true, inserted: clean.length });
      }

      case "add-schedule":
        if (!payload.name || !payload.date) return json({ error: "name and date required" }, 400);
        await admin.from("portal_schedules").insert(schRow(payload));
        return json({ ok: true });
      case "update-schedule":
        if (!payload.id) return json({ error: "id required" }, 400);
        await admin.from("portal_schedules").update(schRow(payload)).eq("id", payload.id);
        return json({ ok: true });
      case "delete-schedule":
        await admin.from("portal_schedules").delete().eq("id", payload.id);
        return json({ ok: true });
      case "bulk-add-schedules": {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const clean = rows.filter((r: any) => r && r.name && r.date).map((r: any) => schRow({ location: loc, ...r }));
        if (!clean.length) return json({ error: "No valid rows (need name + date)." }, 400);
        await admin.from("portal_schedules").insert(clean);
        return json({ ok: true, inserted: clean.length });
      }

      case "set-timeoff": {
        const { data: reqRow } = await admin.from("portal_time_off").select("*").eq("id", payload.id).maybeSingle();
        await admin.from("portal_time_off").update({ status: payload.status }).eq("id", payload.id);
        // Notify the employee about the decision (matched by name, same as the OFF badges)
        if (reqRow && ["approved", "denied"].includes(String(payload.status))) {
          const group = LOC_GROUPS[reqRow.location] || [reqRow.location];
          const { data: emps } = await admin.from("portal_employees").select("id,name").eq("active", true).in("location", group).ilike("name", likeLit(reqRow.name));
          const emp = (emps || [])[0];
          if (emp) {
            const range = fmtDate(reqRow.start_date) + (reqRow.end_date && reqRow.end_date !== reqRow.start_date ? " – " + fmtDate(reqRow.end_date) : "");
            const verdict = payload.status === "approved" ? "approved" : "denied";
            const phones = await phonesFor([emp.id], "timeoff");
            if (phones[emp.id]) await sendSMS(phones[emp.id], `GREYS: your time-off request for ${range} was ${verdict}${verdict === "approved" ? " ✅" : ""}.`, { employee_id: emp.id, kind: "timeoff", ref: String(payload.id) });
            const emails = await contactsFor([emp.id], "timeoff");
            if (emails[emp.id]) await sendMail(emails[emp.id], `Time off ${verdict}`, `<p>Your time-off request for <strong>${range}</strong> was <strong>${verdict}</strong>.</p>`);
          }
        }
        return json({ ok: true });
      }
      case "delete-timeoff":
        await admin.from("portal_time_off").delete().eq("id", payload.id);
        return json({ ok: true });

      // ---- Scheduling: employees ----
      case "add-employee": {
        const row = empRow(payload);
        if (!row.name) return json({ error: "name required" }, 400);
        const em = str(payload.contact_email).trim().toLowerCase();
        const phRaw = str(payload.contact_phone).trim();
        const ph = phRaw ? e164(phRaw) : "";
        if (phRaw && !ph) return json({ error: "That mobile number doesn't look right — use 10 digits, e.g. 901-555-1234." }, 400);
        const { data, error } = await admin.from("portal_employees").insert(row).select("id").single();
        if (error) return json({ error: error.message }, 500);
        if (data?.id && (em || ph)) await admin.from("portal_employee_contacts").upsert({ employee_id: data.id, email: em, phone: ph });
        return json({ ok: true, id: data?.id });
      }
      case "update-employee": {
        if (!payload.id) return json({ error: "id required" }, 400);
        const row = empRow(payload);
        if (!row.name) return json({ error: "name required" }, 400);
        const phRaw = str(payload.contact_phone).trim();
        const ph = phRaw ? e164(phRaw) : "";
        if (phRaw && !ph) return json({ error: "That mobile number doesn't look right — use 10 digits, e.g. 901-555-1234." }, 400);
        const { error } = await admin.from("portal_employees").update(row).eq("id", payload.id);
        if (error) return json({ error: error.message }, 500);
        const upd: Record<string, any> = {};
        if ("contact_email" in payload) upd.email = str(payload.contact_email).trim().toLowerCase();
        if ("contact_phone" in payload) upd.phone = ph; // cleared field = "" = texts stop
        if (Object.keys(upd).length) {
          const c = await admin.from("portal_employee_contacts").upsert({ employee_id: Number(payload.id), ...upd, updated_at: new Date().toISOString() });
          if (c.error) return json({ error: c.error.message }, 500);
        }
        return json({ ok: true });
      }
      case "delete-employee":
        await admin.from("portal_employees").delete().eq("id", payload.id);
        return json({ ok: true });
      case "bulk-add-employees": {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const clean = rows.filter((r: any) => r && str(r.name).trim()).map((r: any) => empRow({ location: loc, ...r }));
        if (!clean.length) return json({ error: "No valid rows (need a name)." }, 400);
        const { error } = await admin.from("portal_employees").insert(clean);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, inserted: clean.length });
      }

      // ---- Scheduling: shifts ----
      case "add-shift": {
        if (!shiftValid(payload)) return json({ error: "employee_id, date, start_time and end_time (HH:MM) required" }, 400);
        const { error } = await admin.from("portal_shifts").insert(shiftRow(payload));
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      case "update-shift": {
        if (!payload.id) return json({ error: "id required" }, 400);
        if (!shiftValid(payload)) return json({ error: "employee_id, date, start_time and end_time (HH:MM) required" }, 400);
        const { error } = await admin.from("portal_shifts").update(shiftRow(payload)).eq("id", payload.id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      // Drag-and-drop: move a shift to another day / employee, keeping its times
      case "move-shift": {
        const id = Number(payload.id);
        if (!id || !DATE_RE.test(String(payload.date ?? ""))) return json({ error: "id and date (YYYY-MM-DD) required" }, 400);
        const upd: Record<string, any> = { date: payload.date };
        if (Number(payload.employee_id) > 0) upd.employee_id = Number(payload.employee_id);
        const { error } = await admin.from("portal_shifts").update(upd).eq("id", id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      case "delete-shift":
        await admin.from("portal_shifts").delete().eq("id", payload.id);
        return json({ ok: true });
      case "bulk-add-shifts": {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const clean = rows.filter(shiftValid).map((r: any) => shiftRow({ location: loc, ...r }));
        if (!clean.length) return json({ error: "No valid rows (need employee_id, date, start_time, end_time)." }, 400);
        const { error } = await admin.from("portal_shifts").insert(clean);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, inserted: clean.length });
      }
      // Copy every shift of one week (starting `from`, YYYY-MM-DD) into the week starting `to`.
      case "copy-week": {
        const from = String(payload.from || "");
        const to = String(payload.to || "");
        if (!DATE_RE.test(from) || !DATE_RE.test(to)) return json({ error: "from and to week-start dates (YYYY-MM-DD) required" }, 400);
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const offset = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
        if (!offset) return json({ error: "Source and target week are the same." }, 400);
        const { data: src, error } = await admin.from("portal_shifts").select("*")
          .eq("location", loc).gte("date", from).lte("date", addDays(from, 6));
        if (error) return json({ error: error.message }, 500);
        const rows = (src || []).map((s: any) => ({
          employee_id: s.employee_id, date: addDays(s.date, offset),
          start_time: s.start_time, end_time: s.end_time, kind: kindOf(s),
          role: s.role, note: s.note, location: s.location,
        }));
        if (!rows.length) return json({ error: "No shifts found in the source week." }, 400);
        const ins = await admin.from("portal_shifts").insert(rows);
        if (ins.error) return json({ error: ins.error.message }, 500);
        return json({ ok: true, inserted: rows.length });
      }

      // ---- Swaps: manager approval ----
      case "set-swap": {
        const id = Number(payload.id);
        const status = payload.status === "approved" ? "approved" : "denied";
        const { data: swap } = await admin.from("portal_swaps").select("*").eq("id", id).maybeSingle();
        if (!swap) return json({ error: "Swap not found" }, 404);
        if (!["pending_peer", "accepted"].includes(swap.status)) return json({ error: "Already handled." }, 409);
        let shift: any = null;
        {
          const { data } = await admin.from("portal_shifts").select("*").eq("id", swap.shift_id).maybeSingle();
          shift = data;
        }
        if (status === "approved") {
          if (!shift) return json({ error: "The shift no longer exists." }, 404);
          const { error } = await admin.from("portal_shifts").update({ employee_id: swap.to_employee_id }).eq("id", swap.shift_id);
          if (error) return json({ error: error.message }, 500);
        }
        await admin.from("portal_swaps").update({ status, decided_at: new Date().toISOString() }).eq("id", id);
        const emails = await contactsFor([swap.from_employee_id, swap.to_employee_id], "swap");
        const phones = await phonesFor([swap.from_employee_id, swap.to_employee_id], "swap");
        const { data: emps } = await admin.from("portal_employees").select("id,name").in("id", [swap.from_employee_id, swap.to_employee_id]);
        const nameOf = (i: number) => (emps || []).find((e: any) => e.id === i)?.name || "your coworker";
        const when = shift ? `<strong>${fmtDate(shift.date)}</strong>, ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}` : "the requested shift";
        const whenTxt = shift ? `${fmtShortD(shift.date)} ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}` : "the requested shift";
        const subj = status === "approved" ? "Shift swap approved" : "Shift swap denied";
        if (emails[swap.from_employee_id]) {
          await sendMail(emails[swap.from_employee_id], subj, status === "approved"
            ? `<p>Your swap was approved — ${escHtml(nameOf(swap.to_employee_id))} now has your shift on ${when}.</p>`
            : `<p>Your swap request for ${when} was denied. You're still on the schedule for it.</p>`);
        }
        if (emails[swap.to_employee_id]) {
          await sendMail(emails[swap.to_employee_id], subj, status === "approved"
            ? `<p>The swap was approved — you now have ${escHtml(nameOf(swap.from_employee_id))}'s shift on ${when}.</p>`
            : `<p>The swap request from ${escHtml(nameOf(swap.from_employee_id))} for ${when} was denied.</p>`);
        }
        if (phones[swap.from_employee_id]) {
          await sendSMS(phones[swap.from_employee_id], status === "approved"
            ? `GREYS: swap approved — ${nameOf(swap.to_employee_id)} now has your shift ${whenTxt}.`
            : `GREYS: your swap request for ${whenTxt} was denied — you're still on the schedule.`, { employee_id: swap.from_employee_id, kind: "swap", ref: "dec:" + id });
        }
        if (phones[swap.to_employee_id]) {
          await sendSMS(phones[swap.to_employee_id], status === "approved"
            ? `GREYS: swap approved — you now have ${nameOf(swap.from_employee_id)}'s shift ${whenTxt}.`
            : `GREYS: the swap request from ${nameOf(swap.from_employee_id)} for ${whenTxt} was denied.`, { employee_id: swap.to_employee_id, kind: "swap", ref: "dec2:" + id });
        }
        return json({ ok: true });
      }
      case "delete-swap":
        await admin.from("portal_swaps").delete().eq("id", payload.id);
        return json({ ok: true });

      // ---- Publish & notify: email + text everyone whose week changed since last publish ----
      case "publish-week": {
        const loc = norm(payload.location, LOCATIONS, "memphis");
        const week = String(payload.week_start || "");
        if (!DATE_RE.test(week)) return json({ error: "week_start (YYYY-MM-DD) required" }, 400);
        const weekEnd = addDays(week, 6);
        const { data: shifts, error } = await admin.from("portal_shifts").select("*")
          .eq("location", loc).gte("date", week).lte("date", weekEnd)
          .order("date").order("start_time");
        if (error) return json({ error: error.message }, 500);
        const cur = (shifts || []).map((s: any) => ({
          employee_id: s.employee_id, date: s.date,
          start_time: String(s.start_time).slice(0, 5), end_time: String(s.end_time).slice(0, 5),
          role: s.role || "", note: s.note || "", kind: kindOf(s),
        }));
        const { data: prevPub } = await admin.from("portal_publishes").select("snapshot")
          .eq("location", loc).eq("week_start", week)
          .order("published_at", { ascending: false }).limit(1);
        const hasPrev = !!(prevPub && prevPub.length);
        const prev: any[] = hasPrev ? (prevPub![0].snapshot || []) : [];
        const key = (rows: any[], id: number) =>
          JSON.stringify(rows.filter((r) => r.employee_id === id).map((r) => [r.date, r.start_time, r.end_time, r.role, r.note, kindOf(r)]));
        const ids = [...new Set([...cur.map((r) => r.employee_id), ...prev.map((r: any) => r.employee_id)])];
        const changed = hasPrev ? ids.filter((id) => key(cur, id) !== key(prev, id)) : ids;
        const offE = new Set<number>(), offS = new Set<number>(); // NOTIFY-PREFS: has the contact but unticked it
        const emails = await contactsFor(changed, "schedule", offE);
        const phones = await phonesFor(changed, "schedule", offS);
        const { data: emps } = await admin.from("portal_employees").select("id,name").in("id", ids.length ? ids : [0]);
        const nameOf = (i: number) => (emps || []).find((e: any) => e.id === i)?.name || "";
        let notified = 0;
        let sms_notified = 0;
        const weekLabel = fmtDate(week) + " – " + fmtDate(weekEnd);
        for (const id of changed) {
          const mine = cur.filter((r) => r.employee_id === id);
          if (emails[id]) {
            const list = mine.length
              ? "<ul>" + mine.map((r) => `<li><strong>${fmtDate(r.date)}</strong>: ${escHtml(shiftLabel(r))}${kindOf(r) !== "off" && r.role ? " · " + escHtml(r.role) : ""}${r.note ? " · " + escHtml(r.note) : ""}</li>`).join("") + "</ul>"
              : "<p>You have no shifts this week.</p>";
            const ok = await sendMail(emails[id],
              `Your ${LOC_NAMES[loc] || loc} schedule — week of ${fmtDate(week)}`,
              `<p>Hi ${escHtml((nameOf(id) || "").split(" ")[0])},</p><p>${hasPrev ? "Your schedule changed for" : "The schedule is out for"} <strong>${weekLabel}</strong> at ${LOC_NAMES[loc] || loc}:</p>${list}<p>Check the schedule page for the latest.</p>`);
            if (ok) notified++;
          }
          if (phones[id]) {
            const lines = mine.length
              ? mine.map((r) => `${fmtShortD(r.date)} ${shiftLabel(r)}${kindOf(r) !== "off" && r.role ? " " + r.role : ""}`).join(", ")
              : "no shifts this week";
            const ok = await sendSMS(phones[id],
              `GREYS ${LOC_NAMES[loc] || loc}: ${hasPrev ? "your schedule changed" : "schedule posted"} for the week of ${fmtShortD(week)} — ${lines}. Details: staff.greyscheese.com/schedule.html`,
              { employee_id: id, kind: "publish", ref: loc + ":" + week });
            if (ok) sms_notified++;
          }
        }
        const no_email = changed.filter((id) => !emails[id] && !offE.has(id)).map((id) => nameOf(id)).filter(Boolean);
        const no_contact = changed.filter((id) => !emails[id] && !phones[id] && !offE.has(id) && !offS.has(id)).map((id) => nameOf(id)).filter(Boolean);
        const opted_out = changed.filter((id) => !emails[id] && !phones[id] && (offE.has(id) || offS.has(id))).map((id) => nameOf(id)).filter(Boolean);
        const ins = await admin.from("portal_publishes").insert({
          location: loc, week_start: week, snapshot: cur, notified, published_by: email,
        });
        if (ins.error) return json({ error: ins.error.message }, 500);
        return json({ ok: true, notified, sms_notified, changed: changed.length, no_email, no_contact, opted_out });
      }

      // ---- Announcements (email + SMS) ----
      case "send-announcement": {
        const title = str(payload.title).trim().slice(0, 200);
        const body = str(payload.body).trim();
        if (!title) return json({ error: "A title is required." }, 400);
        const loc = payload.location === "all" ? "all" : norm(payload.location, LOCATIONS, "memphis");
        const locs = loc === "all" ? LOCATIONS : LOC_GROUPS[loc];
        const { data: emps } = await admin.from("portal_employees").select("id,name").eq("active", true).in("location", locs);
        const ids = (emps || []).map((e: any) => e.id);
        const emails = await contactsFor(ids, "announce");
        const phones = await phonesFor(ids, "announce");
        let sent = 0;
        let sms_sent = 0;
        for (const id of ids) {
          if (emails[id]) {
            const ok = await sendMail(emails[id], `Team announcement: ${title}`,
              `<p><strong>${escHtml(title)}</strong></p><p>${escHtml(body).replace(/\n/g, "<br>")}</p>`);
            if (ok) sent++;
          }
          if (phones[id]) {
            const ok = await sendSMS(phones[id], `GREYS announcement: ${title}${body ? " — " + body.slice(0, 280) : ""}`, { employee_id: id, kind: "announcement" });
            if (ok) sms_sent++;
          }
        }
        const ins = await admin.from("portal_announcements").insert({ title, body, location: loc, sent_count: sent, created_by: email });
        if (ins.error) return json({ error: ins.error.message }, 500);
        return json({ ok: true, sent, sms_sent, total: ids.length });
      }
      case "delete-announcement":
        await admin.from("portal_announcements").delete().eq("id", payload.id);
        return json({ ok: true });

      // ---- Manual SMS blast (manager console) ----
      case "send-sms": {
        if (!smsConfigured()) return json({ error: "Twilio isn't set up yet — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in Supabase Edge Function secrets." }, 400);
        const body = str(payload.body).trim().slice(0, 1400);
        if (!body) return json({ error: "A message is required." }, 400);
        let emps: any[] = [];
        const reqIds: number[] = Array.isArray(payload.employee_ids) ? payload.employee_ids.map(Number).filter((n: number) => n > 0) : [];
        if (reqIds.length) {
          const { data } = await admin.from("portal_employees").select("id,name").in("id", reqIds);
          emps = data || [];
        } else {
          const loc = payload.location === "all" ? "all" : norm(payload.location, LOCATIONS, "memphis");
          const locs = loc === "all" ? LOCATIONS : LOC_GROUPS[loc];
          const { data } = await admin.from("portal_employees").select("id,name").eq("active", true).in("location", locs);
          emps = data || [];
        }
        const ids = emps.map((e: any) => e.id);
        const offS = new Set<number>(); // NOTIFY-PREFS: has a number but unticked "Quick texts"
        const phones = await phonesFor(ids, "quicktext", offS);
        let sms_sent = 0;
        for (const id of ids) {
          if (!phones[id]) continue;
          const ok = await sendSMS(phones[id], body, { employee_id: id, kind: "manual" });
          if (ok) sms_sent++;
        }
        const no_phone = emps.filter((e: any) => !phones[e.id] && !offS.has(e.id)).map((e: any) => e.name);
        const opted_out = emps.filter((e: any) => offS.has(e.id)).map((e: any) => e.name);
        return json({ ok: true, sent: sms_sent, total: ids.length, no_phone, opted_out });
      }

      // ---- Shift reminders (called daily by pg_cron; texts tomorrow's staff) ----
      case "remind-shifts": {
        if (!smsConfigured()) return json({ ok: true, sent: 0, note: "Twilio not configured" });
        // "tomorrow" in restaurant time (Central)
        const nowCT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
        nowCT.setDate(nowCT.getDate() + 1);
        const target = nowCT.getFullYear() + "-" + String(nowCT.getMonth() + 1).padStart(2, "0") + "-" + String(nowCT.getDate()).padStart(2, "0");
        const { data: shifts } = await admin.from("portal_shifts").select("*").eq("date", target).order("start_time");
        const byEmp: Record<number, any[]> = {};
        // scheduled-off entries never trigger a "you work tomorrow" text
        (shifts || []).filter((s: any) => kindOf(s) !== "off").forEach((s: any) => { (byEmp[s.employee_id] = byEmp[s.employee_id] || []).push(s); });
        const ids = Object.keys(byEmp).map(Number);
        if (!ids.length) return json({ ok: true, date: target, sent: 0 });
        const phones = await phonesFor(ids, "reminder");
        // one reminder per employee per day — skip anyone already texted (unique index backs this up)
        const { data: logged } = await admin.from("portal_sms_log").select("ref").eq("kind", "shift-reminder").like("ref", "%:" + target);
        const done = new Set((logged || []).map((r: any) => r.ref));
        let sent = 0;
        for (const id of ids) {
          const ref = id + ":" + target;
          if (!phones[id] || done.has(ref)) continue;
          const lines = byEmp[id].map((s: any) => `${shiftLabel(s)}${s.role ? " (" + s.role + ")" : ""} at ${LOC_NAMES[s.location] || s.location}`).join(", ");
          const ok = await sendSMS(phones[id], `GREYS reminder: you work tomorrow, ${fmtDate(target)}: ${lines}.`, { employee_id: id, kind: "shift-reminder", ref });
          if (ok) sent++;
        }
        return json({ ok: true, date: target, sent });
      }

      // ---- Contacts ----
      case "set-employee-email": {
        const id = Number(payload.employee_id ?? payload.id);
        if (!id) return json({ error: "employee_id required" }, 400);
        const em = str(payload.email).trim().toLowerCase();
        const { error } = await admin.from("portal_employee_contacts").upsert({ employee_id: id, email: em, updated_at: new Date().toISOString() });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      // ---- Onboarding submissions (manager only) ----
      case "list-onboarding": {
        const { data, error } = await admin.from("portal_onboarding").select("*").order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 500);
        const rows = data || [];
        for (const r of rows) {
          if (r.id_path) {
            const s = await admin.storage.from("onboarding-ids").createSignedUrl(r.id_path, 3600);
            (r as any).id_url = s.data?.signedUrl || "";
          }
        }
        return json({ ok: true, rows });
      }
      case "set-onboarding":
        if (!payload.id) return json({ error: "id required" }, 400);
        await admin.from("portal_onboarding").update({ status: payload.status }).eq("id", payload.id);
        return json({ ok: true });
      case "delete-onboarding": {
        if (!payload.id) return json({ error: "id required" }, 400);
        const { data: row } = await admin.from("portal_onboarding").select("id_path").eq("id", payload.id).single();
        if (row?.id_path) await admin.storage.from("onboarding-ids").remove([row.id_path]);
        await admin.from("portal_onboarding").delete().eq("id", payload.id);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
