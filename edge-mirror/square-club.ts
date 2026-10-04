// square-club — the GREYS Cheese Club on Square Subscriptions (club.html on the ticket site).
//
// A MEMBERSHIP is one Square subscription, billed on the 1st of every month to a card on file.
//   Join on/before this month's order deadline (the Wednesday a week before pickup)
//     → this month's box is charged right away (Orders + Payments API, on the card just saved)
//       and the subscription starts on the 1st of next month.
//   Join after the deadline → nothing is charged today; the subscription starts on the 1st of
//       next month and that first charge buys next month's box.
//   Pickup only (v1): Memphis or Nashville, second Wednesday of the month or later that week.
//   Clubs come from cc_clubs (the console's club editor). cc_clubs.shops limits where a club is
//   offered (the wine clubs are Memphis only) and cc_clubs.age_21 asks for a 21+ confirmation.
//
// SQUARE: one subscription plan ("Greys Cheese Club") with a MONTHLY, RELATIVE-priced plan
//   variation per club (billing anchor = the 1st, no proration). Every subscription carries a
//   DRAFT order template holding the club's catalog item, so price and tax come from the item.
//   ?action=setup creates/updates those catalog objects; club_square_catalog keeps their ids.
//
// ENV: SQUARE_CLUB_ENV  sandbox (default) | production
//   sandbox    → SQUARE_CLUB_SANDBOX_* if set, else the SQUARE_EXP_SANDBOX_* test app (one test
//                location stands in for both shops)
//   production → the live SQUARE_TICKET_* app; charged at the member's pickup shop.
//   Shop addresses and hours always come from the LIVE Square locations (read only).
//
// TABLES: club_members (one row per subscription) · club_boxes (one per member per month) ·
//   club_square_catalog · club_links (sha-256 of magic-link tokens) · club_log. Sandbox rows stay
//   in these tables only, so tests never reach the console roster or pickup reminders.
//
// Actions (POST ?action=…), verify_jwt = false:
//   public : config · join · manage_link
//   member : manage · act (skip | pause | resume | cancel | undo) · card     ← magic-link token
//   staff  : setup · sync · members      ← app_secrets.cc_cron_secret, or a manager's session
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const SQUARE_VERSION = "2025-01-23";
const TZ = "America/Chicago";
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DEFAULT_ORIGIN = "https://tickets.greyscheese.com";
const PLAN_NAME = "Greys Cheese Club";
const SOURCE = "Greys Cheese Club";
// Production objects that already exist (made in the Square dashboard 2026-08-03): the "Cheese Club"
// plan and the $59 "Only Rinds" item it was set up for. setup reuses them instead of duplicating.
const PROD_PLAN_ID = "WEZGLAQZHWT4D6CE2XDAYQAK";
const PROD_ITEMS: Record<string, string> = { "only-rinds": "NGPCOPYIVQNZ3X3MWIVFQI3J" };
const WELCOME_LINK_DAYS = 30, MANAGE_LINK_DAYS = 7;

type Shop = "memphis" | "nashville";
type Env = "production" | "sandbox";
const SHOPS: Record<Shop, { label: string; square: string }> = {
  memphis: { label: "Memphis", square: "LCXWZ0HAQ69RM" },
  nashville: { label: "Nashville", square: "LJ33VDYHS1JAR" },
};

// ---------- environment ----------
const env = (): Env => (Deno.env.get("SQUARE_CLUB_ENV") ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
const credsFor = (e: Env) => e === "production"
  ? { token: Deno.env.get("SQUARE_TICKET_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_ACCESS_TOKEN"), appId: Deno.env.get("SQUARE_TICKET_APP_ID") ?? null, location: null as string | null }
  : {
    token: Deno.env.get("SQUARE_CLUB_SANDBOX_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN"),
    appId: Deno.env.get("SQUARE_CLUB_SANDBOX_APP_ID") ?? Deno.env.get("SQUARE_EXP_SANDBOX_APP_ID") ?? null,
    location: Deno.env.get("SQUARE_CLUB_SANDBOX_LOCATION_ID") ?? Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? null,
  };
const baseFor = (e: Env) => e === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
const scriptFor = (e: Env) => e === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
const paused = () => /^(1|true|yes|all)$/i.test(Deno.env.get("CLUB_PAUSED") ?? "");

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

function originOk(origin: string) {
  return /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
}
function corsFor(req: Request) {
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
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

async function square(path: string, init: RequestInit = {}, e: Env = env()): Promise<any> {
  const { token } = credsFor(e);
  if (!token) throw new Error(`Square ${e} access token is not set`);
  const res = await fetch(baseFor(e) + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs: any[] = Array.isArray(data?.errors) ? data.errors : [];
    const err = new SquareError(errs.length ? errs.map((x) => `${x.code}: ${x.detail || ""}`).join("; ") : `Square error (${res.status})`);
    err.status = res.status;
    err.codes = errs.map((x) => String(x.code || ""));
    throw err;
  }
  return data;
}
const post = (path: string, body: unknown, e: Env) => square(path, { method: "POST", body: JSON.stringify(body) }, e);

// ---------- small helpers ----------
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const tidy = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const money = (c: number) => "$" + (c / 100).toFixed(2);
const nowIso = () => new Date().toISOString();
const shopOf = (v: unknown): Shop => {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "memphis" || s === "nashville") return s;
  throw new PublicError("Pick Memphis or Nashville.");
};
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function fmtPhone(p: unknown) {
  const d = String(p ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (String(p ?? "") || null);
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
const codeFrom = (hex: string) => "C" + [0, 1, 2, 3, 4].map((i) => ALPHA[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32]).join("");
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cardLabel(c: any) {
  if (!c) return null;
  const brand = String(c.card_brand || "Card").toUpperCase();
  const pretty: Record<string, string> = { VISA: "Visa", MASTERCARD: "Mastercard", AMERICAN_EXPRESS: "Amex", DISCOVER: "Discover", DISCOVER_DINERS: "Diners", JCB: "JCB", CHINA_UNIONPAY: "UnionPay" };
  return `${pretty[brand] ?? brand.replace(/_/g, " ")} ····${c.last_4 ?? c.last4 ?? ""}`.trim();
}

// ---------- calendar (the shops keep Central time) ----------
function zparts(ms: number, tz = TZ) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, dow: DOW.indexOf(String(p.weekday).toUpperCase().slice(0, 3)) };
}
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function todayCT() { const p = zparts(Date.now()); return { y: p.y, m: p.m, d: p.d, iso: ymd(p.y, p.m, p.d) }; }
function addMonths(y: number, m: number, k: number) { const t = y * 12 + (m - 1) + k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
const firstOfNext = (iso: string) => { const [y, m] = iso.split("-").map(Number); const n = addMonths(y, m, 1); return ymd(n.y, n.m, 1); };
const monthOf = (iso: string) => iso.slice(0, 7) + "-01";
function secondWednesday(y: number, m: number) {
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((3 - dow + 7) % 7) + 7;
}
const fmtD = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...o });
const longDay = (iso: string) => fmtD(iso, { weekday: "long", month: "long", day: "numeric" }); // Wednesday, October 14
const shortDay = (iso: string) => fmtD(iso, { weekday: "short", month: "short", day: "numeric" }); // Wed, Oct 14
const monthName = (iso: string) => fmtD(iso, { month: "long" });
const monthYear = (iso: string) => fmtD(iso, { month: "long", year: "numeric" });

type Cohort = { month: string; pickup: string; deadline: string; open: boolean };
async function cohort(y: number, m: number): Promise<Cohort> {
  const month = ymd(y, m, 1), today = todayCT().iso;
  const { data } = await admin.from("cc_cohorts").select("order_deadline, fulfillment_day, status").eq("month", month).maybeSingle();
  if (data?.fulfillment_day && data?.order_deadline) {
    return { month, pickup: String(data.fulfillment_day), deadline: String(data.order_deadline), open: data.status === "open" && today <= String(data.order_deadline) };
  }
  const wd = secondWednesday(y, m);
  const deadline = new Date(Date.UTC(y, m - 1, wd - 7)).toISOString().slice(0, 10);
  return { month, pickup: ymd(y, m, wd), deadline, open: today <= deadline };
}
const cohortOf = (iso: string) => { const [y, m] = iso.split("-").map(Number); return cohort(y, m); };
const boxLabels = (c: Cohort) => ({ month: c.month, month_label: monthName(c.month), pickup: c.pickup, pickup_label: longDay(c.pickup), pickup_short: shortDay(c.pickup) });

async function schedule() {
  const t = todayCT();
  const cur = await cohort(t.y, t.m);
  const n = addMonths(t.y, t.m, 1);
  const next = await cohort(n.y, n.m);
  const start = ymd(n.y, n.m, 1); // every membership renews on the 1st
  const chargeNow = cur.open;
  return { today: t.iso, charge_now: chargeNow, this_month: cur, next_month: next, first_box: chargeNow ? cur : next, start_date: start };
}

// ---------- clubs ----------
type Club = {
  id: string; slug: string; name: string; tagline: string; description: string; inside: string[]; price_cents: number;
  badge: string | null; image_url: string | null; shops: Shop[]; age_21: boolean; sort: number;
};
async function loadClubs(): Promise<Club[]> {
  const { data, error } = await admin.from("cc_clubs")
    .select("id, slug, name, tagline, description, whats_inside, monthly_price_cents, badge, image_url, shops, age_21, sort_order, active")
    .eq("active", true).order("sort_order");
  if (error) throw new Error("cc_clubs: " + error.message);
  return (data ?? []).map((c: any) => ({
    id: c.id, slug: c.slug, name: tidy(c.name), tagline: tidy(c.tagline),
    // where a club is offered is shown from `shops`, so drop the old "Available in …" sentences
    description: tidy(String(c.description ?? "").replace(/\s*Available (?:in|at) [^.]*\.?/gi, " ")),
    inside: String(c.whats_inside ?? "").split(/\s*,\s*/).map(tidy).filter(Boolean),
    price_cents: Number(c.monthly_price_cents) || 0, badge: c.badge ? tidy(c.badge) : null,
    image_url: /^https:\/\//.test(String(c.image_url ?? "")) ? String(c.image_url) : null,
    shops: ((c.shops ?? ["memphis", "nashville"]) as string[]).map((s) => s.toLowerCase()).filter((s): s is Shop => s === "memphis" || s === "nashville"),
    age_21: !!c.age_21, sort: Number(c.sort_order) || 0,
  })).filter((c) => c.shops.length && c.price_cents > 0);
}
type Cat = { club_id: string; item_id: string; item_variation_id: string; plan_id: string; plan_variation_id: string; price_cents: number; tax_ids: string[] };
async function catalogFor(e: Env): Promise<Map<string, Cat>> {
  const { data } = await admin.from("club_square_catalog").select("*").eq("env", e);
  return new Map((data ?? []).map((r: any) => [r.club_id, { ...r, tax_ids: r.tax_ids ?? [] }]));
}

// ---------- shops (live Square locations: address, phone, hours) ----------
type Loc = { key: Shop; label: string; name: string; address: string; city: string; phone: string | null; email: string | null; hours: { d: number; open: number; close: number }[] };
let LOCS: { at: number; v: Record<Shop, Loc> } | null = null;
const hm = (t: unknown) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
async function shops(): Promise<Record<Shop, Loc>> {
  if (LOCS && Date.now() - LOCS.at < 10 * 60_000) return LOCS.v;
  const out = {} as Record<Shop, Loc>;
  for (const key of Object.keys(SHOPS) as Shop[]) {
    let L: any = {};
    try { L = (await square(`/v2/locations/${SHOPS[key].square}`, {}, "production"))?.location ?? {}; } catch (e) { console.error("location", key, e); }
    const a = L.address ?? {};
    out[key] = {
      key, label: SHOPS[key].label,
      name: /greys/i.test(String(L.name ?? "")) ? tidy(L.name) : `Greys ${SHOPS[key].label}`,
      address: [a.address_line_1, a.address_line_2].filter(Boolean).join(", "),
      city: a.locality ? `${a.locality}, ${a.administrative_district_level_1 ?? ""} ${String(a.postal_code ?? "").slice(0, 5)}`.trim() : "",
      phone: fmtPhone(L.phone_number), email: L.business_email ?? null,
      hours: (L.business_hours?.periods ?? []).map((p: any) => ({ d: DOW.indexOf(String(p.day_of_week)), open: hm(p.start_local_time), close: hm(p.end_local_time) }))
        .filter((h: any) => h.d >= 0 && h.close > h.open).sort((x: any, y: any) => x.d - y.d || x.open - y.open),
    };
  }
  if (Object.values(out).some((l) => l.address)) LOCS = { at: Date.now(), v: out };
  return out;
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

// what one month costs (Square's own math when the item carries a tax)
const AMT = new Map<string, { at: number; cents: number }>();
async function monthlyCents(e: Env, cat: Cat, shop: Shop): Promise<number> {
  if (!cat.tax_ids.length) return cat.price_cents;
  const key = `${e}|${cat.item_variation_id}|${shop}`, hit = AMT.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.cents;
  const loc = await paymentLocation(shop, e);
  const d = await post("/v2/orders/calculate", { order: boxOrder(cat, loc, null, "", "") }, e);
  const cents = Number(d?.order?.total_money?.amount ?? cat.price_cents);
  AMT.set(key, { at: Date.now(), cents });
  return cents;
}

function boxOrder(cat: Cat, locationId: string, customerId: string | null, code: string, note: string) {
  const o: Record<string, unknown> = {
    location_id: locationId,
    source: { name: SOURCE },
    line_items: [{ uid: "box", catalog_object_id: cat.item_variation_id, quantity: "1", ...(note ? { note: note.slice(0, 500) } : {}) }],
  };
  if (customerId) o.customer_id = customerId;
  if (code) { o.reference_id = code; o.metadata = { club_code: code }; }
  if (cat.tax_ids.length) o.taxes = cat.tax_ids.map((t, i) => ({ uid: "t" + i, catalog_object_id: t, scope: "ORDER" }));
  return o;
}

// ---------- config ----------
let CFG: { at: number; e: Env; v: any } | null = null;
async function config() {
  const e = env();
  if (CFG && CFG.e === e && Date.now() - CFG.at < 60_000) return { ...CFG.v, calendar: await calendar() };
  const [clubs, cat, locs] = await Promise.all([loadClubs(), catalogFor(e), shops()]);
  let location_id: string | null = null, reach_error: string | null = null;
  try { location_id = await paymentLocation("memphis", e); } catch (err) { reach_error = String((err as Error).message).slice(0, 300); }
  const out = [];
  for (const c of clubs) {
    const k = cat.get(c.id);
    let amount = k ? k.price_cents : c.price_cents;
    if (k?.tax_ids.length) { try { amount = await monthlyCents(e, k, c.shops[0]); } catch (err) { console.error("calc", c.slug, err); } }
    out.push({
      slug: c.slug, name: c.name, tagline: c.tagline, description: c.description, inside: c.inside, badge: c.badge, image_url: c.image_url,
      shops: c.shops, age_21: c.age_21, price_cents: k ? k.price_cents : c.price_cents, monthly_cents: amount, taxed: !!k?.tax_ids.length,
      available: !!k && !paused(),
    });
  }
  const v = {
    ok: true, env: e, accepting: !paused() && out.some((c) => c.available), paused_message: paused() ? "Cheese Club sign-ups are paused right now. Please check back soon." : null,
    clubs: out, shops: locs,
    pay: { app_id: credsFor(e).appId, location_id, script_src: scriptFor(e), reachable: !!location_id, reach_error },
  };
  CFG = { at: Date.now(), e, v };
  return { ...v, calendar: await calendar() };
}
async function calendar() {
  const s = await schedule();
  return {
    today: s.today, charge_now: s.charge_now,
    this_month: { ...boxLabels(s.this_month), deadline: s.this_month.deadline, deadline_label: longDay(s.this_month.deadline), open: s.this_month.open },
    first_box: boxLabels(s.first_box),
    start_date: s.start_date, start_label: longDay(s.start_date), start_short: shortDay(s.start_date),
  };
}

// ---------- Square: customer, card, refunds ----------
async function findOrCreateCustomer(e: Env, c: { first: string; last: string; email: string; phone: string | null }, code: string) {
  const s = await post("/v2/customers/search", { query: { filter: { email_address: { exact: c.email } } }, limit: 1 }, e);
  const hit = (s?.customers ?? [])[0];
  if (hit?.id) return String(hit.id);
  const body: Record<string, unknown> = {
    idempotency_key: "cu-" + (await sha256hex(e + "|" + c.email)).slice(0, 40),
    given_name: c.first, email_address: c.email, reference_id: code, note: "Cheese Club",
  };
  if (c.last) body.family_name = c.last;
  if (c.phone) body.phone_number = c.phone;
  try {
    return String((await post("/v2/customers", body, e)).customer.id);
  } catch (err) {
    if (!c.phone) throw err;
    delete body.phone_number; // a phone Square won't take shouldn't block the signup
    body.idempotency_key = String(body.idempotency_key).slice(0, 40) + "-np";
    return String((await post("/v2/customers", body, e)).customer.id);
  }
}
async function saveCard(e: Env, customerId: string, sourceId: string, vt: string, name: string, code: string, attempt: string) {
  const d = await post("/v2/cards", {
    idempotency_key: "cd-" + (await sha256hex(attempt + "|" + sourceId)).slice(0, 40),
    source_id: sourceId,
    ...(vt ? { verification_token: vt } : {}),
    card: { customer_id: customerId, ...(name ? { cardholder_name: name.slice(0, 96) } : {}), reference_id: code },
  }, e);
  if (!d?.card?.id) throw new Error("Square did not return a card");
  return d.card;
}
async function disableCard(e: Env, cardId: string | null | undefined) {
  if (!cardId) return;
  try { await post(`/v2/cards/${encodeURIComponent(cardId)}/disable`, {}, e); } catch (err) { console.error("disable card", cardId, err); }
}
function cardMessage(err: unknown) {
  const codes = err instanceof SquareError ? err.codes : [];
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  if (has("CVV_FAILURE", "INVALID_CVV")) return "The security code didn't match. Please check it and try again.";
  if (has("ADDRESS_VERIFICATION_FAILURE", "INVALID_POSTAL_CODE")) return "The billing ZIP didn't match. Please check it and try again.";
  if (has("INVALID_EXPIRATION", "INVALID_EXPIRATION_DATE", "INVALID_EXPIRATION_YEAR", "EXPIRATION_FAILURE", "CARD_EXPIRED")) return "Please check the card's expiration date.";
  if (has("INSUFFICIENT_FUNDS")) return "The card was declined for insufficient funds.";
  if (has("INVALID_CARD", "INVALID_CARD_DATA", "INVALID_ACCOUNT", "CARD_NOT_SUPPORTED", "UNSUPPORTED_CARD_BRAND")) return "That card can't be used. Please try another card.";
  if (has("CARD_DECLINED", "GENERIC_DECLINE", "CARD_DECLINED_CALL_ISSUER", "CARD_DECLINED_VERIFICATION_REQUIRED", "TRANSACTION_LIMIT", "VOICE_FAILURE", "PAN_FAILURE", "ALLOWABLE_PIN_TRIES_EXCEEDED", "BAD_EXPIRATION")) {
    return "The card was declined. Please try another card.";
  }
  if (has("CARD_TOKEN_USED", "CARD_TOKEN_EXPIRED", "SOURCE_USED", "INVALID_SOURCE_ID")) return "Please re-enter your card and try again.";
  return "We couldn't use that card. Please try again or use another card.";
}
const cardProblem = (err: unknown) => err instanceof SquareError && err.status >= 400 && err.status < 500;

// ---------- rate limiting ----------
async function rateLimit(req: Request, bucket: string, limit: number, key?: string) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { data, error } = await admin.rpc("ticket_rate_hit", { p_bucket: (bucket + ":" + (key ?? ip)).slice(0, 200), p_limit: limit, p_window_secs: 3600 });
  if (!error && data === false) throw new PublicError("Too many tries. Please wait a bit, or call the shop.", 429);
}
async function log(memberId: string | null, actor: string, action: string, detail?: unknown) {
  const { error } = await admin.from("club_log").insert({ member_id: memberId, actor, action, detail: detail ?? null });
  if (error) console.error("club_log", error.message);
}

// ---------- magic links ----------
function siteOrigin(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return o && originOk(o) ? o : DEFAULT_ORIGIN;
}
async function newLink(email: string, e: Env, days: number) {
  const token = randomToken();
  const { error } = await admin.from("club_links").insert({
    token_hash: await sha256hex(token), email: email.toLowerCase(), env: e, expires_at: new Date(Date.now() + days * 86400000).toISOString(),
  });
  if (error) throw new Error("club_links: " + error.message);
  return token;
}
async function linkAuth(b: any): Promise<{ email: string; env: Env }> {
  const tok = clean(b.token, 200);
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(tok)) throw new PublicError("This link isn't valid. Ask for a new one below.", 401, { relink: true });
  const h = await sha256hex(tok);
  const { data } = await admin.from("club_links").select("email, env, expires_at, uses").eq("token_hash", h).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) throw new PublicError("This link has expired. Ask for a new one below.", 401, { relink: true });
  await admin.from("club_links").update({ last_used_at: nowIso(), uses: Number(data.uses || 0) + 1 }).eq("token_hash", h);
  return { email: String(data.email), env: data.env as Env };
}

// ---------- join ----------
async function join(req: Request, b: any) {
  await rateLimit(req, "club-join", 12);
  if (paused()) throw new PublicError("Cheese Club sign-ups are paused right now. Please check back soon.", 409);
  const e = env();
  const clubs = await loadClubs();
  const club = clubs.find((c) => c.slug === clean(b.club, 80));
  if (!club) throw new PublicError("Please pick a club.");
  const shop = shopOf(b.shop);
  if (!club.shops.includes(shop)) throw new PublicError(`${club.name} is picked up in ${club.shops.map((s) => SHOPS[s].label).join(" or ")} only.`);
  const c = b.customer ?? {};
  const first = clean(c.first_name, 60), last = clean(c.last_name, 60);
  const email = clean(c.email, 200).toLowerCase();
  const digits = clean(c.phone, 40).replace(/\D/g, "");
  if (!first) throw new PublicError("Please add your name.");
  if (!validEmail(email)) throw new PublicError("Please check your email address.");
  if (digits.length < 10) throw new PublicError("Please add a mobile number so we can reach you about pickup.");
  const bday = clean(c.birthday, 10);
  let birthday: string | null = null;
  if (bday) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bday) || Number.isNaN(Date.parse(bday + "T12:00:00Z"))) throw new PublicError("Please check your birthday.");
    birthday = bday;
  }
  if (club.age_21) {
    if (b.age_21 !== true) throw new PublicError(`${club.name} includes wine, so please confirm you're 21 or older.`);
    if (birthday) {
      const t = todayCT(), [by, bm, bd] = birthday.split("-").map(Number);
      const age = t.y - by - ((t.m < bm || (t.m === bm && t.d < bd)) ? 1 : 0);
      if (age < 21) throw new PublicError(`${club.name} includes wine and is for members 21 and older.`);
    }
  }
  if (b.agree !== true) throw new PublicError("Please agree to the monthly charge to join.");
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("Please re-enter your card.");
  const vt = clean(b.verification_token, 4000);
  const cat = (await catalogFor(e)).get(club.id);
  if (!cat) throw new PublicError("That club isn't open for sign-ups yet. Please call the shop.", 409);

  const sched = await schedule();
  const debugToday = e === "sandbox" && b.debug_start === "today"; // sandbox only: let Square bill the first month itself
  const chargeNow = sched.charge_now && !debugToday;
  const attempt = clean(b.attempt, 80) || crypto.randomUUID();
  const hash = await sha256hex(`${e}|${attempt}`);

  const { data: prior } = await admin.from("club_members").select("*").eq("join_attempt", attempt).maybeSingle();
  if (prior?.square_subscription_id && ["active", "paused"].includes(prior.status)) {
    return await joinResult(req, prior, club, await shops(), null); // double-click / retry after success
  }
  const { data: dups } = await admin.from("club_members").select("id").eq("env", e).eq("club_id", club.id).eq("email", email).in("status", ["active", "paused"]);
  if ((dups ?? []).length) {
    throw new PublicError(`You already have a ${club.name} membership with this email. Use “Manage my membership” to change it.`, 409, { duplicate: true });
  }

  const name = `${first} ${last}`.trim();
  const phone = e164(digits);
  const code = prior?.code ?? codeFrom(hash);
  const monthly = await monthlyCents(e, cat, shop);
  const expected = Math.round(Number(b.expected_monthly_cents));
  if (Number.isFinite(expected) && expected > 0 && expected !== monthly) {
    throw new PublicError(`${club.name} is now ${money(monthly)} a month — please review and try again. Nothing was charged.`, 409, { monthly_cents: monthly });
  }
  const rowBase = {
    code, env: e, status: "pending", club_id: club.id, shop, first_name: first, last_name: last || null, email, phone: phone ?? digits,
    birthday, age_21_confirmed: club.age_21 ? true : false, join_attempt: attempt, error: null, updated_at: nowIso(),
  };
  const w = prior
    ? await admin.from("club_members").update(rowBase).eq("id", prior.id).select("id").single()
    : await admin.from("club_members").insert(rowBase).select("id").single();
  if (w.error) throw new Error("club_members: " + w.error.message);
  const memberId = String(w.data.id);
  const fail = async (msg: string) => {
    await admin.from("club_members").update({ status: "failed", error: msg.slice(0, 500), updated_at: nowIso() }).eq("id", memberId);
  };

  const locationId = await paymentLocation(shop, e);
  const customerId = await findOrCreateCustomer(e, { first, last, email, phone }, code);

  // 1. save the card on the Square customer
  let card: any;
  try {
    card = await saveCard(e, customerId, sourceId, vt, name, code, attempt);
  } catch (err) {
    await fail(String((err as Error).message));
    if (cardProblem(err)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const label = cardLabel(card);

  // 2. this month's box, when they joined before the order deadline
  let firstOrder: any = null, firstPay: any = null;
  if (chargeNow) {
    const boxNote = `Cheese Club · ${club.name} · ${monthYear(sched.first_box.month)} box · ${SHOPS[shop].label} pickup ${shortDay(sched.first_box.pickup)}`;
    try {
      const od = await post("/v2/orders", { idempotency_key: "cf-" + hash.slice(0, 40), order: { ...boxOrder(cat, locationId, customerId, code, boxNote), metadata: { club_code: code, box_month: sched.first_box.month } } }, e);
      firstOrder = od.order;
      const total = Number(firstOrder?.total_money?.amount ?? 0);
      if (!(total > 0)) throw new Error("first-box order total is " + total);
      const pd = await post("/v2/payments", {
        idempotency_key: ("cp" + (await sha256hex(firstOrder.id + "|" + card.id))).slice(0, 45),
        source_id: card.id, customer_id: customerId, location_id: locationId, order_id: firstOrder.id,
        amount_money: { amount: total, currency: "USD" }, autocomplete: true, reference_id: code,
        note: `Cheese Club ${code} · ${monthYear(sched.first_box.month)} box`, buyer_email_address: email,
      }, e);
      firstPay = pd.payment ?? {};
      if (firstPay.status !== "COMPLETED" && firstPay.status !== "APPROVED") throw Object.assign(new SquareError("payment " + firstPay.status), { status: 402, codes: ["GENERIC_DECLINE"] });
    } catch (err) {
      await disableCard(e, card.id);
      await fail(String((err as Error).message));
      if (cardProblem(err)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
      throw err;
    }
  }

  // 3. the subscription itself: starts on the 1st, then renews on the 1st of every month
  let sub: any;
  try {
    const tpl = await post("/v2/orders", {
      idempotency_key: "ct-" + hash.slice(0, 40),
      order: { ...boxOrder(cat, locationId, customerId, code, `Cheese Club · ${club.name} · ${SHOPS[shop].label} pickup`), state: "DRAFT" },
    }, e);
    const sd = await post("/v2/subscriptions", {
      idempotency_key: "cs-" + hash.slice(0, 40),
      location_id: locationId, plan_variation_id: cat.plan_variation_id, customer_id: customerId, card_id: card.id,
      start_date: debugToday ? sched.today : sched.start_date, timezone: TZ, monthly_billing_anchor_date: 1,
      source: { name: SOURCE }, phases: [{ ordinal: 0, order_template_id: tpl.order.id }],
    }, e);
    sub = sd.subscription;
    if (!sub?.id) throw new Error("Square did not return a subscription");
  } catch (err) {
    let refunded = false;
    if (firstPay?.id) {
      try {
        await post("/v2/refunds", {
          idempotency_key: ("cr" + (await sha256hex(firstPay.id))).slice(0, 45), payment_id: firstPay.id,
          amount_money: firstPay.total_money ?? firstPay.amount_money, reason: "Cheese Club sign-up could not be finished",
        }, e);
        refunded = true;
      } catch (rerr) { console.error("refund after failed subscription", firstPay.id, rerr); }
    }
    await disableCard(e, card.id);
    await fail("subscription: " + String((err as Error).message) + (firstPay?.id ? (refunded ? " · first box refunded" : " · FIRST BOX NOT REFUNDED " + firstPay.id) : ""));
    await log(memberId, "system", "join_failed", { error: String((err as Error).message).slice(0, 500), payment: firstPay?.id ?? null, refunded });
    throw new PublicError(
      firstPay?.id
        ? (refunded ? "We couldn't start your membership, so we refunded today's charge. Please try again or call the shop." : "We couldn't start your membership. Please call the shop — we'll make sure you're not charged.")
        : "We couldn't start your membership and nothing was charged. Please try again or call the shop.",
      502,
    );
  }

  // 4. record it
  const firstCents = firstPay ? Number(firstPay.total_money?.amount ?? firstPay.amount_money?.amount ?? 0) : 0;
  const upd = {
    status: "active", error: null, square_customer_id: customerId, square_card_id: card.id, card_label: label,
    square_subscription_id: sub.id, square_location_id: locationId, square_plan_variation_id: cat.plan_variation_id,
    square_status: sub.status ?? null, start_date: sub.start_date ?? (debugToday ? sched.today : sched.start_date),
    charged_through_date: sub.charged_through_date ?? null, canceled_date: sub.canceled_date ?? null,
    first_box_month: sched.first_box.month, first_charge_cents: firstCents, first_order_id: firstOrder?.id ?? null,
    first_payment_id: firstPay?.id ?? null, receipt_url: firstPay?.receipt_url ?? null, updated_at: nowIso(), synced_at: nowIso(),
  };
  await admin.from("club_members").update(upd).eq("id", memberId);
  if (firstPay) {
    const { error } = await admin.from("club_boxes").upsert({
      member_id: memberId, month: sched.first_box.month, club_id: club.id, shop, kind: "first_box", status: "paid", amount_cents: firstCents,
      square_order_id: firstOrder?.id ?? null, square_payment_id: firstPay.id, updated_at: nowIso(),
    }, { onConflict: "member_id,month" });
    if (error) console.error("club_boxes", error.message);
  }
  await log(memberId, "member", "join", { club: club.slug, shop, charged_cents: firstCents, start_date: upd.start_date, subscription: sub.id, debug_today: debugToday || undefined });

  const { data: row } = await admin.from("club_members").select("*").eq("id", memberId).single();
  const locs = await shops();
  const token = await newLink(email, e, WELCOME_LINK_DAYS);
  const out = await joinResult(req, row, club, locs, token, monthly);
  const sent = await mailWelcome(req, row, club, locs[shop], out, token).catch((err) => { console.error("welcome mail", code, err); return false; });
  await admin.from("club_members").update({ email_sent: sent }).eq("id", memberId);
  return { ...out, email_sent: sent };
}

async function joinResult(req: Request, row: any, club: Club, locs: Record<Shop, Loc>, token: string | null, monthly?: number) {
  const e = row.env as Env;
  const cat = (await catalogFor(e)).get(club.id);
  const m = monthly ?? (cat ? await monthlyCents(e, cat, row.shop) : club.price_cents);
  const box = await cohortOf(row.first_box_month ?? row.start_date ?? todayCT().iso);
  const start = String(row.start_date ?? firstOfNext(todayCT().iso));
  if (!token) token = await newLink(row.email, e, WELCOME_LINK_DAYS);
  return {
    ok: true, env: e, code: row.code, member_id: row.id,
    club: { slug: club.slug, name: club.name }, shop: locs[row.shop as Shop],
    first_box: boxLabels(box),
    charged_today: row.first_charge_cents > 0 ? { cents: row.first_charge_cents, card: row.card_label, receipt_url: row.receipt_url } : null,
    first_charge: row.first_charge_cents > 0 ? null : { date: start, label: longDay(start), cents: m },
    monthly_cents: m, renews_label: "the 1st of every month", next_renewal: { date: start, label: longDay(start) },
    card: row.card_label, manage_token: token, manage_url: `${siteOrigin(req)}/club.html?m=${token}`,
  };
}

// ---------- email ----------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
async function sendMail(to: string, subject: string, html: string, replyTo?: string | null) {
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({
      to, subject, html,
      from: Deno.env.get("CLUB_FROM") || Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>",
      replyTo: replyTo || Deno.env.get("INQUIRY_REPLY_TO") || "info@greyscheese.com",
    }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok !== false;
}
const mailHead = (test: boolean, note: string) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#06273A;line-height:1.55">
  ${test ? `<div style="background:#FDE7A8;padding:8px 12px;margin-bottom:14px;font-size:13px"><b>Test</b> — Square sandbox. ${note}</div>` : ""}
  <div style="background:#06273A;color:#F5F7F2;padding:18px 22px"><div style="font:800 26px Arial,sans-serif;letter-spacing:.02em">GREYS</div><div style="font:700 12px Arial,sans-serif;color:#D8E3EF">Fine Cheeses - Charcuterie - Wine</div></div>
  <div style="border:1px solid #E2DACA;border-top:4px solid #896D39;padding:22px">`;
const mailButton = (url: string, label: string) => `<p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:#e6b33c;color:#06273A;text-decoration:none;font:700 13px Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;padding:13px 24px">${esc(label)}</a></p>`;

async function mailWelcome(req: Request, row: any, club: Club, L: Loc, r: any, token: string) {
  const test = row.env === "sandbox";
  const url = `${siteOrigin(req)}/club.html?m=${token}`;
  const where = `${esc(L.name)} · ${esc(L.address)}${L.city ? ", " + esc(L.city) : ""}`;
  const money1 = money(r.monthly_cents);
  const html = `${mailHead(test, "No card was charged and no box will be made.")}
    <p style="font-size:20px;margin:0 0 6px"><b>Welcome to the club, ${esc(row.first_name)}!</b></p>
    <p style="margin:0 0 16px;color:#4d5763">You're a member of the <b>${esc(club.name)}</b>. Membership ${esc(row.code)}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:8px 0;border-top:1px solid #E2DACA;width:38%;color:#6B7480">Your first box</td><td style="padding:8px 0;border-top:1px solid #E2DACA"><b>${esc(r.first_box.month_label)}</b> — pick up ${esc(r.first_box.pickup_label)} or any time later that week</td></tr>
      <tr><td style="padding:8px 0;border-top:1px solid #E2DACA;color:#6B7480">Where</td><td style="padding:8px 0;border-top:1px solid #E2DACA">${where}${L.phone ? `<br><span style="color:#6B7480">${esc(L.phone)}</span>` : ""}</td></tr>
      <tr><td style="padding:8px 0;border-top:1px solid #E2DACA;color:#6B7480">${r.charged_today ? "Charged today" : "First charge"}</td><td style="padding:8px 0;border-top:1px solid #E2DACA">${r.charged_today ? `${money(r.charged_today.cents)}${r.card ? " · " + esc(r.card) : ""}` : `${money(r.first_charge.cents)} on ${esc(r.first_charge.label)}${r.card ? " · " + esc(r.card) : ""}`}</td></tr>
      <tr><td style="padding:8px 0;border-top:1px solid #E2DACA;border-bottom:1px solid #E2DACA;color:#6B7480">After that</td><td style="padding:8px 0;border-top:1px solid #E2DACA;border-bottom:1px solid #E2DACA">${money1} on the 1st of every month</td></tr>
    </table>
    ${club.age_21 ? `<p style="font-size:14px;margin:14px 0 0">Your club includes wine — please bring your ID to pickup.</p>` : ""}
    <p style="font-size:14px;margin:14px 0 0">Skip a month, pause or cancel any time before the 1st:</p>
    ${mailButton(url, "Manage my membership")}
    <p style="font-size:13px;color:#6B7480;margin:0">This link works for ${WELCOME_LINK_DAYS} days. After that, use “Manage my membership” on the Cheese Club page and we'll email you a new one.</p>
    <p style="font-size:14px;margin:18px 0 0"><b>Member perks:</b> 10% off retail cheese, 5% off dining in, a GREYS Cheese Log in your first box, and first dibs on limited wheels.</p>
    <p style="font-size:14px;margin:14px 0 0">Questions? Reply to this email${L.phone ? ` or call ${esc(L.phone)}` : ""}.</p>
  </div></div>`;
  return await sendMail(row.email, `${test ? "[TEST] " : ""}Welcome to the GREYS Cheese Club · first box ${r.first_box.month_label}`, html, L.email);
}

async function manageLink(req: Request, b: any) {
  const email = clean(b.email, 200).toLowerCase();
  if (!validEmail(email)) throw new PublicError("Please check your email address.");
  await rateLimit(req, "club-link", 10);
  await rateLimit(req, "club-link-mail", 4, email);
  const e = env();
  const { data: rows } = await admin.from("club_members").select("id, first_name, status").eq("env", e).eq("email", email).in("status", ["active", "paused", "canceled"]).order("created_at", { ascending: false }).limit(5);
  if ((rows ?? []).length) {
    const token = await newLink(email, e, MANAGE_LINK_DAYS);
    const url = `${siteOrigin(req)}/club.html?m=${token}`;
    const html = `${mailHead(e === "sandbox", "Test memberships only.")}
      <p style="font-size:18px;margin:0 0 10px"><b>Hi ${esc(rows![0].first_name)},</b></p>
      <p style="margin:0">Here's your link to manage your GREYS Cheese Club membership — skip a month, pause, cancel or update your card.</p>
      ${mailButton(url, "Manage my membership")}
      <p style="font-size:13px;color:#6B7480;margin:0">It works for ${MANAGE_LINK_DAYS} days. If you didn't ask for it, you can ignore this email.</p>
    </div></div>`;
    const sent = await sendMail(email, `${e === "sandbox" ? "[TEST] " : ""}Your GREYS Cheese Club link`, html);
    await log(rows![0].id, "member", "manage_link", { sent });
  }
  // same answer either way, so the form can't be used to look up who is a member
  return { ok: true, sent: true };
}

// ---------- sync one membership from Square ----------
const STATUS_MAP: Record<string, string> = { PENDING: "active", ACTIVE: "active", PAUSED: "paused", CANCELED: "canceled", DEACTIVATED: "canceled" };
const INVOICE_MAP: Record<string, string> = {
  PAID: "paid", PARTIALLY_PAID: "paid", REFUNDED: "refunded", PARTIALLY_REFUNDED: "paid",
  UNPAID: "scheduled", SCHEDULED: "scheduled", DRAFT: "scheduled", PAYMENT_PENDING: "scheduled", CANCELED: "failed", FAILED: "failed",
};
async function syncMember(row: any): Promise<{ row: any; sub: any; actions: any[] }> {
  if (!row?.square_subscription_id) return { row, sub: null, actions: [] };
  const e = row.env as Env;
  const d = await square(`/v2/subscriptions/${encodeURIComponent(row.square_subscription_id)}?include=actions`, {}, e);
  const s = d?.subscription ?? {};
  const actions: any[] = (d?.actions ?? s.actions ?? []).filter((a: any) => a && a.id);
  // monthly invoices → boxes (the first box, charged at signup, is already a row)
  const known = new Map<string, any>();
  const { data: boxes } = await admin.from("club_boxes").select("id, month, status, square_invoice_id, kind").eq("member_id", row.id);
  for (const bx of boxes ?? []) if (bx.square_invoice_id) known.set(bx.square_invoice_id, bx);
  for (const invId of ((s.invoice_ids ?? []) as string[]).slice(0, 24)) {
    const k = known.get(invId);
    if (k && ["paid", "refunded", "picked_up"].includes(k.status)) continue;
    try {
      const inv = (await square(`/v2/invoices/${encodeURIComponent(invId)}`, {}, e))?.invoice ?? {};
      const due = String(inv.payment_requests?.[0]?.due_date ?? inv.sale_or_service_date ?? inv.created_at ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
      const status = INVOICE_MAP[String(inv.status)] ?? "scheduled";
      const cents = Number(inv.payment_requests?.[0]?.total_completed_amount_money?.amount || inv.payment_requests?.[0]?.computed_amount_money?.amount || 0);
      const month = monthOf(due);
      const { data: same } = await admin.from("club_boxes").select("id, kind, square_invoice_id").eq("member_id", row.id).eq("month", month).maybeSingle();
      if (same && same.kind === "first_box" && !same.square_invoice_id) continue; // never let an invoice overwrite the signup box
      const rec = { member_id: row.id, month, club_id: row.club_id, shop: row.shop, kind: "renewal", status, amount_cents: cents, square_invoice_id: invId, square_order_id: inv.order_id ?? null, updated_at: nowIso() };
      const { error } = same ? await admin.from("club_boxes").update(rec).eq("id", same.id) : await admin.from("club_boxes").insert(rec);
      if (error) console.error("club_boxes sync", invId, error.message);
    } catch (err) { console.error("invoice", invId, err); }
  }
  // a skipped month: Square shows a pause that covered a 1st with no invoice — keep it visible as "skipped"
  const upd: Record<string, unknown> = {
    square_status: s.status ?? row.square_status, status: STATUS_MAP[String(s.status)] ?? row.status,
    start_date: s.start_date ?? row.start_date, charged_through_date: s.charged_through_date ?? null, canceled_date: s.canceled_date ?? null,
    square_card_id: s.card_id ?? row.square_card_id, synced_at: nowIso(), updated_at: nowIso(),
  };
  if (upd.square_card_id && upd.square_card_id !== row.square_card_id) {
    try { upd.card_label = cardLabel((await square(`/v2/cards/${encodeURIComponent(String(upd.square_card_id))}`, {}, e))?.card); } catch { /* keep the old label */ }
  }
  const { data: fresh } = await admin.from("club_members").update(upd).eq("id", row.id).select("*").single();
  return { row: fresh ?? { ...row, ...upd }, sub: s, actions };
}

// ---------- member view ----------
const ACTION_WORD: Record<string, string> = { PAUSE: "Pause", RESUME: "Resume", CANCEL: "Cancel", SWAP_PLAN: "Club change", CHANGE_BILLING_ANCHOR_DATE: "Billing date change" };
async function memberView(row: any, sub: any, actions: any[], club: Club | undefined, locs: Record<Shop, Loc>) {
  const today = todayCT().iso;
  const sq = String(sub?.status ?? row.square_status ?? "");
  const pauseA = actions.find((a) => a.type === "PAUSE");
  const resumeA = actions.find((a) => a.type === "RESUME");
  const cancelA = actions.find((a) => a.type === "CANCEL");
  const canceledDate = sub?.canceled_date ?? row.canceled_date ?? cancelA?.effective_date ?? null;
  const ended = sq === "CANCELED" || sq === "DEACTIVATED";
  let base: string | null = sq === "PENDING" ? (sub?.start_date ?? row.start_date) : sq === "ACTIVE" ? (sub?.charged_through_date ?? row.charged_through_date ?? firstOfNext(today)) : null;
  if (sq === "PAUSED") base = resumeA?.effective_date ?? null;
  let skipping: string | null = null, pausing: string | null = null;
  if (base && pauseA && pauseA.effective_date <= base) {
    if (resumeA) { skipping = base; base = resumeA.effective_date; } else { pausing = pauseA.effective_date; base = null; }
  }
  if (base && canceledDate && canceledDate <= base) base = null;
  const cat = club ? (await catalogFor(row.env)).get(club.id) : undefined;
  const monthly = cat ? await monthlyCents(row.env, cat, row.shop).catch(() => cat.price_cents) : club?.price_cents ?? 0;
  const { data: boxes } = await admin.from("club_boxes").select("month, status, amount_cents, kind").eq("member_id", row.id).order("month", { ascending: false }).limit(8);
  let upcoming: any = null;
  for (const bx of (boxes ?? []).slice().reverse()) {
    if (bx.status !== "paid") continue;
    const c = await cohortOf(bx.month);
    if (c.pickup >= today) { upcoming = { ...boxLabels(c), paid: true }; break; }
  }
  if (!upcoming && base) upcoming = { ...boxLabels(await cohortOf(base)), paid: false, charge_label: shortDay(base) };
  let statusLabel = "Active";
  if (ended) statusLabel = "Canceled";
  else if (canceledDate) statusLabel = `Ends ${shortDay(canceledDate)}`;
  else if (sq === "PAUSED") statusLabel = resumeA ? `Paused · resumes ${shortDay(resumeA.effective_date)}` : "Paused";
  else if (pausing) statusLabel = `Pausing ${shortDay(pausing)}`;
  else if (sq === "PENDING") statusLabel = `Starts ${shortDay(String(sub?.start_date ?? row.start_date))}`;
  const live = !ended && !canceledDate;
  return {
    id: row.id, code: row.code, env: row.env,
    club: club ? { slug: club.slug, name: club.name, age_21: club.age_21 } : { slug: "", name: "Cheese Club", age_21: false },
    shop: locs[row.shop as Shop] ?? { key: row.shop, label: row.shop },
    status: row.status, square_status: sq, status_label: statusLabel, card: row.card_label, monthly_cents: monthly,
    next_charge: base ? { date: base, label: longDay(base), short: shortDay(base), cents: monthly } : null,
    skipping: skipping ? { date: skipping, month_label: monthName(skipping) } : null,
    upcoming, ends: canceledDate ? { date: canceledDate, label: longDay(canceledDate) } : null,
    scheduled: actions.map((a) => ({ id: a.id, type: a.type, date: a.effective_date, label: `${ACTION_WORD[a.type] ?? a.type} · ${shortDay(String(a.effective_date))}` })),
    can: {
      skip: live && !!base && !pauseA && (sq === "ACTIVE" || sq === "PENDING") ? { month_label: monthName(base!), date: base } : null,
      pause: live && !!base && !pauseA && (sq === "ACTIVE" || sq === "PENDING"),
      resume: !ended && sq === "PAUSED" && !resumeA,
      undo_pause: pauseA && !ended ? pauseA.id : null,
      cancel: live,
      undo_cancel: !ended && cancelA ? cancelA.id : null,
      card: !ended,
    },
    boxes: (boxes ?? []).map((bx: any) => ({ month: bx.month, month_label: monthYear(bx.month), status: bx.status, cents: bx.amount_cents, kind: bx.kind })),
  };
}

async function memberRows(email: string, e: Env) {
  const { data } = await admin.from("club_members").select("*").eq("env", e).eq("email", email.toLowerCase()).in("status", ["active", "paused", "canceled"]).order("created_at", { ascending: false }).limit(10);
  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  return (data ?? []).filter((r: any) => r.status !== "canceled" || !r.canceled_date || r.canceled_date >= cutoff);
}

async function manage(req: Request, b: any) {
  await rateLimit(req, "club-manage", 120);
  const who = await linkAuth(b);
  const [rows, clubs, locs] = await Promise.all([memberRows(who.email, who.env), loadClubs(), shops()]);
  const allClubs = await clubsById(clubs);
  const members = [];
  for (const r of rows) {
    let s: any = null, actions: any[] = [], row = r;
    try { ({ row, sub: s, actions } = await syncMember(r)); } catch (err) { console.error("sync", r.id, err); }
    members.push(await memberView(row, s, actions, allClubs.get(row.club_id), locs));
  }
  const first = rows[0]?.first_name ?? "";
  const pay = { app_id: credsFor(who.env).appId, location_id: await paymentLocation("memphis", who.env).catch(() => null), script_src: scriptFor(who.env) };
  return { ok: true, env: who.env, email: who.email, first_name: first, members, pay, calendar: await calendar() };
}
async function clubsById(active: Club[]) {
  const m = new Map(active.map((c) => [c.id, c]));
  // a member can belong to a club that has since been switched off — still show its name
  const { data } = await admin.from("cc_clubs").select("id, slug, name, age_21, monthly_price_cents, shops").eq("active", false);
  for (const c of data ?? []) if (!m.has(c.id)) m.set(c.id, { id: c.id, slug: c.slug, name: tidy(c.name), tagline: "", description: "", inside: [], price_cents: c.monthly_price_cents, badge: null, image_url: null, shops: c.shops ?? [], age_21: !!c.age_21, sort: 99 });
  return m;
}

async function memberFor(b: any, who: { email: string; env: Env }) {
  const id = clean(b.member, 60);
  const { data: row } = await admin.from("club_members").select("*").eq("id", id).eq("env", who.env).maybeSingle();
  if (!row || String(row.email).toLowerCase() !== who.email.toLowerCase()) throw new PublicError("We couldn't find that membership. Please open your link again.", 404);
  if (!row.square_subscription_id) throw new PublicError("This membership isn't set up in Square yet. Please call the shop.", 409);
  return row;
}

async function act(req: Request, b: any) {
  await rateLimit(req, "club-act", 40);
  const who = await linkAuth(b);
  const row = await memberFor(b, who);
  const e = row.env as Env, id = encodeURIComponent(row.square_subscription_id);
  const op = clean(b.op, 20);
  const { sub, actions } = await syncMember(row);
  const club = (await clubsById(await loadClubs())).get(row.club_id);
  const view = await memberView(row, sub, actions, club, await shops());
  const today = todayCT().iso;
  try {
    if (op === "skip") {
      if (!view.can.skip) throw new PublicError("There's no upcoming month to skip right now.", 409);
      await post(`/v2/subscriptions/${id}/pause`, { pause_effective_date: view.can.skip.date, pause_cycle_duration: 1, pause_reason: "Member skipped a month online" }, e);
    } else if (op === "pause") {
      if (!view.can.pause || !view.next_charge) throw new PublicError("This membership can't be paused right now.", 409);
      await post(`/v2/subscriptions/${id}/pause`, { pause_effective_date: view.next_charge.date, pause_reason: "Member paused online" }, e);
    } else if (op === "resume") {
      if (!view.can.resume) throw new PublicError("This membership isn't paused.", 409);
      const when = firstOfNext(today);
      await post(`/v2/subscriptions/${id}/resume`, { resume_effective_date: when, resume_change_timing: "IMMEDIATE" }, e);
    } else if (op === "cancel") {
      if (!view.can.cancel) throw new PublicError("This membership is already ending.", 409);
      await post(`/v2/subscriptions/${id}/cancel`, {}, e);
    } else if (op === "undo") {
      const aid = clean(b.action_id, 80);
      if (!aid || !actions.some((a) => a.id === aid)) throw new PublicError("That change already happened or was undone.", 409);
      await square(`/v2/subscriptions/${id}/actions/${encodeURIComponent(aid)}`, { method: "DELETE" }, e);
    } else {
      throw new PublicError("Unknown change.");
    }
  } catch (err) {
    if (err instanceof PublicError) throw err;
    console.error("act", op, row.code, err);
    await log(row.id, "member", op + "_failed", { error: String((err as Error).message).slice(0, 500) });
    if (err instanceof SquareError && err.status < 500) {
      throw new PublicError("We couldn't make that change online. Please call or email the shop and we'll take care of it.", 409);
    }
    throw err;
  }
  await log(row.id, "member", op, { action_id: b.action_id ?? undefined });
  const fresh = await syncMember(row);
  return { ok: true, member: await memberView(fresh.row, fresh.sub, fresh.actions, club, await shops()) };
}

async function updateCard(req: Request, b: any) {
  await rateLimit(req, "club-card", 10);
  const who = await linkAuth(b);
  const row = await memberFor(b, who);
  const e = row.env as Env;
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("Please re-enter your card.");
  let card: any;
  try {
    card = await saveCard(e, row.square_customer_id, sourceId, clean(b.verification_token, 4000), `${row.first_name} ${row.last_name ?? ""}`.trim(), row.code, "card-" + crypto.randomUUID());
    await square(`/v2/subscriptions/${encodeURIComponent(row.square_subscription_id)}`, { method: "PUT", body: JSON.stringify({ subscription: { card_id: card.id } }) }, e);
  } catch (err) {
    if (card?.id) await disableCard(e, card.id);
    if (cardProblem(err)) throw new PublicError(cardMessage(err), 402);
    throw err;
  }
  const label = cardLabel(card);
  await admin.from("club_members").update({ square_card_id: card.id, card_label: label, updated_at: nowIso() }).eq("id", row.id);
  await log(row.id, "member", "card", { card: label });
  const fresh = await syncMember({ ...row, square_card_id: card.id, card_label: label });
  const club = (await clubsById(await loadClubs())).get(row.club_id);
  return { ok: true, member: await memberView(fresh.row, fresh.sub, fresh.actions, club, await shops()) };
}

// ---------- staff ----------
async function isStaff(req: Request, b: any) {
  const sec = clean(b.secret, 200);
  if (sec) {
    const { data } = await admin.from("app_secrets").select("value").eq("name", "cc_cron_secret").maybeSingle();
    if (data?.value && sec === data.value) return true;
  }
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === ANON) return false;
  if (tok === SERVICE) return true;
  const user = createClient(SUPABASE_URL, ANON || SERVICE, { global: { headers: { Authorization: "Bearer " + tok } }, auth: { persistSession: false } });
  const { data, error } = await user.rpc("is_app_admin");
  return !error && data === true;
}

async function batchRetrieve(ids: string[], e: Env) {
  const out = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 500) {
    const d = await post("/v2/catalog/batch-retrieve", { object_ids: ids.slice(i, i + 500), include_related_objects: false }, e);
    for (const o of d.objects ?? []) if (!o.is_deleted) out.set(o.id, o);
  }
  return out;
}
async function upsertObjects(e: Env, objects: any[], tag: string) {
  const d = await post("/v2/catalog/batch-upsert", { idempotency_key: `club-${tag}-${crypto.randomUUID()}`, batches: [{ objects }] }, e);
  const map = new Map<string, string>();
  for (const m of d.id_mappings ?? []) map.set(m.client_object_id, m.object_id);
  return { map, objects: (d.objects ?? []) as any[] };
}

// Creates (or repairs) the Square side of every active club: an item with a "Monthly" variation at the
// club's price, the shared plan with those items eligible, and a MONTHLY plan variation per club
// (RELATIVE pricing, billed on the 1st, no proration). Safe to run again: it only fills gaps and
// pushes price changes from cc_clubs onto the Square items.
async function setup(b: any) {
  const e: Env = b.env === "production" ? "production" : "sandbox";
  if (e === "production" && b.confirm !== true) throw new PublicError("Production setup changes the live Square catalog. Send confirm:true to run it.", 409);
  const clubs = await loadClubs();
  const have = await catalogFor(e);
  const ids = new Set<string>();
  for (const r of have.values()) { ids.add(r.item_id); ids.add(r.plan_id); ids.add(r.plan_variation_id); }
  if (e === "production") { ids.add(PROD_PLAN_ID); for (const v of Object.values(PROD_ITEMS)) ids.add(v); }
  const got = ids.size ? await batchRetrieve([...ids], e) : new Map<string, any>();
  const report: any[] = [];

  // 1. items (create the missing ones; push price changes)
  const itemFor = new Map<string, any>();
  const create: any[] = [], update: any[] = [];
  for (const c of clubs) {
    const known = have.get(c.id)?.item_id ?? (e === "production" ? PROD_ITEMS[c.slug] : undefined);
    const obj = known ? got.get(known) : null;
    if (obj) {
      itemFor.set(c.id, obj);
      const v = obj.item_data?.variations?.[0];
      if (v && Number(v.item_variation_data?.price_money?.amount) !== c.price_cents) {
        v.item_variation_data.price_money = { amount: c.price_cents, currency: "USD" };
        v.item_variation_data.pricing_type = "FIXED_PRICING";
        update.push(obj);
        report.push({ club: c.slug, item: "price → " + money(c.price_cents) });
      }
      continue;
    }
    const tid = "#item-" + c.slug;
    create.push({
      type: "ITEM", id: tid, present_at_all_locations: true,
      item_data: {
        name: c.name, description: c.description.slice(0, 4000), product_type: "FOOD_AND_BEV",
        variations: [{
          type: "ITEM_VARIATION", id: "#var-" + c.slug, present_at_all_locations: true,
          item_variation_data: { item_id: tid, name: "Monthly", pricing_type: "FIXED_PRICING", price_money: { amount: c.price_cents, currency: "USD" }, sellable: true, stockable: false },
        }],
      },
    });
  }
  if (create.length || update.length) {
    const r = await upsertObjects(e, [...create, ...update], "items");
    for (const o of r.objects) {
      const c = clubs.find((x) => o.id === r.map.get("#item-" + x.slug)) ?? clubs.find((x) => itemFor.get(x.id)?.id === o.id);
      if (c && o.type === "ITEM") { itemFor.set(c.id, o); if (create.some((x) => x.id === "#item-" + c.slug)) report.push({ club: c.slug, item: "created " + o.id }); }
    }
  }

  // 2. the plan, with every club item eligible
  const planId0 = [...have.values()][0]?.plan_id ?? (e === "production" ? PROD_PLAN_ID : null);
  let plan = planId0 ? got.get(planId0) ?? (await batchRetrieve([planId0], e)).get(planId0) : null;
  const itemIds = clubs.map((c) => itemFor.get(c.id)?.id).filter(Boolean) as string[];
  if (!plan) {
    const r = await upsertObjects(e, [{ type: "SUBSCRIPTION_PLAN", id: "#club-plan", present_at_all_locations: true, subscription_plan_data: { name: PLAN_NAME, eligible_item_ids: itemIds, all_items: false } }], "plan");
    plan = r.objects.find((o) => o.type === "SUBSCRIPTION_PLAN");
    report.push({ plan: "created " + plan?.id });
  } else {
    const elig = new Set<string>(plan.subscription_plan_data?.eligible_item_ids ?? []);
    const missing = itemIds.filter((x) => !elig.has(x));
    if (missing.length && !plan.subscription_plan_data?.all_items) {
      plan.subscription_plan_data.eligible_item_ids = [...elig, ...missing];
      const r = await upsertObjects(e, [plan], "plan");
      plan = r.objects.find((o) => o.type === "SUBSCRIPTION_PLAN") ?? plan;
      report.push({ plan: `eligible items +${missing.length}` });
    }
  }
  if (!plan?.id) throw new Error("no subscription plan");

  // 3. one monthly plan variation per club: RELATIVE price, billed on the 1st, no proration
  const varFor = new Map<string, string>();
  const newVars: any[] = [];
  for (const c of clubs) {
    const vid = have.get(c.id)?.plan_variation_id;
    if (vid && got.get(vid)) { varFor.set(c.id, vid); continue; }
    newVars.push({
      type: "SUBSCRIPTION_PLAN_VARIATION", id: "#pv-" + c.slug, present_at_all_locations: true,
      subscription_plan_variation_data: {
        name: `${c.name} — monthly`, subscription_plan_id: plan.id,
        phases: [{ cadence: "MONTHLY", ordinal: 0, pricing: { type: "RELATIVE" } }],
        monthly_billing_anchor_date: 1, can_prorate: false,
      },
    });
  }
  if (newVars.length) {
    const r = await upsertObjects(e, newVars, "variations");
    for (const c of clubs) { const id = r.map.get("#pv-" + c.slug); if (id) { varFor.set(c.id, id); report.push({ club: c.slug, plan_variation: "created " + id }); } }
  }

  // 4. remember the ids
  const rows = [];
  for (const c of clubs) {
    const it = itemFor.get(c.id), pv = varFor.get(c.id);
    if (!it || !pv) { report.push({ club: c.slug, error: "incomplete" }); continue; }
    rows.push({
      env: e, club_id: c.id, item_id: it.id, item_variation_id: it.item_data.variations[0].id, plan_id: plan.id, plan_variation_id: pv,
      price_cents: Number(it.item_data.variations[0].item_variation_data?.price_money?.amount ?? c.price_cents),
      tax_ids: it.item_data.is_taxable === false ? [] : (it.item_data.tax_ids ?? []), updated_at: nowIso(),
    });
  }
  if (rows.length) {
    const { error } = await admin.from("club_square_catalog").upsert(rows, { onConflict: "env,club_id" });
    if (error) throw new Error("club_square_catalog: " + error.message);
  }
  CFG = null; AMT.clear();
  return { ok: true, env: e, plan_id: plan.id, clubs: rows.map((r) => ({ club: clubs.find((c) => c.id === r.club_id)?.slug, ...r })), changes: report };
}

async function syncAll(b: any) {
  const q = admin.from("club_members").select("*").not("square_subscription_id", "is", null).in("status", ["active", "paused", "canceled"]).order("synced_at", { ascending: true, nullsFirst: true }).limit(Math.min(200, Number(b.max) || 100));
  const { data } = b.env ? await q.eq("env", b.env) : await q;
  let ok = 0, bad = 0;
  for (const r of data ?? []) {
    if (r.status === "canceled" && r.canceled_date && r.canceled_date < todayCT().iso && r.synced_at && Date.parse(r.synced_at) > Date.parse(r.canceled_date)) continue;
    try { await syncMember(r); ok++; } catch (err) { bad++; console.error("sync", r.code, err); }
  }
  return { ok: true, synced: ok, failed: bad };
}

async function members(b: any) {
  const e: Env = b.env === "production" ? "production" : b.env === "sandbox" ? "sandbox" : env();
  const { data } = await admin.from("club_members")
    .select("id, code, env, status, square_status, club_id, shop, first_name, last_name, email, phone, card_label, start_date, charged_through_date, canceled_date, first_box_month, first_charge_cents, created_at, error")
    .eq("env", e).order("created_at", { ascending: false }).limit(Math.min(500, Number(b.limit) || 200));
  return { ok: true, env: e, members: data ?? [] };
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
    if (action === "config") return json(req, await config());
    if (action === "join") return json(req, await join(req, body));
    if (action === "manage_link") return json(req, await manageLink(req, body));
    if (action === "manage") return json(req, await manage(req, body));
    if (action === "act") return json(req, await act(req, body));
    if (action === "card") return json(req, await updateCard(req, body));
    if (action === "setup" || action === "sync" || action === "members") {
      if (!(await isStaff(req, body))) return json(req, { ok: false, error: "Not allowed." }, 403);
      if (action === "setup") return json(req, await setup(body));
      if (action === "sync") return json(req, await syncAll(body));
      return json(req, await members(body));
    }
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message, ...(e.extra ?? {}) }, e.status);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong on our side. Nothing was charged — please try again, or call the shop (ref ${ref}).` }, 500);
  }
});
