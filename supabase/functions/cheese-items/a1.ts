import { createClient } from "npm:@supabase/supabase-js@2";

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const DCG_BASE = "https://www.datecodegenie.com/api/menu";

export const SQUARE_TAX_FOOD = "B5BSOZ3MBXTFWX4T4EPJ5YHB";      
export const SQUARE_TAX_PREPARED = "2K7XWRVWVXBTAJQIHHQOLFCN";  

export const SQUARE_UNIT_IDS: Record<string, string> = {
  LB: "RGKK6J7EYZPQVHJQSA4PNE5C",
  OZ: "4KM5WF5XFAUUOC2AWE6JQWGR",
  G: "77N7IIGPSFHIDWNLHCMU5YDD",
  KG: "OD6ZTEUW23AIZIPW7KU77UOE",
};
export const VALID_UNITS = new Set(["LB", "OZ", "G", "KG", "EA"]);
export const DEFAULT_UNIT = "LB";

export const GRAMS_PER_UNIT: Record<string, number> = {
  LB: 453.59237,
  OZ: 28.349523125,
  KG: 1000,
  G: 1,
};

export function unitOf(item: Record<string, unknown>): string {
  const u = String(item.unit_of_measure ?? "").trim().toUpperCase();
  return VALID_UNITS.has(u) ? u : DEFAULT_UNIT;
}

export const PREPARED_CATEGORIES = new Set(["Catering", "Cheeseboards", "Dine In", "Prepared"]);

export function taxIdForCategory(category: unknown): string {
  const override = Deno.env.get("SQUARE_TAX_ID");
  if (override) return override;
  return PREPARED_CATEGORIES.has(String(category ?? "").trim())
    ? SQUARE_TAX_PREPARED
    : SQUARE_TAX_FOOD;
}

export const SQUARE_CATEGORY_IDS: Record<string, string> = {
  "Cheese": "3GBLBLAWUAPBIS4ADJVEMGFM",
  "Charcuterie": "FIAA5ZKGX4XFQNLHFV5ZUA22",
  "Specialty": "IJ74AFAIE5RS2TBX3ABGA3YJ",
  "Jams": "6WPR62AH6UUOCPVONDFFZNKG",
  "Catering": "CZYRPS4GN2NRWS5FPL3K3AJW",
};

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export const pad5 = (n: unknown) =>
  n === null || n === undefined || n === "" ? undefined : String(n).padStart(5, "0");

export const itemCode = (item: Record<string, unknown>) =>
  pad5(item.plu) ?? (item.barcode ? String(item.barcode) : undefined);

export function isRetailKind(item: Record<string, unknown>, body?: Record<string, unknown>): boolean {
  const kind = String((body?.item_kind ?? item.item_kind ?? "cheese")).trim().toLowerCase();
  if (kind === "retail" || kind === "wine") return true;
  if (body?.skip_dcg === true) return true;
  return false;
}

export const DCG_SKIP_MSG = "Wine/retail — Square only (DateCodeGenie skipped)";

export const DCG_CLIENT_HEADERS: Record<string, string> = {
  "Os": "GreysCheeseEntry",
  "App-Version": "3.0",
  "App-Version-Code": "3.0",
  "Os-Version": "3.0",
  "Api-Version": "3.0",
};

export function dcgHeaders(location?: string): Record<string, string> | null {
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

export let categoryMap: Record<string, string> | null = null;
export let printerMap: Record<string, string> | null = null;
export let gramConversion: boolean | null = null;

export async function loadMaps() {
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
  
  
  gramConversion = settings.data?.dcg_gram_conversion !== false;
}

export function dcgUnitPrice(item: Record<string, unknown>, perUnit: number | undefined) {
  if (perUnit === undefined) return undefined;
  if (!gramConversion || item.dcg_gram_priced !== true) return perUnit;
  const grams = GRAMS_PER_UNIT[unitOf(item)];
  if (!grams || grams === 1) return perUnit; 
  return Number((Number(perUnit) / grams).toFixed(7));
}

export const money = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : undefined;
};

export const int = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export const locationsOf = (item: Record<string, unknown>): string[] => {
  const locs = (item.dcg_locations as string[] | null) ?? [];
  return locs.length ? locs : ["24755", "28711"];
};

export const dcgBarcodeType = (barcode: string) => {
  if (!barcode) return undefined;
  if (/^\d{12}$/.test(barcode)) return "TYPE_UPC_A";
  if (/^\d{13}$/.test(barcode)) return "TYPE_EAN_13";
  if (/^\d{8}$/.test(barcode)) return "TYPE_EAN_8";
  return "TYPE_CODE_128";
};

export async function dcgFields(item: Record<string, unknown>) {
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
