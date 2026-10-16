import {
  DCG_BASE,
  DCG_SKIP_MSG,
  SQUARE_CATEGORY_IDS,
  SQUARE_UNIT_IDS,
  dcgFields,
  dcgHeaders,
  isRetailKind,
  itemCode,
  json,
  locationsOf,
  unitOf
} from "./a1.ts";


export async function pushToDcg(item: Record<string, unknown>) {
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
        override: {}, 
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
      } catch {  }
      if (!dcgId) return { status: "error", error: "DCG created the item but returned no id" };
    }

    return { status: "synced", dcg_item_id: dcgId };
  } catch (e) {
    return { status: "error", error: String(e).slice(0, 500) };
  }
}

export function squareBase(): string {
  return (Deno.env.get("SQUARE_ENV") ?? "production") === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export const squareHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "Square-Version": "2025-01-23",
});

export const upcField = (barcode: unknown) => {
  const bc = String(barcode ?? "").trim();
  return /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(bc) ? bc : undefined;
};

export const categoryCache = new Map<string, string>(Object.entries(SQUARE_CATEGORY_IDS));

export async function resolveCategoryId(name: string | null | undefined, token: string) {
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

export function buildVariation(
  item: Record<string, unknown>,
  opts: { id: string; version?: number },
) {
  const unit = unitOf(item);
  const unitId = SQUARE_UNIT_IDS[unit]; 
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
  if (item._track_inventory === true) vd.track_inventory = true;

  return {
    type: "ITEM_VARIATION",
    id: opts.id,
    ...(opts.version ? { version: opts.version } : {}),
    present_at_all_locations: true,
    item_variation_data: vd,
  };
}
