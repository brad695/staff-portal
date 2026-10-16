# cheese-items

PLU / Square sync for Cheese Case and Wine/Retail entries.

## Modes
- **Cheese** (`item_kind=cheese`): DateCodeGenie + Square (unchanged)
- **Wine/Retail** (`item_kind=retail` or `skip_dcg=true`): Square only; `dcg_status=skipped`

## Square categories + taxes
Hardcoded `SQUARE_CATEGORY_IDS` (lookup by name; create only if missing) covers Cheese, Charcuterie, Specialty, Jams, Catering / Catering and Large Cheeseboards, Wine, Retail Wine, Wine GLS, Wine BTL, Beer, Retail Goods, Crackers, Butter & Dairy, Books & Gifts, and other Greys retail subcats.

`taxIdsForCategory(category, taxPreset?)` returns `string[]`:
- **Wine / Wine GLS / Wine BTL** → Sales tax-in + LBD tax-in
- **Retail Wine / Beer / prepared / non-food retail** → Standard 9.75% additive
- **Cheese + edible retail food** → Food 6.75% additive

Body overrides: `tax_preset` (`auto|food|standard|wine_dine_in|retail_wine`) or explicit `tax_ids`.
On **CREATE**, tax_ids are always set from mapping/override (not only when empty).


## Inventory tracking (create)
On add, optional body fields:
- `track_inventory: true` → sets `item_variation_data.track_inventory` on the Square variation
- `inventory_qty: { memphis, nashville }` (or Square location ids) → after catalog create, `BatchChangeInventory` PHYSICAL_COUNT / IN_STOCK at Memphis (`LCXWZ0HAQ69RM`) and Nashville (`LJ33VDYHS1JAR`). Blank skips a location; `0` is valid.

Catalog success is kept even if inventory fails; `square_status` stays `synced` and `square_error` carries `Catalog synced; inventory failed: …`.

Manager UI defaults: **Track inventory ON for Wine/Retail, OFF for Cheese**. Wine/Retail form is Square-only (no DateCode printer/hot-buttons/stores framing).

## Layout
- `index.ts` — Deno.serve entry (add / update / retry_sync / generate_barcode / locations)
- `a1.ts` — shared helpers, category/tax maps, `isRetailKind`, DCG field builders
- `a2.ts` — `pushToDcg` (skips retail), Square catalog helpers
- `b.ts` — `pushToSquare`, `syncItem`, PLU/barcode helpers
- `index.mono.ts` — single-file embed source for Supabase MCP deploy (no remote imports)

## Deploy
Supabase MCP `deploy_edge_function` on project `vdvtrevhqalmjwhjhjug` with **`verify_jwt: true`**, embedding **`index.mono.ts` as `index.ts`** (do not import from raw.githubusercontent feature branches).

## SQL (already applied)
```sql
ALTER TABLE cheese_items
  ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'cheese';
ALTER TABLE cheese_items
  ADD CONSTRAINT cheese_items_item_kind_check
  CHECK (item_kind IN ('cheese', 'retail'));
```
