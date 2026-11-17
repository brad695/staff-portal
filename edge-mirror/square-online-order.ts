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
//   test_enabled (2026-11-13): the TEST COPY's own on/off, so staging can show shipping while the live site keeps it
//   off. Not set = the test copy follows enabled. The live function never reads it.
//   rates (v18, 2026-11-14, Maverick: "charge shipping based on their location" → near vs far):
//     { ground_miles: 600, ground: { first_cents, each_cents }, air: { first_cents, each_cents } }
//   The ship-to ZIP decides: its 3-digit area within ground_miles of the from-shop's (as the crow flies, the way UPS
//   draws its zones; 600 = UPS zones 2–4, about 1–2 days by Ground from Memphis) pays the `ground` price and ships UPS
//   Ground; farther pays `air` and ships UPS 2nd Day Air. A ZIP area we don't know takes its state's answer (Ground only
//   if the whole state is). No `rates` = the flat first_cents / each_cents as before. The ZIP must be in the picked
//   state. The service goes on the Square order (metadata.ship_service, and the shipping note staff see when they buy
//   the label). `zones` (public) tells the staff portal which states a distance covers.
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
// TEST COPY: square-online-order-test is staging's copy of this file with TEST_COPY = true — it uses ONE Square
// environment for every request, whatever the Origin: TEST_ENV. Deploy both from this one source.
//   TEST_ENV = "production" since 2026-11-15 (v18.1, Maverick: "take the testing site out of sandbox" — so the owner
//   can try shipping end to end while the live site keeps it off). The test order site then takes REAL cards and
//   makes REAL Square orders (pickups go to the kitchen, ship orders to Orders → Shipments, same as the live site).
//   "sandbox" puts it back on test cards.
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
//   portal isn't the order site) — square-online-order = production, square-online-order-test = TEST_ENV. See staffEnv.
//
// GIFT CARDS (v19, 2026-11-16, Maverick: "anywhere we are taking payments, we need to also take gift cards. make sure
// online ordering especially has it"): a GREYS (Square) gift card pays for a pickup or a shipped order — all of it, or
// all it can with a card or Google Pay for the rest. The number is typed into Square's own gift card field on the page
// (Web Payments SDK giftCard()); this function only ever sees a one-time token.
//   gift_balance { location, nonce } → { balance_cents, last4 }: the page's "Apply" (GiftCards from-nonce).
//   pay { …, gift_source_id, gift_cents }: gift_cents = what the page showed the gift card paying. source_id (the card)
//     is only needed when the gift card doesn't cover everything.
//   WHO PAYS WHAT is giftPlan() — the page has the same function, shows that split, and pay refuses any other:
//     the gift card pays all it can of the order + tip; if that isn't everything the card pays the rest, at least $1.00
//     (Square's smallest card payment), so the gift card holds back up to a dollar. The tip rides on the card as far as
//     the card's share allows and the rest of it on the gift card (Square takes a tip on either).
//   HOW: the gift card covers it all → ONE payment, exactly like a card (autocomplete).
//        gift card + card → both are only AUTHORIZED (autocomplete false; Square lets an authorization go by itself
//        after 30 minutes), then PayOrder captures the two together. If either is refused the other is voided: nothing
//        is charged and no balance stays held.
//   The gift card is asked for exactly what the page showed, never "whatever is on it": if its balance changed in the
//   meantime Square refuses it (INSUFFICIENT_FUNDS + GIFT_CARD_AVAILABLE_AMOUNT) and the customer is told the new
//   balance — nothing is charged.
//   menu.pay.gift_cards tells the page to offer it. Secret ORDER_GIFT_CARDS=off hides it and refuses it (kill switch).
//   online_orders: gift_cents, gift_payment_id, gift_last4 (migration online_orders_gift); `card` reads
//   "Gift card ····1234 $20.00 + VISA ····4242 $12.40". Refunds are made in Square, tender by tender.
//   Tried against the Square sandbox 2026-11-16: a split with the tip on the card, on the gift card and on both; gift
//   card only with a tip; INSUFFICIENT_FUNDS; a voided hold goes back on the gift card.
//
// Actions (POST ?action=…): config · menu · quote · gift_balance · pay · status · sweep · ship_days · ship_orders · ship_mark ·
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
// true only in square-online-order-test (staging's copy, see TEST COPY at the top): always TEST_ENV
const TEST_COPY = false;
// the test copy's Square (v18.1, 2026-11-15): "production" = real cards + real orders, "sandbox" = test cards only
const TEST_ENV: Env = "production";
const envFor = (req: Request): Env =>
  TEST_COPY ? TEST_ENV
  : listEnv("ORDER_LIVE_ORIGINS", LIVE_ORIGINS).includes((req.headers.get("Origin") ?? "").trim().toLowerCase()) ? "production" : "sandbox";
// The staff side (ship list, ship days, tracking) is called from the staff portal and pg_cron, never from the order
// site, so the page's Origin can't pick it: the live function works the live Square orders, the test copy TEST_ENV's (v17.2).
const staffEnv = (): Env => (TEST_COPY ? TEST_ENV : "production");
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
type Service = "ground" | "air";
type Tier = { first_cents: number; each_cents: number };
type Rates = { miles: number; ground: Tier; air: Tier };
type ShipCfg = {
  from: Shop; items: string[]; order_by: string | null; ship_on: string; arrive_from: string | null; arrive_by: string | null;
  first_cents: number; each_cents: number; limit: number; tax_states: string[]; rates: Rates | null;
};
let shipCfg: ShipCfg | null = null;
function parseShip(raw: any): ShipCfg | null {
  if (!raw || typeof raw !== "object") return null;
  const on = TEST_COPY && "test_enabled" in raw ? raw.test_enabled : raw.enabled; // test copy: its own switch (see SHIPPING)
  if (on !== true) return null;
  const day = (k: string) => (DATE_ONLY.test(String(raw[k] ?? "")) ? String(raw[k]) : null);
  const items = (Array.isArray(raw.items) ? raw.items : []).map((x: unknown) => String(x ?? "").trim()).filter((x: string) => /^[A-Z0-9]{8,40}$/.test(x));
  const ship_on = day("ship_on");
  if (!items.length || !ship_on) return null;
  const cents = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 50000 ? Number(v) : d);
  const first = cents(raw.first_cents, 0);
  const taxStates = (Array.isArray(raw.tax_states) ? raw.tax_states : ["TN"]).map((s: unknown) => String(s ?? "").toUpperCase()).filter((s: string) => US_STATES[s]);
  // near vs far (v18): both prices or none (then the flat price)
  const tier = (v: any): Tier | null => {
    const f = Number(v?.first_cents);
    if (!v || typeof v !== "object" || !Number.isInteger(f) || f < 0 || f > 50000) return null;
    return { first_cents: f, each_cents: cents(v.each_cents, f) };
  };
  const r = raw.rates && typeof raw.rates === "object" ? raw.rates : null;
  const g = tier(r?.ground), a = tier(r?.air), mi = Number(r?.ground_miles);
  return {
    from: raw.from === "nashville" ? "nashville" : "memphis", items, order_by: day("order_by"), ship_on,
    arrive_from: day("arrive_from"), arrive_by: day("arrive_by"), first_cents: first, each_cents: cents(raw.each_cents, first),
    limit: Math.max(0, Math.min(100000, Math.floor(Number(raw.limit) || 0))), tax_states: taxStates,
    rates: g && a ? { miles: Number.isFinite(mi) && mi >= 50 && mi <= 3000 ? Math.round(mi) : 600, ground: g, air: a } : null,
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
  detail: Record<string, string> = {}; // code → Square's detail text (GIFT_CARD_AVAILABLE_AMOUNT carries the balance)
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
    err.detail = Object.fromEntries(errs.map((x) => [String(x.code || ""), String(x.detail ?? "")]));
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
  return { env: e, app_id: credsFor(e).appId, location_id, script_src: scriptFor(e), reachable: !!location_id, reach_error, gift_cards: giftOn(), card_fee_pct: feeOn() ? feePct() : 0 };
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
  const disc = Number(o?.total_discount_money?.amount ?? 0), fee = feeOnOrder(o), svc = Number(o?.total_service_charge_money?.amount ?? 0) - fee;
  // the credit card fee (CREDIT CARD FEE) is not part of the order's price: it's added only once the card is known
  return { subtotal_cents: total - fee - tax - svc + disc, tax_cents: tax, discount_cents: disc, total_cents: total - fee };
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
// shipping for this many boxes: the service's price when there are near/far rates, else the flat price
function shipFee(c: ShipCfg, boxes: number, service: Service | null = null) {
  if (boxes <= 0) return 0;
  const p: Tier = c.rates ? c.rates[service ?? "ground"] : c;
  return p.first_cents + (boxes - 1) * p.each_cents;
}
const SERVICE_LABEL: Record<Service, string> = { ground: "UPS Ground", air: "UPS 2nd Day Air" };
// ---- near vs far (rates, v18) ----
// ZIP3 → the average spot of that 3-digit ZIP area and its state(s), lower 48 + DC: "zip3:lat:lon:ST[/ST2]".
// Built 2026-11-14 from the zipcodes 1.2.0 package's USPS list (STANDARD ZIPs; military left out).
const ZIP3_RAW = "005:40.80:-73.04:NY,010:42.27:-72.60:MA,011:42.11:-72.55:MA,012:42.36:-73.22:MA,013:42.59:-72.56:MA,014:42.59:-71.78:MA,015:42.22:-71.84:MA,016:42.27:-71.82:MA,017:42.35:-71.45:MA,018:42.64:-71.21:MA,019:42.61:-70.90:MA,020:42.15:-71.16:MA,021:42.34:-71.07:MA,022:42.35:-71.07:MA,023:42.03:-70.92:MA,024:42.35:-71.21:MA,025:41.61:-70.58:MA,026:41.71:-70.20:MA,027:41.77:-71.08:MA,028:41.67:-71.53:RI,029:41.82:-71.44:RI,030:42.88:-71.51:NH,031:42.99:-71.46:NH,032:43.51:-71.64:NH,033:43.25:-71.55:NH,034:42.92:-72.20:NH,035:44.49:-71.47:NH,036:43.18:-72.34:NH,037:43.73:-72.13:NH,038:43.40:-71.07:NH,039:43.21:-70.72:ME,040:43.75:-70.53:ME,041:43.67:-70.25:ME,042:44.32:-70.39:ME,043:44.30:-69.78:ME,044:45.14:-68.73:ME,045:43.95:-69.56:ME,046:44.57:-67.96:ME,047:46.68:-68.24:ME,048:44.15:-69.11:ME,049:44.79:-69.65:ME,050:43.84:-72.40:VT,051:43.26:-72.63:VT,052:43.03:-73.14:VT,053:42.94:-72.79:VT,054:44.60:-73.04:VT,055:42.65:-71.18:MA,056:44.34:-72.56:VT,057:43.66:-73.04:VT,058:44.68:-72.14:VT,059:44.75:-71.67:VT,060:41.86:-72.81:CT,061:41.76:-72.69:CT,062:41.80:-72.11:CT,063:41.49:-72.05:CT/NY,064:41.42:-72.75:CT,065:41.34:-72.93:CT,066:41.21:-73.19:CT,067:41.64:-73.19:CT,068:41.19:-73.44:CT,069:41.08:-73.54:CT,070:40.76:-74.23:NJ,071:40.75:-74.19:NJ,072:40.67:-74.22:NJ,073:40.72:-74.06:NJ,074:41.05:-74.30:NJ,075:40.92:-74.17:NJ,076:40.93:-74.02:NJ,077:40.32:-74.10:NJ,078:40.94:-74.74:NJ,079:40.74:-74.50:NJ,080:39.83:-74.98:NJ,081:39.93:-75.09:NJ,082:39.26:-74.66:NJ,083:39.44:-75.02:NJ,084:39.34:-74.49:NJ,085:40.27:-74.66:NJ,086:40.20:-74.70:NJ,087:39.99:-74.17:NJ,088:40.54:-74.61:NJ,089:40.48:-74.45:NJ,100:40.76:-73.98:NY,101:40.76:-73.98:NY,102:40.71:-74.01:NY,103:40.59:-74.15:NY,104:40.85:-73.88:NY,105:41.19:-73.77:NY,106:41.03:-73.77:NY,107:40.95:-73.86:NY,108:40.92:-73.79:NY,109:41.25:-74.14:NY,110:40.75:-73.71:NY,111:40.76:-73.93:NY,112:40.66:-73.96:NY,113:40.75:-73.83:NY,114:40.69:-73.79:NY,115:40.71:-73.64:NY,116:40.59:-73.83:NY,117:40.80:-73.24:NY,118:40.77:-73.48:NY,119:40.92:-72.59:NY,120:42.69:-73.97:NY,121:42.71:-73.95:NY,122:42.67:-73.77:NY,123:42.80:-73.94:NY,124:42.11:-74.21:NY,125:41.77:-73.84:NY,126:41.68:-73.88:NY,127:41.70:-74.78:NY,128:43.50:-73.73:NY,129:44.56:-73.89:NY,130:43.00:-76.17:NY,131:43.06:-76.28:NY,132:43.05:-76.15:NY,133:43.15:-75.21:NY,134:43.09:-75.25:NY,135:43.11:-75.20:NY,136:44.31:-75.52:NY,137:42.25:-75.43:NY,138:42.36:-75.56:NY,139:42.13:-75.89:NY,140:42.80:-78.62:NY,141:42.84:-78.68:NY,142:42.91:-78.83:NY,143:43.10:-79.01:NY,144:42.95:-77.64:NY,145:42.94:-77.48:NY,146:43.17:-77.62:NY,147:42.21:-78.85:NY,148:42.30:-77.15:NY,149:42.09:-76.81:NY,150:40.48:-80.07:PA,151:40.42:-79.93:PA,152:40.45:-79.99:PA,153:40.01:-80.20:PA,154:39.95:-79.71:PA,155:39.95:-78.84:PA,156:40.32:-79.52:PA,157:40.76:-79.01:PA,158:41.26:-78.70:PA,159:40.35:-78.87:PA,160:40.90:-79.91:PA,161:41.17:-80.33:PA,162:41.05:-79.38:PA,163:41.55:-79.61:PA,164:41.90:-80.04:PA,165:42.11:-80.07:PA,166:40.46:-78.35:PA,167:41.82:-78.48:PA,168:40.95:-77.99:PA,169:41.82:-77.30:PA,170:40.42:-77.10:PA,171:40.28:-76.85:PA,172:40.03:-77.80:PA,173:39.90:-76.84:PA,174:39.95:-76.72:PA,175:40.04:-76.24:PA,176:40.03:-76.33:PA,177:41.32:-77.14:PA,178:40.88:-76.76:PA,179:40.71:-76.28:PA,180:40.63:-75.47:PA,181:40.60:-75.51:PA,182:40.90:-75.91:PA,183:41.07:-75.26:PA,184:41.56:-75.39:PA,185:41.41:-75.66:PA,186:41.33:-76.07:PA,187:41.24:-75.89:PA,188:41.82:-76.10:PA,189:40.34:-75.15:PA,190:40.01:-75.21:PA,191:40.00:-75.15:PA,192:39.95:-75.16:PA,193:39.93:-75.72:PA,194:40.18:-75.41:PA,195:40.40:-75.87:PA,196:40.34:-75.95:PA,197:39.66:-75.67:DE,198:39.76:-75.56:DE,199:38.83:-75.42:DE,200:38.91:-77.02:DC,201:38.92:-77.59:VA,202:38.89:-77.03:DC,203:38.90:-77.04:DC,204:38.90:-77.04:DC,205:38.89:-77.04:DC/VA,206:38.40:-76.73:MD,207:38.92:-76.80:MD,208:39.12:-77.17:MD,209:39.04:-77.01:MD,210:39.36:-76.55:MD,211:39.41:-76.65:MD,212:39.31:-76.60:MD,214:38.99:-76.50:MD,215:39.56:-79.06:MD,216:38.85:-76.04:MD,217:39.48:-77.48:MD,218:38.28:-75.59:MD,219:39.58:-75.98:MD,220:38.82:-77.26:VA,221:38.78:-77.27:VA,222:38.88:-77.10:VA,223:38.79:-77.09:VA,224:38.07:-76.98:VA,225:38.06:-77.17:VA,226:39.02:-78.23:VA,227:38.48:-78.06:VA,228:38.58:-78.82:VA,229:38.01:-78.61:VA,230:37.62:-77.20:VA,231:37.58:-77.09:VA,232:37.55:-77.48:VA,233:37.45:-75.88:VA,234:37.18:-76.06:VA,235:36.88:-76.27:VA,236:37.10:-76.45:VA,237:36.83:-76.33:VA,238:36.96:-77.43:VA,239:37.00:-78.41:VA,240:37.12:-80.07:VA,241:37.10:-80.12:VA,242:36.86:-82.47:VA,243:36.84:-81.12:VA,244:38.09:-79.32:VA,245:37.14:-79.13:VA,246:37.20:-81.84:VA,247:37.40:-81.18:WV,248:37.49:-81.65:WV,249:37.86:-80.41:WV,250:38.20:-81.49:WV,251:38.24:-81.53:WV,252:38.62:-81.55:WV,253:38.35:-81.63:WV,254:39.41:-78.07:WV,255:38.28:-82.15:WV,256:37.76:-82.06:WV,257:38.39:-82.41:WV,258:37.79:-81.20:WV,259:37.76:-81.04:WV,260:40.14:-80.62:WV,261:39.22:-81.25:WV,262:38.77:-80.06:WV,263:39.17:-80.58:WV,264:39.23:-80.39:WV,265:39.59:-80.12:WV,266:38.48:-80.80:WV,267:39.36:-78.96:WV,268:38.94:-79.03:WV,270:36.26:-80.40:NC,271:36.09:-80.27:NC,272:35.90:-79.68:NC,273:35.93:-79.59:NC,274:36.08:-79.83:NC,275:35.87:-78.60:NC,276:35.83:-78.65:NC,277:35.99:-78.90:NC,278:35.93:-77.40:NC,279:36.21:-76.26:NC,280:35.37:-81.01:NC,281:35.30:-80.75:NC,282:35.21:-80.83:NC,283:34.98:-78.96:NC,284:34.31:-78.23:NC,285:35.00:-77.10:NC,286:36.12:-81.30:NC,287:35.44:-82.74:NC,288:35.59:-82.55:NC,289:35.10:-83.90:NC,290:33.94:-80.85:SC,291:33.88:-80.88:SC,292:34.04:-81.01:SC,293:34.81:-81.92:SC,294:32.98:-80.13:SC,295:34.06:-79.42:SC,296:34.67:-82.57:SC,297:34.86:-80.93:SC,298:33.52:-81.77:SC,299:32.53:-80.92:SC,300:33.87:-84.17:GA,301:34.02:-84.84:GA,302:33.31:-84.46:GA,303:33.80:-84.39:GA,304:32.46:-82.16:GA,305:34.51:-83.73:GA,306:33.89:-83.25:GA,307:34.74:-85.14:GA,308:33.35:-82.37:GA,309:33.44:-82.06:GA,310:32.58:-83.45:GA,311:33.76:-84.40:GA,312:32.84:-83.66:GA,313:31.97:-81.42:GA,314:32.04:-81.11:GA,315:31.33:-82.16:GA,316:31.00:-83.20:GA,317:31.51:-83.86:GA,318:32.53:-84.72:GA,319:32.47:-84.92:GA,320:30.17:-82.19:FL,321:29.29:-81.42:FL,322:30.30:-81.64:FL,323:30.32:-84.27:FL,324:30.51:-85.55:FL,325:30.56:-86.96:FL,326:29.61:-82.48:FL,327:28.78:-81.33:FL,328:28.50:-81.32:FL,329:28.04:-80.62:FL,330:25.80:-80.39:FL,331:25.77:-80.28:FL,332:25.77:-80.22:FL,333:26.13:-80.23:FL,334:26.63:-80.21:FL,335:28.11:-82.27:FL,336:27.99:-82.48:FL,337:27.86:-82.73:FL,338:27.87:-81.70:FL,339:26.70:-81.90:FL,341:26.18:-81.66:FL,342:27.30:-82.42:FL,344:29.02:-82.32:FL,346:28.30:-82.61:FL,347:28.47:-81.59:FL,349:27.31:-80.41:FL,350:33.57:-86.73:AL,351:33.50:-86.64:AL,352:33.51:-86.80:AL,354:33.12:-87.77:AL,355:33.98:-87.67:AL,356:34.69:-87.32:AL,357:34.73:-86.33:AL,358:34.71:-86.62:AL,359:34.30:-85.93:AL,360:32.16:-86.17:AL,361:32.36:-86.28:AL,362:33.55:-85.70:AL,363:31.31:-85.54:AL,364:31.42:-87.03:AL,365:30.90:-87.96:AL,366:30.69:-88.13:AL,367:32.35:-87.37:AL,368:32.60:-85.35:AL,369:32.13:-88.26:AL,370:36.12:-86.86:TN,371:36.07:-86.76:TN,372:36.15:-86.79:TN,373:35.27:-85.37:TN,374:35.05:-85.28:TN,375:35.15:-90.05:TN,376:36.37:-82.34:TN,377:36.13:-83.86:TN,378:36.09:-83.80:TN,379:35.97:-83.98:TN,380:35.49:-89.45:TN,381:35.12:-89.94:TN,382:36.29:-88.70:TN,383:35.60:-88.50:TN,384:35.30:-87.32:TN,385:36.20:-85.42:TN,386:34.60:-89.75:MS,387:33.59:-90.79:MS,388:34.34:-88.61:MS,389:33.80:-89.90:MS,390:32.50:-90.16:MS,391:32.38:-90.17:MS,392:32.31:-90.19:MS,393:32.38:-88.83:MS,394:31.33:-89.31:MS,395:30.46:-89.02:MS,396:31.35:-90.57:MS,397:33.54:-88.90:MS,398:31.34:-84.67:GA,399:33.75:-84.39:GA,400:38.14:-85.31:KY,401:37.86:-86.17:KY,402:38.21:-85.70:KY,403:38.04:-84.16:KY,404:37.49:-84.43:KY,405:38.03:-84.49:KY,406:38.23:-84.90:KY,407:36.95:-84.08:KY,408:36.88:-83.30:KY,409:36.90:-83.71:KY,410:38.79:-84.44:KY,411:38.37:-82.96:KY,412:37.86:-82.71:KY,413:37.57:-83.46:KY,414:37.84:-83.18:KY,415:37.46:-82.34:KY,416:37.50:-82.74:KY,417:37.23:-83.23:KY,418:37.23:-82.87:KY,420:36.89:-88.58:KY,421:36.87:-86.03:KY,422:36.94:-86.99:KY,423:37.46:-87.00:KY,424:37.49:-87.65:KY,425:37.15:-84.72:KY,426:36.80:-84.74:KY,427:37.36:-85.78:KY,430:40.18:-82.90:OH,431:39.71:-82.94:OH,432:39.99:-82.99:OH,433:40.52:-83.42:OH,434:41.44:-83.32:OH,435:41.47:-84.13:OH,436:41.66:-83.57:OH,437:39.84:-81.71:OH,438:40.26:-81.86:OH,439:40.25:-80.84:OH,440:41.53:-81.40:OH,441:41.46:-81.67:OH,442:41.12:-81.60:OH,443:41.08:-81.53:OH,444:41.10:-80.75:OH,445:41.09:-80.66:OH,446:40.68:-81.49:OH,447:40.82:-81.38:OH,448:41.03:-82.75:OH,449:40.74:-82.53:OH,450:39.40:-84.46:OH,451:39.12:-83.94:OH,452:39.17:-84.49:OH,453:39.98:-84.30:OH,454:39.75:-84.17:OH,455:39.93:-83.82:OH,456:38.93:-82.80:OH,457:39.35:-81.76:OH,458:40.82:-84.19:OH,459:39.16:-84.46:OH,460:40.14:-86.05:IN,461:39.64:-86.17:IN,462:39.81:-86.14:IN,463:41.46:-87.17:IN,464:41.57:-87.33:IN,465:41.44:-86.04:IN,466:41.68:-86.26:IN,467:41.19:-85.19:IN,468:41.08:-85.14:IN,469:40.72:-86.10:IN,470:39.16:-85.05:IN,471:38.39:-86.01:IN,472:39.02:-85.75:IN,473:40.09:-85.19:IN,474:39.03:-86.69:IN,475:38.41:-86.99:IN,476:38.16:-87.48:IN,477:38.00:-87.57:IN,478:39.45:-87.30:IN,479:40.46:-87.07:IN,480:42.68:-82.91:MI,481:42.21:-83.49:MI,482:42.37:-83.10:MI,483:42.63:-83.33:MI,484:43.26:-83.28:MI,485:43.02:-83.68:MI,486:43.84:-84.26:MI,487:43.96:-83.55:MI,488:43.01:-84.69:MI,489:42.73:-84.56:MI,490:42.21:-85.56:MI,491:41.89:-86.42:MI,492:42.05:-84.34:MI,493:43.25:-85.53:MI,494:43.29:-86.13:MI,495:42.94:-85.66:MI,496:44.52:-85.61:MI,497:45.56:-84.48:MI,498:46.05:-87.18:MI,499:46.72:-88.87:MI,500:41.62:-93.81:IA,501:41.59:-93.45:IA,502:41.67:-93.59:IA,503:41.60:-93.65:IA,504:43.17:-93.33:IA,505:42.76:-94.44:IA,506:42.64:-92.46:IA,507:42.48:-92.29:IA,508:40.97:-94.55:IA,509:41.60:-93.61:IA,510:42.58:-95.90:IA,511:42.51:-96.39:IA,512:43.25:-96.03:IA,513:43.25:-95.14:IA,514:42.10:-95.07:IA,515:41.46:-95.56:IA,516:40.73:-95.40:IA,520:42.50:-91.00:IA,521:43.15:-91.73:IA,522:41.91:-91.75:IA,523:41.91:-91.71:IA,524:41.99:-91.68:IA,525:40.96:-92.44:IA,526:40.86:-91.44:IA,527:41.64:-90.82:IA,528:41.54:-90.58:IA,530:43.45:-88.21:WI,531:42.78:-88.23:WI,532:43.05:-87.97:WI,534:42.74:-87.83:WI,535:42.95:-89.61:WI,537:43.07:-89.40:WI,538:42.86:-90.75:WI,539:43.61:-89.54:WI,540:45.08:-92.49:WI,541:44.90:-88.24:WI,542:44.62:-87.53:WI,543:44.52:-88.02:WI,544:44.88:-89.81:WI,545:45.91:-89.89:WI,546:43.87:-90.95:WI,547:44.85:-91.58:WI,548:46.00:-91.67:WI,549:44.20:-88.86:WI,550:45.03:-93.02:MN,551:44.95:-93.10:MN,553:44.98:-93.88:MN,554:44.98:-93.31:MN,555:45.02:-93.71:MN,556:47.65:-90.92:MN,557:47.13:-92.74:MN,558:46.81:-92.13:MN,559:43.90:-92.29:MN,560:44.00:-93.95:MN,561:43.91:-95.64:MN,562:45.03:-95.65:MN,563:45.79:-94.69:MN,564:46.56:-94.51:MN,565:46.84:-96.12:MN,566:47.78:-94.42:MN,567:48.37:-96.38:MN,569:38.89:-77.02:DC,570:43.46:-97.02:SD,571:43.54:-96.73:SD,572:45.04:-97.12:SD,573:43.82:-98.40:SD,574:45.34:-98.75:SD,575:43.80:-100.43:SD,576:45.50:-101.43:SD,577:44.12:-103.04:SD,580:46.70:-97.34:ND,581:46.86:-96.84:ND,582:48.23:-97.64:ND,583:48.38:-99.22:ND,584:46.95:-99.02:ND,585:46.79:-100.92:ND,586:46.78:-102.90:ND,587:48.35:-101.58:ND,588:48.26:-103.46:ND,590:45.83:-108.71:MT,591:45.77:-108.53:MT,592:48.35:-105.34:MT,593:46.36:-105.43:MT,594:47.68:-111.01:MT,595:48.52:-109.45:MT,596:46.56:-111.91:MT,597:45.67:-112.24:MT,598:47.02:-114.26:MT,599:48.22:-114.46:MT,600:42.23:-88.01:IL,601:41.98:-88.22:IL,602:42.04:-87.70:IL,603:41.89:-87.80:IL,604:41.52:-87.92:IL,605:41.74:-88.29:IL,606:41.87:-87.67:IL,607:41.96:-87.76:IL,608:41.72:-87.71:IL,609:40.83:-87.95:IL,610:42.21:-89.52:IL,611:42.28:-89.05:IL,612:41.50:-90.32:IL,613:41.32:-89.17:IL,614:40.83:-90.44:IL,615:40.71:-89.68:IL,616:40.70:-89.61:IL,617:40.51:-88.92:IL,618:40.10:-88.13:IL,619:39.67:-88.25:IL,620:39.06:-90.02:IL,622:38.43:-89.80:IL,623:40.01:-91.05:IL,624:39.05:-88.22:IL,625:39.69:-89.22:IL,626:39.86:-89.97:IL,627:39.79:-89.65:IL,628:38.34:-88.69:IL,629:37.54:-88.98:IL,630:38.44:-90.68:MO,631:38.64:-90.30:MO,633:38.97:-91.03:MO,634:39.97:-91.79:MO,635:40.20:-92.60:MO,636:37.66:-90.63:MO,637:37.34:-89.80:MO,638:36.48:-89.83:MO,639:36.86:-90.54:MO,640:39.08:-94.18:MO,641:39.11:-94.55:MO,644:40.11:-94.69:MO,645:39.75:-94.83:MO,646:39.88:-93.56:MO,647:38.09:-94.21:MO,648:36.94:-94.34:MO,649:39.10:-94.58:MO,650:38.45:-92.27:MO,651:38.52:-92.20:MO,652:39.21:-92.39:MO,653:38.74:-93.23:MO,654:37.66:-91.82:MO,655:37.63:-91.94:MO,656:37.06:-93.09:MO,657:37.07:-93.01:MO,658:37.19:-93.29:MO,660:38.90:-95.12:KS,661:39.11:-94.69:KS,662:38.96:-94.71:KS,664:39.40:-96.05:KS,665:39.33:-96.09:KS,666:39.04:-95.70:KS,667:37.61:-95.10:KS,668:38.36:-96.38:KS,669:39.78:-97.71:KS,670:37.53:-97.63:KS,671:37.55:-97.67:KS,672:37.69:-97.33:KS,673:37.22:-95.74:KS,674:38.93:-97.76:KS,675:38.23:-98.85:KS,676:39.36:-99.41:KS,677:39.32:-101.07:KS,678:37.81:-100.63:KS,679:37.19:-101.49:KS,680:41.48:-96.44:NE,681:41.24:-96.03:NE,683:40.46:-96.81:NE,684:40.53:-96.62:NE,685:40.82:-96.68:NE,686:41.48:-97.55:NE,687:42.40:-97.74:NE,688:41.17:-98.92:NE,689:40.34:-98.81:NE,690:40.34:-100.88:NE,691:41.30:-101.57:NE,692:42.65:-100.65:NE,693:42.17:-103.01:NE,700:29.90:-90.21:LA,701:29.99:-90.06:LA,703:29.63:-90.75:LA,704:30.56:-90.25:LA,705:30.22:-92.18:LA,706:30.37:-93.21:LA,707:30.51:-91.18:LA,708:30.45:-91.11:LA,710:32.49:-93.47:LA,711:32.46:-93.76:LA,712:32.57:-92.04:LA,713:31.32:-91.95:LA,714:31.54:-92.83:LA,716:33.62:-91.77:AR,717:33.49:-92.82:AR,718:33.67:-93.83:AR,719:34.40:-93.60:AR,720:34.93:-92.01:AR,721:34.92:-92.16:AR,722:34.74:-92.37:AR,723:35.14:-90.51:AR,724:36.05:-90.75:AR,725:36.02:-91.81:AR,726:36.15:-92.86:AR/MO,727:36.15:-94.17:AR,728:35.28:-93.39:AR,729:35.34:-94.18:AR,730:35.33:-97.76:OK,731:35.47:-97.52:OK,733:30.24:-97.75:TX,734:34.20:-97.14:OK,735:34.51:-98.78:OK,736:35.51:-99.29:OK,737:36.38:-98.12:OK,738:36.47:-99.48:OK,739:36.75:-101.54:OK/TX,740:36.29:-96.15:OK,741:36.14:-95.94:OK,743:36.52:-94.98:OK,744:35.64:-95.40:OK,745:34.65:-95.66:OK,746:36.70:-97.13:OK,747:34.01:-95.55:OK,748:35.22:-96.69:OK,749:35.22:-94.70:OK,750:33.07:-96.78:TX,751:32.53:-96.43:TX,752:32.81:-96.80:TX,753:32.78:-96.81:TX,754:33.37:-95.79:TX,755:33.30:-94.43:TX,756:32.50:-94.62:TX,757:32.29:-95.36:TX,758:31.44:-95.70:TX,759:31.29:-94.32:TX,760:32.65:-97.36:TX,761:32.76:-97.33:TX,762:33.42:-97.30:TX,763:33.80:-98.76:TX,764:32.58:-98.51:TX,765:31.07:-97.53:TX,766:31.74:-97.04:TX,767:31.55:-97.15:TX,768:31.30:-99.35:TX,769:31.38:-100.58:TX,770:29.78:-95.41:TX,772:29.77:-95.36:TX,773:30.29:-95.38:TX,774:29.54:-95.88:TX,775:29.59:-95.05:TX,776:30.16:-94.12:TX,777:30.07:-94.16:TX,778:30.67:-96.30:TX,779:28.97:-96.95:TX,780:28.99:-98.86:TX,781:29.30:-98.02:TX,782:29.47:-98.51:TX,783:27.75:-97.89:TX,784:27.75:-97.42:TX,785:26.28:-98.05:TX,786:30.28:-97.96:TX,787:30.30:-97.77:TX,788:29.35:-99.99:TX,789:29.93:-96.81:TX,790:35.36:-101.57:TX,791:35.21:-101.85:TX,792:34.32:-100.60:TX,793:33.49:-102.13:TX,794:33.57:-101.88:TX,795:32.66:-100.17:TX,796:32.42:-99.78:TX,797:31.84:-102.34:TX,798:31.01:-105.20:TX,799:31.80:-106.38:TX,800:39.80:-104.95:CO,801:39.49:-104.77:CO,802:39.74:-104.98:CO,803:40.01:-105.27:CO,804:39.84:-105.95:CO,805:40.42:-105.16:CO,806:40.34:-104.59:CO,807:40.45:-103.03:CO,808:39.10:-103.78:CO,809:38.85:-104.74:CO,810:37.89:-103.79:CO,811:37.55:-106.23:CO,812:38.53:-106.23:CO,813:37.49:-108.45:CO,814:38.55:-108.02:CO,815:39.09:-108.61:CO,816:39.81:-107.56:CO,820:41.36:-105.06:WY,821:44.57:-110.44:WY,822:42.34:-104.58:WY,823:41.50:-107.04:WY,824:44.34:-108.31:WY,825:43.16:-108.96:WY,826:43.04:-106.57:WY,827:44.40:-104.82:WY,828:44.72:-106.92:WY,829:42.02:-109.90:WY,830:43.65:-110.60:WY,831:42.67:-110.73:WY,832:42.98:-112.50:ID,833:42.79:-114.30:ID,834:44.03:-112.11:ID/WY,835:46.17:-116.29:ID,836:43.86:-116.30:ID,837:43.61:-116.20:ID,838:47.65:-116.55:ID,840:40.57:-111.42:UT,841:40.72:-111.88:UT,842:41.22:-111.97:UT,843:41.67:-112.10:UT,844:41.22:-112.00:UT,845:38.94:-110.20:UT,846:39.69:-111.79:UT,847:37.84:-112.85:UT,850:33.53:-112.09:AZ,851:33.04:-111.53:AZ,852:33.45:-111.80:AZ,853:33.45:-112.72:AZ,855:33.35:-110.23:AZ,856:31.85:-110.47:AZ,857:32.23:-110.96:AZ,859:34.14:-109.69:AZ,860:35.56:-111.43:AZ,863:34.65:-112.25:AZ,864:35.24:-114.22:AZ,865:36.23:-109.50:AZ,870:35.26:-106.67:NM,871:35.11:-106.62:NM,873:35.40:-108.49:NM,874:36.73:-108.13:NM,875:36.09:-105.97:NM,876:32.99:-106.98:NM,877:36.01:-104.90:NM,878:34.05:-107.59:NM,879:32.95:-107.28:NM,880:32.40:-107.43:NM,881:34.22:-103.53:NM,882:32.88:-103.95:NM,883:33.26:-105.62:NM,884:35.69:-103.76:NM,885:31.76:-106.49:TX,889:36.04:-114.98:NV,890:36.50:-115.33:NV,891:36.14:-115.21:NV,893:39.40:-115.68:NV,894:39.55:-119.08:NV,895:39.56:-119.81:NV,897:39.17:-119.74:NV,898:40.98:-115.81:NV,900:34.04:-118.30:CA,901:34.06:-118.25:CA,902:33.94:-118.34:CA,903:33.95:-118.35:CA,904:34.02:-118.49:CA,905:33.84:-118.33:CA,906:33.92:-118.03:CA,907:33.82:-118.17:CA,908:33.79:-118.17:CA,910:34.18:-118.10:CA,911:34.15:-118.13:CA,912:34.17:-118.26:CA,913:34.28:-118.58:CA,914:34.18:-118.46:CA,915:34.19:-118.32:CA,916:34.16:-118.38:CA,917:34.07:-117.83:CA,918:34.08:-118.14:CA,919:32.69:-116.82:CA,920:33.11:-117.07:CA,921:32.79:-117.13:CA,922:33.64:-116.03:CA,923:34.50:-116.97:CA,924:34.14:-117.30:CA,925:33.76:-117.17:CA,926:33.63:-117.78:CA,927:33.74:-117.87:CA,928:33.84:-117.81:CA,930:34.29:-119.11:CA,931:34.46:-119.76:CA,932:35.85:-119.19:CA,933:35.34:-119.04:CA,934:35.25:-120.58:CA,935:35.45:-118.13:CA,936:36.86:-119.70:CA,937:36.77:-119.79:CA,938:36.75:-119.77:CA,939:36.53:-121.62:CA,940:37.46:-122.26:CA,941:37.77:-122.43:CA,942:38.58:-121.49:CA,943:37.43:-122.15:CA,944:37.55:-122.31:CA,945:37.94:-122.06:CA,946:37.80:-122.23:CA,947:37.88:-122.27:CA,948:37.95:-122.33:CA,949:38.09:-122.66:CA,950:37.06:-121.84:CA,951:37.31:-121.85:CA,952:38.10:-120.97:CA,953:37.62:-120.70:CA,954:38.92:-123.09:CA,955:40.71:-123.90:CA,956:38.66:-121.27:CA,957:38.75:-121.01:CA,958:38.58:-121.44:CA,959:39.47:-121.51:CA,960:40.94:-122.29:CA,961:40.19:-120.34:CA,970:45.45:-122.35:OR,971:45.52:-123.39:OR,972:45.52:-122.66:OR,973:44.74:-123.23:OR,974:43.58:-123.41:OR,975:42.40:-123.10:OR,976:42.44:-121.18:OR,977:43.84:-120.58:OR,978:45.20:-118.63:OR,979:43.85:-117.57:OR,980:47.56:-122.13:WA,981:47.60:-122.33:WA,982:48.40:-122.29:WA,983:47.42:-122.65:WA,984:47.21:-122.46:WA,985:46.94:-123.20:WA,986:45.94:-122.45:WA,988:47.91:-119.86:WA,989:46.58:-120.49:WA,990:47.63:-117.45:WA,991:47.81:-118.02:WA,992:47.68:-117.38:WA,993:46.38:-119.00:WA,994:46.17:-117.17:WA";
type Spot = { lat: number; lon: number; states: string[] };
let zip3Map: Map<string, Spot> | null = null;
function zip3s(): Map<string, Spot> {
  if (zip3Map) return zip3Map;
  zip3Map = new Map();
  for (const e of ZIP3_RAW.split(",")) {
    const [z, la, lo, st] = e.split(":");
    zip3Map.set(z, { lat: Number(la), lon: Number(lo), states: st.split("/") });
  }
  return zip3Map;
}
const SHOP_ZIP3: Record<Shop, string> = { memphis: "381", nashville: "372" }; // 38117 and 37209
function milesApart(a: Spot, b: Spot) { // as the crow flies, like UPS zones
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const nearShop = (from: Shop, spot: Spot, miles: number) => { const o = zip3s().get(SHOP_ZIP3[from]); return !!o && milesApart(o, spot) <= miles; };
// what the ship-to ZIP means: Ground or 2nd Day Air (null: no ZIP yet, or a flat price), or a ZIP that isn't in the state
function shipZone(c: ShipCfg, zipIn: unknown, stateIn: unknown): { service: Service | null; problem: string | null } {
  const zip = String(zipIn ?? "").trim(), state = String(stateIn ?? "").trim().toUpperCase();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { service: null, problem: null };
  const spot = zip3s().get(zip.slice(0, 3));
  if (spot && US_STATES[state] && !spot.states.includes(state)) {
    return { service: null, problem: `ZIP code ${zip.slice(0, 5)} isn't in ${US_STATES[state]} — please check the ZIP code and the state.` };
  }
  if (!c.rates) return { service: null, problem: null };
  const miles = c.rates.miles;
  if (spot) return { service: nearShop(c.from, spot, miles) ? "ground" : "air", problem: null };
  // a ZIP area we don't know: Ground only if every known area of that state is
  const inState = [...zip3s().values()].filter((x) => x.states.includes(state));
  return { service: inState.length && inState.every((x) => nearShop(c.from, x, miles)) ? "ground" : "air", problem: null };
}
// the ZIP areas that ship Ground (for the page's own math before the quote comes back); cached per shop + distance
const groundCache: Record<string, string[]> = {};
function groundZip3(c: ShipCfg): string[] {
  if (!c.rates) return [];
  const k = c.from + ":" + c.rates.miles;
  return groundCache[k] ??= [...zip3s().entries()].filter(([, v]) => nearShop(c.from, v, c.rates!.miles)).map(([z]) => z);
}
// which states a distance covers, for the staff portal: whole states, and states with some areas inside
function zones(b: any) {
  const from = shopOf(b.from || "memphis"), mi = Number(b.miles);
  const miles = Number.isFinite(mi) && mi >= 50 && mi <= 3000 ? Math.round(mi) : 600;
  const n: Record<string, [number, number]> = {};
  for (const v of zip3s().values()) {
    const st = v.states[0], near = nearShop(from, v, miles);
    (n[st] ??= [0, 0])[near ? 0 : 1]++;
  }
  const all = Object.keys(n).filter((s) => n[s][0] && !n[s][1]).sort();
  const part = Object.keys(n).filter((s) => n[s][0] && n[s][1]).sort().map((s) => ({ state: s, near: n[s][0], areas: n[s][0] + n[s][1] }));
  return { ok: true, from, miles, all, part };
}
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
    // near vs far (v18): the two prices and the ZIP areas that ship Ground; null = the flat price above
    rates: c.rates ? { miles: c.rates.miles, ground: c.rates.ground, air: c.rates.air, ground_zip3: groundZip3(c) } : null,
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
function buildShipOrder(e: Env, m: Menu, c: ShipCfg, lines: Line[], state: string | null, to: ShipTo | null, cust: Cust | null, locationId: string, code: string, note: string, service: Service | null = null) {
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
    if (service) (order.metadata as Record<string, string>).ship_service = service; // which label to buy (v18)
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
  // near/far rates and no ZIP yet (a quote): no shipping line until the ZIP says which
  const fee = c.rates && !service ? 0 : shipFee(c, lines.reduce((n, l) => n + l.qty, 0), service);
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
        shipping_note: [`SHIP ${fmtLongDay(c.ship_on)}`, service ? SERVICE_LABEL[service] : "", `Online ${code}`, `From ${cust.first} ${cust.last}`.trim(), to.gift_note ? `Gift note: “${to.gift_note}”` : "", note]
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
  const zone = shipZone(c, clean(b.ship?.zip, 10), state); // near/far rates: the ZIP sets the shipping (v18)
  const shipKnown = !c.rates || !!zone.service;
  const order = buildShipOrder(e, m, c, lines, state, null, null, await paymentLocation(c.from, e), "", "", zone.service);
  const d = await square("/v2/orders/calculate", { method: "POST", body: JSON.stringify({ order }) }, e);
  const t = totalsOf(d.order);
  return {
    ok: true, env: e, ...t, shipping_cents: Number(d.order?.total_service_charge_money?.amount ?? 0), state, tax_known: !!state && shipKnown,
    shipping_known: shipKnown, service: zone.service, service_label: zone.service ? SERVICE_LABEL[zone.service] : null, zip_problem: zone.problem,
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
  const gift = readGift(b); // a GREYS gift card pays some or all of it (GIFT CARDS at the top)
  if (!(gift && !sourceId) && !TOKEN_OK.test(sourceId)) throw new PublicError("Please re-enter your card.");
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
  const zone = shipZone(c, to.zip, to.state); // near/far rates (v18)
  if (zone.problem) throw new PublicError(zone.problem + " Nothing was charged.");
  if (c.rates && !zone.service) throw new PublicError("Please check the ZIP code. Nothing was charged.");

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
  const order = buildShipOrder(e, m, c, lines, to.state, to, cust, locationId, code, note, zone.service);
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
  const shipCents = Number(o?.total_service_charge_money?.amount ?? 0) - feeOnOrder(o);
  const charge = t.total_cents; // no tip on a shipped order

  const { data: prior } = await admin.from("online_orders").select("id, status, code, square_payment_id, receipt_url, card, total_cents").eq("square_order_id", o.id).maybeSingle();
  const shipOut = {
    name: to.name, city: to.city, state: to.state, zip: to.zip, ship_on: c.ship_on, arrive_from: c.arrive_from, arrive_by: c.arrive_by,
    label: shipText(c), from: shop, from_label: SHOPS[shop].label,
    service: zone.service, service_label: zone.service ? SERVICE_LABEL[zone.service] : null,
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
    fulfillment: "ship", ship_to: zone.service ? { ...to, service: zone.service } : to, gift_note: to.gift_note || null, shipping_cents: shipCents, ship_on: c.ship_on,
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

  const shippingAddress = {
    address_line_1: to.address1, ...(to.address2 ? { address_line_2: to.address2 } : {}), locality: to.city,
    administrative_district_level_1: to.state, postal_code: to.zip, country: "US",
    first_name: to.name.split(" ")[0], ...(to.name.includes(" ") ? { last_name: to.name.split(" ").slice(1).join(" ") } : {}),
  };
  let pmt: any;
  let gp: GiftPaid | null = null; // set when a gift card paid some or all of it
  let cardFee = 0; // CREDIT CARD FEE
  try {
    if (gift) {
      gp = await payWithGift({
        e, orderId: oid, locationId, code, email, total: charge, tip: 0, gift, sourceId, verificationToken,
        extra: { shipping_address: shippingAddress },
        note: `Online order ${code} · ship to ${to.city}, ${to.state}${wallet ? " · " + wallet : ""}`,
      });
    }
    let fee = 0;
    const p = gp ? { payment: gp.primary } : await chargeCard({
      e, orderId: oid, locationId, key: ("q" + (await sha256hex(oid + "|" + sourceId))).slice(0, 45), sourceId, verificationToken,
      amount: charge, tip: 0, reference: code, email, extra: { shipping_address: shippingAddress },
      note: `Online order ${code} · ship to ${to.city}, ${to.state}${wallet ? " · " + wallet : ""}`,
    }).then((r) => { fee = r.fee; return { payment: r.pmt }; });
    cardFee = fee;
    pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await fail((gift ? "with a gift card — " : "") + (wallet ? wallet + ": " : "") + String((err as Error).message));
    if (err instanceof SquareError && (err.status < 500 || err.codes.length)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const cardLine = pmt.card_details?.card ? `${String(pmt.card_details.card.card_brand || "Card").replace(/_/g, " ")} ····${pmt.card_details.card.last_4}` : null;
  const card = gp ? giftLabel(gp, wallet) : wallet ? (cardLine ? `${wallet} · ${cardLine}` : wallet) : cardLine;
  const receiptUrl: string | null = (gp ? gp.receipt_url : pmt.receipt_url) ?? null;
  const paidRow: Record<string, unknown> = { status: "paid", square_payment_id: pmt.id, receipt_url: receiptUrl, card, error: null, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (cardFee) await admin.from("online_orders").update({ card_fee_cents: cardFee, total_cents: charge + cardFee }).eq("square_order_id", oid).then((r) => r.error && console.error("fee col", r.error.message));
  const pu = await admin.from("online_orders").update(gp ? { ...paidRow, ...giftCols(gp) } : paidRow).eq("square_order_id", oid);
  // the gift card columns aren't there (migration online_orders_gift): still mark it paid
  if (gp && pu.error) await admin.from("online_orders").update(paidRow).eq("square_order_id", oid);
  delete shipCache[e]; // the next menu and packing list count this box
  const out = { ...result({ card, receipt_url: receiptUrl }, null), ...(gp ? giftOut(gp) : {}), ...(cardFee ? { card_fee_cents: cardFee, charged_cents: charge + cardFee } : { card_fee_cents: 0 }) };
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
  service: string; // "ground" | "air" | "" (v18: which label to buy)
};
function shipOrderOf(o: any): ShipOrder | null {
  const f = (o?.fulfillments ?? []).find((x: any) => x?.type === "SHIPMENT");
  if (!o?.id || !f || (o.metadata?.fulfillment !== "ship" && o.source?.name !== "Greys online ordering")) return null;
  const sd = f.shipment_details ?? {}, r = sd.recipient ?? {}, a = r.address ?? {}, md = o.metadata ?? {};
  const tenders: any[] = Array.isArray(o.tenders) ? o.tenders : [];
  // AUTHORIZED = only held (a gift card + card payment in flight, v19): not paid until both are captured
  const good = tenders.filter((t) => !["FAILED", "VOIDED", "AUTHORIZED"].includes(String(t?.card_details?.status ?? "")));
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
    total_cents: total, shipping_cents: Number(o.total_service_charge_money?.amount ?? 0) - feeOnOrder(o), card_fee_cents: feeOnOrder(o), tax_cents: Number(o.total_tax_money?.amount ?? 0),
    fulfillment_uid: String(f.uid ?? ""), fulfillment_state: String(f.state ?? ""),
    carrier: clean(sd.carrier, 40), tracking_number: clean(sd.tracking_number, 60), tracking_url: clean(sd.tracking_url, 300),
    shipped_at: sd.shipped_at ?? null, tracking_emailed: clean(md.tracking_emailed, 40) || null,
    service: md.ship_service === "ground" || md.ship_service === "air" ? md.ship_service : "",
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
  for (const e of [staffEnv()]) { // the test copy: TEST_ENV's orders only
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

// ---------- gift cards (GIFT CARDS at the top) ----------
const giftOn = () => (Deno.env.get("ORDER_GIFT_CARDS") ?? "on").trim().toLowerCase() !== "off";
const TOKEN_OK = /^[A-Za-z0-9_\-:.]{8,400}$/;
const usd = (amount: number) => ({ amount, currency: "USD" });
const MIN_PAY = 100; // Square's smallest card payment is $1.00: neither the gift card nor the card is ever asked for less
const GIFT_OFF = "Gift cards can't be used online right now. Please pay by card.";
const GIFT_NO = "That gift card couldn't be used. Remove it and pay by card, or add it again.";

// Who pays what. total = the order (tax in, no tip) · tip · have = what the gift card can put in.
// null = this gift card can't be used on this order (under $1.00 on it, or the order is too small to split).
// order.html carries the same function (giftPlan): it shows this split, and pay() refuses any other.
type Split = { gift: number; card: number; gAmt: number; gTip: number; cAmt: number; cTip: number };
function giftPlan(total: number, tip: number, have: number): Split | null {
  const grand = total + tip;
  if (!(total >= MIN_PAY) || !(have >= MIN_PAY) || !(tip >= 0)) return null;
  if (have >= grand) return { gift: grand, card: 0, gAmt: total, gTip: tip, cAmt: 0, cTip: 0 };
  const gift = Math.min(have, grand - MIN_PAY), card = grand - gift;
  const cTip = Math.min(tip, card - MIN_PAY), gTip = tip - cTip;
  const s = { gift, card, gAmt: gift - gTip, gTip, cAmt: card - cTip, cTip };
  return s.gAmt >= MIN_PAY && s.cAmt >= MIN_PAY ? s : null;
}

// pay's gift card, if the page sent one: the one-time token and what the page showed it paying
type Gift = { token: string; cents: number };
function readGift(b: any): Gift | null {
  const token = clean(b.gift_source_id, 400);
  if (!token) return null;
  if (!giftOn()) throw new PublicError(GIFT_OFF + " Nothing was charged.", 409);
  const cents = Math.round(Number(b.gift_cents));
  if (!TOKEN_OK.test(token) || !Number.isFinite(cents) || cents < 1) throw new PublicError("That gift card couldn't be read. Please add it again. Nothing was charged.");
  return { token, cents };
}

// the page's "Apply": what's on the gift card they typed into Square's field
async function giftBalance(req: Request, b: any) {
  await rateLimit(req, "ordg", 30);
  if (!giftOn()) throw new PublicError(GIFT_OFF, 409);
  const nonce = clean(b.nonce, 400);
  if (!TOKEN_OK.test(nonce)) throw new PublicError("Enter the gift card number first.");
  const e = envFor(req);
  let gc: any;
  try {
    gc = (await square("/v2/gift-cards/from-nonce", { method: "POST", body: JSON.stringify({ nonce }) }, e))?.gift_card ?? {};
  } catch (err) {
    if (!(err instanceof SquareError) || err.status >= 500) throw err;
    // 401 / 403 = our Square access, not their card: say so in the log, and don't blame the number
    if (err.status === 401 || err.status === 403) {
      console.error("gift balance: Square refused us", err.status, err.codes.join(","));
      throw new PublicError("Gift cards aren't working right now. Please pay by card, or call the shop.", 503);
    }
    throw new PublicError("We couldn't find that gift card. Check the number and try again.", 404);
  }
  if (String(gc.state) !== "ACTIVE") throw new PublicError("That gift card isn't active. Please ask the shop.", 409);
  const balance = Math.round(Number(gc.balance_money?.amount ?? 0));
  if (!(balance > 0)) throw new PublicError("That gift card has no balance left.", 409);
  if (balance < MIN_PAY) throw new PublicError(`That gift card has ${money(balance)} left. Online it needs at least ${money(MIN_PAY)} — it still works in the shop.`, 409);
  return { ok: true, env: e, balance_cents: balance, last4: String(gc.gan ?? "").slice(-4) || null };
}

// Square said no to the gift card: tell the customer why (a balance that changed comes back with the new balance)
function giftRefused(err: unknown, asked: number): unknown {
  if (!(err instanceof SquareError) || !(err.status < 500 || err.codes.length)) return err;
  if (err.codes.includes("INSUFFICIENT_FUNDS")) {
    const left = Math.round(Number(err.detail["GIFT_CARD_AVAILABLE_AMOUNT"]));
    if (Number.isFinite(left) && left >= 0 && left < asked) {
      return new PublicError(`That gift card has ${money(left)} on it now, so the amounts changed. Please review them and place the order again. Nothing was charged.`, 402, { gift_balance_cents: left });
    }
    return new PublicError("That gift card doesn't have enough on it. Remove it and add it again to see its balance. Nothing was charged.", 402, { gift_recheck: true });
  }
  return new PublicError(GIFT_NO + " Nothing was charged.", 402, { gift_recheck: true });
}
const paidState = (p: any) => p?.status === "APPROVED" || p?.status === "COMPLETED";
// let go of authorizations that won't be captured (best effort — Square lets them go itself after 30 minutes)
async function voidPayments(e: Env, ids: (string | null | undefined)[]) {
  for (const id of ids) {
    if (!id) continue;
    try { await square(`/v2/payments/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }, e); }
    catch (err) { console.error("void", id, String((err as Error).message).slice(0, 200)); }
  }
}
// ---------- CREDIT CARD FEE (v20, 2026-11-17) ----------
// Maverick: "we need to be charging the 3% credit card fees online, well everywhere". The registers already add
// Square's own 3% Credit card surcharge (credit cards only — never debit, prepaid or gift cards; not on the tip).
// Square's automatic surcharge doesn't work on online (Web Payments SDK) payments, so online it's done here:
//   1. the card is only HELD (autocomplete false), so Square tells us what kind of card it is (card_type);
//   2. a CREDIT card that isn't prepaid → the held amount goes up by FEE_PCT of the order (tip not included),
//      and the order gets a "Credit card fee (3%)" service charge (TOTAL_PHASE, not taxed, uid "ccfee");
//   3. PayOrder captures it. Debit / prepaid → captured as is, no fee.
// If Square won't raise the hold or take the line, the order is captured WITHOUT the fee (never charged more than
// the customer saw on the page, and never left unpaid). A refused card is voided — nothing charged.
// Gift card payments (with or without a card for the rest) get no fee.
// Secrets: CARD_FEE=off turns it off; CARD_FEE_PCT (default 3, capped at 3 — Visa's limit).
const FEE_UID = "ccfee";
const feeOn = () => (Deno.env.get("CARD_FEE") ?? "on").trim().toLowerCase() !== "off";
const feePct = () => Math.min(3, Math.max(0, Number(Deno.env.get("CARD_FEE_PCT") ?? "3") || 0));
const feeFor = (amount: number) => Math.round(amount * feePct() / 100);
const feeLabel = () => `Credit card fee (${feePct()}%)`;
const isCredit = (p: any) => {
  const c = p?.card_details?.card ?? {};
  return String(c.card_type ?? "") === "CREDIT" && String(c.prepaid_type ?? "") !== "PREPAID";
};
// the fee already on a Square order (0 when none)
const feeOnOrder = (o: any) => ((o?.service_charges ?? []) as any[]).filter((s) => s?.uid === FEE_UID)
  .reduce((n, s) => n + Number(s?.applied_money?.amount ?? s?.amount_money?.amount ?? 0), 0);

// Charge a card for an order: hold → fee if it's a credit card → capture. Returns the captured payment and the fee.
// Throws a SquareError when the card is refused (nothing is left held).
async function chargeCard(o: {
  e: Env; orderId: string; locationId: string; key: string; sourceId: string; verificationToken?: string;
  amount: number; tip: number; reference: string; email: string; note: string; extra?: Record<string, unknown>;
}): Promise<{ pmt: any; fee: number }> {
  const created = await square("/v2/payments", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: o.key, source_id: o.sourceId, verification_token: o.verificationToken || undefined,
      amount_money: usd(o.amount), ...(o.tip > 0 ? { tip_money: usd(o.tip) } : {}),
      location_id: o.locationId, order_id: o.orderId, reference_id: o.reference, buyer_email_address: o.email,
      note: o.note, ...(o.extra ?? {}), autocomplete: false, delay_duration: "PT30M",
    }),
  }, o.e);
  let pmt = created?.payment ?? {};
  if (pmt.status === "COMPLETED") { // a retry of a checkout that already went through
    const ord = (await square(`/v2/orders/${encodeURIComponent(o.orderId)}`, { method: "GET" }, o.e).catch(() => null))?.order;
    return { pmt, fee: feeOnOrder(ord) };
  }
  if (pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  const pid = encodeURIComponent(pmt.id);
  let fee = 0;
  if (feeOn() && isCredit(pmt) && feeFor(o.amount) > 0) {
    const want = feeFor(o.amount);
    let raised = Number(pmt.amount_money?.amount) === o.amount + want;
    try {
      if (!raised) {
        const up = await square(`/v2/payments/${pid}`, { method: "PUT", body: JSON.stringify({
          idempotency_key: ("f" + await sha256hex(pmt.id + "|up|" + want)).slice(0, 45),
          payment: { amount_money: usd(o.amount + want), ...(o.tip > 0 ? { tip_money: usd(o.tip) } : {}) },
        }) }, o.e);
        pmt = up?.payment ?? pmt;
        raised = Number(pmt.amount_money?.amount) === o.amount + want;
      }
      if (raised) {
        const cur = (await square(`/v2/orders/${encodeURIComponent(o.orderId)}`, { method: "GET" }, o.e))?.order;
        if (feeOnOrder(cur) !== want) {
          await square(`/v2/orders/${encodeURIComponent(o.orderId)}`, { method: "PUT", body: JSON.stringify({
            idempotency_key: ("g" + await sha256hex(o.orderId + "|fee|" + want + "|" + cur?.version)).slice(0, 45),
            order: { location_id: o.locationId, version: cur?.version, service_charges: [{
              uid: FEE_UID, name: feeLabel(), amount_money: usd(want), calculation_phase: "TOTAL_PHASE", taxable: false,
            }] },
          }) }, o.e);
        }
        fee = want;
      }
    } catch (err) {
      console.error("card fee", o.orderId, String((err as Error).message).slice(0, 200));
      // couldn't add it everywhere: put the hold back to what the page showed and charge that
      if (Number(pmt.amount_money?.amount) !== o.amount) {
        const down = await square(`/v2/payments/${pid}`, { method: "PUT", body: JSON.stringify({
          idempotency_key: ("h" + await sha256hex(pmt.id + "|down")).slice(0, 45), payment: { amount_money: usd(o.amount) },
        }) }, o.e).catch(() => null);
        if (down?.payment) pmt = down.payment;
      }
      fee = 0;
    }
  }
  try {
    await square(`/v2/orders/${encodeURIComponent(o.orderId)}/pay`, { method: "POST", body: JSON.stringify({
      idempotency_key: ("k" + await sha256hex(o.orderId + "|" + pmt.id + "|" + fee)).slice(0, 45), payment_ids: [pmt.id],
    }) }, o.e);
  } catch (err) {
    // the amounts didn't add up (or Square said no): take the fee back off and capture the order as shown
    console.error("pay order", o.orderId, String((err as Error).message).slice(0, 200));
    if (fee) {
      const cur = (await square(`/v2/orders/${encodeURIComponent(o.orderId)}`, { method: "GET" }, o.e).catch(() => null))?.order;
      if (cur && feeOnOrder(cur)) {
        await square(`/v2/orders/${encodeURIComponent(o.orderId)}`, { method: "PUT", body: JSON.stringify({
          idempotency_key: ("j" + await sha256hex(o.orderId + "|nofee|" + cur.version)).slice(0, 45),
          fields_to_clear: [`service_charges[${FEE_UID}]`], order: { location_id: o.locationId, version: cur.version },
        }) }, o.e).catch(() => null);
      }
      await square(`/v2/payments/${pid}`, { method: "PUT", body: JSON.stringify({
        idempotency_key: ("h" + await sha256hex(pmt.id + "|down")).slice(0, 45), payment: { amount_money: usd(o.amount) },
      }) }, o.e).catch(() => null);
      fee = 0;
      try {
        await square(`/v2/orders/${encodeURIComponent(o.orderId)}/pay`, { method: "POST", body: JSON.stringify({
          idempotency_key: ("k" + await sha256hex(o.orderId + "|" + pmt.id + "|0")).slice(0, 45), payment_ids: [pmt.id],
        }) }, o.e);
      } catch (err2) { await voidPayments(o.e, [pmt.id]); throw err2; }
    } else { await voidPayments(o.e, [pmt.id]); throw err; }
  }
  const done = (await square(`/v2/payments/${pid}`, { method: "GET" }, o.e).catch(() => null))?.payment;
  return { pmt: done ?? { ...pmt, status: "COMPLETED" }, fee };
}

// Did the order's payments get captured? true / false, or null when Square can't be asked right now.
async function orderCaptured(e: Env, orderId: string): Promise<boolean | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const o = (await square(`/v2/orders/${encodeURIComponent(orderId)}`, { method: "GET" }, e))?.order;
      if (!o) return null;
      const live = ((o.tenders ?? []) as any[]).filter((t) => !["FAILED", "VOIDED"].includes(String(t?.card_details?.status ?? "")));
      return live.length > 0 && live.every((t) => String(t?.card_details?.status ?? "") === "CAPTURED");
    } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  return null;
}

// Pay an order with a gift card, and a card for whatever the gift card doesn't cover (HOW at the top).
// Throws with nothing charged and nothing left held; a PublicError is already worded for the customer.
type GiftPaid = { primary: any; giftPay: any; cardPay: any | null; split: Split; last4: string | null; receipt_url: string | null };
async function payWithGift(o: {
  e: Env; orderId: string; locationId: string; code: string; email: string; note: string;
  total: number; tip: number; gift: Gift; sourceId: string; verificationToken: string; extra?: Record<string, unknown>;
}): Promise<GiftPaid> {
  const s = giftPlan(o.total, o.tip, o.gift.cents);
  if (!s || s.gift !== o.gift.cents) {
    throw new PublicError("Your total changed, so the gift card amount did too. Please review it and place the order again. Nothing was charged.", 409, { gift_replan: true });
  }
  const split = s.card > 0;
  if (split && !TOKEN_OK.test(o.sourceId)) {
    throw new PublicError(`Your gift card covers ${money(s.gift)} of ${money(o.total + o.tip)}. Please add a card for the other ${money(s.card)}. Nothing was charged.`, 402);
  }
  const key = async (tag: string, ...parts: (string | number)[]) => (tag + (await sha256hex([o.orderId, ...parts].join("|")))).slice(0, 45);
  const common = { location_id: o.locationId, order_id: o.orderId, reference_id: o.code, buyer_email_address: o.email };
  const hold = { autocomplete: false, delay_duration: "PT30M" }; // held, not charged

  // 1. the gift card: exactly what the page showed
  let g: any;
  try {
    g = (await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: await key("g", o.gift.token, s.gAmt, s.gTip, split ? 2 : 1),
        source_id: o.gift.token,
        amount_money: usd(s.gAmt),
        ...(s.gTip > 0 ? { tip_money: usd(s.gTip) } : {}),
        ...common,
        note: `${o.note} · gift card`,
        ...(split ? hold : { autocomplete: true }),
      }),
    }, o.e))?.payment ?? {};
  } catch (err) { throw giftRefused(err, s.gift); }
  if (!paidState(g)) throw new PublicError(GIFT_NO + " Nothing was charged.", 402, { gift_recheck: true });
  const last4 = String(g.card_details?.card?.last_4 ?? "") || null;
  if (!split) return { primary: g, giftPay: g, cardPay: null, split: s, last4, receipt_url: g.receipt_url ?? null };

  // 2. the card for the rest
  let c: any = null;
  try {
    c = (await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: await key("c", o.sourceId, s.cAmt, s.cTip, g.id),
        source_id: o.sourceId,
        verification_token: o.verificationToken || undefined,
        amount_money: usd(s.cAmt),
        ...(s.cTip > 0 ? { tip_money: usd(s.cTip) } : {}),
        ...common,
        ...(o.extra ?? {}),
        note: o.note,
        ...hold,
      }),
    }, o.e))?.payment ?? {};
    if (!paidState(c)) throw Object.assign(new SquareError("payment " + c?.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await voidPayments(o.e, [c?.id, g.id]);
    throw err;
  }
  // 3. capture the two together
  try {
    await square(`/v2/orders/${encodeURIComponent(o.orderId)}/pay`, {
      method: "POST",
      body: JSON.stringify({ idempotency_key: await key("k", g.id, c.id), payment_ids: [g.id, c.id] }),
    }, o.e);
  } catch (err) {
    // Square may have captured both with only its answer lost: look before letting anything go
    const captured = await orderCaptured(o.e, o.orderId);
    if (captured === false) { await voidPayments(o.e, [c.id, g.id]); throw err; }
    if (captured === null) {
      console.error("gift pay unconfirmed", o.code, o.orderId, String((err as Error).message).slice(0, 300));
      throw new PublicError("We couldn't confirm your payment. Please don't order again yet — call the shop and we'll check it for you.", 502, { unconfirmed: true });
    }
  }
  // No receipt link here: Square only makes one once a payment shows as captured, a few seconds after PayOrder
  // (tried in the sandbox) — the customer has our confirmation email, and the order in Square shows both tenders.
  return { primary: c, giftPay: g, cardPay: c, split: s, last4, receipt_url: null };
}
// how the payment reads on the order, the confirmation and the email
function giftLabel(gp: GiftPaid, wallet: string | null) {
  const g = "Gift card" + (gp.last4 ? " ····" + gp.last4 : "");
  if (!gp.cardPay) return g;
  const cd = gp.cardPay.card_details?.card;
  const line = cd ? `${String(cd.card_brand || "Card").replace(/_/g, " ")} ····${cd.last_4}` : null;
  const c = wallet ? (line ? `${wallet} · ${line}` : wallet) : line ?? "Card";
  return `${g} ${money(gp.split.gift)} + ${c} ${money(gp.split.card)}`;
}
const giftCols = (gp: GiftPaid) => ({ gift_cents: gp.split.gift, gift_payment_id: gp.giftPay?.id ?? null, gift_last4: gp.last4 });
const giftOut = (gp: GiftPaid) => ({ gift_cents: gp.split.gift, card_cents: gp.split.card, gift_last4: gp.last4 });

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
  const gift = readGift(b); // a GREYS gift card pays some or all of it (GIFT CARDS at the top)
  if (!(gift && !sourceId) && !TOKEN_OK.test(sourceId)) throw new PublicError("Please re-enter your card.");
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
  let gp: GiftPaid | null = null; // set when a gift card paid some or all of it
  let cardFee = 0; // CREDIT CARD FEE
  try {
    if (gift) {
      gp = await payWithGift({
        e, orderId: oid, locationId, code, email, total: t.total_cents, tip, gift, sourceId, verificationToken,
        note: `Online order ${code} · ${shop}${wallet ? " · " + wallet : ""}`,
      });
    }
    let fee = 0;
    const p = gp ? { payment: gp.primary } : await chargeCard({
      e, orderId: oid, locationId, key: ("p" + (await sha256hex(oid + "|" + sourceId + "|" + tip))).slice(0, 45), sourceId, verificationToken,
      amount: t.total_cents, tip, reference: code, email,
      note: `Online order ${code} · ${shop}${wallet ? " · " + wallet : ""}`,
    }).then((r) => { fee = r.fee; return { payment: r.pmt }; });
    cardFee = fee;
    pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await fail((gift ? "with a gift card — " : "") + (wallet ? wallet + ": " : "") + String((err as Error).message));
    if (err instanceof SquareError && (err.status < 500 || err.codes.length)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const cardLine = pmt.card_details?.card ? `${String(pmt.card_details.card.card_brand || "Card").replace(/_/g, " ")} ····${pmt.card_details.card.last_4}` : null;
  const card = gp ? giftLabel(gp, wallet) : wallet ? (cardLine ? `${wallet} · ${cardLine}` : wallet) : cardLine;
  const receiptUrl: string | null = (gp ? gp.receipt_url : pmt.receipt_url) ?? null;
  const paidRow: Record<string, unknown> = { status: "paid", square_payment_id: pmt.id, receipt_url: receiptUrl, card, error: null, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (cardFee) await admin.from("online_orders").update({ card_fee_cents: cardFee, total_cents: charge + cardFee }).eq("square_order_id", oid).then((r) => r.error && console.error("fee col", r.error.message));
  const pu = await admin.from("online_orders").update(gp ? { ...paidRow, ...giftCols(gp) } : paidRow).eq("square_order_id", oid);
  // the gift card columns aren't there (migration online_orders_gift): still mark it paid
  if (gp && pu.error) await admin.from("online_orders").update(paidRow).eq("square_order_id", oid);
  const out = { ...result({ card, receipt_url: receiptUrl }, null), ...(gp ? giftOut(gp) : {}), ...(cardFee ? { card_fee_cents: cardFee, charged_cents: charge + cardFee } : { card_fee_cents: 0 }) };
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
    ${r.card_fee_cents ? `<tr><td>${esc(feeLabel())}</td><td style="text-align:right">${money(r.card_fee_cents)}</td></tr>` : ""}
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
    <tr><td>Shipping${r.ship?.service_label ? ` · ${esc(r.ship.service_label)}` : ""}</td><td style="text-align:right">${money(r.shipping_cents)}</td></tr>
    ${r.tax_cents ? `<tr><td>Tax</td><td style="text-align:right">${money(r.tax_cents)}</td></tr>` : ""}
    ${r.card_fee_cents ? `<tr><td>${esc(feeLabel())}</td><td style="text-align:right">${money(r.card_fee_cents)}</td></tr>` : ""}
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
    if (action === "gift_balance") return json(req, await giftBalance(req, body));
    if (action === "status") return json(req, await status(body));
    if (action === "sweep") return json(req, await sweep(body));
    if (action === "ship_days" || action === "ship_orders" || action === "ship_mark" || action === "ship_email" || action === "track") await refreshSwitch();
    if (action === "ship_days") return json(req, await shipDays(req));
    if (action === "ship_orders") return json(req, await shipOrdersAction(req, body));
    if (action === "ship_mark") return json(req, await shipMark(req, body));
    if (action === "ship_email") return json(req, await shipEmail(req, body));
    if (action === "track") return json(req, await track(req, body));
    if (action === "zones") return json(req, zones(body)); // near/far coverage for the staff portal (v18)
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message, ...(e.extra ?? {}) }, e.status);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong on our side and nothing was charged. Please try again, or call the shop (ref ${ref}).` }, 500);
  }
});
