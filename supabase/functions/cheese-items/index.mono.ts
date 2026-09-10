// cheese-items: add/edit cheese + wine/retail items with auto-assigned PLU.
// Cheese: DateCodeGenie + Square. Wine/Retail (item_kind=retail / skip_dcg): Square only.
// Secrets: DCG_API_KEY, DCG_AUTH_HEADER (default "Token"), DCG_AUTH_PREFIX (default ""),
//          SQUARE_ACCESS_TOKEN, SQUARE_ENV ("production"), SQUARE_TAX_ID (leave UNSET).
// Square merchant: Greys Fine Cheeses ML6ZX2AV0XKFN / location LCXWZ0HAQ69RM.
//
// ===========================================================================
// DateCodeGenie. Spec: https://www.datecodegenie.com/build/openapi.json — mirrored in dcg_openapi.
// AUTH: header `Token`, raw key, PLUS five client headers (Os, App-Version, App-Version-Code,
// Os-Version, Api-Version). Omitting them gives the misleading "400 Missing required header:
// location". There is no meaningful location header.
// CREATE POST /menu/menuitem (uuid required; `override` must be present or their PHP 500s).
// UPDATE POST /menu/menuitem/{id}  <- POST, not PUT. category_id required every time.
// Omitted fields are LEFT UNTOUCHED — that is how we avoid clobbering portal values.
//
// >>> 2026-09-05: printer_profile_id writes and is non-destructive. Proven on junk item 3810892:
// created at "0", sent 84849, came back "84849", and a later sync OMITTING it left it at "84849".
// Name -> id via dcg_printer_profile_map; an unmapped name is omitted, never guessed.
//
// >>> 2026-09-05: money goes out as a NUMBER, not a string, so DCG stores "30" the way the portal
// does rather than "30.00". This matched the portal exactly but did NOT fix the label bug below.
// Keep it anyway; do not "tidy" money() back into toFixed(2).
//
// DO NOT match items to DCG on PLU: 21 PLUs are shared by unrelated products. Match on name.
// DCG echoes the submitted payload under meta.payload on a 4xx.
// ===========================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DCG_BASE = "https://www.datecodegenie.com/api/menu";

// TN: unprepared food 4% state + 2.75% Shelby = 6.75%; prepared food 7% + 2.75% = 9.75%.
// A cheeseboard is prepared food even though the cheeses on it are not. (TN DoR SUT-53/54.)
const SQUARE_TAX_FOOD = "B5BSOZ3MBXTFWX4T4EPJ5YHB";      // TN Food 6.75%, additive
const SQUARE_TAX_PREPARED = "2K7XWRVWVXBTAJQIHHQOLFCN";  // TN Standard / prepared 9.75%, additive
const SQUARE_TAX_STANDARD = SQUARE_TAX_PREPARED;
const SQUARE_TAX_SALES_INCL = "MTLGRH6TG7GJMAEVCJGFQRIR"; // TN Sales Tax 9.75%, inclusive
const SQUARE_TAX_LBD_INCL = "DTD3GXE53SAZEZWQDYWALVSJ";   // TN Liquor by the Drink 15%, inclusive

// Unit of measure -> Square MEASUREMENT_UNIT id. LB predates this map; the rest were created
// 2026-09-03. Precision = decimal places the register accepts for the weight.
//   LB IMPERIAL_POUND p2 · OZ IMPERIAL_WEIGHT_OUNCE p2 · G METRIC_GRAM p0 · KG METRIC_KILOGRAM p3
// EA has no measurement unit at all — whole units.
// NOTE: the register only honours this on REGULAR (retail) items. Items on a Square for
// Restaurants menu become FOOD_AND_BEV and ignore it — a separate, still-open problem.
const SQUARE_UNIT_IDS: Record<string, string> = {
  LB: "RGKK6J7EYZPQVHJQSA4PNE5C",
  OZ: "4KM5WF5XFAUUOC2AWE6JQWGR",
  G: "77N7IIGPSFHIDWNLHCMU5YDD",
  KG: "OD6ZTEUW23AIZIPW7KU77UOE",
};
const VALID_UNITS = new Set(["LB", "OZ", "G", "KG", "EA"]);
const DEFAULT_UNIT = "LB";

// >>> 2026-09-05: THE PER-GRAM PRICE WORKAROUND.
// The DCG device weighs API-created items in GRAMS but multiplies by the per-POUND price.
// Measured: "tester msglester" at $30/lb, 1 lb on the scale, printed $13,607.70.
// 13607.70 / 30 = 453.59 = grams in a pound (ratio to 453.59237 is 0.999995 — not a rounding
// artefact). So we hand DCG a per-GRAM price_per_unit and let the device's own gram weight
// cancel it out.
// list_price keeps the TRUE per-pound figure: the portal then reads sanely, no-weight labels
// (which print list_price, not price_per_unit) stay correct, and there is an untouched
// reference value sitting next to the converted one.
// DCG stores 7 decimals — verified by writing 0.0661387 and reading it back unchanged — so
// precision is not a constraint. $30/lb -> 0.0661387/g -> x453.59 = $30.00 exactly.
//
// THIS IS A WORKAROUND ON A VENDOR BUG. When NCCO fixes the device weight unit, set
// cheese_plu_settings.dcg_gram_conversion = false and re-push every item with
// dcg_gram_priced = true, or those labels will print 454x too CHEAP.
const GRAMS_PER_UNIT: Record<string, number> = {
  LB: 453.59237,
  OZ: 28.349523125,
  KG: 1000,
  G: 1,
};

// Anything unrecognised falls back to LB — what every item used before the column existed.
function unitOf(item: Record<string, unknown>): string {
  const u = String(item.unit_of_measure ?? "").trim().toUpperCase();
  return VALID_UNITS.has(u) ? u : DEFAULT_UNIT;
}

const PREPARED_CATEGORIES = new Set([
  "Catering",
  "Catering and Large Cheeseboards",
  "Cheeseboards",
  "Dine In",
  "Prepared",
  "Prepared & Ready-to-Go",
]);

const STANDARD_CATEGORIES = new Set([
  "Beer",
  "Retail Wine",
  "Books & Gifts",
  "Cheese Tools & Serveware",
  "Merch & Apparel",
  "Drinks",
  "Retail Goods",
  "Memphis Retail",
]);

const WINE_DINE_IN_CATEGORIES = new Set([
  "Wine",
  "Wine GLS",
  "Wine BTL",
]);

function taxIdsForPreset(preset: string | null | undefined): string[] | null {
  const p = String(preset ?? "").trim().toLowerCase();
  if (!p || p === "auto") return null;
  if (p === "food") return [SQUARE_TAX_FOOD];
  if (p === "standard" || p === "prepared" || p === "retail_wine") return [SQUARE_TAX_STANDARD];
  if (p === "wine_dine_in" || p === "wine") return [SQUARE_TAX_SALES_INCL, SQUARE_TAX_LBD_INCL];
  return null;
}

function taxIdsForCategory(
  category: unknown,
  taxPreset?: string | null,
): string[] {
  const envOverride = Deno.env.get("SQUARE_TAX_ID");
  if (envOverride) return [envOverride];
  const fromPreset = taxIdsForPreset(taxPreset);
  if (fromPreset) return fromPreset;
  const cat = String(category ?? "").trim();
  if (WINE_DINE_IN_CATEGORIES.has(cat)) {
    return [SQUARE_TAX_SALES_INCL, SQUARE_TAX_LBD_INCL];
  }
  if (STANDARD_CATEGORIES.has(cat) || PREPARED_CATEGORIES.has(cat)) {
    return [SQUARE_TAX_STANDARD];
  }
  return [SQUARE_TAX_FOOD];
}

function taxIdForCategory(category: unknown): string {
  return taxIdsForCategory(category)[0] ?? SQUARE_TAX_FOOD;
}

const SQUARE_CATEGORY_IDS: Record<string, string> = {
  "Cheese": "3GBLBLAWUAPBIS4ADJVEMGFM",
  "Charcuterie": "FIAA5ZKGX4XFQNLHFV5ZUA22",
  "Specialty": "IJ74AFAIE5RS2TBX3ABGA3YJ",
  "Jams": "6WPR62AH6UUOCPVONDFFZNKG",
  "Catering": "CZYRPS4GN2NRWS5FPL3K3AJW",
  "Catering and Large Cheeseboards": "CZYRPS4GN2NRWS5FPL3K3AJW",
  "Wine": "AMOCXSALVCYH6N52ZDPVZWTQ",
  "Retail Wine": "GCLZO4EKJZG6XN5RJBLACON2",
  "Wine GLS": "EXP6VEBKROIUFJ6ZEOS3KQSQ",
  "Wine BTL": "K3ZHA4M5HMDXVB6BCKEEP3F4",
  "Beer": "NGEH4EUVYH3MAZPUITRR6KCK",
  "Retail Goods": "VBK7IEVEGA6R3TWYHMTS6OFJ",
  "Crackers": "G6CP42ALSXSCNXJIOLDT3UPI",
  "Butter & Dairy": "CBVZKKDTNMCWY6TAZFLYLRVU",
  "Books & Gifts": "R7IBNTLJSOYUCYSZCUGQVJZL",
  "Cheese Tools & Serveware": "5UTFJSPXASFNZLOZFT4GJQ3X",
  "Chocolate, Candy & Cookies": "BPQHLQVPGN7FTTBJYJUDGCY2",
  "Drinks": "JCXE6HQSFTDFRY6RVLX5DYWL",
  "Honey & Syrups": "LG4NEZ5Q7EXLIE3M2QCAYC47",
  "Merch & Apparel": "P35N5Z23W2ZYN2TY4XDBVVRT",
  "Oils & Vinegars": "OBZNT3RLPIQAI6IXHDKGQEQE",
  "Olives, Tapenade & Antipasti": "JF3IJDW2PFA3CIBBZD7HPLS7",
  "Pantry & Pasta": "AELG2VI3BPF3AHK4HDVRR4KT",
  "Pickles & Condiments": "SFWMZI3VWHHESI5GEUSX2O7E",
  "Prepared & Ready-to-Go": "5W42YZO7X52T5VIEHWP4YXXZ",
  "Salt, Pepper & Spice": "RYNZ6RNK4LWBPZXIXDS7NRNJ",
  "Snacks": "MYGJUZDFHXVRY3TWGNBMNDX2",
  "Tinned Fish & Caviar": "4OTQPRYZBRFBC7UY5LI454SV",
  "Dine In": "ZEQKXN2KSG4EJFGUGQ5EMZ6R",
  "Memphis Retail": "K6GGAWH5QMAFUSTPDPZHYSDW",
};

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

// PLU is optional: barcode-only items have no PLU. Pads but never truncates —
// PLU 130894 is a real 6-digit code in the live menu.
const pad5 = (n: unknown) =>
  n === null || n === undefined || n === "" ? undefined : String(n).padStart(5, "0");

const itemCode = (item: Record<string, unknown>) =>
  pad5(item.plu) ?? (item.barcode ? String(item.barcode) : undefined);

function isRetailKind(item: Record<string, unknown>, body?: Record<string, unknown>): boolean {
  const kind = String((body?.item_kind ?? item.item_kind ?? "cheese")).trim().toLowerCase();
  if (kind === "retail" || kind === "wine") return true;
  if (body?.skip_dcg === true) return true;
  return false;
}

const DCG_SKIP_MSG = "Wine/retail — Square only (DateCodeGenie skipped)";

// ---------- DateCodeGenie ----------

const DCG_CLIENT_HEADERS: Record<string, string> = {
  "Os": "GreysCheeseEntry",
  "App-Version": "3.0",
  "App-Version-Code": "3.0",
  "Os-Version": "3.0",
  "Api-Version": "3.0",
};

function dcgHeaders(location?: string): Record<string, string> | null {
  const key = Deno.env.get("DCG_API_KEY");
  if (!key) return null;
  const header = Deno.env.get("DCG_AUTH_HEADER") ?? "Token";
  const prefix = Deno.env.get("DCG_AUTH_PREFIX") ?? "";
  return {
    [header]: `${prefix}${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...DCG_CLIENT_HEADERS,
    ...(location ? { location } : {}),
  };
}

let categoryMap: Record<string, string> | null = null;
let printerMap: Record<string, string> | null = null;
let gramConversion: boolean | null = null;

async function loadMaps() {
  if (categoryMap && printerMap && gramConversion !== null) return;
  const [cats, profiles, settings] = await Promise.all([
    supabase.from("dcg_category_map").select("category,category_id"),
    supabase.from("dcg_printer_profile_map").select("printer_profile,printer_profile_id"),
    supabase.from("cheese_plu_settings").select("dcg_gram_conversion").eq("id", 1).single(),
  ]);
  categoryMap = Object.fromEntries((cats.data ?? []).map((r) => [r.category, r.category_id]));
  printerMap = Object.fromEntries(
    (profiles.data ?? []).map((r) => [r.printer_profile, r.printer_profile_id]),
  );
  // Default ON if the row or column is missing: the bug is live, and for a NEW item an
  // unconverted price prints 454x too EXPENSIVE, which is the worse way to be wrong.
  gramConversion = settings.data?.dcg_gram_conversion !== false;
}

// What DCG's device should be given. Converted only when the global switch is on AND this
// item is flagged gram-priced — an item corrected by hand in the DCG portal is back in pound
// mode and must be left alone.
function dcgUnitPrice(item: Record<string, unknown>, perUnit: number | undefined) {
  if (perUnit === undefined) return undefined;
  if (!gramConversion || item.dcg_gram_priced !== true) return perUnit;
  const grams = GRAMS_PER_UNIT[unitOf(item)];
  if (!grams || grams === 1) return perUnit; // already per gram, or EA
  return Number((Number(perUnit) / grams).toFixed(7));
}

// >>> Returns a NUMBER. A string like "43.00" is what the portal never writes.
const money = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : undefined;
};

const int = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const locationsOf = (item: Record<string, unknown>): string[] => {
  const locs = (item.dcg_locations as string[] | null) ?? [];
  return locs.length ? locs : ["24755", "28711"];
};

const dcgBarcodeType = (barcode: string) => {
  if (!barcode) return undefined;
  if (/^\d{12}$/.test(barcode)) return "TYPE_UPC_A";
  if (/^\d{13}$/.test(barcode)) return "TYPE_EAN_13";
  if (/^\d{8}$/.test(barcode)) return "TYPE_EAN_8";
  return "TYPE_CODE_128";
};

// price_per_unit is what the scale label multiplies by the weight; list_price is what a
// fixed-price pack prints. We send both where we have them and OMIT the other.
async function dcgFields(item: Record<string, unknown>) {
  await loadMaps();
  const barcode = item.barcode ? String(item.barcode) : "";
  const perUnit = money(item.price_per_lb);
  const flat = money(item.price);
  const netWeight = String(item.net_weight ?? "").trim();
  const profileId = int(printerMap?.[String(item.printer_profile ?? "").trim()]);
  return {
    name: String(item.name ?? ""),
    marketing_name: String(item.marketing_name || item.name || ""),
    category_id: int(categoryMap?.[String(item.category ?? "Cheese")] ?? categoryMap?.["Cheese"]),
    list_price: perUnit ?? flat,
    price_per_unit: dcgUnitPrice(item, perUnit),
    net_weight: netWeight || undefined,
    plu_slu: pad5(item.plu) ?? "",
    printer_profile_id: profileId,
    waste_units: 0,
    barcode,
    barcode_type: dcgBarcodeType(barcode),
    sku: barcode || undefined,
  };
}

async function pushToDcg(item: Record<string, unknown>) {
  if (isRetailKind(item)) {
    return { status: "skipped", error: DCG_SKIP_MSG };
  }
  if (!dcgHeaders()) return { status: "skipped", error: "DCG_API_KEY not set" };
  if (!item.plu && !item.barcode) {
    return { status: "error", error: "item needs a PLU or a barcode before it can be sent" };
  }
  if (!item.dcg_item_id && item.source === "import") {
    return { status: "skipped", error: "already in DCG but not linked — run the DCG ID backfill first" };
  }

  try {
    const fields = await dcgFields(item);
    const locs = locationsOf(item);
    const primary = locs.includes("24755") ? "24755" : locs[0];
    const isCreate = !item.dcg_item_id;

    const url = isCreate ? `${DCG_BASE}/menuitem` : `${DCG_BASE}/menuitem/${item.dcg_item_id}`;
    const payload = isCreate
      ? {
        ...fields,
        uuid: item.id,
        applied_to_restaurants: locs.length > 1 ? locs.map(Number) : Number(locs[0]),
        override: {}, // required, or their controller 500s
      }
      : fields;

    const res = await fetch(url, {
      method: "POST",
      headers: dcgHeaders(primary)!,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) return { status: "error", error: `DCG ${res.status}: ${text.slice(0, 400)}` };

    let dcgId = item.dcg_item_id as string | undefined;
    if (isCreate) {
      try {
        const data = JSON.parse(text);
        dcgId = data?.data?.menu_item?.id ?? data?.data?.id ?? data?.id;
      } catch { /* non-JSON */ }
      if (!dcgId) return { status: "error", error: "DCG created the item but returned no id" };
    }

    return { status: "synced", dcg_item_id: dcgId };
  } catch (e) {
    return { status: "error", error: String(e).slice(0, 500) };
  }
}

// ---------- Square ----------
function squareBase(): string {
  return (Deno.env.get("SQUARE_ENV") ?? "production") === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

const squareHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "Square-Version": "2025-01-23",
});

const upcField = (barcode: unknown) => {
  const bc = String(barcode ?? "").trim();
  return /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(bc) ? bc : undefined;
};

const categoryCache = new Map<string, string>(Object.entries(SQUARE_CATEGORY_IDS));

// Auto-created categories land at top level. The retail ones (Charcuterie, Specialty, Jams) were
// nested under Retail Goods by hand on 2026-08-13 — re-parent any new one in the dashboard.
async function resolveCategoryId(name: string | null | undefined, token: string) {
  const clean = String(name ?? "").trim();
  if (!clean) return undefined;
  const hit = categoryCache.get(clean);
  if (hit) return hit;
  try {
    const res = await fetch(`${squareBase()}/v2/catalog/search`, {
      method: "POST",
      headers: squareHeaders(token),
      body: JSON.stringify({
        object_types: ["CATEGORY"],
        query: { exact_query: { attribute_name: "name", attribute_value: clean } },
        limit: 1,
      }),
    });
    let id = (await res.json())?.objects?.[0]?.id;
    if (!id) {
      const create = await fetch(`${squareBase()}/v2/catalog/object`, {
        method: "POST",
        headers: squareHeaders(token),
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          object: {
            type: "CATEGORY",
            id: "#new-category",
            present_at_all_locations: true,
            category_data: { name: clean, category_type: "REGULAR_CATEGORY", is_top_level: true },
          },
        }),
      });
      id = (await create.json())?.catalog_object?.id;
    }
    if (id) categoryCache.set(clean, id);
    return id;
  } catch {
    return undefined;
  }
}

// Pricing rules (2026-08-07, unit added 2026-09-03):
//   price_per_lb set + unit LB/OZ/G/KG -> sold by weight, variation carries that unit.
//   unit EA, or price only -> fixed price, whole units.
//   no price at all -> variable pricing; cashier keys the amount off the label.
// NOTE: Square gets the TRUE per-pound price. The per-gram conversion above is a
// DateCodeGenie-only workaround and must never leak into the register.
function buildVariation(
  item: Record<string, unknown>,
  opts: { id: string; version?: number },
) {
  const unit = unitOf(item);
  const unitId = SQUARE_UNIT_IDS[unit]; // undefined for EA
  const perUnit = item.price_per_lb == null ? null : Number(item.price_per_lb);
  const flat = item.price == null ? null : Number(item.price);
  const byWeight = !!unitId && perUnit != null && Number.isFinite(perUnit) && perUnit > 0;
  const amount = byWeight ? perUnit : flat;
  const priced = amount != null && Number.isFinite(amount) && amount > 0;

  const vd: Record<string, unknown> = {
    name: byWeight ? `Per ${unit.toLowerCase()}` : "Regular",
    sku: itemCode(item),
    upc: upcField(item.barcode),
    pricing_type: priced ? "FIXED_PRICING" : "VARIABLE_PRICING",
    sellable: true,
    stockable: true,
  };
  if (priced) vd.price_money = { amount: Math.round(Number(amount) * 100), currency: "USD" };
  // Explicit null so switching to EA clears a weight unit the item already had.
  vd.measurement_unit_id = byWeight ? unitId : null;

  return {
    type: "ITEM_VARIATION",
    id: opts.id,
    ...(opts.version ? { version: opts.version } : {}),
    present_at_all_locations: true,
    item_variation_data: vd,
  };
}

async function pushToSquare(item: Record<string, unknown>) {
  const token = Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!token) return { status: "skipped", error: "SQUARE_ACCESS_TOKEN not set" };
  if (!item.plu && !item.barcode) {
    return { status: "error", error: "item needs a PLU or a barcode before it can be sent" };
  }
  try {
    const isUpdate = !!item.square_item_id;
    const categoryId = await resolveCategoryId((item.category as string) ?? "Cheese", token);
    const explicitTaxIds = Array.isArray(item._tax_ids)
      ? (item._tax_ids as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
    const mappedTaxIds = explicitTaxIds.length
      ? explicitTaxIds
      : taxIdsForCategory(item.category, item._tax_preset as string | undefined);

    let existing: Record<string, unknown> | null = null;
    if (isUpdate) {
      const getRes = await fetch(`${squareBase()}/v2/catalog/object/${item.square_item_id}`, {
        headers: squareHeaders(token),
      });
      const getData = await getRes.json();
      if (!getRes.ok) {
        return { status: "error", error: `Square lookup failed: ${JSON.stringify(getData).slice(0, 300)}` };
      }
      existing = getData?.object ?? null;
    }

    const existingItemData = (existing?.item_data ?? {}) as Record<string, unknown>;
    const existingVariations =
      (existingItemData.variations as Record<string, unknown>[] | undefined) ?? [];
    const existingVariation = existingVariations[0];

    const variation = buildVariation(item, {
      id: (existingVariation?.id as string) ?? "#variation",
      version: existingVariation?.version as number | undefined,
    });

    // Only the first variation is ours to manage; anything added in the dashboard rides along.
    const variations = [variation, ...existingVariations.slice(1)];

    const forceTax = explicitTaxIds.length > 0 ||
      (item._tax_preset != null && String(item._tax_preset).trim() !== "" &&
        String(item._tax_preset).trim().toLowerCase() !== "auto");
    const existingTaxes = (existingItemData.tax_ids as string[] | undefined) ?? [];
    const taxIds = (!isUpdate || forceTax || !existingTaxes.length)
      ? mappedTaxIds
      : existingTaxes;

    const categories = categoryId
      ? [{ id: categoryId }]
      : (existingItemData.categories as unknown[] | undefined);

    // Keep whatever product_type the item already has. Forcing REGULAR here used to pull items
    // off the Square for Restaurants menus they had been added to.
    const productType = (existingItemData.product_type as string | undefined) ?? "REGULAR";

    const body = {
      idempotency_key: crypto.randomUUID(),
      object: {
        type: "ITEM",
        id: isUpdate ? item.square_item_id : "#new-cheese",
        ...(existing?.version ? { version: existing.version } : {}),
        present_at_all_locations: true,
        item_data: {
          ...existingItemData,
          name: String(item.marketing_name || item.name),
          is_taxable: true,
          ...((taxIds && taxIds.length) ? { tax_ids: taxIds } : {}),
          ...(categories ? { categories } : {}),
          product_type: productType,
          variations,
        },
      },
    };

    const res = await fetch(`${squareBase()}/v2/catalog/object`, {
      method: "POST",
      headers: squareHeaders(token),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { status: "error", error: `Square ${res.status}: ${text.slice(0, 500)}` };
    let squareId: string | undefined;
    try {
      squareId = JSON.parse(text)?.catalog_object?.id;
    } catch { /* ignore */ }
    return { status: "synced", square_item_id: squareId ?? (item.square_item_id as string | undefined) };
  } catch (e) {
    return { status: "error", error: String(e).slice(0, 500) };
  }
}

// ---------- shared ----------
async function syncItem(item: Record<string, unknown>, targets: { dcg: boolean; square: boolean }) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (targets.dcg) {
    const d = await pushToDcg(item);
    patch.dcg_status = d.status;
    patch.dcg_error = d.error ?? null;
    if (d.dcg_item_id) patch.dcg_item_id = d.dcg_item_id;
  }
  if (targets.square) {
    const s = await pushToSquare(item);
    patch.square_status = s.status;
    patch.square_error = s.error ?? null;
    if (s.square_item_id) patch.square_item_id = s.square_item_id;
  }
  const { data: updated } = await supabase
    .from("cheese_items")
    .update(patch)
    .eq("id", item.id)
    .select()
    .single();
  return updated ?? { ...item, ...patch };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanUnit(v: unknown): string | null {
  const u = String(v ?? "").trim().toUpperCase();
  return VALID_UNITS.has(u) ? u : null;
}

async function cleanLocations(v: unknown): Promise<string[] | null> {
  if (v === undefined) return null;
  const wanted = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  if (!wanted.length) return null;
  const { data } = await supabase.from("dcg_locations").select("restaurant_id");
  const known = new Set((data ?? []).map((r) => r.restaurant_id));
  const valid = [...new Set(wanted.filter((id) => known.has(id)))];
  return valid.length ? valid : null;
}

// ---------- UPC-A ----------
function upcCheckDigit(first11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum += Number(first11[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function buildStoreBarcode(itemNumber: number): string {
  const first11 = "2" + String(itemNumber).padStart(5, "0") + "00000";
  return first11 + upcCheckDigit(first11);
}

async function nextStoreBarcode(): Promise<{ barcode: string; item_number: number }> {
  const { data: rows } = await supabase.from("cheese_items").select("plu,barcode").limit(5000);
  const used = new Set<number>();
  for (const r of rows ?? []) {
    if (r.plu !== null && r.plu !== undefined) used.add(Number(r.plu));
    const bc = String(r.barcode ?? "");
    if (/^2\d{11}$/.test(bc)) used.add(Number(bc.slice(1, 6)));
  }
  const { data: floorRow } = await supabase
    .from("cheese_plu_settings").select("floor").eq("id", 1).single();
  let n = Number(floorRow?.floor ?? 1);
  while (used.has(n) && n < 99999) n++;
  return { barcode: buildStoreBarcode(n), item_number: n };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = body.action ?? "add";

  if (action === "generate_barcode") {
    return json(await nextStoreBarcode());
  }

  if (action === "locations") {
    const { data } = await supabase
      .from("dcg_locations")
      .select("restaurant_id,location_name,location_address,is_default")
      .order("sort_order");
    return json({ locations: data ?? [] });
  }

  if (action === "add") {
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name is required" }, 400);
    const barcode = String(body.barcode ?? "").trim();
    const retail = isRetailKind({}, body);
    const assignPlu = body.assign_plu !== undefined
      ? body.assign_plu !== false
      : (retail ? true : !barcode);
    const { data: item, error } = await supabase.rpc("add_cheese_item", {
      p_name: name,
      p_marketing_name: body.marketing_name ?? null,
      p_price: body.price ?? null,
      p_price_per_lb: retail ? null : (body.price_per_lb ?? null),
      p_barcode: barcode || null,
      p_plu: body.plu ?? null,
      p_category: body.category ?? (retail ? "Wine" : "Cheese"),
      p_printer_profile: retail ? null : (body.printer_profile ?? "Greys Cheese Label"),
      p_hot_buttons: retail ? false : body.hot_buttons !== false,
      p_assign_plu: assignPlu,
    });
    if (error) return json({ error: error.message }, 400);

    // add_cheese_item predates net_weight, unit_of_measure, dcg_gram_priced, item_kind.
    let row = item;
    const extra: Record<string, unknown> = {};
    extra.item_kind = retail ? "retail" : "cheese";
    if (!retail) {
      const locs = await cleanLocations(body.dcg_locations);
      if (locs) extra.dcg_locations = locs;
    }
    if ("net_weight" in body) {
      extra.net_weight = String(body.net_weight ?? "").trim() || null;
    }
    if ("unit_of_measure" in body) {
      const u = cleanUnit(body.unit_of_measure);
      if (!u) return json({ error: "unit of measure must be LB, OZ, G, KG or EA" }, 400);
      extra.unit_of_measure = u;
    } else if (retail) {
      extra.unit_of_measure = "EA";
    }
    // Cheese: born in gram mode for DCG. Retail never touches DCG.
    if (retail) {
      extra.dcg_gram_priced = false;
      extra.dcg_status = "skipped";
      extra.dcg_error = DCG_SKIP_MSG;
    } else {
      extra.dcg_gram_priced = true;
    }
    if (Object.keys(extra).length) {
      const { data: patched } = await supabase
        .from("cheese_items").update(extra).eq("id", item.id).select().single();
      if (patched) row = patched;
    }

    if ("tax_preset" in body) row = { ...row, _tax_preset: body.tax_preset };
    if (Array.isArray(body.tax_ids)) row = { ...row, _tax_ids: body.tax_ids };
    const updated = await syncItem(row, { dcg: !retail, square: true });
    return json({ item: updated });
  }

  if (action === "update") {
    const id = body.id;
    if (!id) return json({ error: "id is required" }, 400);
    const { data: item, error } = await supabase.from("cheese_items").select().eq("id", id).single();
    if (error || !item) return json({ error: "item not found" }, 404);

    const patch: Record<string, unknown> = {};
    if ("name" in body) {
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "name cannot be empty" }, 400);
      patch.name = name;
    }
    if ("marketing_name" in body) patch.marketing_name = String(body.marketing_name ?? "").trim() || null;
    if ("price" in body) patch.price = num(body.price);
    if ("price_per_lb" in body) patch.price_per_lb = num(body.price_per_lb);
    if ("net_weight" in body) patch.net_weight = String(body.net_weight ?? "").trim() || null;
    if ("unit_of_measure" in body) {
      const u = cleanUnit(body.unit_of_measure);
      if (!u) return json({ error: "unit of measure must be LB, OZ, G, KG or EA" }, 400);
      patch.unit_of_measure = u;
    }
    // Clear this when someone has re-saved the item by hand in the DCG portal: that puts the
    // device back in pound mode, and converting on top of it would print 454x too cheap.
    if ("dcg_gram_priced" in body) patch.dcg_gram_priced = body.dcg_gram_priced === true;
    if ("barcode" in body) {
      const bc = String(body.barcode ?? "").trim() || null;
      if (bc && bc !== item.barcode) {
        const { data: dupe } = await supabase
          .from("cheese_items").select("id,name").eq("barcode", bc).neq("id", id).maybeSingle();
        if (dupe) return json({ error: `Barcode ${bc} is already used by ${dupe.name}` }, 400);
      }
      if (!bc && (item.plu === null || item.plu === undefined)) {
        return json({ error: "this item has no PLU — it needs to keep its barcode" }, 400);
      }
      patch.barcode = bc;
    }
    if ("plu" in body) {
      const p = num(body.plu);
      if (p !== null && p !== item.plu) {
        const { data: dupe } = await supabase
          .from("cheese_items").select("id,name").eq("plu", p).neq("id", id).maybeSingle();
        if (dupe) return json({ error: `PLU ${p} is already used by ${dupe.name}` }, 400);
      }
      patch.plu = p;
    }
    if ("category" in body) patch.category = String(body.category ?? "").trim() || null;
    if ("printer_profile" in body) patch.printer_profile = String(body.printer_profile ?? "").trim() || null;
    if ("hot_buttons" in body) patch.hot_buttons = body.hot_buttons !== false;
    if ("dcg_locations" in body) {
      const locs = await cleanLocations(body.dcg_locations);
      if (!locs) return json({ error: "pick at least one valid location" }, 400);
      patch.dcg_locations = locs;
    }
    if ("item_kind" in body) {
      const k = String(body.item_kind ?? "cheese").trim().toLowerCase();
      if (k !== "cheese" && k !== "retail") {
        return json({ error: "item_kind must be cheese or retail" }, 400);
      }
      patch.item_kind = k;
    }
    if (Object.keys(patch).length === 0) return json({ error: "no fields to update" }, 400);
    patch.updated_at = new Date().toISOString();

    const { data: saved, error: upErr } = await supabase
      .from("cheese_items").update(patch).eq("id", id).select().single();
    if (upErr) return json({ error: upErr.message }, 400);

    const retail = isRetailKind(saved, body);
    if (retail && saved.dcg_status !== "skipped") {
      const { data: marked } = await supabase
        .from("cheese_items")
        .update({ dcg_status: "skipped", dcg_error: DCG_SKIP_MSG })
        .eq("id", id)
        .select()
        .single();
      let row: Record<string, unknown> = marked ?? { ...saved, dcg_status: "skipped", dcg_error: DCG_SKIP_MSG };
      if ("tax_preset" in body) row = { ...row, _tax_preset: body.tax_preset };
      if (Array.isArray(body.tax_ids)) row = { ...row, _tax_ids: body.tax_ids };
      const updated = await syncItem(row, { dcg: false, square: true });
      return json({ item: updated });
    }

    let syncRow: Record<string, unknown> = saved;
    if ("tax_preset" in body) syncRow = { ...syncRow, _tax_preset: body.tax_preset };
    if (Array.isArray(body.tax_ids)) syncRow = { ...syncRow, _tax_ids: body.tax_ids };
    const updated = await syncItem(syncRow, { dcg: !retail, square: true });
    return json({ item: updated });
  }

  if (action === "retry_sync") {
    const id = body.id;
    if (!id) return json({ error: "id is required" }, 400);
    const target = String(body.target ?? "both");
    const { data: item, error } = await supabase.from("cheese_items").select().eq("id", id).single();
    if (error || !item) return json({ error: "item not found" }, 404);
    const retail = isRetailKind(item, body);
    const wantDcg = !retail && (target === "dcg" || target === "both");
    const wantSquare = target === "square" || target === "both";
    if (retail && (target === "dcg" || target === "both") && !wantSquare) {
      const { data: marked } = await supabase
        .from("cheese_items")
        .update({
          dcg_status: "skipped",
          dcg_error: DCG_SKIP_MSG,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return json({ item: marked ?? { ...item, dcg_status: "skipped", dcg_error: DCG_SKIP_MSG } });
    }
    let row = item;
    if (retail && item.dcg_status !== "skipped") {
      const { data: marked } = await supabase
        .from("cheese_items")
        .update({ dcg_status: "skipped", dcg_error: DCG_SKIP_MSG })
        .eq("id", id)
        .select()
        .single();
      if (marked) row = marked;
    }
    const updated = await syncItem(row, { dcg: wantDcg, square: wantSquare });
    return json({ item: updated });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
