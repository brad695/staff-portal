# cheese-items

PLU / Square sync for Cheese Case and Wine/Retail entries.

## Modes
- **Cheese** (`item_kind=cheese`): DateCodeGenie + Square (unchanged)
- **Wine/Retail** (`item_kind=retail` or `skip_dcg=true`): Square only; `dcg_status=skipped`

## Layout
- `index.ts` — Deno.serve entry (add / update / retry_sync / generate_barcode / locations)
- `a1.ts` — shared helpers, `isRetailKind`, DCG field builders
- `a2.ts` — `pushToDcg` (skips retail), Square catalog helpers
- `b.ts` — `pushToSquare`, `syncItem`, PLU/barcode helpers

## Deploy
Supabase MCP `deploy_edge_function` on project `vdvtrevhqalmjwhjhjug` with **`verify_jwt: true`**.

## SQL (already applied)
```sql
ALTER TABLE cheese_items
  ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'cheese';
ALTER TABLE cheese_items
  ADD CONSTRAINT cheese_items_item_kind_check
  CHECK (item_kind IN ('cheese', 'retail'));
```
