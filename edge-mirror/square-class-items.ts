// ============================================================================
// square-class-items — classes as Square catalog items, sold on the register,
// landing back in the class roster. (2026-09-26)
//
//   catalog   one Square ITEM per class title per shop ("Class – <title> (<shop>)"),
//             one VARIATION per date, category "Classes", TN 9.75% additive tax.
//             Register price = ticket x (1 + fee) so the register total matches
//             online (ticket + tax + service fee).
//   inventory each date's Square stock = seats left (capacity - seats taken).
//   pull      completed register orders with a class line -> a registration on
//             that class. Returns reduce / refund the registration.
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
const FEE_RATE = Number(Deno.env.get("TICKET_FEE_RATE") ?? "0.06");
const CATEGORY_NAME = "Classes";
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

const money = (c: number) => ({ amount: Math.round(c), currency: "USD" });
const todayCentral = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
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
function keepCategories(cur: Record<string, any> | null, categoryId: string, prevCategoryId: string | null) {
  const had = ((cur?.item_data?.categories ?? []) as any[])
    .filter((c) => c?.id && (c.id === categoryId || c.id !== prevCategoryId));
  return had.some((c) => c.id === categoryId) ? had : [{ id: categoryId }, ...had];
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
// reports only carry its own classes.
const catCache = new Map<string, string>();
async function ensureCategory(location = ""): Promise<string> {
  const name = location ? `${CATEGORY_NAME} – ${location}` : CATEGORY_NAME;
  if (catCache.has(name)) return catCache.get(name)!;
  const id = await ensureCategoryNamed(name);
  catCache.set(name, id);
  return id;
}
async function ensureCategoryNamed(CATEGORY_NAME: string): Promise<string> {
  const hit = await findByName("CATEGORY", CATEGORY_NAME);
  if (hit) return hit.id;
  const d = await sq("/v2/catalog/object", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      object: { type: "CATEGORY", id: "#classes", category_data: { name: CATEGORY_NAME, is_top_level: true } },
    }),
  });
  return d.catalog_object.id;
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
async function upcomingClasses() {
  const { data, error } = await admin.from("events")
    .select("id,title,date,time,price,capacity,location,kind,archived,add_ons")
    .eq("kind", "class").gte("date", todayCentral()).gt("price", 0)
    .order("date").order("time");
  if (error) throw new Error(error.message);
  return (data ?? []).filter((e) => !e.archived);
}

async function syncCatalog() {
  const events = await upcomingClasses();
  const taxId = await ensureTax();

  const { data: itemRows } = await admin.from("class_square_items").select("*").eq("env", ENV);
  const { data: linkRows } = await admin.from("class_square_links").select("*").eq("env", ENV);
  const items = new Map((itemRows ?? []).map((r) => [r.item_key, r]));
  const links = new Map((linkRows ?? []).map((r) => [r.event_id, r]));

  // group
  const groups = new Map<string, { title: string; location: string; loc: string; events: any[] }>();
  for (const ev of events) {
    const key = `${String(ev.location).toLowerCase()}|${String(ev.title).trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, { title: String(ev.title).trim(), location: ev.location, loc: await locationFor(ev), events: [] });
    }
    groups.get(key)!.events.push(ev);
  }

  const out = { groups: groups.size, written: 0, deleted: 0, unchanged: 0 };

  for (const [key, g] of groups) {
    const categoryId = await ensureCategory(String(g.location ?? "").trim());
    const priceOf = (ev: any) => Math.round(Number(ev.price) * (1 + FEE_RATE));
    // Classes normally run once: then the item carries the date in its name
    // and has a single plain "Regular" variation, so the register never asks
    // for a date. Only a title with several dates gets one variation per date.
    const single = g.events.length === 1;
    const desired = g.events.map((ev, i) => ({
      id: ev.id, name: single ? "Regular" : niceWhen(ev.date, ev.time), price: priceOf(ev), ord: i,
    }));
    // Staff-only names (Maverick): "A Nightmare on Cheese Street - Oct 28".
    // The shop is already the category (Classes – Memphis / – Nashville).
    const shortDate = (d: string) =>
      new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const itemName = single ? `${g.title} - ${shortDate(g.events[0].date)}` : g.title;
    // Upgrades (charcuterie, wine...) -> one modifier list per item, union of
    // the group's add-ons keyed by display name. Register price carries the fee.
    const mods: { key: string; name: string; price: number; addonIds: Record<string, string[]> }[] = [];
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
    const sig = await sha(JSON.stringify({
      n: itemName, loc: g.loc, c: categoryId, t: taxId, d: desired,
      m: mods.map((m) => [m.name, m.price]), v: 2,
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
        sku: `CL-${String(ev.id).slice(0, 8).toUpperCase()}`,
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
      categories: keepCategories(cur, categoryId, have?.category_id ?? null),
      reporting_category: { id: categoryId },
      tax_ids: [taxId],
      variations,
      modifier_list_info: mlObj
        ? [{ modifier_list_id: mlObj.id, enabled: true, min_selected_modifiers: 0, max_selected_modifiers: mods.length }]
        : [],
    });
    delete obj.item_data.category_id;
    delete obj.item_data.description_html;
    delete obj.item_data.description_plaintext;

    const res = await sq("/v2/catalog/batch-upsert", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        batches: [{ objects: mlObj ? [mlObj, obj] : [obj] }],
      }),
    });
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

  // Items whose classes have all passed / been archived: delete from Square.
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
  return out;
}

// ---------------------------------------------------------------- inventory
async function syncInventory(force = false) {
  const events = await upcomingClasses();
  const byId = new Map(events.map((e) => [e.id, e]));
  const { data: links } = await admin.from("class_square_links").select("*").eq("env", ENV);
  const changes: any[] = [];
  const updates: { event_id: string; left: number }[] = [];
  for (const l of links ?? []) {
    const ev = byId.get(l.event_id);
    if (!ev) continue;
    const { data: taken } = await admin.rpc("ticket_seats_taken", { p_event_id: ev.id });
    const left = Math.max(0, Number(ev.capacity ?? 0) - Number(taken ?? 0));
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
  const out = { scanned: 0, added: 0, returns: 0, skipped_online: 0 };
  if (!varToEvent.size) return { ...out, note: "no class items yet" };

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

        const qty = Math.max(1, Math.round(Number(li.quantity ?? 1)));
        const who = await customerOf(o);
        const guests = String(li.note ?? "").split(/[,;\n]+/).map((s) => cleanLine(s, 80)).filter(Boolean);
        const notes = [
          `Sold at the register${ENV === "sandbox" ? " [SANDBOX TEST]" : ""} · Square order ${o.id}`,
          guests.length
            ? `Guests: ${guests.map((gn) => optText ? `${gn} (${optText})` : gn).join("; ")}`
            : "",
        ].filter(Boolean).join("\n");
        const total = Number(li.total_money?.amount ?? 0);
        // Upgrades rung as modifiers apply to every seat on the line.
        const addOns = ((li.modifiers ?? []) as any[]).map((m) => ({
          name: cleanLine(m.name, 120),
          qty: qty * Math.max(1, Math.round(Number(m.quantity ?? 1))),
          price: Math.round(Number(m.base_price_money?.amount ?? 0) / (1 + FEE_RATE)),
        }));
        const optText = addOns.map((a) => a.name).join(", ");
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
        for (const rl of ret.return_line_items ?? []) {
          const { data: sale } = await admin.from("class_register_sales").select("*")
            .eq("env", ENV).eq("square_order_id", ret.source_order_id ?? "")
            .eq("line_uid", rl.source_line_item_uid ?? "").maybeSingle();
          if (!sale) continue;
          const key = `R:${o.id}:${rl.uid}`;
          const { data: done } = await admin.from("class_register_sales").select("line_uid")
            .eq("env", ENV).eq("square_order_id", sale.square_order_id).eq("line_uid", key).maybeSingle();
          if (done) continue;
          const n = Math.max(1, Math.round(Number(rl.quantity ?? 1)));
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
  return out;
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
