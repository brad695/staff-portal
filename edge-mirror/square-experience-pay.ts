// square-experience-pay — card payments for Experiences (experiences.html on the ticket site).
//
// Experiences are paid reservations. One call does the whole booking, in order:
//   1. rb_create_experience_v2 — creates the reservation (unpaid), prices it (per person,
//                              per table, per 2 guests, or the option they picked) and
//                              claims rb tables (at-home experiences claim none)
//   2. table-holds (hold)    — books the real tables in Wix; no room = stop, nothing charged.
//                              Skipped for at-home experiences (they happen at the guest's place).
//   3. Square /v2/orders     — an itemized order with the experience's catalog item, so the
//                              sale reports under that item. NO fulfillment (Maverick
//                              2026-11-03: experiences never print in the kitchen), so it
//                              never reaches Order Manager or a kitchen printer. Once paid, a
//                              trigger on rb_reservations (rb_experience_lead_sync) opens a
//                              Catering Lead with a BEO for it. If the order can't be built
//                              the charge still goes through without one (square_order_error).
//                              The add-ons they ticked (2026-11-14: chocolate fondue, $12.95 per guest)
//                              ride on that line as priced modifiers, and what the package includes
//                              (rb_experience_types.includes, 2026-11-08) as $0 ones.
//   4. Square /v2/payments   — charges the card token against that order
//   5. marks the reservation paid (external_id = square:<payment id>, square_order_id)
//   6. emails the guest their GREYS confirmation (2026-11-07); never blocks or undoes the booking
// Any failure in steps 2–4 cancels the reservation and releases the Wix tables.
//
// Catalog: each experience gets ONE variable-priced Square item in the "Experiences"
// category, created on first sale and remembered per environment on rb_experience_types
// (square_variation_id / square_sandbox_variation_id).
//
// The charge (2026-11-10): the price + the 20% gratuity + sales tax — every experience says
// "Price does not include sales tax plus 20% gratuity". rb_reservations.total_cents stays the
// price; gratuity_cents, tax_cents and paid_cents (what the card paid) are set at payment.
// See "20% gratuity + sales tax" below.
//
// The browser never sends a price: the price comes from rb_experience_types via
// rb_create_experience_v2 (the browser only says which option, if the experience has options),
// and the add-ons from rb_experience_addons (the browser only sends their keys, `addons`).
// rb_reservations.total_cents = the package + its add-ons (addons / addons_cents say which).
// It does send expected_cents, the total it showed; if that isn't what the server works out,
// nothing is charged and the guest is asked to refresh (so no one pays more than they saw).
//
// Experiences have their OWN Square switch, separate from classes:
//   SQUARE_EXP_ENV            sandbox (default) | production
//   sandbox    → SQUARE_EXP_SANDBOX_ACCESS_TOKEN + SQUARE_EXP_SANDBOX_APP_ID (+ optional
//                SQUARE_EXP_SANDBOX_LOCATION_ID, else the sandbox's first active location)
//   production → the same live SQUARE_TICKET_* app the classes use
// So classes can be live while experiences are still being tested.
//
// Actions (POST ?action=… or {action}): config · pay · status (public)
//                                        cancel · refund (staff — admin JWT)   verify_jwt = false
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE);

const SQUARE_VERSION = "2025-01-23";
const DEFAULT_LOCATION = "LCXWZ0HAQ69RM"; // Greys Memphis
const SHOP_LOCATIONS: Record<string, string> = { memphis: "LCXWZ0HAQ69RM", nashville: "LJ33VDYHS1JAR" };
const MAX_TOTAL_CENTS = 500000;
const DEFAULT_ORIGINS = ["https://tickets.greyscheese.com", "https://ticket-rennet.onrender.com"];
const EXP_CATEGORY = "Experiences";

const env = () => (Deno.env.get("SQUARE_EXP_ENV") ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
type Env = "production" | "sandbox";
const credsFor = (e: Env) => e === "production"
  ? { token: Deno.env.get("SQUARE_TICKET_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_ACCESS_TOKEN"),
      appId: Deno.env.get("SQUARE_TICKET_APP_ID") ?? null, location: Deno.env.get("SQUARE_TICKET_LOCATION_ID") ?? null }
  : { token: Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN"),
      appId: Deno.env.get("SQUARE_EXP_SANDBOX_APP_ID") ?? null, location: Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? null };
const creds = () => credsFor(env());
const baseFor = (e: Env) => e === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
const squareBase = () => baseFor(env());
let RESOLVED: string | null = null;

class PublicError extends Error {}

function corsFor(req: Request) {
  const configured = (Deno.env.get("TICKET_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = configured.length ? configured : DEFAULT_ORIGINS;
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  // the staff portal calls cancel/refund (those check the staff login themselves)
  const staff = /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
  if (origin && (allow.includes(origin) || staff)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

// e = which Square the call goes to; a refund must go to the one that took the payment.
async function square(path: string, init: RequestInit = {}, e: Env = env()) {
  const token = credsFor(e).token;
  if (!token) throw new Error(e === "production" ? "SQUARE_TICKET_ACCESS_TOKEN is not set" : "SQUARE_EXP_SANDBOX_ACCESS_TOKEN is not set");
  const res = await fetch(baseFor(e) + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs = (data as any)?.errors;
    const msg = Array.isArray(errs) && errs.length ? errs.map((e: any) => e.detail || e.code).join("; ") : `Square error (${res.status})`;
    throw Object.assign(new PublicError(msg), { status: res.status, data });
  }
  return data;
}
async function ensureLocation() {
  const explicit = creds().location;
  if (explicit) return (RESOLVED = explicit);
  if (RESOLVED) return RESOLVED;
  if (env() === "production") return (RESOLVED = DEFAULT_LOCATION);
  const d = await square("/v2/locations");
  const list = (d?.locations ?? []) as any[];
  const active = list.find((l) => l.status === "ACTIVE") ?? list[0];
  if (!active?.id) throw new Error("This Square token has no usable location.");
  return (RESOLVED = String(active.id));
}
// Which shop's money: production charges the shop's own Square location; sandbox has one.
async function squareLocationFor(shop: string) {
  const base = await ensureLocation();
  if (env() !== "production") return base;
  return SHOP_LOCATIONS[String(shop || "").toLowerCase()] ?? base;
}

const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

// ---------- 20% gratuity + sales tax (2026-11-10) ----------
// Maverick: the experiences "clearly say add 20% gratuity and tax but it's not being added". The order
// now carries the register's own Square objects, so the sale reports like one rung up in the shop:
//   gratuity — "20% Grat" (7LLRG4S72ZFKTSO7NP72OTKT), an AUTO_GRATUITY service charge; NOT taxable in Square
//   tax      — "TN Standard 9.75%" (2K7XWRVWVXBTAJQIHHQOLFCN), the tax on every Dine In item, both shops
// Their percentages, and whether the gratuity is taxed, are read from Square, so a change made in the
// Square Dashboard reaches the register and these pages alike (config hands them to the pages).
// Square rounds half to even (CalculateOrder 2026-11-10: $350 → $34.12 tax, $2 → $0.20 tax); so does this.
// Sandbox has no such objects: the same figures go on the order as ad-hoc lines.
const LIVE_TAX_ID = Deno.env.get("SQUARE_EXP_TAX_ID") || "2K7XWRVWVXBTAJQIHHQOLFCN";
const LIVE_GRATUITY_ID = Deno.env.get("SQUARE_EXP_GRATUITY_ID") || "7LLRG4S72ZFKTSO7NP72OTKT";
type Rates = {
  tax_pct: string; tax_name: string; tax_id: string | null;
  gratuity_pct: string; gratuity_name: string; gratuity_taxable: boolean; gratuity_id: string | null;
};
const FALLBACK_RATES: Rates = {
  tax_pct: "9.75", tax_name: "TN Standard 9.75%", tax_id: null,
  gratuity_pct: "20", gratuity_name: "20% Gratuity", gratuity_taxable: false, gratuity_id: null,
};
let RATES: { at: number; v: Rates } | null = null;
async function ratesFor(e: Env, fresh = false): Promise<Rates> {
  if (e !== "production") return FALLBACK_RATES;
  if (!fresh && RATES && Date.now() - RATES.at < 5 * 60_000) return RATES.v;
  const d = await square("/v2/catalog/batch-retrieve", { method: "POST", body: JSON.stringify({ object_ids: [LIVE_TAX_ID, LIVE_GRATUITY_ID] }) }, e);
  const objs = ((d as any)?.objects ?? []) as any[];
  const t = objs.find((o) => o.id === LIVE_TAX_ID && !o.is_deleted)?.tax_data;
  const g = objs.find((o) => o.id === LIVE_GRATUITY_ID && !o.is_deleted)?.service_charge_data;
  if (!t || t.enabled === false || t.inclusion_type !== "ADDITIVE" || !(Number(t.percentage) > 0)) throw new Error("the experience tax is missing in Square");
  if (!g || !(Number(g.percentage) > 0)) throw new Error("the experience gratuity is missing in Square");
  const v: Rates = {
    tax_pct: String(t.percentage), tax_name: String(t.name || "Sales tax"), tax_id: LIVE_TAX_ID,
    gratuity_pct: String(g.percentage), gratuity_name: String(g.name || "Gratuity"), gratuity_taxable: g.taxable === true, gratuity_id: LIVE_GRATUITY_ID,
  };
  RATES = { at: Date.now(), v };
  return v;
}
// pct ("9.75", "20.0") of an amount in cents, rounded half to even — Square's rounding
function pctOf(cents: number, pct: string) {
  const ppm = Math.round(Number(pct) * 10000); // 9.75% → 97500 parts per million
  const n = cents * ppm, q = Math.floor(n / 1000000), r = n - q * 1000000;
  return 2 * r > 1000000 ? q + 1 : 2 * r < 1000000 ? q : q + (q % 2);
}
type Priced = { price_cents: number; gratuity_cents: number; tax_cents: number; total_cents: number };
function priceWith(price: number, R: Rates): Priced {
  const gratuity = pctOf(price, R.gratuity_pct);
  const tax = pctOf(price + (R.gratuity_taxable ? gratuity : 0), R.tax_pct);
  return { price_cents: price, gratuity_cents: gratuity, tax_cents: tax, total_cents: price + gratuity + tax };
}
const pricingOut = (R: Rates) => ({ tax_pct: R.tax_pct, tax_name: R.tax_name, gratuity_pct: R.gratuity_pct, gratuity_taxable: R.gratuity_taxable });

async function rateLimit(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { data, error } = await admin.rpc("ticket_rate_hit", { p_bucket: ("xp:" + ip).slice(0, 200), p_limit: 12, p_window_secs: 3600 });
  if (!error && data === false) throw new PublicError("Too many payment attempts from this connection. Please try again later, or call the shop.");
}

async function tableHolds(action: string, body: Record<string, unknown>) {
  const r = await fetch(SUPABASE_URL + "/functions/v1/table-holds?action=" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.ok !== false, data: d };
}

async function cancelReservation(id: string) {
  await admin.from("rb_reservations").update({ status: "cancelled" }).eq("id", id).neq("payment_status", "paid");
  await tableHolds("release", { source: "experience", source_id: id }).catch(() => null);
}

// ---------- Square catalog + itemized order (no fulfillment: nothing prints) ----------
async function ensureCategory(): Promise<string | null> {
  const d = await square("/v2/catalog/search", {
    method: "POST",
    body: JSON.stringify({ object_types: ["CATEGORY"], query: { exact_query: { attribute_name: "name", attribute_value: EXP_CATEGORY } } }),
  });
  const hit = ((d?.objects ?? []) as any[]).find((o) => !o.is_deleted);
  if (hit?.id) return String(hit.id);
  const c = await square("/v2/catalog/object", {
    method: "POST",
    body: JSON.stringify({ idempotency_key: crypto.randomUUID(), object: { type: "CATEGORY", id: "#exp_cat", category_data: { name: EXP_CATEGORY } } }),
  });
  return c?.catalog_object?.id ?? null;
}

// The variable-priced variation for this experience in the current Square env; created on first use.
async function ensureVariation(expId: string): Promise<string> {
  const col = env() === "production" ? "square_variation_id" : "square_sandbox_variation_id";
  const { data: x, error } = await admin.from("rb_experience_types").select("id, name, square_variation_id, square_sandbox_variation_id").eq("id", expId).single();
  if (error || !x) throw new Error("experience not found for catalog item");
  const known = (x as any)[col] as string | null;
  if (known) {
    try {
      const o = await square(`/v2/catalog/object/${encodeURIComponent(known)}`);
      if (o?.object && !o.object.is_deleted) return known;
    } catch { /* deleted in Square — make a new one */ }
  }
  const cat = await ensureCategory().catch(() => null);
  const d = await square("/v2/catalog/object", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      object: {
        type: "ITEM", id: "#exp_item", present_at_all_locations: true,
        item_data: {
          name: `Experience – ${(x as any).name}`.slice(0, 255),
          description: "Booked and paid online (tickets.greyscheese.com/experiences).",
          product_type: "REGULAR",
          ...(cat ? { categories: [{ id: cat }], reporting_category: { id: cat } } : {}),
          variations: [{
            type: "ITEM_VARIATION", id: "#exp_var", present_at_all_locations: true,
            item_variation_data: { name: "Reservation", pricing_type: "VARIABLE_PRICING" },
          }],
        },
      },
    }),
  });
  const v = d?.catalog_object?.item_data?.variations?.[0]?.id;
  if (!v) throw new Error("Square did not return a variation id");
  await admin.from("rb_experience_types").update({ [col]: v }).eq("id", expId);
  return String(v);
}

const fmtCT = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The add-ons they took (2026-11-14, Jackie: "add a chocolate fondue to any experience for $12.95 per person").
// rb_reservations.addons = [{label, price_cents, qty, …}] as rb_experience_addons priced them. They ride on the
// experience's own line as priced modifiers: one line, so Square taxes exactly the amount charged here (two lines
// can each round their tax and land a cent apart).
function addonModifiers(r: any) {
  return (Array.isArray(r?.addons) ? r.addons : [])
    .map((a: any) => ({ name: clean(a?.label, 255) || "Add-on", quantity: String(Math.max(1, Math.floor(Number(a?.qty) || 1))),
      base_price_money: { amount: Math.max(0, Math.round(Number(a?.price_cents) || 0)), currency: "USD" } }))
    .filter((m: any) => m.base_price_money.amount > 0)
    .slice(0, 10);
}
const addonsTotal = (mods: any[]) => mods.reduce((s, m) => s + m.base_price_money.amount * Number(m.quantity), 0);

// What's in the package (Maverick 2026-11-08: "experience packages need to have items listed being
// sold"). rb_experience_types.includes = [{item, per?: "party" | "guest"}], edited in the manager
// console. Each item rides on the sale as a $0 modifier, so the Square order and receipt list it and
// the total doesn't move; "per guest" counts the party (one raclette burner each). The BEO gets the
// same list from rb_experience_lead_sync.
function includedModifiers(r: any) {
  const list = r?.rb_experience_types?.includes;
  const party = Math.max(1, Math.floor(Number(r?.party_size) || 1));
  return (Array.isArray(list) ? list : [])
    .map((x: any) => ({ name: clean(x?.item, 255), per: x?.per }))
    .filter((x: any) => x.name)
    .slice(0, 30)
    .map((x: any) => ({ name: x.name, quantity: x.per === "guest" ? String(party) : "1", base_price_money: { amount: 0, currency: "USD" } }));
}

async function createOrder(key: string, code: string, P: Priced, R: Rates, r: any, location_id: string): Promise<string> {
  const varId = await ensureVariation(r.experience_type_id);
  const when = fmtCT(r.starts_at);
  // the option they picked, and where an at-home party is — shows on the sale in Square
  const extra = [r.option_label, r.event_address ? "AT: " + r.event_address : null].filter(Boolean).join(" · ");
  // the line = the package, plus each add-on as a priced modifier: together they are the price charged
  let paid = addonModifiers(r);
  if (addonsTotal(paid) > P.price_cents) paid = [];
  const base = P.price_cents - addonsTotal(paid);
  const included = includedModifiers(r);
  const build = (k: string, withItems: boolean) => square("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: k,
      order: {
        location_id,
        reference_id: code,
        source: { name: "GREYS Experiences" },
        line_items: [{
          catalog_object_id: varId,
          quantity: "1",
          base_price_money: { amount: base, currency: "USD" },
          note: [`Party of ${r.party_size} · ${when} · ${code}`, extra].filter(Boolean).join(" · ").slice(0, 2000),
          ...(paid.length || (withItems && included.length) ? { modifiers: [...paid, ...(withItems ? included : [])] } : {}),
        }],
        // sales tax on the experience, and the 20% gratuity: the register's own objects in production
        taxes: [R.tax_id
          ? { uid: "tax", catalog_object_id: R.tax_id, scope: "ORDER" }
          : { uid: "tax", name: R.tax_name, percentage: R.tax_pct, type: "ADDITIVE", scope: "ORDER" }],
        service_charges: [R.gratuity_id
          ? { uid: "gratuity", catalog_object_id: R.gratuity_id }
          : { uid: "gratuity", name: R.gratuity_name, percentage: R.gratuity_pct, calculation_phase: "SUBTOTAL_PHASE", taxable: R.gratuity_taxable }],
        // no fulfillments: an order without one never goes to Order Manager / the kitchen printer
      },
    }),
  });
  let d: any;
  try { d = await build(key, true); }
  catch (e) {
    // Square turned the item list down: still make the itemized sale (with the priced add-ons), just without the list
    if (!included.length || (e as any)?.status !== 400) throw e;
    console.error("order items", code, String((e as Error).message || e).slice(0, 300));
    d = await build(key.slice(0, 40) + ":plain", false);
  }
  const o = d?.order;
  if (!o?.id) throw new Error("Square did not return an order");
  const total = Number(o.total_money?.amount);
  if (total !== P.total_cents) throw new Error(`Square order total ${total} does not match ${P.total_cents}`);
  return String(o.id);
}

// <confirm-email> ---------- the guest's confirmation, once the card is charged (2026-11-07) ----------
// Maverick: the inquiry form and the pay pages say "Your confirmation comes by email", but only
// Square's receipt went out. Same brand chrome as the inquiries / catering emails (2026-10-12):
// cream canvas, white card, navy header with the GREYS wordmark and a gold rule, gold button.
const CF = { NAVY: "#06273A", GOLD: "#e6b33c", INK: "#221E1B", MUTE: "#6E6353", CREAM: "#F6F1E7", LINE: "#E6DFD0" };
const SHOP_INFO: Record<string, { name: string; street: string; city: string; phone: string }> = {
  memphis: { name: "GREYS Memphis", street: "709 S Mendenhall Rd", city: "Memphis, TN 38117", phone: "(901) 440-4739" },
  nashville: { name: "GREYS Nashville", street: "4101 Charlotte Ave, Suite D130", city: "Nashville, TN 37209", phone: "(615) 900-4739" },
};
const cfEsc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const cfMoney = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");
const cfSp = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
const cfWhen = (iso: string) => cfSp(new Date(iso).toLocaleString("en-US",
  { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
const cfDay = (iso: string) => cfSp(new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric" }));
const cfTime = (iso: string) => cfSp(new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }));
type ConfirmInfo = {
  first: string; experience: string; option: string | null; startsAt: string; party: number; shop: string;
  atHome: boolean; address: string | null; totalCents: number; card: string | null; code: string;
  notes: string | null; receiptUrl: string | null; infoUrl: string | null; test: boolean;
  // what the total is made of (2026-11-10): the package (priceCents), the add-ons, the gratuity and the tax
  priceCents?: number; gratuityCents?: number; taxCents?: number; gratuityPct?: string;
  addons?: { label: string; qty: number; total_cents: number }[];
};
function confirmationEmail(d: ConfirmInfo) {
  const shop = SHOP_INFO[String(d.shop || "").toLowerCase()] ?? SHOP_INFO.memphis;
  const what = d.experience + (d.option ? " · " + d.option.split(" · ")[0] : "");
  const row = (k: string, v: string) =>
    `<tr><td style="padding:8px 16px 8px 0;font:13px/1.45 Arial,sans-serif;color:${CF.MUTE};white-space:nowrap;vertical-align:top">${k}</td>` +
    `<td style="padding:8px 0;font:15px/1.45 Georgia,'Times New Roman',serif;color:${CF.INK}">${v}</td></tr>`;
  const where = d.atHome
    ? `Your place: ${cfEsc(d.address || "the address you gave us")}<br><span style="font:13px/1.5 Arial,sans-serif;color:${CF.MUTE}">Our cheesemonger arrives an hour early to set up.</span>`
    : `<b>${cfEsc(shop.name)}</b><br><span style="font:13px/1.5 Arial,sans-serif;color:${CF.MUTE}">${cfEsc(shop.street)}<br>${cfEsc(shop.city)}</span>`;
  const button = (href: string, label: string) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="background:${CF.GOLD};border-radius:3px">` +
    `<a href="${cfEsc(href)}" style="display:inline-block;padding:13px 26px;font:700 13px/1 'League Spartan',Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${CF.NAVY};text-decoration:none">${cfEsc(label)}</a></td></tr></table>`;
  const inner =
    (d.test ? `<p style="margin:0 0 18px;padding:9px 12px;background:#FFF4D6;border:1px solid ${CF.GOLD};font:700 11.5px/1.4 Arial,sans-serif;letter-spacing:.06em;color:#8A6512">TEST MODE &middot; Square sandbox &mdash; no real card was charged</p>` : "") +
    `<p style="margin:0 0 6px;font:700 11px/1.4 Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#8A6512">You're booked</p>` +
    `<h1 style="margin:0 0 16px;font:400 27px/1.2 Georgia,'Times New Roman',serif;color:${CF.NAVY}">${cfEsc(what)}</h1>` +
    `<p style="margin:0 0 14px">Hi ${cfEsc(d.first || "there")}, thanks for booking with us! Here are your details:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid ${CF.LINE};border-bottom:1px solid ${CF.LINE};margin:0 0 4px">` +
    row("When", `${cfEsc(cfDay(d.startsAt))} at <span style="white-space:nowrap">${cfEsc(cfTime(d.startsAt))}</span>`) +
    row("Where", where) +
    row("Guests", String(d.party)) +
    ((d.addons || []).length ? row("Add-ons", (d.addons || []).map((a) => cfEsc(a.label) + (a.qty > 1 ? " for " + a.qty : "")).join("<br>")) : "") +
    row("Paid", cfEsc(cfMoney(d.totalCents)) + (d.card ? ` <span style="font:13px Arial,sans-serif;color:${CF.MUTE}">(${cfEsc(d.card)})</span>` : "") +
      (d.priceCents != null && (d.gratuityCents || d.taxCents)
        ? `<br><span style="font:13px/1.5 Arial,sans-serif;color:${CF.MUTE}">${cfEsc(cfMoney(d.priceCents))}` +
          (d.addons || []).map((a) => ` + ${cfEsc(a.label.toLowerCase())} ${cfEsc(cfMoney(a.total_cents))}`).join("") +
          ` + ${cfEsc(String(Number(d.gratuityPct || 20)))}% gratuity ${cfEsc(cfMoney(d.gratuityCents || 0))} + sales tax ${cfEsc(cfMoney(d.taxCents || 0))}</span>`
        : "")) +
    row("Confirmation", `<b>${cfEsc(d.code)}</b>`) +
    (d.notes ? row("Your notes", cfEsc(d.notes)) : "") +
    `</table>` +
    (d.receiptUrl ? button(d.receiptUrl, "View your receipt") : "") +
    (d.infoUrl ? `<p style="margin:12px 0 0;font:14px/1.5 Arial,sans-serif"><a href="${cfEsc(d.infoUrl)}" style="color:${CF.NAVY}">More about the ${cfEsc(d.experience)} &rarr;</a></p>` : "") +
    `<p style="margin:20px 0 0">Need to change or cancel? Just reply to this email or call ${d.atHome ? "us" : "the shop"} at <span style="white-space:nowrap">${cfEsc(shop.phone)}</span>.</p>` +
    `<p style="margin:14px 0 0">See you soon!<br>GREYS Fine Cheeses</p>`;
  const html =
    `<div style="background:${CF.CREAM};padding:28px 12px;font-family:Georgia,'Times New Roman',serif;color:${CF.INK}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid ${CF.LINE};border-collapse:separate">
      <tr><td style="background:${CF.NAVY};padding:24px 24px 18px;border-bottom:4px solid ${CF.GOLD}">
        <div style="font:800 30px/1 'League Spartan','Arial Black',Arial,sans-serif;letter-spacing:.12em;color:#FFFFFF">GREYS</div>
        <div style="font:700 10.5px/1.4 'League Spartan',Arial,sans-serif;letter-spacing:.22em;color:${CF.GOLD};margin-top:7px;text-transform:uppercase">Fine Cheeses &nbsp;&middot;&nbsp; Charcuterie &nbsp;&middot;&nbsp; Wine</div>
      </td></tr>
      <tr><td style="padding:28px 24px 10px;font-size:16px;line-height:1.6;color:${CF.INK}">${inner}</td></tr>
      <tr><td style="padding:18px 24px 24px">
        <div style="height:1px;background:${CF.LINE};margin-bottom:18px"></div>
        <p style="margin:0;font:11.5px/1.7 Arial,sans-serif;color:${CF.MUTE};letter-spacing:.02em">
          <b style="color:${CF.NAVY}">GREYS Fine Cheeses</b><br>
          Memphis (901) 440-4739 &nbsp;&middot;&nbsp; Nashville (615) 900-4739<br>
          <a href="https://greyscheese.com" style="color:${CF.NAVY};text-decoration:none">greyscheese.com</a>
        </p>
      </td></tr>
    </table></div>`;
  const subject = (d.test ? "[TEST] " : "") + `You're booked: ${what} at ${d.atHome ? "your place" : shop.name}, ${cfWhen(d.startsAt)} (${d.code})`;
  return { subject, html };
}
// </confirm-email>
async function sendConfirmation(to: string, mail: { subject: string; html: string }) {
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({ to, subject: mail.subject, html: mail.html,
      from: Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>",
      replyTo: Deno.env.get("INQUIRY_REPLY_TO") || "info@greyscheese.com" }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && (d as any).ok ? "sent" : "failed";
}

// ---------- actions ----------
async function config() {
  let reachable = false, reach_error: string | null = null;
  try { await ensureLocation(); reachable = true; } catch (e) { reach_error = String((e as Error).message).slice(0, 300); }
  // the 20% gratuity and the sales tax the pages add to the price (pay works it out the same way)
  let R: Rates;
  try { R = await ratesFor(env()); } catch (e) { console.error("rates", e); R = RATES?.v ?? FALLBACK_RATES; }
  return {
    ok: true,
    app_id: creds().appId,
    location_id: RESOLVED,
    env: env(),
    script_src: env() === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js",
    reachable, reach_error,
    pricing: pricingOut(R),
  };
}

async function pay(req: Request, b: Record<string, unknown>) {
  await rateLimit(req);
  const sourceId = clean(b.source_id, 400);
  if (!/^[A-Za-z0-9_\-:.]{8,400}$/.test(sourceId)) throw new PublicError("No card token — please re-enter the card.");
  const verificationToken = clean(b.verification_token, 4000);
  const shop = clean(b.location, 40) || "Memphis";
  const email = clean(b.email, 200);
  const name = (clean(b.first_name, 80) + " " + clean(b.last_name, 80)).trim();
  // the add-ons they ticked, as keys (2026-11-14: chocolate fondue). Not sent at all (an older copy of a page):
  // a held slot keeps the add-ons it was held with, a fresh booking takes none.
  const addonKeys: string[] | null = Array.isArray(b.addons)
    ? [...new Set((b.addons as unknown[]).map((k) => clean(k, 40)).filter(Boolean))].slice(0, 10) : null;

  // 1. the reservation (server decides price, validates party / time / tables).
  //    A link from an inquiry carries hold=<id>&hc=<code>: that slot is already held
  //    for them (status 'pending'), so pay for it instead of claiming a new one.
  let res: any = null, fromHold = false, lapsedInquiry: string | null = null;
  const holdId = clean(b.hold, 64), holdCode = clean(b.hold_code, 20).toUpperCase();
  if (holdId && holdCode) {
    const { data: h } = await admin.from("rb_reservations")
      .select("id, code, status, payment_status, hold_expires_at, total_cents, starts_at, inquiry_id, option_label, rb_experience_types(name)")
      .eq("id", holdId).eq("code", holdCode).eq("kind", "experience").maybeSingle();
    if (h && h.payment_status === "paid") throw new PublicError("This reservation is already paid — check your email for the confirmation.");
    if (h && h.status === "pending" && Date.parse(h.hold_expires_at || "") > Date.now()) {
      await admin.from("rb_reservations").update({
        guest_name: name || undefined, email: email.toLowerCase() || undefined, phone: clean(b.phone, 40) || undefined,
      }).eq("id", h.id);
      // their own notes go after the option / address line the hold already carries
      const extra = clean(b.notes, 1000);
      if (extra) {
        const { data: cur } = await admin.from("rb_reservations").select("notes").eq("id", h.id).single();
        await admin.from("rb_reservations").update({ notes: [cur?.notes, extra].filter(Boolean).join(" · ").slice(0, 2000) }).eq("id", h.id);
      }
      res = { ok: true, id: h.id, code: h.code, total_cents: h.total_cents, experience: (h as any).rb_experience_types?.name,
        time: fmtCT(h.starts_at), option_label: h.option_label };
      fromHold = true;
    }
    // expired or released hold: free it, then book the same slot fresh if it's still open
    else if (h && h.status === "pending") await admin.from("rb_reservations").update({ status: "cancelled" }).eq("id", h.id).neq("payment_status", "paid");
    if (!fromHold && h && h.inquiry_id) lapsedInquiry = h.inquiry_id;
  }
  if (!res) {
    const { data, error } = await admin.rpc("rb_create_experience_v2", {
      p_experience: clean(b.experience_id, 64), p_date: clean(b.date, 10), p_time: clean(b.time, 5),
      p_party: Math.floor(Number(b.party) || 0), p_name: name, p_email: email, p_phone: clean(b.phone, 40),
      p_notes: clean(b.notes, 1000), p_location: shop,
      p_option: clean(b.option, 40) || null, p_address: clean(b.address, 300) || null,
    });
    if (error) throw new Error(error.message);
    res = data;
  }
  if (!res || res.ok === false) throw new PublicError((res && res.error) || "That time is no longer available.");
  const rid = String(res.id), code = String(res.code);
  let price = Math.round(Number(res.total_cents) || 0);
  // a failed payment on a held slot keeps the hold; a fresh booking is cancelled
  const undo = async () => { if (fromHold) await admin.from("rb_reservations").update({ status: "pending" }).eq("id", rid).neq("payment_status", "paid"); else await cancelReservation(rid); };
  // the add-ons, priced here (rb_experience_addons) and kept on the booking: total_cents = the package + add-ons
  if (addonKeys) {
    const { data: cur } = await admin.from("rb_reservations").select("experience_type_id, party_size, total_cents, addons_cents").eq("id", rid).single();
    const pkg = Math.round(Number(cur?.total_cents) || 0) - Math.round(Number(cur?.addons_cents) || 0);
    const { data: q, error: qe } = await admin.rpc("rb_experience_addons", { p_experience: cur?.experience_type_id, p_party: cur?.party_size, p_keys: addonKeys });
    if (qe || !q || q.ok === false) {
      await undo();
      throw new PublicError((q && q.error) || "We couldn't add that add-on. Refresh the page and try again. Nothing was charged.");
    }
    const cents = Math.round(Number(q.cents) || 0);
    const { error: ue } = await admin.from("rb_reservations").update({ addons: q.items, addons_cents: cents, total_cents: pkg + cents }).eq("id", rid);
    if (ue) { await undo(); throw new Error(ue.message); }
    price = pkg + cents;
  }
  if (!(price > 0) || price > MAX_TOTAL_CENTS) { await undo(); throw new PublicError("That price doesn't look right — please call the shop."); }

  // the charge: price + 20% gratuity + sales tax, with the rates as Square has them right now
  let R: Rates;
  try { R = await ratesFor(env(), true); } catch (e) { console.error("rates", rid, e); R = RATES?.v ?? FALLBACK_RATES; }
  const P = priceWith(price, R), amount = P.total_cents;
  // never charge a total the guest wasn't shown (an old copy of the page showed the price alone)
  const shown = Math.round(Number(b.expected_cents) || 0);
  if (shown !== amount) {
    await undo();
    throw new PublicError(shown
      ? `The total is ${cfMoney(amount)} with the ${Number(R.gratuity_pct)}% gratuity and sales tax. Please refresh the page to see it, then pay. Nothing was charged.`
      : "This page needs a refresh: the total now shows the 20% gratuity and sales tax. Refresh it and try again. Nothing was charged.");
  }
  if (amount > MAX_TOTAL_CENTS) { await undo(); throw new PublicError("That price doesn't look right — please call the shop."); }

  // one key per card attempt: a declined card on a held slot can be retried with a new card
  const attempt = rid + ":" + sourceId.slice(-16);

  try {
    // 2. real tables in Wix (an at-home experience happens at their place: no tables)
    const { data: r } = await admin.from("rb_reservations")
      .select("experience_type_id, starts_at, ends_at, party_size, location, guest_name, email, phone, option_label, event_address, addons, addons_cents, rb_experience_types(name, at_home, info_url, includes)").eq("id", rid).single();
    const atHome = !!(r as any)?.rb_experience_types?.at_home;
    if (!atHome) {
      const hold = await tableHolds("hold", {
        source: "experience", source_id: rid, location: r?.location || shop,
        start: r?.starts_at, end: r?.ends_at, guests: r?.party_size,
        label: (((r as any)?.rb_experience_types?.name || "Experience") + " – " + (r?.guest_name || "")).trim(),
      });
      if (!hold.ok) throw new PublicError("Sorry — that time just filled up. Please pick another time. Nothing was charged.");
    }

    const location_id = await squareLocationFor(r?.location || shop);

    // 3. Square order (itemized sale, no kitchen ticket). Never blocks the booking.
    let orderId: string | null = null, orderError: string | null = null;
    try { orderId = await createOrder(attempt.slice(0, 45) + ":o", code, P, R, r, location_id); }
    catch (e) { orderError = String((e as Error).message || e).slice(0, 500); console.error("order", rid, orderError); }

    // 4. charge
    const p = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: attempt.slice(0, 45),
        source_id: sourceId,
        verification_token: verificationToken || undefined,
        amount_money: { amount, currency: "USD" },
        location_id,
        order_id: orderId || undefined,
        reference_id: code,
        buyer_email_address: email || undefined,
        note: [`${res.experience || "Experience"} · ${res.time || ""} · party of ${r?.party_size} · ${code}`, r?.option_label].filter(Boolean).join(" · ").slice(0, 500),
        autocomplete: true,
      }),
    });
    const pmt = p?.payment ?? {};
    if (pmt.status !== "COMPLETED" && pmt.status !== "APPROVED") throw new PublicError("The card was not approved.");

    // 5. paid (a held slot becomes a normal confirmed booking)
    //    (one update: the trigger that opens the Catering Lead + BEO reads paid_cents from it)
    const paidPatch = {
      payment_status: "paid", status: "confirmed", hold_expires_at: null, external_id: "square:" + pmt.id, payment_env: env(),
      square_order_id: orderId, square_order_error: orderError,
    };
    const up = await admin.from("rb_reservations")
      .update({ ...paidPatch, gratuity_cents: P.gratuity_cents, tax_cents: P.tax_cents, paid_cents: P.total_cents }).eq("id", rid);
    // the card is charged: the booking must end up paid even if the breakdown can't be stored
    if (up.error) { console.error("paid update", rid, up.error.message); await admin.from("rb_reservations").update(paidPatch).eq("id", rid); }
    if (fromHold) await admin.from("inquiries").update({ stage: "booked", hold_expires_at: null }).eq("reservation_id", rid);
    else if (lapsedInquiry) { // their hold had run out but they still booked: keep the booking tied to its conversation
      await admin.from("rb_reservations").update({ inquiry_id: lapsedInquiry }).eq("id", rid);
      await admin.from("inquiries").update({ stage: "booked", hold_expires_at: null, reservation_id: rid, reservation_code: code }).eq("id", lapsedInquiry);
    }
    const card = pmt.card_details?.card ? `${pmt.card_details.card.card_brand} ····${pmt.card_details.card.last_4}` : null;
    // what was booked: the package, then each add-on (2026-11-14)
    const adds = (Array.isArray((r as any)?.addons) ? (r as any).addons : [])
      .map((a: any) => ({ key: String(a?.key || ""), label: String(a?.label || "Add-on"), qty: Math.max(1, Math.floor(Number(a?.qty) || 1)),
        price_cents: Math.round(Number(a?.price_cents) || 0), total_cents: Math.round(Number(a?.total_cents) || 0) }));
    const addCents = Math.round(Number((r as any)?.addons_cents) || 0);
    const pkgCents = P.price_cents - addCents;

    // 6. the guest's confirmation email. The booking is paid by now, so nothing here may throw
    //    into the catch below (that would release the tables of a paid booking).
    let confirm_email = "skipped";
    try {
      const to = String(r?.email || email || "").trim();
      if (to) {
        const x = (r as any)?.rb_experience_types || {};
        const mail = confirmationEmail({
          first: String(r?.guest_name || name || "").split(/\s+/)[0], experience: x.name || res.experience || "Experience",
          option: r?.option_label || null, startsAt: String(r?.starts_at), party: Number(r?.party_size) || 0,
          shop: String(r?.location || shop), atHome, address: r?.event_address || null, totalCents: amount, card, code,
          notes: clean(b.notes, 1000) || null, receiptUrl: pmt.receipt_url ?? null, infoUrl: /^https:\/\//i.test(x.info_url || "") ? x.info_url : null,
          test: env() !== "production",
          priceCents: pkgCents, gratuityCents: P.gratuity_cents, taxCents: P.tax_cents, gratuityPct: R.gratuity_pct, addons: adds,
        });
        const sending = sendConfirmation(to, mail).catch((e) => { console.error("confirm mail", rid, e); return "failed"; });
        const rt = (globalThis as any).EdgeRuntime;
        if (rt && typeof rt.waitUntil === "function") { rt.waitUntil(sending); confirm_email = "queued"; }
        else confirm_email = String(await Promise.race([sending, new Promise((ok) => setTimeout(() => ok("slow"), 8000))]));
      }
    } catch (e) { console.error("confirm mail", rid, e); confirm_email = "failed"; }

    return {
      ok: true, id: rid, code, experience: res.experience, time: res.time, total_cents: amount,
      price_cents: P.price_cents, gratuity_cents: P.gratuity_cents, tax_cents: P.tax_cents, pricing: pricingOut(R),
      package_cents: pkgCents, addons: adds, addons_cents: addCents,
      party: r?.party_size, option_label: r?.option_label || null, at_home: atHome, card,
      receipt_url: pmt.receipt_url ?? null, confirm_email,
    };
  } catch (e) {
    await undo();
    throw e;
  }
}

// ---------- staff: cancel / refund ----------
const MASTER_EMAIL = "bbearo@gmail.com";
async function staffEmail(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.startsWith("sb_publishable_")) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  const email = (data.user?.email || "").toLowerCase();
  if (!email) return null;
  if (email === MASTER_EMAIL) return email;
  const { data: row } = await admin.from("app_users").select("email").eq("status", "approved").ilike("email", email).maybeSingle();
  return row ? email : null;
}
const esc = (s: string) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
async function mailGuest(r: any, refundCents: number, reason: string) {
  if (!r.email) return "no email";
  const exp = r.rb_experience_types?.name || "experience";
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.55">
    <div style="font:700 22px Georgia,serif;letter-spacing:.04em;border-bottom:2px solid #E0A21C;padding-bottom:8px;margin-bottom:18px">GREYS <span style="font:400 12px Arial">Fine Cheeses · Charcuterie · Wine</span></div>
    <p>Hi ${esc(String(r.guest_name || "").split(" ")[0] || "there")},</p>
    <p>Your <b>${esc(exp)}</b> reservation for <b>${esc(fmtCT(r.starts_at))}</b> (party of ${r.party_size}, confirmation ${esc(r.code)}) has been cancelled.</p>
    ${refundCents > 0 ? `<p>We've refunded <b>$${(refundCents / 100).toFixed(2)}</b> to your card. It usually shows up within 5–10 business days.</p>` : ""}
    ${reason ? `<p style="color:#6E6353">${esc(reason)}</p>` : ""}
    <p>Questions? Just reply to this email.</p></div>`;
  const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({ to: r.email, subject: `Your GREYS ${exp} reservation is cancelled (${r.code})`, html,
      from: Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>", replyTo: Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com" }),
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && d.ok ? "sent" : "failed";
}

// cancel: {id, reason?, notify?}                  — frees the tables; no money moves
// refund: {id, amount_cents?, reason?, notify?, cancel?=true}
//         amount defaults to whatever is left; cancel=false refunds part and keeps the booking
async function cancelOrRefund(req: Request, b: Record<string, unknown>, action: "cancel" | "refund") {
  const who = await staffEmail(req);
  if (!who) throw Object.assign(new PublicError("Not authorized"), { status: 403 });
  const { data: r } = await admin.from("rb_reservations")
    .select("id, code, status, payment_status, total_cents, paid_cents, refunded_cents, refund_ids, external_id, payment_env, guest_name, email, party_size, starts_at, inquiry_id, rb_experience_types(name)")
    .eq("id", clean(b.id, 64)).eq("kind", "experience").maybeSingle();
  if (!r) throw new PublicError("Booking not found.");
  const reason = clean(b.reason, 500);
  const keep = action === "refund" && b.cancel === false;
  let refundCents = 0, refundId: string | null = null;
  // what the card paid: the price + gratuity + tax since 2026-11-10 (paid_cents); the price alone before
  const charged = (r as any).paid_cents ?? r.total_cents ?? 0;

  if (action === "refund") {
    if (r.payment_status !== "paid" && r.payment_status !== "refunded") throw new PublicError("This booking was never paid — use Cancel instead.");
    const paymentId = String(r.external_id || "").replace(/^square:/, "");
    if (!paymentId || paymentId === String(r.external_id)) throw new PublicError("No Square payment is recorded for this booking.");
    const left = charged - (r.refunded_cents || 0);
    if (left <= 0) throw new PublicError("This booking has already been fully refunded.");
    refundCents = b.amount_cents == null || b.amount_cents === "" ? left : Math.round(Number(b.amount_cents));
    if (!(refundCents > 0) || refundCents > left) throw new PublicError(`Refund must be between $0.01 and $${(left / 100).toFixed(2)}.`);
    const e: Env = r.payment_env === "production" ? "production" : r.payment_env === "sandbox" ? "sandbox" : env();
    const out = await square("/v2/refunds", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: r.id + ":" + ((r.refund_ids || []).length + 1),
        payment_id: paymentId,
        amount_money: { amount: refundCents, currency: "USD" },
        reason: (reason || "Experience cancelled").slice(0, 192),
      }),
    }, e);
    const rf = out?.refund ?? {};
    if (!rf.id || rf.status === "REJECTED" || rf.status === "FAILED") throw new PublicError("Square did not accept the refund" + (rf.status ? " (" + rf.status + ")" : "") + ".");
    refundId = rf.id;
  }

  const refundedTotal = (r.refunded_cents || 0) + refundCents;
  const patch: Record<string, unknown> = {};
  if (refundCents) {
    patch.refunded_cents = refundedTotal;
    patch.refund_ids = [...(r.refund_ids || []), refundId];
    if (refundedTotal >= charged) patch.payment_status = "refunded";
  }
  if (!keep) { patch.status = "cancelled"; patch.cancelled_at = new Date().toISOString(); patch.cancel_reason = reason || null; patch.hold_expires_at = null; }
  const { error } = await admin.from("rb_reservations").update(patch).eq("id", r.id);
  if (error) throw new Error(error.message);
  if (!keep) await tableHolds("release", { source: "experience", source_id: r.id }).catch(() => null);

  // leave a trail in the conversation, if there is one
  if (r.inquiry_id) {
    const line = (keep ? "" : "Booking cancelled") + (refundCents ? (keep ? "" : " · ") + `refunded $${(refundCents / 100).toFixed(2)}` : "") + (reason ? ` — ${reason}` : "");
    await admin.from("inquiry_messages").insert({ inquiry_id: r.inquiry_id, direction: "note", body: line, sent_by: who });
    if (!keep) await admin.from("inquiries").update({ stage: "lost" }).eq("id", r.inquiry_id);
  }
  const mail = b.notify === true && !keep ? await mailGuest(r, refundCents, reason) : null;
  return { ok: true, refunded_cents: refundCents, refunded_total: refundedTotal, cancelled: !keep, email: mail };
}

async function status(b: Record<string, unknown>) {
  const { data } = await admin.from("rb_reservations")
    .select("code, party_size, starts_at, total_cents, gratuity_cents, tax_cents, paid_cents, status, payment_status, option_label, event_address, addons, addons_cents, rb_experience_types(name)")
    .eq("code", clean(b.code, 20).toUpperCase()).eq("email", clean(b.email, 200).toLowerCase()).eq("kind", "experience").maybeSingle();
  return data ? { ok: true, reservation: data } : { ok: false, error: "Reservation not found" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty */ }
    const action = new URL(req.url).searchParams.get("action") ?? String(body.action ?? "");
    if (action === "config") return json(req, await config());
    if (action === "pay") return json(req, await pay(req, body));
    if (action === "status") return json(req, await status(body));
    if (action === "cancel" || action === "refund") return json(req, await cancelOrRefund(req, body, action));
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message }, (e as any).status === 403 ? 403 : 402);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong on our side and nothing was charged. Reference ${ref}.` }, 500);
  }
});
