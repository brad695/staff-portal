// table-holds — holds Wix Table Reservations tables for events and experiences.
//
// A "hold" is a real Wix reservation (status RESERVED) on the tables an event or an
// experience needs, so the Wix widget, Google and phone-ins all see those tables as
// taken while the rest of the room stays bookable. Wix is the source of truth for
// the floor: it rejects a hold that collides with a booking (HTTP 428), and we
// pre-check overlaps ourselves so the manager gets a readable message.
// Every hold we create is recorded in public.table_holds (source + source_id).
//
// Actions (POST ?action=…, JSON body):
//   availability {location, start, end, source?, source_id?}      admin
//   hold   {source, source_id, location, start, end, label, table_ids?[], guests?, check_closed?}  admin | service
//   release {source, source_id}                                     admin | service
//   list   {source, source_ids[]}                                   admin
//   sweep  {}  reconcile: release holds whose event/experience is gone or moved,
//              hold confirmed experiences that have none.          public (idempotent)
//              At-home experiences (rb_experience_types.at_home) happen at the guest's
//              place, so they never hold tables (v7, 2026-10-05).
//   floor  {}  copy each shop's Wix floor into public.wix_floor / wix_floor_bookings (v14)
//                                                                   public (idempotent, ≤ once a minute)
// Experiences at a shop in EXP_BY_TABLE (Nashville) hold picked tables, not a guest count
// (v13, 2026-11-05) — see EXP_BY_TABLE.
//
// v14 (2026-11-08) — Maverick: "reservations are blocked but not experiences, they should follow
// the same table seating as reservations in wix".
//   · floor: the shop's active tables, table combinations, closures (special hours marked closed:
//     holidays, buyouts, class and event blocks) and live bookings for the next FLOOR_DAYS days.
//     rb_get_availability and rb_create_experience_v2 read that copy (rb_wix_closed, rb_wix_fits),
//     so an experience is open only where Wix is open and would seat the party. Cron wix-floor-sync
//     runs it every 2 minutes; every hold made or released here updates wix_floor_bookings at once.
//   · An experience hold is refused when a Wix closure touches it (a reservation made through the
//     API skips Wix's online rules). The sweep's re-hold of a booked experience skips that check.
//   · Nashville (EXP_BY_TABLE) holds the tables Wix itself would seat the party at — one free table
//     that takes the party, else the tightest free table combination (wixSeat) — not any free tables.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const WIX_API_KEY = Deno.env.get("WIX_API_KEY") ?? "";
const WIX_SITE_ID = Deno.env.get("WIX_SITE_ID") ?? "";
// Wix's cancel endpoint demands the reservee's phone, so every hold carries one.
const HOUSE_PHONE = Deno.env.get("TABLE_HOLD_PHONE") || "+19015550100";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const WIX_HEADERS = { "Authorization": WIX_API_KEY, "wix-site-id": WIX_SITE_ID, "Content-Type": "application/json" };
const WIX_RES_URL = "https://www.wixapis.com/table-reservations/reservations/v1/reservations";
const WIX_LOC_URL = "https://www.wixapis.com/table-reservations/reservation-locations/v1/reservation-locations";

// Must match WIX_LOCS in manager.html / LOCATIONS in index.html
const WIX_LOCS: Record<string, string> = {
  memphis: "908a32b3-cd51-490f-b1cb-635321094200",
  nashville: "825c5be0-25d3-4d7e-9418-b062b387f448",
  franklin: "10119bc0-206a-415b-8423-660b05f56dec",
};
const SOURCES = ["portal_item", "event", "experience"];
// Shops whose experiences hold tables one by one instead of a guest count (2026-11-05).
// Maverick: Nashville has "seven 2-tops that can all be pushed together, plus two 4-tops". Since v14
// the hold takes the tables Wix itself would seat the party at (wixSeat): its floor has the seven
// 2-tops combining in a row and the two 4-tops on their own.
const EXP_BY_TABLE = new Set(["nashville"]);
// Shops whose Wix floor is copied for the experience functions (v14)
const FLOOR_LOCS = ["memphis", "nashville"];
const FLOOR_DAYS = 75; // experiences book up to 60 days out (rb_settings.horizon_days)
// experience reservations that should hold tables: booked, or held for an inquiry (48 h)
const LIVE_EXP = ["confirmed", "pending"];
const DEAD = ["CANCELED", "CANCELLED", "DECLINED", "NO_SHOW", "FINISHED"];
const str = (v: any) => (v == null ? "" : String(v)).slice(0, 4000);
const locKey = (v: any) => str(v).trim().toLowerCase();

// ── auth ──────────────────────────────────────────────────────────
const MASTER_EMAIL = "bbearo@gmail.com";
function bearer(req: Request) {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}
async function isAdmin(req: Request): Promise<boolean> {
  const token = bearer(req);
  if (!token || token.startsWith("sb_publishable_")) return false;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error) return false;
    const email = (data.user?.email || "").toLowerCase();
    if (!email) return false;
    if (email === MASTER_EMAIL) return true;
    const { data: row } = await admin.from("app_users").select("email").eq("status", "approved").ilike("email", email).maybeSingle();
    return !!row;
  } catch (_) {
    return false;
  }
}
const isService = (req: Request) => !!SB_SERVICE && bearer(req) === SB_SERVICE;

// ── Wix helpers ───────────────────────────────────────────────────
async function wixLocation(locId: string) {
  const r = await fetch(`${WIX_LOC_URL}/${encodeURIComponent(locId)}`, { headers: WIX_HEADERS });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Could not load the Wix reservation location.");
  const cfg = d.reservationLocation?.configuration || {};
  const tm = cfg.tableManagement || {};
  const tables = (tm.tableDefinitions || []).filter((t: any) => t.isActive !== false)
    .map((t: any) => ({ id: t.id, name: t.name, seatsMin: t.seatsMin ?? 1, seatsMax: t.seatsMax ?? 2 }));
  const combos = (tm.tableCombinations || []).filter((c: any) => c && c.isActive !== false)
    .map((c: any) => ({ tableIds: (c.tableIds || []).map(String), seatsMin: c.seatsMin ?? 1, seatsMax: c.seatsMax ?? 0 }))
    .filter((c: any) => c.tableIds.length);
  // special hours marked closed — the Wix dashboard's holidays and "block" periods
  const closed = ((cfg.onlineReservations?.businessSchedule?.specialHourPeriod || []) as any[])
    .filter((p) => p && p.isClosed && Date.parse(p.endDate || "") > Date.parse(p.startDate || ""))
    .map((p) => ({ start: new Date(p.startDate).toISOString(), end: new Date(p.endDate).toISOString(), comment: str(p.comment).slice(0, 200) }));
  return { mode: String(tm.mode || ""), tables, combos, closed };
}
// the closures that touch [s, e)
const closedDuring = (closed: any[], s: number, e: number) =>
  closed.filter((c) => Date.parse(c.start) < e && Date.parse(c.end) > s);

// Where Wix itself would seat `guests` from the free tables: one table that takes the party
// (the smallest), else the tightest free table combination. [] = nowhere. Same rule as the SQL
// rb_wix_fits that rb_get_availability uses — keep the two in step.
function wixSeat(tables: any[], combos: any[], busy: Set<string>, guests: number): string[] {
  const num = (t: any) => parseInt(String(t.name).replace(/\D/g, ""), 10) || 0;
  const free = new Map(tables.filter((t) => !busy.has(t.id)).map((t) => [t.id, t]));
  const one = [...free.values()]
    .filter((t: any) => guests >= (t.seatsMin || 1) && guests <= (t.seatsMax || 2))
    .sort((a: any, b: any) => (a.seatsMax - b.seatsMax) || (num(a) - num(b)))[0];
  if (one) return [one.id];
  const combo = combos
    .filter((c: any) => guests >= (c.seatsMin || 1) && guests <= (c.seatsMax || 0) && c.tableIds.every((id: string) => free.has(id)))
    .sort((a: any, b: any) => (a.seatsMax - b.seatsMax) || (a.tableIds.length - b.tableIds.length))[0];
  return combo ? [...combo.tableIds] : [];
}

// Reservations whose [start,end) overlaps the window. Search only filters on startDate,
// so look back 12 h for long bookings that started earlier, then test the overlap here.
async function wixOverlapping(locId: string, start: string, end: string) {
  const from = new Date(Date.parse(start) - 12 * 3600000).toISOString();
  const filter = { "$and": [
    { "details.reservationLocationId": { "$eq": locId } },
    { "details.startDate": { "$gte": from } },
    { "details.startDate": { "$lt": end } },
  ] };
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const body = cursor
      ? { search: { cursorPaging: { limit: 100, cursor } } }
      : { search: { filter, sort: [{ fieldName: "details.startDate", order: "ASC" }], cursorPaging: { limit: 100 } } };
    const r = await fetch(WIX_RES_URL + "/search", { method: "POST", headers: WIX_HEADERS, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || "Could not read Wix reservations.");
    out.push(...(d.reservations || []));
    cursor = d.pagingMetadata?.cursors?.next || null;
    if (!d.pagingMetadata?.hasNext || !cursor) break;
  }
  const s = Date.parse(start), e = Date.parse(end);
  return out.filter((x: any) => {
    if (DEAD.includes(String(x.status || ""))) return false;
    const xs = Date.parse(x.details?.startDate || ""), xe = Date.parse(x.details?.endDate || "") || xs + 90 * 60000;
    return xs < e && xe > s;
  });
}
const tableIdsOf = (x: any): string[] => x?.details?.tableIds || x?.details?.tables?.ids || [];
const whoOf = (x: any) => [x?.reservee?.firstName, x?.reservee?.lastName].filter(Boolean).join(" ") || "Guest";

// Every live reservation that starts in [from, to) — the whole list or an error, never part of it.
async function wixBetween(locId: string, from: string, to: string) {
  const filter = { "$and": [
    { "details.reservationLocationId": { "$eq": locId } },
    { "details.startDate": { "$gte": from } },
    { "details.startDate": { "$lt": to } },
  ] };
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("More than 2,000 Wix reservations to copy.");
    const body = cursor
      ? { search: { cursorPaging: { limit: 100, cursor } } }
      : { search: { filter, sort: [{ fieldName: "details.startDate", order: "ASC" }], cursorPaging: { limit: 100 } } };
    const r = await fetch(WIX_RES_URL + "/search", { method: "POST", headers: WIX_HEADERS, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || "Could not read Wix reservations.");
    out.push(...(d.reservations || []));
    cursor = d.pagingMetadata?.cursors?.next || null;
    if (!d.pagingMetadata?.hasNext || !cursor) break;
  }
  return out.filter((x: any) => !DEAD.includes(String(x.status || "")));
}

async function wixCreate(locId: string, start: string, end: string, party: number, label: string, tableIds?: string[]) {
  const details: Record<string, any> = { reservationLocationId: locId, startDate: start, endDate: end, partySize: party };
  if (tableIds && tableIds.length) details.tableIds = tableIds;
  const reservee: Record<string, any> = { firstName: label.slice(0, 60) || "Event", lastName: "(table hold)" };
  const attempt = async (phone?: string) => {
    const rv = phone ? { ...reservee, phone } : reservee;
    const r = await fetch(WIX_RES_URL, { method: "POST", headers: WIX_HEADERS, body: JSON.stringify({ reservation: { status: "RESERVED", details, reservee: rv } }) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d };
  };
  const res = await attempt(HOUSE_PHONE);
  if (!res.ok) {
    const code = res.d?.details?.applicationError?.code || "";
    const msg = res.status === 428 || /CONFLICT|NOT_AVAILABLE|CAPACITY/i.test(code)
      ? "Wix says those tables aren't free for that time."
      : (res.d?.message || "Wix could not create the hold.");
    throw Object.assign(new Error(msg + (code ? " (" + code + ")" : "")), { status: res.status });
  }
  return res.d.reservation;
}

async function wixCancel(resId: string) {
  const g = await fetch(`${WIX_RES_URL}/${encodeURIComponent(resId)}`, { headers: WIX_HEADERS });
  const gd = await g.json().catch(() => ({}));
  if (g.status === 404) return true;
  if (!g.ok) throw new Error(gd.message || "Could not load the Wix hold.");
  const cur = gd.reservation;
  if (!cur || DEAD.includes(String(cur.status || ""))) return true;
  const stored = String(cur.reservee?.phone || "").trim();
  const digits = stored.replace(/\D/g, "");
  const variants: (string | undefined)[] = [];
  if (stored) variants.push(stored);
  if (digits && digits !== stored) variants.push(digits);
  if (!stored) variants.push(HOUSE_PHONE, HOUSE_PHONE.replace(/\D/g, ""));
  variants.push(undefined);
  let last: any = null;
  for (const v of variants) {
    const b: Record<string, any> = { revision: cur.revision };
    if (v) b.phone = v;
    const r = await fetch(`${WIX_RES_URL}/${encodeURIComponent(resId)}/cancel`, { method: "POST", headers: WIX_HEADERS, body: JSON.stringify(b) });
    last = await r.json().catch(() => ({}));
    if (r.ok) return true;
  }
  // last resort: flip the status directly
  const u = await fetch(`${WIX_RES_URL}/${encodeURIComponent(resId)}`, { method: "PATCH", headers: WIX_HEADERS, body: JSON.stringify({ reservation: { revision: cur.revision, status: "CANCELED" } }) });
  if (u.ok) return true;
  const ud = await u.json().catch(() => ({}));
  throw new Error(last?.message || ud?.message || "Wix could not cancel the hold.");
}

// ── the floor copy (v14) ──────────────────────────────────────────
// Our own holds go into wix_floor_bookings the moment they exist, and out the moment they're gone,
// so the experience functions never wait for the next copy to see them. Best effort: the next
// floor copy puts right anything this misses.
async function floorAdd(rows: any[]) {
  const now = new Date().toISOString();
  const add = rows.filter((h) => h && h.wix_reservation_id && FLOOR_LOCS.includes(h.location)
      && Date.parse(h.ends_at) > Date.parse(h.starts_at))
    .map((h) => ({
      wix_reservation_id: h.wix_reservation_id, location: h.location, starts_at: h.starts_at, ends_at: h.ends_at,
      party: h.guests ?? null, table_ids: h.wix_table_ids || [], status: "RESERVED", synced_at: now,
    }));
  if (!add.length) return;
  try { await admin.from("wix_floor_bookings").upsert(add, { onConflict: "wix_reservation_id" }); } catch (_) { /* next copy */ }
}
async function floorDrop(ids: string[]) {
  const list = ids.filter(Boolean);
  if (!list.length) return;
  try { await admin.from("wix_floor_bookings").delete().in("wix_reservation_id", list); } catch (_) { /* next copy */ }
}

// Copy each shop's Wix floor. Skips when every shop was copied in the last minute, unless forced.
async function floorSync(force: boolean) {
  if (!force) {
    const { data } = await admin.from("wix_floor").select("location, synced_at");
    const fresh = (data || []).filter((r: any) => FLOOR_LOCS.includes(r.location) && Date.now() - Date.parse(r.synced_at) < 60000);
    if (fresh.length >= FLOOR_LOCS.length) return { ok: true, skipped: "copied in the last minute" };
  }
  const fetchedAt = new Date().toISOString();
  const from = new Date(Date.now() - 12 * 3600000).toISOString();
  const to = new Date(Date.now() + FLOOR_DAYS * 86400000).toISOString();
  const report: Record<string, unknown> = {};
  for (const key of FLOOR_LOCS) {
    try {
      const locId = WIX_LOCS[key];
      const loc = await wixLocation(locId);
      const live = await wixBetween(locId, from, to);
      const bookings: any[] = [];
      for (const x of live) {
        const st = Date.parse(x.details?.startDate || "");
        if (!x.id || isNaN(st)) continue;
        const en = Date.parse(x.details?.endDate || "") || st + 90 * 60000;
        if (en <= st) continue;
        bookings.push({
          wix_reservation_id: String(x.id), location: key, starts_at: new Date(st).toISOString(), ends_at: new Date(en).toISOString(),
          party: Number(x.details?.partySize) || null, table_ids: tableIdsOf(x).map(String), status: String(x.status || ""),
          synced_at: new Date().toISOString(),
        });
      }
      const floor = {
        location: key, wix_location_id: locId, mode: loc.mode, synced_at: new Date().toISOString(),
        tables: loc.tables.map((t: any) => ({ id: t.id, name: t.name, seats_min: t.seatsMin, seats_max: t.seatsMax })),
        combos: loc.combos.map((c: any) => ({ table_ids: c.tableIds, seats_min: c.seatsMin, seats_max: c.seatsMax })),
        closed: loc.closed,
      };
      if (bookings.length) {
        const { error } = await admin.from("wix_floor_bookings").upsert(bookings, { onConflict: "wix_reservation_id" });
        if (error) throw new Error(error.message);
      }
      // gone from Wix (cancelled, moved out of the window): drop — but keep anything written since we started reading
      let q = admin.from("wix_floor_bookings").delete({ count: "exact" }).eq("location", key)
        .gte("starts_at", from).lt("starts_at", to).lt("synced_at", fetchedAt);
      if (bookings.length) q = q.not("wix_reservation_id", "in", "(" + bookings.map((b) => b.wix_reservation_id).join(",") + ")");
      const { count: gone, error: delErr } = await q;
      if (delErr) throw new Error(delErr.message);
      const { error: fErr } = await admin.from("wix_floor").upsert(floor, { onConflict: "location" });
      if (fErr) throw new Error(fErr.message);
      report[key] = { ok: true, tables: floor.tables.length, combos: floor.combos.length, closed: floor.closed.length, bookings: bookings.length, gone: gone ?? 0 };
    } catch (e) {
      report[key] = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }
  await admin.from("wix_floor_bookings").delete().lt("ends_at", new Date(Date.now() - 86400000).toISOString());
  return { ok: true, ...report };
}

// ── ledger ────────────────────────────────────────────────────────
async function heldFor(source: string, sourceId: string) {
  const { data } = await admin.from("table_holds").select("*").eq("source", source).eq("source_id", sourceId).eq("status", "held");
  return data || [];
}
async function releaseRows(rows: any[]) {
  const errors: string[] = [];
  const dropped: string[] = [];
  for (const h of rows) {
    try {
      if (h.wix_reservation_id) await wixCancel(h.wix_reservation_id);
      await admin.from("table_holds").update({ status: "released", updated_at: new Date().toISOString() }).eq("id", h.id);
      if (h.wix_reservation_id) dropped.push(h.wix_reservation_id);
    } catch (e) {
      errors.push(String((e as Error).message || e));
    }
  }
  await floorDrop(dropped);
  return errors;
}

type HoldReq = { source: string; source_id: string; location: string; start: string; end: string; label: string; table_ids?: string[]; guests?: number; persist?: boolean; check_closed?: boolean };

// persist:true (from the console editors) records the table choice on the event row.
// portal-api's itemRow only knows none/window/day, so for staff events this is the
// write that makes block_scope = 'tables' stick.
async function persistChoice(p: HoldReq, source: string, sourceId: string, want: string[], guests: number) {
  if (!p.persist) return;
  const patch = { block_scope: "tables", block_tables: want, block_guests: want.length ? null : (guests || null) };
  if (source === "portal_item") await admin.from("portal_items").update(patch).eq("id", Number(sourceId));
  else if (source === "event") await admin.from("events").update(patch).eq("id", sourceId);
}

async function doHold(p: HoldReq) {
  const source = str(p.source), sourceId = str(p.source_id);
  if (!SOURCES.includes(source) || !sourceId) return { status: 400, body: { error: "source and source_id are required." } };
  const locId = WIX_LOCS[locKey(p.location)];
  if (!locId) return { status: 400, body: { error: "Unknown location." } };
  const start = new Date(str(p.start)), end = new Date(str(p.end));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return { status: 400, body: { error: "A valid start and end are required." } };
  const S = start.toISOString(), E = end.toISOString();
  const want = [...new Set((Array.isArray(p.table_ids) ? p.table_ids : []).map(str).filter(Boolean))];
  const guests = Math.max(0, Math.floor(Number(p.guests) || 0));
  if (!want.length && !guests) return { status: 400, body: { error: "Pick tables or enter a guest count." } };
  const label = str(p.label).trim() || "Event";

  const loc = await wixLocation(locId);
  // An experience never goes where Wix has the shop closed (v14). A reservation made through the
  // API skips Wix's online rules, so this is the check. The sweep's re-hold of a booked one skips it.
  if (source === "experience" && p.check_closed !== false && closedDuring(loc.closed, start.getTime(), end.getTime()).length) {
    return { status: 409, body: { error: "Wix has the shop closed then.", closed: true } };
  }
  const byId: Record<string, any> = Object.fromEntries(loc.tables.map((t: any) => [t.id, t]));
  const unknown = want.filter((id) => !byId[id]);
  if (unknown.length) return { status: 400, body: { error: "Some of those tables no longer exist in Wix — reopen the editor." } };

  const old = await heldFor(source, sourceId);
  const mine = new Set(old.map((h: any) => h.wix_reservation_id).filter(Boolean));
  // An experience at a shop in EXP_BY_TABLE: the free tables Wix itself would seat the party at
  if (source === "experience" && !want.length && guests && EXP_BY_TABLE.has(locKey(p.location))) {
    const busy = new Set((await wixOverlapping(locId, S, E)).filter((x: any) => !mine.has(x.id)).flatMap(tableIdsOf));
    const seat = wixSeat(loc.tables, loc.combos, busy, guests);
    if (!seat.length) return { status: 409, body: { error: "Wix says those tables aren't free for that time." } };
    want.push(...seat);
  }
  // Same window, same ask, same label → nothing to do. Picked-table holds store guests=null.
  if (old.length && old.every((h: any) => Date.parse(h.starts_at) === start.getTime() && Date.parse(h.ends_at) === end.getTime()
      && h.wix_location_id === locId && h.label === label)) {
    const same = want.length
      ? old.every((h: any) => h.guests == null) && old.flatMap((h: any) => h.wix_table_ids || []).sort().join(",") === [...want].sort().join(",")
      : old.length === 1 && old[0].guests === guests;
    if (same) {
      await persistChoice(p, source, sourceId, want, guests);
      return { status: 200, body: { ok: true, unchanged: true, holds: old, mode: loc.mode } };
    }
  }

  // Pre-check specific tables against everything on the Wix floor except our own old holds
  if (want.length) {
    const over = (await wixOverlapping(locId, S, E)).filter((x: any) => !mine.has(x.id));
    const conflicts: any[] = [];
    for (const x of over) for (const tid of tableIdsOf(x)) if (want.includes(tid)) {
      conflicts.push({ table: byId[tid]?.name || tid, who: whoOf(x), start: x.details?.startDate, end: x.details?.endDate });
    }
    if (conflicts.length) {
      return { status: 409, body: { error: "Already booked: " + conflicts.map((c) => c.table + " (" + c.who + ")").join(", "), conflicts } };
    }
  }

  // Swap: release the old holds, then create the new ones (all-or-nothing)
  const relErr = await releaseRows(old);
  if (relErr.length) return { status: 502, body: { error: "Could not release the previous hold: " + relErr[0] } };
  const created: any[] = [];
  try {
    if (want.length) {
      for (const tid of want) {
        const t = byId[tid];
        const res = await wixCreate(locId, S, E, Math.max(t.seatsMin || 1, t.seatsMax || 2), label, [tid]);
        created.push({ res, tables: tableIdsOf(res).length ? tableIdsOf(res) : [tid], guests: null });
      }
    } else {
      const res = await wixCreate(locId, S, E, guests, label);
      created.push({ res, tables: tableIdsOf(res), guests });
    }
  } catch (e) {
    for (const c of created) { try { await wixCancel(c.res.id); } catch (_) { /* best effort */ } }
    // put the old tables back if we can, so a failed edit doesn't silently unblock the room
    for (const h of old) {
      try {
        const ids = h.wix_table_ids || [];
        const t0 = byId[ids[0]];
        const party = h.guests || (t0 ? t0.seatsMax : 2);
        const res = await wixCreate(h.wix_location_id, h.starts_at, h.ends_at, party, h.label, h.guests ? undefined : ids);
        const back = { ...stripRow(h), wix_reservation_id: res.id, wix_table_ids: tableIdsOf(res) };
        await admin.from("table_holds").insert(back);
        await floorAdd([back]);
      } catch (_) { /* reported below */ }
    }
    await admin.from("table_holds").insert({
      source, source_id: sourceId, location: locKey(p.location), wix_location_id: locId, label, guests: guests || null,
      starts_at: S, ends_at: E, status: "failed", error: String((e as Error).message || e), wix_table_ids: want,
      table_names: want.map((id) => byId[id]?.name || id),
    });
    return { status: (e as any).status === 428 ? 409 : 502, body: { error: String((e as Error).message || e) } };
  }
  const rows = created.map((c) => ({
    source, source_id: sourceId, location: locKey(p.location), wix_location_id: locId, label,
    guests: c.guests ?? null, starts_at: S, ends_at: E, wix_reservation_id: c.res.id, status: "held",
    wix_table_ids: c.tables, table_names: c.tables.map((id: string) => byId[id]?.name || id),
  }));
  const { data, error } = await admin.from("table_holds").insert(rows).select("*");
  await floorAdd(rows);
  if (error) return { status: 500, body: { error: "Held in Wix but could not record it: " + error.message } };
  await persistChoice(p, source, sourceId, want, guests);
  return { status: 200, body: { ok: true, holds: data, mode: loc.mode } };
}
const stripRow = (h: any) => {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = h;
  return { ...rest, status: "held", error: null };
};

// ── sweep ─────────────────────────────────────────────────────────
async function sweep() {
  const report = { released: 0, held: 0, failed: 0, errors: [] as string[] };
  const { data: live } = await admin.from("table_holds").select("*").eq("status", "held").gte("ends_at", new Date().toISOString());
  const rows = live || [];
  const stale: any[] = [];
  const bySrc = (s: string) => rows.filter((h: any) => h.source === s);

  const pi = bySrc("portal_item");
  if (pi.length) {
    const { data } = await admin.from("portal_items").select("id, block_scope, location").in("id", [...new Set(pi.map((h: any) => Number(h.source_id)))]);
    const ok = new Map((data || []).map((r: any) => [String(r.id), r]));
    // portal-api briefly writes block_scope 'none' on every save before table-holds re-stamps
    // 'tables', so 'none' alone is not proof the hold is unwanted (the editor releases explicitly).
    for (const h of pi) { const r: any = ok.get(h.source_id); if (!r || r.block_scope === "window" || r.block_scope === "day" || WIX_LOCS[locKey(r.location)] !== h.wix_location_id) stale.push(h); }
  }
  const ev = bySrc("event");
  if (ev.length) {
    const { data } = await admin.from("events").select("id, block_scope, location, archived").in("id", [...new Set(ev.map((h: any) => h.source_id))]);
    const ok = new Map((data || []).map((r: any) => [String(r.id), r]));
    for (const h of ev) { const r: any = ok.get(h.source_id); if (!r || r.archived || r.block_scope !== "tables" || WIX_LOCS[locKey(r.location)] !== h.wix_location_id) stale.push(h); }
  }
  // Experiences: follow rb_reservations (cancelled / moved → release; confirmed/pending with no hold → hold).
  // At-home experiences never hold tables.
  const { data: exps } = await admin.from("rb_reservations")
    .select("id, status, starts_at, ends_at, party_size, location, guest_name, rb_experience_types(name, at_home)")
    .eq("kind", "experience").gte("ends_at", new Date().toISOString());
  const expMap = new Map((exps || []).map((r: any) => [String(r.id), r]));
  for (const h of bySrc("experience")) {
    const r: any = expMap.get(h.source_id);
    if (!r || r.rb_experience_types?.at_home || !LIVE_EXP.includes(r.status) || Date.parse(r.starts_at) !== Date.parse(h.starts_at) || Date.parse(r.ends_at) !== Date.parse(h.ends_at)) stale.push(h);
  }
  const relErrs = await releaseRows(stale);
  report.errors.push(...relErrs);
  report.released = stale.length - relErrs.length;

  const heldIds = new Set(rows.filter((h: any) => h.source === "experience" && !stale.includes(h)).map((h: any) => h.source_id));
  const since = new Date(Date.now() - 30 * 60000).toISOString();
  const { data: recentFail } = await admin.from("table_holds").select("source_id").eq("source", "experience").eq("status", "failed").gte("created_at", since);
  const skip = new Set((recentFail || []).map((r: any) => r.source_id));
  for (const r of (exps || []) as any[]) {
    if (r.rb_experience_types?.at_home) continue; // at the guest's place: no tables to hold
    if (!LIVE_EXP.includes(r.status) || heldIds.has(String(r.id)) || skip.has(String(r.id))) continue;
    if (Date.parse(r.starts_at) < Date.now()) continue;
    const out = await doHold({
      source: "experience", source_id: String(r.id), location: r.location || "memphis",
      start: r.starts_at, end: r.ends_at, guests: r.party_size, check_closed: false, // already booked: hold its tables regardless
      label: ((r.rb_experience_types?.name || "Experience") + " – " + (r.guest_name || "")).trim(),
    }).catch((e) => ({ status: 500, body: { error: String(e) } }));
    if (out.status === 200) report.held++; else { report.failed++; report.errors.push(String((out.body as any).error)); }
  }
  return report;
}

// ── entry ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const action = new URL(req.url).searchParams.get("action") ?? "";
  let p: Record<string, any> = {};
  try { p = await req.json(); } catch (_) { /* empty body */ }
  if (!WIX_API_KEY || !WIX_SITE_ID) return json({ error: "Wix credentials not configured." }, 500);

  try {
    if (action === "sweep") return json({ ok: true, ...(await sweep()) });
    if (action === "floor") return json(await floorSync(isService(req)));

    const service = isService(req);
    const adm = service || (await isAdmin(req));
    if (!adm) return json({ error: "Not authorized" }, 403);

    if (action === "availability") {
      const locId = WIX_LOCS[locKey(p.location)];
      if (!locId) return json({ error: "Unknown location." }, 400);
      const start = new Date(str(p.start)), end = new Date(str(p.end));
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return json({ error: "A valid start and end are required." }, 400);
      const loc = await wixLocation(locId);
      const own = p.source && p.source_id ? await heldFor(str(p.source), str(p.source_id)) : [];
      const mine = new Set(own.map((h: any) => h.wix_reservation_id));
      const over = await wixOverlapping(locId, start.toISOString(), end.toISOString());
      const busy: Record<string, any[]> = {};
      for (const x of over) {
        if (mine.has(x.id)) continue;
        for (const tid of tableIdsOf(x)) (busy[tid] = busy[tid] || []).push({ who: whoOf(x), start: x.details?.startDate, end: x.details?.endDate, party: x.details?.partySize });
      }
      const unassigned = over.filter((x: any) => !mine.has(x.id) && !tableIdsOf(x).length).length;
      return json({
        ok: true, mode: loc.mode,
        tables: loc.tables.map((t: any) => ({ ...t, busy: busy[t.id] || [], mine: own.some((h: any) => (h.wix_table_ids || []).includes(t.id)) })),
        unassigned, held: own,
      });
    }
    if (action === "hold") {
      const out = await doHold(p as HoldReq);
      return json(out.body, out.status);
    }
    if (action === "release") {
      const source = str(p.source), sourceId = str(p.source_id);
      if (!SOURCES.includes(source) || !sourceId) return json({ error: "source and source_id are required." }, 400);
      const rows = await heldFor(source, sourceId);
      const errs = await releaseRows(rows);
      if (errs.length) return json({ error: errs[0], released: rows.length - errs.length }, 502);
      return json({ ok: true, released: rows.length });
    }
    if (action === "list") {
      const ids = (Array.isArray(p.source_ids) ? p.source_ids : []).map(str).filter(Boolean);
      let q = admin.from("table_holds").select("*").eq("source", str(p.source)).in("status", ["held", "failed"]).order("created_at", { ascending: false });
      if (ids.length) q = q.in("source_id", ids);
      const { data, error } = await q.limit(500);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, holds: data });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
