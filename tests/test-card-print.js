/*
 * 🖨️ Print Cards (2026-11-16): the Cheese Case tab in manager.html that lays counter cards out 6 to a letter sheet
 * and prints them — the picker, the print list, the sheet preview and the PDF (studio/js/sheets.js).
 * Supabase is stubbed with real card rows, built here from studio/data/*-cards.json by the Studio's own code. The
 * Studio scripts, badge SVGs and brand fonts are the real files (fonts from @fontsource instead of Google). Nothing
 * goes to the network.
 * Run: NODE_PATH=<dir with @fontsource/*>:$(npm root -g) node tests/test-card-print.js   (SHOTS=dir for screenshots and the PDFs)
 * qpdf and pdftoppm double-check the PDF when they are installed.
 * PRINT_DIALOG=1 (needs a display: xvfb-run -a node …) also presses the real Print button in a headed Chrome and
 * checks that Chrome's own print preview opens on the PDF, with scaling off.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOST = "https://staff.greyscheese.com";
const REPO = path.join(__dirname, "..");
const MANAGER = fs.readFileSync(path.join(REPO, "manager.html"));
const SHOTS = process.env.SHOTS || "";
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 500) : "")); } };
const has = (cmd) => spawnSync("sh", ["-c", "command -v " + cmd]).status === 0;

// brand fonts: Google's css2 answered with @fontsource faces
const FACES = [["League Spartan", "league-spartan", [700, 800]], ["Barlow Condensed", "barlow-condensed", [800]], ["Nunito Sans", "nunito-sans", [400, 800]]];
function fontsCss() {
  const out = [];
  for (const [fam, pkg, wts] of FACES) for (const w of wts) {
    const css = fs.readFileSync(require.resolve(`@fontsource/${pkg}/${w}.css`), "utf8");
    for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(m[1])[1];
      if (!/-latin(-ext)?-\d+-normal\.woff2$/.test(file)) continue;
      const range = /unicode-range:\s*([^;]+);/.exec(m[1])[1];
      out.push(`@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/__font/${pkg}/${file}) format('woff2');unicode-range:${range};}`);
    }
  }
  return out.join("\n");
}
const FONT_CSS = fontsCss();
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

// the files every page here may ask for; `st` lets a test break the fonts or one picture
function staticRoute(route, st) {
  const u = new URL(route.request().url());
  if (u.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: FONT_CSS }), true;
  if (u.hostname === "fonts.gstatic.com" && u.pathname.startsWith("/__font/")) {
    if (st && st.noFonts) return route.fulfill({ status: 404, headers: CORS, body: "" }), true;
    const [, , pkg, file] = u.pathname.split("/");
    return route.fulfill({ status: 200, headers: CORS, contentType: "font/woff2", body: fs.readFileSync(path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), "files", file)) }), true;
  }
  if (u.origin === HOST && /^\/studio\/(js|graphics)\//.test(u.pathname)) {
    const f = path.join(REPO, u.pathname);
    if (st) st.files.push(u.pathname);
    if ((st && st.break && st.break.test(u.pathname)) || !f.startsWith(REPO) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: "" }), true;
    return route.fulfill({ status: 200, contentType: f.endsWith(".svg") ? "image/svg+xml" : "application/javascript", body: fs.readFileSync(f) }), true;
  }
  return false;
}

// Real studio_designs rows for every researched card, made the way tools/cheese-cards makes them.
async function makeRows(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    if (staticRoute(route)) return;
    const u = new URL(route.request().url());
    if (u.origin === HOST && u.pathname === "/__cards") return route.fulfill({ status: 200, contentType: "text/html", body:
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=League+Spartan&family=Barlow+Condensed&family=Nunito+Sans">' +
      ["util", "fonts", "shapes", "render", "templates", "cards"].map((f) => '<script src="/studio/js/' + f + '.js"></script>').join("") });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(HOST + "/__cards");
  const sets = ["cheese", "wine"].map((kind) => [kind, JSON.parse(fs.readFileSync(path.join(REPO, "studio/data/" + kind + "-cards.json"), "utf8")).cards]);
  const rows = await page.evaluate(async (sets) => {
    const C = window.GS.Cards, out = [], base = Date.parse("2026-11-15T19:12:00Z");
    for (const f of C.FACES) await document.fonts.load(f, C.SAMPLE + "ÀÂÇÈÉÊËÎÏÔÙÛÜàâçèéêëîïôùûüñ");
    if (!C.FACES.every((f) => document.fonts.check(f, "Aa"))) throw new Error("brand fonts did not load");
    window.GS.bus.emit("fontsloaded");
    for (const [kind, cards] of sets) {
      const all = cards.slice().sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
      for (let i = 0; i < all.length; i++) {
        const { d } = C.build(all[i], kind);
        await C.prep(d);
        out.push(C.row(d, C.thumb(d), base - (kind === "wine" ? 4000000 : 0) - i * 1000));
      }
    }
    return out;
  }, sets);
  await ctx.close();
  return rows;
}

// supabase-js stand-in: a manager session, is_app_admin true, the card rows in studio_designs, empty everything else
const sbStub = (rows, deny) => `(function(){
  var S = window.__sb = { rows: ${JSON.stringify(rows)}, log: [], deny: ${!!deny} };
  function result(q){
    var arg = function(k){ var o = q.ops.filter(function(o){ return o[0] === k; })[0]; return o ? o.slice(1) : null; };
    if (q.table !== 'studio_designs') return { data: q.single ? null : [], error: null, count: 0 };
    if (S.deny) return { data: null, error: { message: 'permission denied for table studio_designs' } };
    var out = S.rows.slice(), sel = (arg('select') || ['*'])[0], rng = arg('range'), eq = arg('eq');
    q.ops.forEach(function(o){ if (o[0] === 'in') out = out.filter(function(r){ return o[2].indexOf(r[o[1]]) >= 0; }); });
    if (eq) out = out.filter(function(r){ return r[eq[0]] === eq[1]; });
    if (arg('order')) out.sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    if (rng) out = out.slice(rng[0], rng[1] + 1);
    S.log.push({ sel: sel, n: out.length });
    return { data: out.map(function(r){ if (sel === '*') return r; var o = {}; sel.split(',').forEach(function(c){ o[c] = r[c]; }); return o; }), error: null };
  }
  function builder(table){
    var q = { table: table, ops: [] };
    var b = new Proxy({}, { get: function(_, k){
      if (k === 'then') return function(a, r){ return new Promise(function(res){ setTimeout(function(){ res(result(q)); }, 15); }).then(a, r); };
      if (k === 'maybeSingle' || k === 'single') return function(){ q.single = true; return b; };
      return function(){ q.ops.push([k].concat([].slice.call(arguments))); return b; };
    } });
    return b;
  }
  var session = { access_token: 'tok-manager', user: { email: 'manager@greyscheese.com' } };
  var client = {
    auth: { getSession: function(){ return Promise.resolve({ data: { session: session } }); }, onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
      signOut: function(){ return Promise.resolve({}); }, getUser: function(){ return Promise.resolve({ data: { user: session.user } }); } },
    rpc: function(name){ return Promise.resolve({ data: name === 'is_app_admin' ? true : null, error: null }); },
    from: builder,
    storage: { from: function(){ return builder('storage'); } },
    channel: function(){ var c = { on: function(){ return c; }, subscribe: function(){ return c; } }; return c; }, removeChannel: function(){}
  };
  window.supabase = { createClient: function(){ return client; } };
})();`;

async function open(browser, rows, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const st = { errors: [], files: [], noFonts: !!opts.noFonts, break: null };
  page.on("pageerror", (e) => st.errors.push(String(e)));
  const stub = sbStub(rows, opts.deny);
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (!/^https?:$/.test(u.protocol)) return route.continue();   // blob:, data:, and Chrome's own PDF viewer files
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: stub });
    if (staticRoute(route, st)) return;
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "{}" });
  });
  await page.goto(HOST + "/manager.html" + (opts.hash || ""));
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  if (!opts.hash) await page.evaluate(() => mtab("cardprint"));
  if (!opts.deny) await page.waitForSelector("#pcResults .pc-row", { timeout: 10000 });
  await page.waitForSelector("#pcSheets svg", { timeout: 10000 });
  return { ctx, page, st };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const count = (page, sel) => page.locator(sel).count();
const names = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s + " .pc-nm b")].map((b) => b.textContent), sel);
const search = async (page, q) => { await page.fill("#pcQ", q); await page.waitForTimeout(60); };
async function pdfOf(page, how) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), how ? how() : page.click('#pcBar [data-pc="pdf"]')]);
  const buf = fs.readFileSync(await dl.path());
  return { buf, name: dl.suggestedFilename(), s: buf.toString("latin1") };
}
// what a PDF from GS.Sheets holds, read straight from its bytes
function readPdf(s) {
  const pages = s.split(/\d+ 0 obj\n<< \/Type \/Page \/Parent/).slice(1).map((chunk) => {
    const body = /stream\n([\s\S]*?)\nendstream/.exec(chunk)[1];
    return {
      box: /\/MediaBox \[([^\]]+)\]/.exec(chunk)[1],
      cards: [...body.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/(I\d+) Do Q/g)].map((m) => ({ w: +m[1], h: +m[2], x: +m[3], y: +m[4], img: m[5] })),
      marks: [...body.matchAll(/([\d.]+) ([\d.]+) m ([\d.]+) ([\d.]+) l S/g)].map((m) => m.slice(1, 5).map(Number)),
    };
  });
  const images = [...s.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+) [^>]*\/Filter \/DCTDecode \/Length (\d+)/g)].map((m) => ({ w: +m[1], h: +m[2], len: +m[3] }));
  return { pages, images, noScale: /\/ViewerPreferences << \/PrintScaling \/None >>/.test(s), header: s.slice(0, 8) };
}
// one PDF page as pixels (pdftoppm at 144 dpi: 2 px to the point)
function pixels(buf, pageNo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-")), f = path.join(dir, "x.pdf");
  fs.writeFileSync(f, buf);
  const r = spawnSync("pdftoppm", ["-r", "144", "-f", String(pageNo), "-l", String(pageNo), f, path.join(dir, "p")]);
  if (r.status !== 0) return null;
  const ppm = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith(".ppm"))));
  const head = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString("latin1", 0, 40)), w = +head[1], h = +head[2], off = head[0].length;
  return { w, h, at: (xPt, yPt) => { const i = off + (Math.round(yPt * 2) * w + Math.round(xPt * 2)) * 3; return [ppm[i], ppm[i + 1], ppm[i + 2]]; } };
}
const navy = (p) => p[0] < 40 && p[1] < 75 && p[2] < 95;
const white = (p) => p[0] > 245 && p[1] > 245 && p[2] > 245;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  console.log("\nmaking the card rows with the Studio's own code…");
  const rows = await makeRows(browser);
  const nCheese = rows.filter((r) => r.kind === "cheese-card").length, nWine = rows.filter((r) => r.kind === "wine-card").length;
  // two cards made "today" in Cheese Entry, so Newest has something to put first
  const fresh = rows.filter((r) => r.kind === "cheese-card").slice(60, 62);
  fresh.forEach((r, i) => { r.created_at = r.updated_at = new Date(Date.parse("2026-11-16T15:00:00Z") + i * 60000).toISOString(); });
  const comte = rows.filter((r) => /^Comté/.test(r.name)).map((r) => r.name).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  console.log(`  ${nCheese} cheese cards, ${nWine} wine cards`);

  console.log("\nmanager.html · 🖨️ Print Cards (desktop)");
  {
    const { ctx, page, st } = await open(browser, rows);
    // ---- the tab ----
    const nav = await page.evaluate(() => {
      const tab = document.querySelector('.tab[onclick*="cardprint"]'), g = window.__NAV.groups.find((x) => x.tabs.includes(tab));
      return { group: g && g.name, tabs: g && g.tabs.map((x) => x.textContent.trim()), active: tab.classList.contains("active"), panel: document.getElementById("panel-cardprint").classList.contains("active"),
        title: (document.querySelector(".v3-title h1") || {}).textContent, crumb: (document.querySelector(".v3-title .crumb") || {}).textContent };
    });
    t("Print Cards is a tab in the Cheese Case section", nav.group === "Cheese Case" && nav.tabs.length === 3 && /Print Cards$/.test(nav.tabs[2]) && nav.active && nav.panel, nav);
    t("…with its name in the title bar", nav.title === "Print Cards" && nav.crumb === "Cheese Case", nav);

    // ---- the cards ----
    t("the tabs count the cards: Cheese, Wine, Newest", (await txt(page, "#pcTabs")) === `Cheese · ${nCheese}Wine · ${nWine}Newest`, await txt(page, "#pcTabs"));
    const first = await names(page, "#pcResults");
    t("cheeses list A to Z, 40 at a time", first.length === 40 && first.join("|") === first.slice().sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })).join("|") && /Show 40 more/.test(await txt(page, "#pcResults .pc-more")), first.slice(0, 4));
    await page.waitForFunction(() => [...document.querySelectorAll("#pcResults img.pc-th")].every((i) => /^blob:/.test(i.src) && i.naturalWidth > 0), null, { timeout: 8000 });
    const thumbAsk = await page.evaluate(() => window.__sb.log.filter((l) => /thumb/.test(l.sel)).reduce((a, l) => a + l.n, 0));
    t("thumbnails are fetched only for the rows on screen", thumbAsk === 40, thumbAsk);
    t("the list itself loads names only (no thumbnails, no designs)", await page.evaluate(() => window.__sb.log.some((l) => l.sel === "id,name,kind,created_at,updated_at" && l.n > 100) && window.__sb.log.filter((l) => l.n > 50).every((l) => !/thumb|pages/.test(l.sel))));
    await page.click("#pcResults .pc-more");
    t("Show more adds the next 40", (await count(page, "#pcResults .pc-row")) === 80);
    t("an empty list shows an empty sheet and nothing to print", (await count(page, "#pcSheets svg")) === 1 && (await count(page, "#pcSheets image")) === 0 && (await count(page, "#pcSheets .pc-slot")) === 6
      && /No cards yet/.test(await txt(page, "#pcBar")) && await page.evaluate(() => document.querySelector('#pcBar [data-pc="print"]').disabled && document.querySelector('#pcBar [data-pc="pdf"]').disabled));

    // ---- the form: search and add ----
    await search(page, "comte");
    const found = await names(page, "#pcResults");
    t("search ignores accents (comte finds Comté)", found.length === comte.length && found.every((n) => /^Comté/.test(n)), found);
    t("…and marks the top match that Enter will add", (await count(page, "#pcResults .pc-row.top")) === 1 && /Enter adds the top one/.test(await txt(page, "#pcFoot")));
    await page.press("#pcQ", "Enter");
    t("Enter adds the top match to the print list", (await names(page, "#pcList")).join("|") === comte[0].split(" — ")[0] && (await txt(page, "#pcCount")) === "1 card", await names(page, "#pcList"));
    t("…its row now shows the copies control", (await txt(page, "#pcResults .pc-row.top .pc-qty b")) === "1" && (await count(page, "#pcResults .pc-row.top .pc-add")) === 0);
    t("…and it lands top left on the sheet, with room for 5 more", (await count(page, "#pcSheets image")) === 1 && (await count(page, "#pcSheets .pc-slot")) === 5 && /1 sheet · 1 card/.test(await txt(page, "#pcBar")) && /Room for 5 more/.test(await txt(page, "#pcBar")), await txt(page, "#pcBar"));
    const slot = await page.evaluate(() => { const i = document.querySelector("#pcSheets image"); return ["x", "y", "width", "height"].map((k) => +i.getAttribute(k)); });
    t("…in a 4 × 3 in slot, a quarter inch in and an inch down", slot.join(",") === "18,72,288,216", slot);
    await page.click('#pcResults .pc-row:nth-child(2) [data-pc="add"]');
    await page.click('#pcResults .pc-row:nth-child(2) [data-pc="add"]');
    await page.click('#pcResults .pc-row:nth-child(2) [data-pc="add"]');
    t("＋ Add then + makes copies (2nd Comté × 3)", (await txt(page, "#pcResults .pc-row:nth-child(2) .pc-qty b")) === "3" && (await txt(page, "#pcCount")) === "4 cards" && (await count(page, "#pcSheets image")) === 4);
    t("…and the keyboard stays on the + it pressed", await page.evaluate(() => { const a = document.activeElement; return a.getAttribute("data-pc") === "add" && !!a.closest("#pcResults .pc-row:nth-child(2)"); }));
    await page.click('#pcList .pc-row:nth-child(2) [data-pc="sub"]');
    t("− in the print list takes one off", (await txt(page, "#pcList .pc-row:nth-child(2) .pc-qty b")) === "2" && (await txt(page, "#pcResults .pc-row:nth-child(2) .pc-qty b")) === "2");

    await search(page, "brie");
    const brie = await page.evaluate(() => [...document.querySelectorAll("#pcResults .pc-nm")].map((n) => n.getAttribute("title")));
    const startsWord = (n) => /(^|[^a-z0-9])brie/.test(n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
    t("names where the word starts come before ones that just contain it (Brie before Gabriel)", brie.length > 2 && /^Brie/.test(brie[0]) && startsWord(brie[1]) && brie.some((n) => !startsWord(n))
      && brie.findIndex((n) => !startsWord(n)) > brie.map(startsWord).lastIndexOf(true), brie);

    // ---- wine: the other tab ----
    await search(page, "sauternes");
    t("a wine typed on the Cheese tab points to the Wine tab", /Nothing here matches “sauternes”/.test(await txt(page, "#pcResults")) && /1 wine card does — show it/.test(await txt(page, "#pcResults")), await txt(page, "#pcResults"));
    await page.click('#pcResults [data-pc="tab"]');
    t("…and one click shows it", (await count(page, "#pcResults .pc-row")) === 1 && await page.evaluate(() => document.querySelector('#pcTabs .chip.on').textContent.startsWith("Wine")));
    await page.click('#pcResults [data-pc="add"]');
    t("a wine is tagged Wine on the print list (not on its own tab)", (await txt(page, "#pcList .pc-tag")) === "Wine" && (await count(page, "#pcResults .pc-tag")) === 0);
    await search(page, "");
    const wrap = await page.evaluate(() => [...document.querySelectorAll("#pcResults .pc-row")].slice(0, 12).map((r) => { const b = r.querySelector(".pc-nm b"); return [b.scrollWidth <= b.clientWidth + 1, b.scrollHeight <= b.clientHeight + 1, Math.round(r.getBoundingClientRect().height)]; }));
    t("long wine names wrap to a second line instead of being cut off", wrap.every((x) => x[0]) && wrap.filter((x) => !x[1]).length <= 1 && wrap.every((x) => x[2] <= 70), wrap);
    await search(page, "");
    await page.click('#pcTabs [data-v="new"]');
    const newest = await names(page, "#pcResults");
    t("Newest puts the latest cards first", newest.length === 30 && newest[0] === fresh[1].name.split(" — ")[0] && newest[1] === fresh[0].name.split(" — ")[0], newest.slice(0, 3));
    await page.click('#pcResults .pc-row:nth-child(1) [data-pc="add"]');
    await page.click('#pcResults .pc-row:nth-child(2) [data-pc="add"]');
    await page.click('#pcTabs [data-v="cheese"]');

    // ---- the sheets ----
    // list now: Comté A ×1, Comté B ×2, Sauternes ×1, 2 new = 6 cards -> one full sheet
    t("six cards fill one sheet", /1 sheet · 6 cards/.test(await txt(page, "#pcBar")) && /The sheet is full/.test(await txt(page, "#pcBar")) && (await count(page, "#pcSheets svg")) === 1 && (await count(page, "#pcSheets image")) === 6 && (await count(page, "#pcSheets .pc-slot")) === 0);
    const one = await page.evaluate(() => Math.round(document.querySelector("#pcSheets svg").getBoundingClientRect().width));
    if (SHOTS) { await page.waitForFunction(() => [...document.querySelectorAll("#pcSheets image")].every((i) => /^blob:/.test(i.getAttribute("href") || "")), null, { timeout: 8000 }); await page.screenshot({ path: path.join(SHOTS, "card-print-one-sheet.png") }); }
    await page.click('#pcListActs [data-pc="extra"]');
    t("“Copies of every card +” adds one of each (5 cards → 11)", (await txt(page, "#pcCount")) === "11 cards" && /2 sheets · 11 cards/.test(await txt(page, "#pcBar")) && /Room for 1 more/.test(await txt(page, "#pcBar")) && (await count(page, "#pcSheets svg")) === 2, await txt(page, "#pcBar"));
    const order = await page.evaluate(() => [...document.querySelectorAll("#pcSheets svg")].map((s) => [...s.querySelectorAll("image title")].map((x) => x.textContent)));
    t("copies sit together, in the order added", order[0][0] === comte[0] && order[0][1] === comte[0] && order[0][2] === comte[1] && order[0][4] === comte[1] && order[1].length === 5, order);
    t("each sheet carries cut marks", (await count(page, "#pcSheets .pc-mark")) === 2);
    const two = await page.evaluate(() => [...document.querySelectorAll("#pcSheets svg")].map((s) => s.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width)]));
    t("one sheet shows big; more sit side by side", one > 380 && two[0][2] < one && two[0][1] === two[1][1] && two[1][0] > two[0][0], [one, two]);
    await page.waitForFunction(() => [...document.querySelectorAll("#pcSheets image")].every((i) => /^blob:/.test(i.getAttribute("href") || "")), null, { timeout: 8000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "card-print-desktop.png"), fullPage: true });

    // ---- the PDF ----
    await page.evaluate(() => { window.__toBlob = 0; const was = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function () { window.__toBlob++; return was.apply(this, arguments); }; });
    const a = await pdfOf(page);
    const A = readPdf(a.s);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "cards-11.pdf"), a.buf);
    t("Download PDF saves GREYS-cards-<date>.pdf", /^GREYS-cards-\d{4}-\d{2}-\d{2}\.pdf$/.test(a.name) && A.header === "%PDF-1.6", [a.name, A.header]);
    t("…2 letter pages, 6 + 5 cards", A.pages.length === 2 && A.pages.every((p) => p.box === "0 0 612 792") && A.pages[0].cards.length === 6 && A.pages[1].cards.length === 5, A.pages.map((p) => [p.box, p.cards.length]));
    t("…every card exactly 4 × 3 in, on the 2 × 3 grid", A.pages.every((p) => p.cards.every((c, j) => c.w === 288 && c.h === 216 && c.x === [18, 306][j % 2] && c.y === [504, 288, 72][Math.floor(j / 2)])), A.pages[0].cards);
    t("…each card's picture stored once, at 300 dpi", A.images.length === 5 && A.images.every((i) => i.w === 1200 && i.h === 900 && i.len > 20000), A.images);
    t("…copies point at the same picture", A.pages[0].cards[0].img === A.pages[0].cards[1].img && A.pages[0].cards[1].img !== A.pages[0].cards[2].img);
    t("the cards are encoded right away, never waiting on canvas.toBlob (a second or more per card in a real Chrome)", (await page.evaluate(() => window.__toBlob)) === 0);
    t("…and the PDF asks the print dialog for 100% (no fit-to-page)", A.noScale);
    const key = (m) => m.join(",");
    const m0 = A.pages[0].marks.map(key), m1 = A.pages[1].marks.map(key);
    t("a full sheet has 14 cut marks: 3 up-and-down lines, 4 across, a tick at each end", m0.length === 14 && m0.includes("18,745.2,18,723.6") && m0.includes("306,68.4,306,46.8") && m0.includes("0,720,14.4,720") && m0.includes("597.6,72,612,72"), m0);
    t("…none of them touching a card", A.pages.every((p) => p.marks.every((m) => (m[0] === m[2] ? (m[1] >= 723 && m[3] >= 723) || (m[1] <= 69 && m[3] <= 69) || (m[1] <= 285 && m[3] <= 285 && p.cards.length < 6) : (m[0] <= 15 && m[2] <= 15) || (m[0] >= 597 && m[2] >= 597)))), A.pages[1].marks);
    t("a sheet with 5 cards keeps its marks out of the empty spot", m1.length === 14 && m1.includes("306,68.4,306,46.8") && m1.includes("594,68.4,594,46.8"), m1);
    const done = await txt(page, "#pcMsg");
    t("it says what it saved and how to print it", /^Saved GREYS-cards-.*\(2 sheets\)\. Print it at 100%/.test(done), done);
    if (has("qpdf")) {
      const f = path.join(os.tmpdir(), "pc-check-" + process.pid + ".pdf");
      fs.writeFileSync(f, a.buf);
      const r = spawnSync("qpdf", ["--check", f]);
      t("qpdf finds no errors in the file", r.status === 0 && !/error|warning/i.test(String(r.stderr)), String(r.stdout).slice(0, 200) + String(r.stderr).slice(0, 200));
      fs.unlinkSync(f);
    }
    if (has("pdftoppm")) {
      const px = pixels(a.buf, 1);
      t("printed page: navy bands where the cards start, white where they end", !!px && px.w === 1224 && px.h === 1584 && navy(px.at(24, 80)) && navy(px.at(588, 80)) && navy(px.at(24, 296)) && navy(px.at(24, 512))
        && white(px.at(300, 284)) && white(px.at(10, 400)) && white(px.at(306, 30)), px && [px.w, px.h, px.at(24, 80), px.at(300, 284)]);
      const dark = (x, y) => { let m = 255; for (let dx = -1; dx <= 1; dx += 0.5) for (let dy = -1; dy <= 1; dy += 0.5) m = Math.min(m, px.at(x + dx, y + dy)[0]); return m < 150; };
      t("…with the cut marks drawn in the margins", dark(18, 57) && dark(306, 57) && dark(594, 735) && dark(7, 72) && dark(605, 720) && !dark(160, 57), [px.at(18, 57), px.at(7, 72)]);
      const p2 = pixels(a.buf, 2);
      t("…and the sixth spot on page 2 left blank", !!p2 && navy(p2.at(24, 512)) && white(p2.at(330, 512)) && white(p2.at(450, 600)), p2 && [p2.at(24, 512), p2.at(330, 512)]);
      if (SHOTS) for (const n of [1, 2]) spawnSync("pdftoppm", ["-r", "110", "-png", "-f", String(n), "-l", String(n), path.join(SHOTS, "cards-11.pdf"), path.join(SHOTS, "cards-11-p" + n)]);
    }
    const loaded = await page.evaluate(() => [...document.querySelectorAll('script[src^="/studio/js/"]')].map((s) => s.getAttribute("src").replace(/^.*\/|\.js$/g, "")));
    t("the Studio's renderer was loaded once, in order, with sheets.js", loaded.slice().sort().join() === ["cards", "fonts", "render", "shapes", "sheets", "templates", "util"].join() && loaded.indexOf("util") < loaded.indexOf("render") && loaded.indexOf("render") < loaded.indexOf("cards"), loaded);
    t("the cards were drawn with the brand fonts", await page.evaluate(() => window.GS.Cards.FACES.every((f) => document.fonts.check(f, "Aa"))));
    t("a library photo on an edited card resolves under /studio/ here", await page.evaluate(async () => [await window.GS.Store.resolveURL("p:class.jpg"), await window.GS.Store.resolveURL("g:cow.svg"), await window.GS.Store.resolveURL("/studio/graphics/cow.svg")].join()) === "/studio/photos/class.jpg,/studio/graphics/cow.svg,/studio/graphics/cow.svg");

    // ---- cut marks off ----
    await page.click("#pcMarks");
    t("Cut marks off: none on the sheets", (await count(page, "#pcSheets .pc-mark")) === 0 && !/cut from mark/.test(await txt(page, "#pcBar")));
    const drawnBefore = await page.evaluate(() => window.__sb.log.filter((l) => /pages/.test(l.sel)).length);
    const b = await pdfOf(page);
    const B = readPdf(b.s);
    t("…and none in the PDF, cards unmoved", B.pages.length === 2 && B.pages.every((p) => p.marks.length === 0) && JSON.stringify(B.pages.map((p) => p.cards.map((c) => [c.x, c.y]))) === JSON.stringify(A.pages.map((p) => p.cards.map((c) => [c.x, c.y]))));
    t("a second print reuses the drawn cards (same pictures)", JSON.stringify(B.images) === JSON.stringify(A.images) && await page.evaluate((n) => window.__sb.log.filter((l) => /pages/.test(l.sel)).length === n + 1, drawnBefore));
    await page.click("#pcMarks");

    // ---- a card changed in the Studio, and one deleted there ----
    await page.evaluate((name) => {
      const r = window.__sb.rows.find((x) => x.name === name);
      r.pages[0].els.find((e) => e.type === "text" && /^\$/.test(e.text)).text = "$99.00 / lb";
      r.updated_at = "2026-11-16T18:00:00.000Z";
      window.__sb.rows = window.__sb.rows.filter((x) => !/Sauternes/.test(x.name));
    }, comte[0]);
    const c = await pdfOf(page);
    const C2 = readPdf(c.s);
    t("a card changed in the Studio is drawn again for the next print", C2.images.length === 4 && C2.images[0].len !== A.images[0].len && JSON.stringify(C2.images.slice(1, 2)) === JSON.stringify(A.images.slice(1, 2)), [C2.images.map((i) => i.len), A.images.map((i) => i.len)]);
    t("…and one deleted there is left out, and said so", C2.pages.length === 2 && C2.pages[0].cards.length + C2.pages[1].cards.length === 9 && /1 card no longer in GREYS Studio was left out/.test(await txt(page, "#pcMsg")) && (await txt(page, "#pcCount")) === "9 cards", await txt(page, "#pcMsg"));

    // ---- Print ----
    await page.evaluate(() => {
      window.__cardPrint.direct = true; window.__printed = 0;
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { configurable: true, get() { return { focus() {}, print() { window.__printed++; } }; } });
    });
    await page.click('#pcBar [data-pc="print"]');
    await page.waitForFunction(() => /sent to the print window/.test(document.getElementById("pcMsg").textContent), null, { timeout: 30000 });
    const fr = await page.evaluate(async () => {
      const f = document.querySelector('iframe[title="Cards to print"]');
      const head = f ? new TextDecoder("latin1").decode(new Uint8Array(await (await fetch(f.src)).arrayBuffer()).slice(0, 8)) : "";
      if (f) f.onload();
      await new Promise((r) => setTimeout(r, 500));
      return { src: f && f.src.slice(0, 5), head, printed: window.__printed, n: document.querySelectorAll('iframe[title="Cards to print"]').length };
    });
    t("Print opens the print dialog on the PDF (hidden frame)", fr.src === "blob:" && fr.head === "%PDF-1.6" && fr.printed === 1 && fr.n === 1, fr);
    t("…and says to keep the scale at 100%", /2 sheets sent to the print window — keep the scale at 100%\. Nothing opened\? Use Download PDF\./.test(await txt(page, "#pcMsg")), await txt(page, "#pcMsg"));
    await page.evaluate(() => {
      window.__cardPrint.direct = false; window.__opened = [];
      window.open = function () { const w = { closed: false, document: { write(h) { window.__opened.push("write:" + /Building your sheets/.test(h)); } }, location: { replace(u) { window.__opened.push(u.slice(0, 5)); } }, close() { window.__opened.push("close"); } }; return w; };
    });
    await page.keyboard.press("Control+p");
    await page.waitForFunction(() => /opened in a new tab/.test(document.getElementById("pcMsg").textContent), null, { timeout: 30000 });
    t("Ctrl+P prints the sheets; other browsers get the PDF in a new tab", (await page.evaluate(() => window.__opened.join())) === "write:true,blob:", await page.evaluate(() => window.__opened));

    // ---- clearing, undo, and a reload ----
    await page.click('#pcList .pc-row:nth-child(1) [data-pc="remove"]');
    t("× takes a card off the list", (await count(page, "#pcList .pc-row")) === 3 && (await txt(page, "#pcCount")) === "7 cards");
    await page.click('#pcListActs [data-pc="clear"]');
    t("Clear list empties it and offers Undo", (await count(page, "#pcList .pc-row")) === 0 && /Print list cleared/.test(await txt(page, "#pcMsg")) && (await count(page, '#pcMsg [data-pc="undo"]')) === 1);
    await page.click('#pcMsg [data-pc="undo"]');
    t("Undo brings it back", (await count(page, "#pcList .pc-row")) === 3 && (await txt(page, "#pcCount")) === "7 cards");
    await search(page, "ched");
    const ched = await count(page, "#pcResults .pc-row");
    await page.click('#pcFoot [data-pc="addall"]');
    t("Add all adds every match", ched > 2 && (await count(page, "#pcList .pc-row")) === 3 + ched && (await count(page, '#pcFoot [data-pc="addall"]')) === 0, ched);
    const before = await page.evaluate(() => window.__cardPrint.state.list.map((x) => x.id + "×" + x.n).join());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
    await page.evaluate(() => mtab("cardprint"));
    await page.waitForSelector("#pcList .pc-row", { timeout: 10000 });
    t("the print list is still there after a reload", (await page.evaluate(() => window.__cardPrint.state.list.map((x) => x.id + "×" + x.n).join())) === before && (await count(page, "#pcList .pc-row")) === 3 + ched);
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }

  console.log("\nmanager.html · 🖨️ Print Cards (when something is missing)");
  {
    // the fonts don't arrive: stop, don't print cards in a fallback font
    const { ctx, page, st } = await open(browser, rows, { noFonts: true, hash: "#cardprint" });
    t("manager#cardprint opens the tab", await page.evaluate(() => document.getElementById("panel-cardprint").classList.contains("active")));
    await page.click('#pcResults .pc-row:nth-child(1) [data-pc="add"]');
    await page.click('#pcBar [data-pc="pdf"]');
    await page.waitForSelector("#pcMsg.bad", { timeout: 60000 });
    t("no fonts: it stops and says so, no PDF", /The card fonts didn’t load \(.*Barlow Condensed.*\)\. Check the connection and try again\./.test(await txt(page, "#pcMsg")) && await page.evaluate(() => !document.querySelector('#pcBar [data-pc="pdf"]').disabled), await txt(page, "#pcMsg"));
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  {
    // a badge picture fails once: the card is named, and trying again works
    const { ctx, page, st } = await open(browser, rows);
    const goat = rows.find((r) => r.kind === "cheese-card" && JSON.stringify(r.pages).includes("/studio/graphics/goat.svg"));
    st.break = /goat\.svg$/;
    await search(page, goat.name.split(" — ")[0]);
    await page.evaluate((id) => document.querySelector('#pcResults .pc-row[data-id="' + id + '"] [data-pc="add"]').click(), goat.id);
    await page.click('#pcBar [data-pc="pdf"]');
    await page.waitForSelector("#pcMsg.bad", { timeout: 60000 });
    t("a picture that didn't load names the card instead of printing it empty", (await txt(page, "#pcMsg")) === "A picture on “" + goat.name + "” didn’t load. Try again, or open that card in GREYS Studio and check it.", await txt(page, "#pcMsg"));
    st.break = null;
    const again = readPdf((await pdfOf(page)).s);
    t("…and trying again prints it", again.pages.length === 1 && again.pages[0].cards.length === 1 && again.images.length === 1 && again.pages[0].marks.length === 8, again.pages);
    t("one card: marks hug the card, not the empty sheet", again.pages[0].marks.map((m) => m.join()).includes("309.6,504,331.2,504") && again.pages[0].marks.map((m) => m.join()).includes("306,500.4,306,478.8"), again.pages[0].marks);
    // the cards can't be reached on a later visit to the tab: keep what's already here
    await page.evaluate(() => { window.__sb.deny = true; mtab("plu"); mtab("cardprint"); });
    await page.waitForTimeout(300);
    t("a refresh that fails keeps the cards and the list already loaded", (await count(page, "#pcResults .pc-row")) > 0 && (await count(page, "#pcList .pc-row")) === 1 && (await count(page, '#pcResults [data-pc="reload"]')) === 0);
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  {
    // the cards can't be read at all
    const { ctx, page, st } = await open(browser, rows, { deny: true });
    await page.waitForSelector('#pcResults [data-pc="reload"]', { timeout: 10000 });
    t("cards that can't be read: says why, with Try again", /Couldn’t load the cards: permission denied/.test(await txt(page, "#pcResults")) && (await count(page, "#pcSheets svg")) === 1);
    await page.evaluate(() => { window.__sb.deny = false; });
    await page.click('#pcResults [data-pc="reload"]');
    await page.waitForSelector("#pcResults .pc-row", { timeout: 10000 });
    t("…and Try again loads them", (await count(page, "#pcResults .pc-row")) === 40);
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }

  console.log("\nmanager.html · 🖨️ Print Cards (phone)");
  {
    const { ctx, page, st } = await open(browser, rows, { viewport: { width: 390, height: 844 } });
    await search(page, "brie");
    await page.click('#pcResults .pc-row:nth-child(1) [data-pc="add"]');
    await page.click('#pcResults .pc-row:nth-child(1) [data-pc="add"]');
    const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, btn: Math.round(document.querySelector("#pcResults .pc-qty button").getBoundingClientRect().height),
      cols: getComputedStyle(document.querySelector("#panel-cardprint .pc-wrap")).gridTemplateColumns.split(" ").length, sheet: Math.round(document.querySelector("#pcSheets svg").getBoundingClientRect().width) }));
    t("phone: one column, nothing runs off the side", fit.sw <= fit.w + 1 && fit.cols === 1 && fit.sheet > 250 && fit.sheet <= 390, fit);
    t("phone: the copies buttons are finger sized", fit.btn >= 40, fit);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "card-print-phone.png"), fullPage: true });
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  await browser.close();

  if (process.env.PRINT_DIALOG) {
    console.log("\nmanager.html · 🖨️ Print Cards (the real print dialog, headed Chrome)");
    const PORT = 9339, http = require("http");
    const targets = () => new Promise((res) => http.get("http://127.0.0.1:" + PORT + "/json", (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res([]); } }); }).on("error", () => res([])));
    const headed = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, headless: false, args: ["--no-sandbox", "--remote-debugging-port=" + PORT, "--remote-allow-origins=*"] });
    const { page, st } = await open(headed, rows);
    await search(page, "comte");
    await page.click('#pcResults .pc-row:nth-child(1) [data-pc="add"]');
    await page.click('#pcResults .pc-row:nth-child(2) [data-pc="add"]');
    await page.click('#pcBar [data-pc="print"]');
    let preview = null;
    for (let i = 0; i < 60 && !preview; i++) {
      await new Promise((r) => setTimeout(r, 500));
      preview = (await targets()).find((x) => /^chrome:\/\/print/.test(x.url)) || null;
    }
    t("Print opens Chrome's print preview on the PDF", !!preview);
    if (preview) {
      // ask the preview what it was handed: a 1-page PDF (not the console page), with "fit to page" scaling switched off
      await new Promise((r) => setTimeout(r, 2500));
      const expr = `(function(){ var m = null; (function walk(n){ for (var el of n.children || []) { if (el.tagName === 'PRINT-PREVIEW-MODEL') m = el; if (el.shadowRoot) walk(el.shadowRoot); walk(el); } })(document.body); return m && m.documentSettings ? JSON.stringify(m.documentSettings) : ''; })()`;
      const doc = await new Promise((res) => {
        const ws = new WebSocket(preview.webSocketDebuggerUrl);
        const stop = setTimeout(() => { try { ws.close(); } catch (e) {} res({}); }, 8000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id !== 1) return; clearTimeout(stop); ws.close(); try { res(JSON.parse(d.result.result.value || "{}")); } catch (e) { res({}); } };
        ws.onerror = () => { clearTimeout(stop); res({}); };
      });
      t("…a PDF of 1 sheet, to be printed at true size (PrintScaling None honoured)", doc.isModifiable === false && doc.pageCount === 1 && doc.isScalingDisabled === true, doc);
      t("…and the print job is named for the cards, not the console", doc.title === "GREYS counter cards" && /Manager Console/.test(await page.title()), [doc.title, await page.title()]);
    }
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await headed.close().catch(() => {});
  }
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
