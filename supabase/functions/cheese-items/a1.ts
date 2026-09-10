import { createClient } from "npm:@supabase/supabase-js@2";

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const DCG_BASE = "https://www.datecodegenie.com/api/menu";


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

export const SQUARE_TAX_FOOD = "B5BSOZ3MBXTFWX4T4EPJ5YHB";      // TN Food 6.75%, additive
export const SQUARE_TAX_PREPARED = "2K7XWRVWVXBTAJQIHHQOLFCN";  // TN Standard / prepared 9.75%, additive
export const SQUARE_TAX_STANDARD = SQUARE_TAX_PREPARED;
export const SQUARE_TAX_SALES_INCL = "MTLGRH6TG7GJMAEVCJGFQRIR"; // TN Sales Tax 9.75%, inclusive
export const SQUARE_TAX_LBD_INCL = "DTD3GXE53SAZEZWQDYWALVSJ";   // TN Liquor by the Drink 15%, inclusive

export const PREPARED_CATEGORIES = new Set([
  "Catering",
  "Catering and Large Cheeseboards",
  "Cheeseboards",
  "Dine In",
  "Prepared",
  "Prepared & Ready-to-Go",
]);

/** Non-food retail / beer → Standard 9.75% additive (Beer sampled live 2026-09). */
export const STANDARD_CATEGORIES = new Set([
  "Beer",
  "Retail Wine",
  "Books & Gifts",
  "Cheese Tools & Serveware",
  "Merch & Apparel",
  "Drinks",
  "Retail Goods",
  "Memphis Retail",
]);

/** Dine-in wine glass/bottle → tax-in Sales + LBD. */
export const WINE_DINE_IN_CATEGORIES = new Set([
  "Wine",
  "Wine GLS",
  "Wine BTL",
]);

export type TaxPreset = "auto" | "food" | "standard" | "wine_dine_in" | "retail_wine";

export function taxIdsForPreset(preset: string | null | undefined): string[] | null {
  const p = String(preset ?? "").trim().toLowerCase();
  if (!p || p === "auto") return null;
  if (p === "food") return [SQUARE_TAX_FOOD];
  if (p === "standard" || p === "prepared" || p === "retail_wine") return [SQUARE_TAX_STANDARD];
  if (p === "wine_dine_in" || p === "wine") return [SQUARE_TAX_SALES_INCL, SQUARE_TAX_LBD_INCL];
  return null;
}

/** Returns Square tax_ids for a category (multi-tax for dine-in Wine). */
export function taxIdsForCategory(
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
  // Cheese + edible retail food (Charcuterie, Specialty, Jams, Crackers, Butter & Dairy, …)
  return [SQUARE_TAX_FOOD];
}

/** @deprecated Prefer taxIdsForCategory — kept for any leftover single-id callers. */
export function taxIdForCategory(category: unknown): string {
  return taxIdsForCategory(category)[0] ?? SQUARE_TAX_FOOD;
}

export const SQUARE_CATEGORY_IDS: Record<string, string> = {
  // Regular catalog categories (live Greys Square, 2026-09)
  "Cheese": "3GBLBLAWUAPBIS4ADJVEMGFM",
  "Charcuterie": "FIAA5ZKGX4XFQNLHFV5ZUA22",
  "Specialty": "IJ74AFAIE5RS2TBX3ABGA3YJ",
  "Jams": "6WPR62AH6UUOCPVONDFFZNKG",
  // UI alias + live Square name
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
