/*
 * 💼 Catering Leads list views (manager.html, 2026-11-22 — "not happy with the look of our catering leads"):
 * the list draws as a TABLE (sortable columns, totals row, two-line rows on a phone) or a BOARD (a column per stage),
 * with a search box. Opening a lead, the kind tabs and the stage chips work as before.
 * Same day: "make the columns rearrangeable, and change the look of the tabs, color code them, the whole thing like a
 * button" — table columns move by dragging a heading (order remembered), and each kind tab is a button in its own color.
 * Then "also do a calendar view" — a third view: the month by event date, leads with no date in a strip underneath,
 * a list of days on a phone.
 * Later: "switch the button designs, give bottom row the big prominent colored buttons, move top row to bottom and give
 * them checkmarks inside the button", then "swap positions though, colored on bottom" — the type row is on top as small
 * pills with a tick box (tick one or more kinds; All inquiries clears them); the stage row is under it as big buttons
 * in each stage's color.
 * The page is served under the staging host; Supabase and the CDNs are stood in — nothing goes to the network.
 * Run: NODE_PATH=$(npm root -g) node tests/test-lead-views.js     (SHOTS=dir for screenshots, PW_CHROME=path, MANAGER=file)
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const HOST = "https://greys-staff-portal-staging.onrender.com";
const MANAGER = fs.readFileSync(process.env.MANAGER || path.join(__dirname, "..", "manager.html"));
const SHOTS = process.env.SHOTS || "";
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 900) : "")); } };

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
let n = 0; const id = () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0");
const lead = (o) => Object.assign({ id: id(), code: "C" + String(n).padStart(5, "0"), company: "", phone: "9015550100", unread: false, location: "Memphis", fulfillment: "pickup", created_at: ago(400) }, o);
function fresh() {
  n = 0;
  const L = [
    lead({ name: "Jane Smith", email: "jane@example.com", stage: "new", unread: true, occasion: "Birthday dinner", event_date: day(20), event_time: "18:00", guests: 20, last_message_at: ago(1) }),
    lead({ name: "Omar Reyes", company: "Acme Realty", email: "omar@acme.example", stage: "replied", occasion: "Private event — holiday party", location: "Nashville", event_date: day(28), guests: 40, last_message_at: ago(5), q: 248000 }),
    lead({ name: "Priya Patel", company: "St. Jude Events", email: "priya@example.org", stage: "quoted", occasion: "Board lunch", event_date: day(9), guests: 60, last_message_at: ago(26), q: 131250 }),
    lead({ name: "Marcus Lee", email: "marcus@example.com", stage: "contract_sent", occasion: "Wedding welcome party", event_date: day(41), guests: 120, last_message_at: ago(50), q: 685000 }),
    lead({ name: "Lucia Romano", company: "Romano Law", email: "lucia@example.com", stage: "deposit_paid", occasion: "Private event", event_date: day(6), guests: 24, last_message_at: ago(120), q: 410000, paid: 205000 }),
    lead({ name: "Tom Becker", email: "tom@example.com", stage: "paid", occasion: "Experience — Raclette", event_date: day(3), guests: 6, last_message_at: ago(140), q: 42000, paid: 42000 }),
    lead({ name: "Grace Kim", email: "grace@example.com", stage: "paid", occasion: "Office holiday boards", event_date: day(-4), guests: 50, last_message_at: ago(300), q: 157500, paid: 157500 }),   // past: not Open
    lead({ name: "Will Turner", email: "will@example.com", stage: "lost", occasion: "Rehearsal dinner", event_date: day(60), guests: 45, last_message_at: ago(200) }),                         // lost: not Open
    lead({ name: "Ana Flores", email: "ana@example.com", stage: "replied", occasion: null, event_date: null, guests: null, last_message_at: ago(30) }),
    lead({ name: '<img src=x onerror="window.__xss=1">', company: "<b>Co</b>", email: "x@example.com", stage: "quoted", occasion: "<script>window.__xss=2</script>", event_date: day(18), guests: 250, last_message_at: ago(8), q: 1234567 }),
  ];
  const quotes = [];
  L.forEach((r) => { if (r.q) quotes.push({ id: id(), lead_id: r.id, status: r.paid ? "paid" : "sent", total_cents: r.q, amount_paid_cents: r.paid || 0, created_at: ago(100) }); delete r.q; delete r.paid; });
  quotes.push({ id: id(), lead_id: L[1].id, status: "canceled", total_cents: 999900, amount_paid_cents: 0, created_at: ago(10) });   // a newer canceled proposal never counts
  const I = [
    { id: id(), code: "E00001", name: "Sam Lee", email: "sam@example.com", phone: "6155550100", stage: "new", unread: false, experience_name: "Raclette", preferred_date: day(11), preferred_time: "18:00", party_size: 6, location: "Memphis", last_message_at: ago(20), created_at: ago(20), details: {} },
    { id: id(), code: "E00002", name: "Kelly Nguyen", email: "kelly@example.com", phone: "", stage: "link_sent", unread: false, experience_name: "Greysing Table", preferred_date: day(16), preferred_time: "19:00", party_size: 8, location: "Nashville", last_message_at: ago(44), created_at: ago(60), details: {} },
  ];
  return { catering_leads: L, catering_messages: [], catering_quotes: quotes, inquiries: I, inquiry_messages: [], catering_templates: [], site_content: [] };
}

// supabase-js stand-in: the tables are answered by this test (https://stub.local/db)
const SB_STUB = `(function(){
  function ask(what, payload){ return fetch('https://stub.local/' + what, { method: 'POST', body: JSON.stringify(payload) }).then(function(r){ return r.json(); }); }
  var REAL = { catering_leads:1, catering_messages:1, catering_quotes:1, inquiries:1, inquiry_messages:1, catering_templates:1, site_content:1 };
  function builder(table){
    var q = { table: table, ops: [] };
    var b = new Proxy({}, { get: function(_, k){
      if (k === 'then') return function(a, r){ return (REAL[table] ? ask('db', q) : Promise.resolve({ data: q.single ? null : [], error: null, count: 0 })).then(a, r); };
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
    storage: { from: function(){ return { upload: function(){ return Promise.resolve({ data: {}, error: null }); }, getPublicUrl: function(p){ return { data: { publicUrl: 'https://stub.local/' + p } }; }, list: function(){ return Promise.resolve({ data: [], error: null }); } }; } },
    channel: function(){ var c = { on: function(){ return c; }, subscribe: function(){ return c; } }; return c; }, removeChannel: function(){}
  };
  window.supabase = { createClient: function(){ return client; } };
})();`;

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, hasTouch: !!opts.touch });
  const page = await ctx.newPage();
  const st = { errors: [], updates: [], rows: fresh() };
  page.on("pageerror", (e) => st.errors.push(String(e)));
  page.on("dialog", (d) => { st.errors.push("dialog: " + d.message()); d.dismiss(); });
  await page.route("**/*", async (route) => {
    const req = route.request(), u = new URL(req.url());
    const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    const json = (o, s) => route.fulfill({ status: s || 200, headers: CORS, contentType: "application/json", body: JSON.stringify(o) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SB_STUB });
    if (u.hostname === "stub.local" && u.pathname === "/db") {
      const q = JSON.parse(req.postData()), all = st.rows[q.table] || [];
      const eqs = q.ops.filter((o) => o[0] === "eq"), hit = all.filter((r) => eqs.every((e) => r[e[1]] === e[2]));
      const upd = q.ops.find((o) => o[0] === "update");
      if (upd) { st.updates.push({ table: q.table, set: upd[1], ids: hit.map((r) => r.id) }); hit.forEach((r) => Object.assign(r, upd[1])); return json({ data: hit, error: null }); }
      const rows = hit.map((r) => Object.assign({}, r));
      if (q.table === "catering_leads") rows.forEach((r) => { r.catering_messages = []; r.catering_quotes = st.rows.catering_quotes.filter((m) => m.lead_id === r.id); });
      if (q.table === "inquiries") rows.forEach((r) => { r.inquiry_messages = []; });
      return json({ data: q.single ? (rows[0] || null) : rows, error: null });
    }
    if (/^\/functions\/v1\//.test(u.pathname)) return json({ ok: true });
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/fonts\.googleapis\.com/.test(u.hostname)) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp|woff2?)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return json({});
  });
  if (opts.view) await page.addInitScript((v) => { try { localStorage.setItem("cat_view", v); } catch (_) {} }, opts.view);
  if (opts.cols) await page.addInitScript((v) => { try { localStorage.setItem("cat_cols", v); } catch (_) {} }, opts.cols);
  await page.goto(HOST + "/manager.html");
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  await page.evaluate(async () => { mtab("catering"); await catLoad(); await inqLoad(); });
  return { ctx, page, st };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } };
const names = (page) => page.$$eval("#catList .cv-tbl tbody tr", (rs) => rs.map((r) => r.querySelector(".cv-nm b").textContent));
const cellOf = (page, name, cls) => page.evaluate(([nm, c]) => { const r = [...document.querySelectorAll("#catList .cv-tbl tbody tr")].find((x) => x.querySelector(".cv-nm b").textContent === nm); return r ? r.querySelector("td." + c).textContent.trim() : null; }, [name, cls]);
const chips = (page) => page.$$eval("#catChips .chip", (bs) => bs.map((b) => b.textContent));
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== "none"; }, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

  console.log("\nmanager.html · 💼 Catering Leads → Table");
  {
    const { ctx, page, st } = await open(browser);
    t("the list opens as a table", await page.evaluate(() => document.getElementById("catList").className === "rec-list cv-table" && !!document.querySelector("#catList table.cv-tbl")));
    t("Table is the pressed view button", await page.evaluate(() => document.querySelector('.cv-seg button[data-v="table"]').getAttribute("aria-pressed") === "true" && document.querySelector('.cv-seg button[data-v="board"]').getAttribute("aria-pressed") === "false"));
    const first = await names(page);
    t("Open shows every lead but the lost one and the one whose date has passed", first.length === 10 && !first.includes("Will Turner") && !first.includes("Grace Kim"), first);
    t("newest activity first to begin with", first[0] === "Jane Smith" && first[first.length - 1] === "Tom Becker", first);
    t("the columns", JSON.stringify(await page.$$eval("#catList .cv-tbl thead th", (h) => h.map((x) => x.textContent.trim()))) === JSON.stringify(["Lead", "Stage", "Event date", "Guests", "Value", "Type", "Event", "Shop", "Paid", "Last activity", "Email", "Phone"]));
    t("stage reads as a colored chip", await page.evaluate(() => { const c = [...document.querySelectorAll("#catList tbody tr")].find((r) => /Marcus Lee/.test(r.textContent)).querySelector("td.c-stage .cv-chip"); return c.textContent === "Proposal sent" && c.classList.contains("st-contract_sent"); }));
    t("an experience inquiry keeps its own stage name", (await cellOf(page, "Kelly Nguyen", "c-stage")) === "Link sent");
    t("the kind is taken off the front of the occasion (Type says it)", (await cellOf(page, "Omar Reyes", "c-event")) === "Holiday party" && (await cellOf(page, "Omar Reyes", "c-kind")) === "Private event" && (await cellOf(page, "Tom Becker", "c-event")) === "Raclette" && (await cellOf(page, "Tom Becker", "c-kind")) === "Experience");
    t("a bare 'Private event' leaves the Event cell empty", (await cellOf(page, "Lucia Romano", "c-event")) === "—");
    t("value is the newest proposal that isn't canceled", (await cellOf(page, "Omar Reyes", "c-value")) === "$2,480.00");
    t("paid shows what has come in", (await cellOf(page, "Lucia Romano", "c-paid")) === "$2,050.00" && (await cellOf(page, "Tom Becker", "c-paid")) === "$420.00" && (await cellOf(page, "Jane Smith", "c-paid")) === "—");
    t("an event inside a week is flagged, a paid one is not", await page.evaluate(() => { const row = (n) => [...document.querySelectorAll("#catList tbody tr")].find((r) => r.querySelector(".cv-nm b").textContent === n); return row("Lucia Romano").querySelector("td.c-date .cv-rel").classList.contains("soon") && !row("Tom Becker").querySelector("td.c-date .cv-rel").classList.contains("soon") && row("Lucia Romano").querySelector("td.c-date .cv-rel").textContent === "in 6 days"; }));
    t("no date / guests / phone shows a dash, not 'null'", (await cellOf(page, "Ana Flores", "c-date")) === "—" && (await cellOf(page, "Ana Flores", "c-guests")) === "—" && (await cellOf(page, "Kelly Nguyen", "c-phone")) === "—" && !/null|undefined|NaN/.test(await page.textContent("#catList")));
    t("the unread lead is marked", await page.evaluate(() => { const r = [...document.querySelectorAll("#catList tbody tr")].filter((x) => x.classList.contains("unread")); return r.length === 1 && /Jane Smith/.test(r[0].textContent) && !!r[0].querySelector(".cv-dot"); }));
    t("totals row: count, guests, value, paid", await page.evaluate(() => { const f = (c) => document.querySelector("#catList tfoot td." + c).textContent.trim(); return f("cv-first") === "10 leads" && f("c-guests") === "Sum534" && f("c-value") === "Sum$27,508.17" && f("c-paid") === "Sum$2,470.00"; }), await page.$$eval("#catList tfoot td", (x) => x.map((y) => y.textContent)));
    t("names, companies and occasions are written as text, never as markup", await page.evaluate(() => !window.__xss && !document.querySelector("#catList img, #catList script, #catList b b") && [...document.querySelectorAll("#catList .cv-nm b")].some((b) => b.textContent.indexOf("<img") === 0)));
    await shot(page, "views-table");

    console.log("\n  sorting");
    await page.click('#catList th.c-value .cv-th');
    let ns = await names(page);
    t("Value: biggest first, leads with no proposal at the bottom", ns[0].indexOf("<img") === 0 && ns[1] === "Marcus Lee" && ["Jane Smith", "Ana Flores", "Sam Lee", "Kelly Nguyen"].includes(ns[ns.length - 1]), ns);
    t("the sorted column says so", await page.evaluate(() => document.querySelector("#catList th.c-value").getAttribute("aria-sort") === "descending" && document.querySelectorAll("#catList th[aria-sort]").length === 1));
    await page.click('#catList th.c-value .cv-th');
    ns = await names(page);
    t("again: smallest first, blanks still at the bottom", ns[0] === "Tom Becker" && ["Jane Smith", "Ana Flores", "Sam Lee", "Kelly Nguyen"].includes(ns[ns.length - 1]) && (await page.getAttribute("#catList th.c-value", "aria-sort")) === "ascending", ns);
    await page.click('#catList th.c-stage .cv-th');
    const stages = await page.$$eval("#catList tbody td.c-stage .cv-chip", (c) => c.map((x) => x.className.replace("cv-chip st-", "")));
    t("Stage sorts in pipeline order, not A–Z", JSON.stringify([...new Set(stages)]) === JSON.stringify(["new", "replied", "quoted", "contract_sent", "deposit_paid", "paid"]), stages);
    await page.click('#catList th.c-date .cv-th');
    ns = await names(page);
    t("Event date: soonest first, no date last", ns[0] === "Tom Becker" && ns[ns.length - 1] === "Ana Flores", ns);
    await page.click('#catList th.cv-first .cv-th');
    ns = await names(page);
    t("Lead sorts A–Z", ns[1] === "Ana Flores" && ns[ns.length - 1] === "Tom Becker", ns);
    await page.click('#catList th.c-last .cv-th');

    console.log("\n  search, tabs and stage chips");
    await page.fill("#catFind", "acme");
    t("search finds a lead by company", JSON.stringify(await names(page)) === JSON.stringify(["Omar Reyes"]));
    t("the tab and stage counts follow the search", (await page.textContent("#catKinds .ctab.on .cnt")) === "1" && (await chips(page))[1] === "Open1");
    t("typing keeps the cursor in the box", await page.evaluate(() => document.activeElement === document.getElementById("catFind")));
    await page.fill("#catFind", "KELLY@EXAMPLE");
    t("search matches email, any case, and experience inquiries too", JSON.stringify(await names(page)) === JSON.stringify(["Kelly Nguyen"]));
    await page.fill("#catFind", "zzzz");
    t("nothing found says so", (await page.textContent("#catList")) === "No leads match “zzzz”." && (await page.getAttribute("#catList", "class")) === "rec-list");
    t("the unread badge still counts every lead while searching", (await page.textContent("#catBadge")) === "1");
    await page.fill("#catFind", "");
    t("clearing the search brings the list back", (await names(page)).length === 10);
    await page.click('#catKinds .ctab:has-text("Private events")');
    t("kind tab: Private events", JSON.stringify((await names(page)).sort()) === JSON.stringify(["Lucia Romano", "Omar Reyes"]));
    await page.click('#catKinds .ctab:has-text("All inquiries")');
    await page.click('#catChips .chip:has-text("Quoting")');
    t("stage chip: Quoting", (await names(page)).length === 2 && (await page.textContent("#catList tfoot td.cv-first")) === "2 leads");
    await page.click('#catChips .chip:has-text("All")');
    t("All brings back the lost and the past ones", (await names(page)).length === 12 && (await cellOf(page, "Grace Kim", "c-date")).endsWith("Past"));
    await page.click('#catChips .chip:has-text("Open")');

    console.log("\n  opening a lead");
    await page.click('#catList tbody tr:has-text("Jane Smith")');
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("a click on the row opens the lead", (await page.textContent("#catTitle")) === "Jane Smith");
    await page.waitForFunction(() => !document.querySelector("#catList tbody tr.unread"));
    t("opening it marks it read", st.updates.some((u) => u.table === "catering_leads" && u.set.unread === false) && (await shown(page, "#catBadge")) === false);
    await page.evaluate(() => catClose());
    await page.click('#catList tbody tr:has-text("Sam Lee")');
    await page.waitForFunction(() => document.getElementById("inqModal").style.display === "flex");
    t("an experience inquiry opens its own window", /Sam Lee/.test(await page.textContent("#inqTitle")));
    await page.evaluate(() => { document.getElementById("inqModal").style.display = "none"; });
    await page.evaluate(() => { window.__nav = 0; document.querySelectorAll("#catList td.c-email a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.__nav++; })); });
    await page.evaluate(() => { const row = [...document.querySelectorAll("#catList tbody tr")].find((r) => /Marcus Lee/.test(r.textContent)); row.querySelector("td.c-email a").click(); });
    t("the email link is a mailto and doesn't open the lead", (await page.evaluate(() => window.__nav)) === 1 && (await page.evaluate(() => document.getElementById("catModal").style.display)) !== "flex" && (await page.evaluate(() => document.querySelector("#catList td.c-email a").getAttribute("href"))).indexOf("mailto:") === 0);
    await page.focus('#catList tbody tr:has-text("Marcus Lee")');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("Enter on a row opens it (keyboard)", (await page.textContent("#catTitle")) === "Marcus Lee");
    await page.evaluate(() => catClose());
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · 💼 Catering Leads → type checkmarks on top, big colored stage buttons under them");
  {
    const { ctx, page, st } = await open(browser);
    const rgb = (hex) => "rgb(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ") + ")";
    const stg = () => page.$$eval("#catChips .chip", (bs) => bs.map((b) => { const c = getComputedStyle(b); return { text: [...b.childNodes].find((n) => n.nodeType === 3).textContent, k: (b.className.match(/st-(\w+)/) || [])[1], on: b.classList.contains("on"), pressed: b.getAttribute("aria-checked"), tick: getComputedStyle(b.querySelector(".cv-ck svg")).opacity, bg: c.backgroundColor, color: c.color, radius: parseFloat(c.borderTopLeftRadius), fs: parseFloat(c.fontSize), padT: parseFloat(c.paddingTop), n: (b.querySelector("b") || {}).textContent }; }));
    const typ = () => page.$$eval("#catKinds .ctab", (bs) => bs.map((b) => { const c = getComputedStyle(b), k = b.querySelector(".cv-ck"), kc = getComputedStyle(k); return { text: b.querySelector(".kl").textContent, on: b.classList.contains("on"), role: b.getAttribute("role"), checked: b.getAttribute("aria-checked"), kcVar: b.style.getPropertyValue("--kc"), radius: parseFloat(c.borderTopLeftRadius), fs: parseFloat(c.fontSize), box: kc.backgroundColor, boxW: k.getBoundingClientRect().width, tick: getComputedStyle(k.querySelector("svg")).opacity, n: b.querySelector(".cnt").textContent }; }));
    t("the type row is on top, the colored stage row under it, then the list", await page.evaluate(() => { const a = document.getElementById("catKinds"), b = document.getElementById("catChips"), c = document.getElementById("catList"); return a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1 && b.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1 && a.nextElementSibling === b && b.nextElementSibling === c; }));
    let sb = await stg();
    sb.push(sb.shift());   // All is first on the page; checks below read Open as [0] and All as [10]
    t("eleven stage buttons: All first, then Open and the nine stages", sb.map((x) => x.text).join() === "Open,New,Replied,Quoting,Proposal sent,Signed,Invoiced,Deposit paid,Paid,Lost,All" && (await page.textContent("#catChips .chip")) === "All" && await page.evaluate(() => !document.querySelector("#catChips .lbl, #catChips .sep")), sb.map((x) => x.text));
    let tp = await typ();
    t("the stage buttons are the big ones now, the type pills the small ones", sb.every((x) => x.radius === 10 && x.padT >= 7) && tp.every((x) => x.radius > 100) && sb[0].fs > tp[0].fs, [sb[0], tp[0]]);
    t("each stage button is in its own color, the same as its chip in the table", new Set(sb.map((x) => x.bg)).size === 11 && await page.evaluate(() => ["new", "replied", "quoted", "contract_sent"].every((k) => { const chip = document.querySelector("#catList .cv-chip.st-" + k), btn = document.querySelector("#catChips .chip.st-" + k); return chip && getComputedStyle(chip).backgroundColor === getComputedStyle(btn).backgroundColor && getComputedStyle(chip).color === getComputedStyle(btn).color; })), sb.map((x) => x.bg));
    t("the picked one (Open) is solid navy with white text and says it is pressed", sb[0].on && sb[0].pressed === "true" && sb[0].bg === rgb("#06273a") && sb[0].color === "rgb(255, 255, 255)" && sb.slice(1).every((x) => !x.on && x.pressed === "false" && x.color !== "rgb(255, 255, 255)"), sb[0]);
    t("the count sits inside each button; All has none", sb[0].n === "10" && sb[1].n === "2" && sb[10].n === undefined, sb.map((x) => x.n));
    await page.click('#catChips .chip:has-text("Quoting")');
    sb = await stg(); sb.push(sb.shift());
    t("picking Quoting fills it with the Quoting color and lets go of Open", sb[3].on && sb[3].bg === rgb("#4a3596") && sb[3].color === "rgb(255, 255, 255)" && !sb[0].on && sb[0].bg !== rgb("#06273a") && (await names(page)).length === 2, sb[3]);
    t("every stage button has a tick box; only the picked one is ticked", sb.every((x) => x.tick === (x.on ? "1" : "0")) && sb[3].tick === "1");
    await page.click('#catChips .chip:has-text("Deposit paid")');
    sb = await stg(); sb.push(sb.shift());
    t("ticking Deposit paid as well shows both stages together", sb[3].on && sb[7].on && sb.filter((x) => x.on).length === 2 && (await names(page)).length === 3, await names(page));
    await page.click('#catChips .chip:has-text("Quoting")');
    await page.click('#catChips .chip:has-text("Deposit paid")');
    sb = await stg(); sb.push(sb.shift());
    t("unticking the last stage goes back to Open", sb[0].on && sb.filter((x) => x.on).length === 1 && (await names(page)).length === 10);
    await page.click('#catChips .chip:has-text("New")');
    await page.click('#catChips .chip:has-text("All")');
    sb = await stg(); sb.push(sb.shift());
    t("All (or Open) stands alone and clears the stage ticks", sb[10].on && sb.filter((x) => x.on).length === 1);
    await page.click('#catChips .chip:has-text("Open")');

    console.log("\n  type row: tick boxes");
    t("a Type label, then seven pills that are checkboxes", (await page.textContent("#catKinds .lbl")) === "Type" && tp.map((x) => x.text).join() === "All inquiries,Catering,Private events,Experiences,Table requests,Donations,Questions" && tp.every((x) => x.role === "checkbox" && x.boxW >= 15));
    t("each box carries its kind's color", JSON.stringify(tp.map((x) => x.kcVar)) === JSON.stringify(["", "#06273a", "#7c3aed", "#b45309", "#0f766e", "#be185d", "#2563eb"]));
    t("to begin with only All inquiries is ticked", tp[0].on && tp[0].checked === "true" && tp[0].tick === "1" && tp[0].box === "rgb(61, 70, 84)" && tp.slice(1).every((x) => !x.on && x.checked === "false" && x.tick === "0" && x.box === "rgb(255, 255, 255)"), tp.map((x) => x.checked + x.tick));
    await page.click('#catKinds .ctab:has-text("Catering")');
    tp = await typ();
    t("ticking Catering shows only catering and unticks All inquiries", tp[1].on && tp[1].checked === "true" && tp[1].tick === "1" && tp[1].box === rgb("#06273a") && !tp[0].on && tp[0].tick === "0" && (await names(page)).length === 5 && (await page.$$eval("#catList tbody td.c-kind", (c) => c.every((x) => x.textContent === "Catering"))), await names(page));
    await page.click('#catKinds .ctab:has-text("Experiences")');
    tp = await typ();
    t("ticking Experiences as well shows both kinds", tp[1].on && tp[3].on && tp[3].box === rgb("#b45309") && tp.filter((x) => x.on).length === 2 && (await names(page)).length === 8 && JSON.stringify([...new Set(await page.$$eval("#catList tbody td.c-kind", (c) => c.map((x) => x.textContent)))].sort()) === JSON.stringify(["Catering", "Experience"]), await names(page));
    t("the stage counts follow what is ticked", (await chips(page))[1] === "Open8");
    await shot(page, "views-rows-swapped");
    await page.click('#catKinds .ctab:has-text("Catering")');
    t("unticking Catering leaves just the experiences", (await names(page)).length === 3 && (await typ()).filter((x) => x.on).map((x) => x.text).join() === "Experiences");
    await page.click('#catKinds .ctab:has-text("Experiences")');
    t("unticking the last one goes back to All inquiries", (await typ())[0].on && (await names(page)).length === 10);
    await page.click('#catKinds .ctab:has-text("Private events")');
    await page.click('#catKinds .ctab:has-text("All inquiries")');
    tp = await typ();
    t("All inquiries clears the ticks", tp[0].on && tp.filter((x) => x.on).length === 1 && (await names(page)).length === 10);
    for (const l of ["Catering", "Private events", "Experiences", "Table requests", "Donations", "Questions"]) await page.click('#catKinds .ctab:has-text("' + l + '")');
    tp = await typ();
    t("ticking every kind is the same as All inquiries", tp[0].on && tp.filter((x) => x.on).length === 1 && (await names(page)).length === 10, tp.map((x) => x.on));
    await page.focus('#catKinds .ctab:has-text("Private events")');
    await page.keyboard.press("Space");
    t("Space ticks a box from the keyboard", (await typ())[2].checked === "true" && JSON.stringify((await names(page)).sort()) === JSON.stringify(["Lucia Romano", "Omar Reyes"]));
    await page.click('.cv-seg button[data-v="board"]');
    t("on the board the big row is just Open | All and the ticks still apply", JSON.stringify(await chips(page)) === JSON.stringify(["All", "Open2"]) && (await page.$$eval("#catList .cv-card .cv-nm b", (b) => b.map((x) => x.textContent).sort())).join() === "Lucia Romano,Omar Reyes");
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · 💼 Catering Leads → moving columns");
  {
    const { ctx, page, st } = await open(browser);
    const heads = () => page.$$eval("#catList .cv-tbl thead th", (h) => h.map((x) => x.textContent.trim()));
    const DEF = ["Lead", "Stage", "Event date", "Guests", "Value", "Type", "Event", "Shop", "Paid", "Last activity", "Email", "Phone"];
    const center = async (sel) => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.x, right: b.x + b.width }; };
    const drag = async (from, toX, opts) => { const a = await center(from); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + (toX < a.x ? -12 : 12), a.y + 6, { steps: 3 }); await page.mouse.move(toX, a.y + 10, { steps: 8 }); if (opts && opts.mid) await opts.mid(); if (!(opts && opts.hold)) await page.mouse.up(); };
    t("Reset columns is hidden while the order is the original", !(await shown(page, "#catColsReset")));
    // Type -> just after Lead
    let st0 = await center("#catList th.c-stage");
    await drag("#catList th.c-kind .cv-th", st0.left + 14, { mid: async () => {
      t("while dragging: a line shows where it lands and a label follows the pointer", await page.evaluate(() => { const d = document.getElementById("cvDrop"), g = document.getElementById("cvGhost"), s = document.querySelector("#catList th.c-stage").getBoundingClientRect(); return !!d && !!g && g.textContent === "Type" && Math.abs(parseFloat(d.style.left) - s.left) < 2 && document.querySelector("#catList th.c-kind").classList.contains("cv-moving"); }));
    } });
    t("dropping Type after Lead puts it there", JSON.stringify(await heads()) === JSON.stringify(["Lead", "Type", "Stage", "Event date", "Guests", "Value", "Event", "Shop", "Paid", "Last activity", "Email", "Phone"]), await heads());
    t("every row's cells follow the headings", await page.evaluate(() => { const h = [...document.querySelectorAll("#catList thead th")].map((x) => x.className.replace(" num", "")); return [...document.querySelectorAll("#catList tbody tr, #catList tfoot tr")].every((r) => JSON.stringify([...r.children].filter((c) => !c.classList.contains("c-sum")).map((c) => c.className.replace(" num", ""))) === JSON.stringify(h)) && [...document.querySelectorAll("#catList col")].length === h.length; }));
    t("the widths travel with the columns", await page.evaluate(() => { const c = document.querySelectorAll("#catList col"); return c[1].style.width === "158px" && c[2].style.width === "142px"; }));
    t("the drag did not sort the table or leave anything behind", (await page.evaluate(() => CAT_SORT.k + CAT_SORT.d)) === "last-1" && await page.evaluate(() => !document.getElementById("cvDrop") && !document.getElementById("cvGhost") && !document.querySelector(".cv-moving, .c-moving, .cv-dragging")));
    t("the order is remembered", (await page.evaluate(() => localStorage.getItem("cat_cols"))) === JSON.stringify(["kind", "stage", "date", "guests", "value", "event", "shop", "paid", "last", "email", "phone"]));
    t("Reset columns shows up once the order is yours", await shown(page, "#catColsReset"));
    // Stage -> far right: the table scrolls itself when the pointer reaches its edge
    const box = await page.locator("#catList .cv-scroll").boundingBox();
    await drag("#catList th.c-stage .cv-th", box.x + box.width - 8, { hold: true });
    await page.waitForFunction(() => { const b = document.querySelector("#catList .cv-scroll"); return b.scrollLeft >= b.scrollWidth - b.clientWidth - 1; }, null, { timeout: 8000 });
    await page.mouse.move(box.x + box.width - 6, box.y + 20);
    await page.mouse.up();
    let hs = await heads();
    t("dragging to the right edge scrolls the table and drops the column at the end", hs[hs.length - 1] === "Stage" && hs[1] === "Type" && hs[2] === "Event date", hs);
    // a plain click still sorts
    await page.evaluate(() => { document.querySelector("#catList .cv-scroll").scrollLeft = 0; });
    await page.click("#catList th.c-guests .cv-th");
    t("a click on a heading still sorts", (await page.evaluate(() => CAT_SORT.k + CAT_SORT.d)) === "guests-1" && (await names(page))[0].indexOf("<img") === 0);
    // Lead stays first
    const g0 = await center("#catList th.c-guests");
    await drag("#catList th.cv-first .cv-th", g0.x + 30);
    t("Lead cannot be dragged away", (await heads())[0] === "Lead" && (await page.evaluate(() => CAT_COLS.indexOf("name"))) === -1);
    const lead = await center("#catList th.cv-first");
    await drag("#catList th.c-guests .cv-th", lead.x);
    hs = await heads();
    t("and nothing can be dropped in front of it", hs[0] === "Lead" && hs[1] === "Guests", hs);
    // Escape cancels
    const before = JSON.stringify(await heads());
    const v0 = await center("#catList th.c-value");
    await drag("#catList th.c-kind .cv-th", v0.right - 6, { hold: true });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    t("Esc while dragging leaves the order alone", JSON.stringify(await heads()) === before && await page.evaluate(() => !document.getElementById("cvDrop") && !document.getElementById("cvGhost")));
    // keyboard
    await page.focus("#catList th.c-kind .cv-th");
    await page.keyboard.press("Alt+ArrowRight");
    hs = await heads();
    t("Alt+→ on a heading moves it one place and keeps the focus on it", hs[3] === "Type" && await page.evaluate(() => document.activeElement === document.querySelector("#catList th.c-kind .cv-th")), hs);
    await page.keyboard.press("Alt+ArrowLeft");
    t("Alt+← moves it back", (await heads())[2] === "Type");
    // finger (pointer events, no mouse)
    await page.evaluate(() => {
      const th = document.querySelector("#catList th.c-value .cv-th"), r = th.getBoundingClientRect(), to = document.querySelector("#catList th.c-guests").getBoundingClientRect();
      const ev = (type, x, target) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true, button: 0, clientX: x, clientY: r.top + 10 }));
      ev("pointerdown", r.left + 20, th); ev("pointermove", r.left + 5, document); ev("pointermove", to.left + 6, document); ev("pointerup", to.left + 6, document);
    });
    hs = await heads();
    t("it works with a finger too (touch pointer)", hs.indexOf("Value") === hs.indexOf("Guests") - 1 && (await page.evaluate(() => getComputedStyle(document.querySelector("#catList .cv-th")).touchAction)) === "pan-y", hs);
    // reset
    await page.click("#catColsReset");
    t("Reset columns puts them back and forgets the saved order", JSON.stringify(await heads()) === JSON.stringify(DEF) && (await page.evaluate(() => localStorage.getItem("cat_cols"))) === null && !(await shown(page, "#catColsReset")));
    await page.evaluate(() => catMoveCol("phone", "stage"));
    await page.click('.cv-seg button[data-v="board"]');
    t("no Reset link on the board", !(await shown(page, "#catColsReset")));
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { cols: JSON.stringify(["phone", "bogus", "phone", "name", "kind"]) });
    const hs = await page.$$eval("#catList .cv-tbl thead th", (h) => h.map((x) => x.textContent.trim()));
    t("a saved order comes back on the next visit; junk in it is ignored and missing columns are added at the end", JSON.stringify(hs) === JSON.stringify(["Lead", "Phone", "Type", "Stage", "Event date", "Guests", "Value", "Event", "Shop", "Paid", "Last activity", "Email"]) && st.errors.length === 0, hs);
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { cols: "{not json" });
    t("a broken saved order falls back to the original", (await page.$$eval("#catList .cv-tbl thead th", (h) => h.map((x) => x.textContent.trim())))[1] === "Stage" && st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · 💼 Catering Leads → Board");
  {
    const { ctx, page, st } = await open(browser);
    await page.click('#catChips .chip:has-text("Quoting")');
    await page.click('.cv-seg button[data-v="board"]');
    await page.click('.cv-seg button[data-v="table"]');
    t("back on the table the stage picked earlier is still on", (await names(page)).length === 2 && (await page.textContent("#catChips .chip.on")) === "Quoting2");
    await page.click('.cv-seg button[data-v="board"]');
    t("Board draws a column per stage, in pipeline order", JSON.stringify(await page.$$eval("#catList .cv-col", (c) => c.map((x) => x.querySelector(".cv-chip").textContent))) === JSON.stringify(["New", "Replied", "Quoting", "Proposal sent", "Signed", "Invoiced", "Deposit paid", "Paid", "Lost"]));
    t("on the board the chips are just Open | All", JSON.stringify(await chips(page)) === JSON.stringify(["All", "Open10"]) && (await page.textContent("#catChips .chip.on")) === "Open10");
    const col = (name) => page.evaluate((nm) => { const c = [...document.querySelectorAll("#catList .cv-col")].find((x) => x.querySelector(".cv-chip").textContent === nm); return { empty: c.classList.contains("empty"), cards: [...c.querySelectorAll(".cv-card .cv-nm b")].map((b) => b.textContent), n: (c.querySelector(".cv-n") || {}).textContent, total: (c.querySelector(".cv-total") || {}).textContent }; }, name);
    let c = await col("New");
    t("New holds the new catering lead and the new inquiry", JSON.stringify(c.cards) === JSON.stringify(["Jane Smith", "Sam Lee"]) && c.n === "2" && !c.total, c);
    c = await col("Quoting");
    t("a column adds up its proposals", c.n === "2" && c.total === "$13,658.17", c);
    c = await col("Proposal sent");
    t("a 'Link sent' inquiry sits under Proposal sent and says so on its card", c.cards.includes("Kelly Nguyen") && await page.evaluate(() => [...document.querySelectorAll(".cv-card")].find((x) => /Kelly Nguyen/.test(x.textContent)).querySelector(".cv-cardfoot .cv-sub").textContent === "Link sent"), c);
    t("stages with nobody in them fold to a slim column", (await col("Signed")).empty && (await col("Invoiced")).empty && (await col("Lost")).empty && await page.evaluate(() => document.querySelector(".cv-col.empty").getBoundingClientRect().width < 60));
    t("a card shows the date, guests, shop and amount", await page.evaluate(() => { const k = [...document.querySelectorAll(".cv-card")].find((x) => /Omar Reyes/.test(x.textContent)); return /Acme Realty/.test(k.textContent) && k.querySelector(".cv-ev").textContent === "Holiday party" && k.querySelectorAll(".cv-facts span").length === 3 && k.querySelector(".cv-val").textContent === "$2,480.00" && k.querySelector(".cv-kind").textContent === "Private event"; }));
    t("the board's column heading is not styled as the page header", await page.evaluate(() => !document.querySelector("#catList header, #catList footer")));
    await shot(page, "views-board");
    await page.click('#catChips .chip:has-text("All")');
    t("All adds the lost and past leads to their columns", (await col("Lost")).cards.includes("Will Turner") && (await col("Paid")).cards.includes("Grace Kim"));
    await page.click('#catChips .chip:has-text("Open")');
    await page.click('#catList .cv-card:has-text("Omar Reyes")');
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("a click on a card opens the lead", (await page.textContent("#catTitle")) === "Omar Reyes — Acme Realty");
    await page.evaluate(() => catClose());
    await page.fill("#catFind", "raclette");
    t("search works on the board", JSON.stringify(await page.$$eval(".cv-card .cv-nm b", (b) => b.map((x) => x.textContent).sort())) === JSON.stringify(["Sam Lee", "Tom Becker"]));
    await page.fill("#catFind", "");
    t("the view is remembered", (await page.evaluate(() => localStorage.getItem("cat_view"))) === "board");
    await page.click('.cv-seg button[data-v="table"]');
    t("and so is switching back", (await page.evaluate(() => localStorage.getItem("cat_view"))) === "table" && (await page.getAttribute("#catList", "class")) === "rec-list cv-table");
    t("nothing here was written to the database by looking", st.updates.length === 0, st.updates);
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { view: "board" });
    t("the page opens on the board when that was the last view", (await page.getAttribute("#catList", "class")) === "rec-list cv-board" && (await page.getAttribute('.cv-seg button[data-v="board"]', "aria-pressed")) === "true" && st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · 💼 Catering Leads → Calendar");
  const ym = (d) => d.slice(0, 7);
  const monthName = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // the open leads that have a date: [date, guests, proposal cents]
  const OPEN_DATED = [[day(20), 20, 0], [day(28), 40, 248000], [day(9), 60, 131250], [day(41), 120, 685000], [day(6), 24, 410000], [day(3), 6, 42000], [day(18), 250, 1234567], [day(11), 6, 0], [day(16), 8, 0]];
  const sumFor = (m) => { const x = OPEN_DATED.filter((r) => ym(r[0]) === m), g = x.reduce((n, r) => n + r[1], 0), v = x.reduce((n, r) => n + r[2], 0); return x.length ? x.length + (x.length === 1 ? " event" : " events") + (g ? g.toLocaleString("en-US") + " guests" : "") + (v ? money(v) : "") : null; };
  {
    const { ctx, page, st } = await open(browser);
    const today = day(0);
    const title = () => page.textContent("#catList .cv-month");
    const show = (m) => page.evaluate((mm) => catMonthStep(mm), m);
    const inDay = (d, box) => page.$$eval("#catList " + (box || ".cv-calgrid") + ' [data-d="' + d + '"] .cv-item .nm span', (x) => x.map((y) => y.textContent));
    await page.click('.cv-seg button[data-v="calendar"]');
    t("Calendar is the third view, and it is remembered", (await page.getAttribute("#catList", "class")) === "rec-list cv-calendar" && (await page.getAttribute('.cv-seg button[data-v="calendar"]', "aria-pressed")) === "true" && (await page.$$eval(".cv-seg button", (b) => b.map((x) => x.textContent).join())) === "Table,Board,Calendar" && (await page.evaluate(() => localStorage.getItem("cat_view"))) === "calendar");
    t("the calendar starts on All, so past and lost jobs are on it", (await page.textContent("#catChips .chip.on")) === "All" && (await page.evaluate(() => CAT_FILTER)) === "all");
    await page.click('#catChips .chip:has-text("Open")');
    t("it opens on this month", (await title()) === monthName(ym(today)));
    t("whole weeks, Sunday first, with today marked", await page.evaluate((td) => { const d = [...document.querySelectorAll("#catList .cv-calgrid .cv-day")], dow = [...document.querySelectorAll("#catList .cv-dow")].map((x) => x.textContent).join(); const marked = document.querySelectorAll("#catList .cv-calgrid .cv-day.today");
      return dow === "Sun,Mon,Tue,Wed,Thu,Fri,Sat" && d.length % 7 === 0 && d.length >= 28 && new Date(d[0].dataset.d + "T12:00:00").getDay() === 0 && marked.length === 1 && marked[0].dataset.d === td && d.every((x, i) => i === 0 || x.dataset.d > d[i - 1].dataset.d); }, today));
    t("this month's total sits beside the month name", (await page.textContent("#catList .cv-calsum")).replace(/Go to .*/, "") === (sumFor(ym(today)) || "Nothing this month"), [await page.textContent("#catList .cv-calsum"), sumFor(ym(today))]);
    t("the stage chips are the full set, as on the table", (await chips(page)).length === 11 && !(await shown(page, "#catColsReset")));
    await show(ym(day(28)));
    t("a lead sits on its event date", (await inDay(day(28))).includes("Omar Reyes") && (await title()) === monthName(ym(day(28))), await inDay(day(28)));
    t("its tile carries the kind color, a stage dot, guests and the amount", await page.evaluate(() => { const k = [...document.querySelectorAll("#catList .cv-calgrid .cv-item")].find((x) => /Omar Reyes/.test(x.textContent)); return k.style.getPropertyValue("--kc") === "#7c3aed" && k.querySelector(".cv-sd").classList.contains("st-replied") && [...k.querySelectorAll(".meta span")].map((x) => x.textContent).join("|") === "40 guests|$2,480.00" && /Acme Realty/.test(k.title) && /Holiday party/.test(k.title); }));
    t("the month total follows the month shown", (await page.textContent("#catList .cv-calsum")) === sumFor(ym(day(28))), [await page.textContent("#catList .cv-calsum"), sumFor(ym(day(28)))]);
    await show(ym(day(20)));
    t("the time shows when the lead has one", await page.evaluate(() => [...document.querySelectorAll("#catList .cv-calgrid .cv-item")].find((x) => /Jane Smith/.test(x.textContent)).querySelector(".meta span").textContent === "6 PM"));
    await show(ym(day(16)));
    t("experience inquiries are on it too, under their own date", (await inDay(day(16))).includes("Kelly Nguyen") && await page.evaluate(() => [...document.querySelectorAll("#catList .cv-calgrid .cv-item")].find((x) => /Kelly Nguyen/.test(x.textContent)).querySelector(".meta").textContent === "7 PM8 guests"));
    t("a lead with no date waits in the strip underneath", (await page.textContent("#catList .cv-undated .lbl")) === "No date yet (1)" && (await page.$$eval("#catList .cv-undated .cv-item .nm span", (x) => x.map((y) => y.textContent))).join() === "Ana Flores");
    t("names are written as text here as well", await page.evaluate(() => !window.__xss && !document.querySelector("#catList img, #catList script")));
    await shot(page, "views-calendar");

    console.log("\n  moving between months");
    await show("");
    await page.click('#catList .cv-navb[aria-label="Next month"]');
    const next = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })();
    const prev = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })();
    t("› goes to next month", (await title()) === monthName(next));
    await page.click('#catList .cv-navb[aria-label="Previous month"]');
    await page.click('#catList .cv-navb[aria-label="Previous month"]');
    t("‹ goes back", (await title()) === monthName(prev));
    await page.click("#catList .cv-todayb");
    t("Today comes back to this month", (await title()) === monthName(ym(today)) && (await page.$$("#catList .cv-day.today")).length === 1);
    await page.evaluate(() => catMonthStep(9));
    const lastMonth = OPEN_DATED.map((r) => ym(r[0])).sort().pop();
    t("an empty month says so and offers the nearest month that has something", /^Nothing this month/.test(await page.textContent("#catList .cv-calsum")) && (await page.textContent("#catList .cv-jump")) === "Go to " + monthName(lastMonth) && (await page.$$("#catList .cv-calgrid .cv-item")).length === 0, await page.textContent("#catList .cv-calsum"));
    await page.click("#catList .cv-jump");
    t("…and goes there", (await title()) === monthName(lastMonth) && (await inDay(day(41))).includes("Marcus Lee"));

    console.log("\n  filters and opening a lead");
    await show(ym(day(-4)));
    t("Open leaves a past, paid job off the calendar", !(await inDay(day(-4))).includes("Grace Kim"));
    await page.click('#catChips .chip:has-text("All")');
    t("All shows it", (await inDay(day(-4))).includes("Grace Kim"));
    await show(ym(day(60)));
    t("a lost lead is struck through", await page.evaluate(() => { const k = [...document.querySelectorAll("#catList .cv-calgrid .cv-item")].find((x) => /Will Turner/.test(x.textContent)); return !!k && k.classList.contains("lost") && getComputedStyle(k.querySelector(".nm span")).textDecorationLine === "line-through"; }));
    await page.click('#catChips .chip:has-text("Open")');
    await show(ym(day(28)));
    await page.click('#catKinds .ctab:has-text("Private events")');
    t("a kind button narrows the calendar", (await page.$$eval("#catList .cv-calgrid .cv-item .nm span", (x) => x.map((y) => y.textContent))).every((n) => ["Omar Reyes", "Lucia Romano"].includes(n)) && (await inDay(day(28))).join() === "Omar Reyes");
    await page.click('#catKinds .ctab:has-text("All inquiries")');
    await page.fill("#catFind", "omar");
    t("so does the search box", (await page.$$eval("#catList .cv-calgrid .cv-item .nm span", (x) => x.map((y) => y.textContent))).join() === "Omar Reyes" && !(await page.$("#catList .cv-undated")));
    await page.fill("#catFind", "");
    await page.click('#catList .cv-calgrid .cv-item:has-text("Omar Reyes")');
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("a click on a tile opens the lead", (await page.textContent("#catTitle")) === "Omar Reyes — Acme Realty");
    await page.evaluate(() => catClose());
    t("the calendar stays on the month you were looking at", (await title()) === monthName(ym(day(28))));
    await show(ym(day(11)));
    await page.focus('#catList .cv-calgrid .cv-item:has-text("Sam Lee")');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("inqModal").style.display === "flex");
    t("Enter on a tile opens it (an inquiry opens its own window)", /Sam Lee/.test(await page.textContent("#inqTitle")));
    await page.evaluate(() => { document.getElementById("inqModal").style.display = "none"; });
    t("looking at the calendar wrote nothing", st.updates.length === 0, st.updates);
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { view: "calendar" });
    t("the page opens on the calendar when that was the last view, on All", (await page.getAttribute("#catList", "class")) === "rec-list cv-calendar" && (await page.textContent("#catChips .chip.on")) === "All" && st.errors.length === 0, st.errors);
    await ctx.close();
  }
  {
    const { ctx, page, st } = await open(browser, { viewport: { width: 390, height: 844 }, touch: true, view: "calendar" });
    await page.evaluate((m) => catMonthStep(m), ym(day(28)));
    t("on a phone the month is a list of days, not a grid", !(await shown(page, "#catList .cv-calgrid")) && (await shown(page, "#catList .cv-agenda")));
    t("only days with something on them, in date order", await page.evaluate((m) => { const d = [...document.querySelectorAll("#catList .cv-agenda .cv-agday")]; return d.length > 0 && d.every((x, i) => x.dataset.d.slice(0, 7) === m && x.querySelector(".cv-item") && (i === 0 || x.dataset.d > d[i - 1].dataset.d)); }, ym(day(28))));
    t("the lead is under its day", (await page.$$eval('#catList .cv-agenda [data-d="' + day(28) + '"] .cv-item .nm span', (x) => x.map((y) => y.textContent))).includes("Omar Reyes"));
    t("nothing runs off the side of the screen", await page.evaluate(() => { const w = document.documentElement.clientWidth; return document.documentElement.scrollWidth <= w + 1 && [...document.querySelectorAll("#catList .cv-agenda .cv-item, #catList .cv-calhead, .cv-seg")].every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= w + 1; }); }));
    await shot(page, "views-calendar-phone");
    await page.tap('#catList .cv-agenda .cv-item:has-text("Omar Reyes")');
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("a tap opens the lead", (await page.textContent("#catTitle")) === "Omar Reyes — Acme Realty");
    await page.evaluate(() => { catClose(); catMonthStep(9); });
    t("an empty month reads 'Nothing this month.'", (await page.textContent("#catList .cv-agenda")) === "Nothing this month.");
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · 💼 Catering Leads on a phone (390 wide)");
  {
    const { ctx, page, st } = await open(browser, { viewport: { width: 390, height: 844 }, touch: true });
    t("no column headings or totals row — each lead is two lines", !(await shown(page, "#catList thead")) && !(await shown(page, "#catList tfoot")) && (await shown(page, "#catList tbody td.c-sum")) && !(await shown(page, "#catList tbody td.c-email")));
    t("line two reads occasion, date, guests, shop, amount", (await cellOf(page, "Omar Reyes", "c-sum")).replace(/[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+(, \d{4})?/, "DATE") === "Holiday party, DATE, 40 guests, Nashville, $2,480.00", await cellOf(page, "Omar Reyes", "c-sum"));
    t("nothing runs off the side of the screen", await page.evaluate(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll("#catList tbody tr, #catList td.c-stage .cv-chip, #catViewBar, #catTools")].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.left >= 0 && r.right <= w + 1); }) && document.documentElement.scrollWidth <= w + 1; }));
    t("the big stage buttons scroll sideways in their own row; the type pills wrap", await page.evaluate(() => { const s = document.getElementById("catChips"), k = document.getElementById("catKinds"), w = document.documentElement.clientWidth; return s.scrollWidth > s.clientWidth + 20 && getComputedStyle(s).flexWrap === "nowrap" && [...k.querySelectorAll(".ctab")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= w; }) && k.getBoundingClientRect().height > 60; }));
    await shot(page, "views-table-phone");
    await page.tap('#catList tbody tr:has-text("Omar Reyes")');
    await page.waitForFunction(() => document.getElementById("catModal").style.display === "flex");
    t("a tap opens the lead", (await page.textContent("#catTitle")) === "Omar Reyes — Acme Realty");
    await page.evaluate(() => catClose());
    await page.tap('.cv-seg button[data-v="board"]');
    t("the board scrolls sideways inside the list, not the page", await page.evaluate(() => { const c = document.querySelector("#catList .cv-cols"); return c.scrollWidth > c.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; }));
    await shot(page, "views-board-phone");
    t("no errors on the page", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  await browser.close();
  console.log("\n" + ok + " passed, " + bad + " failed");
  process.exit(bad ? 1 : 0);
})();
