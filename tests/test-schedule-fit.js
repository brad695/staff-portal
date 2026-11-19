/*
 * 🗓️ Weekly Schedule (manager.html) fits the screen with no sideways scrolling, 2026-11-18:
 * phone = day picker + one day; iPad/PC = the 7-day grid squeezed to the width. Supabase is stubbed.
 * Run: NODE_PATH=$(npm root -g) PW_CHROME=/usr/bin/google-chrome node tests/test-schedule-fit.js   (SHOTS=dir)
 */
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const REPO = path.join(__dirname, "..");
const HOST = "https://greys-staff-portal-staging.onrender.com";
const MANAGER = fs.readFileSync(path.join(REPO, "manager.html"));
let ok = 0, bad = 0;
const t = (n, c, x) => { if (c) { ok++; console.log("  ✓ " + n); } else { bad++; console.log("  ✗ " + n + (x !== undefined ? "  -> " + JSON.stringify(x) : "")); } };
const SB_STUB = `(function(){
  function builder(){ var b = new Proxy({}, { get: function(_, k){
    if (k === 'then') return function(a, r){ return Promise.resolve({ data: [], error: null }).then(a, r); };
    return function(){ return b; }; } }); return b; }
  var session = { access_token: 'tok', user: { email: 'manager@greyscheese.com' } };
  var client = { auth: { getSession: function(){ return Promise.resolve({ data: { session: session } }); }, onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
      signOut: function(){ return Promise.resolve({}); }, getUser: function(){ return Promise.resolve({ data: { user: session.user } }); } },
    rpc: function(n){ return Promise.resolve({ data: n === 'is_app_admin' ? true : null, error: null }); },
    from: builder, storage: { from: builder }, channel: function(){ var c = { on: function(){ return c; }, subscribe: function(){ return c; } }; return c; }, removeChannel: function(){} };
  window.supabase = { createClient: function(){ return client; } };
})();`;
const NAMES = ["Alexandra Montgomery", "Brad", "Jackie Owner", "Kurt", "Sam Rivera", "Taylor Brooks", "Morgan Lee", "Chris P."];
function seed(NAMES) {
  const wk = sgWeek, iso = (n) => sgIso(sgAdd(wk, n));
  const mk = (loc, base) => {
    const emps = NAMES.map((n, i) => ({ id: base + i, name: n, role: i % 2 ? "Server" : "Kitchen", location: loc }));
    const shifts = []; let id = base * 10;
    emps.forEach((e, i) => { for (let d = 0; d < 7; d++) if ((i + d) % 3) shifts.push({ id: id++, employee_id: e.id, date: iso(d), start_time: d % 2 ? "10:30:00" : "16:00:00", end_time: "22:00:00", role: e.role, note: "", kind: (i + d) % 7 === 1 ? "oncall" : (i + d) % 7 === 2 ? "offsite" : "shift", location: loc }); });
    shifts.push({ id: id++, employee_id: base, date: iso(0), start_time: "00:00", end_time: "00:00", role: "", note: "", kind: "off", location: loc });
    return { emps, shifts, to: [{ name: NAMES[1], start_date: iso(2), end_date: iso(3), start_time: null }], avail: [{ employee_id: base + 3, weekday: 4, kind: "unavailable", start_time: "09:00", end_time: "14:00" }, { employee_id: base + 4, weekday: 5, kind: "preferred" }], pub: null };
  };
  SG.memphis = mk("memphis", 100); SG.nashville = mk("nashville", 200); sgDay = null; sgRender();
}
async function at(browser, w, h, label, shots) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1300, isMobile: w < 900 });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { window.open = () => null; });
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SB_STUB });
    if (u.origin === HOST && /^\/manager(\.html)?$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/\.js(\?|$)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp|css)$/.test(u.pathname) || /fonts/.test(u.hostname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
  });
  await page.goto(HOST + "/manager.html");
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  await page.evaluate(() => mtab("scheduling"));
  await page.waitForTimeout(300);
  await page.evaluate(seed, NAMES);
  await page.waitForTimeout(200);
  console.log("\n" + label + " " + w + "×" + h);
  const m = await page.evaluate(() => {
    const doc = document.documentElement, tbl = [...document.querySelectorAll("#sgAll table.sg-grid")];
    return { docOver: doc.scrollWidth - doc.clientWidth,
      tblOver: tbl.map((x) => x.scrollWidth - x.parentElement.clientWidth),
      cardOver: [...document.querySelectorAll("#sgAll .section-card")].map((c) => Math.round(c.getBoundingClientRect().right - doc.clientWidth)),
      oneDay: !!document.querySelector("#sgAll table.sg-1day"), strip: document.querySelectorAll("#sgAll .sg-dbtn").length,
      cols: (document.querySelector("#sgAll table.sg-grid thead tr") || { children: [] }).children.length,
      clipped: [...document.querySelectorAll("#sgAll .sg-shift")].filter((e) => e.scrollWidth > e.clientWidth + 1).length };
  });
  t("page doesn't scroll sideways", m.docOver <= 0, m.docOver);
  t("grids fit their box", m.tblOver.every((x) => x <= 0), m.tblOver);
  t("cards sit on screen", m.cardOver.every((x) => x <= 0), m.cardOver);
  t("no shift text clipped", m.clipped === 0, m.clipped);
  if (w < 640) {
    t("phone: one-day view with a 7-day picker", m.oneDay && m.strip === 14 && m.cols === 2, m);
    await page.click("#sgAll .sg-days .sg-dbtn:nth-child(5)");
    t("phone: tapping Fri switches the day", /Friday/.test(await page.textContent("#sgAll table.sg-grid thead")));
    await page.click("#sgAll table.sg-grid tbody td.sg-cell");
    t("phone: tapping a cell opens the shift box", await page.evaluate(() => document.getElementById("shiftModal").style.display === "flex"));
    await page.evaluate(() => shClose());
  } else t("wide: the full 7-day grid", !m.oneDay && m.cols === 8, m);
  t("no page errors", errs.length === 0, errs);
  if (shots) await page.screenshot({ path: path.join(shots, label.replace(/\W+/g, "-") + ".png"), fullPage: true });
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  const S = process.env.SHOTS || "";
  await at(browser, 390, 844, "iPhone", S);
  await at(browser, 820, 1180, "iPad portrait", S);
  await at(browser, 1180, 820, "iPad landscape", S);
  await at(browser, 1024, 768, "iPad mini landscape", S);
  await at(browser, 1440, 900, "PC", S);
  await browser.close();
  console.log("\n" + ok + " passed, " + bad + " failed"); process.exit(bad ? 1 : 0);
})();
