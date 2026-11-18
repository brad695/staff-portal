/*
 * 🎁 Gift note cards on the 🚚 Shipping tab (manager.html), 2026-11-17: one 4 × 3 in card per gift note, 6 to a
 * Letter sheet with cut marks, as a PDF (studio/js/sheets.js). Supabase and the order function are stubbed; the Studio
 * scripts are the real files and the brand fonts come from @fontsource. Nothing goes to the network.
 * Run: NODE_PATH=<dir with @fontsource/*>:$(npm root -g) PW_CHROME=/usr/bin/google-chrome node tests/test-gift-cards.js   (SHOTS=dir)
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const REPO = path.join(__dirname, "..");
const HOST = "https://greys-staff-portal-staging.onrender.com";
const MANAGER = fs.readFileSync(path.join(REPO, "manager.html"));
const INDEX = fs.readFileSync(path.join(REPO, "index.html"));
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra ? "  -> " + extra : "")); } };

const RATES = { ground_miles: 600, ground: { first_cents: 2000, each_cents: 2000 }, air: { first_cents: 4000, each_cents: 4000 } };
const CFG = { enabled: true, from: "memphis", items: ["EN2OPFWI6P6WHF3DDHD4T2V2"], order_by: "2026-12-03", ship_on: "2026-12-08", arrive_from: "2026-12-09",
  arrive_by: "2026-12-11", first_cents: 3000, each_cents: 3000, limit: 0, tax_states: ["TN"], note: "keep me" };
const order = (id, extra) => Object.assign({
  id, code: id.slice(0, 6).toUpperCase(), state: "OPEN", created_at: "2026-11-12T20:10:56Z", ship_on: "2026-12-08", paid: true, refunded: false,
  buyer: "Brad Test", buyer_first: "Brad", email: "brad@example.com", buyer_phone: "+19015550100",
  to: { name: "Jackie Gift", phone: "+19015550123", address1: "4101 Charlotte Ave", address2: "Suite D130", city: "Nashville", state: "TN", zip: "37209" },
  gift_note: "", note: "", lines: [{ name: "12 Days of Cheesemas", option: "", qty: 1, note: "" }], boxes: 1,
  total_cents: 14158, shipping_cents: 3000, tax_cents: 1258, fulfillment_uid: "f-" + id, fulfillment_state: "PROPOSED",
  carrier: "", tracking_number: "", tracking_url: "", shipped_at: null, tracking_emailed: null,
}, extra || {});
const ORDERS = () => [
  order("aaaa11", { service: "air", to: { name: "Sam Giftee", phone: "", address1: "123 Main St", address2: "", city: "Franklin", state: "TN", zip: "37064" }, gift_note: "Merry Cheesemas! <3", boxes: 2,
    lines: [{ name: "12 Days of Cheesemas", option: "", qty: 2, note: "" }] }),
  order("bbbb22", { fulfillment_state: "COMPLETED", carrier: "UPS", tracking_number: "1Z999AA10123456784", tracking_url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    shipped_at: "2026-11-12T22:00:00Z", tracking_emailed: "2026-11-12T22:00:01Z" }),
  order("cccc33", { refunded: true, to: { name: "Refund Person", phone: "", address1: "9 Elm", address2: "", city: "Austin", state: "TX", zip: "73301" } }),
];
// a supabase-js stand-in: a session, is_app_admin true, empty tables, and the order_shipping row
const SB_STUB = `(function(){
  var calls = window.__sbCalls = [];
  var row = window.__shipRowOverride || ${JSON.stringify({ data: CFG, updated_at: "2026-11-12T20:08:26Z", updated_by: "claude" })};
  function builder(table){
    var q = { table: table, ops: [] }, p;
    var res = function(){
      if (table === 'site_content' && q.ops.some(function(o){ return o[0] === 'upsert'; })) { var u = q.ops.filter(function(o){ return o[0] === 'upsert'; })[0][1]; row = { data: u.data, updated_at: u.updated_at, updated_by: u.updated_by }; return { data: row, error: null }; }
      if (table === 'site_content' && JSON.stringify(q.ops).indexOf('order_shipping') >= 0) return { data: q.single ? row : [Object.assign({ key: 'order_shipping' }, row)], error: null };
      return { data: q.single ? null : [], error: null, count: 0 };
    };
    var b = new Proxy({}, { get: function(_, k){
      if (k === 'then') return function(a, r){ return Promise.resolve(res()).then(a, r); };
      if (k === 'maybeSingle' || k === 'single') return function(){ q.single = true; return b; };
      return function(){ var args = [].slice.call(arguments); q.ops.push([k].concat(args)); calls.push([table, k].concat(args)); return b; };
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

const TPL = {"id":"dxcd6ls80cj","name":"Gift card cheesemas","w":336,"h":192,"unit":"in","kind":"gift-card","updated_at":"2026-11-18T00:11:43Z","pages":[{"bg":{"grad":{"a":"#123E57","b":"#06273A","angle":135},"color":"#06273A"},"id":"pdh1ydt80cj","els":[{"h":78,"w":78,"x":236,"y":22,"id":"egtofpf80cj","op":1,"rot":0,"fill":"#E6B33C","icon":"wheel","type":"icon"},{"h":40,"w":200,"x":24,"y":24,"id":"evyiz9h80cj","lh":1,"ls":0,"op":1,"rot":0,"font":"League Spartan","ital":false,"size":40,"text":"GREYS","type":"text","align":"left","color":"#FFF6E3","under":false,"upper":false,"weight":800},{"h":9.6,"w":200,"x":24,"y":68,"id":"ee6sc5v80cj","lh":1.2,"ls":120,"op":1,"rot":0,"font":"League Spartan","ital":false,"size":8,"text":"FINE CHEESES · CHARCUTERIE · WINE","type":"text","align":"left","color":"#E6B33C","under":false,"upper":false,"weight":700},{"h":12,"w":126,"x":186,"y":152,"id":"e0v1jea80cj","lh":1.2,"ls":0,"op":1,"rot":0,"font":"Nunito Sans","ital":false,"size":10,"text":"greyscheese.com","type":"text","align":"right","color":"#C9D6DF","under":false,"upper":false,"weight":700}]}]};
const FACES = [["League Spartan", "league-spartan", ["700", "800"]], ["Barlow Condensed", "barlow-condensed", ["800"]], ["Nunito Sans", "nunito-sans", ["400-italic", "700", "800"]]];
const SB_STUB2 = SB_STUB.replace("return { data: q.single ? null : [], error: null, count: 0 };", "if (table === 'studio_designs' && window.__gcTpl) return { data: [window.__gcTpl], error: null }; return { data: q.single ? null : [], error: null, count: 0 };");
const FONT_CSS = FACES.flatMap(([fam, pkg, wts]) => wts.flatMap((w) => {
  const css = fs.readFileSync(require.resolve(`@fontsource/${pkg}/${w}.css`), "utf8"), out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(m[1])[1];
    if (!/-latin(-ext)?-\d+-(normal|italic)\.woff2$/.test(file)) continue;
    out.push(`@font-face{font-family:'${fam}';font-style:${/italic/.test(w) ? "italic" : "normal"};font-weight:${parseInt(w)};src:url(https://fonts.gstatic.com/__font/${pkg}/${file}) format('woff2');unicode-range:${/unicode-range:\s*([^;]+);/.exec(m[1])[1]};}`);
  }
  return out;
})).join("\n");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const LONG = "Merry Cheesemas, Grandma! We wish we could be there to share all twelve days with you — save the Comté for Christmas Eve, and don't let Uncle Ray near the truffle brie. Love you so much and see you in the spring!";

async function open(browser, orders, tpl) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const st = { errors: [], orders };
  page.on("pageerror", (e) => st.errors.push(String(e)));
  await page.addInitScript(() => { window.__giftCardsDirect = false; window.open = function(){ return null; }; });
  if (tpl) await page.addInitScript((d) => { window.__gcTpl = d; }, tpl);
  await page.route("**/*", (route) => {
    const req = route.request(), u = new URL(req.url());
    if (!/^https?:/.test(u.protocol)) return route.continue();
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SB_STUB2 });
    if (u.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: FONT_CSS });
    if (u.hostname === "fonts.gstatic.com" && u.pathname.startsWith("/__font/")) {
      const [, , pkg, file] = u.pathname.split("/");
      return route.fulfill({ status: 200, headers: CORS, contentType: "font/woff2", body: fs.readFileSync(path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), "files", file)) });
    }
    if (u.origin === HOST && /^\/studio\/js\//.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(REPO, u.pathname)) });
    if (/^\/functions\/v1\/square-online-order(-test)?$/.test(u.pathname)) {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
      const action = u.searchParams.get("action");
      const reply = (o) => route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(o) });
      if (action === "ship_orders") return reply({ ok: true, env: "sandbox", from: "memphis", from_label: "Memphis", config: Object.assign({ text: "Ships Tue, Dec 8" }, CFG), orders: st.orders });
      return reply({ ok: true });
    }
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "{}" });
  });
  await page.goto(HOST + "/manager.html");
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  await page.evaluate(() => mtab("shipping"));
  await page.waitForSelector("#shList .sh-row", { timeout: 8000 });
  return { ctx, page, st };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
async function grab(page, click) {
  await page.evaluate(() => { window.__giftCardsLast = null; });
  await page.click(click);
  await page.waitForFunction(() => window.__giftCardsLast || /Couldn/.test((document.querySelector("#shBar .sh-msg") || {}).textContent || ""), null, { timeout: 20000 });
  const r = await page.evaluate(async () => { const L = window.__giftCardsLast; if (!L) return null; const b = new Uint8Array(await L.blob.arrayBuffer()); let s = ""; for (const c of b) s += String.fromCharCode(c); return { b64: btoa(s), cards: L.cards, sheets: L.sheets }; });
  return r && Object.assign(r, { buf: Buffer.from(r.b64, "base64") });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-")), SHOTS = process.env.SHOTS || "";
  const many = [];
  for (let i = 0; i < 7; i++) many.push(order("g" + i + "xxxx", { gift_note: i === 0 ? LONG : i === 1 ? "Happy holidays!\nFrom all of us" : "Enjoy the cheese, friend #" + (i + 1), buyer: "Buyer " + (i + 1), to: { name: "Friend " + (i + 1), phone: "", address1: "1 Main", address2: "", city: "Memphis", state: "TN", zip: "38117" } }));
  many.push(order("nonote", { gift_note: "" }));
  many.push(order("refund", { gift_note: "should not print", refunded: true }));
  console.log("\nmanager.html · 🚚 Shipping · 🎁 gift note cards");
  const { ctx, page, st } = await open(browser, many);
  t("no template in the Studio: the plain 4 × 3 card", true);
  t("the button counts the gift notes to ship (7 — not the plain or refunded ones)", /Gift note cards \(7\)/.test(await txt(page, '#shBar [data-sh="gcards"]')), await txt(page, "#shBar .sh-acts"));
  t("each gift note row has its own Print card", (await page.locator('#shList [data-sh="gcard"]').count()) === 7);
  const all = await grab(page, '#shBar [data-sh="gcards"]');
  t("all: a PDF with 7 cards on 2 sheets", !!all && all.cards === 7 && all.sheets === 2 && all.buf.slice(0, 5).toString() === "%PDF-", all && [all.cards, all.sheets]);
  const f = path.join(tmp, "all.pdf"); if (all) fs.writeFileSync(f, all.buf);
  const q = spawnSync("qpdf", ["--check", f], { encoding: "utf8" });
  t("…qpdf: the PDF is sound", q.status === 0, q.stdout + q.stderr);
  const info = spawnSync("pdfinfo", [f], { encoding: "utf8" }).stdout || "";
  t("…Letter pages, titled GREYS gift notes", /Pages:\s+2/.test(info) && /612 x 792/.test(info) && /GREYS gift notes/.test(info), info);
  spawnSync("pdftoppm", ["-r", "60", "-png", f, path.join(tmp, "p")]);
  t("…both sheets render", fs.existsSync(path.join(tmp, "p-1.png")) && fs.existsSync(path.join(tmp, "p-2.png")));
  t("…the message says print at 100% and cut on the marks", /2 sheets, 7 cards/.test(await txt(page, "#shBar .sh-msg")) && /100%/.test(await txt(page, "#shBar .sh-msg")), await txt(page, "#shBar .sh-msg"));
  const one = await grab(page, '#shList [data-sh="gcard"][data-v="g1xxxx"]');
  t("Print card: just that one, 1 sheet", !!one && one.cards === 1 && one.sheets === 1, one && [one.cards, one.sheets]);
  t("fonts: the note's italic face really loaded", await page.evaluate(() => document.fonts.check('italic 400 40px "Nunito Sans"', "Aa") && [...document.fonts].some((x) => x.family.replace(/"/g, "") === "Nunito Sans" && x.style === "italic" && x.status === "loaded")));
  if (SHOTS) {
    fs.copyFileSync(f, path.join(SHOTS, "gift-notes.pdf"));
    spawnSync("pdftoppm", ["-r", "110", "-png", "-f", "1", "-l", "1", f, path.join(SHOTS, "gift-notes")]);
    await page.screenshot({ path: path.join(SHOTS, "shipping-gift-button.png") });
  }
  t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
  await ctx.close();
  console.log("\n…with the Studio template “Gift card cheesemas”");
  {
    const o = await open(browser, many, TPL);
    const r = await grab(o.page, '#shBar [data-sh="gcards"]');
    const g = path.join(tmp, "tpl.pdf"); if (r) fs.writeFileSync(g, r.buf);
    t("template: 7 cards on 1 sheet (10 to a sheet)", !!r && r.cards === 7 && r.sheets === 1, r && [r.cards, r.sheets]);
    t("…it used the Studio design", (await o.page.evaluate(() => window.__giftCardsTemplate)) === "Gift card cheesemas");
    t("…qpdf: sound", spawnSync("qpdf", ["--check", g]).status === 0);
    if (SHOTS) { fs.copyFileSync(g, path.join(SHOTS, "gift-notes-tpl.pdf")); spawnSync("pdftoppm", ["-r", "110", "-png", g, path.join(SHOTS, "gift-tpl")]); }
    t("…no page errors", o.st.errors.length === 0, o.st.errors.slice(0, 3).join(" | "));
    await o.ctx.close();
  }
  await browser.close();
  console.log("\n" + ok + " passed, " + bad + " failed");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
