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
  Cheese: "3GBLBLAWUAPBIS4ADJVEMGFM",
  Charcuterie: "FIAA5ZKGX4XFQNLHFV5ZUA22",
  Specialty: "IJ74AFAIE5RS2TBX3ABGA3YJ",
  Jams: "6WPR62AH6UUOCPVONDFFZNKG",
  Catering: "CZYRPS4GN2NRWS5FPL3K3AJW",
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
