# cheese-items

PLU / Square sync for Cheese Case and Wine/Retail entries.

- Cheese (`item_kind=cheese`): DateCodeGenie + Square
- Wine/Retail (`item_kind=retail` or `skip_dcg`): Square only; DCG status `skipped`

Deploy via Supabase MCP `deploy_edge_function` on project `vdvtrevhqalmjwhjhjug` with `verify_jwt: true`.

SQL (already applied): `cheese_items.item_kind text NOT NULL DEFAULT 'cheese'` CHECK (`item_kind IN ('cheese','retail')`).
