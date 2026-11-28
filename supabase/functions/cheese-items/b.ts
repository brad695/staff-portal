import {
  SQUARE_LOC_MEMPHIS,
  SQUARE_LOC_NASHVILLE,
  VALID_UNITS,
  json,
  supabase,
  taxIdsForCategory
} from "./a1.ts";
import {
  buildVariation,
  pushToDcg,
  resolveCategoryId,
  squareBase,
  squareHeaders
} from "./a2.ts";

// Starting on-hand counts, sent once right after the item is created in Square.
// qtys = { memphis, nashville }; a blank skips that store, 0 is a real count.
export async function setStartingInventory(
  token: string,
  variationId: string,
  qtys: Record<string, unknown> | null | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!qtys || typeof qtys !== "object") return { ok: true };
  const occurred_at = new Date().toISOString();
  const changes: Record<string, unknown>[] = [];
  for (const [location_id, raw] of [[SQUARE_LOC_MEMPHIS, qtys.memphis], [SQUARE_LOC_NASHVILLE, qtys.nashville]] as const) {
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: `bad count "${raw}"` };
    changes.push({
      type: "PHYSICAL_COUNT",
      physical_count: {
        catalog_object_id: variationId,
        location_id,
        state: "IN_STOCK",
        quantity: String(Number(n.toFixed(5))),
        occurred_at,
      },
    });
  }
  if (!changes.length) return { ok: true };
  try {
    const res = await fetch(`${squareBase()}/v2/inventory/changes/batch-create`, {
      method: "POST",
      headers: squareHeaders(token),
      body: JSON.stringify({ idempotency_key: crypto.randomUUID(), changes, ignore_unchanged_counts: false }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Square inventory ${res.status}: ${text.slice(0, 400)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400) };
  }
}

export async function pushToSquare(item: Record<string, unknown>) {
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
      existing: existingVariation,
    });

    
    const variations = [variation, ...existingVariations.slice(1)];

    // CREATE: always assign mapped/override tax_ids.
    // UPDATE: keep existing taxes unless caller sent tax_preset / tax_ids.
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
    let variationId: string | undefined;
    try {
      const saved = JSON.parse(text)?.catalog_object;
      squareId = saved?.id;
      variationId = saved?.item_data?.variations?.[0]?.id;
    } catch { /* ignore */ }
    squareId = squareId ?? (item.square_item_id as string | undefined);

    // The item is in Square either way. A failed count only earns a warning; it never undoes the add.
    let inventoryWarning: string | undefined;
    if (!isUpdate && item._track_inventory === true) {
      if (!variationId) inventoryWarning = "Square didn't return the new variation id";
      else {
        const inv = await setStartingInventory(token, variationId, item._inventory_qty as Record<string, unknown>);
        if (!inv.ok) inventoryWarning = inv.error ?? "inventory update failed";
      }
    }
    return {
      status: "synced",
      square_item_id: squareId,
      ...(inventoryWarning ? { inventory_warning: `Starting stock counts weren't set: ${inventoryWarning}` } : {}),
    };
  } catch (e) {
    return { status: "error", error: String(e).slice(0, 500) };
  }
}

export async function syncItem(item: Record<string, unknown>, targets: { dcg: boolean; square: boolean }) {
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
    patch.square_error = s.error ?? (s as { inventory_warning?: string }).inventory_warning ?? null;
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

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function cleanUnit(v: unknown): string | null {
  const u = String(v ?? "").trim().toUpperCase();
  return VALID_UNITS.has(u) ? u : null;
}

export async function cleanLocations(v: unknown): Promise<string[] | null> {
  if (v === undefined) return null;
  const wanted = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  if (!wanted.length) return null;
  const { data } = await supabase.from("dcg_locations").select("restaurant_id");
  const known = new Set((data ?? []).map((r) => r.restaurant_id));
  const valid = [...new Set(wanted.filter((id) => known.has(id)))];
  return valid.length ? valid : null;
}

export function upcCheckDigit(first11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum += Number(first11[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function buildStoreBarcode(itemNumber: number): string {
  const first11 = "2" + String(itemNumber).padStart(5, "0") + "00000";
  return first11 + upcCheckDigit(first11);
}

export async function nextStoreBarcode(): Promise<{ barcode: string; item_number: number }> {
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

