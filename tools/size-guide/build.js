// Builds the "Board Size Comparison" Studio design from out/spec.json with the real Studio renderer.
// Writes out/row.json (a studio_designs row, thumb included) and out/preview.png (2x).
//   python3 make_graphics.py && node build.js [--chrome /path/to/chrome]
// Needs playwright and @fontsource/barlow-condensed on NODE_PATH (or npm i them here).
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const META = { id: 'dboardsizes', name: 'Board Size Comparison', pageId: 'pboardsizes1' };
const WEIGHTS = [600, 700];

function fontsCss() {
  const out = [];
  for (const w of WEIGHTS) {
    const css = fs.readFileSync(require.resolve(`@fontsource/barlow-condensed/${w}.css`), 'utf8');
    for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(m[1])[1];
      if (!/-latin(-ext)?-\d+-normal\.woff2$/.test(file)) continue;
      const range = /unicode-range:\s*([^;]+);/.exec(m[1])[1];
      out.push(`@font-face{font-family:'Barlow Condensed';font-style:normal;font-weight:${w};font-display:block;src:url(/__font/${file}) format('woff2');unicode-range:${range};}`);
    }
  }
  return out.join('\n');
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const css = fontsCss();
const fontDir = path.join(path.dirname(require.resolve('@fontsource/barlow-condensed/package.json')), 'files');
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/tools/size-guide/fonts.css') { r.writeHead(200, { 'content-type': 'text/css' }); return r.end(css); }
  const f = u.startsWith('/__font/') ? path.join(fontDir, path.basename(u)) : path.join(REPO, u);
  if ((!f.startsWith(REPO) && !f.startsWith(fontDir)) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

(async () => {
  await new Promise((ok) => srv.listen(0, ok));
  const port = srv.address().port;
  const spec = JSON.parse(fs.readFileSync(path.join(OUT, 'spec.json'), 'utf8'));
  const browser = await chromium.launch({ executablePath: arg('--chrome') || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic/, (r) => r.abort());
  await page.goto(`http://localhost:${port}/tools/size-guide/harness.html`);
  const ok = await page.evaluate(() => window.fontsReady);
  if (!ok.every(Boolean)) throw new Error('Barlow Condensed did not load: ' + ok);
  const now = Date.now();
  const res = await page.evaluate(async ([spec, meta]) => {
    const d = window.buildDesign(spec, meta);
    await window.prep(d);
    return { d, thumb: window.thumbOf(d), png: window.pngOf(d, 2) };
  }, [spec, Object.assign({ createdAt: now }, META)]);
  const iso = new Date(now).toISOString();
  const d = res.d;
  const row = { id: d.id, name: d.name, w: d.w, h: d.h, unit: d.unit, kind: d.kind, page_count: 1, thumb: res.thumb, pages: d.pages, created_at: iso, updated_at: iso };
  fs.writeFileSync(path.join(OUT, 'row.json'), JSON.stringify(row));
  fs.writeFileSync(path.join(OUT, 'preview.png'), Buffer.from(res.png.split(',')[1], 'base64'));
  console.log(`${d.pages[0].els.length} layers -> out/row.json (${(JSON.stringify(row).length / 1024).toFixed(1)} KB), out/preview.png`);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
