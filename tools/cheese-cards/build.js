// Builds GREYS Studio cheese cards from studio/data/cheese-cards.json with the real Studio renderer.
// Writes out/rows.json (studio_designs rows, thumbs included) and, with --png, 300 dpi PNGs in out/png.
//   npm i && node build.js [--png] [--only dccxxx,dccyyy] [--chrome /usr/bin/google-chrome]
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FACES = [['League Spartan', 'league-spartan', [700, 800]], ['Barlow Condensed', 'barlow-condensed', [800]], ['Nunito Sans', 'nunito-sans', [400, 800]]];

function fontsCss() {
  const out = [];
  for (const [fam, pkg, wts] of FACES) for (const w of wts) {
    const css = fs.readFileSync(require.resolve(`@fontsource/${pkg}/${w}.css`), 'utf8');
    for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(m[1])[1];
      if (!/-latin(-ext)?-\d+-normal\.woff2$/.test(file)) continue;
      const range = /unicode-range:\s*([^;]+);/.exec(m[1])[1];
      out.push(`@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:block;src:url(/__font/${pkg}/${file}) format('woff2');unicode-range:${range};}`);
    }
  }
  return out.join('\n');
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const css = fontsCss();
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/tools/cheese-cards/fonts.css') { r.writeHead(200, { 'content-type': 'text/css' }); return r.end(css); }
  let f;
  if (u.startsWith('/__font/')) { const [, , pkg, file] = u.split('/'); f = path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file); }
  else f = path.join(REPO, u);
  if ((!f.startsWith(REPO) && !u.startsWith('/__font/')) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

(async () => {
  await new Promise((ok) => srv.listen(0, ok));
  const port = srv.address().port;
  const data = JSON.parse(fs.readFileSync(path.join(REPO, 'studio/data/cheese-cards.json'), 'utf8'));
  const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
  // alphabetical; created/updated times step back 1 s per card so the Studio home (newest first) reads A to Z
  const all = data.cards.slice().sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const base = Date.parse(arg('--base') || new Date().toISOString());
  const browser = await chromium.launch({ executablePath: arg('--chrome') || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic/, (r) => r.abort());
  await page.goto(`http://localhost:${port}/tools/cheese-cards/harness.html`);
  const ok = await page.evaluate(() => window.fontsReady);
  if (!ok.every(Boolean)) throw new Error('brand fonts did not load: ' + ok);
  fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });
  const rows = [], warns = [];
  for (let i = 0; i < all.length; i++) {
    const c = Object.assign({}, all[i], { line: [all[i].origin, all[i].milk, all[i].treat].filter(Boolean).join('  ·  ') });
    if (only && !only.has(c.design_id)) continue;
    const res = await page.evaluate(([c, i, base, png]) => {
      const { d, diag } = window.buildCard(c, i, base);
      return { d, diag, thumb: window.thumbOf(d), png: png ? window.pngOf(d, 3.125) : null };
    }, [c, i, base, process.argv.includes('--png')]);
    const iso = new Date(res.d.createdAt).toISOString();
    rows.push({ id: res.d.id, name: res.d.name, w: res.d.w, h: res.d.h, unit: res.d.unit, kind: res.d.kind, page_count: 1, thumb: res.thumb, pages: res.d.pages, created_at: iso, updated_at: iso });
    if (res.diag.warn.length) warns.push(c.name + ': ' + res.diag.warn.join(', '));
    if (res.png) fs.writeFileSync(path.join(OUT, 'png', String(i).padStart(3, '0') + '-' + c.design_id + '.png'), Buffer.from(res.png.split(',')[1], 'base64'));
  }
  fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows));
  console.log(`${rows.length} cards -> out/rows.json` + (warns.length ? '\nCHECK:\n' + warns.join('\n') : ''));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
