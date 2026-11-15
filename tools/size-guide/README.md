# Board Size Comparison → GREYS Studio

The boxes & boards size guide as a Studio design (`dboardsizes`, 1220 × 728 px), built from separate
layers so it can be edited in the Studio: each box/board, each cheese wedge (grouped in fours),
each dimension line with its label, the captions and the headings.

- `make_graphics.py` draws the pictures into `studio/graphics/size-guide/` (boxes and boards without
  cheese, `wedge-1..4.svg`, `mini-piece.svg`) and writes `out/spec.json` (every layer's position).
  One scale for everything: 14 px per inch. A wedge is the same amount of cheese on every board:
  Custom 4, Large 8, Extra Large 12, Gathering 3, Demi 15/16 of one, Mini 3/8 of one.
- `build.js` turns the spec into a `studio_designs` row with the live Studio renderer
  (`out/row.json`, thumb included) plus `out/preview.png`. `row.json` here is the design as first loaded
  (2026-11-15) — reload it to get the original back.

```
python3 make_graphics.py
NODE_PATH=<dir with @fontsource/barlow-condensed and playwright> node build.js
```

Load (keeps the design if staff already edited it):
```sql
insert into studio_designs (id,name,w,h,unit,kind,page_count,thumb,pages,created_at,updated_at)
select r->>'id', r->>'name', (r->>'w')::int, (r->>'h')::int, r->>'unit', r->>'kind', 1, r->>'thumb', r->'pages',
       (r->>'created_at')::timestamptz, (r->>'updated_at')::timestamptz
from (select content::jsonb r from http_get('https://raw.githubusercontent.com/brad695/staff-portal/<commit>/tools/size-guide/row.json')) s
on conflict (id) do nothing;   -- use do update set pages = excluded.pages, thumb = excluded.thumb only to reset it on purpose
```
