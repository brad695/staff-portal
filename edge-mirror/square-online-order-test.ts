// square-online-order — pickup ordering for the GREYS order site.
//   live:    https://orderonline.greyscheese.com          (order.html, built by build.js --site orderonline)
//   staging: https://ticket-rennet.onrender.com/order.html
//
// MENU: always the LIVE Square catalog (production), per shop:
//   memphis   → "Memphis Online / Online Menu"      + "Memphis Catering / Catering & Charcuterie Boards"
//   nashville → "Nashville Online / Online Menu"    + "Nashville Catering / Catering & Charcuterie Boards"
//   plus each shop's "Special Offers" categories (seasonal pre-orders) — see PRE-ORDERS below
// Prices (incl. location overrides), photos, sold-out flags, taxes and the online-visible modifier
// lists come straight from Square, so the page changes when the catalog does (cached 60 s).
// Hidden-online modifiers, conversational (POS-only) lists and lists switched off on the item are
// left out.
//
// PRE-ORDERS (v7, 2026-10-29): the items in a shop's "Special Offers" category (Fall Gooeys, 12 Days of
// Cheesemas …) are seasonal pre-orders, each with its own pickup window. They get their own "Special Offers"
// section, first on the page, and carry preorder: true. Special Offers wins over the online / catering menus
// for an item that sits in more than one, and a pre-order is never a catering item. A bag with a pre-order in
// it may hold nothing else, can't be ASAP, and must be scheduled — up to RULES.preorder_max_days ahead (every
// other bag keeps RULES.max_days). Shop hours and quarter-hour slots are checked as usual, and the Square
// fulfillment note starts with "PRE-ORDER".
//   PICKUP WINDOWS (v7) come from custom attribute values on the Square ITEM: preorder_pickup_from and
//   preorder_pickup_to (YYYY-MM-DD shop-local dates, both inclusive) plus the optional preorder_order_by
//   (last local day to order). They go out as item.window { from, to, order_by }; values that aren't plain
//   dates are ignored (no window). An item whose order_by or pickup_to has gone by is left OFF the menu, so
//   it just stops selling. The pickup day has to sit inside EVERY windowed pre-order in the bag (windows that
//   don't overlap → order them separately), order_by is checked again at payment, and a window reaching past
//   RULES.preorder_max_days still works right through its last day.
//
// INVENTORY (v7, 2026-10-29): Square counts stock for some variations (item_variation_data.track_inventory,
// which a location override can switch off). For those the menu reads the IN_STOCK counts for the shop's own
// location (/v2/inventory/counts/batch-retrieve) and carries avail = how many are left; untracked variations
// have avail null. avail <= 0 is sold out, exactly like a location override's sold_out. The menu is cached
// 60 s, so pay() counts everything tracked in the bag again for real and turns down anything that sold out or
// that the bag now wants more of than is left; quote() is happy with the cached numbers.
//
// ORDERS + PAYMENTS go to the Square environment picked PER REQUEST from the page's address (Origin):
//   the live order site (ORDER_LIVE_ORIGINS, default https://orderonline.greyscheese.com) → production
//   anything else (staging, local copies, curl)                                           → sandbox
// Production sells only for the shops in ORDER_LIVE_SHOPS (default memphis + nashville: Memphis since 2026-10-06,
// Nashville since 2026-10-07). Adding or dropping a shop = change it here AND in LIVE_SHOPS in order.html.
// (v3, 2026-10-06. Before v3 one secret, SQUARE_ORDER_ENV, switched everything; it is no longer read.)
//   sandbox    → SQUARE_ORDER_SANDBOX_* if set, else the SQUARE_EXP_SANDBOX_* test app. The sandbox
//                has no copy of the catalog, so lines go in as ad-hoc items carrying the live items'
//                tax rates — totals match what production would charge.
//   production → the live SQUARE_TICKET_* app, charged to the shop's own location. Lines reference
//                catalog ids (kitchen printer / KDS routing) and Square applies the items' taxes.
// Orders are PICKUP fulfillments: ASAP (20 min prep) or scheduled on the quarter hour inside the
// shop's Square business hours. Catering needs 24 hours' notice and prints at payment (no prep
// time); other scheduled orders use a 30-minute prep time. Paid orders land in Square Orders and
// on the kitchen tickets like any other Square order. Every order is logged in public.online_orders.
//
//   ORDER_PAUSED = memphis,nashville | all   → stop taking orders (menu still shows) — the kill switch
//   The everyday on/off switch is in the staff portal + manager console (site_content 'online_ordering') — see refreshSwitch.
//
// CLOSED DATES (v14, 2026-11-07, Maverick: "add a section for us to block future dates, pre-block christmas,
// thanksgiving and new years day"): site_content 'order_closed_dates' = { dates: [{ day: 'YYYY-MM-DD', shop:
// 'all' | 'memphis' | 'nashville', label, by, at }] }, written only by the set_order_closed_date RPC (manager
// console → Online Ordering → Closed Dates) and re-read with the on/off switch (at most every 10 s). The menu
// sends the shop's upcoming ones as closed_dates [{ day, label }] so the page offers no pickup times on them,
// and pay() refuses a pickup on one (ASAP included). Regular weekly closed days are NOT here — they come from
// each shop's business hours in Square.
//   EARLY CLOSE (v15, 2026-11-07, Maverick: "we also need to have times like if we want to close the store at
//   3:00"): an entry may carry close_at 'HH:MM' (shop-local). Then the day stays open but ends early: the last
//   pickup is close_at minus close_buffer, ASAP stops asap_minutes before it, and pay() refuses anything later.
//   No close_at = closed all day. The menu passes close_at through ({ day, label, close_at }).
//
// Card or Google Pay: both come from Square's Web Payments SDK as a one-time token and are charged the same
// way (pay → source_id). The page sends wallet: "google_pay" so the receipt line reads "Google Pay · VISA ····1234".
//
// UNPAID ORDERS (v4, 2026-10-07): the Square order is created before the card is charged, so a declined or
// abandoned checkout leaves an OPEN, unpaid order. Square's Order Manager hides those, but the staff calendar
// mirror (square-orders) does not. Every order is logged in online_orders BEFORE any check that can stop pay(),
// and the `sweep` action (pg_cron, every 10 min, cron secret) cancels the ones still unpaid after 30 minutes.
// A customer who comes back to a swept checkout gets a fresh order automatically.
//
// SHIPPING (v16, 2026-11-12, Maverick: ship the 12 Days of Cheesemas boxes for Christmas — ordered on this site, paid
// through Square, delivered Dec 9–12): site_content 'order_shipping' (read with the on/off switch, at most every 10 s)
// says what can ship and how:
//   { enabled: true, from: 'memphis', items: [<Square item id>, …], order_by: 'YYYY-MM-DD' (last shop-local day to
//     order), ship_on: 'YYYY-MM-DD', arrive_from, arrive_by, first_cents (shipping for the first box), each_cents (each
//     box after it), limit (most boxes to ship, 0 = no limit beyond Square's stock), tax_states: ['TN'] }
//   No row, enabled not true, no items or no ship_on = no shipping (menu.ship is null and pay refuses).
// A ship order holds shippable items only. It is booked at the `from` shop as a Square SHIPMENT fulfillment —
// recipient, street address, expected ship day, gift note — instead of a pickup, so it lands in Square Dashboard →
// Orders → Shipments, where staff buy the labels. One address per order: Square's API takes one fulfillment per
// order. Shipping is a "Shipping" service charge. Tax: only for ship-to states in tax_states (Tennessee), on the
// boxes AND the shipping (TN taxes a seller's delivery charge with the goods); every other state ships untaxed (the
// sale is delivered outside Tennessee). No automatic catalog taxes on a ship order — they're added explicitly.
// Ship-to: the lower 48 + DC, street addresses only (no PO boxes, APO/FPO/DPO). No tip. Paid ship boxes (online_orders,
// fulfillment 'ship', same env) count against `limit`; Square's stock count at the `from` shop applies as usual.
// The menu sends `ship` so the page can offer "Ship it"; quote takes ship.state (tax depends on it); pay takes
// ship.{name, phone, address1, address2, city, state, zip, gift_note}. The pickup path is unchanged.
// TEST COPY: square-online-order-test is staging's copy of this file with TEST_COPY = true — it uses the Square
// SANDBOX for every request, whatever the Origin. Deploy both from this one source.
//
// SHIPPED ORDERS, THE STAFF SIDE (v17, 2026-11-12): Square is the record of a shipped order — the recipient and
// address, the gift note, paid or not, refunds, and the label (carrier, tracking number, shipped_at) once staff buy
// it. shipOrders() reads the from-shop's SHIPMENT orders that came from this site (metadata.fulfillment 'ship') with
// SearchOrders, keeps the paid ones, and caches them 30 s. The order's metadata also carries buyer, buyer_phone and
// gift_note (orders from before v17: parsed from the shipping note).
//   ship_days   public, counts only (no names): [{ date, orders, boxes, shipped }] by ship day — the staff portal
//               calendar shows "Ship day · N boxes" from it.
//   ship_orders staff (a manager's session, is_app_admin): the packing list — every paid ship order in full.
//   ship_mark   staff: tracking for a label bought outside Square (Pirate Ship, UPS.com) or typed in by hand —
//               writes carrier / tracking number / shipped_at onto the Square fulfillment, marks it COMPLETED,
//               flags metadata.tracking_emailed, and emails the buyer the tracking link.
//   ship_email  staff: (re)send the tracking email for an order whose label is already in Square.
//   track       cron (cc_cron_secret) or staff: emails the tracking link for labels bought in Square Dashboard.
//               Square won't update a COMPLETED order, so "already emailed" for those lives in online_orders
//               (tracking_emailed_at) — without those columns track does nothing and says so.
// The ledger: online_orders gets fulfillment / ship_to / gift_note / shipping_cents / ship_on and the tracking
// columns (migration online_orders_shipping). Until they exist a ship order is logged without them, so the sweep,
// the double-click guard and status still work.
//   v17.2 (2026-11-12, go-live): the staff actions pick Square by function, not by the caller's Origin (the staff
//   portal isn't the order site) — square-online-order = production, square-online-order-test = sandbox. See staffEnv.
//
// Actions (POST ?action=…): config · menu · quote · pay · status · sweep · ship_days · ship_orders · ship_mark ·
// ship_email · track                                                            verify_jwt = false
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE);

const SQUARE_VERSION = "2025-01-23";
const TZ = "America/Chicago";
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_ORIGINS = ["https://orderonline.greyscheese.com", "https://tickets.greyscheese.com", "https://ticket-rennet.onrender.com"];

type Shop = "memphis" | "nashville";
type Env = "production" | "sandbox";

const SHOPS: Record<Shop, { label: string; square: string; online: string[]; catering: string[]; special: string[] }> = {
  memphis: { label: "Memphis", square: "LCXWZ0HAQ69RM", online: ["O6H7DIGXCWNN2U2AVEEEZQJF"], catering: ["X6T5X5HWIGZNVWJEOENWLMEY"], special: ["WFQFC7DLTQ7IFQ6ZTEQ5RBLR"] },
  nashville: { label: "Nashville", square: "LJ33VDYHS1JAR", online: ["MGZ4YTQFX7ICWLIUZTF6QR4Z"], catering: ["QK4SNM7LPXKQHVPWSFMAR6CU"], special: ["OYQTZ2FLHBOWIMBREZ64LEGS", "JBB6ORABFB2N7CFENXKABGYZ"] },
};
// Lists a customer must pick from even though Square has no minimum set on them.
const REQUIRED_LISTS = new Set(["O4MHTBBCIKTEK5ZWV53ZDCTR"]); // Box Lunch: salad or cheesecake

const RULES = {
  asap_minutes: 20, // ASAP = ready about 20 minutes after paying
  slot_minutes: 15, // scheduled pickups on the quarter hour
  open_buffer: 15, // first slot 15 min after opening
  close_buffer: 15, // last slot 15 min before closing
  lead_minutes: 30, // a scheduled (non-catering) pickup at least 30 min out
  catering_hours: 24, // catering needs a day's notice
  max_days: 21, // how far ahead anyone can schedule
  preorder_max_days: 60, // Special Offers pre-orders can be scheduled further out
};
const MAX_QTY = 50, MAX_LINES = 40, MAX_TOTAL_CENTS = 500000, MENU_TTL_MS = 60_000;

const SECTIONS = [
  { id: "special", name: "Special Offers", blurb: "Seasonal pre-orders, each with its own pickup window." },
  { id: "sandwiches", name: "Sandwiches", blurb: "Add chips or a Greek side salad to any sandwich." },
  { id: "salads", name: "Salads", blurb: "" },
  { id: "boards", name: "Boards & bites", blurb: "Planches, flights and small plates." },
  { id: "cheese", name: "From the cheese case", blurb: "" },
  { id: "sides", name: "Sweets, sides & drinks", blurb: "" },
  { id: "more", name: "More from the counter", blurb: "" },
  { id: "catering", name: "Catering", blurb: "Boxes, boards and platters for groups. Order at least 24 hours ahead.", catering: true },
];

// ---------- environment ----------
// Browsers always send Origin on these cross-site POSTs. A forged Origin gains nothing: production still
// needs a real card token from Square's production form, and the order is charged at full price.
const LIVE_ORIGINS = ["https://orderonline.greyscheese.com"];
const LIVE_SHOPS: Shop[] = ["memphis", "nashville"];
const listEnv = (name: string, dflt: string[]) => {
  const v = (Deno.env.get(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return v.length ? v : dflt;
};
// true only in square-online-order-test (staging's copy, see TEST COPY at the top): Square SANDBOX, always
const TEST_COPY = true;
const envFor = (req: Request): Env =>
  !TEST_COPY && listEnv("ORDER_LIVE_ORIGINS", LIVE_ORIGINS).includes((req.headers.get("Origin") ?? "").trim().toLowerCase()) ? "production" : "sandbox";
// The staff side (ship list, ship days, tracking) is called from the staff portal and pg_cron, never from the order
// site, so the page's Origin can't pick it: the live function works the live Square orders, the test copy the sandbox's (v17.2).
const staffEnv = (): Env => (TEST_COPY ? "sandbox" : "production");
const liveShop = (shop: Shop) => listEnv("ORDER_LIVE_SHOPS", LIVE_SHOPS).includes(shop);
const credsFor = (e: Env) => e === "production"
  ? { token: Deno.env.get("SQUARE_TICKET_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_ACCESS_TOKEN"), appId: Deno.env.get("SQUARE_TICKET_APP_ID") ?? null, location: null as string | null }
  : {
    token: Deno.env.get("SQUARE_ORDER_SANDBOX_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN"),
    appId: Deno.env.get("SQUARE_ORDER_SANDBOX_APP_ID") ?? Deno.env.get("SQUARE_EXP_SANDBOX_APP_ID") ?? null,
    location: Deno.env.get("SQUARE_ORDER_SANDBOX_LOCATION_ID") ?? Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? null,
  };
const baseFor = (e: Env) => e === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
const scriptFor = (e: Env) => e === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
const pausedList = () => (Deno.env.get("ORDER_PAUSED") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
// ON/OFF SWITCH (v5, 2026-10-10): managers turn a shop's ordering off and on from the staff portal / manager
// console. It is stored in site_content 'online_ordering' = { memphis:{paused}, nashville:{paused} } (written by
// the set_online_ordering RPC) and re-read here at most every 10 seconds. If the read fails the last known
// answer stands (starts as "on"), so a database hiccup never turns ordering off by itself.
let switchOff: Record<string, boolean> = {};
let switchAt = 0;
// CLOSED DATES (v14) ride along with the switch: same read, same 10 s, same "last known answer stands".
type Closed = { day: string; shop: "all" | Shop; label: string | null; close: number | null };
let closedDates: Closed[] = [];
// SHIPPING (v16) rides along too: same read, same 10 s, same "last known answer stands".
type ShipCfg = {
  from: Shop; items: string[]; order_by: string | null; ship_on: string; arrive_from: string | null; arrive_by: string | null;
  first_cents: number; each_cents: number; limit: number; tax_states: string[];
};
let shipCfg: ShipCfg | null = null;
function parseShip(raw: any): ShipCfg | null {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;
  const day = (k: string) => (DATE_ONLY.test(String(raw[k] ?? "")) ? String(raw[k]) : null);
  const items = (Array.isArray(raw.items) ? raw.items : []).map((x: unknown) => String(x ?? "").trim()).filter((x: string) => /^[A-Z0-9]{8,40}$/.test(x));
  const ship_on = day("ship_on");
  if (!items.length || !ship_on) return null;
  const cents = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 50000 ? Number(v) : d);
  const first = cents(raw.first_cents, 0);
  const taxStates = (Array.isArray(raw.tax_states) ? raw.tax_states : ["TN"]).map((s: unknown) => String(s ?? "").toUpperCase()).filter((s: string) => US_STATES[s]);
  return {
    from: raw.from === "nashville" ? "nashville" : "memphis", items, order_by: day("order_by"), ship_on,
    arrive_from: day("arrive_from"), arrive_by: day("arrive_by"), first_cents: first, each_cents: cents(raw.each_cents, first),
    limit: Math.max(0, Math.min(100000, Math.floor(Number(raw.limit) || 0))), tax_states: taxStates,
  };
}
async function refreshSwitch() {
  if (Date.now() - switchAt < 10_000) return;
  try {
    const { data, error } = await admin.from("site_content").select("key, data").in("key", ["online_ordering", "order_closed_dates", "order_shipping"]);
    if (error) throw error;
    const row = (k: string): any => (data ?? []).find((r: any) => r.key === k)?.data ?? {};
    const d: any = row("online_ordering");
    switchOff = { memphis: d?.memphis?.paused === true, nashville: d?.nashville?.paused === true };
    const c: any = row("order_closed_dates");
    closedDates = (Array.isArray(c?.dates) ? c.dates : [])
      .filter((x: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(x?.day ?? "")) && ["all", "memphis", "nashville"].includes(String(x?.shop ?? "all")))
      .map((x: any) => ({
        day: String(x.day), shop: String(x.shop ?? "all") as Closed["shop"], label: x.label ? String(x.label).trim().slice(0, 40) || null : null,
        close: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.close_at ?? "")) ? hm(x.close_at) : null,
      }));
    shipCfg = parseShip(row("order_shipping"));
    switchAt = Date.now();
  } catch (err) { console.error("online_ordering switch read failed", err); }
}
// What the closed dates say about this shop on this shop-local day: closed all day (close null), closing early
// (close = minutes after midnight, the earliest one wins), or nothing (null). A labelled entry names the day.
function closedOn(shop: Shop, day: string): Closed | null {
  const hits = closedDates.filter((c) => c.day === day && (c.shop === "all" || c.shop === shop));
  if (!hits.length) return null;
  const label = hits.find((c) => c.label)?.label ?? null;
  const allDay = hits.some((c) => c.close == null);
  return { day, shop, label, close: allDay ? null : Math.min(...hits.map((c) => c.close as number)) };
}
// this shop's closed / early-close days from today on, one per day, for the page
function closedFor(shop: Shop, tz = TZ) {
  const today = localDate(Date.now(), tz);
  const days = [...new Set(closedDates.filter((c) => c.day >= today && (c.shop === "all" || c.shop === shop)).map((c) => c.day))].sort();
  return days.map((day) => {
    const c = closedOn(shop, day)!;
    return { day, label: c.label, close_at: c.close == null ? null : `${pad2(Math.floor(c.close / 60))}:${pad2(c.close % 60)}` };
  });
}
const clockOf = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60; return `${h % 12 || 12}${m ? ":" + pad2(m) : ""} ${h >= 12 ? "PM" : "AM"}`; };
const closedDayMsg = (c: Closed, when: string) => `We're closed ${when}${c.label ? ` (${c.label})` : ""}. Please pick another day.`;
const earlyMsg = (c: Closed, when: string) =>
  `We close at ${clockOf(c.close as number)} ${when}${c.label ? ` (${c.label})` : ""}. Please pick an earlier time or another day.`;
const paused = (shop: Shop) => { const p = pausedList(); return p.includes("all") || p.includes(shop) || switchOff[shop] === true; };
const PAUSED_MSG = "Online ordering is paused right now. Please call the shop to order.";
const notLiveMsg = (shop: Shop) => `Online ordering for ${SHOPS[shop].label} isn't open on this site yet. Please call the shop to order.`;
// Taking orders? Paused shops never; in production only the live shops.
const accepting = (shop: Shop, e: Env) => !paused(shop) && (e === "sandbox" || liveShop(shop));
const closedMsg = (shop: Shop, e: Env) => paused(shop) ? PAUSED_MSG : accepting(shop, e) ? null : notLiveMsg(shop);

class PublicError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(msg: string, status = 400, extra?: Record<string, unknown>) {
    super(msg);
    this.status = status;
    this.extra = extra;
  }
}
class SquareError extends Error {
  status = 500;
  codes: string[] = [];
}

function corsFor(req: Request) {
  const configured = (Deno.env.get("TICKET_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = configured.length ? configured : DEFAULT_ORIGINS;
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const ours = /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
  if (origin && (allow.includes(origin) || ours)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

async function square(path: string, init: RequestInit, e: Env): Promise<any> {
  const { token } = credsFor(e);
  if (!token) throw new Error(`Square ${e} access token is not set`);
  const res = await fetch(baseFor(e) + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs: any[] = Array.isArray(data?.errors) ? data.errors : [];
    const err = new SquareError(errs.length ? errs.map((x) => x.detail || x.code).join("; ") : `Square error (${res.status})`);
    err.status = res.status;
    err.codes = errs.map((x) => String(x.code || ""));
    throw err;
  }
  return data;
}

// ---------- small helpers ----------
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const tidy = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const money = (c: number) => "$" + (c / 100).toFixed(2);
const shopOf = (v: unknown): Shop => {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "memphis" || s === "nashville") return s;
  throw new PublicError("Pick Memphis or Nashville.");
};
function presentAt(o: any, loc: string) {
  if (!o || o.is_deleted) return false;
  if (o.present_at_all_locations === false) return (o.present_at_location_ids ?? []).includes(loc);
  return !(o.absent_at_location_ids ?? []).includes(loc);
}
const hm = (t: unknown) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function fmtPhone(p: unknown) {
  const d = String(p ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p ?? "") || null;
}
function e164(digits: string) {
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const codeFrom = (hex: string) => "G" + [0, 1, 2, 3, 4].map((i) => ALPHA[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32]).join("");

// ---------- time (the shops keep Central time) ----------
function zparts(ms: number, tz = TZ) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, dow: DOW.indexOf(String(p.weekday).toUpperCase().slice(0, 3)) };
}
const fmtWhen = (ms: number, tz = TZ) =>
  new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (ms: number, tz = TZ) => new Date(ms).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const pad2 = (n: number) => String(n).padStart(2, "0");
// the shop's own calendar day, YYYY-MM-DD — what pre-order windows are written in
const localDate = (ms: number, tz = TZ) => { const p = zparts(ms, tz); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; };
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${Number(iso.slice(8, 10))}`.trim();

type Hours = { d: number; open: number; close: number }[];
function openNow(hours: Hours, now: number, tz = TZ) {
  const p = zparts(now, tz), mins = p.hh * 60 + p.mm;
  return hours.some((h) => h.d === p.dow && mins >= h.open && mins + RULES.asap_minutes <= h.close);
}
function isSlot(hours: Hours, ms: number, tz = TZ) {
  const p = zparts(ms, tz), mins = p.hh * 60 + p.mm;
  if (mins % RULES.slot_minutes !== 0) return false;
  return hours.some((h) => h.d === p.dow && mins >= h.open + RULES.open_buffer && mins <= h.close - RULES.close_buffer);
}

// ---------- menu ----------
type Mod = { id: string; name: string; price: number; on: boolean; ord: number };
type List = { id: string; name: string; single: boolean; min: number; max: number; mods: Mod[] };
type Var = { id: string; name: string; price: number; sold_out: boolean; track: boolean; avail: number | null; img: string | null; ord: number };
type Win = { from: string; to: string; order_by: string | null };
type Tax = { id: string; name: string; pct: string; inclusive: boolean };
type Item = {
  id: string; name: string; full_name: string; desc: string; meta: string[]; min_qty: number; img: string | null;
  catering: boolean; preorder: boolean; window: Win | null; section: string; ord: number; vars: Var[]; lists: List[]; taxes: string[]; sold_out: boolean;
};
type Loc = { key: Shop; label: string; name: string; address: string; city: string; phone: string | null; email: string | null; tz: string; hours: Hours };
type Menu = { at: number; shop: Shop; location: Loc; sections: { id: string; name: string; blurb: string; catering?: boolean; items: string[] }[]; items: Record<string, Item>; taxes: Record<string, Tax> };

const menuCache = new Map<Shop, Menu>();
const menuInflight = new Map<Shop, Promise<Menu>>();

async function loadMenu(shop: Shop): Promise<Menu> {
  const hit = menuCache.get(shop);
  if (hit && Date.now() - hit.at < MENU_TTL_MS) return hit;
  let p = menuInflight.get(shop);
  if (!p) {
    p = buildMenu(shop).then((m) => { menuCache.set(shop, m); return m; }).finally(() => menuInflight.delete(shop));
    menuInflight.set(shop, p);
  }
  try {
    return await p;
  } catch (e) {
    if (hit) return hit; // Square hiccup: keep serving the last good menu
    throw e;
  }
}

async function batchRetrieve(ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 1000) {
    const d = await square("/v2/catalog/batch-retrieve", {
      method: "POST",
      body: JSON.stringify({ object_ids: ids.slice(i, i + 1000), include_related_objects: false }),
    }, "production");
    for (const o of d.objects ?? []) out.set(o.id, o);
  }
  return out;
}
const imgUrl = (rel: Map<string, any>, id?: string) => (id && rel.get(id)?.image_data?.url) || null;

// How many of each tracked variation Square has left at this location. A variation with no count has none.
async function inventoryCounts(ids: string[], loc: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const catalog_object_ids = ids.slice(i, i + 1000);
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const d = await square("/v2/inventory/counts/batch-retrieve", {
        method: "POST",
        body: JSON.stringify({ catalog_object_ids, location_ids: [loc], states: ["IN_STOCK"], ...(cursor ? { cursor } : {}) }),
      }, "production");
      for (const c of d.counts ?? []) {
        if (String(c.state ?? "") !== "IN_STOCK" || String(c.location_id ?? loc) !== loc) continue;
        const n = Math.floor(Number(c.quantity));
        if (c.catalog_object_id && Number.isFinite(n)) out.set(String(c.catalog_object_id), Math.max(0, n));
      }
      cursor = String(d.cursor ?? "");
      if (!cursor) break;
    }
  }
  return out;
}

function displayName(n: string, catering: boolean) {
  let s = n.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s*\([^)]*\b(?:serves?|individual)\b[^)]*\)\s*/gi, " ");
  if (catering) s = s.replace(/^catering\s*[-–—:]\s*/i, "");
  s = s.replace(/\b([A-Z])([A-Z]{2,})\b/g, (w, a, b) => (/^(BBQ|BLT|GF|NYC)$/.test(w) ? w : a + b.toLowerCase()));
  s = s.replace(/\s+-\s+/g, " — ").replace(/\s{2,}/g, " ").trim();
  return s || n;
}
function describe(raw: string) {
  let d = String(raw || "")
    .replace(/\*+/g, "")
    .replace(/THIS ITEM REQUIRES (?:A )?MINIMUM OF 24 HOURS? (?:OF )?ADVANCE NOTICE\.?/gi, "")
    .replace(/Add chips to any sandwich,? or add a Greek side salad\.?/gi, "") // the "Add a side" choices say it
    .replace(/\s+/g, " ").trim();
  const meta: string[] = [];
  let min_qty = 1;
  if (/individual serving/i.test(d)) meta.push("Individual");
  d = d.replace(/^INDIVIDUAL SERVING\b\s*/i, "");
  const serves = d.match(/\bSERVES\s+(\d+(?:\s*[-–]\s*\d+)?)(?:\s+guests)?\b/i);
  if (serves) { meta.push("Serves " + serves[1].replace(/\s*[-–]\s*/, "–")); d = d.replace(serves[0], ""); }
  const pp = d.match(/\[\s*\$\s*([\d.]+)\s*per person\s*\]/i);
  if (pp) { meta.push(`$${pp[1]} per person`); d = d.replace(pp[0], ""); }
  const mo = d.match(/minimum order (?:of )?(\d+)/i);
  if (mo) { min_qty = Math.max(1, Math.min(MAX_QTY, parseInt(mo[1], 10))); meta.push(`Minimum ${min_qty}`); d = d.replace(mo[0], ""); }
  d = d.replace(/\s*--\s*/g, "; ").replace(/\s+-\s+/g, ", ").replace(/^[\s,;:.\-–—]+/, "").replace(/[\s,;\-–—]+$/, "")
    .replace(/\s+([,.;!?])/g, "$1").replace(/([,;]){2,}/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (d && !/[.!?)]$/.test(d)) d += ".";
  if (d) d = d[0].toUpperCase() + d.slice(1);
  return { desc: d, meta, min_qty };
}
// A pre-order's pickup window is written in custom attribute values on the Square item. Square keys that map
// by the attribute's key, sometimes behind the owning application's id, so map key and entry.key both count.
const DATE_ONLY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
function attrValues(o: any): Record<string, string> {
  const src = o?.custom_attribute_values ?? o?.item_data?.custom_attribute_values;
  const out: Record<string, string> = {};
  if (!src || typeof src !== "object") return out;
  for (const [mapKey, v] of Object.entries<any>(src)) {
    const s = String(v?.string_value ?? "").trim();
    if (!s) continue;
    for (const k of [v?.key, mapKey]) {
      const name = String(k ?? "").split(":").pop()!.trim().toLowerCase();
      if (name) out[name] = s;
    }
  }
  return out;
}
function preorderWindow(o: any): Win | null {
  const a = attrValues(o);
  const date = (k: string) => (DATE_ONLY.test(a[k] ?? "") ? a[k] : null);
  const from = date("preorder_pickup_from"), to = date("preorder_pickup_to");
  if (!from || !to || to < from) return null; // nothing usable written down: no window
  return { from, to, order_by: date("preorder_order_by") };
}

function listTitle(name: string, mods: Mod[]) {
  const n = tidy(name);
  if (/customi[sz]e$/i.test(n)) return "Customize";
  if (/^sides?$/i.test(n)) return "Add a side";
  if (/^box lunch/i.test(n)) return "Choose a side";
  if (/^add cheese$/i.test(n) || mods.every((m) => /^add\b/i.test(m.name))) return "Add-ons";
  return n ? n[0].toUpperCase() + n.slice(1) : "Options";
}
function sectionFor(name: string, lists: List[], catNames: string[]) {
  const n = name.toLowerCase();
  if (/salad/.test(n)) return "salads";
  if (lists.some((l) => l.name === "Add a side") || /sandwich|grilled cheese|panini|\bmelt\b|hoagie|\bsub\b|\bclub\b|reuben|\bblt\b|cuban|muffuletta|\bwrap\b/.test(n)) return "sandwiches";
  if (/cheesecake|cookie|brownie|\bcake\b|dessert|\bchips\b|drink|soda|\btea\b|lemonade|water|coffee|juice|\bsweets?\b/.test(n)) return "sides";
  if (/board|planche|flight|burrata|pimento|olive|\bnuts?\b|butter|spread|charcuterie|bread|baguette|crostini|whipped|feta|liptauer|hummus|\bdip\b|\bbites?\b|plate/.test(n)) return "boards";
  if (catNames.some((c) => /cheese/i.test(c))) return "cheese";
  return "more";
}

function buildLists(i: any, rel: Map<string, any>, loc: string): List[] {
  const infos = [...(i.modifier_list_info ?? [])].sort((a: any, b: any) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  const out: List[] = [];
  for (const info of infos) {
    if (info.enabled === false || info.hidden_from_customer === true || info.hidden_from_customer_override === "YES") continue;
    const L = rel.get(info.modifier_list_id);
    const ld = L?.modifier_list_data;
    if (!L || !ld || !presentAt(L, loc)) continue;
    if (ld.is_conversational || info.is_conversational || ld.hidden_from_customer === true) continue; // POS-only
    if (ld.modifier_type && ld.modifier_type !== "LIST") continue;
    const overrides = new Map<string, any>((info.modifier_overrides ?? []).map((o: any) => [o.modifier_id, o]));
    const mods: Mod[] = [];
    for (const m of ld.modifiers ?? []) {
      const md = m.modifier_data ?? {};
      const ov = overrides.get(m.id) ?? {};
      if (!presentAt(m, loc) || md.hidden_online === true || ov.hidden_online_override === "YES") continue;
      const lo = (md.location_overrides ?? []).find((o: any) => o.location_id === loc) ?? {};
      if (lo.sold_out === true) continue;
      const price = Number(lo.price_money?.amount ?? md.price_money?.amount ?? 0) || 0;
      mods.push({ id: m.id, name: cap(tidy(md.name)), price: Math.max(0, price), on: (ov.on_by_default ?? md.on_by_default) === true, ord: Number(md.ordinal ?? 0) });
    }
    if (!mods.length) continue;
    mods.sort((a, b) => a.ord - b.ord);
    const single = String(ld.selection_type ?? "MULTIPLE") === "SINGLE";
    const pick = (a: unknown, b: unknown) => (a != null && Number(a) >= 0 ? Number(a) : b != null && Number(b) >= 0 ? Number(b) : -1);
    let min = pick(info.min_selected_modifiers, ld.min_selected_modifiers);
    let max = pick(info.max_selected_modifiers, ld.max_selected_modifiers);
    if (min < 0) min = 0;
    if (REQUIRED_LISTS.has(L.id)) min = Math.max(min, 1);
    if (max <= 0) max = single ? 1 : mods.length; // Square stores 0/0 for "no limits"
    if (single) max = 1;
    max = Math.min(max, mods.length);
    min = Math.min(min, max);
    out.push({ id: L.id, name: listTitle(ld.name, mods), single, min, max, mods });
  }
  return out;
}

async function buildMenu(shop: Shop): Promise<Menu> {
  const cfg = SHOPS[shop], loc = cfg.square;
  const onlineCats = new Set(cfg.online), cateringCats = new Set(cfg.catering), specialCats = new Set(cfg.special);
  // 1. the items in this shop's online + catering + Special Offers menu categories
  const found = new Map<string, any>();
  const cursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    let d: any;
    try {
      d = await square("/v2/catalog/search-catalog-items", {
        method: "POST",
        body: JSON.stringify({ category_ids: [...cfg.online, ...cfg.catering, ...cfg.special], enabled_location_ids: [loc], limit: 100, ...(cursor ? { cursor } : {}) }),
      }, "production");
    } catch (e) {
      if (page === 0) throw e;
      break;
    }
    const before = found.size;
    for (const it of d.items ?? []) found.set(it.id, it);
    cursor = String(d.cursor ?? "");
    if (!cursor || cursors.has(cursor) || found.size === before) break;
    cursors.add(cursor);
  }
  const raw = [...found.values()].filter((it) => it.item_data && !it.item_data.is_archived && presentAt(it, loc));

  // 2. their modifier lists, photos, taxes and categories, plus the shop's hours
  const ids = new Set<string>();
  for (const it of raw) {
    const i = it.item_data;
    for (const m of i.modifier_list_info ?? []) if (m.enabled !== false && m.modifier_list_id) ids.add(m.modifier_list_id);
    for (const x of i.image_ids ?? []) ids.add(x);
    for (const t of i.tax_ids ?? []) ids.add(t);
    for (const c of i.categories ?? []) if (c?.id) ids.add(c.id);
    for (const v of i.variations ?? []) for (const x of v.item_variation_data?.image_ids ?? []) ids.add(x);
  }
  const [rel, locRes] = await Promise.all([
    ids.size ? batchRetrieve([...ids]) : Promise.resolve(new Map<string, any>()),
    square(`/v2/locations/${loc}`, {}, "production"),
  ]);

  // pre-order windows are kept in the shop's own dates, so its day is worked out before the items
  const tz = String(locRes?.location?.timezone || TZ);
  const today = localDate(Date.now(), tz);
  const taxes: Record<string, Tax> = {};
  const items: Record<string, Item> = {};
  for (const it of raw) {
    const i = it.item_data;
    const vis = String(i.ecom_visibility ?? "VISIBLE").toUpperCase();
    if (vis === "HIDDEN" || vis === "UNAVAILABLE") continue;
    if (["APPOINTMENTS_SERVICE", "GIFT_CARD", "MEMBERSHIP", "EVENT", "DIGITAL", "DONATION"].includes(String(i.product_type ?? ""))) continue;
    const cats: any[] = i.categories ?? [];
    const inSpecial = cats.find((c) => specialCats.has(c.id));
    const inOnline = cats.find((c) => onlineCats.has(c.id));
    const inCatering = cats.find((c) => cateringCats.has(c.id));
    if (!inSpecial && !inOnline && !inCatering) continue;
    const preorder = !!inSpecial; // Special Offers wins: a pre-order is never a catering item
    const catering = !preorder && !inOnline;
    const ord = Number((inSpecial ?? inOnline ?? inCatering)?.ordinal ?? 0);
    // a pre-order whose pickup window — or its last day to order — has gone by simply stops selling
    const win = preorder ? preorderWindow(it) : null;
    if (win && (today > win.to || (win.order_by && today > win.order_by))) continue;

    const vars: Var[] = [];
    for (const v of i.variations ?? []) {
      const vd = v.item_variation_data ?? {};
      if (!presentAt(v, loc) || vd.sellable === false || vd.pricing_type === "VARIABLE_PRICING") continue;
      const lo = (vd.location_overrides ?? []).find((o: any) => o.location_id === loc) ?? {};
      const price = Number(lo.price_money?.amount ?? vd.price_money?.amount);
      if (!Number.isFinite(price) || price < 0) continue;
      const track = vd.track_inventory === true && lo.track_inventory !== false;
      vars.push({ id: v.id, name: tidy(vd.name || "Regular").replace(/\s+-\s+/g, " — "), price, sold_out: lo.sold_out === true, track, avail: null, img: imgUrl(rel, vd.image_ids?.[0]), ord: Number(vd.ordinal ?? 0) });
    }
    if (!vars.length) continue;
    vars.sort((a, b) => a.ord - b.ord);

    const itemTaxes: string[] = [];
    if (i.is_taxable !== false) {
      for (const tid of i.tax_ids ?? []) {
        const t = rel.get(tid);
        const td = t?.tax_data;
        if (!td || !presentAt(t, loc) || td.enabled === false) continue;
        const pct = String(td.percentage ?? "");
        if (!/^\d+(\.\d+)?$/.test(pct)) continue;
        taxes[tid] = { id: tid, name: tidy(td.name || "Tax"), pct, inclusive: td.inclusion_type === "INCLUSIVE" };
        itemTaxes.push(tid);
      }
    }
    const lists = buildLists(i, rel, loc);
    const full = tidy(i.name);
    const { desc, meta, min_qty } = describe(i.description_plaintext ?? i.description ?? "");
    const catNames = cats.map((c) => String(rel.get(c.id)?.category_data?.name ?? ""));
    items[it.id] = {
      id: it.id, name: displayName(full, catering), full_name: full, desc, meta, min_qty,
      img: imgUrl(rel, (i.image_ids ?? [])[0]) ?? vars.find((v) => v.img)?.img ?? null,
      catering, preorder, window: win, section: preorder ? "special" : catering ? "catering" : sectionFor(full, lists, catNames), ord, vars, lists, taxes: itemTaxes,
      sold_out: vars.every((v) => v.sold_out),
    };
  }
  // Square's counts for the tracked variations — nothing left is sold out. A hiccup reading them leaves avail
  // null (pay() counts for real anyway) rather than taking the whole menu down.
  const tracked = [...new Set(Object.values(items).flatMap((it) => it.vars.filter((v) => v.track).map((v) => v.id)))];
  if (tracked.length) {
    try {
      const counts = await inventoryCounts(tracked, loc);
      for (const it of Object.values(items)) {
        for (const v of it.vars) if (v.track) { v.avail = counts.get(v.id) ?? 0; if (v.avail <= 0) v.sold_out = true; }
        it.sold_out = it.vars.every((v) => v.sold_out);
      }
    } catch (err) { console.error("inventory counts", err); }
  }
  const sections = SECTIONS.map((s) => ({
    ...s,
    items: Object.values(items).filter((x) => x.section === s.id).sort((a, b) => a.ord - b.ord || a.name.localeCompare(b.name)).map((x) => x.id),
  })).filter((s) => s.items.length);

  const L = locRes?.location ?? {};
  const a = L.address ?? {};
  const hours: Hours = (L.business_hours?.periods ?? [])
    .map((p: any) => ({ d: DOW.indexOf(String(p.day_of_week)), open: hm(p.start_local_time), close: hm(p.end_local_time) }))
    .filter((h: any) => h.d >= 0 && h.close > h.open)
    .sort((x: any, y: any) => x.d - y.d || x.open - y.open);
  const location: Loc = {
    key: shop, label: cfg.label, name: /greys/i.test(String(L.name ?? "")) ? tidy(L.name) : `Greys ${cfg.label}`,
    address: [a.address_line_1, a.address_line_2].filter(Boolean).join(", "),
    city: `${a.locality ?? ""}, ${a.administrative_district_level_1 ?? ""} ${String(a.postal_code ?? "").slice(0, 5)}`.trim(),
    phone: fmtPhone(L.phone_number), email: L.business_email ?? null, tz, hours,
  };
  return { at: Date.now(), shop, location, sections, items, taxes };
}

function publicMenu(m: Menu, e: Env) {
  const pct = (it: Item) => Math.round(it.taxes.map((t) => m.taxes[t]).filter((t) => t && !t.inclusive).reduce((s, t) => s + Number(t.pct), 0) * 1000) / 1000;
  return {
    shop: m.shop,
    accepting: accepting(m.shop, e),
    paused_message: closedMsg(m.shop, e),
    location: m.location,
    rules: RULES,
    closed_dates: closedFor(m.shop, m.location.tz),
    sections: m.sections.map((s) => ({ id: s.id, name: s.name, blurb: s.blurb, catering: !!s.catering, items: s.items })),
    items: Object.fromEntries(Object.values(m.items).map((it) => [it.id, {
      id: it.id, name: it.name, desc: it.desc, meta: it.meta, min_qty: it.min_qty, img: it.img, catering: it.catering, preorder: it.preorder, window: it.window, sold_out: it.sold_out,
      tax_pct: pct(it),
      vars: it.vars.map((v) => ({ id: v.id, name: v.name, price: v.price, sold_out: v.sold_out, avail: v.avail, img: v.img })),
      lists: it.lists.map((l) => ({ id: l.id, name: l.name, single: l.single, min: l.min, max: l.max, mods: l.mods.map((x) => ({ id: x.id, name: x.name, price: x.price, on: x.on })) })),
    }])),
    updated_at: new Date(m.at).toISOString(),
  };
}

// ---------- pay config ----------
let SANDBOX_LOC: string | null = null;
async function paymentLocation(shop: Shop, e: Env): Promise<string> {
  if (e === "production") return SHOPS[shop].square;
  const explicit = credsFor("sandbox").location;
  if (explicit) return explicit;
  if (SANDBOX_LOC) return SANDBOX_LOC;
  const d = await square("/v2/locations", {}, "sandbox");
  const list = (d?.locations ?? []) as any[];
  const active = list.find((l) => l.status === "ACTIVE") ?? list[0];
  if (!active?.id) throw new Error("The Square sandbox has no location.");
  return (SANDBOX_LOC = String(active.id));
}
async function payConfig(shop: Shop, e: Env) {
  let location_id: string | null = null, reach_error: string | null = null;
  try { location_id = await paymentLocation(shop, e); } catch (err) { reach_error = String((err as Error).message).slice(0, 300); }
  return { env: e, app_id: credsFor(e).appId, location_id, script_src: scriptFor(e), reachable: !!location_id, reach_error };
}

// ---------- cart → priced lines ----------
type Line = { item: Item; v: Var; qty: number; chosen: { list: List; mod: Mod }[]; unit: number; note: string };
function priceLines(m: Menu, raw: unknown): Line[] {
  if (!Array.isArray(raw) || !raw.length) throw new PublicError("Your bag is empty.");
  if (raw.length > MAX_LINES) throw new PublicError("That's a big order — please call the shop and we'll set it up.");
  const lines = raw.map((r: any): Line => {
    const item = m.items[String(r?.item ?? "")];
    if (!item) throw new PublicError("Something in your bag isn't on this menu anymore. Please remove it and try again.", 409);
    const v = item.vars.find((x) => x.id === String(r.var ?? ""));
    if (!v) throw new PublicError(`${item.name}: please choose an option again.`, 409);
    if (v.sold_out) throw new PublicError(`Sorry — ${item.name}${item.vars.length > 1 ? ` (${v.name})` : ""} just sold out. Please remove it and try again.`, 409);
    const qty = Math.floor(Number(r.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) throw new PublicError(`${item.name}: quantity must be between 1 and ${MAX_QTY}.`);
    const ids = Array.isArray(r.mods) ? [...new Set(r.mods.map((x: unknown) => String(x)))] : [];
    const chosen: { list: List; mod: Mod }[] = [];
    for (const id of ids) {
      let hit: { list: List; mod: Mod } | null = null;
      for (const list of item.lists) { const mod = list.mods.find((x) => x.id === id); if (mod) { hit = { list, mod }; break; } }
      if (!hit) throw new PublicError(`${item.name}: one of your choices isn't available anymore. Please add it again.`, 409);
      chosen.push(hit);
    }
    for (const list of item.lists) {
      const n = chosen.filter((c) => c.list.id === list.id).length;
      if (n < list.min) throw new PublicError(`${item.name}: please choose ${list.min === 1 ? "an option" : list.min + " options"} under “${list.name}”.`);
      if (n > list.max) throw new PublicError(`${item.name}: too many choices under “${list.name}”.`);
    }
    chosen.sort((a, b) => item.lists.indexOf(a.list) - item.lists.indexOf(b.list) || a.list.mods.indexOf(a.mod) - b.list.mods.indexOf(b.mod));
    const unit = v.price + chosen.reduce((s, c) => s + c.mod.price, 0);
    return { item, v, qty, chosen, unit, note: clean(r.note, 200) };
  });
  // a pre-order is made for its own pickup window, so it can't ride along with the everyday menu
  const pre = lines.filter((l) => l.item.preorder).length;
  if (pre && pre !== lines.length) {
    throw new PublicError("Special Offers pre-orders are picked up on their own date, so they can't share a bag with the rest of the menu. Please order them separately.");
  }
  const perItem = new Map<string, number>();
  for (const l of lines) perItem.set(l.item.id, (perItem.get(l.item.id) ?? 0) + l.qty);
  for (const [id, n] of perItem) {
    const it = m.items[id];
    if (n < it.min_qty) throw new PublicError(`${it.name}: please order at least ${it.min_qty}.`);
  }
  return lines;
}

// The menu is cached 60 s, so anything Square counts is counted again for real before the card is charged.
async function checkStock(m: Menu, lines: Line[]) {
  const tracked = lines.filter((l) => l.v.track);
  if (!tracked.length) return;
  const ids = [...new Set(tracked.map((l) => l.v.id))];
  const counts = await inventoryCounts(ids, SHOPS[m.shop].square);
  for (const id of ids) {
    const mine = tracked.filter((l) => l.v.id === id);
    const want = mine.reduce((n, l) => n + l.qty, 0), have = counts.get(id) ?? 0;
    const name = mine[0].item.name + (mine[0].item.vars.length > 1 ? ` (${mine[0].v.name})` : "");
    if (have <= 0) throw new PublicError(`Sorry — ${name} just sold out. Please remove it and try again.`, 409);
    if (want > have) throw new PublicError(`Only ${have} left of ${name}. Please lower the quantity and try again.`, 409);
  }
}

// ---------- pickup ----------
type Pickup = { asap: boolean; ms: number };
// The pickup day has to suit every windowed pre-order in the bag, so their windows narrow into one.
function bagWindow(lines: Line[]): Win | null {
  let w: Win | null = null;
  for (const l of lines) {
    const x = l.item.window;
    if (!x) continue;
    if (!w) { w = { ...x }; continue; }
    if (x.from > w.from) w.from = x.from;
    if (x.to < w.to) w.to = x.to;
    if (x.order_by && (!w.order_by || x.order_by < w.order_by)) w.order_by = x.order_by;
  }
  return w;
}
function checkPickup(m: Menu, p: any, lines: Line[]): Pickup {
  const now = Date.now(), tz = m.location.tz;
  const catering = lines.some((l) => l.item.catering);
  const preorder = lines.some((l) => l.item.preorder);
  if (p?.asap === true) {
    if (preorder) throw new PublicError("Pre-orders are picked up later — please pick a pickup day and time inside the item's pickup window.");
    if (catering) throw new PublicError("Catering needs 24 hours' notice — please pick a pickup day and time.");
    const shutToday = closedOn(m.shop, localDate(now, tz));
    if (shutToday && shutToday.close == null) throw new PublicError(closedDayMsg(shutToday, "today"), 409);
    if (shutToday) {
      const p0 = zparts(now, tz);
      if (p0.hh * 60 + p0.mm + RULES.asap_minutes > (shutToday.close as number)) throw new PublicError(earlyMsg(shutToday, "today"), 409);
    }
    if (!openNow(m.location.hours, now, tz)) throw new PublicError("We can't do ASAP right now — please schedule a pickup time.", 409);
    return { asap: true, ms: now + RULES.asap_minutes * 60000 };
  }
  const ms = Date.parse(String(p?.at ?? ""));
  if (!Number.isFinite(ms)) throw new PublicError("Please pick a pickup time.");
  const lead = catering ? RULES.catering_hours * 60 : RULES.lead_minutes;
  if (ms < now + lead * 60000 - 90000) {
    throw new PublicError(catering ? "Catering needs 24 hours' notice. Please pick a later pickup time." : "That pickup time is too soon now. Please pick a later one.", 409);
  }
  const w = preorder ? bagWindow(lines) : null;
  if (w) {
    if (w.to < w.from) {
      throw new PublicError("These pre-orders are picked up in different windows, so they can't share an order. Please order them separately.");
    }
    if (w.order_by && localDate(now, tz) > w.order_by) throw new PublicError(`Pre-ordering closed on ${fmtDay(w.order_by)}. Please take that item out of your bag.`, 409);
    const day = localDate(ms, tz);
    if (day < w.from || day > w.to) throw new PublicError(`That pre-order is picked up ${fmtDay(w.from)} – ${fmtDay(w.to)}. Please pick a pickup day inside the window.`, 409);
  }
  // a day inside the pickup window always counts, even past the usual limit
  const maxDays = preorder ? RULES.preorder_max_days : RULES.max_days;
  if (!w && ms > now + maxDays * 86400000) throw new PublicError(`We take ${preorder ? "pre-orders" : "orders"} up to ${maxDays} days ahead.`);
  const shutDay = closedOn(m.shop, localDate(ms, tz));
  if (shutDay && shutDay.close == null) throw new PublicError(closedDayMsg(shutDay, fmtDay(localDate(ms, tz))), 409);
  if (shutDay) {
    const pz = zparts(ms, tz);
    if (pz.hh * 60 + pz.mm > (shutDay.close as number) - RULES.close_buffer) throw new PublicError(earlyMsg(shutDay, "on " + fmtDay(localDate(ms, tz))), 409);
  }
  if (!isSlot(m.location.hours, ms, tz)) throw new PublicError("We're closed then. Please pick another pickup time.", 409);
  return { asap: false, ms };
}

// ---------- the Square order ----------
type Cust = { first: string; last: string; email: string; phone: string | null };
function buildOrder(e: Env, m: Menu, lines: Line[], pickup: Pickup | null, cust: Cust | null, locationId: string, code: string, note: string) {
  const catering = lines.some((l) => l.item.catering);
  const preorder = lines.some((l) => l.item.preorder);
  const usedTaxes = new Set<string>();
  const line_items = lines.map((l, i) => {
    const li: Record<string, unknown> = { uid: "l" + (i + 1), quantity: String(l.qty) };
    if (e === "production") {
      li.catalog_object_id = l.v.id;
      if (l.chosen.length) li.modifiers = l.chosen.map((c) => ({ catalog_object_id: c.mod.id }));
    } else {
      li.name = l.item.full_name;
      li.variation_name = l.v.name;
      li.base_price_money = { amount: l.v.price, currency: "USD" };
      if (l.chosen.length) li.modifiers = l.chosen.map((c) => ({ name: c.mod.name, base_price_money: { amount: c.mod.price, currency: "USD" } }));
      if (l.item.taxes.length) li.applied_taxes = l.item.taxes.map((t) => { usedTaxes.add(t); return { tax_uid: "t-" + t }; });
    }
    if (l.note) li.note = l.note;
    return li;
  });
  const order: Record<string, unknown> = {
    location_id: locationId,
    source: { name: "Greys online ordering" },
    line_items,
  };
  if (code) {
    order.reference_id = code;
    order.metadata = { web_code: code, shop: m.shop };
  }
  if (e === "production") order.pricing_options = { auto_apply_taxes: true, auto_apply_discounts: false };
  else if (usedTaxes.size) {
    order.taxes = [...usedTaxes].map((t) => ({
      uid: "t-" + t, name: m.taxes[t].name, percentage: m.taxes[t].pct, type: m.taxes[t].inclusive ? "INCLUSIVE" : "ADDITIVE", scope: "LINE_ITEM",
    }));
  }
  if (pickup && cust) {
    const recipient: Record<string, string> = { display_name: `${cust.first} ${cust.last}`.trim().slice(0, 255), email_address: cust.email };
    if (cust.phone) recipient.phone_number = cust.phone;
    const when = pickup.asap ? "ASAP" : fmtWhen(pickup.ms, m.location.tz);
    const details: Record<string, unknown> = {
      recipient,
      schedule_type: pickup.asap ? "ASAP" : "SCHEDULED",
      note: [preorder ? "PRE-ORDER" : catering ? "CATERING" : "", `Online ${code}`, when, note].filter(Boolean).join(" · ").slice(0, 500),
    };
    if (pickup.asap) details.prep_time_duration = `PT${RULES.asap_minutes}M`;
    else {
      details.pickup_at = new Date(pickup.ms).toISOString();
      if (!catering) details.prep_time_duration = "PT30M"; // catering prints at payment
    }
    order.fulfillments = [{ type: "PICKUP", state: "PROPOSED", pickup_details: details }];
    order.ticket_name = `${cust.first} ${cust.last.slice(0, 1)}`.trim().slice(0, 30);
  }
  return order;
}
function totalsOf(o: any) {
  const total = Number(o?.total_money?.amount ?? 0), tax = Number(o?.total_tax_money?.amount ?? 0);
  const disc = Number(o?.total_discount_money?.amount ?? 0), svc = Number(o?.total_service_charge_money?.amount ?? 0);
  return { subtotal_cents: total - tax - svc + disc, tax_cents: tax, discount_cents: disc, total_cents: total };
}
const lineSummary = (lines: Line[]) => lines.map((l) => ({
  item_id: l.item.id, var_id: l.v.id, name: l.item.name, option: l.item.vars.length > 1 || l.v.name !== "Regular" ? l.v.name : "",
  qty: l.qty, unit_cents: l.unit, mods: l.chosen.map((c) => c.mod.name), note: l.note || undefined,
}));

// ---------- shipping (SHIPPING at the top) ----------
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const NO_SHIP = new Set(["AK", "HI"]); // cheese travels cold: the lower 48 + DC only
const PO_BOX = /\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b|\b(?:apo|fpo|dpo)\b/i;
type ShipTo = { name: string; phone: string | null; address1: string; address2: string; city: string; state: string; zip: string; gift_note: string };
const shipFee = (c: ShipCfg, boxes: number) => (boxes > 0 ? c.first_cents + (boxes - 1) * c.each_cents : 0);
// a shop-local wall-clock time as a real instant (the shops keep Central time; December is CST)
function zonedMs(y: number, mo: number, d: number, hh: number, mm: number, tz = TZ) {
  const off = (ms: number) => { const p = zparts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(ms / 60000) * 60000; };
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  return guess - off(guess - off(guess));
}
const dayAt = (iso: string, hh: number, tz = TZ) => zonedMs(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10), hh, 0, tz);
const fmtLongDay = (iso: string) => new Date(dayAt(iso, 12)).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
function arriveText(c: ShipCfg) {
  const a = c.arrive_from, b = c.arrive_by;
  if (a && b && a !== b) return `arrives ${fmtDay(a)}–${a.slice(5, 7) === b.slice(5, 7) ? Number(b.slice(8, 10)) : fmtDay(b)}`;
  const one = b || a;
  return one ? `arrives by ${fmtLongDay(one)}` : "";
}
const shipText = (c: ShipCfg) => [`Ships ${fmtLongDay(c.ship_on)}`, arriveText(c)].filter(Boolean).join(" · ");
// boxes already paid for shipping (this env) — what `limit` counts against. From Square (v17): every line of a ship
// order is a box that ships; refunded orders don't count.
async function shippedBoxes(e: Env, _c: ShipCfg, fresh = false): Promise<number> {
  return (await shipOrders(e, fresh)).filter((o) => !o.refunded).reduce((n, o) => n + o.boxes, 0);
}
// why shipping can't take an order right now (null = it can)
function shipClosed(c: ShipCfg, e: Env): string | null {
  const today = localDate(Date.now());
  if (c.order_by && today > c.order_by) return `Shipped orders closed on ${fmtDay(c.order_by)}. You can still pick up at the shop.`;
  if (today >= c.ship_on) return "Shipped orders are closed for this season. You can still pick up at the shop.";
  if (!accepting(c.from, e)) return closedMsg(c.from, e);
  return null;
}
async function publicShip(e: Env) {
  const c = shipCfg;
  if (!c) return null;
  let left: number | null = null;
  if (c.limit) { try { left = Math.max(0, c.limit - (await shippedBoxes(e, c))); } catch (err) { console.error(err); } }
  const why = shipClosed(c, e) ?? (left === 0 ? "Shipped boxes are sold out. You can still pick up at the shop." : null);
  return {
    open: !why, message: why, from: c.from, from_label: SHOPS[c.from].label, items: c.items,
    order_by: c.order_by, ship_on: c.ship_on, arrive_from: c.arrive_from, arrive_by: c.arrive_by, text: shipText(c),
    first_cents: c.first_cents, each_cents: c.each_cents, left,
    states: Object.keys(US_STATES).filter((s) => !NO_SHIP.has(s)).map((s) => ({ code: s, name: US_STATES[s] })),
    tax_states: c.tax_states,
  };
}
// a ship bag holds shippable items only; returns how many boxes
function shipLines(c: ShipCfg, lines: Line[]) {
  const no = lines.find((l) => !c.items.includes(l.item.id));
  if (no) throw new PublicError(`${no.item.name} can't be shipped — please order it for pickup instead.`, 409);
  return lines.reduce((n, l) => n + l.qty, 0);
}
function readShipTo(s: any, cust: Cust): ShipTo {
  const t: ShipTo = {
    name: clean(s?.name, 80) || `${cust.first} ${cust.last}`.trim(), phone: null,
    address1: clean(s?.address1, 120), address2: clean(s?.address2, 120), city: clean(s?.city, 80),
    state: clean(s?.state, 2).toUpperCase(), zip: clean(s?.zip, 10), gift_note: clean(s?.gift_note, 250),
  };
  const digits = clean(s?.phone, 40).replace(/\D/g, "");
  if (digits && !e164(digits)) throw new PublicError("Please check the recipient's phone number (10 digits), or leave it blank.");
  t.phone = digits ? e164(digits) : cust.phone; // carriers like a phone number: the buyer's when the recipient's isn't given
  if (t.name.length < 2) throw new PublicError("Please add who the box is going to.");
  if (!t.address1) throw new PublicError("Please add the street address.");
  if (PO_BOX.test(t.address1 + " " + t.address2)) throw new PublicError("We can't ship cheese to a PO box or an APO/FPO address — please use a street address.");
  if (!t.city) throw new PublicError("Please add the city.");
  if (!US_STATES[t.state]) throw new PublicError("Please pick the state.");
  if (NO_SHIP.has(t.state)) throw new PublicError("We ship to the lower 48 states and DC only — not to Alaska or Hawaii.");
  if (!/^\d{5}(-\d{4})?$/.test(t.zip)) throw new PublicError("Please check the ZIP code.");
  return t;
}
// The Square order for a ship bag: SHIPMENT fulfillment, a "Shipping" service charge, and taxes only for tax_states.
function buildShipOrder(e: Env, m: Menu, c: ShipCfg, lines: Line[], state: string | null, to: ShipTo | null, cust: Cust | null, locationId: string, code: string, note: string) {
  const taxed = !!state && c.tax_states.includes(state);
  const taxIds = [...new Set(lines.flatMap((l) => l.item.taxes))].filter((t) => m.taxes[t]);
  const line_items = lines.map((l, i) => {
    const li: Record<string, unknown> = { uid: "l" + (i + 1), quantity: String(l.qty) };
    if (e === "production") {
      li.catalog_object_id = l.v.id;
      if (l.chosen.length) li.modifiers = l.chosen.map((x) => ({ catalog_object_id: x.mod.id }));
    } else {
      li.name = l.item.full_name;
      li.variation_name = l.v.name;
      li.base_price_money = { amount: l.v.price, currency: "USD" };
      if (l.chosen.length) li.modifiers = l.chosen.map((x) => ({ name: x.mod.name, base_price_money: { amount: x.mod.price, currency: "USD" } }));
    }
    if (l.note) li.note = l.note;
    return li;
  });
  const order: Record<string, unknown> = {
    location_id: locationId,
    source: { name: "Greys online ordering" },
    line_items,
    // no automatic catalog taxes on a shipped order: the ship-to state decides (Tennessee: the items' own taxes)
    pricing_options: { auto_apply_taxes: false, auto_apply_discounts: false },
  };
  if (code) {
    order.reference_id = code;
    order.metadata = { web_code: code, shop: m.shop, fulfillment: "ship" };
    if (cust) { // the packing list reads these back (v17)
      const md = order.metadata as Record<string, string>;
      md.buyer = `${cust.first} ${cust.last}`.trim().slice(0, 255);
      if (cust.phone) md.buyer_phone = cust.phone;
      if (to?.gift_note) md.gift_note = to.gift_note.slice(0, 255);
    }
  }
  if (taxed && taxIds.length) {
    // ORDER scope: the boxes AND the taxable Shipping charge
    order.taxes = taxIds.map((t) => e === "production"
      ? { uid: "t-" + t, catalog_object_id: t, scope: "ORDER" }
      : { uid: "t-" + t, name: m.taxes[t].name, percentage: m.taxes[t].pct, type: m.taxes[t].inclusive ? "INCLUSIVE" : "ADDITIVE", scope: "ORDER" });
  }
  const fee = shipFee(c, lines.reduce((n, l) => n + l.qty, 0));
  if (fee > 0) {
    order.service_charges = [{ uid: "ship", name: "Shipping", amount_money: { amount: fee, currency: "USD" }, calculation_phase: "SUBTOTAL_PHASE", taxable: taxed }];
  }
  if (to && cust) {
    const address: Record<string, string> = { address_line_1: to.address1, locality: to.city, administrative_district_level_1: to.state, postal_code: to.zip, country: "US" };
    if (to.address2) address.address_line_2 = to.address2;
    const recipient: Record<string, unknown> = { display_name: to.name.slice(0, 255), email_address: cust.email, address };
    if (to.phone) recipient.phone_number = to.phone;
    order.fulfillments = [{
      type: "SHIPMENT",
      state: "PROPOSED",
      shipment_details: {
        recipient,
        expected_shipped_at: new Date(dayAt(c.ship_on, 12, m.location.tz)).toISOString(),
        shipping_note: [`SHIP ${fmtLongDay(c.ship_on)}`, `Online ${code}`, `From ${cust.first} ${cust.last}`.trim(), to.gift_note ? `Gift note: “${to.gift_note}”` : "", note]
          .filter(Boolean).join(" · ").slice(0, 500),
      },
    }];
    order.ticket_name = `Ship · ${to.name}`.slice(0, 30);
  }
  return order;
}

// ---------- rate limiting ----------
async function rateLimit(req: Request, bucket: string, limit: number) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { data, error } = await admin.rpc("ticket_rate_hit", { p_bucket: (bucket + ":" + ip).slice(0, 200), p_limit: limit, p_window_secs: 3600 });
  if (!error && data === false) throw new PublicError("Too many tries from this connection. Please wait a bit, or call the shop.", 429);
}

// ---------- actions ----------
async function menu(req: Request, b: any) {
  const shop = shopOf(b.location);
  const e = envFor(req);
  const [m, pay, ship] = await Promise.all([loadMenu(shop), payConfig(shop, e), publicShip(e)]);
  return { ok: true, env: e, ...publicMenu(m, e), pay, ship };
}

// ---------- shipped orders (SHIPPING at the top) ----------
async function quoteShip(req: Request, b: any) {
  const c = shipCfg;
  if (!c) throw new PublicError("Shipping isn't available right now.", 409);
  const e = envFor(req);
  const m = await loadMenu(c.from);
  const lines = priceLines(m, b.lines);
  shipLines(c, lines);
  const st = clean(b.ship?.state, 2).toUpperCase();
  const state = US_STATES[st] && !NO_SHIP.has(st) ? st : null; // no state yet: totals before tax
  const order = buildShipOrder(e, m, c, lines, state, null, null, await paymentLocation(c.from, e), "", "");
  const d = await square("/v2/orders/calculate", { method: "POST", body: JSON.stringify({ order }) }, e);
  const t = totalsOf(d.order);
  return {
    ok: true, env: e, ...t, shipping_cents: Number(d.order?.total_service_charge_money?.amount ?? 0), state, tax_known: !!state,
    lines: (d.order?.line_items ?? []).map((li: any, i: number) => ({ ...lineSummary([lines[i]])[0], total_cents: Number(li.total_money?.amount ?? 0), tax_cents: Number(li.total_tax_money?.amount ?? 0) })),
  };
}

async function payShip(req: Request, b: any) {
  await rateLimit(req, "ord", 12);
  const c = shipCfg;
  if (!c) throw new PublicError("Shipping isn't available right now. Nothing was charged.", 409);
  const e = envFor(req);
  const why = shipClosed(c, e);
  if (why) throw new PublicError(why, 409);
  const shop = c.from;
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("Please re-enter your card.");
  const verificationToken = clean(b.verification_token, 4000);
  const cc = b.customer ?? {};
  const first = clean(cc.first_name, 60), last = clean(cc.last_name, 60);
  const email = clean(cc.email, 200).toLowerCase();
  const digits = clean(cc.phone, 40).replace(/\D/g, "");
  if (!first) throw new PublicError("Please add your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Please check your email address.");
  if (digits.length < 10) throw new PublicError("Please add a phone number so we can reach you about your order.");
  const cust: Cust = { first, last, email, phone: e164(digits) };
  const to = readShipTo(b.ship, cust);

  const m = await loadMenu(shop);
  const lines = priceLines(m, b.lines);
  const boxes = shipLines(c, lines);
  await checkStock(m, lines);
  if (c.limit) {
    const left = Math.max(0, c.limit - (await shippedBoxes(e, c, true)));
    if (left <= 0) throw new PublicError("Shipped boxes are sold out. You can still pick up at the shop. Nothing was charged.", 409);
    if (boxes > left) throw new PublicError(`Only ${left} shipped box${left === 1 ? "" : "es"} left — please lower the quantity. Nothing was charged.`, 409);
  }
  const note = clean(b.note, 300);
  const locationId = await paymentLocation(shop, e);
  const wallet = b.wallet === "google_pay" ? "Google Pay" : null;

  // Same customer + address + cart + checkout attempt → same Square order (safe double-click / card retry).
  const sig = JSON.stringify({
    a: clean(b.attempt, 80) || crypto.randomUUID(), e, shop, ship: 1, c: cust, t: to, n: note,
    l: lines.map((l) => [l.v.id, l.qty, l.chosen.map((x) => x.mod.id), l.note]),
  });
  const hash = await sha256hex(sig);
  const code = codeFrom(hash);
  const order = buildShipOrder(e, m, c, lines, to.state, to, cust, locationId, code, note);
  const od = await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "s-" + hash.slice(0, 60), order }) }, e);
  let o = od?.order;
  if (!o?.id) throw new Error("Square did not return an order");
  // swept while the customer was away: carry on with a fresh order (same as pay)
  for (let i = 0; o.state === "CANCELED" && i < 3; i++) {
    const old = o.id;
    const again = await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "s-" + (await sha256hex(hash + "|" + old)).slice(0, 60), order }) }, e);
    o = again?.order;
    if (!o?.id) throw new Error("Square did not return an order");
    if (o.id !== old) {
      await admin.from("online_orders").update({ square_order_id: o.id, status: "pending", error: null, updated_at: new Date().toISOString() })
        .eq("square_order_id", old).neq("status", "paid");
    }
  }
  if (o.state === "CANCELED") throw new PublicError("This checkout timed out. Please place your order again. Nothing was charged.", 409);
  const t = totalsOf(o);
  const shipCents = Number(o?.total_service_charge_money?.amount ?? 0);
  const charge = t.total_cents; // no tip on a shipped order

  const { data: prior } = await admin.from("online_orders").select("id, status, code, square_payment_id, receipt_url, card, total_cents").eq("square_order_id", o.id).maybeSingle();
  const shipOut = {
    name: to.name, city: to.city, state: to.state, zip: to.zip, ship_on: c.ship_on, arrive_from: c.arrive_from, arrive_by: c.arrive_by,
    label: shipText(c), from: shop, from_label: SHOPS[shop].label,
  };
  const result = (row: { card: string | null; receipt_url: string | null }, emailSent: boolean | null) => ({
    ok: true, env: e, code, ...t, shipping_cents: shipCents, tip_cents: 0, charged_cents: charge, fulfillment: "ship", ship: shipOut,
    location: m.location, card: row.card, receipt_url: row.receipt_url, email_sent: emailSent, lines: lineSummary(lines),
  });
  if (prior?.status === "paid") return result(prior as any, null); // already paid: never charge twice
  const row = {
    code, env: e, location: shop, square_location_id: locationId, status: "pending", error: null,
    customer_name: `${first} ${last}`.trim(), email, phone: cust.phone ?? digits, pickup_at: null, asap: false, catering: false, note: note || null,
    lines: lineSummary(lines), subtotal_cents: t.subtotal_cents, tax_cents: t.tax_cents, tip_cents: 0, total_cents: charge,
    square_order_id: o.id, updated_at: new Date().toISOString(),
    fulfillment: "ship", ship_to: to, gift_note: to.gift_note || null, shipping_cents: shipCents, ship_on: c.ship_on,
  };
  let w = prior ? await admin.from("online_orders").update(row).eq("id", prior.id) : await admin.from("online_orders").insert(row);
  if (w.error && /column|schema cache/i.test(w.error.message)) { // the shipping columns aren't there yet: log the rest
    const { fulfillment: _f, ship_to: _t, gift_note: _g, shipping_cents: _s, ship_on: _o, ...base } = row;
    w = prior ? await admin.from("online_orders").update(base).eq("id", prior.id) : await admin.from("online_orders").insert(base);
  }
  if (w.error) console.error("ledger", o.id, w.error.message);
  const oid = o.id;
  const fail = (msg: string) => admin.from("online_orders").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("square_order_id", oid).neq("status", "paid");

  if (!(t.total_cents > 0) || t.total_cents > MAX_TOTAL_CENTS) {
    await fail("total out of range");
    throw new PublicError("That order total doesn't look right — please call the shop.");
  }
  const expected = Math.round(Number(b.expected_total_cents));
  if (Number.isFinite(expected) && expected > 0 && expected !== charge) {
    await fail(`total changed: page ${expected}, Square ${charge}`);
    throw new PublicError(`Your total is now ${money(charge)} — please review it and place the order again. Nothing was charged.`, 409, { totals: { ...t, shipping_cents: shipCents, tip_cents: 0 } });
  }

  let pmt: any;
  try {
    const p = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: ("q" + (await sha256hex(oid + "|" + sourceId))).slice(0, 45),
        source_id: sourceId,
        verification_token: verificationToken || undefined,
        amount_money: { amount: charge, currency: "USD" },
        location_id: locationId,
        order_id: oid,
        reference_id: code,
        buyer_email_address: email,
        shipping_address: {
          address_line_1: to.address1, ...(to.address2 ? { address_line_2: to.address2 } : {}), locality: to.city,
          administrative_district_level_1: to.state, postal_code: to.zip, country: "US",
          first_name: to.name.split(" ")[0], ...(to.name.includes(" ") ? { last_name: to.name.split(" ").slice(1).join(" ") } : {}),
        },
        note: `Online order ${code} · ship to ${to.city}, ${to.state}${wallet ? " · " + wallet : ""}`,
        autocomplete: true,
      }),
    }, e);
    pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await fail((wallet ? wallet + ": " : "") + String((err as Error).message));
    if (err instanceof SquareError && (err.status < 500 || err.codes.length)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const cardLine = pmt.card_details?.card ? `${String(pmt.card_details.card.card_brand || "Card").replace(/_/g, " ")} ····${pmt.card_details.card.last_4}` : null;
  const card = wallet ? (cardLine ? `${wallet} · ${cardLine}` : wallet) : cardLine;
  await admin.from("online_orders").update({
    status: "paid", square_payment_id: pmt.id, receipt_url: pmt.receipt_url ?? null, card, error: null, paid_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("square_order_id", oid);
  delete shipCache[e]; // the next menu and packing list count this box
  const out = result({ card, receipt_url: pmt.receipt_url ?? null }, null);
  const sent = await mailShipConfirmation(out, cust, to, note).catch((err) => { console.error("mail", code, err); return false; });
  await admin.from("online_orders").update({ email_sent: sent }).eq("square_order_id", oid);
  return { ...out, email_sent: sent };
}

// ---------- shipped orders: the staff side (v17, SHIPPED ORDERS at the top) ----------
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// a manager's session (is_app_admin) or the cron secret; null = not staff
async function staff(req: Request, b: any): Promise<string | null> {
  const sec = clean(b.secret, 200);
  if (sec) {
    const { data } = await admin.from("app_secrets").select("value").eq("name", "cc_cron_secret").maybeSingle();
    if (data?.value && sec === data.value) return "cron";
  }
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === ANON || tok.startsWith("sb_publishable_")) return null;
  if (tok === SERVICE) return "service";
  const user = createClient(SUPABASE_URL, ANON || SERVICE, { global: { headers: { Authorization: "Bearer " + tok } }, auth: { persistSession: false } });
  const { data, error } = await user.rpc("is_app_admin");
  if (error || data !== true) return null;
  const { data: u } = await admin.auth.getUser(tok);
  return u?.user?.email ?? "manager";
}
async function needStaff(req: Request, b: any) {
  const who = await staff(req, b);
  if (!who) throw new PublicError("Managers only — please sign in to the manager console again.", 401);
  return who;
}

type ShipOrder = {
  id: string; code: string; state: string; created_at: string; ship_on: string | null; paid: boolean; refunded: boolean;
  buyer: string; buyer_first: string; email: string; buyer_phone: string;
  to: { name: string; phone: string; address1: string; address2: string; city: string; state: string; zip: string };
  gift_note: string; note: string; lines: { name: string; option: string; qty: number; note: string }[]; boxes: number;
  total_cents: number; shipping_cents: number; tax_cents: number;
  fulfillment_uid: string; fulfillment_state: string;
  carrier: string; tracking_number: string; tracking_url: string; shipped_at: string | null; tracking_emailed: string | null;
};
function shipOrderOf(o: any): ShipOrder | null {
  const f = (o?.fulfillments ?? []).find((x: any) => x?.type === "SHIPMENT");
  if (!o?.id || !f || (o.metadata?.fulfillment !== "ship" && o.source?.name !== "Greys online ordering")) return null;
  const sd = f.shipment_details ?? {}, r = sd.recipient ?? {}, a = r.address ?? {}, md = o.metadata ?? {};
  const tenders: any[] = Array.isArray(o.tenders) ? o.tenders : [];
  const good = tenders.filter((t) => !["FAILED", "VOIDED"].includes(String(t?.card_details?.status ?? "")));
  const total = Number(o.total_money?.amount ?? 0), due = Number(o.net_amount_due_money?.amount);
  const paid = good.length > 0 || (Number.isFinite(due) && due <= 0 && total > 0 && o.state === "COMPLETED");
  const refundedCents = (Array.isArray(o.refunds) ? o.refunds : []).filter((x: any) => x?.status !== "REJECTED" && x?.status !== "FAILED")
    .reduce((n: number, x: any) => n + Number(x?.amount_money?.amount ?? 0), 0);
  const sn = String(sd.shipping_note ?? "");
  const buyer = clean(md.buyer, 120) || clean((sn.match(/From ([^·]+)/) ?? [])[1], 120);
  const gift = clean(md.gift_note, 255) || clean((sn.match(/Gift note: “([^”]*)”/) ?? [])[1], 255);
  const lines = (o.line_items ?? []).map((li: any) => ({
    name: clean(li.name, 120), option: li.variation_name && li.variation_name !== "Regular" ? clean(li.variation_name, 80) : "",
    qty: Math.max(0, Number(li.quantity) || 0), note: clean(li.note, 200),
  }));
  const shipMs = Date.parse(sd.expected_shipped_at ?? "");
  return {
    id: o.id, code: clean(o.reference_id || md.web_code, 12), state: o.state, created_at: o.created_at,
    ship_on: Number.isFinite(shipMs) ? localDate(shipMs) : null, paid, refunded: refundedCents > 0 && refundedCents >= total,
    buyer, buyer_first: buyer.split(" ")[0] || "", email: clean(r.email_address, 200), buyer_phone: clean(md.buyer_phone, 40),
    to: {
      name: clean(r.display_name, 120), phone: clean(r.phone_number, 40), address1: clean(a.address_line_1, 120), address2: clean(a.address_line_2, 120),
      city: clean(a.locality, 80), state: clean(a.administrative_district_level_1, 2), zip: clean(a.postal_code, 10),
    },
    gift_note: gift, note: clean(o.note, 300), lines, boxes: lines.reduce((n: number, l: { qty: number }) => n + l.qty, 0),
    total_cents: total, shipping_cents: Number(o.total_service_charge_money?.amount ?? 0), tax_cents: Number(o.total_tax_money?.amount ?? 0),
    fulfillment_uid: String(f.uid ?? ""), fulfillment_state: String(f.state ?? ""),
    carrier: clean(sd.carrier, 40), tracking_number: clean(sd.tracking_number, 60), tracking_url: clean(sd.tracking_url, 300),
    shipped_at: sd.shipped_at ?? null, tracking_emailed: clean(md.tracking_emailed, 40) || null,
  };
}
// every paid ship order from this site at the from-shop (this env), newest first; cached 30 s
const shipCache: Record<string, { at: number; v: ShipOrder[] } | undefined> = {};
async function shipOrders(e: Env, fresh = false): Promise<ShipOrder[]> {
  const hit = shipCache[e];
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.v;
  const c = shipCfg, from: Shop = c?.from ?? "memphis";
  const since = new Date(Math.min(Date.now(), c ? dayAt(c.ship_on, 12) : Date.now()) - 150 * 86400_000).toISOString();
  const location = await paymentLocation(from, e);
  const out: ShipOrder[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const d = await square("/v2/orders/search", {
      method: "POST",
      body: JSON.stringify({
        location_ids: [location], limit: 100, ...(cursor ? { cursor } : {}),
        query: {
          filter: {
            state_filter: { states: ["OPEN", "COMPLETED"] },
            fulfillment_filter: { fulfillment_types: ["SHIPMENT"] },
            date_time_filter: { created_at: { start_at: since } },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
        },
      }),
    }, e);
    for (const o of d?.orders ?? []) { const s = shipOrderOf(o); if (s && s.paid) out.push(s); }
    cursor = d?.cursor;
    if (!cursor) break;
  }
  shipCache[e] = { at: Date.now(), v: out };
  return out;
}
// staff calendar: how many boxes go out each ship day — no names (the portal home page has no login)
async function shipDays(req: Request) {
  const e = staffEnv(), c = shipCfg;
  const by: Record<string, { date: string; orders: number; boxes: number; shipped: number }> = {};
  for (const o of await shipOrders(e)) {
    if (o.refunded || !o.ship_on) continue;
    const d = (by[o.ship_on] ??= { date: o.ship_on, orders: 0, boxes: 0, shipped: 0 });
    d.orders++; d.boxes += o.boxes;
    if (o.tracking_number || o.fulfillment_state === "COMPLETED") d.shipped++;
  }
  const from: Shop = c?.from ?? "memphis";
  return { ok: true, env: e, from, from_label: SHOPS[from].label, ship_on: c?.ship_on ?? null, days: Object.values(by).sort((a, b) => a.date.localeCompare(b.date)) };
}
// the packing list, with what the ledger knows about the tracking email
async function shipOrdersAction(req: Request, b: any) {
  await needStaff(req, b);
  const e = staffEnv(), c = shipCfg;
  const list = await shipOrders(e, b.fresh === true);
  const ids = list.map((o) => o.id);
  if (ids.length) {
    const { data, error } = await admin.from("online_orders").select("square_order_id, tracking_emailed_at").in("square_order_id", ids);
    if (!error) for (const r of data ?? []) { const o = list.find((x) => x.id === (r as any).square_order_id); if (o && (r as any).tracking_emailed_at && !o.tracking_emailed) o.tracking_emailed = (r as any).tracking_emailed_at; }
  }
  const from: Shop = c?.from ?? "memphis";
  return {
    ok: true, env: e, from, from_label: SHOPS[from].label, config: shipCfg ? { ...shipCfg, text: shipText(shipCfg) } : null,
    orders: list,
  };
}
const CARRIERS = ["UPS", "USPS", "FedEx", "Other"];
function trackUrl(carrier: string, num: string) {
  const n = encodeURIComponent(num);
  if (/^ups$/i.test(carrier)) return `https://www.ups.com/track?loc=en_US&tracknum=${n}`;
  if (/^usps$/i.test(carrier)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (/^fedex$/i.test(carrier)) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  return "";
}
// what the ledger knows (best effort: the columns may not be there yet)
async function ledgerTrack(o: ShipOrder, emailed: boolean) {
  const { error } = await admin.from("online_orders").update({
    carrier: o.carrier || null, tracking_number: o.tracking_number || null, tracking_url: o.tracking_url || null,
    shipped_at: o.shipped_at, ...(emailed ? { tracking_emailed_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString(),
  }).eq("square_order_id", o.id);
  if (error) console.error("ledger track", o.id, error.message);
  return !error;
}
// a label bought outside Square (or typed in by hand): the email first, then onto the Square order (carrier, tracking
// number, shipped_at; fulfillment COMPLETED; metadata.tracking_emailed when the email went)
async function shipMark(req: Request, b: any) {
  const who = await needStaff(req, b);
  const e = staffEnv();
  const id = clean(b.order_id, 80);
  const carrier = CARRIERS.find((x) => x.toLowerCase() === clean(b.carrier, 20).toLowerCase()) ?? "UPS";
  const num = clean(b.tracking_number, 60).replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(num)) throw new PublicError("Please check the tracking number.");
  const url = /^https:\/\/\S+$/.test(clean(b.tracking_url, 300)) ? clean(b.tracking_url, 300) : trackUrl(carrier, num);
  let o = (await square(`/v2/orders/${encodeURIComponent(id)}`, { method: "GET" }, e))?.order;
  const s0 = shipOrderOf(o);
  if (!s0) throw new PublicError("That isn't a shipped order from the order site.", 404);
  if (!s0.paid) throw new PublicError("That order isn't paid.", 409);
  const now = new Date().toISOString();
  const s: ShipOrder = { ...s0, carrier, tracking_number: num, tracking_url: url, shipped_at: now };
  const sent = await mailShipTracking(e, s).catch((err) => { console.error("mail track", s.code, err); return false; });
  let saved = false, squareError: string | null = null;
  if (o.state === "OPEN") {
    const put = async (state: string, details: boolean) => {
      const d = await square(`/v2/orders/${encodeURIComponent(o.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          idempotency_key: (`tk-${o.id}-${o.version}-${state}`).slice(0, 190),
          order: {
            location_id: o.location_id, version: o.version,
            ...(details ? { metadata: { ...(o.metadata ?? {}), ...(sent ? { tracking_emailed: now } : {}), tracking_by: who.slice(0, 120) } } : {}),
            fulfillments: [{
              uid: s0.fulfillment_uid, state,
              ...(details ? { shipment_details: { carrier, tracking_number: num, ...(url ? { tracking_url: url } : {}), shipped_at: now } } : {}),
            }],
          },
        }),
      }, e);
      o = d?.order ?? o;
    };
    try {
      try { await put("COMPLETED", true); }
      catch (err) { // a fulfillment that can't jump straight to COMPLETED: step it through
        if (!(err instanceof SquareError) || err.status >= 500) throw err;
        for (const st of ["RESERVED", "PREPARED"]) {
          const cur = String((o.fulfillments ?? []).find((x: any) => x.uid === s0.fulfillment_uid)?.state ?? "");
          if (cur !== "PROPOSED" && !(cur === "RESERVED" && st === "PREPARED")) continue;
          await put(st, false);
        }
        await put("COMPLETED", true);
      }
      saved = true;
      // paid and shipped: close the order too (Square Dashboard doesn't list an OPEN order whose fulfillment is done)
      if (o.state === "OPEN" && Number(o.net_amount_due_money?.amount ?? 1) <= 0) {
        try {
          const d = await square(`/v2/orders/${encodeURIComponent(o.id)}`, {
            method: "PUT",
            body: JSON.stringify({ idempotency_key: (`tc-${o.id}-${o.version}`).slice(0, 190), order: { location_id: o.location_id, version: o.version, state: "COMPLETED" } }),
          }, e);
          o = d?.order ?? o;
        } catch (err) { console.error("ship_mark complete", s.code, (err as Error).message); }
      }
    } catch (err) { squareError = String((err as Error).message).slice(0, 300); console.error("ship_mark", s.code, squareError); }
  } else squareError = `Square has this order ${String(o.state).toLowerCase()}, so the tracking number wasn't added there.`;
  const after = saved ? shipOrderOf(o) ?? s : s;
  await ledgerTrack(after, sent);
  delete shipCache[e];
  return { ok: true, env: e, saved_in_square: saved, square_error: squareError, email_sent: sent, order: { ...after, tracking_emailed: sent ? now : after.tracking_emailed } };
}
// the tracking email again, for a label that's already in Square
async function shipEmail(req: Request, b: any) {
  await needStaff(req, b);
  const e = staffEnv();
  const o = shipOrderOf((await square(`/v2/orders/${encodeURIComponent(clean(b.order_id, 80))}`, { method: "GET" }, e))?.order);
  if (!o) throw new PublicError("That isn't a shipped order from the order site.", 404);
  if (!o.tracking_number) throw new PublicError("Square has no tracking number on this order yet — buy the label, or add the tracking number.", 409);
  const sent = await mailShipTracking(e, o);
  if (sent) await ledgerTrack(o, true);
  delete shipCache[e];
  return { ok: true, env: e, email_sent: sent, order: { ...o, tracking_emailed: sent ? new Date().toISOString() : o.tracking_emailed } };
}
// labels bought in Square Dashboard → the tracking email, once (the ledger remembers)
async function track(req: Request, b: any) {
  await needStaff(req, b);
  const out = { ok: true, checked: 0, emailed: [] as string[], errors: [] as string[], needs_migration: false };
  for (const e of (TEST_COPY ? ["sandbox"] : ["production"]) as Env[]) { // the test copy: the sandbox's test orders only
    const list = (await shipOrders(e, true)).filter((o) => o.tracking_number && !o.tracking_emailed && !o.refunded);
    if (!list.length) continue;
    const { data, error } = await admin.from("online_orders").select("square_order_id, tracking_emailed_at").in("square_order_id", list.map((o) => o.id));
    if (error) { out.needs_migration = true; out.errors.push(e + ": " + error.message); continue; }
    const done = new Set((data ?? []).filter((r: any) => r.tracking_emailed_at).map((r: any) => r.square_order_id));
    const known = new Set((data ?? []).map((r: any) => r.square_order_id));
    for (const o of list) {
      if (done.has(o.id) || !known.has(o.id)) continue; // no ledger row = nowhere to remember it: leave it to a person
      out.checked++;
      try {
        const sent = await mailShipTracking(e, o);
        if (sent && await ledgerTrack(o, true)) out.emailed.push(o.code);
        else if (!sent) out.errors.push(o.code + ": email not sent");
      } catch (err) { out.errors.push(o.code + ": " + String((err as Error).message).slice(0, 200)); }
    }
  }
  if (out.errors.length) console.error("track", out.errors);
  return out;
}
async function mailShipTracking(e: Env, o: ShipOrder): Promise<boolean> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return false;
  const c = shipCfg, from: Shop = c?.from ?? "memphis";
  const L = (await loadMenu(from)).location;
  const test = e === "sandbox";
  const what = o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ");
  const arrive = c ? arriveText(c) : "";
  const link = o.tracking_url ? `<a href="${esc(o.tracking_url)}" style="display:inline-block;background:#06273A;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Track your box</a>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.5">
  ${test ? `<div style="background:#FDECC8;padding:8px 12px;margin-bottom:14px;font-size:13px"><b>Test order</b> — Square sandbox. Nothing was charged and nothing shipped.</div>` : ""}
  <div style="font:700 22px Georgia,serif;letter-spacing:.04em;border-bottom:2px solid #E0A21C;padding-bottom:8px;margin-bottom:18px">GREYS <span style="font:400 12px Arial">Fine Cheeses · Shipped from ${esc(L.label)}</span></div>
  <p>Good news${o.buyer_first ? ", " + esc(o.buyer_first) : ""}! Your order is on its way${o.to.name ? " to " + esc(o.to.name) : ""}.</p>
  <p style="font-size:18px;margin:14px 0"><b>${esc(o.carrier || "Tracking")} · ${esc(o.tracking_number)}</b>${arrive ? `<br><span style="font-size:14px;color:#6E6353">It ${esc(arrive)}.</span>` : ""}</p>
  ${link ? `<p style="margin:0 0 18px">${link}</p>` : ""}
  <p style="font-size:14px;margin:0 0 14px"><b>Shipping to</b><br>${esc(o.to.name)}<br>${esc(o.to.address1)}${o.to.address2 ? "<br>" + esc(o.to.address2) : ""}<br>${esc(o.to.city)}, ${esc(o.to.state)} ${esc(o.to.zip)}</p>
  <p style="font-size:14px;margin:0 0 14px">${esc(what)}</p>
  <p style="font-size:14px">It's cheese, so it travels cold: please put the box in the fridge as soon as it arrives. If anything arrives warm or damaged, call us${L.phone ? ` at <b>${esc(L.phone)}</b>` : ""} and we'll make it right.</p>
  <p style="margin:0;color:#6E6353;font-size:13px">Order ${esc(o.code)}</p></div>`;
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({
      to: o.email,
      subject: `${test ? "[TEST] " : ""}Your Greys order ${o.code} has shipped`,
      html,
      from: Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>",
      replyTo: L.email || Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com",
    }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok !== false;
}

async function quote(req: Request, b: any) {
  await rateLimit(req, "ordq", 300);
  if (b.ship) return quoteShip(req, b);
  const shop = shopOf(b.location);
  const m = await loadMenu(shop);
  const lines = priceLines(m, b.lines);
  const e = envFor(req);
  const order = buildOrder(e, m, lines, null, null, await paymentLocation(shop, e), "", "");
  const d = await square("/v2/orders/calculate", { method: "POST", body: JSON.stringify({ order }) }, e);
  const t = totalsOf(d.order);
  return {
    ok: true, env: e, ...t,
    lines: (d.order?.line_items ?? []).map((li: any, i: number) => ({ ...lineSummary([lines[i]])[0], total_cents: Number(li.total_money?.amount ?? 0), tax_cents: Number(li.total_tax_money?.amount ?? 0) })),
  };
}

function cardMessage(err: unknown) {
  const codes = err instanceof SquareError ? err.codes : [];
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  if (has("CVV_FAILURE", "INVALID_CVV")) return "The security code didn't match. Please check it and try again.";
  if (has("ADDRESS_VERIFICATION_FAILURE", "INVALID_POSTAL_CODE")) return "The billing ZIP didn't match. Please check it and try again.";
  if (has("INVALID_EXPIRATION", "INVALID_EXPIRATION_DATE", "INVALID_EXPIRATION_YEAR", "EXPIRATION_FAILURE", "CARD_EXPIRED")) return "Please check the card's expiration date.";
  if (has("INSUFFICIENT_FUNDS")) return "The card was declined for insufficient funds.";
  if (has("INVALID_CARD", "INVALID_CARD_DATA", "INVALID_ACCOUNT", "CARD_NOT_SUPPORTED")) return "That card can't be used. Please try another card.";
  if (has("CARD_DECLINED", "GENERIC_DECLINE", "CARD_DECLINED_CALL_ISSUER", "CARD_DECLINED_VERIFICATION_REQUIRED", "TRANSACTION_LIMIT", "VOICE_FAILURE", "PAN_FAILURE", "ALLOWABLE_PIN_TRIES_EXCEEDED", "BAD_EXPIRATION")) {
    return "The card was declined. Please try another card.";
  }
  if (has("CARD_TOKEN_USED", "CARD_TOKEN_EXPIRED", "SOURCE_USED")) return "Please re-enter your card and try again.";
  return "We couldn't charge that card. Please try again or use another card.";
}

async function pay(req: Request, b: any) {
  await rateLimit(req, "ord", 12);
  const shop = shopOf(b.location);
  const e = envFor(req);
  if (!accepting(shop, e)) throw new PublicError(closedMsg(shop, e) ?? PAUSED_MSG, 409);
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("Please re-enter your card.");
  const verificationToken = clean(b.verification_token, 4000);
  const c = b.customer ?? {};
  const first = clean(c.first_name, 60), last = clean(c.last_name, 60);
  const email = clean(c.email, 200).toLowerCase();
  const digits = clean(c.phone, 40).replace(/\D/g, "");
  if (!first) throw new PublicError("Please add your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Please check your email address.");
  if (digits.length < 10) throw new PublicError("Please add a phone number so we can reach you about your order.");
  const cust: Cust = { first, last, email, phone: e164(digits) };

  const m = await loadMenu(shop);
  const lines = priceLines(m, b.lines);
  await checkStock(m, lines);
  const catering = lines.some((l) => l.item.catering);
  const pickup = checkPickup(m, b.pickup, lines);
  const note = clean(b.note, 300);
  const tip = Math.round(Number(b.tip_cents) || 0);
  if (tip < 0) throw new PublicError("Please check the tip.");
  const locationId = await paymentLocation(shop, e);
  const wallet = b.wallet === "google_pay" ? "Google Pay" : null;

  // Same customer + cart + time + checkout attempt → same Square order (safe double-click / card retry).
  const sig = JSON.stringify({
    a: clean(b.attempt, 80) || crypto.randomUUID(), e, shop, c: cust, n: note, p: pickup.asap ? "asap" : pickup.ms,
    l: lines.map((l) => [l.v.id, l.qty, l.chosen.map((x) => x.mod.id), l.note]),
  });
  const hash = await sha256hex(sig);
  const code = codeFrom(hash);
  const order = buildOrder(e, m, lines, pickup, cust, locationId, code, note);
  const od = await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "o-" + hash.slice(0, 60), order }) }, e);
  let o = od?.order;
  if (!o?.id) throw new Error("Square did not return an order");
  // This checkout sat unpaid long enough for the sweep to cancel its order: carry on with a fresh one. Each
  // replacement's key comes from the order it replaces, so a double-click still lands on the same order.
  for (let i = 0; o.state === "CANCELED" && i < 3; i++) {
    const old = o.id;
    const again = await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "o-" + (await sha256hex(hash + "|" + old)).slice(0, 60), order }) }, e);
    o = again?.order;
    if (!o?.id) throw new Error("Square did not return an order");
    if (o.id !== old) {
      await admin.from("online_orders").update({ square_order_id: o.id, status: "pending", error: null, updated_at: new Date().toISOString() })
        .eq("square_order_id", old).neq("status", "paid");
    }
  }
  if (o.state === "CANCELED") throw new PublicError("This checkout timed out. Please place your order again. Nothing was charged.", 409);
  const t = totalsOf(o);
  const charge = t.total_cents + tip;

  // ledger (one row per Square order) — written before anything below can stop, so every order that never
  // gets paid is on file for the sweep
  const pickupIso = new Date(pickup.ms).toISOString();
  const { data: prior } = await admin.from("online_orders").select("id, status, code, square_payment_id, receipt_url, card, total_cents, tip_cents").eq("square_order_id", o.id).maybeSingle();
  const result = (row: { card: string | null; receipt_url: string | null }, emailSent: boolean | null) => ({
    ok: true, env: e, code, ...t, tip_cents: tip, charged_cents: charge,
    pickup: { asap: pickup.asap, at: pickupIso, label: pickup.asap ? `Today, about ${fmtTime(pickup.ms, m.location.tz)}` : fmtWhen(pickup.ms, m.location.tz) },
    location: m.location, card: row.card, receipt_url: row.receipt_url, email_sent: emailSent, lines: lineSummary(lines),
  });
  if (prior?.status === "paid") return result(prior as any, null); // already paid: never charge twice
  const row = {
    code, env: e, location: shop, square_location_id: locationId, status: "pending", error: null,
    customer_name: `${first} ${last}`.trim(), email, phone: cust.phone ?? digits, pickup_at: pickupIso, asap: pickup.asap, catering, note: note || null,
    lines: lineSummary(lines), subtotal_cents: t.subtotal_cents, tax_cents: t.tax_cents, tip_cents: tip, total_cents: charge,
    square_order_id: o.id, updated_at: new Date().toISOString(),
  };
  const w = prior ? await admin.from("online_orders").update(row).eq("id", prior.id) : await admin.from("online_orders").insert(row);
  if (w.error) console.error("ledger", o.id, w.error.message);
  const oid = o.id;
  const fail = (msg: string) => admin.from("online_orders").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("square_order_id", oid).neq("status", "paid");

  if (!(t.total_cents > 0) || t.total_cents > MAX_TOTAL_CENTS) {
    await fail("total out of range");
    throw new PublicError("That order total doesn't look right — please call the shop.");
  }
  if (tip > t.total_cents || tip > 100000) {
    await fail("tip too high");
    throw new PublicError("That tip looks too high — please check it.");
  }
  const expected = Math.round(Number(b.expected_total_cents));
  if (Number.isFinite(expected) && expected > 0 && expected !== charge) {
    await fail(`total changed: page ${expected}, Square ${charge}`);
    throw new PublicError(`Your total is now ${money(charge)} — please review it and place the order again. Nothing was charged.`, 409, { totals: { ...t, tip_cents: tip } });
  }

  let pmt: any;
  try {
    const p = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: ("p" + (await sha256hex(oid + "|" + sourceId + "|" + tip))).slice(0, 45),
        source_id: sourceId,
        verification_token: verificationToken || undefined,
        amount_money: { amount: t.total_cents, currency: "USD" },
        ...(tip > 0 ? { tip_money: { amount: tip, currency: "USD" } } : {}),
        location_id: locationId,
        order_id: oid,
        reference_id: code,
        buyer_email_address: email,
        note: `Online order ${code} · ${shop}${wallet ? " · " + wallet : ""}`,
        autocomplete: true,
      }),
    }, e);
    pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await fail((wallet ? wallet + ": " : "") + String((err as Error).message));
    if (err instanceof SquareError && (err.status < 500 || err.codes.length)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const cardLine = pmt.card_details?.card ? `${String(pmt.card_details.card.card_brand || "Card").replace(/_/g, " ")} ····${pmt.card_details.card.last_4}` : null;
  const card = wallet ? (cardLine ? `${wallet} · ${cardLine}` : wallet) : cardLine;
  await admin.from("online_orders").update({
    status: "paid", square_payment_id: pmt.id, receipt_url: pmt.receipt_url ?? null, card, error: null, paid_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("square_order_id", oid);
  const out = result({ card, receipt_url: pmt.receipt_url ?? null }, null);
  const sent = await mailConfirmation(out, cust, note).catch((err) => { console.error("mail", code, err); return false; });
  await admin.from("online_orders").update({ email_sent: sent }).eq("square_order_id", oid);
  return { ...out, email_sent: sent };
}

// ---------- sweep: cancel orders that never got paid ----------
// pg_cron calls this every 10 minutes with the shared cron secret (app_secrets.cc_cron_secret). An online order
// still pending/failed 30 minutes after its last checkout attempt is canceled in Square (fulfillment too),
// dropped from the staff-calendar mirror and marked cancelled here. Nothing Square shows a payment on is
// touched — those get a note in `error` for a person to check. Sandbox rows can be swept sooner for tests.
const SWEEP_MINUTES = 30;
async function sweep(b: any) {
  const { data: sec } = await admin.from("app_secrets").select("value").eq("name", "cc_cron_secret").maybeSingle();
  if (!sec?.value || String(b.secret ?? "") !== String(sec.value)) throw new PublicError("Not allowed.", 401);
  const now = Date.now();
  const sbMin = Math.max(1, Math.min(SWEEP_MINUTES, Math.floor(Number(b.sandbox_minutes)) || SWEEP_MINUTES));
  const { data: rows, error } = await admin.from("online_orders")
    .select("id, env, code, status, square_order_id, updated_at")
    .in("status", ["pending", "failed"]).not("square_order_id", "is", null)
    .lt("updated_at", new Date(now - sbMin * 60000).toISOString())
    .order("updated_at", { ascending: true }).limit(25);
  if (error) throw new Error("sweep: " + error.message);
  const out = { ok: true, checked: 0, cancelled: [] as string[], kept: [] as string[], errors: [] as string[] };
  for (const r of rows ?? []) {
    const e: Env = r.env === "production" ? "production" : "sandbox";
    if (e === "production" && now - Date.parse(r.updated_at) < SWEEP_MINUTES * 60000) continue;
    out.checked++;
    const note = (s: string) => admin.from("online_orders").update({ error: s.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", r.id).neq("status", "paid");
    try {
      const o = (await square(`/v2/orders/${encodeURIComponent(r.square_order_id)}`, { method: "GET" }, e))?.order;
      // A declined card still leaves a tender on the order (card_details.status FAILED), so only tenders that
      // went through count — or Square saying nothing is left to pay.
      const tenders: any[] = Array.isArray(o?.tenders) ? o.tenders : [];
      const good = tenders.filter((t) => !["FAILED", "VOIDED"].includes(String(t?.card_details?.status ?? "")));
      const due = Number(o?.net_amount_due_money?.amount);
      const paid = good.length > 0 || (Number.isFinite(due) && due <= 0 && Number(o?.total_money?.amount ?? 0) > 0);
      if (o && ((o.state !== "OPEN" && o.state !== "CANCELED") || paid)) {
        const seen = tenders.map((t) => String(t?.card_details?.status ?? t?.type ?? "?")).join("/");
        await note(`sweep: Square shows this order ${o.state}${paid ? " with a payment" : ""}${seen ? ` (tenders ${seen})` : ""} — check it in Square`);
        out.kept.push(r.code);
        continue;
      }
      if (o && o.state === "OPEN") {
        const fulfillments = (o.fulfillments ?? []).filter((f: any) => f.uid && !["CANCELED", "COMPLETED", "FAILED"].includes(f.state))
          .map((f: any) => ({ uid: f.uid, state: "CANCELED" }));
        await square(`/v2/orders/${encodeURIComponent(o.id)}`, {
          method: "PUT",
          body: JSON.stringify({
            idempotency_key: ("cx-" + o.id + "-" + o.version).slice(0, 190),
            order: { location_id: o.location_id, version: o.version, state: "CANCELED", ...(fulfillments.length ? { fulfillments } : {}) },
          }),
        }, e);
      }
      if (e === "production") await admin.from("square_future_orders").delete().eq("square_order_id", r.square_order_id);
      await admin.from("online_orders").update({ status: "cancelled", error: `not paid — order canceled by the ${SWEEP_MINUTES}-minute sweep`, updated_at: new Date().toISOString() })
        .eq("id", r.id).neq("status", "paid");
      out.cancelled.push(r.code);
    } catch (err) {
      const msg = String((err as Error).message).slice(0, 300);
      await note("sweep: " + msg);
      out.errors.push(r.code + ": " + msg);
    }
  }
  if (out.errors.length) console.error("sweep", out.errors);
  return out;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
async function mailConfirmation(r: any, cust: Cust, note: string): Promise<boolean> {
  const L = r.location as Loc;
  const rows = (r.lines as any[]).map((l) => `<tr><td style="padding:6px 0;vertical-align:top;width:34px;color:#6E6353">${l.qty}×</td>
    <td style="padding:6px 0"><b>${esc(l.name)}</b>${l.option ? ` · ${esc(l.option)}` : ""}${l.mods.length ? `<br><span style="color:#6E6353;font-size:13px">${esc(l.mods.join(", "))}</span>` : ""}${l.note ? `<br><span style="color:#6E6353;font-size:13px">“${esc(l.note)}”</span>` : ""}</td>
    <td style="padding:6px 0;text-align:right;vertical-align:top">${money(l.unit_cents * l.qty)}</td></tr>`).join("");
  const test = r.env === "sandbox";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.5">
  ${test ? `<div style="background:#FDECC8;padding:8px 12px;margin-bottom:14px;font-size:13px"><b>Test order</b> — Square sandbox. No card was charged and the shop won't make this.</div>` : ""}
  <div style="font:700 22px Georgia,serif;letter-spacing:.04em;border-bottom:2px solid #E0A21C;padding-bottom:8px;margin-bottom:18px">GREYS <span style="font:400 12px Arial">Fine Cheeses · ${esc(L.label)}</span></div>
  <p>Thanks, ${esc(cust.first)}! We've got your order.</p>
  <p style="font-size:18px;margin:14px 0"><b>Pickup: ${esc(r.pickup.label)}</b><br><span style="font-size:14px;color:#6E6353">${esc(L.name)} · ${esc(L.address)}, ${esc(L.city)}</span></p>
  <p style="margin:0 0 6px;color:#6E6353;font-size:13px">Order ${esc(r.code)}</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6DCC6;border-bottom:1px solid #E6DCC6">${rows}</table>
  <table style="width:100%;margin-top:8px;font-size:14px">
    <tr><td>Subtotal</td><td style="text-align:right">${money(r.subtotal_cents)}</td></tr>
    <tr><td>Tax</td><td style="text-align:right">${money(r.tax_cents)}</td></tr>
    ${r.tip_cents ? `<tr><td>Tip</td><td style="text-align:right">${money(r.tip_cents)}</td></tr>` : ""}
    <tr><td style="padding-top:6px"><b>Total</b></td><td style="text-align:right;padding-top:6px"><b>${money(r.charged_cents)}</b></td></tr>
  </table>
  ${r.card ? `<p style="color:#6E6353;font-size:13px">Paid with ${esc(r.card)}${r.receipt_url ? ` · <a href="${esc(r.receipt_url)}" style="color:#7C1F15">receipt</a>` : ""}</p>` : ""}
  ${note ? `<p style="font-size:14px">Your note: “${esc(note)}”</p>` : ""}
  <p style="font-size:14px">Need to change something? Call us${L.phone ? ` at <b>${esc(L.phone)}</b>` : ""} or reply to this email.</p></div>`;
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({
      to: cust.email,
      subject: `${test ? "[TEST] " : ""}Your Greys order ${r.code} · pickup ${r.pickup.label}`,
      html,
      from: Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>",
      replyTo: L.email || Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com",
    }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok !== false;
}
// the confirmation for a shipped order: when it ships, where to, the gift note, and keep it cold
async function mailShipConfirmation(r: any, cust: Cust, to: ShipTo, note: string): Promise<boolean> {
  const L = r.location as Loc;
  const rows = (r.lines as any[]).map((l) => `<tr><td style="padding:6px 0;vertical-align:top;width:34px;color:#6E6353">${l.qty}×</td>
    <td style="padding:6px 0"><b>${esc(l.name)}</b>${l.option ? ` · ${esc(l.option)}` : ""}${l.mods.length ? `<br><span style="color:#6E6353;font-size:13px">${esc(l.mods.join(", "))}</span>` : ""}${l.note ? `<br><span style="color:#6E6353;font-size:13px">“${esc(l.note)}”</span>` : ""}</td>
    <td style="padding:6px 0;text-align:right;vertical-align:top">${money(l.unit_cents * l.qty)}</td></tr>`).join("");
  const test = r.env === "sandbox";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.5">
  ${test ? `<div style="background:#FDECC8;padding:8px 12px;margin-bottom:14px;font-size:13px"><b>Test order</b> — Square sandbox. No card was charged and nothing will ship.</div>` : ""}
  <div style="font:700 22px Georgia,serif;letter-spacing:.04em;border-bottom:2px solid #E0A21C;padding-bottom:8px;margin-bottom:18px">GREYS <span style="font:400 12px Arial">Fine Cheeses · Shipped from ${esc(L.label)}</span></div>
  <p>Thanks, ${esc(cust.first)}! We've got your order.</p>
  <p style="font-size:18px;margin:14px 0"><b>${esc(r.ship.label)}</b></p>
  <p style="font-size:14px;margin:0 0 14px"><b>Shipping to</b><br>${esc(to.name)}<br>${esc(to.address1)}${to.address2 ? "<br>" + esc(to.address2) : ""}<br>${esc(to.city)}, ${esc(to.state)} ${esc(to.zip)}</p>
  ${to.gift_note ? `<p style="font-size:14px;margin:0 0 14px"><b>Gift note</b> (we'll tuck it in the box)<br>“${esc(to.gift_note)}”</p>` : ""}
  <p style="margin:0 0 6px;color:#6E6353;font-size:13px">Order ${esc(r.code)}</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6DCC6;border-bottom:1px solid #E6DCC6">${rows}</table>
  <table style="width:100%;margin-top:8px;font-size:14px">
    <tr><td>Subtotal</td><td style="text-align:right">${money(r.subtotal_cents)}</td></tr>
    <tr><td>Shipping</td><td style="text-align:right">${money(r.shipping_cents)}</td></tr>
    ${r.tax_cents ? `<tr><td>Tax</td><td style="text-align:right">${money(r.tax_cents)}</td></tr>` : ""}
    <tr><td style="padding-top:6px"><b>Total</b></td><td style="text-align:right;padding-top:6px"><b>${money(r.charged_cents)}</b></td></tr>
  </table>
  ${r.card ? `<p style="color:#6E6353;font-size:13px">Paid with ${esc(r.card)}${r.receipt_url ? ` · <a href="${esc(r.receipt_url)}" style="color:#7C1F15">receipt</a>` : ""}</p>` : ""}
  ${note ? `<p style="font-size:14px">Your note: “${esc(note)}”</p>` : ""}
  <p style="font-size:14px">It's cheese, so it travels cold: please put the box in the fridge as soon as it arrives. We'll send tracking when it ships.</p>
  <p style="font-size:14px">Need to change something? Call us${L.phone ? ` at <b>${esc(L.phone)}</b>` : ""} or reply to this email.</p></div>`;
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({
      to: cust.email,
      subject: `${test ? "[TEST] " : ""}Your Greys order ${r.code} · ships ${fmtDay(r.ship.ship_on)}`,
      html,
      from: Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>",
      replyTo: L.email || Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com",
    }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok !== false;
}

async function status(b: any) {
  const base = "code, env, location, status, pickup_at, asap, catering, lines, subtotal_cents, tax_cents, tip_cents, total_cents, card, receipt_url, created_at";
  const look = (cols: string) => admin.from("online_orders").select(cols)
    .eq("code", clean(b.code, 12).toUpperCase()).eq("email", clean(b.email, 200).toLowerCase())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  let q = await look(base + ", fulfillment, ship_on, shipping_cents, carrier, tracking_number, tracking_url, shipped_at");
  if (q.error) q = await look(base); // before the shipping columns exist
  return q.data ? { ok: true, order: q.data } : { ok: false, error: "Order not found." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    const text = await req.text();
    if (text.length > 100_000) return json(req, { ok: false, error: "Request too large." }, 413);
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* empty */ }
    if (!body || typeof body !== "object") body = {};
    const action = new URL(req.url).searchParams.get("action") ?? String(body.action ?? "");
    if (action === "menu" || action === "quote" || action === "pay") await refreshSwitch();
    if (action === "menu") return json(req, await menu(req, body));
    if (action === "config") return json(req, { ok: true, ...(await payConfig(shopOf(body.location || "memphis"), envFor(req))) });
    if (action === "quote") return json(req, await quote(req, body));
    if (action === "pay") return json(req, body.ship ? await payShip(req, body) : await pay(req, body));
    if (action === "status") return json(req, await status(body));
    if (action === "sweep") return json(req, await sweep(body));
    if (action === "ship_days" || action === "ship_orders" || action === "ship_mark" || action === "ship_email" || action === "track") await refreshSwitch();
    if (action === "ship_days") return json(req, await shipDays(req));
    if (action === "ship_orders") return json(req, await shipOrdersAction(req, body));
    if (action === "ship_mark") return json(req, await shipMark(req, body));
    if (action === "ship_email") return json(req, await shipEmail(req, body));
    if (action === "track") return json(req, await track(req, body));
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message, ...(e.extra ?? {}) }, e.status);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong on our side and nothing was charged. Please try again, or call the shop (ref ${ref}).` }, 500);
  }
});
