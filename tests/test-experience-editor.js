/*
 * ✨ Experiences → Edit in manager.html (2026-11-14, Jackie's list): "Guests come in steps of" (Fondue 2 → 2, 4, 6, 8),
 * "per N guests" charged by the guest ($350 for 6 → $408.33 for 7 → $700 for 12), and "Add-ons guests can tick"
 * (chocolate fondue $12.95 per guest). Also the bookings list shows a booking's add-ons.
 * The page is served under the staging host; Supabase is stubbed (rows in, saves captured), React / ReactDOM / Babel
 * come from local copies — nothing goes to the network.
 * Run: NODE_PATH=$(npm root -g) REACT_DIR=<dir with react/ + react-dom/ umd builds> BABEL_JS=<babel.min.js> node tests/test-experience-editor.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const HOST = "https://greys-staff-portal-staging.onrender.com";
const MANAGER = fs.readFileSync(path.join(__dirname, "..", "manager.html"));
const REACT_DIR = process.env.REACT_DIR || path.join(__dirname, "..", "node_modules");
const REACT = fs.readFileSync(path.join(REACT_DIR, "react", "umd", "react.production.min.js"));
const REACT_DOM = fs.readFileSync(path.join(REACT_DIR, "react-dom", "umd", "react-dom.production.min.js"));
const BABEL = fs.readFileSync(process.env.BABEL_JS || path.join(__dirname, "..", "node_modules", "@babel", "standalone", "babel.min.js"));
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); } };

const CHOC = [{ key: "chocolate_fondue", label: "Chocolate fondue", price_cents: 1295, per: "guest" }];
const ROWS = [
  { id: "340f39c7-fcda-41a8-9aaa-841c973a2872", name: "Raclette", description: "Raclette.", price_cents: 35000, per_person: false, price_unit_guests: 6, options: null,
    min_party: 6, max_party: 12, party_step: 1, duration_min: 120, tables_needed: 2, lead_time_min: 10080, active: true, sort_order: 1, image_url: null,
    bookable: true, info_url: null, price_label: "$350 for 6 guests · $58.33 per extra guest · up to 12", includes: [], addons: CHOC, at_home: false },
  { id: "d3271965-6fa9-4951-b705-89ce01fb5ce4", name: "Fondue", description: "Fondue.", price_cents: 12500, per_person: false, price_unit_guests: 2, options: null,
    min_party: 2, max_party: 8, party_step: 2, duration_min: 120, tables_needed: 2, lead_time_min: 10080, active: true, sort_order: 2, image_url: null,
    bookable: true, info_url: null, price_label: "$125 per 2 guests · 2, 4, 6 or 8 guests", includes: [], addons: CHOC, at_home: false },
];
const BOOKINGS = [
  { id: "r1", code: "AB12CD", guest_name: "Ada Lovelace", email: "ada@example.com", phone: "9015550142", party_size: 7, starts_at: "2026-12-05T00:00:00Z",
    ends_at: "2026-12-05T02:00:00Z", status: "confirmed", payment_status: "paid", total_cents: 49898, paid_cents: 64743, gratuity_cents: 9980, tax_cents: 4865,
    refunded_cents: 0, notes: "", hold_expires_at: null, inquiry_id: null, external_id: "square:x", created_at: "2026-11-14T00:00:00Z", cancel_reason: null,
    experience_type_id: ROWS[0].id, addons_cents: 9065, addons: [{ key: "chocolate_fondue", label: "Chocolate fondue", qty: 7, per: "guest", price_cents: 1295, total_cents: 9065 }],
    rb_experience_types: { name: "Raclette" } },
];
const SB_STUB = `(function(){
  var saves = window.__saves = [];
  var ROWS = ${JSON.stringify(ROWS)}, BOOKINGS = ${JSON.stringify(BOOKINGS)};
  function builder(table){
    var q = { table: table, ops: [] };
    var res = function(){
      var w = q.ops.filter(function(o){ return o[0] === 'update' || o[0] === 'insert' || o[0] === 'upsert'; })[0];
      if (w) { saves.push({ table: table, op: w[0], row: w[1], ops: q.ops }); return { data: null, error: null }; }
      if (table === 'rb_experience_types') return { data: q.single ? ROWS[0] : ROWS, error: null };
      if (table === 'rb_reservations' && JSON.stringify(q.ops).indexOf('addons') >= 0) return { data: BOOKINGS, error: null };
      return { data: q.single ? null : [], error: null, count: 0 };
    };
    var b = new Proxy({}, { get: function(_, k){
      if (k === 'then') return function(a, r){ return Promise.resolve(res()).then(a, r); };
      if (k === 'maybeSingle' || k === 'single') return function(){ q.single = true; return b; };
      return function(){ var args = [].slice.call(arguments); q.ops.push([k].concat(args)); return b; };
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

async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const st = { errors: [] };
  page.on("pageerror", (e) => st.errors.push(String(e)));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const js = (body) => route.fulfill({ status: 200, contentType: "application/javascript", body });
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return js(SB_STUB);
    if (/react-dom/.test(u.pathname) && /\.js$/.test(u.pathname)) return js(REACT_DOM);
    if (/\/react\/|react\.production/.test(u.pathname) && /\.js$/.test(u.pathname)) return js(REACT);
    if (/babel/.test(u.pathname) && /\.js$/.test(u.pathname)) return js(BABEL);
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return js("");
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
  });
  await page.goto(HOST + "/manager.html");
  return { ctx, page, st };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const inputAfter = (page, label) => page.evaluateHandle((l) => {
  const lab = [...document.querySelectorAll("#tk-root label.cc-label")].find((x) => x.textContent.trim().startsWith(l));
  let n = lab && lab.nextElementSibling;
  while (n && !/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) n = n.nextElementSibling;
  return n;
}, label);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  console.log("\nmanager.html · ✨ Experiences → Edit");
  {
    const { ctx, page, st } = await open(browser);
    await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
    await page.evaluate(() => tkTab(document.querySelector('.tab[onclick*="\'experiences\'"]'), "experiences"));
    await page.waitForFunction(() => /Fondue/.test((document.getElementById("tk-root") || {}).textContent || ""), null, { timeout: 15000 });
    t("the list loads", /Raclette/.test(await txt(page, "#tk-root")) && /Fondue/.test(await txt(page, "#tk-root")), await txt(page, "#tk-root"));

    // Fondue: steps of 2, chocolate fondue, by-the-guest wording
    await page.locator("#tk-root .cc-tr", { hasText: "Fondue" }).locator("button", { hasText: "Edit" }).click();
    await page.waitForFunction(() => /Guests come in steps of/.test(document.getElementById("tk-root").textContent), null, { timeout: 8000 });
    const stepVal = await (await inputAfter(page, "Guests come in steps of")).evaluate((e) => e && e.value);
    t("Fondue: Guests come in steps of 2", stepVal === "2", stepVal);
    const root = await txt(page, "#tk-root");
    t("Fondue: says guests can book 2, 4, 6 or 8 guests", /Guests can book 2, 4, 6 or 8 guests\./.test(root), root.slice(0, 400));
    t("Fondue: priced by the guest — $125 for every 2, $62.50 each; 2 pay $125, 4 pay $250, 8 pay $500",
      /\$125 for every 2 guests, charged by the guest \(\$62\.50 each\): 2 guests pay \$125, 4 pay \$250, 8 pay \$500\./.test(root), root.match(/\$125 for every[^.]*\./));
    const add = await page.evaluate(() => {
      const lab = [...document.querySelectorAll("#tk-root label.cc-label")].find((x) => /^Add-ons guests can tick/.test(x.textContent.trim()));
      let n = lab, rows = [];
      while (n && (n = n.nextElementSibling)) { if (n.tagName === "BUTTON") break; if (n.tagName === "DIV") rows.push([...n.querySelectorAll("input,select")].map((i) => i.value)); }
      return rows;
    });
    t("Fondue: the add-on row — Chocolate fondue, 12.95, per guest", JSON.stringify(add) === JSON.stringify([["Chocolate fondue", "12.95", "guest"]]), add);
    const sug = await page.$eval("#tk-root input[placeholder^='$125']", (i) => i.placeholder).catch(() => "");
    t("suggested price line: $125 per 2 guests · 2, 4, 6 or 8 guests", sug === "$125 per 2 guests · 2, 4, 6 or 8 guests", sug);
    await page.locator("#tk-root button", { hasText: "Save changes" }).click();
    await page.waitForFunction(() => (window.__saves || []).length > 0, null, { timeout: 8000 }).catch(() => {});
    const sv = await page.evaluate(() => window.__saves[0] || null);
    t("Save sends party_step 2 and the add-on as stored", !!sv && sv.table === "rb_experience_types" && sv.op === "update" && sv.row.party_step === 2 &&
      JSON.stringify(sv.row.addons) === JSON.stringify(CHOC) && sv.row.price_unit_guests === 2 && sv.row.price_cents === 12500 && sv.row.max_party === 8 &&
      JSON.stringify(sv.ops.find((o) => o[0] === "eq")) === JSON.stringify(["eq", "id", ROWS[1].id]), sv && sv.row);

    // Raclette: $350 for 6 → $408.33 for 7 → $700 for 12; untick nothing; a second add-on per party; a bad step refused
    await page.waitForFunction(() => /Raclette/.test(document.getElementById("tk-root").textContent) && /Edit/.test(document.getElementById("tk-root").textContent), null, { timeout: 8000 });
    await page.locator("#tk-root .cc-tr", { hasText: "Raclette" }).locator("button", { hasText: "Edit" }).click();
    await page.waitForFunction(() => /Guests come in steps of/.test(document.getElementById("tk-root").textContent), null, { timeout: 8000 });
    const r2 = await txt(page, "#tk-root");
    t("Raclette: $350 for every 6 guests, by the guest ($58.33 each): 6 pay $350, 7 pay $408.33, 12 pay $700",
      /\$350 for every 6 guests, charged by the guest \(\$58\.33 each\): 6 guests pay \$350, 7 pay \$408\.33, 12 pay \$700\./.test(r2), r2.match(/\$350 for every[^.]*\.[^.]*\./));
    await page.locator("#tk-root button", { hasText: "＋ Add an add-on" }).click();
    const rowsAdd = page.locator("#tk-root input[placeholder='e.g. Chocolate fondue']");
    await rowsAdd.nth(1).fill("Champagne toast");
    await page.locator("#tk-root input[placeholder='$']").last().fill("25");
    await page.locator("#tk-root select").filter({ has: page.locator("option[value='party']") }).last().selectOption("party");
    const stepIn = await inputAfter(page, "Guests come in steps of");
    await stepIn.asElement().fill("0");
    await page.locator("#tk-root button", { hasText: "Save changes" }).click();
    t("a step of 0 is refused, nothing saved", /Guests come in steps of 1 to 12/.test(await txt(page, "#tk-root .cc-err")) && (await page.evaluate(() => window.__saves.length)) === 1, await txt(page, "#tk-root .cc-err"));
    await stepIn.asElement().fill("1");
    await page.locator("#tk-root button", { hasText: "Save changes" }).click();
    await page.waitForFunction(() => (window.__saves || []).length > 1, null, { timeout: 8000 }).catch(() => {});
    const sv2 = await page.evaluate(() => window.__saves[1] || null);
    t("Save: two add-ons, the new one keyed from its name, per party", !!sv2 && JSON.stringify(sv2.row.addons) === JSON.stringify([CHOC[0],
      { key: "champagne_toast", label: "Champagne toast", price_cents: 2500, per: "party" }]) && sv2.row.party_step === 1, sv2 && sv2.row.addons);

    // the bookings list shows what a booking took
    await page.waitForFunction(() => /Raclette/.test(document.getElementById("tk-root").textContent), null, { timeout: 8000 });
    await page.evaluate(() => tkTab(document.querySelector('.tab[onclick*="\'expbookings\'"]'), "expbookings"));
    await page.waitForFunction(() => /Ada Lovelace/.test(document.getElementById("tk-root").textContent), null, { timeout: 8000 }).catch(() => {});
    const bk = await txt(page, "#tk-root");
    t("Bookings: ➕ Chocolate fondue × 7 ($90.65) and what the card paid", /➕ Chocolate fondue × 7 \(\$90\.65\)/.test(bk) && /\$647\.43/.test(bk), bk.slice(0, 600));
    t("no page errors", st.errors.length === 0, st.errors);
    await ctx.close();
  }
  await browser.close();
  console.log("\n" + ok + " passed, " + bad + " failed");
  process.exit(bad ? 1 : 0);
})();
