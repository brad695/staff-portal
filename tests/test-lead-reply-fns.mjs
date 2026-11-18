/*
 * The `reply` action of the catering and inquiries functions with the reply editor's formatted message + files
 * (2026-11-17), run in Node: the real edge-mirror sources with Supabase, send-mail and Deno stood in.
 * The plain reply is checked against the functions as they were before the editor (BASE = main b412cc5, the commit
 * the live loaders were built from) so nothing moved for pages that still send { body }. If that commit isn't in
 * this clone (a shallow one), those side-by-side checks are skipped and say so.
 * Run: node tests/test-lead-reply-fns.mjs            (BASE=<commit> to pick what "before" means)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "b412cc58bb205859c5d407f6fe0c02fb0fb8b32e";
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 700) : "")); } };
const eq = (name, got, want) => t(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const SB = "https://proj.supabase.co";
const LEAD = { id: "11111111-2222-3333-4444-555555555555", code: "AB12CD", name: "Jane Smith", email: "jane@example.com", stage: "new", occasion: "Birthday", location: "Memphis" };
const INQ = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", code: "EF34AB", name: "Sam Lee", email: "sam@example.com", stage: "new", experience_name: "Raclette", reservation_id: "res-1" };
const OTHER = "99999999-2222-3333-4444-555555555555";
const FILES = {
  [`cat/${LEAD.id}/aaaaaaaaaaaaaaaa/Private-Events.pdf`]: { size: 2_400_000, mimetype: "application/pdf" },
  [`cat/${LEAD.id}/bbbbbbbbbbbbbbbb/menu.docx`]: { size: 60_000, mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  [`cat/${OTHER}/aaaaaaaaaaaaaaaa/secret.pdf`]: { size: 10, mimetype: "application/pdf" },
  [`inq/${INQ.id}/cccccccccccccccc/board.jpg`]: { size: 800_000, mimetype: "image/jpeg" },
};

// ---- stand-ins ----
function world() {
  const w = { rows: { catering_leads: [{ ...LEAD }], inquiries: [{ ...INQ }], catering_messages: [], inquiry_messages: [], rb_reservations: [{ id: "res-1", status: "pending" }], app_users: [{ email: "manager@greyscheese.com", status: "approved" }] },
    ops: [], mail: [], mailReply: () => ({ status: 200, body: { ok: true, provider: "smtp2go" } }), insertError: null };
  const builder = (table) => {
    const q = { table, filters: [], op: "select", row: null };
    const run = () => {
      const all = w.rows[table] || (w.rows[table] = []);
      const hit = all.filter((r) => q.filters.every(([k, v, how]) => how === "ilike" ? String(r[k]).toLowerCase() === String(v).toLowerCase() : how === "neq" ? r[k] !== v : r[k] === v));
      if (q.op === "insert") {
        const err = w.insertError && w.insertError(table, q.row);
        w.ops.push({ table, op: "insert", row: q.row, error: err || null });
        if (err) return { data: null, error: { message: err } };
        all.push({ ...q.row });
        return { data: q.single ? q.row : [q.row], error: null };
      }
      if (q.op === "update") { hit.forEach((r) => Object.assign(r, q.row)); w.ops.push({ table, op: "update", row: q.row, n: hit.length }); return { data: hit, error: null }; }
      return { data: q.single ? (hit[0] || null) : hit, error: null };
    };
    const b = {
      select: () => b, order: () => b, limit: () => b, in: () => b, not: () => b, is: () => b, gte: () => b,
      neq: (k, v) => { q.filters.push([k, v, "neq"]); return b; },
      eq: (k, v) => { q.filters.push([k, v]); return b; }, ilike: (k, v) => { q.filters.push([k, v, "ilike"]); return b; },
      insert: (row) => { q.op = "insert"; q.row = row; return b; }, update: (row) => { q.op = "update"; q.row = row; return b; },
      single: () => { q.single = true; return b; }, maybeSingle: () => { q.single = true; return b; },
      then: (a, r) => Promise.resolve(run()).then(a, r),
    };
    return b;
  };
  w.client = {
    from: builder,
    auth: { getUser: async (token) => token === "tok-manager" ? { data: { user: { email: "manager@greyscheese.com" } }, error: null } : { data: { user: null }, error: { message: "bad token" } } },
    rpc: async () => ({ data: true, error: null }),
    storage: { from: () => ({ list: async (folder) => ({ data: Object.keys(FILES).filter((p) => p.startsWith(folder + "/")).map((p) => ({ name: p.slice(folder.length + 1), metadata: FILES[p] })), error: null }) }) },
  };
  w.fetch = async (url, init) => {
    if (String(url).endsWith("/functions/v1/send-mail")) {
      const body = JSON.parse(init.body);
      w.mail.push({ auth: init.headers.Authorization, body });
      const r = w.mailReply(body, w.mail.length);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected fetch " + url);
  };
  return w;
}

// Load one function source (text) with its imports pointed at the stand-ins; returns its request handler.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "leadfn-"));
let seq = 0;
async function load(src, w) {
  const dir = path.join(TMP, "m" + ++seq);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "sb.mjs"), "export const createClient = () => globalThis.__world.client;\n");
  fs.writeFileSync(path.join(dir, "pdf.mjs"), "export const PDFDocument = {}, StandardFonts = {}, rgb = () => ({});\n");
  const code = src
    .replace(/from "npm:@supabase\/supabase-js@2"/, 'from "./sb.mjs"')
    .replace(/from "npm:pdf-lib@1\.17\.1"/, 'from "./pdf.mjs"')
    .replace(/from "\.\/rich-reply\.ts"/, `from ${JSON.stringify(pathToFileURL(path.join(ROOT, "edge-mirror", "rich-reply.ts")).href)}`);
  fs.writeFileSync(path.join(dir, "fn.ts"), code);
  let handler = null;
  globalThis.__world = w;
  globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: "service-key" }[k]) }, serve: (h) => { handler = h; } };
  globalThis.fetch = (u, i) => w.fetch(u, i);
  await import(pathToFileURL(path.join(dir, "fn.ts")).href);
  return async (action, body, token = "tok-manager") => {
    globalThis.__world = w; globalThis.fetch = (u, i) => w.fetch(u, i);
    const res = await handler(new Request(`${SB}/functions/v1/x?action=${action}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) }));
    return { status: res.status, data: await res.json() };
  };
}
const now = (f) => fs.readFileSync(path.join(ROOT, "edge-mirror", f), "utf8");
const before = (f) => { try { return execFileSync("git", ["-C", ROOT, "show", `${BASE}:edge-mirror/${f}`], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const strip = (ops) => ops.map((o) => ({ ...o, row: Object.fromEntries(Object.entries(o.row).filter(([k]) => k !== "last_message_at" && k !== "hold_expires_at")) }));
const realFetch = globalThis.fetch;

for (const [file, idKey, msgTable, rowKey, subj] of [
  ["catering.ts", "lead_id", "catering_messages", "lead_id", "Re: Your GREYS catering question [#AB12CD]"],
  ["inquiries.ts", "inquiry_id", "inquiry_messages", "inquiry_id", "Re: Your GREYS Raclette question [#EF34AB]"],
]) {
  const who = file === "catering.ts" ? LEAD : INQ;
  const folder = (file === "catering.ts" ? "cat/" : "inq/") + who.id + "/";
  const good = file === "catering.ts" ? [{ path: folder + "aaaaaaaaaaaaaaaa/Private-Events.pdf", name: "GREYS Private Events.pdf" }, { path: folder + "bbbbbbbbbbbbbbbb/menu.docx", name: "menu.docx" }]
    : [{ path: folder + "cccccccccccccccc/board.jpg", name: "board.jpg" }];
  console.log(`\n${file} · reply`);

  // 1. a plain reply: byte for byte what the version in git sends and stores
  const PLAIN = { [idKey]: who.id, body: 'Hi there,\n\nSee https://greyscheese.com/catering & tell me "when" <soon>.\n' };
  const wOld = world(), wNew = world();
  const oldSrc = before(file), newFn = await load(now(file), wNew);
  const b = await newFn("reply", PLAIN);
  t("plain reply: no formatted copy on the row", !("body_html" in wNew.ops[0].row) && !("attachments" in wNew.ops[0].row), wNew.ops[0].row);
  eq("plain reply: the email is the old <p>…<br>…</p> one, no attachments", [/<p>Hi there,<br><br>See <a href="https:\/\/greyscheese\.com\/catering">https:\/\/greyscheese\.com\/catering<\/a> &amp; tell me &quot;when&quot; &lt;soon&gt;\.<\/p>/.test(wNew.mail[0].body.html), Object.keys(wNew.mail[0].body).sort().join()], [true, "from,html,replyTo,subject,to"]);
  if (oldSrc) {
    const oldFn = await load(oldSrc, wOld), a = await oldFn("reply", PLAIN);
    eq("plain reply: same email as before", wNew.mail, wOld.mail);
    eq("plain reply: same rows written as before", strip(wNew.ops), strip(wOld.ops));
    eq("plain reply: same answer, plus rich:true", b.data, { ...a.data, rich: true, files: [] });
    eq("plain reply: an empty one is refused the same way", (await newFn("reply", { [idKey]: who.id, body: "  " })).data, (await oldFn("reply", { [idKey]: who.id, body: "  " })).data);
    eq("plain reply: an unknown id is refused the same way", (await newFn("reply", { [idKey]: OTHER, body: "x" })).data, (await oldFn("reply", { [idKey]: OTHER, body: "x" })).data);
    eq("not signed in: refused the same way", await newFn("reply", PLAIN, "nope"), await oldFn("reply", PLAIN, "nope"));
  } else console.log("  – side-by-side with the old function skipped (commit " + BASE.slice(0, 7) + " isn't in this clone)");

  // 2. the editor: formatted text + files
  const w = world(), fn = await load(now(file), w);
  const r = await fn("reply", { [idKey]: who.id, body: "plain copy the page sends too", attachments: good,
    html: 'Hi <b>there</b>,<div><br></div><div>Our <a href="https://greyscheese.com/catering" onclick="x()">menu</a> is attached.</div><script>alert(1)</script>' });
  t("formatted reply: 200 + rich", r.status === 200 && r.data.ok === true && r.data.rich === true, r);
  const m = w.mail[0].body;
  eq("email: to / subject / from / reply-to unchanged", [m.to, m.subject, m.from, m.replyTo], [who.email, subj, "GREYS Fine Cheeses <info@greyscheese.com>", "brad@greyscheese.com"]);
  t("email: service-role call", w.mail[0].auth === "Bearer service-key");
  t("email: the formatted message inside the brand shell", m.html.includes('Hi <b>there</b>,<div><br></div><div>Our <a href="https://greyscheese.com/catering" style="color:#06273A;text-decoration:underline">menu</a> is attached.</div>')
    && m.html.includes(">GREYS</div>") && m.html.includes("Just reply to this email"), m.html.slice(600, 1500));
  t("email: no script, no handler", !/<script|onclick|alert\(1\)/.test(m.html));
  t("email: every file is linked", good.every((g) => m.html.includes(`${SB}/storage/v1/object/public/lead-files/${g.path}`) && m.html.includes(g.name)));
  const row = w.ops.find((o) => o.table === msgTable).row;
  if (file === "catering.ts") {
    eq("email: the PDF rides as a real attachment, the Word file doesn't", m.attachments, [{ filename: "GREYS Private Events.pdf", mimetype: "application/pdf", url: `${SB}/storage/v1/object/public/lead-files/${good[0].path}` }]);
    eq("row: how each file went", row.attachments.map((f) => [f.name, f.sent, f.size, f.type.split("/")[0]]), [["GREYS Private Events.pdf", "attached", 2_400_000, "application"], ["menu.docx", "link", 60_000, "application"]]);
    eq("answer: how each file went", r.data.files, [{ name: "GREYS Private Events.pdf", sent: "attached" }, { name: "menu.docx", sent: "link" }]);
  } else {
    eq("email: the photo rides as a real attachment", m.attachments, [{ filename: "board.jpg", mimetype: "image/jpeg", url: `${SB}/storage/v1/object/public/lead-files/${good[0].path}` }]);
  }
  eq("row: the sanitized HTML", row.body_html, 'Hi <b>there</b>,<div><br></div><div>Our <a href="https://greyscheese.com/catering">menu</a> is attached.</div>');
  eq("row: body is the plain copy + a line per file", row.body, "Hi there,\n\nOur menu: https://greyscheese.com/catering is attached.\n\n" + good.map((g) => `📎 ${g.name} — ${SB}/storage/v1/object/public/lead-files/${g.path}`).join("\n"));
  eq("row: the usual columns", [row[rowKey], row.direction, row.sent_by, row.email_status], [who.id, "out", "manager@greyscheese.com", "sent"]);
  eq("the lead moves to replied", w.rows[file === "catering.ts" ? "catering_leads" : "inquiries"][0].stage, "replied");

  // 3. send-mail refuses the attachments → sent again without, files recorded as links
  {
    const w3 = world(); w3.mailReply = (body) => body.attachments ? { status: 400, body: { ok: false, error: "Attachment problem: x isn't a PDF" } } : { status: 200, body: { ok: true } };
    const f3 = await load(now(file), w3);
    const r3 = await f3("reply", { [idKey]: who.id, html: "<div>Here you go</div>", attachments: good });
    t("attachments refused: it still sends, once, without them", r3.data.ok === true && w3.mail.length === 2 && !!w3.mail[0].body.attachments && !("attachments" in w3.mail[1].body), w3.mail.map((x) => Object.keys(x.body)));
    t("attachments refused: every file is recorded as a link", w3.ops.find((o) => o.table === msgTable).row.attachments.every((x) => x.sent === "link"));
    t("attachments refused: the links are still in the email", good.every((g) => w3.mail[1].body.html.includes(g.path)));
  }
  // 4. the email fails outright
  {
    const w4 = world(); w4.mailReply = () => ({ status: 502, body: { ok: false, attempts: [] } });
    const f4 = await load(now(file), w4);
    const r4 = await f4("reply", { [idKey]: who.id, html: "<div>Hello</div>" });
    t("email fails: said so, and the row says failed", r4.status === 400 && /didn't send/.test(r4.data.error) && /^failed/.test(w4.ops.find((o) => o.table === msgTable).row.email_status), r4);
    t("email fails with no files: one try only", w4.mail.length === 1);
  }
  // 5. files that aren't this conversation's
  {
    const w5 = world(), f5 = await load(now(file), w5);
    const r5 = await f5("reply", { [idKey]: who.id, html: "<div>x</div>", attachments: [{ path: `cat/${OTHER}/aaaaaaaaaaaaaaaa/secret.pdf`, name: "s.pdf" }] });
    t("another lead's file: refused, nothing sent, nothing stored", r5.status === 400 && /doesn't belong/.test(r5.data.error) && !w5.mail.length && !w5.ops.length, r5);
    const r6 = await f5("reply", { [idKey]: who.id, html: "<div>x</div>", attachments: [{ path: folder + "zzzzzzzzzzzzzzzz/ghost.pdf", name: "g.pdf" }] });
    t("a file that never uploaded: refused, nothing sent", r6.status === 400 && /didn't finish uploading/.test(r6.data.error) && !w5.mail.length, r6);
    const r7 = await f5("reply", { [idKey]: who.id, html: "<div><br></div>" });
    t("an empty editor: refused", r7.status === 400 && /Type a message first/.test(r7.data.error), r7);
    const r8 = await f5("reply", { [idKey]: who.id, html: `<img src="${SB}/storage/v1/object/public/lead-files/cat/${OTHER}/aaaaaaaaaaaaaaaa/x.png">hello` });
    t("another lead's picture: dropped from the message", r8.data.ok === true && !/<img/.test(w5.mail[0].body.html.split("Just reply")[0]) && w5.ops.find((o) => o.table === msgTable).row.body_html === "hello", r8);
  }
  // 6. the new columns aren't there (migration not applied): the plain copy is still saved
  {
    const w6 = world(); w6.insertError = (tb, rw) => tb === msgTable && ("body_html" in rw || "attachments" in rw) ? 'column "body_html" does not exist' : null;
    const f6 = await load(now(file), w6);
    const r6 = await f6("reply", { [idKey]: who.id, html: "<div><b>Hi</b></div>", attachments: good.slice(0, 1) });
    const ins = w6.ops.filter((o) => o.table === msgTable);
    t("no new columns: sent, and saved as plain text", r6.data.ok === true && ins.length === 2 && !!ins[0].error && !ins[1].error && !("body_html" in ins[1].row) && ins[1].row.body.startsWith("Hi\n\n📎 "), ins);
    const f6b = await load(now(file), w6);
    t("no new columns: a plain reply never touches them", (await f6b("reply", { [idKey]: who.id, body: "plain" })).data.ok === true && w6.ops.filter((o) => o.table === msgTable).slice(-1)[0].error === null);
  }
  // 7. the row can't be saved at all
  {
    const w7 = world(); w7.insertError = (tb) => tb === msgTable ? "db is down" : null;
    const f7 = await load(now(file), w7);
    const r7 = await f7("reply", { [idKey]: who.id, html: "<div>Hi</div>" });
    t("row can't be saved: the email went, and it says so", r7.status === 400 && /couldn't be saved/.test(r7.data.error) && w7.mail.length === 1, r7);
  }
}

console.log("\ninquiries.ts · the booking link");
{
  const w = world(), fn = await load(now("inquiries.ts"), w);
  const link = "https://tickets.greyscheese.com/experiences?book=abc&amp;date=2026-12-05&amp;hold=res-1";
  const r = await fn("reply", { inquiry_id: INQ.id, html: `<div>Great news — you can <a href="${link}">lock it in here</a>.</div>` });
  eq("a linked booking link moves the inquiry to link_sent", [r.data.stage, w.rows.inquiries[0].stage], ["link_sent", "link_sent"]);
  t("…and restarts the 48 h hold", w.ops.some((o) => o.table === "rb_reservations" && o.op === "update" && o.row.hold_expires_at) && !!w.rows.inquiries[0].hold_expires_at);
  t("…and the plain copy has the address written out", /lock it in here: https:\/\/tickets\.greyscheese\.com\/experiences\?book=abc&date=2026-12-05&hold=res-1/.test(w.ops.find((o) => o.table === "inquiry_messages").row.body));
  const w2 = world(), fn2 = await load(now("inquiries.ts"), w2);
  const r2 = await fn2("reply", { inquiry_id: INQ.id, html: "<div>Here it is: https://tickets.greyscheese.com/experiences?book=abc</div>" });
  eq("a typed booking link does the same", r2.data.stage, "link_sent");
  t("…and is clickable in the email", w2.mail[0].body.html.includes('<a href="https://tickets.greyscheese.com/experiences?book=abc" style='));
  const w3 = world(), fn3 = await load(now("inquiries.ts"), w3);
  eq("no booking link: replied", (await fn3("reply", { inquiry_id: INQ.id, html: "<div>We'd love to host you!</div>" })).data.stage, "replied");
}

console.log("\ninquiries.ts · info@ Gmail sync (2026-11-18)");
{
  const w = world();
  w.rows.app_secrets = [{ name: "inquiry_ingest_secret", value: "s3cret" }];
  w.rows.catering_leads[0].created_at = "2026-11-10T00:00:00Z";
  const fn = await load(now("inquiries.ts"), w);
  const ing = (b) => fn("ingest", { secret: "s3cret", ...b });
  eq("bad secret is refused", (await fn("ingest", { secret: "x", direction: "in" })).status, 403);
  eq("addresses list needs the secret", (await fn("ingest_addrs", { secret: "x" })).status, 403);
  const ad = await fn("ingest_addrs", { secret: "s3cret" });
  t("addresses list: the leads' emails", ad.data.ok && ad.data.addrs.includes("jane@example.com") && ad.data.addrs.includes("sam@example.com"), ad.data);
  let r = await ing({ direction: "out", from: "GREYS Fine Cheeses <info@greyscheese.com>", to: "Jane Smith <jane@example.com>", subject: "Your party", body: "Hi Jane, here's the menu.\n\nOn Tue, Nov 17, 2026 Jane wrote:\n> hi", message_id: "g1", date: "2026-11-18T15:00:00Z" });
  const o = w.ops.find((x) => x.table === "catering_messages" && x.op === "insert");
  t("staff mail from info@ to a lead → an out row on that lead", r.data.added && o && o.row.direction === "out" && o.row.lead_id === LEAD.id && o.row.body === "Hi Jane, here's the menu." && o.row.email_status === "sent" && o.row.gmail_id === "g1", [r.data, o && o.row]);
  t("…lead moves new → replied, not unread", w.rows.catering_leads[0].stage === "replied" && w.rows.catering_leads[0].unread === false && w.rows.catering_leads[0].last_from === "staff");
  r = await ing({ direction: "out", from: "info@greyscheese.com", to: "Jane Smith <jane@example.com>", subject: "Your party", body: "x", message_id: "g1" });
  eq("the same Gmail message twice is skipped", r.data.skipped, "already have it");
  r = await ing({ direction: "in", from: "Sam Lee <sam@example.com>", to: "info@greyscheese.com", subject: "quick question", body: "Can we bring a cake?", message_id: "g2" });
  const n = w.ops.filter((x) => x.table === "inquiry_messages" && x.op === "insert").pop();
  t("customer mail with no code → their newest lead, as unread", r.data.added && n.row.direction === "in" && n.row.inquiry_id === INQ.id && w.rows.inquiries[0].unread === true, [r.data, n && n.row]);
  r = await ing({ direction: "in", from: "stranger@example.com", subject: "hello", body: "x", message_id: "g3" });
  eq("mail from someone who isn't a lead is skipped", r.data.skipped, "no lead for this email");
  r = await ing({ direction: "out", from: "info@greyscheese.com", to: "kurt@greyscheese.com", subject: "fyi", body: "x", message_id: "g4" });
  eq("staff-to-staff mail is skipped", r.data.skipped, "no lead for this email");
  r = await ing({ direction: "in", from: "someone@else.com", subject: "Re: Your GREYS catering question [#AB12CD]", body: "yes please", message_id: "g5" });
  t("a [#CODE] still wins over the address", r.data.added && w.ops.filter((x) => x.table === "catering_messages" && x.op === "insert").pop().row.body === "yes please");
  r = await fn("ingest", { secret: "s3cret", from: "jane@example.com", subject: "Re: Your GREYS catering question [#AB12CD]", body: "old script", message_id: "g6" });
  t("the old script's payload still works", r.data.added === true && r.data.catering === true, r.data);
}

console.log("\ncatering.ts · everything else still answers");
{
  const w = world(), fn = await load(now("catering.ts"), w);
  eq("log (a note) still saves", [(await fn("log", { lead_id: LEAD.id, body: "called her", note: true })).data, w.ops[0].row.direction, w.ops[0].row.body], [{ ok: true }, "note", "called her"]);
  eq("an unknown action is refused", await fn("nope", {}), { status: 400, data: { ok: false, error: "Unknown action" } });
}

globalThis.fetch = realFetch;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
