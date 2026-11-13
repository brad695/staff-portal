/*
 * The 🚚 Shipping tab in manager.html and the ship day on the portal calendar (index.html), 2026-11-12.
 * Pages are served under the staging host (so they call square-online-order-test); Supabase, the order function
 * and the CDNs are stubbed — nothing goes to the network.
 * Run: NODE_PATH=$(npm root -g) node tests/test-shipping-tab.js     (SHOTS=dir for screenshots)
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const HOST = "https://greys-staff-portal-staging.onrender.com";
const MANAGER = fs.readFileSync(path.join(__dirname, "..", "manager.html"));
const INDEX = fs.readFileSync(path.join(__dirname, "..", "index.html"));
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra ? "  -> " + extra : "")); } };

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
  order("aaaa11", { to: { name: "Sam Giftee", phone: "", address1: "123 Main St", address2: "", city: "Franklin", state: "TN", zip: "37064" }, gift_note: "Merry Cheesemas! <3", boxes: 2,
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

async function open(browser, file, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const st = { errors: [], calls: [], orders: ORDERS() };
  const H = opts.host || HOST;
  if (opts.row) await page.addInitScript((r) => { window.__shipRowOverride = r; }, { data: opts.row, updated_at: "2026-11-13T23:00:00Z", updated_by: "claude" });
  page.on("pageerror", (e) => st.errors.push(String(e)));
  await page.route("**/*", (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SB_STUB });
    if (/^\/functions\/v1\/square-online-order(-test)?$/.test(u.pathname)) {
      const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
      const action = u.searchParams.get("action"), b = JSON.parse(req.postData() || "{}");
      st.calls.push({ action, fn: u.pathname.split("/").pop(), body: b, auth: req.headers()["authorization"] });
      const reply = (o, s) => route.fulfill({ status: s || 200, headers: CORS, contentType: "application/json", body: JSON.stringify(o) });
      if (action === "ship_orders") return reply({ ok: true, env: "sandbox", from: "memphis", from_label: "Memphis", config: Object.assign({ text: "Ships Tue, Dec 8 · arrives Dec 9–11" }, CFG), orders: st.orders });
      if (action === "ship_mark") {
        const o = st.orders.find((x) => x.id === b.order_id);
        Object.assign(o, { fulfillment_state: "COMPLETED", carrier: b.carrier, tracking_number: b.tracking_number, tracking_url: "https://www.ups.com/track?tracknum=" + b.tracking_number, shipped_at: new Date().toISOString(), tracking_emailed: new Date().toISOString() });
        return reply({ ok: true, env: "sandbox", saved_in_square: true, square_error: null, email_sent: true, order: o });
      }
      if (action === "ship_email") { const o = st.orders.find((x) => x.id === b.order_id); o.tracking_emailed = new Date().toISOString(); return reply({ ok: true, email_sent: true, order: o }); }
      if (action === "menu") return reply({ ok: true, sections: [{ id: "special", name: "Special Offers", items: ["EN2OPFWI6P6WHF3DDHD4T2V2", "FALL1"] }, { id: "sandwiches", name: "Sandwiches", items: ["ITAL"] }],
        items: { EN2OPFWI6P6WHF3DDHD4T2V2: { name: "12 Days of Cheesemas", vars: [{ price: 9900 }] }, FALL1: { name: "Fall Gooeys", vars: [{ price: 4500 }] }, ITAL: { name: "Italian", vars: [{ price: 1600 }] } } });
      if (action === "ship_days") return reply({ ok: true, env: "sandbox", from: "memphis", from_label: "Memphis", ship_on: "2026-12-08", days: [{ date: "2026-12-08", orders: 2, boxes: 3, shipped: 1 }] });
      return reply({ ok: false, error: "nope" }, 400);
    }
    if (/square-orders$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, orders: [] }) });
    if (u.origin === H && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (u.origin === H && (u.pathname === "/" || u.pathname === "/index.html")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: INDEX });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
  });
  await page.goto(H + file);
  return { ctx, page, st };
}
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  console.log("\nmanager.html · 🚚 Shipping");
  {
    const { ctx, page, st } = await open(browser, "/manager.html");
    await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    t("signed in: the tab shows the boxes to ship (2)", (await txt(page, "#shTabPill")) === "2" && await page.evaluate(() => document.getElementById("shTabPill").classList.contains("show")), await txt(page, "#shTabPill"));
    await page.evaluate(() => mtab("shipping"));
    await page.waitForSelector("#shList .sh-row", { timeout: 8000 });
    await page.waitForTimeout(400);
    t("it calls the sandbox copy with the manager's session", st.calls.length > 0 && st.calls.every((c) => c.fn === "square-online-order-test") && st.calls.some((c) => c.action === "ship_orders" && c.auth === "Bearer tok-manager"),
      JSON.stringify(st.calls.map((c) => c.fn + ":" + c.action + ":" + c.auth)));
    t("test orders are flagged", await page.evaluate(() => !document.getElementById("shEnv").hidden));
    t("summary: ships Tue, Dec 8 · 2 orders · 3 boxes · 1 shipped", /Ships Tue, Dec 8 from Memphis · 2 orders · 3 boxes · 1 shipped/.test(await txt(page, "#shBar .sh-sum")), await txt(page, "#shBar .sh-sum"));
    t("To ship shows the one not shipped", await page.locator("#shList .sh-row").count() === 1 && /Sam Giftee/.test(await txt(page, "#shList")), await txt(page, "#shList"));
    t("…with its address, boxes and gift note (escaped)", /123 Main St/.test(await txt(page, "#shList")) && /2× 12 Days of Cheesemas/.test(await txt(page, "#shList"))
      && await page.evaluate(() => document.querySelector(".sh-gift").textContent.indexOf("Merry Cheesemas! <3") >= 0 && !document.querySelector(".sh-gift b")));
    await page.click('#shBar [data-sh="filter"][data-v="done"]');
    t("Shipped: the UPS one, tracking linked and emailed", /1Z999AA10123456784/.test(await txt(page, "#shList")) && /Tracking emailed/.test(await txt(page, "#shList"))
      && (await page.locator('#shList a.sh-trk[href*="ups.com"]').count()) === 1);
    t("…offers Resend tracking email", (await page.locator('#shList [data-sh="email"]').count()) === 1 && /Resend/.test(await txt(page, '#shList [data-sh="email"]')));
    await page.click('#shList [data-sh="email"]'); await page.waitForTimeout(400);
    t("Resend: ship_email for that order", st.calls.some((c) => c.action === "ship_email" && c.body.order_id === "bbbb22") && /Tracking emailed to brad@example.com/.test(await txt(page, "#shList .sh-msg")), await txt(page, "#shList .sh-msg"));
    await page.click('#shBar [data-sh="filter"][data-v="all"]');
    t("All: three, the refunded one marked", await page.locator("#shList .sh-row").count() === 3 && /Refunded/.test(await txt(page, ".sh-row.refund")));
    await page.click('#shBar [data-sh="filter"][data-v="todo"]');
    await page.click('#shList [data-sh="track"]'); await page.waitForTimeout(200);
    t("Add tracking opens the form, focused", (await page.locator("#shList .sh-track").count()) === 1 && await page.evaluate(() => document.activeElement && document.activeElement.name === "num"));
    await page.fill('#shList .sh-track input[name="num"]', "1z 12");
    await page.click('#shList .sh-track button[type="submit"]'); await page.waitForTimeout(200);
    t("a bad tracking number is refused here", /check the tracking number/.test(await txt(page, "#shList .sh-msg")) && !st.calls.some((c) => c.action === "ship_mark"));
    await page.selectOption('#shList .sh-track select[name="carrier"]', "UPS");
    await page.fill('#shList .sh-track input[name="num"]', "1Z 999 AA1 0123 456784");
    await page.evaluate(() => window.__ship.load(false)); await page.waitForTimeout(400); // a refresh mid-typing keeps it
    t("a refresh keeps the half-typed number", (await page.inputValue('#shList .sh-track input[name="num"]')) === "1Z 999 AA1 0123 456784");
    await page.click('#shList .sh-track button[type="submit"]'); await page.waitForTimeout(500);
    const mk = st.calls.find((c) => c.action === "ship_mark");
    t("Save & email: ship_mark with the cleaned number", !!mk && mk.body.order_id === "aaaa11" && mk.body.carrier === "UPS" && mk.body.tracking_number === "1Z999AA10123456784", JSON.stringify(mk && mk.body));
    await page.click('#shBar [data-sh="filter"][data-v="all"]');
    t("…the row is shipped and says the customer has the link", /Saved in Square and the customer has the tracking link/.test(await txt(page, "#shList")) && (await page.locator(".sh-row.done").count()) === 2);
    t("…the tab count drops to 0", !(await page.evaluate(() => document.getElementById("shTabPill").classList.contains("show"))));
    // print
    st.orders = ORDERS(); await page.evaluate(() => window.__ship.load(true)); await page.waitForTimeout(400);
    await page.click('#shBar [data-sh="filter"][data-v="todo"]');
    const [pop] = await Promise.all([page.waitForEvent("popup"), page.click('#shBar [data-sh="print"]')]);
    await pop.waitForLoadState(); const ph = await pop.content();
    t("Print: a packing list + a slip with the gift note", /Ship day · Tue, Dec 8, 2026/.test(ph) && /TEST ORDERS/.test(ph) && (ph.match(/class="slip"/g) || []).length === 1 && /Merry Cheesemas! &lt;3/.test(ph) && /tuck it in the box/.test(ph), ph.slice(0, 200));
    if (process.env.SHOTS) { await pop.setViewportSize({ width: 900, height: 1100 }); await pop.screenshot({ path: path.join(process.env.SHOTS, "packing-list.png"), fullPage: true }); }
    await pop.close();
    // settings
    await page.waitForSelector("#shItems .sh-it", { timeout: 8000 });
    t("settings: filled from order_shipping", await page.evaluate(() => document.getElementById("shEnabled").checked && document.getElementById("shShipOn").value === "2026-12-08"
      && document.getElementById("shFirst").value === "30.00" && document.getElementById("shTax").value === "TN"));
    t("…the Cheesemas box is ticked, Special Offers listed", await page.evaluate(() => { const b = [...document.querySelectorAll('#shItems input[data-sh="item"]')]; return b.length === 2 && b[0].checked && b[0].value === "EN2OPFWI6P6WHF3DDHD4T2V2" && !b[1].checked; }));
    await page.click('#shItems [data-sh="more"]');
    t("…Show every item lists the rest", (await page.locator('#shItems input[data-sh="item"]').count()) === 3);
    await page.fill("#shOrderBy", "2026-12-10"); await page.click("#shSave"); await page.waitForTimeout(200);
    t("a last order day after the ship day is refused", /on or before the ship day/.test(await txt(page, "#shSetMsg")));
    await page.fill("#shOrderBy", "2026-12-04"); await page.fill("#shFirst", "35"); await page.fill("#shEach", "25"); await page.fill("#shTax", "tn, ms");
    await page.click("#shSave"); await page.waitForTimeout(400);
    const up = await page.evaluate(() => (window.__sbCalls || []).filter((c) => c[0] === "site_content" && c[1] === "upsert").pop());
    const d = up && up[2] && up[2].data;
    t("Save: upserts order_shipping with the new values", !!d && up[2].key === "order_shipping" && d.order_by === "2026-12-04" && d.first_cents === 3500 && d.each_cents === 2500
      && JSON.stringify(d.tax_states) === '["TN","MS"]' && d.enabled === true && JSON.stringify(d.items) === '["EN2OPFWI6P6WHF3DDHD4T2V2"]', JSON.stringify(up && up[2]));
    t("…keeps keys the form doesn't know, says who saved", !!d && d.note === "keep me" && up[2].updated_by === "manager@greyscheese.com" && /Saved/.test(await txt(page, "#shSetMsg")));
    if (process.env.SHOTS) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(process.env.SHOTS, "manager-shipping.png"), fullPage: true }); }
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  // TEST SWITCH (2026-11-13): the staging portal's on/off box is the test site's order_shipping.test_enabled; live's is enabled
  const settingsSave = async (page) => {
    await page.click("#shSave"); await page.waitForTimeout(400);
    const up = await page.evaluate(() => (window.__sbCalls || []).filter((c) => c[0] === "site_content" && c[1] === "upsert").pop());
    return up && up[2] && up[2].data;
  };
  const openSettings = async (opts) => {
    const o = await open(browser, "/manager.html", opts);
    await o.page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
    await o.page.evaluate(() => mtab("shipping"));
    await o.page.waitForSelector("#shItems .sh-it", { timeout: 8000 }); await o.page.waitForTimeout(300);
    return o;
  };
  console.log("\nmanager.html · the test site's own shipping switch");
  {
    const { ctx, page, st } = await openSettings({ row: Object.assign({}, CFG, { enabled: false, test_enabled: true }) });
    t("staging: live off + test on → the box is ticked", await page.evaluate(() => document.getElementById("shEnabled").checked));
    t("…and says it's the test order site", /on the test order site/.test(await txt(page, ".sh-on")), await txt(page, ".sh-on"));
    await page.uncheck("#shEnabled"); const d = await settingsSave(page);
    t("…untick + Save: test_enabled false, live enabled left false", !!d && d.test_enabled === false && d.enabled === false && d.note === "keep me", JSON.stringify(d));
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  {
    const { ctx, page, st } = await openSettings({ row: Object.assign({}, CFG, { enabled: false }) });
    t("staging: no test_enabled yet → the box follows live (off)", !(await page.evaluate(() => document.getElementById("shEnabled").checked)));
    await page.check("#shEnabled"); const d = await settingsSave(page);
    t("…tick + Save: test_enabled true, live enabled stays false", !!d && d.test_enabled === true && d.enabled === false, JSON.stringify(d));
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  {
    const { ctx, page, st } = await openSettings({ host: "https://staff.greyscheese.com", row: Object.assign({}, CFG, { enabled: false, test_enabled: true }) });
    t("live portal: the box is the live switch (off), test on doesn't tick it", !(await page.evaluate(() => document.getElementById("shEnabled").checked)));
    t("…label unchanged", /on the order site/.test(await txt(page, ".sh-on")) && !/test/.test(await txt(page, ".sh-on")), await txt(page, ".sh-on"));
    await page.check("#shEnabled"); const d = await settingsSave(page);
    t("…tick + Save: enabled true, test_enabled kept as it was", !!d && d.enabled === true && d.test_enabled === true, JSON.stringify(d));
    t("…talks to the live function", st.calls.some((c) => c.fn === "square-online-order") && !st.calls.some((c) => c.fn === "square-online-order-test"));
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, "/manager.html", { viewport: { width: 390, height: 844 } });
    await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
    await page.evaluate(() => mtab("shipping"));
    await page.waitForSelector("#shList .sh-row", { timeout: 8000 }); await page.waitForTimeout(300);
    const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    t("phone: the ship list fits", fit.sw <= fit.w + 1, JSON.stringify(fit));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, "manager-shipping-phone.png"), fullPage: false });
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  console.log("\nindex.html · ship day on the calendar");
  {
    const { ctx, page, st } = await open(browser, "/", {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => { localStorage.setItem("greys_loc", "memphis"); });
    const out = await page.evaluate(async () => {
      let box = document.getElementById("shipTestBox"); if (!box) { box = document.createElement("div"); box.id = "shipTestBox"; document.body.appendChild(box); }
      await renderCalendar({ y: 2026, m: 11, target: { list: "shipTestBox" } });
      const day = box.querySelector('.ag-day[data-date="2026-12-08"]');
      return { day: day ? day.textContent.replace(/\s+/g, " ") : "", tag: day ? (day.querySelector(".ag-tag.t-ship") || {}).textContent || "" : "", link: day ? !!day.querySelector('a[href="/manager#shipping"]') : false };
    });
    t("Dec 8: Ship day · 3 boxes to ship · 2 orders · 1 shipped · TEST", out.tag === "Ship day" && /3 boxes to ship · 2 orders · 1 shipped · TEST/.test(out.day), JSON.stringify(out));
    t("…opens to the ship list link", out.link);
    t("…from the sandbox copy", st.calls.some((c) => c.action === "ship_days" && c.fn === "square-online-order-test"));
    const nash = await page.evaluate(async () => {
      // the Nashville calendar doesn't get Memphis's ship day
      const real = LOC; return real;
    });
    t("the calendar's shop is Memphis here", nash === "memphis", nash);
    t("no page errors", st.errors.length === 0, st.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
  await browser.close();
  console.log("\n" + ok + " passed, " + bad + " failed");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
