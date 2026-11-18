/*
 * The reply editor in 💼 Catering Leads (manager.html, 2026-11-17 — "when replying we need a full editor, add file,
 * add link etc."): formatting, links, pictures in the message, attached files, paste, what gets posted to the
 * catering / inquiries functions, how the thread draws a formatted reply, quick replies and templates.
 * The page is served under the staging host; Supabase (tables + Storage), the two functions and the CDNs are stood
 * in — nothing goes to the network.
 * Run: NODE_PATH=$(npm root -g) node tests/test-lead-reply-editor.js     (SHOTS=dir for screenshots, PW_CHROME=path, MANAGER=file)
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const HOST = "https://greys-staff-portal-staging.onrender.com";
const SB = "https://vdvtrevhqalmjwhjhjug.supabase.co";
const PUB = SB + "/storage/v1/object/public/lead-files/";
const MANAGER = fs.readFileSync(process.env.MANAGER || path.join(__dirname, "..", "manager.html")); // MANAGER=<file> to test another copy (the staging branch's)
const SHOTS = process.env.SHOTS || "";
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 900) : "")); } };

// a real PNG of a given size (so the page can read its width)
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x99);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG_800 = png(800, 600), PNG_120 = png(120, 90);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

const L1 = "11111111-2222-3333-4444-555555555555", L2 = "22222222-2222-3333-4444-555555555555", I1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", TPL = "77777777-0000-0000-0000-000000000001";
const fresh = () => ({
  catering_leads: [
    { id: L1, code: "AB12CD", name: "Jane Smith", company: "", email: "jane@example.com", phone: "9015550100", stage: "new", unread: false, occasion: "Birthday dinner", location: "Memphis",
      event_date: "2026-12-12", event_time: "18:00", guests: 20, fulfillment: "pickup", last_message_at: "2026-11-17T20:00:00Z", created_at: "2026-11-17T19:00:00Z" },
    { id: L2, code: "EF56AB", name: "Omar Reyes", company: "Acme", email: "omar@example.com", stage: "replied", unread: false, occasion: "Private event", location: "Nashville",
      event_date: "2026-12-20", guests: 40, last_message_at: "2026-11-16T20:00:00Z", created_at: "2026-11-16T19:00:00Z" },
  ],
  catering_messages: [
    { id: "m1", lead_id: L1, direction: "in", body: "Hi! Do you do boards for 20?\nThanks", sent_by: "jane@example.com", created_at: "2026-11-17T19:00:00Z" },
    { id: "m2", lead_id: L1, direction: "out", body: "Plain old reply with https://greyscheese.com in it", sent_by: "manager@greyscheese.com", email_status: "sent", created_at: "2026-11-17T19:10:00Z" },
    { id: "m3", lead_id: L1, direction: "out", sent_by: "manager@greyscheese.com", email_status: "sent", created_at: "2026-11-17T19:20:00Z",
      body: "Hi Jane, the menu: https://greyscheese.com/catering is attached.\n\n📎 Private Events.pdf — " + PUB + "cat/" + L1 + "/aaaaaaaaaaaaaaaa/Private-Events.pdf",
      body_html: 'Hi <b>Jane</b>, the <a href="https://greyscheese.com/catering">menu</a> is attached.<ul><li>Boards</li><li>Boxes</li></ul>'
        + '<img src="x" onerror="window.__xss=1"><a href="javascript:window.__xss=2">bad link</a><script>window.__xss=3</script><span style="color:#b91c1c;position:fixed;top:0">red</span>',
      attachments: [{ name: "Private Events.pdf", url: PUB + "cat/" + L1 + "/aaaaaaaaaaaaaaaa/Private-Events.pdf", path: "cat/" + L1 + "/aaaaaaaaaaaaaaaa/Private-Events.pdf", size: 2400000, type: "application/pdf", sent: "attached" },
        { name: "menu.docx", url: PUB + "cat/" + L1 + "/bbbbbbbbbbbbbbbb/menu.docx", path: "x", size: 60000, type: "application/msword", sent: "link" },
        { name: "evil", url: "javascript:window.__xss=4", size: 1, type: "x", sent: "link" }] },
    { id: "m4", lead_id: L1, direction: "out", sent_by: "manager@greyscheese.com", email_status: "sent", created_at: "2026-11-17T19:25:00Z",
      body: "Here is the file\n\n📎 board.jpg — " + PUB + "cat/" + L1 + "/cccccccccccccccc/board.jpg",
      attachments: [{ name: "board.jpg", url: PUB + "cat/" + L1 + "/cccccccccccccccc/board.jpg", size: 800000, type: "image/jpeg", sent: "attached" }] },
  ],
  catering_quotes: [],
  inquiries: [{ id: I1, code: "EF34AB", name: "Sam Lee", email: "sam@example.com", phone: "6155550100", stage: "new", unread: false, experience_name: "Raclette", experience_type_id: "exp-1",
    preferred_date: "2026-12-05", preferred_time: "18:00", party_size: 6, location: "Memphis", last_message_at: "2026-11-17T18:00:00Z", created_at: "2026-11-17T18:00:00Z", details: {} }],
  inquiry_messages: [{ id: "q1", inquiry_id: I1, direction: "in", body: "Can we do raclette for 6?", sent_by: "sam@example.com", created_at: "2026-11-17T18:00:00Z" }],
  catering_templates: [{ id: TPL, kind: "email", title: "Celebration inquiry", category: "Inquiries", location: "", active: true, sort: 1, items: [],
    body: "Hi {{first_name}},\n\nThank you for reaching out to Greys Fine Cheeses about your {{occasion}}!", attachments: ["GREYS - Private Events Memphis 2023-2024.pdf"] }],
  site_content: [],
});

// supabase-js stand-in: tables and Storage are answered by this test (https://stub.local/…)
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
    storage: { from: function(bucket){ return {
      upload: function(path, file, opts){ return ask('upload', { bucket: bucket, path: path, name: file.name, size: file.size, type: file.type, opts: opts }); },
      getPublicUrl: function(path){ return { data: { publicUrl: '${SB}/storage/v1/object/public/' + bucket + '/' + path } }; },
      list: function(){ return Promise.resolve({ data: [], error: null }); }
    }; } },
    channel: function(){ var c = { on: function(){ return c; }, subscribe: function(){ return c; } }; return c; }, removeChannel: function(){}
  };
  window.supabase = { createClient: function(){ return client; } };
})();`;

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const st = { errors: [], uploads: [], calls: [], rows: fresh(), rich: true, replyStatus: 200, replyError: "" };
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
      if (upd) { hit.forEach((r) => Object.assign(r, upd[1])); return json({ data: hit, error: null }); }
      let rows = hit.map((r) => Object.assign({}, r));
      if (q.table === "catering_leads") rows.forEach((r) => { r.catering_messages = st.rows.catering_messages.filter((m) => m.lead_id === r.id); r.catering_quotes = []; });
      if (q.table === "inquiries") rows.forEach((r) => { r.inquiry_messages = st.rows.inquiry_messages.filter((m) => m.inquiry_id === r.id); });
      return json({ data: q.single ? (rows[0] || null) : rows, error: null });
    }
    if (u.hostname === "stub.local" && u.pathname === "/upload") {
      const up = JSON.parse(req.postData());
      st.uploads.push(up);
      if (/slow/.test(up.name)) await new Promise((r) => setTimeout(r, 1500));
      return json(/fail/.test(up.name) ? { data: null, error: { message: "new row violates row-level security policy" } } : { data: { path: up.path }, error: null });
    }
    const fn = /^\/functions\/v1\/(catering|inquiries)$/.exec(u.pathname);
    if (fn) {
      const action = u.searchParams.get("action"), b = JSON.parse(req.postData() || "{}");
      st.calls.push({ fn: fn[1], action, body: b, auth: req.headers()["authorization"] });
      if (action === "reply") {
        if (st.replyStatus !== 200) return json({ ok: false, error: st.replyError }, st.replyStatus);
        const files = (b.attachments || []).map((a) => ({ name: a.name, sent: /\.(pdf|jpe?g|png)$/i.test(a.name) ? "attached" : "link" }));
        const table = fn[1] === "catering" ? "catering_messages" : "inquiry_messages", key = fn[1] === "catering" ? "lead_id" : "inquiry_id";
        const row = { id: "n" + st.calls.length, [key]: b[key], direction: "out", body: b.body, sent_by: "manager@greyscheese.com", email_status: "sent", created_at: new Date().toISOString() };
        if (st.rich && b.html) { row.body_html = b.html; if (files.length) row.attachments = (b.attachments || []).map((a, i) => ({ name: a.name, url: PUB + a.path, path: a.path, size: 1000, type: "x", sent: files[i].sent })); }
        st.rows[table].push(row);
        return json(st.rich ? { ok: true, stage: "replied", rich: true, files } : { ok: true, stage: "replied" });
      }
      if (action === "log") { st.rows[fn[1] === "catering" ? "catering_messages" : "inquiry_messages"].push({ id: "n" + st.calls.length, lead_id: b.lead_id, inquiry_id: b.inquiry_id, direction: b.note ? "note" : "in", body: b.body, sent_by: "staff note", created_at: new Date().toISOString() }); return json({ ok: true }); }
      return json({ ok: true });
    }
    if (u.href.indexOf(PUB) === 0) return route.fulfill({ status: 200, contentType: "image/png", body: PNG_120 });
    if (u.origin === HOST && (u.pathname === "/manager.html" || u.pathname === "/manager")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MANAGER });
    if (/\.js(\?|$)/.test(u.pathname + u.search)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (/\.(png|svg|ico|jpg|webp)$/.test(u.pathname)) return route.fulfill({ status: 404, body: "" });
    return json({});
  });
  await page.goto(HOST + "/manager.html");
  await page.waitForFunction(() => !document.getElementById("consoleView").classList.contains("hide"), null, { timeout: 15000 });
  await page.evaluate(async () => { mtab("catering"); await catLoad(); await inqLoad(); });
  return { ctx, page, st };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } };
const html = (page, id) => page.evaluate((i) => document.querySelector("#" + i + " .rr-area").innerHTML, id);
const msg = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);
const selectText = (page, id, text) => page.evaluate(([i, tx]) => {
  const area = document.querySelector("#" + i + " .rr-area"), w = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { const at = n.nodeValue.indexOf(tx); if (at >= 0) { const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + tx.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); area.focus(); document.dispatchEvent(new Event("selectionchange")); return true; } }
  return false;
}, [id, text]);
const paste = (page, id, data) => page.evaluate(async ([i, d]) => {
  const area = document.querySelector("#" + i + " .rr-area"); area.focus();
  const dt = new DataTransfer();
  if (d.html) dt.setData("text/html", d.html);
  if (d.text) dt.setData("text/plain", d.text);
  if (d.png) dt.items.add(new File([Uint8Array.from(atob(d.png), (c) => c.charCodeAt(0))], d.name || "image.png", { type: "image/png" }));
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  area.dispatchEvent(ev);
  return ev.defaultPrevented;
}, [id, data]);
const btn = (page, id, sel) => page.locator("#" + id + " .rr-bar " + sel);
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

  console.log("\nmanager.html · 💼 Catering Leads → a lead → Reply");
  {
    const { ctx, page, st } = await open(browser);
    await page.evaluate((id) => catOpen(id), L1);
    await wait(page, () => document.querySelectorAll("#catThread > div").length >= 4);
    t("the reply box is the editor", await page.evaluate(() => !!document.querySelector("#catBody.rr .rr-bar") && !!document.querySelector("#catBody .rr-area[contenteditable=true]") && !document.querySelector("textarea#catBody")));
    t("toolbar: size, B I U S, color, lists, quote, align, link, picture, attach, clear", await page.evaluate(() => {
      const bar = document.querySelector("#catBody .rr-bar"), has = (s) => !!bar.querySelector(s);
      return ["undo", "redo", "bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList", "justifyLeft", "justifyCenter", "justifyRight", "removeFormat"].every((c) => has('[data-cmd="' + c + '"]'))
        && ["color", "quote", "link", "image", "file"].every((a) => has('[data-act="' + a + '"]')) && has("select.rr-size");
    }));
    t("placeholder shows while it is empty", await page.evaluate(() => getComputedStyle(document.querySelector("#catBody .rr-area"), "::before").content.includes("Write your reply")));
    t("the toolbar is one row on a desktop", await page.evaluate(() => { const b = [...document.querySelectorAll("#catBody .rr-bar > *")].map((x) => x.getBoundingClientRect().top); return Math.max.apply(null, b) - Math.min.apply(null, b) < 12; }), await page.evaluate(() => document.querySelector("#catBody .rr-bar").getBoundingClientRect().height));

    // --- the thread ---
    const thread = await page.evaluate(() => document.getElementById("catThread").innerHTML);
    t("thread: a formatted reply shows its formatting", /<div class="rr-view">Hi <b>Jane<\/b>, the <a href="https:\/\/greyscheese\.com\/catering" target="_blank" rel="noopener">menu<\/a> is attached\.<ul><li>Boards<\/li><li>Boxes<\/li><\/ul>/.test(thread), thread.slice(0, 1500));
    t("thread: nothing in a stored message can run", await page.evaluate(() => window.__xss === undefined) && !/<script|onerror|javascript:|position:\s*fixed/i.test(thread));
    t("thread: the bad link keeps its words, the color stays", /bad link<span style="color:\s*(#b91c1c|rgb\(185,\s*28,\s*28\));?">red<\/span>/.test(thread), thread.match(/bad link.{0,80}/));
    t("thread: files are chips that open the file", await page.evaluate((pub) => { const a = [...document.querySelectorAll("#catThread a.rr-att")]; return a.length === 3 && a[0].href.indexOf(pub) === 0 && a[0].target === "_blank" && /Private Events\.pdf/.test(a[0].textContent) && /2\.3 MB · attached/.test(a[0].textContent) && /menu\.docx/.test(a[1].textContent) && /link/.test(a[1].textContent) && /board\.jpg/.test(a[2].textContent); }, PUB), thread.match(/rr-atts.{0,400}/));
    t("thread: a file with a bad address is left out", !/evil/.test(thread));
    t("thread: plain rows are drawn as before", /<div style="white-space:pre-wrap;font-size:\.9rem;">Hi! Do you do boards for 20\?\nThanks<\/div>/.test(thread) && /Plain old reply with https:\/\/greyscheese\.com in it<\/div>/.test(thread));
    t("thread: a plain row with files shows the text once and the chip", /<div style="white-space:pre-wrap;font-size:\.9rem;">Here is the file<\/div><div class="rr-atts">/.test(thread), thread.match(/Here is the file.{0,200}/));

    // --- formatting ---
    const area = page.locator("#catBody .rr-area");
    await area.click();
    await page.keyboard.type("Hello Jane thanks for asking");
    await selectText(page, "catBody", "Hello");
    await btn(page, "catBody", '[data-cmd="bold"]').click();
    t("bold", /<b>Hello<\/b> Jane/.test(await html(page, "catBody")), await html(page, "catBody"));
    t("…and the B button lights up", await btn(page, "catBody", '[data-cmd="bold"]').evaluate((b) => b.classList.contains("on")));
    await selectText(page, "catBody", "Jane"); await btn(page, "catBody", '[data-cmd="italic"]').click();
    await selectText(page, "catBody", "thanks"); await btn(page, "catBody", '[data-cmd="underline"]').click();
    await selectText(page, "catBody", "for"); await btn(page, "catBody", '[data-cmd="strikeThrough"]').click();
    let h1 = await html(page, "catBody");
    t("italic, underline, strike", /<i>Jane<\/i>/.test(h1) && /<u>thanks<\/u>/.test(h1) && /<strike>for<\/strike>|<s>for<\/s>/.test(h1), h1);
    await selectText(page, "catBody", "asking");
    await page.locator("#catBody select.rr-size").selectOption("5");
    t("text size: Large", /<font size="5">asking<\/font>/.test(await html(page, "catBody")), await html(page, "catBody"));
    t("…and the size box follows the caret: Large there, Normal in plain text", await page.evaluate(() => {
      const sel = document.querySelector("#catBody select.rr-size"), area = document.querySelector("#catBody .rr-area"), at = (node, off) => { const r = document.createRange(); r.setStart(node, off); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); area.dispatchEvent(new Event("keyup")); return sel.value; };
      const big = area.querySelector("font[size='5']").firstChild, plain = [...area.childNodes].find((n) => n.nodeType === 3 && /Jane|thanks| /.test(n.nodeValue));
      return at(big, 2) === "5" && at(plain, 0) === "3";
    }));
    await selectText(page, "catBody", "asking");
    await btn(page, "catBody", '[data-act="color"]').click();
    await page.locator('#catBody .rr-pop [data-c="#b91c1c"]').click();
    h1 = await html(page, "catBody");
    t("text color: red", /color="#b91c1c"/.test(h1) && /asking/.test(h1) && await page.evaluate(() => document.querySelector("#catBody .rr-pop").hidden), h1);
    await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
    await btn(page, "catBody", '[data-cmd="insertUnorderedList"]').click();
    await page.keyboard.type("Pick-up"); await page.keyboard.press("Enter"); await page.keyboard.type("Delivery"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    t("bulleted list", /<ul><li>Pick-up<\/li><li>Delivery<\/li><\/ul>/.test((await html(page, "catBody")).replace(/<font[^>]*>|<\/font>/g, "")), await html(page, "catBody"));
    await btn(page, "catBody", '[data-cmd="insertOrderedList"]').click();
    await page.keyboard.type("First"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    t("numbered list", /<ol><li>First<\/li><\/ol>/.test((await html(page, "catBody")).replace(/<font[^>]*>|<\/font>/g, "")), await html(page, "catBody"));
    await page.keyboard.type("A quoted line");
    await btn(page, "catBody", '[data-act="quote"]').click();
    t("quote", /<blockquote[^>]*>.*A quoted line.*<\/blockquote>/.test(await html(page, "catBody")), await html(page, "catBody"));
    await btn(page, "catBody", '[data-act="quote"]').click();
    t("quote again takes it off", !/<blockquote/.test(await html(page, "catBody")), await html(page, "catBody"));
    await btn(page, "catBody", '[data-cmd="justifyCenter"]').click();
    t("center", /text-align:\s*center/.test(await html(page, "catBody")), await html(page, "catBody"));
    await btn(page, "catBody", '[data-cmd="justifyLeft"]').click();
    await btn(page, "catBody", '[data-cmd="undo"]').click();
    await btn(page, "catBody", '[data-cmd="redo"]').click();
    t("undo / redo don't break anything", /A quoted line/.test(await html(page, "catBody")));

    // --- links ---
    await selectText(page, "catBody", "Delivery");
    await btn(page, "catBody", '[data-act="link"]').click();
    t("link box opens with the picked words", await page.evaluate(() => { const p = document.querySelector("#catBody .rr-pop"); return !p.hidden && p.querySelector(".rr-lt").value === "Delivery" && document.activeElement === p.querySelector(".rr-lu"); }));
    await page.locator("#catBody .rr-pop .rr-lu").fill("javascript:alert(1)");
    await page.locator("#catBody .rr-pop .rr-ok").click();
    t("a link that isn't a web address is refused", /doesn’t look like a link/.test(await page.locator("#catBody .rr-pop .err").textContent()) && !/javascript/.test(await html(page, "catBody")));
    await page.locator("#catBody .rr-pop .rr-lu").fill("greyscheese.com/catering?a=1&b=2");
    await page.locator("#catBody .rr-pop .rr-lu").press("Enter");
    t("link: https:// is added for you", /<a href="https:\/\/greyscheese\.com\/catering\?a=1&amp;b=2">Delivery<\/a>/.test(await html(page, "catBody")), await html(page, "catBody"));
    await page.locator("#catBody .rr-area a", { hasText: "Delivery" }).click();
    t("clicking a link opens it for editing", await page.evaluate(() => { const p = document.querySelector("#catBody .rr-pop"); return !p.hidden && p.querySelector(".rr-lu").value === "https://greyscheese.com/catering?a=1&b=2" && /Save link/.test(p.textContent) && /Remove link/.test(p.textContent); }));
    await page.locator("#catBody .rr-pop .rr-lu").fill("https://greyscheese.com/menu");
    await page.locator("#catBody .rr-pop .rr-lt").fill("We deliver");
    await page.locator("#catBody .rr-pop .rr-ok").click();
    t("…and saves the new address and words", /<a href="https:\/\/greyscheese\.com\/menu">We deliver<\/a>/.test(await html(page, "catBody")), await html(page, "catBody"));
    await page.locator("#catBody .rr-area a", { hasText: "We deliver" }).click();
    await page.locator("#catBody .rr-pop .rr-rm").click();
    t("remove link keeps the words", !/<a /.test(await html(page, "catBody")) && /We deliver/.test(await html(page, "catBody")), await html(page, "catBody"));
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+k");
    t("Ctrl+K opens the link box", await page.evaluate(() => !document.querySelector("#catBody .rr-pop").hidden && !!document.querySelector("#catBody .rr-pop .rr-lu")));
    await page.locator("#catBody .rr-pop .rr-lt").fill("email us");
    await page.locator("#catBody .rr-pop .rr-lu").fill("info@greyscheese.com");
    await page.locator("#catBody .rr-pop .rr-ok").click();
    t("an email address becomes a mailto link", /<a href="mailto:info@greyscheese\.com">email us<\/a>/.test(await html(page, "catBody")), await html(page, "catBody"));
    await page.keyboard.type("or call");
    t("typing carries on after the link, not inside it", /<a href="mailto:info@greyscheese\.com">email us<\/a>(&nbsp;| )or call/.test(await html(page, "catBody")), (await html(page, "catBody")).slice(-200));
    t("a link put in a colored, large line is sent the way it looks", await page.evaluate(() => { const h = catEd().getHtml(); return /<a href="mailto:info@greyscheese\.com">email us<\/a>/.test(h) && !/rem/.test(h); }), await page.evaluate(() => catEd().getHtml()));
    await page.keyboard.press("Control+k"); await page.keyboard.press("Escape");
    t("Esc closes the link box", await page.evaluate(() => document.querySelector("#catBody .rr-pop").hidden));
    await shot(page, "01-formatting");

    // --- quick reply + template: added to what is there ---
    await page.locator("#catQuick").selectOption({ label: "Thanks — on it" });
    h1 = await html(page, "catBody");
    t("a quick reply is added after what is typed (nothing lost)", /<b>Hello<\/b>/.test(h1) && /<div><br><\/div><div>Thanks so much for thinking of us!/.test(h1) && !/Hi Jane,/.test(h1.split("Thanks so much")[1]), h1.slice(-400));
    await wait(page, () => [...document.querySelectorAll("#catQuick option")].some((o) => o.value.indexOf("t:") === 0));
    await page.locator("#catQuick").selectOption("t:" + TPL);
    h1 = await html(page, "catBody");
    t("an email template is added too, filled in", /<div>Hi Jane,<\/div><div><br><\/div><div>Thank you for reaching out to Greys Fine Cheeses about your Birthday dinner!<\/div>/.test(h1) && /<b>Hello<\/b>/.test(h1), h1.slice(-500));
    t("…and points at Attach file for what HoneyBook attached", /In HoneyBook this email attached GREYS - Private Events Memphis 2023-2024\.pdf — add it here with 📎 Attach file\./.test(await msg(page, "catMsg")), await msg(page, "catMsg"));
    t("older code still reads the box as text (.value)", await page.evaluate(() => { const v = document.getElementById("catBody").value; return typeof v === "string" && /^Hello Jane thanks for asking/.test(v) && /Thank you for reaching out/.test(v) && !/</.test(v); }), await page.evaluate(() => document.getElementById("catBody").value));

    // --- files ---
    await page.locator("#catBody .rr-in-file").setInputFiles([
      { name: "GREYS - Private Events Memphis 2023-2024.pdf", mimeType: "application/pdf", buffer: PDF },
      { name: "Menu & Pricing (v2).docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK docx") },
    ]);
    await wait(page, () => document.querySelectorAll("#catBody .rr-chip:not(.up)").length === 2);
    t("files upload to this lead's own folder", st.uploads.length === 2 && st.uploads.every((u) => u.bucket === "lead-files" && new RegExp("^cat/" + L1 + "/[a-f0-9]{32}/[A-Za-z0-9][A-Za-z0-9._-]*$").test(u.path) && u.opts.upsert === false), st.uploads);
    t("…with a clean file name and the right type", /\/GREYS---Private-Events-Memphis-2023-2024\.pdf$/.test(st.uploads[0].path) && st.uploads[0].opts.contentType === "application/pdf" && /\/Menu-Pricing-v2\.docx$/.test(st.uploads[1].path), st.uploads.map((u) => u.path));
    const chips = await page.evaluate(() => [...document.querySelectorAll("#catBody .rr-chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()));
    t("chips: the PDF is attached, the Word file goes as a link", /Private Events Memphis 2023-2024\.pdf.*attached/.test(chips[0]) && /Menu & Pricing \(v2\)\.docx.*as a link/.test(chips[1]), chips);
    t("…and the note under them explains it", /real attachments.*download link/.test(await page.locator("#catBody .rr-note").textContent()));
    await page.locator("#catBody .rr-in-file").setInputFiles([{ name: "party.mp4", mimeType: "video/mp4", buffer: Buffer.from("x") }]);
    await wait(page, () => !!document.querySelector("#catBody .rr-chip.err"));
    t("a file type that can't be sent says so", /can’t be sent from here/.test(await page.locator("#catBody .rr-note").textContent()) && st.uploads.length === 2, await page.locator("#catBody .rr-note").textContent());
    await page.locator("#catSend").click();
    t("send waits while a file is in trouble", /didn't upload/.test(await msg(page, "catMsg")) && !st.calls.some((c) => c.action === "reply"), await msg(page, "catMsg"));
    await page.locator("#catBody .rr-chip.err button").click();
    t("✕ takes a file off", await page.evaluate(() => document.querySelectorAll("#catBody .rr-chip").length === 2 && !document.querySelector("#catBody .rr-chip.err")));
    await page.locator("#catBody .rr-in-file").setInputFiles([{ name: "slow-photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") }]);
    await page.locator("#catSend").click();
    t("send waits for an upload in flight", /still uploading/.test(await msg(page, "catMsg")) && !st.calls.some((c) => c.action === "reply"), await msg(page, "catMsg"));
    await wait(page, () => document.querySelectorAll("#catBody .rr-chip:not(.up)").length === 3);

    // --- a picture in the message ---
    await page.keyboard.press("Control+End");
    await page.locator("#catBody .rr-in-img").setInputFiles([{ name: "The Board.png", mimeType: "image/png", buffer: PNG_800 }]);
    await wait(page, () => !!document.querySelector("#catBody .rr-area img"));
    const img = await page.evaluate(() => { const i = document.querySelector("#catBody .rr-area img"); return { src: i.getAttribute("src"), w: i.getAttribute("width"), alt: i.getAttribute("alt") }; });
    t("a picture goes into the message, sized to fit the email", img.src.indexOf(PUB + "cat/" + L1 + "/") === 0 && /\/The-Board\.png$/.test(img.src) && img.w === "536" && img.alt === "The Board", img);
    await page.locator("#catBody .rr-area img").click();
    await page.locator('#catBody .rr-pop [data-w="200"]').click();
    t("click a picture → Small", await page.evaluate(() => document.querySelector("#catBody .rr-area img").getAttribute("width")) === "200");
    await page.locator("#catBody .rr-pop .rr-x").click();
    await shot(page, "02-files-picture");

    // --- paste ---
    await page.keyboard.press("Control+End");
    const prevented = await paste(page, "catBody", { html: '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr" style="color:red;font-size:30px;margin:0">Pasted <b>bold</b> <span style="font-weight:700;color:#00f">strong</span> <a href="https://example.com/x" onclick="x()">a link</a><script>window.__xss=9</script><img src="https://evil.example/x.png" onerror="window.__xss=8"></p></b>', text: "Pasted bold strong a link" });
    h1 = await page.evaluate(() => catEd().getHtml());
    t("paste: bold / links stay; colors, sizes, scripts and outside pictures go", prevented && /Pasted <b>bold<\/b> <span style="font-weight:bold">strong<\/span> <a href="https:\/\/example\.com\/x">a link<\/a>/.test(h1) && !/evil|onclick|color:\s*red|30px|__xss|rem/.test(h1) && await page.evaluate(() => window.__xss === undefined), h1.slice(-500));
    t("paste: nothing Chrome added around it is sent (no rem sizes, no default color)", !/rem|rgb\(22,\s*26,\s*31\)|class=/.test(h1), h1.match(/.{0,60}(rem|rgb\(22).{0,60}/));
    const before = st.uploads.length;
    await paste(page, "catBody", { png: PNG_120.toString("base64"), name: "image.png" });
    await wait(page, () => document.querySelectorAll("#catBody .rr-area img").length === 2);
    t("paste: a screenshot becomes a picture in the message", st.uploads.length === before + 1 && /\/image\.png$/.test(st.uploads[before].path) && await page.evaluate(() => document.querySelectorAll("#catBody .rr-area img")[1].getAttribute("width")) === "120", st.uploads.slice(-1));

    // --- send ---
    await page.locator("#catSend").click();
    await wait(page, () => /Sent to/.test(document.getElementById("catMsg").textContent));
    const call = st.calls.find((c) => c.action === "reply");
    t("send: posted to the catering function with the manager's sign-in", !!call && call.fn === "catering" && call.auth === "Bearer tok-manager" && call.body.lead_id === L1, call && [call.fn, call.auth]);
    t("send: html carries the formatting, cleaned", /<b>Hello<\/b>/.test(call.body.html) && /<ul><li>(<span[^>]*>)?Pick-up(<\/span>)?<\/li>/.test(call.body.html) && /<a href="mailto:info@greyscheese\.com">email us<\/a>/.test(call.body.html) && !/<font/.test(call.body.html) && /<span style="[^"]*color:#b91c1c[^"]*">/.test(call.body.html) && /font-size:22px/.test(call.body.html), call.body.html);
    t("send: pictures ride in the html from this lead's folder", (call.body.html.match(/<img /g) || []).length === 2 && call.body.html.indexOf('<img src="' + PUB + "cat/" + L1 + "/") >= 0);
    t("send: body is the plain-text copy", /^Hello Jane thanks for asking/.test(call.body.body) && !/</.test(call.body.body) && /Pick-up\n/.test(call.body.body), call.body.body);
    t("send: attachments are path + name, uploaded ones only", JSON.stringify(call.body.attachments.map((a) => a.name)) === JSON.stringify(["GREYS - Private Events Memphis 2023-2024.pdf", "Menu & Pricing (v2).docx", "slow-photo.jpg"]) && call.body.attachments.every((a) => a.path.indexOf("cat/" + L1 + "/") === 0 && Object.keys(a).length === 2), call.body.attachments);
    t("send: says how the files went", /^✓ Sent to jane@example\.com — 2 files attached, 1 file as a link$/.test(await msg(page, "catMsg")), await msg(page, "catMsg"));
    t("send: the box is empty again, no chips", await page.evaluate(() => document.querySelector("#catBody .rr-area").innerHTML === "" && !document.querySelector("#catBody .rr-chip") && document.querySelector("#catBody .rr-note").textContent === ""));
    await wait(page, () => /Pick-up/.test(document.getElementById("catThread").textContent));
    t("send: the thread shows it formatted, with its files", await page.evaluate(() => { const last = [...document.querySelectorAll("#catThread > div")].pop(); return !!last.querySelector(".rr-view b") && !!last.querySelector(".rr-view ul") && last.querySelectorAll("a.rr-att").length === 3 && last.querySelectorAll(".rr-view img").length === 2; }));
    t("send: the lead's stage follows", await page.evaluate(() => document.getElementById("catStage").value) === "replied");
    await shot(page, "03-sent");

    // --- a reply with no formatting goes like the old box ---
    await area.click();
    await page.keyboard.type("Just a plain line"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("Second line https://greyscheese.com");
    await page.locator("#catSend").click();
    await wait(page, () => /Sent to/.test(document.getElementById("catMsg").textContent) && document.querySelector("#catBody .rr-area").innerHTML === "");
    const plain = st.calls.filter((c) => c.action === "reply")[1];
    t("plain text: posted as { lead_id, body } only", JSON.stringify(plain.body) === JSON.stringify({ lead_id: L1, body: "Just a plain line\n\nSecond line https://greyscheese.com" }), plain.body);
    t("plain text: ✓ Sent", (await msg(page, "catMsg")) === "✓ Sent to jane@example.com", await msg(page, "catMsg"));

    // --- nothing typed ---
    await page.locator("#catSend").click();
    t("nothing typed: Write a reply first", (await msg(page, "catMsg")) === "Write a reply first." && st.calls.filter((c) => c.action === "reply").length === 2);
    await area.click(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await page.locator("#catSend").click();
    t("only blank lines: still nothing to send", (await msg(page, "catMsg")) === "Write a reply first." && st.calls.filter((c) => c.action === "reply").length === 2);

    // --- notes ---
    await page.evaluate(() => catEd().reset());
    await area.click(); await page.keyboard.type("Called her, wants "); await btn(page, "catBody", '[data-cmd="bold"]').click(); await page.keyboard.type("gluten free");
    await page.locator("#catBody .rr-in-file").setInputFiles([{ name: "keep.pdf", mimeType: "application/pdf", buffer: PDF }]);
    await wait(page, () => document.querySelectorAll("#catBody .rr-chip:not(.up)").length === 1);
    await page.locator("#catModal button", { hasText: "Add note" }).click();
    await wait(page, () => /Note added/.test(document.getElementById("catMsg").textContent));
    const note = st.calls.find((c) => c.action === "log");
    t("a note is saved as text", !!note && note.body.body === "Called her, wants gluten free" && note.body.note === true, note && note.body);
    t("…and the attached file waits for the reply", /files are still here/.test(await msg(page, "catMsg")) && await page.evaluate(() => document.querySelector("#catBody .rr-area").innerHTML === "" && document.querySelectorAll("#catBody .rr-chip").length === 1));

    // --- files alone ---
    await page.locator("#catSend").click();
    await wait(page, () => /Sent to/.test(document.getElementById("catMsg").textContent));
    const only = st.calls.filter((c) => c.action === "reply")[2];
    t("a file with no words still sends", only.body.html === "" && only.body.attachments.length === 1 && only.body.attachments[0].name === "keep.pdf" && /1 file attached/.test(await msg(page, "catMsg")), only.body);

    // --- the server says no ---
    st.replyStatus = 400; st.replyError = "One of the files didn't finish uploading — remove it and add it again.";
    await area.click(); await page.keyboard.type("Try"); await selectText(page, "catBody", "Try"); await btn(page, "catBody", '[data-cmd="bold"]').click();
    await page.locator("#catSend").click();
    await wait(page, () => /❌/.test(document.getElementById("catMsg").textContent));
    t("an error from the function is shown and the message is kept", /didn't finish uploading/.test(await msg(page, "catMsg")) && /<b>Try<\/b>/.test(await html(page, "catBody")) && await page.evaluate(() => !document.getElementById("catSend").disabled));
    st.replyStatus = 200;
    // --- an email function from before the editor ---
    st.rich = false;
    await page.locator("#catSend").click();
    await wait(page, () => /⚠/.test(document.getElementById("catMsg").textContent));
    t("an old email function: warns that it went as plain text", /as plain text — the formatting and files did not go/.test(await msg(page, "catMsg")), await msg(page, "catMsg"));
    st.rich = true;

    // --- the draft survives a slip of the mouse and a close ---
    await page.evaluate(() => catEd().reset());
    await area.click(); await page.keyboard.type("draft for Jane");
    await page.locator("#catBody .rr-in-file").setInputFiles([{ name: "jane-only.pdf", mimeType: "application/pdf", buffer: PDF }]);
    await wait(page, () => document.querySelectorAll("#catBody .rr-chip:not(.up)").length === 1);
    const box = await area.boundingBox();
    await page.mouse.move(box.x + 120, box.y + 20); await page.mouse.down(); await page.mouse.move(40, box.y + 20, { steps: 6 }); await page.mouse.up();
    t("picking text and letting go outside the card doesn't close the lead", await page.evaluate(() => document.getElementById("catModal").style.display !== "none" && !!CAT_CUR) && /draft for Jane/.test(await html(page, "catBody")));
    await page.mouse.click(40, 300);
    t("a click on the dim area still closes it", await page.evaluate(() => document.getElementById("catModal").style.display === "none"));
    await page.evaluate((id) => catOpen(id), L1);
    await wait(page, () => document.getElementById("catModal").style.display !== "none" && document.querySelectorAll("#catThread > div").length >= 4);
    t("reopening the same lead keeps the draft and its file", /draft for Jane/.test(await html(page, "catBody")) && await page.evaluate(() => document.querySelectorAll("#catBody .rr-chip").length === 1));
    // --- closing the lead while it sends: it still goes once, and isn't left in the box ---
    const sentBefore = st.calls.filter((c) => c.action === "reply").length;
    await page.evaluate(() => { catSend(); catClose(); });
    await page.waitForTimeout(700);
    await page.evaluate((id) => catOpen(id), L1);
    await wait(page, () => document.getElementById("catModal").style.display !== "none" && /draft for Jane/.test(document.getElementById("catThread").textContent));
    t("closing the lead mid-send: sent once, and the box is empty when you come back", st.calls.filter((c) => c.action === "reply").length === sentBefore + 1 && await page.evaluate(() => document.querySelector("#catBody .rr-area").innerHTML === "" && !document.querySelector("#catBody .rr-chip")));
    // --- another lead: a clean box, its own folder ---
    await page.locator("#catBody .rr-area").click(); await page.keyboard.type("left behind for Jane");
    await page.evaluate(() => catClose());
    await page.evaluate((id) => catOpen(id), L2);
    await wait(page, () => /Omar Reyes/.test(document.getElementById("catTitle").textContent));
    t("another lead opens with an empty box and no files", await page.evaluate(() => document.querySelector("#catBody .rr-area").innerHTML === "" && !document.querySelector("#catBody .rr-chip")));
    const n0 = st.uploads.length;
    await page.locator("#catBody .rr-in-file").setInputFiles([{ name: "omar.pdf", mimeType: "application/pdf", buffer: PDF }]);
    await wait(page, () => document.querySelectorAll("#catBody .rr-chip:not(.up)").length === 1);
    t("…and its files go to its own folder", st.uploads[n0].path.indexOf("cat/" + L2 + "/") === 0, st.uploads[n0].path);
    await page.locator("#catQuick").selectOption({ label: "Questions" });
    t("a quick reply in an empty box starts with Hi <first name>", /^<div>Hi Omar,<\/div><div><br><\/div><div>Happy to help!/.test(await html(page, "catBody")), await html(page, "catBody"));
    await page.locator("#catSend").click();
    await wait(page, () => /Sent to omar@example\.com/.test(document.getElementById("catMsg").textContent));
    const om = st.calls.filter((c) => c.action === "reply").pop();
    t("…and its reply goes to its own lead", om.body.lead_id === L2 && om.body.attachments.length === 1 && om.body.attachments[0].name === "omar.pdf" && /• About how many guests\?/.test(om.body.body), om.body);
    t("no page errors", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  console.log("\nmanager.html · an experience / private-event inquiry → Reply");
  {
    const { ctx, page, st } = await open(browser);
    await page.evaluate((id) => inqOpen(id), I1);
    await wait(page, () => /raclette for 6/.test(document.getElementById("inqThread").textContent));
    t("the inquiry's reply box is the editor too", await page.evaluate(() => !!document.querySelector("#inqBody.rr .rr-bar") && !!document.querySelector("#inqBody .rr-area")));
    await page.locator("#inqModal button", { hasText: "Booking link" }).click();
    let h2 = await html(page, "inqBody");
    t("🔗 Booking link drops in a real link", /^<a href="https:\/\/tickets\.greyscheese\.com\/[^"]*[?&]book=exp-1[^"]*">Book and pay here<\/a>$/.test(h2) && /first=Sam/.test(h2) && /party=6/.test(h2), h2);
    await page.locator("#inqQuick").selectOption({ label: "Book here" });
    h2 = await html(page, "inqBody");
    t("a quick reply is added after it, with the address written out", /Book and pay here<\/a><div><br><\/div><div>Great news — you can lock it in here and pay online:<\/div><div>https:\/\/tickets\.greyscheese\.com\/[^<]*book=exp-1/.test(h2), h2);
    await page.locator("#inqBody .rr-in-file").setInputFiles([{ name: "raclette.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") }]);
    await wait(page, () => document.querySelectorAll("#inqBody .rr-chip:not(.up)").length === 1);
    t("its files go to the inquiry's folder", st.uploads[0].path.indexOf("inq/" + I1 + "/") === 0, st.uploads[0].path);
    await page.locator("#inqSend").click();
    await wait(page, () => /Sent to sam@example\.com/.test(document.getElementById("inqMsg").textContent));
    const c = st.calls.find((x) => x.action === "reply");
    t("send: posted to the inquiries function", c.fn === "inquiries" && c.body.inquiry_id === I1 && /<a href="https:\/\/tickets[^"]*book=exp-1[^"]*">Book and pay here<\/a>/.test(c.body.html) && c.body.attachments[0].path.indexOf("inq/" + I1 + "/") === 0, c.body);
    t("send: the plain copy has the booking address in it", /[?&]book=exp-1/.test(c.body.body), c.body.body);
    await wait(page, () => !!document.querySelector("#inqThread .rr-view a"));
    t("send: the thread shows the link and the file", await page.evaluate(() => { const last = [...document.querySelectorAll("#inqThread > div")].pop(); return /Book and pay here/.test(last.querySelector(".rr-view a").textContent) && last.querySelectorAll("a.rr-att").length === 1; }));
    await page.locator("#inqBody .rr-area").click(); await page.keyboard.type("They emailed back: yes please");
    await page.locator("#inqModal button", { hasText: "Log their reply" }).click();
    await wait(page, () => /Reply logged/.test(document.getElementById("inqMsg").textContent));
    const lg = st.calls.find((x) => x.action === "log");
    t("log their reply still takes the text", lg.fn === "inquiries" && lg.body.body === "They emailed back: yes please" && lg.body.note === false, lg.body);
    await page.locator("#inqBody .rr-area").click(); await page.keyboard.type("We would love to host you!");
    await page.locator("#inqSend").click();
    await wait(page, () => /Sent to sam@example\.com/.test(document.getElementById("inqMsg").textContent));
    t("plain text: posted as { inquiry_id, body } only", JSON.stringify(st.calls.filter((x) => x.action === "reply")[1].body) === JSON.stringify({ inquiry_id: I1, body: "We would love to host you!" }), st.calls.filter((x) => x.action === "reply")[1].body);
    t("no page errors", st.errors.length === 0, st.errors);
    await shot(page, "04-inquiry");
    await ctx.close();
  }

  console.log("\nmanager.html · on a phone (390 × 844)");
  {
    const { ctx, page, st } = await open(browser, { viewport: { width: 390, height: 844 } });
    await page.evaluate((id) => catOpen(id), L1);
    await wait(page, () => document.querySelectorAll("#catThread > div").length >= 4);
    const m = await page.evaluate(() => {
      const host = document.getElementById("catBody"), bar = host.querySelector(".rr-bar"), card = document.querySelector("#catModal .rec-card");
      const bs = [...bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
      return { hostW: host.getBoundingClientRect().width, cardW: card.getBoundingClientRect().width, overflow: host.scrollWidth - host.clientWidth, barOverflow: bar.scrollWidth - bar.clientWidth,
        minH: Math.min.apply(null, bs.map((r) => r.height)), minW: Math.min.apply(null, bs.map((r) => r.width)), right: Math.max.apply(null, bs.map((r) => r.right)), vw: innerWidth,
        font: parseFloat(getComputedStyle(host.querySelector(".rr-area")).fontSize), docOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    t("the toolbar wraps inside the box (nothing runs off the side)", m.overflow <= 0 && m.barOverflow <= 0 && m.right <= m.vw && m.docOverflow <= 0, m);
    t("buttons are big enough to tap", m.minH >= 34 && m.minW >= 34, m);
    t("16px text in the box (no iPhone zoom)", m.font >= 16, m);
    await page.locator("#catBody .rr-area").click();
    await page.keyboard.type("From my phone");
    await btn(page, "catBody", '[data-act="link"]').click();
    const pop = await page.evaluate(() => { const r = document.querySelector("#catBody .rr-pop").getBoundingClientRect(); return { left: r.left, right: r.right, vw: innerWidth }; });
    t("the link box fits the screen", pop.left >= 0 && pop.right <= pop.vw, pop);
    await page.locator("#catBody .rr-pop .rr-x").click();
    await shot(page, "05-phone");
    t("no page errors", st.errors.length === 0, st.errors);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
