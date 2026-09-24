// ============================================================================
// square-ticket-pay-sandbox — STAGING COPY of square-ticket-pay (v16).
// Used only by the staging ticket site (ticket-rennet.onrender.com).
//   * ALWAYS Square sandbox — reuses the SQUARE_EXP_SANDBOX_* secrets. No real
//     card can be charged: the sandbox SDK only accepts test cards.
//   * A successful test booking is immediately marked canceled + refunded, so
//     it never takes a real seat on the live class.
//   * Promo codes are priced but never burned.
// Regenerate from square-ticket-pay whenever that function changes.
// ============================================================================
// square-ticket-pay: real card payments for the Greys ticket site.
//
// The browser mounts Square's Web Payments SDK, tokenizes the card, and posts
// the token here with the BOOKING INTENT ONLY — never an amount. This function
// reprices everything from the database, claims the seats under a lock, builds
// a Square Order, and charges exactly what Square says that order costs.
//
// WHY THE SERVER PRICES EVERYTHING
// Any figure arriving from the client is ignored. The one number the client is
// allowed to send is `expectedTotalCents` — the total it actually showed the
// buyer — and that is used only as a CEILING: if the server reprices higher
// (a promo went stale, the class price was edited mid-checkout) the charge is
// refused rather than silently taking more than the button said.
//
// WHY quote AND pay BOTH GO THROUGH SQUARE
// Square apportions order-scoped discounts and taxes across line items, so its
// rounding can differ from a single Math.round(taxable * rate) by a cent or
// two. `quote` runs the identical order body through POST /v2/orders/calculate
// and hands Square's own numbers back for display. The customer sees Square's
// math and is charged Square's math, so the two can never disagree.
//
// IDEMPOTENCY (the thing that used to double-charge)
// The browser mints an `attemptId` once per checkout attempt and resends it
// verbatim on every retry. It is stored on ticket_payments.attempt_id (unique)
// and IS the Square idempotency key. So:
//   - retry after a lost response, charge already landed  -> the stored result
//     is replayed, no second charge
//   - retry after a lost response, charge in flight       -> same key, Square
//     returns the same payment
//   - genuine decline                                     -> the row is marked
//     failed and the browser mints a NEW attemptId for the next try
//
// THE POST-CHARGE RULE
// Once Square says COMPLETED, nothing below may mark the payment failed.
// Marking a payment failed releases the seats, so a Supabase hiccup after a
// successful charge used to take the customer's money AND their seats and tell
// them nothing was charged. Everything after the charge is best-effort with
// retries; a failure there is recorded in ticket_payments.settle_error for
// repair, never turned into a refusal.
//
// AUTH
// verify_jwt must be FALSE — ticket buyers have no Supabase session. Public
// actions (config / quote / pay / status) are open by design and rate-limited
// by IP; refund and list do their own is_app_admin() check on the caller's
// token.
//
// Secrets (Dashboard > Edge Functions > Secrets):
//   SQUARE_TICKET_ACCESS_TOKEN - falls back to SQUARE_ACCESS_TOKEN. Kept
//                                separate so tickets can run against sandbox
//                                while the catalog sync stays on production.
//                                Scopes: PAYMENTS_READ, PAYMENTS_WRITE,
//                                ORDERS_READ, ORDERS_WRITE.
//   SQUARE_TICKET_ENV          - "sandbox" (default) or "production"
//   SQUARE_TICKET_APP_ID       - public application id, handed to the browser
//   SQUARE_TICKET_LOCATION_ID  - optional; sandbox resolves it off the token
//   TICKET_TAX_RATE            - default 0.0975
//   TICKET_FEE_RATE            - default 0.06
//   TICKET_FEE_LABEL           - default "Ticketing service fee". NOT a card
//                                surcharge: brand rules cap those at 3%, bar
//                                them on debit, and Square does not support
//                                surcharging on API payments at all. This is a
//                                flat fee on every order regardless of tender.
//   TICKET_ALLOWED_ORIGINS     - comma-separated CORS allowlist. When unset,
//                                the built-in list below is used. CORS now
//                                fails CLOSED: an origin that is not on the
//                                list gets no allow header at all.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const DEFAULT_LOCATION = "LCXWZ0HAQ69RM"; // Greys Memphis, merchant ML6ZX2AV0XKFN
const SQUARE_VERSION = "2025-01-23";
const CURRENCY = "USD";
const MAIL_FROM = Deno.env.get("TICKET_MAIL_FROM") ?? "GREYS <info@greyscheese.com>";

const MAX_QTY = 20;            // seats in one transaction
const MAX_TOTAL_CENTS = 500000; // $5,000 — a ticket order above this is a bug
const ATTEMPT_WINDOW_MIN = 60;
const MAX_ATTEMPTS_PER_EMAIL = 8;

// Per-IP brakes. quote is the cheap-to-call one that reaches check_promo and
// Square's calculate endpoint, so it gets its own bucket.
const QUOTE_LIMIT = 40;
const QUOTE_WINDOW_SECS = 600;
const PAY_LIMIT = 12;
const PAY_WINDOW_SECS = 3600;

const DEFAULT_ORIGINS = [
  "https://ticket-rennet.onrender.com",
];

// ---------- env ----------
const env = (): "production" | "sandbox" => "sandbox"; // STAGING: never production
const squareBase = () =>
  env() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
// A sandbox test account gets a generated location id, different for every
// developer account, and digging it out of the test seller dashboard is a
// nuisance. When the secret is unset, sandbox resolves it off the token and
// caches it for the life of the isolate. Production never guesses: multiple
// locations on the account would make "the first active one" a coin toss, so
// it falls back to Greys Memphis and nothing else.
let RESOLVED_LOCATION: string | null = null;

const locationId = () =>
  RESOLVED_LOCATION ?? Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ?? DEFAULT_LOCATION;

async function ensureLocation() {
  const explicit = Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID");
  if (explicit) return (RESOLVED_LOCATION = explicit);
  if (RESOLVED_LOCATION) return RESOLVED_LOCATION;
  if (env() === "production") return (RESOLVED_LOCATION = DEFAULT_LOCATION);

  const data = await square("/v2/locations");
  const list = (data?.locations ?? []) as Record<string, any>[];
  const active = list.find((l) => l.status === "ACTIVE") ?? list[0];
  if (!active?.id) throw new Error("This Square token has no usable location.");
  return (RESOLVED_LOCATION = String(active.id));
}
// WHICH SHOP'S MONEY THIS IS.
// Production has two real locations on merchant ML6ZX2AV0XKFN. Until now every
// online ticket — Nashville's included — was charged at Memphis, because
// locationId() is a single global. That put Nashville's deposits and its Square
// reporting in the wrong shop. The event's own `location` column decides now.
//
// Sandbox holds none of these ids, so it keeps the single resolved test location
// and nothing about today's behaviour changes until SQUARE_TICKET_ENV flips.
// TICKET_LOCATION_MAP (json, e.g. {"nashville":"L..."}) overrides an entry
// without a redeploy.
const SHOP_LOCATIONS: Record<string, string> = {
  memphis: "LCXWZ0HAQ69RM",   // Greys Memphis, 709 S Mendenhall Rd
  nashville: "LJ33VDYHS1JAR", // Greys Fine Cheeses Nashville, 4101 Charlotte Ave
};
function shopLocations(): Record<string, string> {
  const raw = Deno.env.get("TICKET_LOCATION_MAP");
  if (!raw) return SHOP_LOCATIONS;
  try { return { ...SHOP_LOCATIONS, ...JSON.parse(raw) }; } catch { return SHOP_LOCATIONS; }
}
// An unknown shop (a closed Franklin event, a typo) falls back rather than
// failing the sale — the money still lands somewhere real.
function locationForEvent(ev: Record<string, any>): string {
  if (env() !== "production") return locationId();
  const key = String(ev?.location ?? "").trim().toLowerCase();
  return shopLocations()[key] ?? locationId();
}

const taxRate = () => Number(Deno.env.get("TICKET_TAX_RATE") ?? "0.0975");
const feeRate = () => Number(Deno.env.get("TICKET_FEE_RATE") ?? "0.06");
const feeLabel = () => Deno.env.get("TICKET_FEE_LABEL") ?? "Ticketing service fee";
const taxLabel = () => Deno.env.get("TICKET_TAX_LABEL") ?? "TN Sales Tax";

// ---------- errors ----------
// PublicError is safe to show a customer. Everything else is logged with a
// reference and replaced with a generic line, so Postgres constraint names and
// RPC internals stop leaking to anonymous callers.
class PublicError extends Error {}

// A declined card is a normal outcome, not an exception — callers that need to
// tell "declined" from "our request was malformed" read .status off the error.
// Square's own decline text is customer-safe, so these are public.
class SquareFail extends PublicError {
  status: number;
  data: unknown;
  constructor(status: number, data: unknown) {
    super(squareError(status, data));
    this.status = status;
    this.data = data;
  }
}

const ref = () => crypto.randomUUID().slice(0, 8);

function publicMessage(e: unknown, correlation: string): string {
  if (e instanceof PublicError) return e.message;
  console.error(`[${correlation}]`, e instanceof Error ? e.stack ?? e.message : String(e));
  return `Something went wrong on our side and nothing was charged. Please try again, or call the shop and quote reference ${correlation}.`;
}

// ---------- CORS ----------
// Fails closed. An origin that is not on the list gets no allow header, so the
// browser refuses the response rather than us handing out a working one.
function corsFor(req: Request) {
  // STAGING: staging site + the staff portal (admin list/refund) only.
  const allow = [...DEFAULT_ORIGINS];
  const o = req.headers.get("Origin") ?? "";
  if (/^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(o) && o !== "https://tickets.greyscheese.com") allow.push(o);
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && allow.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}

// ---------- rate limiting ----------
function callerIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0].trim();
  return first || req.headers.get("cf-connecting-ip") || "unknown";
}

async function rateLimit(bucket: string, limit: number, windowSecs: number, msg: string) {
  const { data, error } = await admin.rpc("ticket_rate_hit", {
    p_bucket: bucket.slice(0, 200),
    p_limit: limit,
    p_window_secs: windowSecs,
  });
  // A limiter that cannot reach the database must not take the shop offline.
  if (error) {
    console.error("rate limit unavailable:", error.message);
    return;
  }
  if (data === false) throw new PublicError(msg);
}

// ---------- Square plumbing ----------
function squareHeaders() {
  const token = Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN");
  if (!token) throw new Error("SQUARE_TICKET_ACCESS_TOKEN is not set");
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
  return `Square could not complete that request (${status}).`;
}

async function square(path: string, init: RequestInit = {}) {
  const res = await fetch(`${squareBase()}${path}`, { ...init, headers: squareHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SquareFail(res.status, data);
  return data;
}

const cents = (v: unknown) => Math.round(Number(v ?? 0));
const money = (amount: number) => ({ amount: cents(amount), currency: CURRENCY });
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

// The guest roster and table code live as TEXT LINES inside registrations.notes
// ("Guests: A; B" / "Group: Cheddar") and the site parses them back out. A name
// carrying a newline or a semicolon can therefore forge a roster entry or move
// the booking onto another table. Anything that ends up in notes goes through
// this instead of clean().
const cleanLine = (v: unknown, max = 200) =>
  String(v ?? "")
    .replace(/[\r\n\t;]+/g, " ")
    .replace(/^\s*(guests|group)\s*:/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);

// ---------- admin auth (refund / list only) ----------
async function requireAdmin(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return "missing Authorization header";
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return "not signed in";
  const { data: isAdmin, error } = await asUser.rpc("is_app_admin");
  if (error) return "admin check failed";
  if (!isAdmin) return "not an admin";
  return null;
}

// The signed-in user, when there is one. The browser used to send userId in the
// body, which meant any caller could attach a booking to any account.
async function callerUserId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || jwt === Deno.env.get("SUPABASE_ANON_KEY")) return null;
  try {
    const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data } = await asUser.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// PRICING
// ============================================================

type AddOn = { id: string; name: string; price: number };
type Guest = { first?: string; last?: string; email?: string; optIds?: string[] };

type Intent = {
  event: Record<string, any>;
  qty: number;
  guests: Guest[];
  addOnCounts: { addOn: AddOn; count: number }[];
  promo: Record<string, any> | null;
  discountCents: number;
  buyer: { name: string; email: string; phone: string };
  context: "book" | "table_reserve";
  table: string;
  customerNote: string;
};

// Mirrors promoDiscount() in the ticket site. The promo row itself comes from
// check_promo, which is the only thing that knows whether a code is live,
// unexpired, scoped to this event and unredeemed.
function promoDiscountCents(
  promo: Record<string, any> | null,
  addOnCounts: { addOn: AddOn; count: number }[],
  subtotal: number,
): number {
  if (!promo) return 0;
  const kind = String(promo.kind ?? "");
  if (kind === "percent") {
    const pct = Math.min(100, Math.max(0, Number(promo.value ?? 0)));
    return Math.min(subtotal, Math.round((subtotal * pct) / 100));
  }
  if (kind === "fixed") {
    return Math.min(subtotal, Math.max(0, Number(promo.value ?? 0)));
  }
  if (kind === "free_addon") {
    const target = String(promo.addon_name ?? promo.addonName ?? "").trim().toLowerCase();
    if (!target) return 0;
    let d = 0;
    for (const { addOn, count } of addOnCounts) {
      // ONE free unit, not one per guest. "Free cheese knife" on a party of
      // eight used to hand out eight knives. Change the 1 here if a promo is
      // ever meant to cover the whole table.
      if (addOn.name.trim().toLowerCase() === target) d += addOn.price * Math.min(count, 1);
    }
    return Math.min(subtotal, d);
  }
  return 0;
}

// Turn whatever the browser sent into a priced intent, using only DB values.
async function buildIntent(body: Record<string, unknown>): Promise<Intent> {
  const eventId = clean(body.eventId ?? body.event_id, 64);
  if (!eventId) throw new PublicError("eventId is required");

  const { data: event, error } = await admin
    .from("events").select("*").eq("id", eventId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!event) throw new PublicError("That class could not be found.");
  if (event.archived) throw new PublicError("That class is no longer on sale.");

  const context = body.context === "table_reserve" ? "table_reserve" : "book";

  // Guests carry their own upgrade picks; a table reservation is a flat qty.
  const rawGuests = Array.isArray(body.guests) ? (body.guests as Guest[]) : [];
  let qty: number;
  let guests: Guest[];
  if (rawGuests.length) {
    guests = rawGuests.slice(0, MAX_QTY);
    qty = guests.length;
  } else {
    qty = Math.max(1, Math.min(MAX_QTY, Number(body.qty ?? 1) || 1));
    guests = Array.from({ length: qty }, () => ({}));
  }
  if (qty < 1) throw new PublicError("At least one seat is required.");

  // Every add-on must exist on THIS event at THIS price.
  const catalog: AddOn[] = Array.isArray(event.add_ons) ? event.add_ons : [];
  const byId = new Map(catalog.map((a) => [String(a.id), a]));
  const counts = new Map<string, number>();

  if (rawGuests.length) {
    for (const g of guests) {
      for (const id of (g.optIds ?? []).slice(0, 10)) {
        const key = String(id);
        if (!byId.has(key)) throw new PublicError("An upgrade on this booking is no longer offered.");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  } else if (Array.isArray(body.addOns)) {
    for (const a of body.addOns as { id: string; qty?: number }[]) {
      const key = String(a?.id ?? "");
      if (!byId.has(key)) throw new PublicError("An upgrade on this booking is no longer offered.");
      const n = Math.max(0, Math.min(MAX_QTY, Number(a?.qty ?? 1) || 0));
      if (n) counts.set(key, (counts.get(key) ?? 0) + n);
    }
  }

  const addOnCounts = [...counts.entries()].map(([id, count]) => ({
    addOn: {
      id,
      name: String(byId.get(id)!.name ?? "Upgrade"),
      price: cents(byId.get(id)!.price),
    },
    count,
  }));

  const buyer = {
    name: cleanLine(body.name, 120),
    email: clean(body.email, 160).toLowerCase(),
    phone: clean(body.phone, 40),
  };
  if (!buyer.name) throw new PublicError("A name is required.");
  if (!/^\S+@\S+\.\S+$/.test(buyer.email)) throw new PublicError("A valid email is required.");

  // Promo. check_promo is the authority; we only recompute the amount.
  let promo: Record<string, any> | null = null;
  const code = clean(body.promoCode, 64);
  if (code) {
    const { data: res } = await admin.rpc("check_promo", {
      p_code: code,
      p_email: buyer.email,
      p_event_id: event.id,
    });
    if (res?.ok) promo = res as Record<string, any>;
    // A code that has gone stale between the quote and the tap is not an
    // error — the buyer just pays the undiscounted price. `expectedTotalCents`
    // is what stops that being charged without them seeing it.
  }

  const ticketSubtotal = cents(event.price) * qty;
  const addOnSubtotal = addOnCounts.reduce((s, x) => s + x.addOn.price * x.count, 0);
  const subtotal = ticketSubtotal + addOnSubtotal;
  const discountCents = promoDiscountCents(promo, addOnCounts, subtotal);

  return {
    event,
    qty,
    guests,
    addOnCounts,
    promo,
    discountCents,
    buyer,
    context,
    table: cleanLine(body.table ?? body.group, 80),
    // Allergies / dietary needs / occasion. The site collected this and threw
    // it away for months; it now rides at the top of notes.
    customerNote: cleanLine(body.notes ?? body.customerNote, 500),
  };
}

// The Square order body. quote and pay send the identical structure, so the
// figures shown to the buyer are the figures charged.
function orderBody(intent: Intent, referenceId?: string) {
  const ev = intent.event;
  const when = new Date(`${ev.date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const line_items: Record<string, unknown>[] = [{
    uid: "tickets",
    name: `${clean(ev.title, 400)} · ${when}`,
    quantity: String(intent.qty),
    base_price_money: money(ev.price),
    note: clean(ev.location, 40),
  }];

  for (const { addOn, count } of intent.addOnCounts) {
    line_items.push({
      uid: `ao_${addOn.id}`.slice(0, 60),
      name: clean(addOn.name, 400),
      quantity: String(count),
      base_price_money: money(addOn.price),
    });
  }

  const order: Record<string, unknown> = {
    location_id: locationForEvent(ev),
    line_items,
    // ORDER scope + ADDITIVE: tax comes off the discounted subtotal, exactly
    // as the site's taxable = subtotal - discount does.
    taxes: [{
      uid: "tax",
      name: taxLabel(),
      percentage: String(+(taxRate() * 100).toFixed(4)),
      scope: "ORDER",
      type: "ADDITIVE",
    }],
    // TOTAL_PHASE runs after taxes, matching round((taxable + tax) * feeRate).
    // taxable:false is required by Square on a TOTAL_PHASE charge.
    service_charges: [{
      uid: "fee",
      name: feeLabel(),
      percentage: String(+(feeRate() * 100).toFixed(4)),
      calculation_phase: "TOTAL_PHASE",
      taxable: false,
    }],
    metadata: {
      source: "ticket-site",
      event_id: String(ev.id).slice(0, 60),
      location: clean(ev.location, 40),
    },
  };

  if (intent.discountCents > 0 && intent.promo) {
    order.discounts = [{
      uid: "promo",
      name: `Promo ${clean(intent.promo.code, 40)}`,
      type: "FIXED_AMOUNT",
      amount_money: money(intent.discountCents),
      scope: "ORDER",
    }];
  }

  if (referenceId) order.reference_id = referenceId.slice(0, 40);
  return order;
}

type Totals = {
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  fee_cents: number;
  total_cents: number;
};

function readTotals(sq: Record<string, any>): Totals {
  const gross = cents(sq?.total_money?.amount);
  const tax = cents(sq?.total_tax_money?.amount);
  const fee = cents(sq?.total_service_charge_money?.amount);
  const discount = cents(sq?.total_discount_money?.amount);
  return {
    subtotal_cents: gross - tax - fee + discount,
    discount_cents: discount,
    tax_cents: tax,
    fee_cents: fee,
    total_cents: gross,
  };
}

async function calculate(intent: Intent): Promise<Totals & { order: Record<string, any> }> {
  const data = await square("/v2/orders/calculate", {
    method: "POST",
    body: JSON.stringify({ order: orderBody(intent) }),
  });
  const sq = data?.order ?? {};
  return { ...readTotals(sq), order: sq };
}

// ============================================================
// ACTIONS
// ============================================================

async function config() {
  // Report what this function can actually reach, not what the env vars claim.
  let location_name: string | null = null;
  let merchant: string | null = null;
  let reachable = false;
  let reach_error: string | null = null;
  try {
    await ensureLocation();
    const loc = await square(`/v2/locations/${locationId()}`);
    location_name = loc?.location?.name ?? null;
    merchant = loc?.location?.merchant_id ?? null;
    reachable = true;
  } catch (e) {
    reach_error = String(e instanceof Error ? e.message : e).slice(0, 300);
  }

  return {
    app_id: Deno.env.get("SQUARE_EXP_SANDBOX_APP_ID") ?? null,
    location_id: locationId(),
    location_source: Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID") ? "secret" : "resolved from token",
    location_name,
    merchant,
    reachable,
    reach_error,
    env: env(),
    script_src: env() === "production"
      ? "https://web.squarecdn.com/v1/square.js"
      : "https://sandbox.web.squarecdn.com/v1/square.js",
    tax_rate: taxRate(),
    fee_rate: feeRate(),
    fee_label: feeLabel(),
    tax_label: taxLabel(),
    ready: !!(Deno.env.get("SQUARE_EXP_SANDBOX_APP_ID") &&
      (Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN"))),
  };
}

async function seatsLeft(eventId: string, capacity: number) {
  const { data } = await admin.rpc("ticket_seats_taken", { p_event_id: eventId });
  return Math.max(0, capacity - Number(data ?? 0));
}

async function quote(req: Request, body: Record<string, unknown>) {
  await rateLimit(
    `q:${callerIp(req)}`, QUOTE_LIMIT, QUOTE_WINDOW_SECS,
    "Too many price checks from this connection. Please wait a minute and try again.",
  );
  const intent = await buildIntent(body);
  const { order: _sq, ...totals } = await calculate(intent);
  const left = await seatsLeft(intent.event.id, intent.event.capacity);
  return {
    ok: true,
    ...totals,
    seats_left: left,
    enough_seats: left >= intent.qty,
    // Deliberately a boolean and not the code or the amount: `quote` is public,
    // so returning the discount made it a free promo-code oracle. The discount
    // is already visible in discount_cents when the code is genuinely applied.
    promo_applied: !!(intent.promo && intent.discountCents > 0),
    currency: CURRENCY,
  };
}

// Rough abuse brake on top of the per-IP limit. Square is the real gate — a
// payment needs a live card token — but this stops a script hammering
// CreatePayment on one address.
async function throttle(email: string) {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MIN * 60000).toISOString();
  const { count } = await admin
    .from("ticket_payments")
    .select("id", { count: "exact", head: true })
    .eq("buyer_email", email)
    .gte("created_at", since);
  if ((count ?? 0) >= MAX_ATTEMPTS_PER_EMAIL) {
    throw new PublicError("Too many payment attempts on this email. Please try again later.");
  }
}

const bookingCode = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => abc[b % abc.length]).join("");
};

// Guest roster and table code ride in notes, the same shape the site parses
// back out with splitNotes()/parseGuestStr(). Every value here has been through
// cleanLine(), so nothing can forge an extra Guests:/Group: line.
function buildNotes(intent: Intent) {
  const lines: string[] = [];
  if (intent.customerNote) lines.push(intent.customerNote);
  const roster = intent.guests
    .map((g) => {
      const nm = `${cleanLine(g.first, 60)} ${cleanLine(g.last, 60)}`.trim();
      if (!nm) return "";
      const opts = (g.optIds ?? [])
        .map((id) => intent.addOnCounts.find((x) => x.addOn.id === String(id))?.addOn.name)
        .filter(Boolean)
        .map((n) => cleanLine(n, 80))
        .join(", ");
      return opts ? `${nm} (${opts})` : nm;
    })
    .filter(Boolean)
    .join("; ");
  if (roster) lines.push(`Guests: ${roster}`);
  if (intent.table) lines.push(`Group: ${intent.table}`);
  return lines.join("\n");
}

// ============================================================
// CONFIRMATION EMAIL
// ============================================================
// The browser used to send this itself, right after the charge returned. Close
// the tab, lose signal in the car park, or hit any JS error in that window and
// the customer had paid and never heard from us — nothing retried, nothing was
// recorded. It is sent from here instead, inside the post-charge best-effort
// block, so it survives the browser going away.
//
// The old browser send is still live on cached pages and on any copy of the site
// that has not been redeployed. `send-confirmation` dedupes on to+subject for
// ten minutes, and this uses the IDENTICAL subject ("Your booking — <title>")
// and the same recipient list, so the stale client's copy is suppressed instead
// of arriving twice. Once the client stops sending, nothing here changes.

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const usd = (c: number) =>
  (c < 0 ? "-$" : "$") + (Math.abs(cents(c)) / 100).toFixed(2);

const SITE_URL = Deno.env.get("TICKET_SITE_URL") ?? "https://tickets.greyscheese.com";

function longDate(d: string) {
  try {
    return new Date(`${d}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  } catch { return d; }
}
function niceTime(t: string) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  if (!m) return String(t ?? "");
  let h = Number(m[1]);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

function confirmationHtml(
  intent: Intent, totals: Totals, code: string, regId: string,
  card: Record<string, any>, giftCents = 0,
) {
  const cardPart = totals.total_cents - giftCents;
  const ev = intent.event;
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 0;color:#555">${k}</td>` +
    `<td style="padding:4px 0;text-align:right"><b>${v}</b></td></tr>`;
  const line = (k: string, v: string) =>
    `<tr><td style="padding:2px 0;color:#333">${k}</td>` +
    `<td style="padding:2px 0;text-align:right">${v}</td></tr>`;

  const guestItems = intent.guests.map((g) => {
    const nm = esc(`${g.first ?? ""} ${g.last ?? ""}`.trim());
    if (!nm) return "";
    const rows = line("General admission", usd(cents(ev.price))) +
      (g.optIds ?? []).map((id) => {
        const a = intent.addOnCounts.find((x) => x.addOn.id === String(id))?.addOn;
        return a ? line(esc(a.name), "+ " + usd(a.price)) : "";
      }).join("");
    return `<p style="margin:12px 0 2px"><b>${nm}</b></p>` +
      `<table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>`;
  }).join("");

  const share = `${SITE_URL}/?booking=${regId}`;

  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#06273a">
      <h2 style="margin:0 0 4px">${esc(ev.title)}</h2>
      <p style="margin:0 0 4px;color:#555">${esc(longDate(ev.date))} · ${esc(niceTime(ev.time))}</p>
      <p style="margin:0 0 16px;color:#555"><b>&#128205; GREYS ${esc(ev.location || "Memphis")}</b></p>
      <p>Hi ${esc(intent.buyer.name)}, your booking is confirmed. Confirmation code <b>${esc(code)}</b>.</p>
      ${guestItems ? `<p style="margin:14px 0 4px"><b>Itemized</b></p>${guestItems}` : ""}
      <table style="width:100%;border-top:1px solid #ddd;margin-top:14px">
        ${row("Tickets", String(intent.qty))}
        ${intent.table ? row("Group", esc(intent.table)) : ""}
        ${row("Subtotal", usd(totals.subtotal_cents))}
        ${totals.discount_cents ? row("Promo " + esc(intent.promo?.code ?? ""), "&minus; " + usd(totals.discount_cents)) : ""}
        ${totals.tax_cents ? row(esc(taxLabel()), usd(totals.tax_cents)) : ""}
        ${totals.fee_cents ? row(esc(feeLabel()), usd(totals.fee_cents)) : ""}
        ${row("<b>Total</b>", "<b>" + usd(totals.total_cents) + "</b>")}
        ${(card?.last_4 || giftCents > 0)
          ? `<tr><td colspan="2" style="padding:10px 0 2px;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Payment</td></tr>` +
            (giftCents > 0 ? row("Gift card", usd(giftCents)) : "") +
            (cardPart > 0 && card?.last_4 && card?.card_brand !== "SQUARE_GIFT_CARD"
              ? row(esc(card.card_brand ?? "Card") + " &middot;&middot;&middot;&middot;" + esc(card.last_4), usd(cardPart))
              : "")
          : ""}
      </table>
      <p style="margin:18px 0 4px"><b>Share with your guests</b></p>
      <p style="margin:0 0 4px;color:#555">Anyone with this link can see the full booking details:</p>
      <p style="margin:0"><a href="${share}" style="color:#7c1f15">${share}</a></p>
      <p style="color:#777;font-size:12px;margin-top:18px">
        All sales are final and non-refundable. Tickets may be transferred to
        someone else who uses your name at check-in.
      </p>
    </div>`;
}

// Purchaser plus any guest who gave an address, deduped — the same set the
// browser used, so the dedupe keys line up one for one.
function confirmationRecipients(intent: Intent): string[] {
  const all = [intent.buyer.email, ...intent.guests.map((g) => g.email ?? "")]
    .map((e) => String(e ?? "").trim().toLowerCase())
    .filter((e) => /^\S+@\S+\.\S+$/.test(e));
  return [...new Set(all)];
}

async function sendConfirmation(
  intent: Intent, totals: Totals, code: string, regId: string,
  card: Record<string, any>, giftCents = 0,
): Promise<{ error: unknown }> {
  const to = confirmationRecipients(intent);
  if (!to.length) return { error: null };

  const subject = `Your booking — ${intent.event.title}`;
  const html = confirmationHtml(intent, totals, code, regId, card, giftCents);
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const results = await Promise.all(to.map(async (addr) => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${service}` },
      // `dedupe` is what suppresses the stale browser copy of this same mail.
      body: JSON.stringify({ from: MAIL_FROM, to: addr, subject, html, dedupe: true }),
    });
    const data = await res.json().catch(() => null);
    return res.ok && data?.ok ? null : `${addr}: ${JSON.stringify(data ?? {}).slice(0, 120)}`;
  }));

  const bad = results.filter(Boolean);
  return { error: bad.length ? bad.join(" | ") : null };
}

// The success payload, built from a ticket_payments row. Used both when a
// charge completes and when a retry replays an already-paid attempt.
function paidResult(pmt: Record<string, any>) {
  return {
    ok: true,
    registration_id: pmt.registration_id,
    payment_id: pmt.id,
    code: pmt.booking_code ?? null,
    subtotal_cents: pmt.subtotal_cents ?? 0,
    discount_cents: pmt.discount_cents ?? 0,
    tax_cents: pmt.tax_cents ?? 0,
    fee_cents: pmt.fee_cents ?? 0,
    total_cents: pmt.total_cents ?? 0,
    currency: CURRENCY,
    card_brand: pmt.card_brand ?? null,
    card_last4: pmt.card_last4 ?? null,
    receipt_url: pmt.receipt_url ?? null,
    gift_cents: pmt.gift_cents ?? 0,
    card_cents: pmt.gift_cents ? (pmt.card_cents ?? 0) : (pmt.total_cents ?? 0),
    square_env: pmt.square_env ?? env(),
    replayed: true,
  };
}

// Best-effort write with a couple of retries. Used only AFTER money has moved,
// where giving up must never mean marking the payment failed.
async function persist(label: string, fn: () => Promise<{ error: unknown }>): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const { error } = await fn();
      if (!error) return null;
      if (i === 2) return `${label}: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}`;
    } catch (e) {
      if (i === 2) return `${label}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  return null;
}

// ============================================================
// GIFT CARDS (split tender, 2026-09-21)
// ============================================================
// Square's documented split-payment pattern:
//   1. gift card payment, autocomplete:false + accept_partial_authorization:true
//      for the WHOLE amount due — Square approves whatever the balance covers;
//   2. if that fell short, a card payment, autocomplete:false, for the rest;
//   3. POST /v2/orders/{id}/pay with both ids captures them together.
// Nothing is captured until step 3, so any failure before it is a void (the
// caller cancels the holds), never a charge the customer has to chase.
async function payWithGift(o: {
  giftSourceId: string; sourceId: string; verificationToken: string;
  due: number; orderId: string; locationId: string; keyBase: string; code: string;
  email: string; note: string; giftMax?: number;
  onAuthorised: (gift: Record<string, any> | null, card: Record<string, any> | null) => void;
}): Promise<{ giftCents: number; primary: Record<string, any> }> {
  const g = await square("/v2/payments", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: `g_${o.keyBase}`,
      source_id: o.giftSourceId,
      order_id: o.orderId,
      location_id: o.locationId,
      // The buyer may cap how much of the card's balance to use.
      amount_money: money(o.giftMax && o.giftMax > 0 ? Math.min(o.due, o.giftMax) : o.due),
      autocomplete: false,
      accept_partial_authorization: true,
      reference_id: o.code,
      buyer_email_address: o.email,
      note: o.note,
    }),
  });
  const gift = g?.payment ?? {};
  o.onAuthorised(gift, null);
  const giftCents = Math.min(o.due, cents(gift?.approved_money?.amount ?? gift?.amount_money?.amount));
  // COMPLETED as well as APPROVED: a retry after a lost response replays the
  // same idempotency key and gets back a payment that was already captured.
  const okState = (p: Record<string, any> | null) =>
    ["APPROVED", "COMPLETED"].includes(String(p?.status ?? ""));
  if (!okState(gift) || giftCents <= 0) {
    throw new PublicError("That gift card has no balance left. Nothing was charged.");
  }

  const rest = o.due - giftCents;
  let card: Record<string, any> | null = null;
  if (rest > 0) {
    if (!o.sourceId) {
      throw new PublicError(
        `Your gift card covers ${usd(giftCents)} of ${usd(o.due)}. Please add a card for the other ` +
        `${usd(rest)} — nothing was charged.`,
      );
    }
    const c = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: o.keyBase, // same key as a card-only charge of this attempt
        source_id: o.sourceId,
        verification_token: o.verificationToken || undefined,
        order_id: o.orderId,
        location_id: o.locationId,
        amount_money: money(rest),
        autocomplete: false,
        reference_id: o.code,
        buyer_email_address: o.email,
        note: o.note,
      }),
    });
    card = c?.payment ?? {};
    o.onAuthorised(gift, card);
    if (!okState(card)) {
      throw new PublicError(`Payment was not completed (${card?.status || "unknown"}).`);
    }
  }

  // Capture both together. If the response is lost, the capture may still have
  // happened — check before letting the caller void and fail the booking.
  try {
    await square(`/v2/orders/${o.orderId}/pay`, {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `po_${o.keyBase}`,
        payment_ids: [gift.id, card?.id].filter(Boolean),
      }),
    });
  } catch (e) {
    let captured = false;
    try {
      const chk = await square(`/v2/payments/${gift.id}`);
      captured = String(chk?.payment?.status) === "COMPLETED";
    } catch (_) {/* fall through: treat as not captured */}
    if (!captured) throw e;
  }

  const primary = { ...(card ?? gift), status: "COMPLETED" };
  return { giftCents, primary };
}

// Balance check for the "Apply" button. The browser tokenizes the gift card in
// Square's hosted field and sends only that single-use token; the card number
// never touches this site. Rate-limited with quote, so it can't be used to
// probe balances in bulk (and a token needs the real card number anyway).
async function giftBalance(req: Request, body: Record<string, unknown>) {
  await rateLimit(
    `q:${callerIp(req)}`, QUOTE_LIMIT, QUOTE_WINDOW_SECS,
    "Too many checks from this connection. Please wait a minute and try again.",
  );
  const nonce = clean(body.nonce, 400);
  if (!nonce) throw new PublicError("Enter the gift card number first.");
  let data: Record<string, any>;
  try {
    data = await square("/v2/gift-cards/from-nonce", {
      method: "POST",
      body: JSON.stringify({ nonce }),
    });
  } catch (_) {
    throw new PublicError("That gift card couldn't be found. Check the number and try again.");
  }
  const gc = data?.gift_card ?? {};
  if (String(gc.state) !== "ACTIVE") {
    throw new PublicError("That gift card isn't active. Please ask the shop.");
  }
  const balance = cents(gc?.balance_money?.amount);
  if (balance <= 0) throw new PublicError("That gift card has no balance left.");
  return { ok: true, balance_cents: balance };
}

async function pay(req: Request, body: Record<string, unknown>) {
  const ip = callerIp(req);
  await rateLimit(
    `p:${ip}`, PAY_LIMIT, PAY_WINDOW_SECS,
    "Too many payment attempts from this connection. Please try again later, or call the shop.",
  );

  const sourceId = clean(body.sourceId ?? body.source_id, 400);
  // A Square gift card token from the Web Payments SDK giftCard() field. When
  // present the order is paid split-tender: gift card first (partial auth), the
  // credit card for whatever is left. See payWithGift().
  const giftSourceId = clean(body.giftSourceId ?? body.gift_source_id, 400);
  const giftMax = Math.max(0, Math.floor(Number(body.giftMaxCents ?? 0) || 0));
  if (!sourceId && !giftSourceId) {
    throw new PublicError("No card token — the payment form did not complete.");
  }
  const tokenOk = (t: string) => /^[A-Za-z0-9_\-:.]{8,400}$/.test(t);
  if (sourceId && !tokenOk(sourceId)) {
    throw new PublicError("That card token isn't valid. Please re-enter the card.");
  }
  if (giftSourceId && !tokenOk(giftSourceId)) {
    throw new PublicError("That gift card couldn't be read. Please re-enter it.");
  }
  const verificationToken = clean(body.verificationToken ?? body.verification_token, 4000);

  // One id per checkout attempt, minted by the browser and resent on retries.
  // An older cached page that doesn't send one still works — it just gets the
  // old, non-idempotent behaviour for that single request.
  const attemptId = clean(body.attemptId ?? body.attempt_id, 64) || `srv_${crypto.randomUUID()}`;

  // Replay / resume. A row already exists for this attempt when the customer
  // retried after a lost response.
  const { data: prior } = await admin
    .from("ticket_payments").select().eq("attempt_id", attemptId).maybeSingle();
  if (prior) {
    if (["paid", "refunded", "partially_refunded"].includes(String(prior.status))) {
      return paidResult(prior);
    }
    if (prior.status === "failed") {
      throw new PublicError(
        "That payment attempt was already declined. Please re-enter the card and try again.",
      );
    }
  }

  const intent = await buildIntent(body);
  await throttle(intent.buyer.email);

  // The ceiling. The client sends the total it actually displayed; if the
  // server reprices higher, refuse rather than quietly charging more.
  const expected = cents(body.expectedTotalCents ?? body.expected_total_cents ?? 0);

  const userId = await callerUserId(req);
  const code = prior?.booking_code ?? bookingCode();

  // 1. Claim the seats and land a pending registration BEFORE any charge, so a
  //    Square failure leaves a recoverable record instead of a silent loss.
  //    On a resume, the seats are already claimed — don't claim twice.
  let regId: string;
  if (prior?.registration_id) {
    regId = prior.registration_id;
  } else {
    const { data: reg, error: claimErr } = await admin.rpc("claim_ticket_seats", {
      p: {
        event_id: intent.event.id,
        code,
        name: intent.buyer.name,
        email: intent.buyer.email,
        phone: intent.buyer.phone,
        qty: intent.qty,
        add_ons: intent.addOnCounts.map((x) => ({
          name: x.addOn.name,
          qty: x.count,
          price: x.addOn.price,
        })),
        notes: buildNotes(intent),
        total: 0, // filled in from Square once the charge lands
        guest_emails: intent.guests.map((g) => clean(g.email, 160)).filter(Boolean),
        user_id: userId,
      },
    });
    if (claimErr) {
      const m = /sold_out:(\d+):(\d+)/.exec(claimErr.message ?? "");
      if (m) {
        const left = Number(m[1]);
        throw new PublicError(
          left === 0
            ? "That class just sold out — no seats left."
            : `Only ${left} seat${left === 1 ? "" : "s"} left — please lower the number of guests.`,
        );
      }
      // Tabled-event refusals from claim_ticket_seats (2026-09-21). All of these
      // happen BEFORE the charge, so nothing was taken.
      const msg = claimErr.message ?? "";
      if (/table_taken/.test(msg)) {
        throw new PublicError(
          "That table was just taken by someone else. Nothing was charged — please reload the page and try again.",
        );
      }
      if (/table_must_be_whole|table_invalid/.test(msg)) {
        throw new PublicError(
          "Tables for this event are sold whole. Please reload the page and try again. Nothing was charged.",
        );
      }
      throw new Error(claimErr.message);
    }
    if (!reg?.id) throw new PublicError("Could not hold your seats. Nothing was charged.");
    regId = reg.id;
  }

  // 2. Ledger row (or the one this attempt already made).
  let pmt = prior;
  if (!pmt) {
    const { data: fresh, error: pErr } = await admin.from("ticket_payments").insert({
      attempt_id: attemptId,
      context: intent.context,
      event_id: intent.event.id,
      registration_id: regId,
      hold_id: intent.table || null,
      buyer_name: intent.buyer.name,
      buyer_email: intent.buyer.email,
      buyer_phone: intent.buyer.phone,
      qty: intent.qty,
      line_items: intent.addOnCounts.map((x) => ({
        name: x.addOn.name,
        qty: x.count,
        price_cents: x.addOn.price,
      })),
      promo_code: intent.promo ? clean(intent.promo.code, 40) : "",
      booking_code: code,
      square_env: env(),
      status: "pending",
    }).select().single();
    if (pErr) {
      await admin.from("registrations")
        .update({ payment_status: "failed" }).eq("id", regId);
      throw new Error(pErr.message);
    }
    pmt = fresh;
  }

  // Only ever called BEFORE the charge lands. Marking a payment failed releases
  // the seats, which is exactly wrong once money has moved.
  const fail = async (msg: string, raw?: unknown) => {
    await admin.from("ticket_payments").update({
      status: "failed",
      error: msg.slice(0, 600),
      raw: raw ? (raw as Record<string, unknown>) : null,
      updated_at: new Date().toISOString(),
    }).eq("id", pmt!.id);
    await admin.from("registrations")
      .update({ payment_status: "failed" }).eq("id", regId);
  };

  let sq: Record<string, any>;
  let totals: Totals;
  let payment: Record<string, any>;
  // Split tender bookkeeping. Authorised-but-uncaptured payments are cancelled
  // if anything fails before capture, so a decline never leaves a hold behind.
  let giftPay: Record<string, any> | null = null;
  let cardPay: Record<string, any> | null = null;
  let giftCents = 0;

  // ---- everything in here happens BEFORE the card is charged ----
  try {
    // 3. The real order. Keyed on the attempt, so a retry reuses it.
    const created = await square("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `o_${pmt!.id}`,
        order: orderBody(intent, code),
      }),
    });
    sq = created?.order ?? {};
    totals = readTotals(sq);
    if (!totals.total_cents) throw new PublicError("Square returned a $0 total — check the class price.");
    if (totals.total_cents > MAX_TOTAL_CENTS) {
      throw new PublicError("That total is larger than this page can take. Please call the shop.");
    }
    if (expected > 0 && totals.total_cents > expected) {
      throw new PublicError(
        "The price changed while you were checking out — a code may have expired. " +
        "Nothing was charged. Please review the new total and try again.",
      );
    }

    await admin.from("ticket_payments").update({
      square_order_id: sq.id,
      ...totals,
      updated_at: new Date().toISOString(),
    }).eq("id", pmt!.id);

    // 4. Charge exactly what Square calculated.
    const due = cents(sq?.net_amount_due_money?.amount ?? sq?.total_money?.amount);
    if (giftSourceId) {
      const r = await payWithGift({
        giftSourceId, sourceId, verificationToken, due, orderId: sq.id, giftMax,
        locationId: locationForEvent(intent.event), keyBase: pmt!.id, code,
        email: intent.buyer.email,
        note: `${clean(intent.event.title, 60)} · ${intent.qty} seat${intent.qty === 1 ? "" : "s"}`,
        onAuthorised: (g, c) => { giftPay = g; cardPay = c; },
      });
      giftCents = r.giftCents;
      payment = r.primary;
    } else {
    const res = await square("/v2/payments", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: pmt!.id, // same key on every retry of this attempt
        source_id: sourceId,
        verification_token: verificationToken || undefined,
        order_id: sq.id,
        location_id: locationForEvent(intent.event),
        amount_money: money(due),
        autocomplete: true,
        reference_id: code,
        buyer_email_address: intent.buyer.email,
        note: `${clean(intent.event.title, 60)} · ${intent.qty} seat${intent.qty === 1 ? "" : "s"}`,
      }),
    });
    payment = res?.payment ?? {};
    const paidStatus = String(payment?.status ?? "");
    if (paidStatus !== "COMPLETED" && paidStatus !== "APPROVED") {
      throw new PublicError(`Payment was not completed (${paidStatus || "unknown"}).`);
    }
    }
  } catch (e) {
    // Release any split-tender holds. Nothing was captured, so this is a void,
    // not a refund, and the customer sees no charge.
    for (const p of [cardPay, giftPay] as (Record<string, any> | null)[]) {
      if (p?.id) {
        try { await square(`/v2/payments/${p.id}/cancel`, { method: "POST" }); } catch (_) {/* best effort */}
      }
    }
    const msg = String(e instanceof Error ? e.message : e);
    await fail(msg, e instanceof SquareFail ? e.data : undefined);
    throw e;
  }
  const cardCents = totals!.total_cents - giftCents;

  // ================= MONEY HAS MOVED =================
  // Nothing below may call fail(), throw, or refuse. Every write is retried and
  // any residue is recorded on the ledger for repair.
  const cardDetails = payment?.card_details?.card ?? {};
  const problems: string[] = [];

  problems.push(await persist("ledger", () =>
    admin.from("ticket_payments").update({
      status: "paid",
      square_payment_id: payment.id ?? null,
      gift_payment_id: (giftPay as Record<string, any> | null)?.id ?? null,
      gift_cents: giftCents,
      card_cents: cardCents,
      card_brand: cardDetails.card_brand ?? null,
      card_last4: cardDetails.last_4 ?? null,
      receipt_url: payment.receipt_url ?? null,
      error: null,
      settle_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", pmt!.id)) ?? "");

  problems.push(await persist("registration", () =>
    admin.from("registrations").update({
      // STAGING: a test booking must never hold a real seat.
      payment_status: "canceled",
      refunded: true,
      total: totals!.total_cents,
      square_payment_id: payment.id ?? null,
      square_order_id: sq!.id ?? null,
      card_brand: cardDetails.card_brand ?? null,
      card_last4: cardDetails.last_4 ?? null,
    }).eq("id", regId)) ?? "");

  // 5. Burn the promo only once money actually moved, with OUR discount.
  if (false && intent.promo && intent.discountCents > 0) { // STAGING: never burn a real promo
    try {
      await admin.rpc("redeem_promo", {
        p_code: clean(intent.promo.code, 64),
        p_email: intent.buyer.email,
        p_reg_id: regId,
        p_event_id: intent.event.id,
        p_discount: intent.discountCents,
      });
    } catch (_) {/* a lost redemption must not lose the booking */}
  }

  // Confirmation email. Best-effort like every other post-charge write: three
  // tries, then the failure is recorded on the ledger instead of thrown. A
  // customer who paid must never see an error because our mailer had a moment.
  problems.push((await persist("confirmation email", () =>
    sendConfirmation(intent, totals!, code, regId, cardDetails, giftCents))) ?? "");

  const residue = problems.filter(Boolean).join(" | ");
  if (residue) {
    console.error("post-charge settle failed:", pmt!.id, residue);
    // Best-effort flag so a human (or a repair job) can find it.
    try {
      await admin.from("ticket_payments")
        .update({ settle_error: residue.slice(0, 600) }).eq("id", pmt!.id);
    } catch (_) {/* nothing more we can do here */}
  }

  return {
    ok: true,
    registration_id: regId,
    payment_id: pmt!.id,
    code,
    ...totals!,
    currency: CURRENCY,
    card_brand: cardDetails.card_brand ?? null,
    card_last4: cardDetails.last_4 ?? null,
    receipt_url: payment.receipt_url ?? null,
    gift_cents: giftCents,
    card_cents: cardCents,
    square_env: env(),
  };
}

// Look up a payment. Public, so it must prove ownership: either the caller
// holds the attempt id it generated itself, or it can name the buyer's email.
// Used by the browser to recover after a lost pay response.
async function status(body: Record<string, unknown>) {
  const attemptId = clean(body.attemptId ?? body.attempt_id, 64);
  const id = clean(body.payment_id ?? body.id, 64);
  if (!attemptId && !id) throw new PublicError("payment not found");

  const q = admin
    .from("ticket_payments")
    .select("id,status,total_cents,subtotal_cents,discount_cents,tax_cents,fee_cents," +
      "card_brand,card_last4,receipt_url,registration_id,booking_code,square_env,buyer_email," +
      "gift_cents,card_cents");
  const { data } = attemptId
    ? await q.eq("attempt_id", attemptId).maybeSingle()
    : await q.eq("id", id).maybeSingle();
  if (!data) throw new PublicError("payment not found");

  // An attempt id is self-authorizing (the browser minted it). A payment id is
  // only a UUID, so it has to be paired with the buyer's email.
  if (!attemptId) {
    const claimed = clean(body.email, 160).toLowerCase();
    if (!claimed || claimed !== String(data.buyer_email ?? "").toLowerCase()) {
      throw new PublicError("payment not found");
    }
  }

  const { buyer_email: _drop, ...safe } = data as Record<string, unknown>;
  return { payment: safe };
}

// ---------- admin ----------
async function refund(body: Record<string, unknown>) {
  const id = clean(body.payment_id ?? body.id, 64);
  const { data: row } = await admin.from("ticket_payments").select().eq("id", id).maybeSingle();
  if (!row) throw new PublicError("payment not found");
  if (!row.square_payment_id) throw new PublicError("this booking was never charged");
  if (row.status === "refunded") throw new PublicError("already fully refunded");

  const total = cents(row.total_cents);
  const already = cents(row.refunded_cents ?? 0); // NULL used to make this NaN
  const remaining = total - already;
  if (remaining <= 0) throw new PublicError("nothing left to refund");

  const asked = cents(body.amount_cents ?? remaining);
  const amount = Math.max(1, Math.min(remaining, asked > 0 ? asked : remaining));
  const reason = clean(body.reason, 192) || "Ticket refund";

  // Split-tender orders refund the CARD part first, then the gift card, so a
  // partial refund goes back to real money before store credit. Older rows have
  // gift_cents 0 and are all-card, exactly as before.
  const giftPart = cents(row.gift_cents ?? 0);
  const giftId: string | null = giftPart > 0 ? (row.gift_payment_id ?? null) : null;
  const cardId: string | null = giftPart > 0
    ? (row.square_payment_id && row.square_payment_id !== row.gift_payment_id ? row.square_payment_id : null)
    : row.square_payment_id;
  const cardPart = total - giftPart;
  const cardLeft = Math.max(0, cardPart - Math.min(already, cardPart));
  const toCard = cardId ? Math.min(amount, cardLeft) : 0;
  const toGift = amount - toCard;
  if (toGift > 0 && !giftId) throw new PublicError("nothing left to refund on this payment");

  const refundIds: string[] = [];
  let done = 0;
  let res: Record<string, any> | null = null;
  try {
    if (toCard > 0) {
      res = await square("/v2/refunds", {
        method: "POST",
        body: JSON.stringify({
          // Deterministic: resubmitting the same refund is the same refund, not a
          // second one. Card-only orders keep the exact key format they always had.
          idempotency_key: clean(body.refund_key, 45) ||
            (giftPart > 0 ? `r_${row.id}_${already}_${amount}_c` : `r_${row.id}_${already}_${amount}`),
          payment_id: cardId,
          amount_money: money(toCard),
          reason,
        }),
      });
      if (res?.refund?.id) refundIds.push(res.refund.id);
      done += toCard;
    }
    if (toGift > 0) {
      const gr = await square("/v2/refunds", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: `r_${row.id}_${already}_${amount}_g`,
          payment_id: giftId,
          amount_money: money(toGift),
          reason,
        }),
      });
      if (gr?.refund?.id) refundIds.push(gr.refund.id);
      res = res ?? gr;
      done += toGift;
    }
  } catch (e) {
    // The card half may have gone through before the gift half failed. Record
    // what actually happened, then surface the failure.
    if (done === 0) throw e;
    await admin.from("ticket_payments").update({
      refunded_cents: already + done,
      status: "partially_refunded",
      square_refund_ids: [...(row.square_refund_ids ?? []), ...refundIds],
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    throw new PublicError(
      `Refunded ${usd(done)} to the card, but the gift card refund failed. Retry to finish the rest.`,
    );
  }

  const refunded = already + done;
  const full = refunded >= total;
  const newStatus = full ? "refunded" : "partially_refunded";

  await admin.from("ticket_payments").update({
    refunded_cents: refunded,
    status: newStatus,
    square_refund_ids: [...(row.square_refund_ids ?? []), ...refundIds],
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);

  if (row.registration_id) {
    await admin.from("registrations").update({
      payment_status: newStatus,
      refunded_cents: refunded,
      refunded: full,
      refunded_at: full ? new Date().toISOString() : null,
    }).eq("id", row.registration_id);
  }

  return { ok: true, refund: res?.refund, refunded_cents: refunded, status: newStatus };
}

async function list(body: Record<string, unknown>) {
  let q = admin.from("ticket_payments").select().order("created_at", { ascending: false });
  if (body.event_id) q = q.eq("event_id", String(body.event_id));
  if (body.status) q = q.eq("status", String(body.status));
  const limit = Math.max(1, Math.min(500, Number(body.limit ?? 200) || 200));
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(error.message);
  return { payments: data ?? [] };
}

// ---------- router ----------
const PUBLIC_ACTIONS = new Set(["config", "quote", "pay", "status", "gift_balance"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON" }, 400);
  }

  const action = String(body.action ?? "");

  if (!PUBLIC_ACTIONS.has(action)) {
    const denied = await requireAdmin(req);
    if (denied) return json(req, { error: `Forbidden: ${denied}` }, 403);
  }

  const correlation = ref();
  try {
    // Everything except config needs a location on the order.
    if (action !== "config") await ensureLocation();

    switch (action) {
      case "config":
        return json(req, await config());
      case "quote":
        return json(req, await quote(req, body));
      case "pay":
        return json(req, await pay(req, body));
      case "status":
        return json(req, await status(body));
      case "gift_balance":
        return json(req, await giftBalance(req, body));
      case "refund":
        return json(req, await refund(body));
      case "list":
        return json(req, await list(body));
      default:
        return json(req, { error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json(req, { error: publicMessage(e, correlation), ref: correlation }, 400);
  }
});
