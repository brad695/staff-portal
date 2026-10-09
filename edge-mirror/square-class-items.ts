// ============================================================================
// square-class-items — ticket-site events as Square catalog items, sold on the
// register, landing back in the class roster. (2026-10-09)
//
//   kinds     'class' (sold per seat) and 'event_tabled' (Mahjong: sold as
//             whole tables of party_size seats). KINDS below is the whole
//             per-kind config; a kind that is not listed is never synced.
//   catalog   one Square ITEM per title per shop ("<title> - Oct 28"), one
//             VARIATION per date — one seat for a class, one whole table for a
//             tabled event — TN 9.75% additive tax. Register price = ticket x
//             (1 + fee) so the register total matches online (ticket + tax +
//             service fee).
//   category  the per-shop category ("Classes – Memphis") stays on the item for
//             the register menu; the REPORTING category — what Square's
//             item-sales report groups by — is the kind's own top-level one.
//   inventory each date's Square stock = seats left (tables left for a tabled
//             event).
//   pull      completed register orders with a class line -> a registration on
//             that class. Returns reduce / refund the registration.
//   refunds   a refund made in Square on a ticket-site order (return order) ->
//             ticket_payments + registration (2026-10-07)
//   ensure    {"action":"ensure","eventId":"..."} syncs just that event's group
//             and hands back its class_square_links row. square-ticket-pay
//             calls it at checkout so every online sale is a real catalog line
//             and never an ad-hoc one. (2026-10-09)
//
// ENV below decides sandbox vs production. The sandbox copy writes register
// sales as canceled + refunded test rows: it shares the LIVE database, so a
// sandbox sale must never take a real seat.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const ENV: "sandbox" | "production" = "production";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SQUARE_VERSION = "2025-01-23";
const TZ = "America/Chicago";
const FEE_RATE = Number(Deno.env.get("TICKET_FEE_RATE") ?? "0.04"); // register price = ticket x 1.04 (was 1.06 until 2026-09-29)
// Per-kind config (2026-10-09). unit says whether one variation is a seat
// (classes) or a whole table of party_size seats (Mahjong); locPrefix builds
// the per-shop register category; reporting* is the top-level category Square's
// item-sales report groups the kind under.
const KINDS: Record<string, { unit: "seat" | "table"; locPrefix: string; skuPrefix: string; reportingProd: string | null; reportingSandboxName: string }> = {
  class:        { unit: "seat",  locPrefix: "Classes", skuPrefix: "CL", reportingProd: "CNZCPOPXO4MMMCUH2IJ4TKL2" /* top-level "Classes" */, reportingSandboxName: "Classes" },
  // reportingProd is PENDING Brad's choice: "Classes" CNZCPOPXO4MMMCUH2IJ4TKL2
  // or "Experiences" H5HEPNMRTWQ64C3OELYQXQF5. While it is null, tabled events
  // are NOT synced in production — a guessed reporting category would quietly
  // land Mahjong money in the wrong report.
  event_tabled: { unit: "table", locPrefix: "Classes", skuPrefix: "TB", reportingProd: null, reportingSandboxName: "Experiences" /* sandbox stand-in */ },
};
type KindCfg = (typeof KINDS)[string];
const SYNCED_KINDS = Object.keys(KINDS);
const kindCfg = (kind: unknown): KindCfg | null => KINDS[String(kind ?? "")] ?? null;
const partySizeOf = (ev: Record<string, any>) => Math.max(1, Math.round(Number(ev?.party_size ?? 1) || 1));
const PROD_TAX_ID = "2K7XWRVWVXBTAJQIHHQOLFCN"; // TN Standard 9.75% ADDITIVE
const SANDBOX_TAX_NAME = "TN Sales Tax 9.75% (classes)";
const PROD_LOCATIONS: Record<string, string> = {
  memphis: "LCXWZ0HAQ69RM",
  nashville: "LJ33VDYHS1JAR",
};
const STATE_ID = `class-items-${ENV}`;

const base = ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
const token = () =>
  ENV === "production"
    ? (Deno.env.get("SQUARE_ACCESS_TOKEN") ?? "")
    : (Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN") ?? "");

class SqErr extends Error {
  constructor(public status: number, public data: unknown) {
    super(`Square ${status}: ${JSON.stringify((data as any)?.errors ?? data).slice(0, 400)}`);
  }
}
async function sq(path: string, init: RequestInit = {}) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && i < 3) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); continue; }
    if (!res.ok) throw new SqErr(res.status, data);
    return data as Record<string, any>;
  }
  throw new Error("unreachable");
}

// Square answers a reused batch-upsert idempotency key with this code: the
// other runner (the 5-minute cron vs a checkout "ensure") already wrote that
// object, so its stored row is the one to keep. (2026-10-09)
function isIdemReuse(e: unknown): boolean {
  if (!(e instanceof SqErr)) return false;
  return (((e.data as any)?.errors ?? []) as any[]).some((x) => String(x?.code) === "IDEMPOTENCY_KEY_REUSED");
}
// The other run writes class_square_items right after its upsert, so give it a
// couple of seconds before giving up on finding the item it made.
async function itemRowFor(itemKey: string, tries = 6): Promise<Record<string, any> | null> {
  for (let i = 0; i < tries; i++) {
    const { data } = await admin.from("class_square_items").select("*")
      .eq("env", ENV).eq("item_key", itemKey).maybeSingle();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

const money = (c: number) => ({ amount: Math.round(c), currency: "USD" });
const todayCentral = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
};
// Register sales stop when online sales do: this many hours before the start
// (Maverick, 2026-09-29: 12). A class inside the cutoff leaves the catalog like
// a past one; its link stays a week so late register sales and returns still map.
const CUTOFF_HOURS = Number(Deno.env.get("TICKET_BOOKING_CUTOFF_HOURS") ?? "12");
// events.date + events.time are shop-local wall-clock values (America/Chicago).
function startsAtMs(ev: Record<string, any>): number {
  const [y, m, d] = String(ev?.date ?? "").split("-").map(Number);
  const [hh, mm] = String(ev?.time || "00:00").split(":").map(Number);
  if (!y || !m || !d) return NaN;
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guess)).forEach((x) => { p[x.type] = x.value; });
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return guess - (shown - guess);
}
const salesOpen = (ev: Record<string, any>) => {
  const start = startsAtMs(ev);
  return !Number.isFinite(start) || Date.now() < start - CUTOFF_HOURS * 3600e3;
};
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function niceWhen(date: string, time: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ""));
  if (!m) return day;
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${day} · ${h}:${m[2]} ${ap}`;
}
const bookingCode = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => abc[b % abc.length]).join("");
};
const cleanLine = (v: unknown, max = 200) =>
  String(v ?? "").replace(/[\r\n\t;]+/g, " ").replace(/^\s*(guests|group)\s*:/i, "")
    .replace(/\s{2,}/g, " ").trim().slice(0, max);

// "Base Ticket plus charcuterie and crusty bread" -> "Charcuterie and crusty bread"
function upgradeName(n: string) {
  const t = String(n ?? "").trim().replace(/^base\s+ticket\s+plus\s+/i, "");
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 255) || "Upgrade";
}

// Keep the categories an item already has, above all the "Classes" group on
// the Memphis / Nashville Restaurant menu (added in the Dashboard). Replacing
// the list on a rewrite dropped the class off the register menu whenever its
// price, date or upgrades changed. Only the per-shop category is ours: swap it
// if it changed, leave everything else alone. (2026-09-28)
// The reporting category is never dropped either — Square puts it in this list
// itself, and dropping it would fight that every rewrite. (2026-10-09)
function keepCategories(
  cur: Record<string, any> | null, categoryId: string, prevCategoryId: string | null, reportingId: string,
) {
  const had = ((cur?.item_data?.categories ?? []) as any[])
    .filter((c) => c?.id && (c.id === categoryId || c.id === reportingId || c.id !== prevCategoryId));
  const keep = had.some((c) => c.id === categoryId) ? had : [{ id: categoryId }, ...had];
  // Never list the same category twice: Square rejects duplicates.
  const seen = new Set<string>();
  return keep.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

// ---------------------------------------------------------------- locations
let SANDBOX_LOC: string | null = null;
async function locationFor(ev: Record<string, any>): Promise<string> {
  if (ENV === "production") {
    const id = PROD_LOCATIONS[String(ev.location ?? "").trim().toLowerCase()];
    if (!id) throw new Error(`no Square location for "${ev.location}"`);
    return id;
  }
  if (SANDBOX_LOC) return SANDBOX_LOC;
  const explicit = Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID");
  if (explicit) return (SANDBOX_LOC = explicit);
  const d = await sq("/v2/locations");
  const l = (d.locations ?? []).find((x: any) => x.status === "ACTIVE") ?? d.locations?.[0];
  return (SANDBOX_LOC = String(l.id));
}
async function allLocations(): Promise<string[]> {
  if (ENV === "production") return Object.values(PROD_LOCATIONS);
  return [await locationFor({})];
}

// ----------------------------------------------------------- category + tax
async function findByName(type: string, name: string): Promise<Record<string, any> | null> {
  const d = await sq("/v2/catalog/search", {
    method: "POST",
    body: JSON.stringify({ object_types: [type], query: { exact_query: { attribute_name: "name", attribute_value: name } } }),
  });
  return (d.objects ?? []).find((o: any) => !o.is_deleted) ?? null;
}
// One category per shop ("Classes – Memphis"), so each location's menu and
// reports only carry its own events.
const catCache = new Map<string, string>();
async function ensureCategory(prefix: string, location = ""): Promise<string> {
  const name = location ? `${prefix} – ${location}` : prefix;
  if (catCache.has(name)) return catCache.get(name)!;
  const id = await ensureCategoryNamed(name);
  catCache.set(name, id);
  return id;
}
async function ensureCategoryNamed(name: string): Promise<string> {
  const hit = await findByName("CATEGORY", name);
  if (hit) return hit.id;
  try {
    const d = await sq("/v2/catalog/object", {
      method: "POST",
      body: JSON.stringify({
        // Deterministic on the name, so the cron and a checkout "ensure" running
        // at the same second cannot create two categories called the same thing.
        idempotency_key: `cat-${ENV}-${name}`.slice(0, 128),
        object: { type: "CATEGORY", id: "#classes", category_data: { name, is_top_level: true } },
      }),
    });
    return d.catalog_object.id;
  } catch (e) {
    if (!isIdemReuse(e)) throw e;
    const again = await findByName("CATEGORY", name);
    if (again) return again.id;
    throw e;
  }
}
// The kind's reporting category. Production names it by its fixed id (like
// PROD_TAX_ID); sandbox ids differ per test account, so there it is resolved —
// or created — by name. null means "not chosen yet": do not sync that kind.
const reportCache = new Map<string, string>();
async function reportingCategory(kind: string): Promise<string | null> {
  const cfg = kindCfg(kind);
  if (!cfg) return null;
  if (ENV === "production") return cfg.reportingProd;
  if (reportCache.has(kind)) return reportCache.get(kind)!;
  const id = await ensureCategoryNamed(cfg.reportingSandboxName);
  reportCache.set(kind, id);
  return id;
}
async function ensureTax(): Promise<string> {
  if (ENV === "production") return PROD_TAX_ID;
  const hit = await findByName("TAX", SANDBOX_TAX_NAME);
  if (hit) return hit.id;
  const d = await sq("/v2/catalog/object", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      object: {
        type: "TAX", id: "#tax",
        tax_data: {
          name: SANDBOX_TAX_NAME, calculation_phase: "TAX_SUBTOTAL_PHASE", inclusion_type: "ADDITIVE",
          percentage: "9.75", applies_to_custom_amounts: false, enabled: true,
        },
      },
    }),
  });
  return d.catalog_object.id;
}

// ------------------------------------------------------------------ catalog
// Everything the catalog is built from: upcoming, on-sale, priced events of a
// kind KINDS covers. party_size comes along for tabled events, where one
// variation is one whole table (2026-10-09).
async function upcomingEvents() {
  const { data, error } = await admin.from("events")
    .select("id,title,date,time,price,capacity,location,kind,party_size,archived,add_ons")
    .in("kind", SYNCED_KINDS).gte("date", todayCentral()).gt("price", 0)
    .order("date").order("time");
  if (error) throw new Error(error.message);
  return (data ?? []).filter((e) => !e.archived && salesOpen(e));
}

// Upcoming priced events of a kind KINDS knows nothing about. Never synced,
// only reported, so a new kind in the DB shows up instead of silently missing.
async function unsupportedKindEvents(): Promise<string[]> {
  const { data } = await admin.from("events").select("id,kind,archived")
    .not("kind", "in", `(${SYNCED_KINDS.join(",")})`)
    .gte("date", todayCentral()).gt("price", 0);
  return (data ?? []).filter((e) => !e.archived).map((e) => e.id);
}

// The one catalog-writing path (2026-10-09): the 5-minute "sync" runs it over
// everything, "ensure" runs it over a single event's group — same items, no
// deletions, no stale-link cleanup.
async function syncCatalog(opts: { onlyEventId?: string } = {}) {
  const scoped = !!opts.onlyEventId;
  const events = await upcomingEvents();
  const taxId = await ensureTax();

  const { data: itemRows } = await admin.from("class_square_items").select("*").eq("env", ENV);
  const { data: linkRows } = await admin.from("class_square_links").select("*").eq("env", ENV);
  const items = new Map((itemRows ?? []).map((r) => [r.item_key, r]));
  const links = new Map((linkRows ?? []).map((r) => [r.event_id, r]));

  // group. Classes keep EXACTLY the historic key: changing it would delete and
  // recreate every live item. Other kinds are namespaced by kind, so a Mahjong
  // night and a class of the same name in the same shop stay separate items.
  type Group = {
    kind: string; cfg: KindCfg; title: string; location: string; loc: string;
    report: string; events: Record<string, any>[];
  };
  const groups = new Map<string, Group>();
  const pending: string[] = [];
  const noLoc: string[] = [];
  for (const ev of events) {
    const cfg = kindCfg(ev.kind)!;
    const report = await reportingCategory(String(ev.kind));
    // No production reporting category chosen for this kind yet: never guess.
    if (!report) { pending.push(ev.id); continue; }
    // An event whose shop has no Square location (a typo, a closed Franklin
    // date) is skipped and reported. It used to throw, which took the whole
    // sync — and now checkout's "ensure" — down with it. (2026-10-09)
    let loc: string;
    try {
      loc = await locationFor(ev);
    } catch (_) {
      noLoc.push(ev.id);
      continue;
    }
    const base = `${String(ev.location).toLowerCase()}|${String(ev.title).trim().toLowerCase()}`;
    const key = ev.kind === "class" ? base : `${ev.kind}:${base}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: String(ev.kind), cfg, title: String(ev.title).trim(), location: ev.location,
        loc, report, events: [],
      });
    }
    groups.get(key)!.events.push(ev);
  }

  // "ensure" works on the one group that holds the asked-for event.
  const work = new Map(groups);
  const out: Record<string, any> = { groups: 0, written: 0, deleted: 0, unchanged: 0, adopted: 0, raced: 0 };
  if (scoped) {
    const want = String(opts.onlyEventId);
    const hit = [...groups.entries()].find(([, g]) => g.events.some((e) => e.id === want));
    work.clear();
    if (hit) work.set(hit[0], hit[1]);
    out.event_ids = hit ? hit[1].events.map((e) => e.id) : [];
  }
  out.groups = work.size;
  const mine = (ids: string[]) => (scoped ? ids.filter((id) => id === String(opts.onlyEventId)) : ids);
  const pendingOut = mine(pending);
  if (pendingOut.length) out.pending_reporting_category = pendingOut;
  const noLocOut = mine(noLoc);
  if (noLocOut.length) out.no_location = noLocOut;
  if (!scoped) {
    const other = await unsupportedKindEvents();
    if (other.length) out.unsupported_kind = other;
  }

  for (const [key, g] of work) {
    const categoryId = await ensureCategory(g.cfg.locPrefix, String(g.location ?? "").trim());
    // A tabled event (Mahjong) is sold as whole tables: one variation is
    // party_size seats, and the register price is the whole table.
    const table = g.cfg.unit === "table";
    const partyOf = (ev: Record<string, any>) => (table ? partySizeOf(ev) : 1);
    const priceOf = (ev: Record<string, any>) => Math.round(Number(ev.price) * partyOf(ev) * (1 + FEE_RATE));
    // Classes normally run once: then the item carries the date in its name
    // and has a single plain "Regular" variation, so the register never asks
    // for a date. Only a title with several dates gets one variation per date.
    const single = g.events.length === 1;
    const desired = g.events.map((ev, i) => ({
      id: ev.id,
      name: table
        ? (single ? `Table of ${partyOf(ev)}` : `${niceWhen(ev.date, ev.time)} · table of ${partyOf(ev)}`)
        : (single ? "Regular" : niceWhen(ev.date, ev.time)),
      price: priceOf(ev),
      ord: i,
    }));
    // Staff-only names (Maverick): "A Nightmare on Cheese Street - Oct 28".
    // The shop is already the category (Classes – Memphis / – Nashville).
    const shortDate = (d: string) =>
      new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const itemName = single ? `${g.title} - ${shortDate(g.events[0].date)}` : g.title;
    // Upgrades (charcuterie, wine...) -> one modifier list per item, union of
    // the group's add-ons keyed by display name. Register price carries the fee.
    // Tabled events never get one: the site sends no upgrades for them.
    const mods: { key: string; name: string; price: number; addonIds: Record<string, string[]> }[] = [];
    if (!table) {
      for (const ev of g.events) {
        for (const a of (Array.isArray(ev.add_ons) ? ev.add_ons : []) as any[]) {
          const name = upgradeName(a.name);
          const price = Math.round(Number(a.price ?? 0) * (1 + FEE_RATE));
          const key = `${name.toLowerCase()}|${price}`;
          let m = mods.find((x) => x.key === key);
          if (!m) mods.push(m = { key, name, price, addonIds: {} });
          (m.addonIds[ev.id] ??= []).push(String(a.id));
        }
      }
    }
    // v:3 adds the reporting category, the kind and the party size, so every
    // existing item is rewritten once with its new reporting category.
    const sig = await sha(JSON.stringify({
      n: itemName, loc: g.loc, c: categoryId, rc: g.report, t: taxId, d: desired,
      m: mods.map((m) => [m.name, m.price]),
      k: g.kind, u: g.cfg.unit, p: g.events.map((ev) => partyOf(ev)), v: 3,
    }));
    const have = items.get(key);
    if (have && have.sig === sig && g.events.every((ev) => links.get(ev.id)?.square_item_id === have.square_item_id)) {
      out.unchanged++;
      continue;
    }

    // Start from Square's current object so seller-managed fields (image,
    // channels, online visibility) survive the upsert.
    let cur: Record<string, any> | null = null;
    if (have) {
      try {
        cur = (await sq(`/v2/catalog/object/${have.square_item_id}`)).object ?? null;
        if (cur?.is_deleted) cur = null;
      } catch (e) {
        if (!(e instanceof SqErr && e.status === 404)) throw e;
      }
    }
    const itemId = cur?.id ?? `#item`;
    const curVars = new Map<string, any>(
      ((cur?.item_data?.variations ?? []) as any[]).map((v) => [v.id, v]),
    );

    const variations = g.events.map((ev, i) => {
      const link = links.get(ev.id);
      const prior = link && link.square_item_id === cur?.id ? curVars.get(link.square_variation_id) : null;
      const v: Record<string, any> = prior ? structuredClone(prior) : {
        type: "ITEM_VARIATION", id: `#v_${ev.id}`, item_variation_data: {},
      };
      v.present_at_all_locations = false;
      v.present_at_location_ids = [g.loc];
      Object.assign(v.item_variation_data, {
        item_id: itemId,
        name: desired[i].name,
        sku: `${g.cfg.skuPrefix}-${String(ev.id).slice(0, 8).toUpperCase()}`,
        ordinal: i,
        pricing_type: "FIXED_PRICING",
        price_money: money(desired[i].price),
        track_inventory: true,
        sellable: true,
        stockable: true,
        location_overrides: [{ location_id: g.loc, track_inventory: true }],
      });
      return v;
    });

    // Modifier list: reuse the stored one (and its modifier ids, by name).
    let ml: Record<string, any> | null = null;
    if (mods.length && have?.modifier_list_id) {
      try {
        ml = (await sq(`/v2/catalog/object/${have.modifier_list_id}`)).object ?? null;
        if (ml?.is_deleted) ml = null;
      } catch (e) {
        if (!(e instanceof SqErr && e.status === 404)) throw e;
      }
    }
    const curMods = new Map<string, any>(
      ((ml?.modifier_list_data?.modifiers ?? []) as any[])
        .map((m) => [String(m.modifier_data?.name ?? "").toLowerCase(), m]),
    );
    let mlObj: Record<string, any> | null = null;
    if (mods.length) {
      mlObj = ml ? structuredClone(ml) : { type: "MODIFIER_LIST", id: "#ml", modifier_list_data: {} };
      mlObj.present_at_all_locations = false;
      mlObj.present_at_location_ids = [g.loc];
      Object.assign(mlObj.modifier_list_data, {
        name: `Upgrades – ${g.title} (${g.location})`.slice(0, 255),
        selection_type: "MULTIPLE",
        modifiers: mods.map((m, i) => {
          const prior = curMods.get(m.name.toLowerCase());
          const mo: Record<string, any> = prior ? structuredClone(prior) : { type: "MODIFIER", id: `#m${i}`, modifier_data: {} };
          mo.present_at_all_locations = false;
          mo.present_at_location_ids = [g.loc];
          Object.assign(mo.modifier_data, {
            name: m.name, price_money: money(m.price), ordinal: i,
            modifier_list_id: mlObj!.id,
          });
          return mo;
        }),
      });
    }

    const obj: Record<string, any> = cur ? structuredClone(cur) : { type: "ITEM", id: itemId, item_data: {} };
    obj.present_at_all_locations = false;
    obj.present_at_location_ids = [g.loc];
    Object.assign(obj.item_data, {
      name: itemName.slice(0, 255),
      description: "",
      product_type: "REGULAR",
      categories: keepCategories(cur, categoryId, have?.category_id ?? null, g.report),
      // Square's item-sales report groups by the REPORTING category, so that one
      // is the kind's top-level category ("Classes" / "Experiences"), not the
      // per-shop one. Square adds it to categories[] by itself; that is fine.
      reporting_category: { id: g.report },
      tax_ids: [taxId],
      variations,
      modifier_list_info: mlObj
        ? [{ modifier_list_id: mlObj.id, enabled: true, min_selected_modifiers: 0, max_selected_modifiers: mods.length }]
        : [],
    });
    delete obj.item_data.category_id;
    delete obj.item_data.description_html;
    delete obj.item_data.description_plaintext;

    // The 5-minute cron and a checkout "ensure" can run at the same time, so
    // CREATING an item is keyed deterministically on (env, item key, sig): two
    // runs can never make two items for one class. An update keeps a random key
    // (its object id is already the thing being written). (2026-10-09)
    const batches = [{ objects: mlObj ? [mlObj, obj] : [obj] }];
    const creating = !cur;
    let res: Record<string, any>;
    try {
      res = await sq("/v2/catalog/batch-upsert", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: creating
            ? `ci-${ENV}-${await sha(key)}-${sig}`.slice(0, 128)
            : crypto.randomUUID(),
          batches,
        }),
      });
    } catch (e) {
      if (!creating || !isIdemReuse(e)) throw e;
      const row = await itemRowFor(key);
      if (row && row.square_item_id !== (have?.square_item_id ?? null)) {
        // The other run created it. Its links were written with it: nothing to do.
        out.adopted++;
        continue;
      }
      if (!row) {
        // The other run has not written its rows yet. The next sync picks it up.
        out.raced++;
        console.error("catalog idempotency race", key);
        continue;
      }
      // Our own earlier run burned this key and the item has since been deleted
      // in Square: create a fresh one.
      res = await sq("/v2/catalog/batch-upsert", {
        method: "POST",
        body: JSON.stringify({ idempotency_key: crypto.randomUUID(), batches }),
      });
    }
    const map = new Map<string, string>(
      (res.id_mappings ?? []).map((m: any) => [m.client_object_id, m.object_id]),
    );
    const realItem = map.get("#item") ?? itemId;
    const realMl = mlObj ? (map.get("#ml") ?? mlObj.id) : null;
    // Upserted objects come back with their real ids; read the modifiers off it.
    const savedMl = realMl
      ? ((res.objects ?? []) as any[]).find((o) => o.id === realMl) ?? null
      : null;
    const modIdByName = new Map<string, string>(
      ((savedMl?.modifier_list_data?.modifiers ?? []) as any[])
        .map((m) => [String(m.modifier_data?.name ?? "").toLowerCase(), m.id]),
    );
    if (have?.modifier_list_id && have.modifier_list_id !== realMl) {
      try { await sq(`/v2/catalog/object/${have.modifier_list_id}`, { method: "DELETE" }); } catch (_) { /* gone */ }
    }
    await admin.from("class_square_items").upsert({
      env: ENV, item_key: key, square_item_id: realItem, location_id: g.loc,
      category_id: categoryId, sig, modifier_list_id: realMl, updated_at: new Date().toISOString(),
    });
    for (const ev of g.events) {
      const link = links.get(ev.id);
      const vid = map.get(`#v_${ev.id}`) ??
        (link && link.square_item_id === realItem ? link.square_variation_id : null);
      if (!vid) continue;
      await admin.from("class_square_links").upsert({
        env: ENV, event_id: ev.id, item_key: key, square_item_id: realItem, square_variation_id: vid,
        location_id: g.loc, price_cents: priceOf(ev), sig,
        modifier_ids: Object.fromEntries(mods.flatMap((m) =>
          (m.addonIds[ev.id] ?? []).map((aid) => [aid, modIdByName.get(m.name.toLowerCase()) ?? null])
        ).filter(([, v]) => v)),
        ...(link?.square_variation_id === vid ? {} : { stock_set: null, stock_at: null }),
        updated_at: new Date().toISOString(),
      });
    }
    out.written++;
  }

  // "ensure" touches one group only: it must never delete another item or drop
  // another event's link.
  if (!scoped) {
    // Items whose events have all passed / been archived: delete from Square.
    for (const [key, row] of items) {
      if (groups.has(key)) continue;
      try { await sq(`/v2/catalog/object/${row.square_item_id}`, { method: "DELETE" }); }
      catch (e) { if (!(e instanceof SqErr && e.status === 404)) throw e; }
      await admin.from("class_square_items").delete().eq("env", ENV).eq("item_key", key);
      out.deleted++;
    }
    // Links for events no longer upcoming (their variation went with the item
    // rewrite). Keep links for past classes a week so late returns still map.
    const live = new Set(events.map((e) => e.id));
    const stale = (linkRows ?? []).filter((l) => !live.has(l.event_id)).map((l) => l.event_id);
    if (stale.length) {
      const { data: old } = await admin.from("events").select("id,date").in("id", stale);
      const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      const drop = (old ?? []).filter((e) => !e.date || e.date < cutoff).map((e) => e.id);
      if (drop.length) await admin.from("class_square_links").delete().eq("env", ENV).in("event_id", drop);
    }
  }
  return out;
}

// ---------------------------------------------------------------- inventory
// onlyEventIds limits the push to one group's links ("ensure"); the 5-minute
// sync passes nothing and pushes every linked event.
async function syncInventory(force = false, onlyEventIds?: Set<string>) {
  const events = await upcomingEvents();
  const byId = new Map(events.map((e) => [e.id, e]));
  const { data: links } = await admin.from("class_square_links").select("*").eq("env", ENV);
  const changes: any[] = [];
  const updates: { event_id: string; left: number }[] = [];
  for (const l of links ?? []) {
    if (onlyEventIds && !onlyEventIds.has(l.event_id)) continue;
    const ev = byId.get(l.event_id);
    if (!ev) continue;
    const { data: taken } = await admin.rpc("ticket_seats_taken", { p_event_id: ev.id });
    const seats = Math.max(0, Number(ev.capacity ?? 0) - Number(taken ?? 0));
    // A tabled event's stock is TABLES, not seats: a 24-seat Mahjong night with
    // party_size 4 and one table sold has 5 tables left. (2026-10-09)
    const left = kindCfg(ev.kind)?.unit === "table" ? Math.floor(seats / partySizeOf(ev)) : seats;
    const fresh = l.stock_at && Date.now() - new Date(l.stock_at).getTime() < 6 * 3600e3;
    if (!force && l.stock_set === left && fresh) continue;
    changes.push({
      type: "PHYSICAL_COUNT",
      physical_count: {
        catalog_object_id: l.square_variation_id, state: "IN_STOCK", location_id: l.location_id,
        quantity: String(left), occurred_at: new Date().toISOString(),
      },
    });
    updates.push({ event_id: l.event_id, left });
  }
  for (let i = 0; i < changes.length; i += 100) {
    await sq("/v2/inventory/changes/batch-create", {
      method: "POST",
      body: JSON.stringify({ idempotency_key: crypto.randomUUID(), changes: changes.slice(i, i + 100) }),
    });
  }
  const now = new Date().toISOString();
  for (const u of updates) {
    await admin.from("class_square_links").update({ stock_set: u.left, stock_at: now })
      .eq("env", ENV).eq("event_id", u.event_id);
  }
  return { pushed: changes.length };
}

// ------------------------------------------------------------------- ensure
// Called by square-ticket-pay at checkout when an event has no usable
// class_square_links row, so every online sale reaches Square as a real
// catalog line instead of an ad-hoc one (2026-10-09). It syncs only the group
// that holds this event (the whole group, so the item stays complete), deletes
// nothing, then pushes that group's stock and hands back the link row.
async function ensure(eventId: string) {
  const id = String(eventId ?? "").trim();
  if (!id) return { link: null, reason: "no event id" };
  const { data: ev } = await admin.from("events")
    .select("id,title,date,time,price,capacity,location,kind,party_size,archived,add_ons")
    .eq("id", id).maybeSingle();
  if (!ev) return { link: null, reason: "not found" };
  if (ev.archived) return { link: null, reason: "archived" };
  if (!(Number(ev.price) > 0)) return { link: null, reason: "price 0" };
  if (!salesOpen(ev)) return { link: null, reason: "sales closed" };
  if (!kindCfg(ev.kind)) return { link: null, reason: `unsupported kind ${String(ev.kind)}` };
  if (!(await reportingCategory(String(ev.kind)))) {
    return { link: null, reason: "pending reporting category" };
  }
  try {
    await locationFor(ev);
  } catch (e) {
    return { link: null, reason: `no location: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  }

  const catalog = await syncCatalog({ onlyEventId: id });
  const ids: string[] = (catalog.event_ids as string[] | undefined) ?? [id];
  let inventory: unknown;
  try {
    inventory = await syncInventory(false, new Set(ids));
  } catch (e) {
    // The item is what checkout needs; a stock push that failed is not fatal.
    inventory = `error: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
  }
  const { data: link } = await admin.from("class_square_links").select("*")
    .eq("env", ENV).eq("event_id", id).maybeSingle();
  return link
    ? { link, catalog, inventory }
    : { link: null, reason: "catalog sync produced no link", catalog, inventory };
}

// --------------------------------------------------------------------- pull
async function customerOf(order: Record<string, any>) {
  const cid = order.customer_id ?? (order.tenders ?? []).find((t: any) => t.customer_id)?.customer_id;
  if (cid) {
    try {
      const c = (await sq(`/v2/customers/${cid}`)).customer ?? {};
      const name = `${c.given_name ?? ""} ${c.family_name ?? ""}`.trim() || c.company_name || "";
      return { name, email: String(c.email_address ?? "").toLowerCase(), phone: c.phone_number ?? "" };
    } catch (_) { /* fall through */ }
  }
  const r = (order.fulfillments ?? [])[0]?.pickup_details?.recipient ?? {};
  return { name: r.display_name ?? "", email: String(r.email_address ?? "").toLowerCase(), phone: r.phone_number ?? "" };
}

// A refund taken in Square itself (Dashboard, POS or the Refunds API) creates a
// RETURN order pointing back at the sale. For a ticket-site order that return
// never reached ticket_payments, so the booking stayed "paid" and the seats
// stayed held (2026-10-07). Read the refunded-to-date total off the payment(s)
// and mirror exactly what square-ticket-pay's admin refund() writes.
// pull() only looks back to the last pulled_to minus 10 minutes, so an older
// refund needs a manual backfill: {"action":"pull","days":N}.
async function syncTicketRefund(sourceOrderId: string): Promise<boolean> {
  if (!sourceOrderId) return false;
  try {
    const { data: row } = await admin.from("ticket_payments").select("*")
      .eq("square_order_id", sourceOrderId).eq("square_env", ENV)
      .in("status", ["paid", "partially_refunded"]).limit(1).maybeSingle();
    if (!row) return false;

    // Split-tender rows carry a second payment; refunded_money on each is
    // "the total amount of the payment refunded to date".
    const ids = [row.square_payment_id, row.gift_payment_id]
      .filter((id, i, all) => !!id && all.indexOf(id) === i) as string[];
    let refunded = 0;
    const refundIds: string[] = [];
    for (const pid of ids) {
      const p = (await sq(`/v2/payments/${pid}`)).payment ?? {};
      refunded += Math.round(Number(p.refunded_money?.amount ?? 0));
      for (const rid of (p.refund_ids ?? []) as string[]) refundIds.push(String(rid));
    }

    // Same total square-ticket-pay refund() works from: the tip rode on the card.
    const total = Math.round(Number(row.total_cents ?? 0)) + Math.round(Number(row.tip_cents ?? 0));
    const already = Math.round(Number(row.refunded_cents ?? 0));
    // The portal's own refund() already updated the row, so that case lands
    // here as a no-op. Never decrease.
    if (refunded <= already) return false;

    const full = refunded >= total;
    const status = full ? "refunded" : "partially_refunded";
    const now = new Date().toISOString();
    // The ledger's existing ids came from the Refunds API; Payment.refund_ids
    // uses the PaymentRefund id format. Union the strings, don't normalise.
    const union = Array.from(new Set([...((row.square_refund_ids ?? []) as string[]), ...refundIds]));

    await admin.from("ticket_payments").update({
      refunded_cents: refunded, status, square_refund_ids: union, updated_at: now,
    }).eq("id", row.id);

    if (row.registration_id) {
      // ticket_seats_taken() excludes refunded=true rows, so a full refund
      // releases the seats exactly like the portal refund does; a partial
      // refund keeps them, same as today.
      await admin.from("registrations").update({
        payment_status: status, refunded_cents: refunded,
        refunded: full, refunded_at: full ? now : null,
      }).eq("id", row.registration_id);
    }
    return true;
  } catch (e) {
    // One bad row must not stop the 5-minute sync.
    console.error("ticket refund sync", sourceOrderId, String(e instanceof Error ? e.message : e).slice(0, 300));
    return false;
  }
}

async function pull(days?: number) {
  const { data: state } = await admin.from("square_sync_state").select("*").eq("id", STATE_ID).maybeSingle();
  const since = days
    ? new Date(Date.now() - days * 864e5)
    : state?.stats?.pulled_to
    ? new Date(new Date(state.stats.pulled_to).getTime() - 10 * 60e3)
    : new Date(Date.now() - 3 * 864e5);
  const startedAt = new Date().toISOString();

  const { data: links } = await admin.from("class_square_links").select("event_id,square_variation_id").eq("env", ENV);
  const varToEvent = new Map((links ?? []).map((l) => [l.square_variation_id, l.event_id]));
  // A tabled event's variation IS one table, so a register line of quantity 2
  // is 2 tables = 2 x party_size seats. Classes keep party 1. (2026-10-09)
  const kindOf = new Map<string, { kind: string; party: number }>();
  if (varToEvent.size) {
    const { data: evs } = await admin.from("events").select("id,kind,party_size")
      .in("id", [...new Set(varToEvent.values())]);
    for (const e of evs ?? []) kindOf.set(e.id, { kind: String(e.kind), party: partySizeOf(e) });
  }
  const seatsPerUnit = (eventId: string) => {
    const inf = kindOf.get(eventId);
    return kindCfg(inf?.kind)?.unit === "table" ? (inf?.party ?? 1) : 1;
  };
  const out = { scanned: 0, added: 0, returns: 0, ticket_refunds: 0, skipped_online: 0 };
  // No class links for this env used to return early here. The scan has to run
  // either way now: a refund made in Square on a ticket-site order only reaches
  // ticket_payments through the returns loop below (2026-10-07). An empty
  // varToEvent already makes the register-sale (line item) part a no-op.
  const note = varToEvent.size ? undefined : "no class items yet";

  let cursor: string | undefined;
  do {
    const d = await sq("/v2/orders/search", {
      method: "POST",
      body: JSON.stringify({
        location_ids: await allLocations(),
        cursor,
        limit: 100,
        query: {
          filter: {
            state_filter: { states: ["COMPLETED"] },
            date_time_filter: { updated_at: { start_at: since.toISOString() } },
          },
          sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
        },
      }),
    });
    cursor = d.cursor;
    for (const o of d.orders ?? []) {
      out.scanned++;
      // Ticket-site orders already made their own registration. Square only
      // shows an order's metadata to the app that wrote it, so also match the
      // order id against the ticket-site payment ledger.
      if (o.metadata?.source === "ticket-site") { out.skipped_online++; continue; }
      const { data: online } = await admin.from("ticket_payments").select("id")
        .eq("square_order_id", o.id).limit(1);
      if (online?.length) { out.skipped_online++; continue; }

      for (const li of o.line_items ?? []) {
        const eventId = varToEvent.get(li.catalog_object_id);
        if (!eventId) continue;
        const { data: seen } = await admin.from("class_register_sales").select("line_uid")
          .eq("env", ENV).eq("square_order_id", o.id).eq("line_uid", li.uid).maybeSingle();
        if (seen) continue;

        const units = Math.max(1, Math.round(Number(li.quantity ?? 1)));
        const perUnit = seatsPerUnit(eventId);
        // Seats: the line quantity for a class, tables x party_size for a
        // tabled event.
        const qty = units * perUnit;
        const who = await customerOf(o);
        const total = Number(li.total_money?.amount ?? 0);
        // Upgrades rung as modifiers apply to every seat on the line. A tabled
        // event has no modifier list, so there is nothing to read.
        const addOns = perUnit > 1 ? [] : ((li.modifiers ?? []) as any[]).map((m) => ({
          name: cleanLine(m.name, 120),
          qty: qty * Math.max(1, Math.round(Number(m.quantity ?? 1))),
          price: Math.round(Number(m.base_price_money?.amount ?? 0) / (1 + FEE_RATE)),
        }));
        // optText feeds the guest roster below, so it has to exist before the
        // notes are built — it used to be read in guests.map() one statement
        // before its own const, which threw on any line with a note.
        const optText = addOns.map((a) => a.name).join(", ");
        const guests = String(li.note ?? "").split(/[,;\n]+/).map((s) => cleanLine(s, 80)).filter(Boolean);
        const notes = [
          `Sold at the register${ENV === "sandbox" ? " [SANDBOX TEST]" : ""} · Square order ${o.id}`,
          guests.length
            ? `Guests: ${guests.map((gn) => optText ? `${gn} (${optText})` : gn).join("; ")}`
            : "",
        ].filter(Boolean).join("\n");
        const { data: reg, error } = await admin.from("registrations").insert({
          event_id: eventId,
          code: bookingCode(),
          name: cleanLine(who.name, 120) || "Register sale",
          email: who.email || "",
          phone: who.phone || "",
          qty,
          add_ons: addOns,
          notes,
          total,
          square_order_id: o.id,
          square_payment_id: (o.tenders ?? [])[0]?.payment_id ?? (o.tenders ?? [])[0]?.id ?? null,
          card_brand: (o.tenders ?? [])[0]?.card_details?.card?.card_brand ?? ((o.tenders ?? [])[0]?.type ?? null),
          card_last4: (o.tenders ?? [])[0]?.card_details?.card?.last_4 ?? null,
          // Sandbox shares the live DB: a test sale must never hold a real seat.
          payment_status: ENV === "sandbox" ? "canceled" : "paid",
          refunded: ENV === "sandbox",
        }).select("id").single();
        if (error) throw new Error(error.message);
        await admin.from("class_register_sales").insert({
          env: ENV, square_order_id: o.id, line_uid: li.uid, event_id: eventId,
          registration_id: reg.id, qty, total_cents: total, buyer_name: who.name || null,
        });
        out.added++;
      }

      // Returns: a return order points back at the sale it came from.
      for (const ret of o.returns ?? []) {
        // The skip above is for the ORIGINAL ticket-site order. This return is a
        // different order and is not in ticket_payments, so it gets here.
        if (await syncTicketRefund(String(ret.source_order_id ?? ""))) out.ticket_refunds++;
        for (const rl of ret.return_line_items ?? []) {
          const { data: sale } = await admin.from("class_register_sales").select("*")
            .eq("env", ENV).eq("square_order_id", ret.source_order_id ?? "")
            .eq("line_uid", rl.source_line_item_uid ?? "").maybeSingle();
          if (!sale) continue;
          const key = `R:${o.id}:${rl.uid}`;
          const { data: done } = await admin.from("class_register_sales").select("line_uid")
            .eq("env", ENV).eq("square_order_id", sale.square_order_id).eq("line_uid", key).maybeSingle();
          if (done) continue;
          // Returned units are tables for a tabled event: n is always seats.
          const n = Math.max(1, Math.round(Number(rl.quantity ?? 1))) * seatsPerUnit(sale.event_id);
          const returned = Math.min(sale.qty, sale.returned_qty + n);
          await admin.from("class_register_sales").insert({
            env: ENV, square_order_id: sale.square_order_id, line_uid: key, event_id: sale.event_id,
            registration_id: sale.registration_id, qty: -n,
            total_cents: -Number(rl.total_money?.amount ?? 0),
          });
          await admin.from("class_register_sales").update({ returned_qty: returned })
            .eq("env", ENV).eq("square_order_id", sale.square_order_id).eq("line_uid", sale.line_uid);
          if (sale.registration_id) {
            const left = sale.qty - returned;
            await admin.from("registrations").update(
              left <= 0
                ? { refunded: true, refunded_at: new Date().toISOString(), payment_status: "refunded",
                    refunded_cents: sale.total_cents }
                : { qty: left, payment_status: ENV === "sandbox" ? "canceled" : "partially_refunded" },
            ).eq("id", sale.registration_id);
          }
          out.returns++;
        }
      }
    }
  } while (cursor);

  await admin.from("square_sync_state").upsert({
    id: STATE_ID, last_run_at: startedAt, last_ok_at: startedAt, last_error: null,
    stats: { ...(state?.stats ?? {}), pulled_to: startedAt, last_pull: out },
  });
  return note ? { ...out, note } : out;
}

// ----------------------------------------------- sandbox: fake a register sale
async function simulate(body: Record<string, any>) {
  if (ENV !== "sandbox") throw new Error("simulate is sandbox-only");
  const { data: link } = await admin.from("class_square_links").select("*")
    .eq("env", ENV).eq("event_id", String(body.eventId ?? "")).maybeSingle();
  if (!link) throw new Error("that class has no Square item yet — run catalog first");
  const qty = Math.max(1, Math.min(8, Number(body.qty ?? 2)));
  const o = await sq("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: link.location_id,
        line_items: [{
          catalog_object_id: link.square_variation_id, quantity: String(qty),
          note: String(body.guests ?? "Test Guest One, Test Guest Two"),
          modifiers: body.upgrade
            ? Object.values(link.modifier_ids ?? {}).slice(0, 1).map((id) => ({ catalog_object_id: id }))
            : undefined,
        }],
      },
    }),
  });
  const order = o.order;
  const p = await sq("/v2/payments", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(), source_id: "cnon:card-nonce-ok",
      amount_money: order.total_money, order_id: order.id, location_id: link.location_id,
      autocomplete: true,
    }),
  });
  return { order_id: order.id, total: order.total_money, tax: order.total_tax_money, payment: p.payment?.status };
}

// ------------------------------------------------------------------- server
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const action = String(body.action ?? "sync");
  try {
    let result: unknown;
    if (action === "catalog") result = await syncCatalog();
    else if (action === "ensure") result = await ensure(String(body.eventId ?? body.event_id ?? ""));
    else if (action === "inventory") result = await syncInventory(!!body.force);
    else if (action === "pull") result = await pull(body.days ? Number(body.days) : undefined);
    else if (action === "simulate") result = await simulate(body);
    else if (action === "status") {
      const { data } = await admin.from("square_sync_state").select("*").eq("id", STATE_ID).maybeSingle();
      const { count } = await admin.from("class_square_links").select("event_id", { count: "exact", head: true }).eq("env", ENV);
      result = { env: ENV, state: data, linked_dates: count };
    } else if (action === "sync") {
      // Order matters: import register sales BEFORE resetting stock, so a sale
      // already rung up is counted in the seats-taken the stock is set from.
      const catalog = await syncCatalog();
      const pulled = await pull();
      const inventory = await syncInventory(!!body.force);
      result = { catalog, pulled, inventory };
    } else throw new Error(`unknown action ${action}`);
    return new Response(JSON.stringify({ ok: true, env: ENV, result }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 800);
    console.error(action, msg);
    try {
      await admin.from("square_sync_state").update({ last_run_at: new Date().toISOString(), last_error: msg }).eq("id", STATE_ID);
    } catch (_) { /* ignore */ }
    return new Response(JSON.stringify({ ok: false, env: ENV, error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
