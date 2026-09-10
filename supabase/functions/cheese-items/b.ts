import {
  VALID_UNITS,
  json,
  supabase,
  taxIdForCategory
} from "./a1.ts";
import {
  buildVariation,
  pushToDcg,
  resolveCategoryId,
  squareBase,
  squareHeaders
} from "./a2.ts";

export async function pushToSquare(item: Record<string, unknown>) {
  const token = Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!token) return { status: "skipped", error: "SQUARE_ACCESS_TOKEN not set" };
  if (!item.plu && !item.barcode) {
    return { status: "error", error: "item needs a PLU or a barcode before it can be sent" };
  }
  try {
    const isUpdate = !!item.square_item_id;
    const categoryId = await resolveCategoryId((item.category as string) ?? "Cheese", token);
    const taxId = taxIdForCategory(item.category);

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

    const variations = [variation, ...existingVariations.slice(1)];

    const taxIds = (existingItemData.tax_ids as string[] | undefined)?.length
      ? existingItemData.tax_ids as string[]
      : (taxId ? [taxId] : undefined);

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
          ...(taxIds ? { tax_ids: taxIds } : {}),
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
