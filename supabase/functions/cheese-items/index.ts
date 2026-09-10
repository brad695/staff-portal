import {
  DCG_SKIP_MSG,
  cors,
  isRetailKind,
  json,
  supabase
} from "./a1.ts";
import {
  cleanLocations,
  cleanUnit,
  nextStoreBarcode,
  num,
  syncItem
} from "./b.ts";

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
      const row = marked ?? { ...saved, dcg_status: "skipped", dcg_error: DCG_SKIP_MSG };
      const updated = await syncItem(row, { dcg: false, square: true });
      return json({ item: updated });
    }

    const updated = await syncItem(saved, { dcg: !retail, square: true });
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
