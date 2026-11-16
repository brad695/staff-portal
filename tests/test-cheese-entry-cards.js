/*
 * Cheese Entry → counter card (2026-11-15): saving a cheese in manager.html#plu makes its GREYS Studio
 * "Cheese counter card" — studio-ai looks the cheese up, studio/js/cards.js lays the card out with the Studio's own
 * renderer, and the row lands in studio_designs. Also the "+ Card" / "Card ↗" buttons on the Running PLU list.
 * Supabase, cheese-items and studio-ai are stubbed; the Studio scripts, badge SVGs and brand fonts are the real files
 * (fonts from @fontsource instead of Google). Nothing goes to the network.
 * Run: NODE_PATH=<dir with @fontsource/*>:$(npm root -g) node tests/test-cheese-entry-cards.js   (SHOTS=dir for screenshots)
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const HOST = "https://staff.greyscheese.com";
const REPO = path.join(__dirname, "..");
const MANAGER = fs.readFileSync(path.join(REPO, "manager.html"));
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); } };

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

const SQ_OLD = "PWCCAOW6LIIREX2NEZGR7KGV";   // has a batch card already
const ITEMS = () => [
  { id: "11111111-1111-4111-8111-111111111111", plu: 2210, name: "1605 MANCHEGO", marketing_name: null, category: "Cheese", item_kind: "cheese", price: null, price_per_lb: 41, unit_of_measure: "LB",
    barcode: null, dcg_status: "synced", square_status: "synced", square_item_id: SQ_OLD, printer_profile: "Greys Cheese Label", hot_buttons: true, dcg_locations: ["24755", "28711"] },
  { id: "22222222-2222-4222-8222-222222222222", plu: 2211, name: "TOMME BELINA MADE IN MEADOWS", marketing_name: "Tomme Belina", category: "Cheese", item_kind: "cheese", price: null, price_per_lb: 24, unit_of_measure: "LB",
    barcode: null, dcg_status: "synced", square_status: "synced", square_item_id: "TB7OMMEBELINA2Q3W4E5R6T7Y", printer_profile: "Greys Cheese Label", hot_buttons: true, dcg_locations: ["24755", "28711"] },
  { id: "33333333-3333-4333-8333-333333333333", plu: 2212, name: "FINOCCHIONA", marketing_name: null, category: "Charcuterie", item_kind: "cheese", price: null, price_per_lb: 30, unit_of_measure: "LB",
    barcode: null, dcg_status: "synced", square_status: "synced", square_item_id: "FINOCCHIONA22222222222222", printer_profile: "Charcuterie 2x4", hot_buttons: true, dcg_locations: ["24755"] },
];

const SB_STUB = `(function(){
  var calls = window.__sbCalls = [];
  var S = window.__sb = { items: ${JSON.stringify(ITEMS())}, cards: ['dcc${SQ_OLD.toLowerCase()}'], saved: [] };
  function result(q){
    var has = function(k){ return q.ops.some(function(o){ return o[0] === k; }); };
    var arg = function(k){ var o = q.ops.filter(function(o){ return o[0] === k; })[0]; return o ? o.slice(1) : null; };
    if (q.table === 'cheese_items') return { data: S.items.slice(), error: null };
    if (q.table === 'studio_designs' && has('upsert')) {
      var a = arg('upsert'), row = a[0], opt = a[1] || {};
      var exists = S.cards.indexOf(row.id) >= 0;
      if (exists && opt.ignoreDuplicates) return { data: [], error: null };
      S.cards.push(row.id); S.saved.push({ row: row, opt: opt });
      return { data: [{ id: row.id }], error: null };
    }
    if (q.table === 'studio_designs') {
      var eq = arg('eq');
      if (S.denyDesigns) return { data: null, error: { message: 'permission denied for table studio_designs' } };
      return { data: (eq && eq[0] === 'kind' && eq[1] === 'cheese-card' ? S.cards : []).map(function(id){ return { id: id }; }), error: null };
    }
    return { data: q.single ? null : [], error: null, count: 0 };
  }
  function builder(table){
    var q = { table: table, ops: [] };
    var b = new Proxy({}, { get: function(_, k){
      if (k === 'then') return function(a, r){ return Promise.resolve(result(q)).then(a, r); };
      if (k === 'maybeSingle' || k === 'single') return function(){ q.single = true; return b; };
      return function(){ var args = [].slice.call(arguments); q.ops.push([k].concat(args)); calls.push([table, k].concat(args)); return b; };
    } });
    return b;
  }
  var session = { access_token: 'tok-manager', user: { email: 'manager@greyscheese.com' } };
  var client = {
    auth: { getSession: function(){ return Promise.resolve({ data: { session: session } }); }, onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
      signOut: function(){ return Promise.resolve({}); }, getUser: function(){ return Promise.resolve({ data: { user: session.user } }); } },
    rpc: function(name){ return Promise.resolve({ data: name === 'is_app_admin' ? true : name === 'next_plu' ? 2213 : null, error: null }); },
    from: builder,
    storage: { from: function(){ return builder('storage'); } },
    channel: function(){ var c = { on: function(){ return c; }, subscribe: function(){ return c; } }; return c; }, removeChannel: function(){}
  };
  window.supabase = { createClient: function(){ return client; } };
})();`;

// what the lookup "finds"
const LOOKUP = {
  "LAMB BUSH MANCHEGO MADE IN MEADOWS": { found: true, title: "Lamb Bush", sub: "Made in Meadows", origin: "Spain", milk: "Sheep", treat: "Pasteurized",
    desc: "A young Manchego-style sheep cheese—sweet, buttery and gently grassy with a soft tang.", note: "", sources: ["https://example.com/lamb-bush"] },
  "TOMME BELINA MADE IN MEADOWS": { found: false, title: "Tomme Belina", sub: "Made in Meadows", origin: "", milk: "", treat: "",
    desc: "", note: "couldn't confirm the milk", sources: [] },
};

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const st = { errors: [], fn: [], ai: [], failAi: 0, aiDelay: opts.aiDelay || 300 };
  page.on("pageerror", (e) => st.errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const req = route.request(), u = new URL(req.url());
    const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    const reply = (o, s) => route.fulfill({ status: s || 200, headers: CORS, contentType: "application/json", body: JSON.stringify(o) });
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SB_STUB });
    if (u.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: FONT_CSS });
    if (u.hostname === "fonts.gstatic.com" && u.pathname.startsWith("/__font/")) {
      const [, , pkg, file] = u.pathname.split("/");
      return route.fulfill({ status: 200, headers: CORS, contentType: "font/woff2", body: fs.readFileSync(path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), "files", file)) });
    }
    if (u.pathname === "/functions/v1/cheese-items") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
      const b = JSON.parse(req.postData() || "{}");
      st.fn.push(b);
      if (b.action === "add") {
        const id = "44444444-4444-4444-8444-44444444444" + st.fn.length;
        const it = { id, plu: 2213, name: b.name, marketing_name: b.marketing_name, category: b.category, item_kind: b.item_kind, price: b.price, price_per_lb: b.price_per_lb,
          unit_of_measure: b.unit_of_measure, barcode: null, dcg_status: "synced", square_status: "synced", square_item_id: "LAMBBUSH" + st.fn.length + "XQ2W3E4R5T6Y7U8",
          printer_profile: b.printer_profile, hot_buttons: b.hot_buttons, dcg_locations: b.dcg_locations };
        await page.evaluate((it) => window.__sb.items.unshift(it), it);
        return reply({ item: it });
      }
      return reply({ error: "nope" }, 400);
    }
    if (u.pathname === "/functions/v1/studio-ai") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
      const b = JSON.parse(req.postData() || "{}");
      st.ai.push({ body: b, auth: req.headers()["authorization"] });
      await new Promise((r) => setTimeout(r, st.aiDelay));
      if (st.failAi > 0) { st.failAi--; return reply({ ok: false, error: "The cheese lookup didn't answer. Try again." }, 502); }
      const hit = LOOKUP[b.cheese && b.cheese.name];
      return hit ? reply({ ok: true, data: hit }) : reply({ ok: false, error: "unknown test cheese" }, 400);
    }
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (u.origin === HOST && /^\/studio\/(js|graphics)\//.test(u.pathname)) {
      const f = path.join(REPO, u.pathname);
      if (!f.startsWith(REPO) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: f.endsWith(".svg") ? "image/svg+xml" : "application/javascript", body: fs.readFileSync(f) });
    }
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "{}" });
  });
  await page.goto(HOST + "/manager.html#plu");
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  await page.evaluate(() => mtab("plu"));
  await page.waitForSelector("#pluBody tr td.plu", { timeout: 10000 });
  return { ctx, page, st };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const rowText = (page, name) => page.evaluate((n) => { const r = [...document.querySelectorAll("#pluBody tr")].find((tr) => tr.textContent.includes(n)); return r ? r.textContent.replace(/\s+/g, " ") : ""; }, name);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  console.log("\nmanager.html · Cheese Entry → counter card");
  {
    const { ctx, page, st } = await open(browser, { aiDelay: 700 });
    t("a cheese with a card shows Card ↗ to its Studio design", await page.evaluate((id) => !!document.querySelector('#pluBody a[href="/studio/?from=plu#d-' + id + '"]'), "dcc" + SQ_OLD.toLowerCase()));
    t("a cheese without one offers + Card", /\+ Card/.test(await rowText(page, "TOMME BELINA")));
    t("charcuterie gets no card button", !/Card/.test(await rowText(page, "FINOCCHIONA")), await rowText(page, "FINOCCHIONA"));
    t("the hint says new cheese gets a counter card", /counter card in GREYS Studio/.test(await txt(page, "#pluHint")));

    // ---- save a new cheese ----
    await page.fill("#pf_name", "LAMB BUSH MANCHEGO MADE IN MEADOWS");
    await page.fill("#pf_marketing", "Lamb Bush");
    await page.fill("#pf_ppl", "32");
    await page.click("#pluSubmit");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("pluNotice").textContent), null, { timeout: 8000 });
    t("the cheese saves as before (cheese-items add)", st.fn.length === 1 && st.fn[0].action === "add" && st.fn[0].price_per_lb === 32 && st.fn[0].category === "Cheese", st.fn);
    await page.waitForSelector("#pluCardNote .cn-spin", { timeout: 4000 });
    t("…then says it's making the counter card", /Making the counter card for Lamb Bush/.test(await txt(page, "#pluCardNote")), await txt(page, "#pluCardNote"));
    t("…and its row shows Making card…", /Making card…/.test(await rowText(page, "LAMB BUSH")), await rowText(page, "LAMB BUSH"));
    t("the form is free for the next cheese meanwhile", await page.evaluate(() => !document.getElementById("pluSubmit").disabled && document.getElementById("pf_name").value === ""));
    await page.waitForSelector("#pluCardNote .cn-row.ok", { timeout: 20000 });
    t("studio-ai was asked for a cheese-card with the manager's session", st.ai.length === 1 && st.ai[0].body.kind === "cheese-card" && st.ai[0].body.cheese.name === "LAMB BUSH MANCHEGO MADE IN MEADOWS"
      && st.ai[0].body.cheese.marketing_name === "Lamb Bush" && st.ai[0].auth === "Bearer tok-manager", st.ai);
    const saved = await page.evaluate(() => window.__sb.saved);
    const row = saved[0] && saved[0].row;
    const els = row ? row.pages[0].els : [];
    const texts = els.filter((e) => e.type === "text").map((e) => e.text);
    t("one design saved, id dcc + Square id lowercased, never replacing one", saved.length === 1 && row.id === "dcclambbush1xq2w3e4r5t6y7u8" && saved[0].opt.onConflict === "id" && saved[0].opt.ignoreDuplicates === true, saved.map((s) => [s.row.id, s.opt]));
    t("…a 4×3 in Cheese counter card named Title — Sub", row && row.kind === "cheese-card" && row.w === 384 && row.h === 288 && row.unit === "in" && row.page_count === 1 && row.name === "Lamb Bush — Made in Meadows", row && [row.kind, row.w, row.h, row.unit, row.name]);
    t("…title, gold line, origin line, note and price filled in", texts.includes("Lamb Bush") && texts.includes("Made in Meadows") && texts.includes("Spain  ·  Sheep  ·  Pasteurized")
      && texts.some((x) => /^A young Manchego-style/.test(x)) && texts.includes("$32.00 / lb") && texts.includes("GREYS") && !texts.includes("Comté") && !texts.includes("$00.00 / lb"), texts);
    t("…with the sheep badge", els.some((e) => e.type === "image" && e.src === "/studio/graphics/sheep.svg") && !els.some((e) => e.type === "image" && /cow\.svg$/.test(e.src)));
    t("…a JPEG thumbnail and matching times", row && /^data:image\/jpeg;base64,/.test(row.thumb) && row.thumb.length > 5000 && row.created_at === row.updated_at, row && row.thumb.slice(0, 30));
    t("…and keeps what it was made from on the page", row && row.pages[0].card && row.pages[0].card.milk === "Sheep" && row.pages[0].card.price === "$32.00 / lb" && row.pages[0].card.made_by === "cheese-entry" && row.pages[0].card.found === true, row && row.pages[0].card);
    t("the note shows the card with a link into Studio", /Counter card ready: Lamb Bush — Made in Meadows/.test(await txt(page, "#pluCardNote")) && /Spain · Sheep · Pasteurized/.test(await txt(page, "#pluCardNote"))
      && await page.evaluate(() => !!document.querySelector('#pluCardNote a[href="/studio/?from=plu#d-dcclambbush1xq2w3e4r5t6y7u8"][target="_blank"]') && /^data:image\/jpeg/.test(document.querySelector("#pluCardNote img.cn-thumb").src)), await txt(page, "#pluCardNote"));
    t("the row now has Card ↗", /Card ↗/.test(await rowText(page, "LAMB BUSH")));
    const fit = await page.evaluate(() => {
      const fonts = window.GS.Cards.FACES.map((f) => document.fonts.check(f, "Aa"));
      return { fonts, title: window.__sb.saved[0].row.pages[0].els.find((e) => e.text === "Lamb Bush").size };
    });
    t("brand fonts were really loaded before the text was fitted", fit.fonts.every(Boolean) && fit.title >= 28, fit);
    if (process.env.SHOTS) {
      const png = await page.evaluate(async () => { const r = window.__sb.saved[0].row; const d = { id: r.id, name: r.name, w: r.w, h: r.h, unit: r.unit, kind: r.kind, pages: r.pages }; await window.GS.Cards.prep(d); return window.GS.Cards.png(d, 3.125); });
      fs.writeFileSync(path.join(process.env.SHOTS, "lamb-bush-card.png"), Buffer.from(png.split(",")[1], "base64"));
      await page.screenshot({ path: path.join(process.env.SHOTS, "cheese-entry-card.png"), clip: { x: 0, y: 0, width: 1360, height: 900 } });
    }

    // ---- + Card on an older cheese: a failed lookup, then Try again, with an edit open meanwhile ----
    st.failAi = 1; st.aiDelay = 600;
    await page.click('#pluBody button[data-card="22222222-2222-4222-8222-222222222222"]');
    await page.waitForTimeout(100);
    await page.click('#pluBody button[data-edit="11111111-1111-4111-8111-111111111111"]');
    await page.fill("#pe_marketing", "half-typed edit");
    await page.waitForSelector("#pluCardNote .cn-row.err", { timeout: 8000 });
    t("a failed lookup says so, with Try again", /Couldn't make the counter card for Tomme Belina: The cheese lookup didn't answer/.test(await txt(page, "#pluCardNote")) && (await page.locator('#pluCardNote button[data-card]').count()) === 1, await txt(page, "#pluCardNote"));
    t("…and didn't wipe the row someone is editing", (await page.inputValue("#pe_marketing")) === "half-typed edit");
    await page.click('#pluBody button[data-cancel]');
    await page.click('#pluCardNote button[data-card]');
    await page.waitForSelector("#pluCardNote .cn-row.ok:first-child", { timeout: 8000 });
    const tb = await page.evaluate(() => window.__sb.saved.find((s) => s.row.id === "dcctb7ommebelina2q3w4e5r6t7y"));
    const tbEls = tb ? tb.row.pages[0].els : [];
    t("Try again makes the card", !!tb && tbEls.some((e) => e.text === "$24.00 / lb"), tb && tb.row.id);
    t("…unknown milk keeps the gold cheese wheel, no animal", tbEls.some((e) => e.type === "icon" && e.icon === "wheel") && !tbEls.some((e) => e.type === "image" && /graphics\/(cow|goat|sheep)\.svg$/.test(e.src)));
    t("…and asks staff to check a cheese it couldn't find", /Couldn't find this exact cheese online — check the card\. couldn't confirm the milk/.test(await txt(page, "#pluCardNote .cn-row")), await txt(page, "#pluCardNote .cn-row"));
    t("the note keeps the last few cards, newest first", (await page.locator("#pluCardNote .cn-row").count()) === 2 && /Tomme Belina/.test(await txt(page, "#pluCardNote .cn-row:first-child")));

    // ---- wine / retail and non-cheese categories don't make cards ----
    const before = st.ai.length;
    await page.click('#pluKindSwitch button[data-kind="retail"]');
    await page.fill("#pf_name", "Cordoni Sangiovese");
    await page.fill("#pf_price", "27");
    await page.selectOption("#pf_category", "Retail Wine");
    await page.click("#pluSubmit");
    await page.waitForFunction((n) => (window.__sbCalls || []).length > 0 && /Saved Cordoni/.test(document.getElementById("pluNotice").textContent), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    t("a retail wine saves without a card", st.ai.length === before && !/Cordoni/.test(await txt(page, "#pluCardNote")));
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  {
    // an account that can't read studio_designs: no card buttons, saving doesn't try
    const { ctx, page, st } = await open(browser, {});
    await page.evaluate(() => { window.__sb.denyDesigns = true; return window.pluInit(); });
    await page.waitForTimeout(300);
    t("no Studio access: no card buttons", (await page.locator("#pluBody [data-card], #pluBody a[href^='/studio/']").count()) === 0);
    await page.fill("#pf_name", "LAMB BUSH MANCHEGO MADE IN MEADOWS"); await page.fill("#pf_ppl", "32");
    await page.click("#pluSubmit");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("pluNotice").textContent), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    t("…and saving doesn't call the lookup", st.ai.length === 0 && (await txt(page, "#pluCardNote")) === "");
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { viewport: { width: 390, height: 844 }, aiDelay: 200 });
    await page.fill("#pf_name", "LAMB BUSH MANCHEGO MADE IN MEADOWS"); await page.fill("#pf_marketing", "Lamb Bush"); await page.fill("#pf_ppl", "32");
    await page.click("#pluSubmit");
    await page.waitForSelector("#pluCardNote .cn-row.ok", { timeout: 20000 });
    const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    t("phone: the card note fits", fit.sw <= fit.w + 1, fit);
    if (process.env.SHOTS) { await page.evaluate(() => document.getElementById("pluCardNote").scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.SHOTS, "cheese-entry-card-phone.png") }); }
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3));
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
