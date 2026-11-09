// shirt-shop — the GREYS shirt shop: shop.html in the staff-portal repo (moved in from tee-stores, 2026-11-08).
//   live:    https://staff.greyscheese.com/shop   (+ https://shop.greyscheese.com once that domain points at the portal)
//   staging: https://greys-staff-portal-staging.onrender.com/shop
//
// CATALOG: public.shirt_products + shirt_variants (see supabase/sql/2026-11-08_shirt_shop.sql). Prices always come
// from here, never from the page.
//
// PAYMENTS: Square, same pattern as square-online-order. The Square environment is picked PER REQUEST:
//   production → site_content 'shirt_shop'.live is true AND the page's Origin is a live origin
//                (SHIRT_LIVE_ORIGINS, default https://shop.greyscheese.com + https://staff.greyscheese.com).
//                The live SQUARE_TICKET_* app, charged to SHIRT_SQUARE_LOCATION_ID (default Memphis).
//   sandbox    → everything else (staging, local copies, curl, or live=false): SQUARE_ORDER_SANDBOX_* / SQUARE_EXP_SANDBOX_*.
// Square gets ad-hoc lines ("Brie Right Back Tee", variation "M"), a "Shipping" line and, for ship-to states in
// tax_rates, an additive sales tax — no fulfillment on the Square order, so nothing prints in the kitchen and the
// calendar mirror (square-orders) ignores it. The card is charged with the ship-to address on the payment.
//
// PRINTFUL: every checkout makes a Printful DRAFT before the card is charged — that checks the address and the
// shirts with Printful first (a bad address is refused with nothing charged) and records what Printful will bill
// us (printful_cost_cents). After payment, site_content 'shirt_shop'.printful decides:
//   "draft"   → leave it as a draft; confirm it in Printful (or with admin_confirm) — the safe start
//   "confirm" → confirm it right away; Printful prints and ships it
//   "off"     → no Printful at all; the order is only recorded
// Test (sandbox) checkouts skip Printful unless printful_test is true, and are never confirmed.
// If Printful is unreachable at checkout the sale still goes through, marked "not sent" — admin_retry sends it.
// Mapping: a variant needs printful_sync_variant_id (a product made in the Printful dashboard) or
// printful_variant_id + print_file_url. admin_printful_sync fills printful_sync_variant_id by matching Printful
// product names to ours (sizes: S M L XL 2XL). On the live site an unmapped variant shows as unavailable.
// Status comes back on the Printful webhook (admin_printful_setup registers it): shipped → tracking is stored and
// the customer gets a "shipped" email; failed / canceled / on hold → Brad gets an alert email.
//
// UNPAID ORDERS: the Square order (and the Printful draft) exist before the card is charged. The `sweep` action
// (pg_cron 'shirt-orders-sweep', every 10 min, app_secrets.cc_cron_secret) cancels what's still unpaid after 30
// minutes, in Square and in Printful.
//
// Secrets: SQUARE_TICKET_ACCESS_TOKEN / SQUARE_TICKET_APP_ID (live, shared with the order site),
//   SQUARE_ORDER_SANDBOX_* or SQUARE_EXP_SANDBOX_* (sandbox), PRINTFUL_TOKEN (+ PRINTFUL_STORE_ID for an
//   account-level token), PRINTFUL_HOOK_KEY (any long random string). NOTES_PASS (manager password) also opens the admin actions.
//   Optional: SHIRT_LIVE_ORIGINS, SHIRT_SQUARE_LOCATION_ID, SHIRT_ALERT_EMAIL (default brad@greyscheese.com).
//
// Actions (POST ?action=…)    verify_jwt = false
//   public:  catalog · quote · pay · status
//   cron:    sweep {secret}
//   printful_hook ?key=PRINTFUL_HOOK_KEY            (Printful → us)
//   admin (a signed-in console admin — Authorization: Bearer <session token>, checked with is_app_admin() — or {pass} =
//   NOTES_PASS): admin_orders · admin_retry {code} · admin_confirm {code} · admin_printful_setup · admin_printful_sync
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => {
  const v = Deno.env.get(k);
  return v && v.trim() ? v.trim() : undefined;
};
const SUPABASE_URL = env("SUPABASE_URL") ?? "";
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
let _admin: SupabaseClient | null = null;
const admin = () => (_admin ??= createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } }));

const SHOP = "greys";
const PUBLISHABLE_KEY = "sb_publishable_LnlevWReed7K8cFk_f_Mxg_UywktQ5_"; // public; the pages use it too
const SQUARE_VERSION = "2025-01-23";
const PRINTFUL_BASE = "https://api.printful.com";
const MEMPHIS_LOCATION = "LCXWZ0HAQ69RM";
const LIVE_ORIGINS = ["https://shop.greyscheese.com", "https://staff.greyscheese.com"];
const MAX_QTY = 10, MAX_LINES = 20, MAX_TOTAL_CENTS = 150000, CATALOG_TTL_MS = 30_000, SETTINGS_TTL_MS = 10_000;
const SWEEP_MINUTES = 30;
const SHOP_PHONE = "901-440-4739";
const SHOP_EMAIL = "info@greyscheese.com";

type Env = "production" | "sandbox";
type Mode = "off" | "draft" | "confirm";
type Settings = {
  live: boolean; paused: boolean; ship_first_cents: number; ship_each_cents: number; free_ship_over_cents: number;
  tax_rates: Record<string, string>; printful: Mode; printful_test: boolean;
};
type Variant = {
  id: string; product_id: string; size: string; sku: string; price_cents: number; active: boolean; sort_order: number;
  printful_sync_variant_id: number | null; printful_variant_id: number | null; print_file_url: string | null;
};
type Product = {
  id: string; slug: string; name: string; tagline: string; description: string; image_url: string | null;
  price_cents: number; sort_order: number; variants: Variant[];
};
type Line = { p: Product; v: Variant; qty: number };
type Cust = { name: string; email: string; phone: string | null };
type Ship = { name: string; address1: string; address2: string; city: string; state_code: string; zip: string; country_code: "US" };
type Totals = { subtotal_cents: number; shipping_cents: number; tax_cents: number; total_cents: number };

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

export class PublicError extends Error {
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
class PrintfulError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

// ---------- data (one object, so tests can swap it) ----------
const one = async (q: any) => {
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
};
export const db = {
  async settings(): Promise<any> {
    return (await one(admin().from("site_content").select("data").eq("key", "shirt_shop")))?.data ?? {};
  },
  async catalog(): Promise<any[]> {
    const { data, error } = await admin().from("shirt_products").select("*, shirt_variants(*)").eq("shop", SHOP).eq("active", true).order("sort_order");
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async rateHit(bucket: string, limit: number): Promise<boolean> {
    const { data, error } = await admin().rpc("ticket_rate_hit", { p_bucket: bucket.slice(0, 200), p_limit: limit, p_window_secs: 3600 });
    return error ? true : data !== false;
  },
  orderBySquare: (id: string) => one(admin().from("shirt_orders").select("*").eq("square_order_id", id)),
  orderByCode: (code: string) => one(admin().from("shirt_orders").select("*").eq("code", code).order("created_at", { ascending: false }).limit(1)),
  orderByPrintful: (id: number) => one(admin().from("shirt_orders").select("*").eq("printful_order_id", id).limit(1)),
  async insertOrder(row: Record<string, unknown>) {
    const { error } = await admin().from("shirt_orders").insert(row);
    if (error) console.error("shirt_orders insert", error.message);
  },
  // notPaid: leave a paid row alone (a late failure must never overwrite a payment)
  async updateOrder(match: { id?: string; square_order_id?: string }, patch: Record<string, unknown>, notPaid = false) {
    let q: any = admin().from("shirt_orders").update({ ...patch, updated_at: new Date().toISOString() });
    if (match.id) q = q.eq("id", match.id);
    if (match.square_order_id) q = q.eq("square_order_id", match.square_order_id);
    if (notPaid) q = q.neq("status", "paid");
    const { error } = await q;
    if (error) console.error("shirt_orders update", error.message);
  },
  async sweepRows(beforeIso: string): Promise<any[]> {
    const { data, error } = await admin().from("shirt_orders").select("id, env, code, status, square_order_id, printful_order_id, updated_at")
      .in("status", ["pending", "failed"]).not("square_order_id", "is", null).lt("updated_at", beforeIso)
      .order("updated_at", { ascending: true }).limit(25);
    if (error) throw new Error("sweep: " + error.message);
    return data ?? [];
  },
  async recentOrders(limit: number): Promise<any[]> {
    const { data, error } = await admin().from("shirt_orders").select("*").neq("status", "cancelled").order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async setPrintfulIds(map: { id: string; sync: number }[]) {
    for (const m of map) {
      const { error } = await admin().from("shirt_variants").update({ printful_sync_variant_id: m.sync }).eq("id", m.id);
      if (error) throw new Error(error.message);
    }
  },
  // the manager console's signed-in user: same check as the console's RLS (public.is_app_admin)
  async isAdmin(token: string): Promise<boolean> {
    const c = createClient(SUPABASE_URL, env("SUPABASE_ANON_KEY") ?? PUBLISHABLE_KEY, {
      global: { headers: { Authorization: "Bearer " + token } }, auth: { persistSession: false },
    });
    const { data, error } = await c.rpc("is_app_admin");
    return !error && data === true;
  },
  async cronSecret(): Promise<string | null> {
    return (await one(admin().from("app_secrets").select("value").eq("name", "cc_cron_secret")))?.value ?? null;
  },
};

// ---------- settings + catalog (cached; a failed read keeps the last good copy) ----------
const DEFAULTS: Settings = {
  live: false, paused: false, ship_first_cents: 600, ship_each_cents: 200, free_ship_over_cents: 0,
  tax_rates: { TN: "9.75" }, printful: "draft", printful_test: false,
};
let settingsCache: { at: number; s: Settings } | null = null;
const cents = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000 ? Number(v) : d);
export function parseSettings(raw: any): Settings {
  const r = raw && typeof raw === "object" ? raw : {};
  const rates: Record<string, string> = {};
  const src = r.tax_rates && typeof r.tax_rates === "object" ? r.tax_rates : DEFAULTS.tax_rates;
  for (const [k, v] of Object.entries(src)) {
    const st = String(k).toUpperCase(), pct = String(v ?? "").trim();
    if (US_STATES[st] && /^\d{1,2}(\.\d{1,4})?$/.test(pct) && Number(pct) > 0 && Number(pct) < 20) rates[st] = pct;
  }
  return {
    live: r.live === true,
    paused: r.paused === true,
    ship_first_cents: cents(r.ship_first_cents, DEFAULTS.ship_first_cents),
    ship_each_cents: cents(r.ship_each_cents, DEFAULTS.ship_each_cents),
    free_ship_over_cents: cents(r.free_ship_over_cents, 0),
    tax_rates: rates,
    printful: (["off", "draft", "confirm"] as Mode[]).includes(r.printful) ? r.printful : DEFAULTS.printful,
    printful_test: r.printful_test === true,
  };
}
async function settings(): Promise<Settings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.s;
  try {
    settingsCache = { at: Date.now(), s: parseSettings(await db.settings()) };
  } catch (err) {
    console.error("shirt_shop settings read failed", err);
    if (!settingsCache) return { ...DEFAULTS, paused: true }; // never sell blind
  }
  return settingsCache!.s;
}
let catalogCache: { at: number; list: Product[] } | null = null;
async function catalog(): Promise<Product[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.list;
  const rows = await db.catalog();
  const list: Product[] = rows.map((p: any) => ({
    id: p.id, slug: p.slug, name: p.name, tagline: p.tagline ?? "", description: p.description ?? "", image_url: p.image_url ?? null,
    price_cents: p.price_cents, sort_order: p.sort_order ?? 0,
    variants: ((p.shirt_variants ?? []) as any[]).filter((v) => v.active)
      .map((v) => ({
        id: v.id, product_id: p.id, size: v.size, sku: v.sku, price_cents: v.price_cents, active: true, sort_order: v.sort_order ?? 0,
        printful_sync_variant_id: v.printful_sync_variant_id == null ? null : Number(v.printful_sync_variant_id),
        printful_variant_id: v.printful_variant_id == null ? null : Number(v.printful_variant_id),
        print_file_url: v.print_file_url ?? null,
      }))
      .sort((a, b) => a.sort_order - b.sort_order),
  })).filter((p: Product) => p.variants.length);
  catalogCache = { at: Date.now(), list };
  return list;
}
export const _resetCaches = () => { settingsCache = null; catalogCache = null; sandboxLoc = null; };

// ---------- environment ----------
const listEnv = (name: string, dflt: string[]) => {
  const v = (env(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return v.length ? v : dflt;
};
const originOf = (req: Request) => (req.headers.get("Origin") ?? "").trim().toLowerCase();
const envFor = (req: Request, s: Settings): Env => (s.live && listEnv("SHIRT_LIVE_ORIGINS", LIVE_ORIGINS).includes(originOf(req)) ? "production" : "sandbox");
const credsFor = (e: Env) => e === "production"
  ? {
    token: env("SHIRT_SQUARE_ACCESS_TOKEN") ?? env("SQUARE_TICKET_ACCESS_TOKEN"),
    appId: env("SHIRT_SQUARE_APP_ID") ?? env("SQUARE_TICKET_APP_ID") ?? null,
    location: env("SHIRT_SQUARE_LOCATION_ID") ?? MEMPHIS_LOCATION,
  }
  : {
    token: env("SHIRT_SQUARE_SANDBOX_ACCESS_TOKEN") ?? env("SQUARE_ORDER_SANDBOX_ACCESS_TOKEN") ?? env("SQUARE_EXP_SANDBOX_ACCESS_TOKEN"),
    appId: env("SHIRT_SQUARE_SANDBOX_APP_ID") ?? env("SQUARE_ORDER_SANDBOX_APP_ID") ?? env("SQUARE_EXP_SANDBOX_APP_ID") ?? null,
    location: env("SHIRT_SQUARE_SANDBOX_LOCATION_ID") ?? env("SQUARE_ORDER_SANDBOX_LOCATION_ID") ?? env("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? null,
  };
const baseFor = (e: Env) => (e === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");
const scriptFor = (e: Env) => (e === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js");
const printfulReady = () => !!env("PRINTFUL_TOKEN");
const mapped = (v: Variant) => !!(v.printful_sync_variant_id || (v.printful_variant_id && v.print_file_url));
const PAUSED_MSG = "The shirt shop is taking a short break. Please check back soon, or call us at " + SHOP_PHONE + ".";

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const ours = /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (ours) h["Access-Control-Allow-Origin"] = origin;
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
async function printful(path: string, init: RequestInit = {}): Promise<any> {
  const token = env("PRINTFUL_TOKEN");
  if (!token) throw new PrintfulError("PRINTFUL_TOKEN is not set", 0);
  const headers: Record<string, string> = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const store = env("PRINTFUL_STORE_ID");
  if (store) headers["X-PF-Store-Id"] = store;
  let res: Response;
  try {
    res = await fetch(PRINTFUL_BASE + path, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new PrintfulError("Printful unreachable: " + String((err as Error).message).slice(0, 200), 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || (typeof data?.result === "string" ? data.result : "") || `Printful error (${res.status})`;
    throw new PrintfulError(String(msg).slice(0, 400), res.status);
  }
  return data?.result ?? data;
}

let sandboxLoc: string | null = null;
async function paymentLocation(e: Env): Promise<string> {
  const c = credsFor(e);
  if (c.location) return c.location;
  if (sandboxLoc) return sandboxLoc;
  const d = await square("/v2/locations", {}, "sandbox");
  const list = (d?.locations ?? []) as any[];
  const active = list.find((l) => l.status === "ACTIVE") ?? list[0];
  if (!active?.id) throw new Error("The Square sandbox has no location.");
  return (sandboxLoc = String(active.id));
}
async function payConfig(e: Env) {
  let location_id: string | null = null, reach_error: string | null = null;
  try { location_id = await paymentLocation(e); } catch (err) { reach_error = String((err as Error).message).slice(0, 300); }
  return { env: e, app_id: credsFor(e).appId, location_id, script_src: scriptFor(e), reachable: !!location_id, reach_error };
}

// ---------- helpers ----------
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const money = (c: number) => "$" + (c / 100).toFixed(2);
const dollars = (c: number) => (c / 100).toFixed(2);
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const codeFrom = (hex: string) => "T" + [0, 1, 2, 3, 4].map((i) => ALPHA[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32]).join("");
function e164(raw: unknown) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const sizeOf = (raw: unknown) => {
  const s = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  return s === "2XL" ? "XXL" : s === "3XL" ? "XXXL" : s;
};
const normName = (s: unknown) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/\b(t-?shirts?|tees?|shirts?|unisex|greys?)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim();

async function rateLimit(req: Request, bucket: string, limit: number) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!(await db.rateHit(bucket + ":" + ip, limit))) throw new PublicError("Too many tries from this connection. Please wait a bit, or call us at " + SHOP_PHONE + ".", 429);
}

// ---------- cart → lines → totals ----------
export function priceLines(cat: Product[], raw: unknown, e: Env): Line[] {
  if (!Array.isArray(raw) || !raw.length) throw new PublicError("Your cart is empty.");
  if (raw.length > MAX_LINES) throw new PublicError("That's a big order — email " + SHOP_EMAIL + " and we'll set it up.");
  const byId = new Map<string, { p: Product; v: Variant }>();
  for (const p of cat) for (const v of p.variants) byId.set(v.id, { p, v });
  const qty = new Map<string, number>();
  const gone: string[] = [];
  for (const r of raw) {
    const id = clean((r as any)?.variant_id, 64);
    const q = Math.floor(Number((r as any)?.qty));
    if (!id || !Number.isFinite(q) || q < 1) throw new PublicError("Please check the quantities in your cart.");
    const hit = byId.get(id);
    if (!hit || (e === "production" && !mapped(hit.v))) { gone.push(id); continue; }
    qty.set(id, (qty.get(id) ?? 0) + q);
  }
  if (gone.length) throw new PublicError("Something in your cart isn't available anymore — please check your cart.", 409, { gone });
  return [...qty.entries()].map(([id, q]) => {
    if (q > MAX_QTY) throw new PublicError(`Up to ${MAX_QTY} of each shirt per order, please.`);
    const { p, v } = byId.get(id)!;
    return { p, v, qty: q };
  });
}
export function shippingFor(s: Settings, lines: Line[]) {
  const n = lines.reduce((a, l) => a + l.qty, 0), sub = lines.reduce((a, l) => a + l.qty * l.v.price_cents, 0);
  if (!n) return 0;
  if (s.free_ship_over_cents > 0 && sub >= s.free_ship_over_cents) return 0;
  return s.ship_first_cents + (n - 1) * s.ship_each_cents;
}
const taxRate = (s: Settings, state: string) => s.tax_rates[state] ?? null;
// Same math as Square for one additive line-item tax (each line rounded half up) — only used when Square can't be asked.
function localTotals(lines: Line[], shipping: number, rate: string | null): Totals {
  const sub = lines.reduce((a, l) => a + l.qty * l.v.price_cents, 0);
  const pct = rate ? Number(rate) / 100 : 0;
  const tax = rate ? lines.reduce((a, l) => a + Math.round(l.qty * l.v.price_cents * pct), 0) + Math.round(shipping * pct) : 0;
  return { subtotal_cents: sub, shipping_cents: shipping, tax_cents: tax, total_cents: sub + shipping + tax };
}
function buildOrder(lines: Line[], shipping: number, rate: string | null, state: string, locationId: string, code: string) {
  const taxed = rate ? { applied_taxes: [{ tax_uid: "tax" }] } : {};
  const line_items: Record<string, unknown>[] = lines.map((l, i) => ({
    uid: "l" + (i + 1), name: `${l.p.name} Tee`, variation_name: l.v.size, quantity: String(l.qty),
    base_price_money: { amount: l.v.price_cents, currency: "USD" }, note: l.v.sku, ...taxed,
  }));
  if (shipping > 0) line_items.push({ uid: "ship", name: "Shipping", quantity: "1", base_price_money: { amount: shipping, currency: "USD" }, ...taxed });
  const order: Record<string, unknown> = { location_id: locationId, source: { name: "Greys shirt shop" }, line_items };
  if (rate) order.taxes = [{ uid: "tax", name: `${state} sales tax`, percentage: rate, type: "ADDITIVE", scope: "LINE_ITEM" }];
  if (code) {
    order.reference_id = code;
    order.metadata = { web_code: code, channel: "shirt-shop" };
  }
  return order;
}
function totalsOf(o: any, shipping: number): Totals {
  const total = Number(o?.total_money?.amount ?? 0), tax = Number(o?.total_tax_money?.amount ?? 0);
  return { subtotal_cents: total - tax - shipping, shipping_cents: shipping, tax_cents: tax, total_cents: total };
}
const lineSummary = (lines: Line[]) => lines.map((l) => ({
  variant_id: l.v.id, sku: l.v.sku, slug: l.p.slug, name: l.p.name, size: l.v.size, qty: l.qty, unit_cents: l.v.price_cents, image: l.p.image_url,
}));

// ---------- customer + address ----------
function readCustomer(c: any): Cust {
  const name = clean(c?.name, 80), email = clean(c?.email, 200).toLowerCase();
  if (name.length < 2) throw new PublicError("Please add your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Please check your email address.");
  const rawPhone = clean(c?.phone, 40);
  const phone = rawPhone ? e164(rawPhone) : null;
  if (rawPhone && !phone) throw new PublicError("Please check your phone number (10 digits), or leave it blank.");
  return { name, email, phone };
}
function readShip(a: any, fallbackName: string): Ship {
  const s: Ship = {
    name: clean(a?.name, 80) || fallbackName, address1: clean(a?.address1, 120), address2: clean(a?.address2, 120),
    city: clean(a?.city, 80), state_code: clean(a?.state_code, 2).toUpperCase(), zip: clean(a?.zip, 10), country_code: "US",
  };
  const country = clean(a?.country_code || "US", 2).toUpperCase();
  if (country !== "US") throw new PublicError("We ship to US addresses only for now.");
  if (!s.address1) throw new PublicError("Please add your street address.");
  if (!s.city) throw new PublicError("Please add your city.");
  if (!US_STATES[s.state_code]) throw new PublicError("Please pick your state.");
  if (!/^\d{5}(-\d{4})?$/.test(s.zip)) throw new PublicError("Please check your ZIP code.");
  return s;
}

// ---------- Printful ----------
function pfItem(l: Line) {
  const base = { quantity: l.qty, retail_price: dollars(l.v.price_cents), name: `${l.p.name} Tee — ${l.v.size}`, external_id: l.v.sku };
  if (l.v.printful_sync_variant_id) return { ...base, sync_variant_id: l.v.printful_sync_variant_id };
  if (l.v.printful_variant_id && l.v.print_file_url) return { ...base, variant_id: l.v.printful_variant_id, files: [{ type: "front", url: l.v.print_file_url }] };
  return null;
}
function pfBody(code: string, cust: Cust, ship: Ship, lines: Line[], t: Totals) {
  const items = lines.map(pfItem);
  if (items.some((x) => !x)) throw new PrintfulError("a shirt in this order isn't set up in Printful yet", -1);
  return {
    external_id: code,
    shipping: "STANDARD",
    recipient: {
      name: ship.name, address1: ship.address1, ...(ship.address2 ? { address2: ship.address2 } : {}), city: ship.city,
      state_code: ship.state_code, country_code: "US", zip: ship.zip, email: cust.email, ...(cust.phone ? { phone: cust.phone } : {}),
    },
    items,
    retail_costs: { currency: "USD", subtotal: dollars(t.subtotal_cents), discount: "0.00", shipping: dollars(t.shipping_cents), tax: dollars(t.tax_cents) },
    packing_slip: { email: SHOP_EMAIL, phone: SHOP_PHONE, message: "Thanks for shopping GREYS Fine Cheeses! Questions? Email " + SHOP_EMAIL + "." },
  };
}
// Make (or refresh) the draft for this checkout. A retry of the same checkout reuses the same external_id.
async function printfulDraft(code: string, cust: Cust, ship: Ship, lines: Line[], t: Totals) {
  const body = pfBody(code, cust, ship, lines, t);
  let existing: any = null;
  try { existing = await printful(`/orders/@${encodeURIComponent(code)}`); } catch (err) {
    if (!(err instanceof PrintfulError) || err.status !== 404) throw err;
  }
  if (existing?.id && existing.status !== "draft") return existing; // already confirmed / in production
  return existing?.id
    ? await printful(`/orders/@${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(body) })
    : await printful("/orders", { method: "POST", body: JSON.stringify(body) });
}
const pfCost = (o: any) => {
  const v = Number(o?.costs?.total);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
};
const addressish = (m: string) => /recipient|address|zip|postal|state|city|country/i.test(m);
// Printful's mode for this checkout: off (don't touch Printful), skip (test order), draft, confirm.
function pfMode(s: Settings, e: Env): Mode | "skip" {
  if (!printfulReady()) return "off";
  if (e === "sandbox") return s.printful_test ? "draft" : "skip";
  return s.printful;
}

// ---------- actions ----------
async function catalogAction(req: Request) {
  const s = await settings(), e = envFor(req, s);
  const [cat, pay] = await Promise.all([catalog(), payConfig(e)]);
  return {
    ok: true, env: e, accepting: !s.paused, message: s.paused ? PAUSED_MSG : null,
    shipping: { first_cents: s.ship_first_cents, each_cents: s.ship_each_cents, free_over_cents: s.free_ship_over_cents },
    tax_states: Object.keys(s.tax_rates),
    states: US_STATES,
    pay,
    products: cat.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, description: p.description, image: p.image_url, price_cents: p.price_cents,
      variants: p.variants.map((v) => ({ id: v.id, size: v.size, price_cents: v.price_cents, available: e === "sandbox" || mapped(v) })),
    })),
  };
}

async function quote(req: Request, b: any) {
  await rateLimit(req, "shirtq", 300);
  const s = await settings(), e = envFor(req, s);
  const lines = priceLines(await catalog(), b.lines, e);
  const state = clean(b.state_code, 2).toUpperCase();
  const st = US_STATES[state] ? state : "";
  const shipping = shippingFor(s, lines), rate = st ? taxRate(s, st) : null;
  let t: Totals;
  try {
    const order = buildOrder(lines, shipping, rate, st, await paymentLocation(e), "");
    const d = await square("/v2/orders/calculate", { method: "POST", body: JSON.stringify({ order }) }, e);
    t = totalsOf(d.order, shipping);
  } catch (err) {
    console.error("quote: Square calculate failed, using local math", String((err as Error).message).slice(0, 200));
    t = localTotals(lines, shipping, rate);
  }
  return { ok: true, env: e, ...t, state_code: st || null, tax_rate: rate, tax_known: !!st, lines: lineSummary(lines) };
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
  await rateLimit(req, "shirt", 12);
  const s = await settings(), e = envFor(req, s);
  if (s.paused) throw new PublicError(PAUSED_MSG, 409);
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("Please re-enter your card.");
  const verificationToken = clean(b.verification_token, 4000);
  const cust = readCustomer(b.customer ?? {});
  const ship = readShip(b.ship_to ?? {}, cust.name);
  const lines = priceLines(await catalog(), b.lines, e);
  const shipping = shippingFor(s, lines), rate = taxRate(s, ship.state_code);
  const locationId = await paymentLocation(e);

  // Same customer + address + cart + checkout attempt → same Square order and code (double-clicks, card retries).
  const sig = JSON.stringify({ a: clean(b.attempt, 80) || crypto.randomUUID(), e, c: cust, s: ship, l: lines.map((l) => [l.v.id, l.qty]), sh: shipping, r: rate });
  const hash = await sha256hex(sig);
  const code = codeFrom(hash);
  const order = buildOrder(lines, shipping, rate, ship.state_code, locationId, code);
  let o = (await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "t-" + hash.slice(0, 60), order }) }, e))?.order;
  if (!o?.id) throw new Error("Square did not return an order");
  for (let i = 0; o.state === "CANCELED" && i < 3; i++) { // swept while the customer was away: start a fresh one
    const old = o.id;
    o = (await square("/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: "t-" + (await sha256hex(hash + "|" + old)).slice(0, 60), order }) }, e))?.order;
    if (!o?.id) throw new Error("Square did not return an order");
    if (o.id !== old) await db.updateOrder({ square_order_id: old }, { square_order_id: o.id, status: "pending", error: null }, true);
  }
  if (o.state === "CANCELED") throw new PublicError("This checkout timed out. Please place your order again. Nothing was charged.", 409);
  const t = totalsOf(o, shipping);

  const prior = await db.orderBySquare(o.id);
  const result = (row: any, emailSent: boolean | null) => ({
    ok: true, env: e, code, ...t, card: row.card ?? null, receipt_url: row.receipt_url ?? null, email_sent: emailSent,
    lines: lineSummary(lines), ship_to: ship, printful_status: row.printful_status ?? null,
  });
  if (prior?.status === "paid") return result(prior, prior.email_sent ?? null); // already paid: never charge twice
  const row = {
    code, shop: SHOP, env: e, status: "pending", error: null, customer_name: cust.name, email: cust.email, phone: cust.phone,
    ship_to: ship, lines: lineSummary(lines), ...t, square_location_id: locationId, square_order_id: o.id,
  };
  if (prior) await db.updateOrder({ id: prior.id }, row, true);
  else await db.insertOrder(row);
  const oid = o.id;
  const fail = (msg: string, extra: Record<string, unknown> = {}) => db.updateOrder({ square_order_id: oid }, { status: "failed", error: msg.slice(0, 500), ...extra }, true);

  if (!(t.total_cents > 0) || t.total_cents > MAX_TOTAL_CENTS) {
    await fail("total out of range");
    throw new PublicError("That order total doesn't look right — please email " + SHOP_EMAIL + ".");
  }
  const expected = Math.round(Number(b.expected_total_cents));
  if (Number.isFinite(expected) && expected > 0 && expected !== t.total_cents) {
    await fail(`total changed: page ${expected}, Square ${t.total_cents}`);
    throw new PublicError(`Your total is now ${money(t.total_cents)} — please review it and place the order again. Nothing was charged.`, 409, { totals: t });
  }

  // Printful draft BEFORE the charge: Printful checks the address and the shirts; a bad address costs nothing.
  const mode = pfMode(s, e);
  let pf: any = prior?.printful_order_id ? { id: prior.printful_order_id, status: prior.printful_status } : null;
  let pfNote: string | null = mode === "off" ? (printfulReady() ? "Printful is switched off" : "Printful isn't connected") : mode === "skip" ? "test order" : null;
  if (mode === "draft" || mode === "confirm") {
    try {
      pf = await printfulDraft(code, cust, ship, lines, t);
      await db.updateOrder({ square_order_id: oid }, { printful_order_id: pf.id ?? null, printful_status: pf.status ?? "draft", printful_cost_cents: pfCost(pf), printful_error: null }, true);
    } catch (err) {
      const msg = String((err as Error).message);
      if (err instanceof PrintfulError && err.status >= 400 && err.status < 500) {
        await fail("printful: " + msg, { printful_error: msg.slice(0, 400) });
        throw new PublicError(
          (addressish(msg) ? "We couldn't ship to that address — please check it." : "We couldn't set that order up with our printer.") +
            " Nothing was charged. Questions? " + SHOP_EMAIL,
          400,
        );
      }
      pf = null;
      pfNote = "not sent: " + msg; // Printful is down (or a shirt isn't mapped): take the sale, send it later
    }
  }

  let pmt: any;
  try {
    const p = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: ("p" + (await sha256hex(oid + "|" + sourceId))).slice(0, 45),
        source_id: sourceId,
        verification_token: verificationToken || undefined,
        amount_money: { amount: t.total_cents, currency: "USD" },
        location_id: locationId,
        order_id: oid,
        reference_id: code,
        buyer_email_address: cust.email,
        shipping_address: {
          address_line_1: ship.address1, ...(ship.address2 ? { address_line_2: ship.address2 } : {}), locality: ship.city,
          administrative_district_level_1: ship.state_code, postal_code: ship.zip, country: "US",
          first_name: ship.name.split(" ")[0], last_name: ship.name.split(" ").slice(1).join(" ") || undefined,
        },
        note: `Shirt shop ${code}`,
        autocomplete: true,
      }),
    }, e);
    pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw Object.assign(new SquareError("payment " + pmt.status), { codes: ["GENERIC_DECLINE"] });
  } catch (err) {
    await fail(String((err as Error).message));
    if (err instanceof SquareError && (err.status < 500 || err.codes.length)) throw new PublicError(cardMessage(err) + " Nothing was charged.", 402);
    throw err;
  }
  const card = pmt.card_details?.card ? `${String(pmt.card_details.card.card_brand || "Card").replace(/_/g, " ")} ····${pmt.card_details.card.last_4}` : null;
  const paidPatch: Record<string, unknown> = {
    status: "paid", square_payment_id: pmt.id ?? null, receipt_url: pmt.receipt_url ?? null, card, error: null, paid_at: new Date().toISOString(),
  };
  if (!pf) paidPatch.printful_status = pfNote?.startsWith("not sent") ? "not sent" : mode === "skip" ? "skipped" : "not sent";
  if (pfNote && !pf) paidPatch.printful_error = pfNote.slice(0, 400);
  await db.updateOrder({ square_order_id: oid }, paidPatch);

  // Confirm with Printful (it prints and ships) — only real orders, only in "confirm" mode.
  let pfStatus = pf ? String(pf.status ?? "draft") : String(paidPatch.printful_status);
  let confirmErr = "";
  if (pf?.id && mode === "confirm" && e === "production" && pf.status === "draft") {
    try {
      const c = await printful(`/orders/${pf.id}/confirm`, { method: "POST" });
      pfStatus = String(c?.status ?? "pending");
      await db.updateOrder({ square_order_id: oid }, { printful_status: pfStatus, printful_cost_cents: pfCost(c) ?? pfCost(pf) });
    } catch (err) {
      confirmErr = String((err as Error).message).slice(0, 380);
      await db.updateOrder({ square_order_id: oid }, { printful_error: "confirm failed: " + confirmErr });
    }
  }
  // Every real order pings Brad, with where it stands in Printful.
  if (e === "production") {
    const where = !pf?.id
      ? `<b>Not in Printful</b> (${esc(pfNote ?? "unknown")}) — send it from Shirt Shop admin (Retry) or the Printful dashboard.`
      : confirmErr ? `Printful draft made, but <b>confirm failed</b>: ${esc(confirmErr)} — confirm it in Printful.`
      : pfStatus === "draft" ? "It's a Printful <b>draft</b> — confirm it in Printful (or Shirt Shop admin) to print it."
      : `Sent to Printful to print (${esc(pfStatus)}).`;
    await alert(`New order ${code} · ${money(t.total_cents)}`,
      `<p><b>${esc(code)}</b> · ${esc(cust.name)} · ${esc(cust.email)} · ${money(t.total_cents)}</p><p>${lines.map((l) => `${l.qty}× ${esc(l.p.name)} · ${esc(l.v.size)}`).join("<br>")}</p>` +
        `<p>Ship to ${esc(ship.city)}, ${esc(ship.state_code)}</p><p>${where}</p>`);
  }

  const out = result({ card, receipt_url: pmt.receipt_url ?? null, printful_status: pfStatus }, null);
  const sent = await mailConfirmation(out, cust).catch((err) => { console.error("mail", code, err); return false; });
  await db.updateOrder({ square_order_id: oid }, { email_sent: sent });
  return { ...out, email_sent: sent };
}

async function status(b: any) {
  const row = await db.orderByCode(clean(b.code, 12).toUpperCase());
  if (!row || row.email !== clean(b.email, 200).toLowerCase() || !["paid", "cancelled"].includes(row.status)) return { ok: false, error: "We couldn't find that order. Check the code and email." };
  return {
    ok: true,
    order: {
      code: row.code, env: row.env, status: row.status, printful_status: row.printful_status, tracking: row.tracking ?? [], lines: row.lines,
      subtotal_cents: row.subtotal_cents, shipping_cents: row.shipping_cents, tax_cents: row.tax_cents, total_cents: row.total_cents,
      created_at: row.created_at, shipped_at: row.shipped_at,
    },
  };
}

// ---------- sweep: cancel what never got paid ----------
async function sweep(b: any) {
  const secret = await db.cronSecret();
  if (!secret || String(b.secret ?? "") !== secret) throw new PublicError("Not allowed.", 401);
  const now = Date.now();
  const sbMin = Math.max(1, Math.min(SWEEP_MINUTES, Math.floor(Number(b.sandbox_minutes)) || SWEEP_MINUTES));
  const rows = await db.sweepRows(new Date(now - sbMin * 60000).toISOString());
  const out = { ok: true, checked: 0, cancelled: [] as string[], kept: [] as string[], errors: [] as string[] };
  for (const r of rows) {
    const e: Env = r.env === "production" ? "production" : "sandbox";
    if (e === "production" && now - Date.parse(r.updated_at) < SWEEP_MINUTES * 60000) continue;
    out.checked++;
    try {
      const o = (await square(`/v2/orders/${encodeURIComponent(r.square_order_id)}`, { method: "GET" }, e))?.order;
      const tenders: any[] = Array.isArray(o?.tenders) ? o.tenders : [];
      const good = tenders.filter((t) => !["FAILED", "VOIDED"].includes(String(t?.card_details?.status ?? "")));
      const due = Number(o?.net_amount_due_money?.amount);
      const paid = good.length > 0 || (Number.isFinite(due) && due <= 0 && Number(o?.total_money?.amount ?? 0) > 0);
      if (o && ((o.state !== "OPEN" && o.state !== "CANCELED") || paid)) {
        await db.updateOrder({ id: r.id }, { error: `sweep: Square shows this order ${o.state}${paid ? " with a payment" : ""} — check it in Square` }, true);
        out.kept.push(r.code);
        continue;
      }
      if (o && o.state === "OPEN") {
        await square(`/v2/orders/${encodeURIComponent(o.id)}`, {
          method: "PUT",
          body: JSON.stringify({ idempotency_key: ("cx-" + o.id + "-" + o.version).slice(0, 190), order: { location_id: o.location_id, version: o.version, state: "CANCELED" } }),
        }, e);
      }
      if (r.printful_order_id && printfulReady()) { // only drafts can be deleted, and unpaid orders are only ever drafts
        try { await printful(`/orders/${r.printful_order_id}`, { method: "DELETE" }); } catch (err) { console.error("sweep printful", r.code, (err as Error).message); }
      }
      await db.updateOrder({ id: r.id }, { status: "cancelled", printful_status: r.printful_order_id ? "canceled" : null, error: `not paid — canceled by the ${SWEEP_MINUTES}-minute sweep` }, true);
      out.cancelled.push(r.code);
    } catch (err) {
      const msg = String((err as Error).message).slice(0, 300);
      await db.updateOrder({ id: r.id }, { error: "sweep: " + msg }, true);
      out.errors.push(r.code + ": " + msg);
    }
  }
  if (out.errors.length) console.error("sweep", out.errors);
  return out;
}

// ---------- Printful → us ----------
async function printfulHook(req: Request, url: URL, body: any) {
  const key = env("PRINTFUL_HOOK_KEY");
  if (!key || url.searchParams.get("key") !== key) throw new PublicError("Not allowed.", 401);
  const type = String(body?.type ?? ""), d = body?.data ?? {}, pfo = d.order ?? {};
  const code = clean(pfo.external_id, 12).toUpperCase();
  const row = (code ? await db.orderByCode(code) : null) ?? (pfo.id ? await db.orderByPrintful(Number(pfo.id)) : null);
  if (!row) return { ok: true, ignored: "no matching order" };
  const at = new Date().toISOString();
  if (type === "package_shipped") {
    const sh = d.shipment ?? {};
    const number = clean(sh.tracking_number, 80);
    const list: any[] = Array.isArray(row.tracking) ? row.tracking : [];
    const isNew = !!number && !list.some((x) => x.number === number);
    const tracking = isNew ? [...list, { carrier: clean(sh.carrier, 40), service: clean(sh.service, 80), number, url: clean(sh.tracking_url, 400), shipped_at: sh.ship_date ?? at }] : list;
    await db.updateOrder({ id: row.id }, { printful_status: "shipped", tracking, shipped_at: row.shipped_at ?? at, printful_error: null });
    if (isNew && row.status === "paid") {
      const sent = await mailShipped(row, tracking[tracking.length - 1]).catch((err) => { console.error("shipped mail", row.code, err); return false; });
      await db.updateOrder({ id: row.id }, { shipped_email_sent: sent });
    }
    return { ok: true, code: row.code, shipped: true };
  }
  const problems: Record<string, string> = { order_failed: "failed", order_canceled: "canceled", order_put_hold: "onhold" };
  if (problems[type]) {
    const reason = clean(d.reason, 400) || clean(pfo.status, 40) || type;
    await db.updateOrder({ id: row.id }, { printful_status: problems[type], printful_error: reason });
    await alert(`Shirt order ${row.code}: Printful ${problems[type]}`, `<p>Printful says order <b>${esc(row.code)}</b> (${esc(row.customer_name)}) is <b>${problems[type]}</b>: ${esc(reason)}</p><p>Check it in the Printful dashboard.</p>`);
    return { ok: true, code: row.code, status: problems[type] };
  }
  if (type === "order_updated" || type === "order_remove_hold" || type === "order_created") {
    if (pfo.status) await db.updateOrder({ id: row.id }, { printful_status: clean(pfo.status, 30), printful_cost_cents: pfCost(pfo) ?? row.printful_cost_cents });
    return { ok: true, code: row.code, status: pfo.status ?? null };
  }
  return { ok: true, ignored: type || "no type" };
}

// ---------- admin: the manager console's signed-in admin (shop-admin.html), or the manager password (curl) ----------
async function checkPass(req: Request, b: any) {
  const pass = env("NOTES_PASS");
  if (pass && String(b.pass ?? "") === pass) return;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token.split(".").length === 3 && (await db.isAdmin(token))) return;
  throw new PublicError("Sign in to the manager console first.", 401);
}
async function adminOrders(req: Request, b: any) {
  await checkPass(req, b);
  const rows = await db.recentOrders(Math.min(200, Math.max(1, Math.floor(Number(b.limit)) || 50)));
  return { ok: true, orders: rows };
}
async function lineFromSaved(l: any): Promise<Line | null> {
  const cat = await catalog();
  for (const p of cat) for (const v of p.variants) if (v.id === l.variant_id) return { p, v, qty: Number(l.qty) || 1 };
  return null;
}
async function adminRetry(req: Request, b: any) {
  await checkPass(req, b);
  catalogCache = null;
  const row = await db.orderByCode(clean(b.code, 12).toUpperCase());
  if (!row || row.status !== "paid") throw new PublicError("No paid order with that code.", 404);
  if (!printfulReady()) throw new PublicError("PRINTFUL_TOKEN isn't set.", 409);
  const lines = (await Promise.all(((row.lines ?? []) as any[]).map(lineFromSaved))).filter(Boolean) as Line[];
  if (lines.length !== (row.lines ?? []).length) throw new PublicError("A shirt in this order isn't in the catalog anymore — send it from the Printful dashboard.", 409);
  const t: Totals = { subtotal_cents: row.subtotal_cents, shipping_cents: row.shipping_cents, tax_cents: row.tax_cents, total_cents: row.total_cents };
  const cust: Cust = { name: row.customer_name, email: row.email, phone: row.phone };
  let pf: any;
  try { pf = await printfulDraft(row.code, cust, row.ship_to as Ship, lines, t); } catch (err) {
    await db.updateOrder({ id: row.id }, { printful_error: String((err as Error).message).slice(0, 400) });
    throw new PublicError("Printful said: " + (err as Error).message, 502);
  }
  const s = await settings();
  let st = String(pf.status ?? "draft");
  if (row.env === "production" && s.printful === "confirm" && st === "draft") st = String((await printful(`/orders/${pf.id}/confirm`, { method: "POST" }))?.status ?? "pending");
  await db.updateOrder({ id: row.id }, { printful_order_id: pf.id, printful_status: st, printful_cost_cents: pfCost(pf), printful_error: null });
  return { ok: true, code: row.code, printful_order_id: pf.id, printful_status: st };
}
async function adminConfirm(req: Request, b: any) {
  await checkPass(req, b);
  const row = await db.orderByCode(clean(b.code, 12).toUpperCase());
  if (!row || row.status !== "paid" || !row.printful_order_id) throw new PublicError("No paid order with a Printful draft under that code.", 404);
  if (row.env !== "production") throw new PublicError("That's a test order — test orders are never sent to print.", 409);
  const c = await printful(`/orders/${row.printful_order_id}/confirm`, { method: "POST" });
  await db.updateOrder({ id: row.id }, { printful_status: String(c?.status ?? "pending"), printful_cost_cents: pfCost(c) ?? row.printful_cost_cents, printful_error: null });
  return { ok: true, code: row.code, printful_status: c?.status ?? "pending" };
}
// Registers our webhook with Printful and reports the store.
async function adminPrintfulSetup(req: Request, b: any) {
  await checkPass(req, b);
  const key = env("PRINTFUL_HOOK_KEY");
  if (!key) throw new PublicError("Set the PRINTFUL_HOOK_KEY secret first (any long random string).", 409);
  const hookUrl = `${SUPABASE_URL}/functions/v1/shirt-shop?action=printful_hook&key=${encodeURIComponent(key)}`;
  const types = ["package_shipped", "order_failed", "order_canceled", "order_put_hold", "order_remove_hold", "order_updated"];
  const hook = await printful("/webhooks", { method: "POST", body: JSON.stringify({ url: hookUrl, types }) });
  let store: any = null;
  try { store = await printful("/store"); } catch (_) { /* account-level token without PRINTFUL_STORE_ID */ }
  return { ok: true, webhook: { url: String(hook?.url ?? "").replace(key, "…"), types: hook?.types ?? types }, store: store ? { id: store.id, name: store.name, type: store.type } : null };
}
// Matches Printful store products to ours by name and size, and saves printful_sync_variant_id.
async function adminPrintfulSync(req: Request, b: any) {
  await checkPass(req, b);
  catalogCache = null;
  const cat = await catalog();
  const listed: any[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await printful(`/store/products?limit=100&offset=${offset}`);
    const arr = Array.isArray(page) ? page : [];
    listed.push(...arr);
    if (arr.length < 100) break;
  }
  const save: { id: string; sync: number }[] = [];
  const report: { product: string; printful: string | null; sizes: Record<string, number | null> }[] = [];
  for (const p of cat) {
    const want = normName(p.name);
    const hit = listed.find((x) => normName(x.name) === want) ?? listed.find((x) => normName(x.name).includes(want));
    const sizes: Record<string, number | null> = {};
    if (hit) {
      const full = await printful(`/store/products/${hit.id}`);
      const svs: any[] = full?.sync_variants ?? [];
      for (const v of p.variants) {
        const sv = svs.find((x) => !x.is_ignored && sizeOf(x.size ?? String(x.name ?? "").split("/").pop()) === v.size);
        sizes[v.size] = sv ? Number(sv.id) : null;
        if (sv) save.push({ id: v.id, sync: Number(sv.id) });
      }
    } else for (const v of p.variants) sizes[v.size] = null;
    report.push({ product: p.name, printful: hit ? String(hit.name) : null, sizes });
  }
  if (b.dry_run !== true) await db.setPrintfulIds(save);
  catalogCache = null;
  return { ok: true, saved: b.dry_run === true ? 0 : save.length, report, printful_products: listed.map((x) => x.name) };
}

// ---------- email (send-mail, like the order site) ----------
async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({ to, subject, html, from: env("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>", replyTo: SHOP_EMAIL }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok !== false;
}
async function alert(subject: string, html: string) {
  try { await sendMail(env("SHIRT_ALERT_EMAIL") || "brad@greyscheese.com", "[Shirt shop] " + subject, html); } catch (err) { console.error("alert", subject, err); }
}
const shell = (body: string, test: boolean) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.5">
  ${test ? `<div style="background:#FDECC8;padding:8px 12px;margin-bottom:14px;font-size:13px"><b>Test order</b> — Square sandbox. No card was charged and nothing will ship.</div>` : ""}
  <div style="font:700 22px Georgia,serif;letter-spacing:.04em;border-bottom:2px solid #E0A21C;padding-bottom:8px;margin-bottom:18px">GREYS <span style="font:400 12px Arial">Fine Cheeses · Shirt Shop</span></div>
  ${body}
  <p style="font-size:13px;color:#6E6353;margin-top:22px">Questions? Reply to this email or write ${SHOP_EMAIL}.</p></div>`;
async function mailConfirmation(r: any, cust: Cust): Promise<boolean> {
  const rows = (r.lines as any[]).map((l) => `<tr><td style="padding:6px 0;width:34px;color:#6E6353">${l.qty}×</td><td style="padding:6px 0"><b>${esc(l.name)}</b> tee · ${esc(l.size)}</td><td style="padding:6px 0;text-align:right">${money(l.unit_cents * l.qty)}</td></tr>`).join("");
  const s = r.ship_to as Ship;
  const html = shell(`<p>Thanks, ${esc(cust.name.split(" ")[0])}! Your shirts are ordered.</p>
  <p style="margin:0 0 6px;color:#6E6353;font-size:13px">Order ${esc(r.code)}</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6DCC6;border-bottom:1px solid #E6DCC6">${rows}</table>
  <table style="width:100%;margin-top:8px;font-size:14px">
    <tr><td>Subtotal</td><td style="text-align:right">${money(r.subtotal_cents)}</td></tr>
    <tr><td>Shipping</td><td style="text-align:right">${r.shipping_cents ? money(r.shipping_cents) : "Free"}</td></tr>
    ${r.tax_cents ? `<tr><td>Tax</td><td style="text-align:right">${money(r.tax_cents)}</td></tr>` : ""}
    <tr><td style="padding-top:6px"><b>Total</b></td><td style="text-align:right;padding-top:6px"><b>${money(r.total_cents)}</b></td></tr>
  </table>
  ${r.card ? `<p style="color:#6E6353;font-size:13px">Paid with ${esc(r.card)}${r.receipt_url ? ` · <a href="${esc(r.receipt_url)}" style="color:#7C1F15">receipt</a>` : ""}</p>` : ""}
  <p style="font-size:14px"><b>Shipping to</b><br>${esc(s.name)}<br>${esc(s.address1)}${s.address2 ? "<br>" + esc(s.address2) : ""}<br>${esc(s.city)}, ${esc(s.state_code)} ${esc(s.zip)}</p>
  <p style="font-size:14px">Every shirt is printed to order, so it usually ships in 2–5 business days. We'll email you the tracking link when it's on the way.</p>`, r.env === "sandbox");
  return sendMail(cust.email, `${r.env === "sandbox" ? "[TEST] " : ""}Your GREYS shirt order ${r.code}`, html);
}
async function mailShipped(row: any, tr: any): Promise<boolean> {
  const html = shell(`<p>Good news, ${esc(String(row.customer_name ?? "").split(" ")[0])} — your GREYS shirts are on the way.</p>
  <p style="font-size:16px"><b>${esc(tr.carrier || "Tracking")}</b>${tr.number ? ` · ${esc(tr.number)}` : ""}</p>
  ${tr.url ? `<p><a href="${esc(tr.url)}" style="display:inline-block;background:#06273A;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold">Track your package</a></p>` : ""}
  <p style="color:#6E6353;font-size:13px">Order ${esc(row.code)}</p>`, row.env === "sandbox");
  return sendMail(row.email, `${row.env === "sandbox" ? "[TEST] " : ""}Your GREYS shirts shipped (${row.code})`, html);
}

// ---------- router ----------
export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    const text = await req.text();
    if (text.length > 100_000) return json(req, { ok: false, error: "Request too large." }, 413);
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* empty */ }
    if (!body || typeof body !== "object") body = {};
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? String(body.action ?? "");
    if (action === "catalog") return json(req, await catalogAction(req));
    if (action === "quote") return json(req, await quote(req, body));
    if (action === "pay") return json(req, await pay(req, body));
    if (action === "status") return json(req, await status(body));
    if (action === "sweep") return json(req, await sweep(body));
    if (action === "printful_hook") return json(req, await printfulHook(req, url, body));
    if (action === "admin_orders") return json(req, await adminOrders(req, body));
    if (action === "admin_retry") return json(req, await adminRetry(req, body));
    if (action === "admin_confirm") return json(req, await adminConfirm(req, body));
    if (action === "admin_printful_setup") return json(req, await adminPrintfulSetup(req, body));
    if (action === "admin_printful_sync") return json(req, await adminPrintfulSync(req, body));
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message, ...(e.extra ?? {}) }, e.status);
    if (e instanceof PrintfulError) return json(req, { ok: false, error: "Printful: " + e.message }, 502);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong on our side and nothing was charged. Please try again, or email ${SHOP_EMAIL} (ref ${ref}).` }, 500);
  }
}

if (!Deno.env.get("SHIRT_SHOP_TEST")) Deno.serve(handle);
