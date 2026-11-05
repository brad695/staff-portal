// square-orders: mirror every future-dated Square order into Supabase and
// serve it to the staff portal calendar.
//
// WHY A MIRROR AND NOT A LIVE QUERY
// Square's SearchOrders cannot filter on pickup_at — only on created_at /
// updated_at / closed_at. So "what is being picked up in November" is not a
// question Square can answer directly; it has to be swept and kept locally.
// A cron sweeps recently-updated orders every 15 minutes, keeps the ones with
// a future fulfillment, and the calendar reads the mirror. That also means the
// calendar still renders when Square is down, and gives the day-of kitchen
// digest something to read.
//
// Actions
//   sync      - sweep Square, upsert the mirror, purge what is past. Called by
//               pg_cron (publishable key) and by hand from the console.
//   feed      - trimmed rows for the calendar: {from, to, loc}. Unions the
//               counter pre-orders in `preorders` and de-dupes them against
//               the Square mirror by square_order_id, because a portal
//               pre-order IS a Square order and would otherwise show twice.
//               Square rows are filtered: catering-category orders any time,
//               everything else only if due at or before 12:00 PM.
//               Also every catering lead with a saved BEO (invoice or not),
//               carrying beo_pdf: a signed link to the beo-pdf function.
//               Also exp_beo: { <experience booking code>: <signed beo-pdf link> }
//               so the calendar's Experience entries open their BEO (2026-11-03).
//               Order-form pre-orders (the portal's Snap Order tile, 2026-11-05) carry
//               channel "Order form · Pickup|Delivery · Square ticket #…" and photo:
//               a 7-day signed link to the photo of the paper form.
//   status    - last run, counts, any error.
//   locations - Square locations and how they map to portal slugs (admin).
//
// Secrets: SQUARE_ACCESS_TOKEN (needs ORDERS_READ), SQUARE_ENV.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const SQUARE_VERSION = "2025-01-23";
const SYNC_ID = "future-orders";

// How far back to look at *updated* orders on a routine run. An order that has
// not been touched in two days has already been mirrored; a backfill passes a
// bigger `days`.
const DEFAULT_LOOKBACK_DAYS = 3;
// Keep a fulfilled/past order on the calendar this long before purging it.
const KEEP_PAST_DAYS = 14;
// Square rejects more than 10 location_ids in one SearchOrders call.
const LOC_CHUNK = 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------- Square plumbing (same shape as square-preorders) ----------
const squareBase = () =>
  (Deno.env.get("SQUARE_ENV") ?? "production") === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

function squareHeaders() {
  const token = Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function squareError(status: number, data: unknown): string {
  const errs = (data as { errors?: { detail?: string; code?: string }[] })?.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e) => e.detail || e.code).filter(Boolean).join("; ");
  }
  return `Square ${status}: ${JSON.stringify(data).slice(0, 400)}`;
}

async function square(path: string, init: RequestInit = {}) {
  const res = await fetch(`${squareBase()}${path}`, { ...init, headers: squareHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(squareError(res.status, data));
  return data;
}

// ---------- auth ----------
// The calendar and the cron both call with the publishable key, which is what
// verify_jwt checks. Admin-only actions get the extra check the money-moving
// functions use.
async function requireAdmin(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return "missing Authorization header";
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return "not signed in";
  const { data: isAdmin, error } = await asUser.rpc("is_app_admin");
  if (error) return `admin check failed: ${error.message}`;
  if (!isAdmin) return "not an admin";
  return null;
}

// ---------- location mapping ----------
// Square location names are the merchant's own labels ("Greys Memphis"), so
// match on the town rather than hard-coding ids that change per account.
const SLUGS = ["memphis", "nashville", "franklin"];

function slugFor(name: string | undefined): string | null {
  const n = String(name ?? "").toLowerCase();
  return SLUGS.find((s) => n.includes(s)) ?? null;
}

async function squareLocations() {
  const data = await square("/v2/locations");
  return ((data?.locations ?? []) as Record<string, any>[])
    .filter((l) => l?.status !== "INACTIVE")
    .map((l) => ({ id: l.id as string, name: l.name as string, slug: slugFor(l.name) }));
}

// ---------- shaping ----------
const cents = (v: unknown) => Math.round(Number(v ?? 0));

// PICKUP carries pickup_at, DELIVERY carries deliver_at. Take the first
// fulfillment that has a time and is not dead.
function pickFulfillment(order: Record<string, any>) {
  const dead = ["CANCELED", "FAILED"];
  for (const f of (order?.fulfillments ?? []) as Record<string, any>[]) {
    const type = String(f?.type ?? "");
    const details = f?.pickup_details ?? f?.delivery_details ?? f?.shipment_details ?? {};
    const at = details?.pickup_at ?? details?.deliver_at ?? details?.expected_shipped_at;
    if (!at) continue;
    if (dead.includes(String(f?.state ?? ""))) continue;
    return {
      type: type || "PICKUP",
      state: String(f?.state ?? ""),
      schedule_type: String(details?.schedule_type ?? (type === "DELIVERY" ? "SCHEDULED" : "")),
      at: String(at),
      recipient: details?.recipient ?? {},
      note: details?.note ?? null,
    };
  }
  return null;
}

function lineItems(order: Record<string, any>) {
  return ((order?.line_items ?? []) as Record<string, any>[]).map((li) => {
    const variation = li?.variation_name && li.variation_name !== "Regular"
      ? ` (${li.variation_name})`
      : "";
    return { name: `${li?.name ?? "Item"}${variation}`, qty: Number(li?.quantity ?? 1) };
  });
}

// Square does not hand back a single "amount paid" field on a search result,
// so add up the tenders. An unpaid pay-at-pickup order has none.
function paidCents(order: Record<string, any>) {
  return ((order?.tenders ?? []) as Record<string, any>[])
    .reduce((n, t) => n + cents(t?.amount_money?.amount), 0);
}

function rowFor(order: Record<string, any>, locs: Record<string, { name: string; slug: string | null }>) {
  const f = pickFulfillment(order);
  if (!f) return null;
  const loc = locs[String(order?.location_id ?? "")] ?? { name: null, slug: null };
  const items = lineItems(order);
  const r = f.recipient ?? {};
  return {
    square_order_id: order.id,
    location_id: order.location_id,
    location_name: loc.name,
    loc_slug: loc.slug,
    order_state: String(order?.state ?? ""),
    fulfillment_type: f.type,
    fulfillment_state: f.state,
    schedule_type: f.schedule_type || null,
    fulfill_at: new Date(f.at).toISOString(),
    customer_name: r?.display_name ?? null,
    customer_phone: r?.phone_number ?? null,
    customer_email: r?.email_address ?? null,
    item_count: items.reduce((n, i) => n + (Number.isFinite(i.qty) ? i.qty : 1), 0),
    items,
    total_cents: cents(order?.total_money?.amount),
    paid_cents: paidCents(order),
    source_name: order?.source?.name ?? null,
    note: typeof f.note === "string" ? f.note.slice(0, 500) : null,
    square_created_at: order?.created_at ?? null,
    square_updated_at: order?.updated_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

// ---------- sync ----------
async function searchOrders(locationIds: string[], startAt: string) {
  const out: Record<string, any>[] = [];
  let cursor: string | undefined;
  do {
    const data: Record<string, any> = await square("/v2/orders/search", {
      method: "POST",
      body: JSON.stringify({
        location_ids: locationIds,
        limit: 500,
        cursor,
        return_entries: false,
        query: {
          filter: {
            // DRAFT orders are half-rung tickets sitting on a register; they
            // are not commitments and must not reach the calendar.
            state_filter: { states: ["OPEN", "COMPLETED"] },
            // The only date field SearchOrders can filter on that is useful
            // here. sort_field below has to match it or Square 400s.
            date_time_filter: { updated_at: { start_at: startAt } },
            fulfillment_filter: {
              fulfillment_types: ["PICKUP", "DELIVERY", "SHIPMENT"],
              fulfillment_states: ["PROPOSED", "RESERVED", "PREPARED", "COMPLETED"],
            },
          },
          sort: { sort_field: "UPDATED_AT", sort_order: "DESC" },
        },
      }),
    });
    out.push(...((data?.orders ?? []) as Record<string, any>[]));
    cursor = data?.cursor || undefined;
  } while (cursor && out.length < 5000);
  return out;
}

async function sync(body: Record<string, unknown>) {
  const days = Math.max(1, Math.min(365, Number(body.days ?? DEFAULT_LOOKBACK_DAYS)));
  const startedAt = new Date();

  // Cheap guard so a page refresh loop or a stuck cron cannot hammer the
  // Square API. `force:true` (the console button) bypasses it.
  if (body.force !== true) {
    const { data: st } = await admin
      .from("square_sync_state").select("last_run_at").eq("id", SYNC_ID).maybeSingle();
    if (st?.last_run_at && Date.now() - Date.parse(st.last_run_at) < 60_000) {
      return { skipped: true, reason: "synced less than a minute ago" };
    }
  }
  await admin.from("square_sync_state")
    .upsert({ id: SYNC_ID, last_run_at: startedAt.toISOString() }, { onConflict: "id" });

  try {
    const locations = await squareLocations();
    if (!locations.length) throw new Error("Square returned no active locations");
    const locMap: Record<string, { name: string; slug: string | null }> = {};
    for (const l of locations) locMap[l.id] = { name: l.name, slug: l.slug };

    const startAt = new Date(Date.now() - days * 86400_000).toISOString();
    const orders: Record<string, any>[] = [];
    for (let i = 0; i < locations.length; i += LOC_CHUNK) {
      const ids = locations.slice(i, i + LOC_CHUNK).map((l) => l.id);
      orders.push(...await searchOrders(ids, startAt));
    }

    // Only orders whose fulfillment has not already come and gone. A same-day
    // ASAP order counts: it belongs on today's row until the day is over.
    const floor = new Date();
    floor.setHours(0, 0, 0, 0);
    const rows = orders
      .map((o) => rowFor(o, locMap))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .filter((r) => Date.parse(r.fulfill_at) >= floor.getTime())
      .filter((r) => r.order_state !== "CANCELED");

    // De-dupe: an order can come back from more than one location chunk.
    const byId: Record<string, typeof rows[number]> = {};
    for (const r of rows) byId[r.square_order_id] = r;
    const unique = Object.values(byId);

    let upserted = 0;
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const { error } = await admin.from("square_future_orders")
        .upsert(chunk, { onConflict: "square_order_id" });
      if (error) throw new Error(error.message);
      upserted += chunk.length;
    }

    // Anything Square now reports as canceled, and anything long past, comes
    // back off the calendar.
    const canceled = orders
      .filter((o) => String(o?.state) === "CANCELED" || !pickFulfillment(o))
      .map((o) => String(o.id));
    if (canceled.length) {
      await admin.from("square_future_orders").delete().in("square_order_id", canceled);
    }
    await admin.from("square_future_orders").delete()
      .lt("fulfill_at", new Date(Date.now() - KEEP_PAST_DAYS * 86400_000).toISOString());

    const stats = {
      locations: locations.length,
      scanned: orders.length,
      upserted,
      removed: canceled.length,
      lookback_days: days,
      ms: Date.now() - startedAt.getTime(),
    };
    await admin.from("square_sync_state").upsert({
      id: SYNC_ID,
      last_run_at: startedAt.toISOString(),
      last_ok_at: new Date().toISOString(),
      last_error: null,
      stats,
    }, { onConflict: "id" });
    return { ok: true, ...stats };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 600);
    await admin.from("square_sync_state").upsert({
      id: SYNC_ID,
      last_run_at: startedAt.toISOString(),
      last_error: msg,
    }, { onConflict: "id" });
    throw new Error(msg);
  }
}

// ---------- which orders belong on the calendar (2026-09-27) ----------
// Maverick: "we only need uber/doordash/online orders showing up if they at
// 12pm or before. anything in the catering/large cheeseboards category gets
// put on." So a Square order is shown when EITHER
//   * any line is in the Square category "Catering & Large Charcuterie Boards"
//     (any time of day), OR
//   * its pickup/delivery time is 12:00 PM or earlier, shop time.
// Portal pre-orders are catering by definition and always show.
const CATERING_CATEGORY_ID = "CZYRPS4GN2NRWS5FPL3K3AJW";
const NOON_MINUTES = 12 * 60;
let _cateringNames: { names: string[]; at: number } | null = null;

// Item names in the catering category, lower-cased. Order lines are stored as
// "<item name> (<variation>)", so a line matches when it starts with one.
async function cateringNames(): Promise<string[] | null> {
  if (_cateringNames && Date.now() - _cateringNames.at < 10 * 60_000) return _cateringNames.names;
  try {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const data: Record<string, any> = await square("/v2/catalog/search-catalog-items", {
        method: "POST",
        body: JSON.stringify({ category_ids: [CATERING_CATEGORY_ID], limit: 100, cursor }),
      });
      for (const it of (data?.items ?? []) as Record<string, any>[]) {
        const n = String(it?.item_data?.name ?? "").trim().toLowerCase();
        if (n) names.push(n);
      }
      cursor = data?.cursor || undefined;
    } while (cursor && names.length < 2000);
    names.sort((a, b) => b.length - a.length);
    _cateringNames = { names, at: Date.now() };
    return names;
  } catch (_e) {
    // Square unreachable: fall back to the last list we had, or none at all.
    return _cateringNames?.names ?? null;
  }
}

function isCateringOrder(items: { name?: string }[] | null | undefined, names: string[]) {
  return (items ?? []).some((i) => {
    const n = String(i?.name ?? "").trim().toLowerCase();
    return names.some((c) => n.startsWith(c));
  });
}

function shopMinutes(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// ---------- feed (what the calendar reads) ----------
// Deliberately trimmed: the portal calendar is behind the staff URL, not a
// login, so phone numbers and email addresses do not leave the server.
function feedRow(r: Record<string, any>, source: string) {
  return {
    source,
    at: r.at,
    kind: r.kind,
    name: r.name || "Guest",
    loc: r.loc ?? null,
    item_count: r.item_count ?? 0,
    items: (r.items ?? []).slice(0, 6).map((i: Record<string, any>) => ({
      name: i.name,
      qty: i.qty,
    })),
    total_cents: r.total_cents ?? 0,
    paid: !!r.paid,
    note: r.note ?? null,
    channel: r.channel ?? null,
    // BEO tiles only: beo_pdf opens the BEO as a PDF (beo-pdf function, signed link)
    ...(r.beo_code ? { beo_code: r.beo_code, beo_pdf: r.beo_pdf ?? null, guests: r.guests ?? null, time_tbd: !!r.time_tbd } : {}),
    // Order-form pre-orders only: a signed link to the photo of the paper form (2026-11-05)
    ...(r.photo ? { photo: r.photo } : {}),
  };
}

// ---------- order-form photos (2026-11-05) ----------
// Pre-orders filed from the portal's Snap Order tile (order-photo function) keep the photo of the
// paper form in the private bucket order-forms. The calendar gets a 7-day signed link to it; the
// link is minted fresh on every feed call. A storage hiccup only costs the link, never the row.
const FORM_BUCKET = "order-forms";
async function formPhotoLinks(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;
  try {
    const { data } = await admin.storage.from(FORM_BUCKET).createSignedUrls(paths, 7 * 86400);
    for (const d of (data ?? []) as { path?: string | null; signedUrl?: string }[]) {
      if (d?.path && d.signedUrl) out[d.path] = d.signedUrl;
    }
  } catch (_e) { /* no links this time */ }
  return out;
}
function formChannel(p: Record<string, any>) {
  return ["Order form", p.fulfillment === "delivery" ? "Delivery" : "Pickup",
    p.square_ticket_no ? "Square ticket #" + p.square_ticket_no : "", p.taken_by ? "taken by " + p.taken_by : ""]
    .filter(Boolean).join(" · ");
}

// ---------- catering leads with a BEO (2026-11-03) ----------
// Maverick: "If a BEO is created without an invoice for some reason it still
// needs to be shown on the calendar. Give it a tile as normal but have a link
// to the BEO in it." A catering invoice's Square order has no pickup/delivery
// fulfillment, so it never reaches the mirror — the lead itself is the source.
// Every lead with a saved BEO shows at its event date/time, invoice or not;
// lost leads and hide_on_calendar leads don't.

// Wall-clock date + "HH:MM" in shop time -> UTC ISO, right on both sides of DST.
function chicagoISO(date: string, hhmm: string | null): string {
  const [h, m] = hhmm ? hhmm.split(":").map(Number) : [12, 0];
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const behind = (ms: number) => {   // minutes Chicago is behind UTC at that instant
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    return (ms - Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"))) / 60000;
  };
  let t = guess + behind(guess) * 60000;
  const again = behind(t);
  if (guess + again * 60000 !== t) t = guess + again * 60000;
  return new Date(t).toISOString();
}

// Signed link to the BEO PDF (2026-11-03, "beo needs to open as a pdf, not taken to the
// site"). The calendar POSTs it to beo-pdf with the publishable key; the publishable key is
// public, so the link also carries HMAC-SHA256(service-role key, "beo-pdf|<code>|<expiry
// day>") and expires 30 days out. beo-pdf checks the same thing, so codes can't be guessed.
let _beoKey: CryptoKey | null = null;
async function beoPdfLink(code: string) {
  _beoKey ??= await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const e = Math.floor(Date.now() / 86400000) + 30;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", _beoKey, new TextEncoder().encode(`beo-pdf|${code}|${e}`)));
  const s = Array.from(mac.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  return `${SUPABASE_URL}/functions/v1/beo-pdf?c=${encodeURIComponent(code)}&e=${e}&s=${s}`;
}

async function beoLeads(from: string, to: string, loc: string | null) {
  const { data: leads, error } = await admin.from("catering_leads")
    .select("id,code,name,company,location,event_date,event_time,guests,stage,hide_on_calendar,beo")
    .not("beo", "is", null)
    .gte("event_date", from).lte("event_date", to);
  if (error || !leads?.length) return { rows: [] as ReturnType<typeof feedRow>[], orderIds: new Set<string>() };
  const live = leads.filter((l) =>
    String(l.stage ?? "") !== "lost" && !l.hide_on_calendar &&
    // a lead with no shop on it stays visible everywhere, same as the other feeds
    (!loc || !l.location || String(l.location).toLowerCase().includes(loc))
  );
  if (!live.length) return { rows: [] as ReturnType<typeof feedRow>[], orderIds: new Set<string>() };
  const { data: quotes } = await admin.from("catering_quotes")
    .select("lead_id,status,total_cents,amount_paid_cents,square_invoice_id,invoice_number,square_order_id,ticket_order_id,ticket_cancel_order_id,created_at")
    .in("lead_id", live.map((l) => l.id))
    .order("created_at", { ascending: false });
  // Square orders that belong to these jobs (invoice order, kitchen-ticket order)
  // must not show a second time as raw Square rows.
  const orderIds = new Set<string>();
  for (const q of quotes ?? []) {
    for (const id of [q.square_order_id, q.ticket_order_id, q.ticket_cancel_order_id]) if (id) orderIds.add(String(id));
  }
  const rows = await Promise.all(live.map(async (l) => {
    const qs = (quotes ?? []).filter((q) => q.lead_id === l.id && q.status !== "canceled");
    const q = qs.find((x) => x.square_invoice_id) ?? qs[0] ?? null;   // the invoice if there is one, else the newest proposal
    const tm = /^(\d{1,2}):(\d{2})/.exec(String(l.event_time ?? ""));
    const items = (((l.beo as Record<string, any>)?.menu ?? []) as Record<string, any>[])
      .filter((r) => String(r?.item ?? "").trim())
      .map((r) => ({ name: String(r.item).trim(), qty: Number(r.qty) || 1 }));
    const total = Number(q?.total_cents ?? 0), paid = Number(q?.amount_paid_cents ?? 0);
    return feedRow({
      at: chicagoISO(String(l.event_date), tm ? `${tm[1]}:${tm[2]}` : null),
      kind: "catering",
      name: l.company ? `${l.name} (${l.company})` : l.name,
      loc: slugFor(l.location ?? undefined),
      item_count: items.reduce((n, i) => n + i.qty, 0),
      items,
      total_cents: total,
      paid: total > 0 && paid >= total,
      note: null,
      channel: q?.square_invoice_id ? `BEO · invoice${q.invoice_number ? " #" + q.invoice_number : ""}` : "BEO · no invoice yet",
      beo_code: l.code,
      beo_pdf: await beoPdfLink(String(l.code)),
      guests: l.guests ?? null,
      time_tbd: !tm,
    }, "beo");
  }));
  return { rows, orderIds };
}

// ---------- experience bookings' BEOs (2026-11-03) ----------
// Maverick: experiences don't print in the kitchen; a paid booking becomes a catering
// lead with a BEO (trigger rb_experience_lead_sync). That lead is hidden from the
// calendar because the booking already shows there as an Experience, so the calendar
// puts the BEO link on the Experience entry instead:
//   exp_beo = { <booking confirmation code>: <signed beo-pdf link> }
async function experienceBeoLinks(from: string, to: string, loc: string | null) {
  const out: Record<string, string> = {};
  const { data, error } = await admin.from("catering_leads")
    .select("code,location,stage,rb_reservations(code)")
    .not("reservation_id", "is", null).not("beo", "is", null)
    .gte("event_date", from).lte("event_date", to);
  if (error || !data?.length) return out;
  for (const l of data as Record<string, any>[]) {
    if (String(l.stage ?? "") === "lost") continue;
    if (loc && l.location && !String(l.location).toLowerCase().includes(loc)) continue;
    const rc = l.rb_reservations?.code;
    if (rc && l.code) out[String(rc)] = await beoPdfLink(String(l.code));
  }
  return out;
}

async function feed(body: Record<string, unknown>) {
  const from = String(body.from ?? new Date().toISOString().slice(0, 10));
  const to = String(body.to ?? from);
  const loc = body.loc ? String(body.loc).toLowerCase() : null;
  // Dates arrive as plain YYYY-MM-DD in shop time. Central is -05:00 half the
  // year and -06:00 the other half, so take the widest reading of each edge
  // (earliest possible start, latest possible end) rather than guessing which
  // side of a DST change today is on. The client groups by local date anyway,
  // so an extra hour of slack costs nothing and a missing hour loses orders.
  const start = `${from}T00:00:00-05:00`;
  const end = `${to}T23:59:59-06:00`;

  let q = admin.from("square_future_orders").select("*")
    .gte("fulfill_at", start).lte("fulfill_at", end)
    .order("fulfill_at", { ascending: true });
  // Rows Square could not place at a known town stay visible everywhere
  // rather than vanishing off every calendar.
  if (loc) q = q.or(`loc_slug.eq.${loc},loc_slug.is.null`);
  const { data: sq, error } = await q.limit(1000);
  if (error) throw new Error(error.message);

  // Every pre-order in the window, whatever its status AND whatever its shop.
  // The list is used twice, and the two uses want different rows:
  //   * de-dupe  - needs EVERY pre-order, unfiltered. A draft, a canceled one,
  //                or one belonging to the other shop still has a mirrored
  //                Square twin that must be suppressed, or it comes back as a
  //                raw Square row.
  //   * display  - needs only confirmed/awaiting rows for the shop asked for.
  const { data: preAll } = await admin.from("preorders")
    .select("square_order_id,customer_name,pickup_at,items,total_cents,paid_cents,status,payment_status,notes,asap,loc_slug,source,fulfillment,square_ticket_no,taken_by,form_photo_path")
    .gte("pickup_at", start).lte("pickup_at", end)
    .order("pickup_at", { ascending: true });

  // A counter pre-order is also a Square order. Show the portal's own richer
  // row and drop the mirrored twin.
  const preIds = new Set((preAll ?? []).map((p) => p.square_order_id).filter(Boolean));

  // A draft is a basket someone started at the counter and never finished, and
  // a canceled one is gone — neither is a commitment, so neither belongs on the
  // calendar. This mirrors the DRAFT exclusion the Square sweep already applies.
  const SHOW_STATUSES = ["confirmed", "awaiting_payment"];
  const pre = (preAll ?? [])
    .filter((p) => SHOW_STATUSES.includes(String(p.status ?? "")))
    // Store-specific, same rule the Square rows get: a row with no shop on it
    // (only pre-2026-09-14 rows, all backfilled to memphis) stays visible
    // everywhere rather than disappearing off both calendars.
    .filter((p) => !loc || !p.loc_slug || String(p.loc_slug) === loc);
  const photos = await formPhotoLinks(pre.map((p) => p.form_photo_path).filter(Boolean) as string[]);

  const catNames = await cateringNames();
  // A broken lead query must never take the rest of the calendar down with it.
  const beo = await beoLeads(from, to, loc)
    .catch(() => ({ rows: [] as ReturnType<typeof feedRow>[], orderIds: new Set<string>() }));
  const expBeo = await experienceBeoLinks(from, to, loc).catch(() => ({} as Record<string, string>));

  const rows = [
    ...beo.rows,
    ...(pre ?? []).map((p) =>
      feedRow({
        at: p.pickup_at,
        kind: p.asap ? "order" : "catering",
        name: p.customer_name,
        loc: p.loc_slug ?? null,
        item_count: (p.items ?? []).reduce(
          (n: number, i: Record<string, any>) => n + Number(i?.quantity ?? 1),
          0,
        ),
        items: (p.items ?? []).map((i: Record<string, any>) => ({
          name: i?.name ?? "Item",
          qty: Number(i?.quantity ?? 1),
        })),
        total_cents: p.total_cents,
        paid: p.payment_status === "paid",
        note: p.notes,
        channel: p.source === "photo" || p.source === "form" ? formChannel(p) : "Portal pre-order",
        photo: p.form_photo_path ? photos[p.form_photo_path] ?? null : null,
      }, "preorder")
    ),
    ...(sq ?? []).filter((r) => !preIds.has(r.square_order_id) && !beo.orderIds.has(String(r.square_order_id)))
      .map((r) => ({ r, cat: catNames ? isCateringOrder(r.items, catNames) : false }))
      // No category list (Square down, nothing cached): show everything rather
      // than silently dropping catering orders.
      .filter(({ r, cat }) => !catNames || cat || shopMinutes(r.fulfill_at) <= NOON_MINUTES)
      .map(({ r, cat }) =>
      feedRow({
        at: r.fulfill_at,
        kind: cat ? "catering" : r.fulfillment_type === "PICKUP"
          ? (r.schedule_type === "ASAP" ? "order" : "pickup")
          : "delivery",
        name: r.customer_name,
        loc: r.loc_slug ?? null,
        item_count: r.item_count,
        items: r.items,
        total_cents: r.total_cents,
        paid: (r.paid_cents ?? 0) >= (r.total_cents ?? 0) && (r.total_cents ?? 0) > 0,
        note: r.note,
        channel: r.source_name,
      }, "square")
    ),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const { data: st } = await admin
    .from("square_sync_state").select("last_ok_at,last_error").eq("id", SYNC_ID).maybeSingle();

  return { orders: rows, count: rows.length, exp_beo: expBeo, loc, last_sync: st?.last_ok_at ?? null, sync_error: st?.last_error ?? null };
}

async function status() {
  const { data: st } = await admin.from("square_sync_state").select("*").eq("id", SYNC_ID).maybeSingle();
  const { count } = await admin.from("square_future_orders")
    .select("square_order_id", { count: "exact", head: true });
  return { sync: st ?? null, mirrored: count ?? 0 };
}

// ---------- router ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "sync":
        return json(await sync(body));
      case "feed":
        return json(await feed(body));
      case "status":
        return json(await status());
      case "locations": {
        const denied = await requireAdmin(req);
        if (denied) return json({ error: `Forbidden: ${denied}` }, 403);
        return json({ locations: await squareLocations() });
      }
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e).slice(0, 600) }, 400);
  }
});
