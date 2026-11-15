# Cheese counter cards → GREYS Studio

Makes one Studio design per cheese from `studio/data/cheese-cards.json`, using the Studio's own
"Cheese counter card" template and renderer, so the cards open and edit like any other design.

## Add or change cheeses
Edit `studio/data/cheese-cards.json`. One entry per Square item:

| field | what goes on the card |
|---|---|
| `design_id` | `dcc` + the Square item id, lowercased (letters/digits only — the Studio's `#d-<id>` route needs that) |
| `name` | the design's name on the Studio home (searchable) |
| `title` / `sub` | big cream name / gold caps line under it (maker, age or style) |
| `origin`, `milk`, `treat` | the "France · Cow · Raw" line. Leave `treat` empty when raw vs pasteurized isn't confirmed. `milk` also picks the badge: `Cow`, `Goat` or `Sheep` get that animal (`studio/graphics/*.svg`); blends like `Sheep & goat` get the gold cheese wheel |
| `desc` | tasting note, 2–3 lines (about 100 characters) |
| `price` | e.g. `$38.00 / lb`, `$14.00 each` |

Text is fitted automatically: titles shrink to one line, the gold line and origin line stay on one line,
the note shrinks if it would run past the rule. `build.js` prints anything that still doesn't fit.

## Build
```
cd tools/cheese-cards
npm i
node build.js            # all cards -> out/rows.json (studio_designs rows with thumbnails)
node build.js --png      # also 300 dpi PNGs in out/png
node build.js --only dccabc123,dccdef456
```

## Load into the Studio
`out/rows.json` is too big for one SQL statement. Push it to a throwaway branch, pull it into the
database with the `http` extension, then delete the branch:
```sql
insert into studio_designs (id,name,w,h,unit,kind,page_count,thumb,pages,created_at,updated_at)
select r->>'id', r->>'name', (r->>'w')::int, (r->>'h')::int, r->>'unit', r->>'kind', 1, r->>'thumb', r->'pages',
       (r->>'created_at')::timestamptz, (r->>'updated_at')::timestamptz
from (select content::jsonb j from http_get('https://raw.githubusercontent.com/brad695/staff-portal/<branch>/rows.json')) s,
     jsonb_array_elements(s.j) r
on conflict (id) do nothing;   -- keeps cards staff already edited; use do update only to regenerate on purpose
```
To regenerate cards on purpose (new look for existing cards), first check nobody edited them
(`updated_at = created_at`), then use `on conflict (id) do update set pages = excluded.pages,
thumb = excluded.thumb, updated_at = excluded.updated_at` so the cards keep their created date.
