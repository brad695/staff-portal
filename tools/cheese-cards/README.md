# Cheese and wine counter cards → GREYS Studio

Makes one Studio design per cheese from `studio/data/cheese-cards.json`, or per wine from
`studio/data/wine-cards.json` (`--wine`), using the Studio's own "Cheese counter card" /
"Wine counter card" templates and renderer, so the cards open and edit like any other design.

The layout rules (text fitting, the milk / glass badge) live in `studio/js/cards.js`, shared with
Cheese Entry in `manager.html`: since 2026-11-15 every new cheese saved there gets its card on its own
(studio-ai `cheese-card` looks the cheese up on the web, `cards.js` lays it out, the row goes into
`studio_designs` with `do nothing` on conflict). Those cards keep their fields in `pages[0].card`.
Rows on the Running PLU list without a card have a "+ Card" button. Change the layout in `cards.js`
and both places follow; `tests/test-cheese-entry-cards.js` covers the Cheese Entry side.

## Print the cards
Staff print cards from the manager console: **Cheese Case ▸ Print Cards** (`/manager#cardprint`). Search, add the
cheeses (and wines), set copies, then Print or Download PDF: 8 to a letter sheet, each card 3.5 × 2.5 in, with cut marks,
drawn at 300 dpi from the designs as they are in the Studio right now. The sheet layout and the PDF live in
`studio/js/sheets.js` (`GS.Sheets`); `tests/test-card-print.js` covers the tab.

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

### Wine cards
`studio/data/wine-cards.json` has the same fields, with these differences:

| field | what goes on the card |
|---|---|
| `design_id` | `dwc` + the Square item id, lowercased |
| `sub` | the producer (or a style word when the producer isn't known) |
| `line` | the rust line, parts joined with `  ·  ` — the place, plus the grape when the title doesn't already say it. `origin` and `grape` keep the full detail |
| `type` | picks the glass on the badge: `red`, `white`, `rose`, `orange`, `sparkling`, `sparkling-rose`, `dessert` or `port` (`studio/graphics/wine-*.svg`) |
| `price` | e.g. `$27.00` |

`skipped` lists Square wines that sold but have no card yet, and why.

Text is fitted automatically: titles shrink to one line, the gold line and origin line stay on one line,
the note shrinks if it would run past the rule. `build.js` prints anything that still doesn't fit.

## Build
```
cd tools/cheese-cards
npm i
node build.js            # all cards -> out/rows.json (studio_designs rows with thumbnails)
node build.js --png      # also 300 dpi PNGs in out/png
node build.js --only dccabc123,dccdef456
node build.js --wine --png   # wine cards -> out-wine/rows.json and out-wine/png
```

## Load into the Studio
`out/rows.json` (or `out-wine/rows.json`) is too big for one SQL statement. Push it to a throwaway branch, pull it into the
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
