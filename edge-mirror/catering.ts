// catering — HoneyBook-style catering pipeline: conversation → proposal → e-signed
// contract → Square invoice (deposit + balance) with the signed PDF attached.
//
// Tables: catering_leads (one per customer), catering_messages (in / out / note),
// catering_quotes (proposal + contract + signature + Square invoice). All admin-only by RLS;
// the public only ever reaches a quote through its unguessable sign_token.
//
// PUBLIC
//   ask     {name,email,phone,company,location,event_date,event_time,guests,fulfillment,
//            address,occasion,budget,message,website(honeypot)}  → lead + first message,
//            staff alert, customer ack. Rate-limited 8/h/IP.
//   view    {token}  → proposal + contract for catering.html?q=<token>
//   sign    {token, name, agree:true} → records the signature (name, time, IP, browser),
//            builds the signed PDF, then creates the Square customer + order + invoice
//            (deposit now, balance later), attaches the PDF, publishes → invoice_url.
//            If Square fails the signature still stands; staff retry with create_invoice.
// CRON / ADMIN
//   sync    {secret?} → refreshes every open invoice from Square (deposit_paid / paid / canceled)
// ADMIN (staff JWT)
//   reply · log · new_lead · save_quote · send_quote · send_invoice · create_invoice · cancel_invoice · contract_url · preview
//   preview {quote_id, kind, message} → the exact customer email (+ what Square will bill) without sending anything
//   refund {quote_id, amount_cents?, reason?} → refunds money paid on the quote's Square invoice (default: all that's
//            left), newest payment first; adds to catering_quotes.refunded_cents and logs a note. Real money.
//   send_invoice {quote_id, message?} → skips the proposal + e-sign: marks the quote invoice_only,
//            creates + publishes the Square invoice right away (deposit % / balance date as set),
//            emails the customer the pay link in the conversation thread, lead stage → invoiced.
//            If Square fails the quote stays "Invoice pending" and staff retry with create_invoice.
//
// Square: its own switch SQUARE_CATERING_ENV = sandbox (default) | production.
//   sandbox    → SQUARE_EXP_SANDBOX_ACCESS_TOKEN (the experiences sandbox)
//   production → SQUARE_CATERING_ACCESS_TOKEN ?? SQUARE_ACCESS_TOKEN ?? SQUARE_TICKET_ACCESS_TOKEN
//                (needs ORDERS, INVOICES and CUSTOMERS read/write)
// Emails go through send-mail. Every customer email uses the subject
// "Your GREYS catering question [#CODE]" so the Gmail sync script (subject:(GREYS question))
// brings their replies back in via inquiries?action=ingest, which routes catering codes here.
// (Questions: "Your GREYS question [#CODE]"; donation requests: "Your GREYS donation question [#CODE]" —
// any other subject must keep both words, GREYS and question, or the customer's reply never comes back.)
// verify_jwt = false (ask / view / sign are public).
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const REPLY_TO = Deno.env.get("CATERING_REPLY_TO") || Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com";
const STAFF_INBOX = Deno.env.get("CATERING_INBOX") || Deno.env.get("INQUIRY_INBOX") || "brad@greyscheese.com";
const FROM = Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>";
const SITE = Deno.env.get("TICKET_SITE_URL") || "https://tickets.greyscheese.com";
const PORTAL = "https://staff.greyscheese.com/manager.html";
const MASTER_EMAIL = "bbearo@gmail.com";
const SQUARE_VERSION = "2025-01-23";
const SHOP_LOCATIONS: Record<string, string> = { memphis: "LCXWZ0HAQ69RM", nashville: "LJ33VDYHS1JAR" };
const BUCKET = "catering-contracts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
class PublicError extends Error {}
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const para = (s: string) => esc(s).replace(/\r?\n/g, "<br>").replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
const money = (c: number) => "$" + (Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDate = (ymd?: string | null) => ymd ? new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "TBD";
const fmtTime = (t?: string | null) => { if (!t || !/^\d{1,2}:\d{2}/.test(t)) return t || ""; const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + (h >= 12 ? " PM" : " AM"); };
const fmtStamp = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const FULFILL: Record<string, string> = { pickup: "Pick-up", delivery: "Delivery", onsite: "On-site service" };

// ---------- auth ----------
function bearer(req: Request) { return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
async function staffEmail(req: Request) {
  const token = bearer(req);
  if (!token || token.startsWith("sb_publishable_")) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  const email = (data.user?.email || "").toLowerCase();
  if (!email) return null;
  if (email === MASTER_EMAIL) return email;
  const { data: row } = await admin.from("app_users").select("email").eq("status", "approved").ilike("email", email).maybeSingle();
  return row ? email : null;
}

// ---------- mail ----------
async function sendMail(to: string, subject: string, html: string, replyTo = REPLY_TO) {
  const r = await fetch(SB_URL + "/functions/v1/send-mail", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({ to, subject, html, from: FROM, replyTo }),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.ok ? "sent" : "failed: " + JSON.stringify(d).slice(0, 200);
}
// Brand email chrome (Maverick 2026-10-12): cream canvas, white card, navy header band with the
// GREYS wordmark + gold rule, gold CTA with navy text, shop footer. All inline styles for mail clients.
const NAVY = "#06273A", GOLD = "#e6b33c", INK = "#221E1B", MUTE = "#6E6353", CREAM = "#F6F1E7", LINE = "#E6DFD0";
const shell = (inner: string, foot = true) =>
  `<div style="background:${CREAM};padding:28px 12px;font-family:Georgia,'Times New Roman',serif;color:${INK}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid ${LINE};border-collapse:separate">
      <tr><td style="background:${NAVY};padding:26px 32px 20px;border-bottom:4px solid ${GOLD}">
        <div style="font:800 30px/1 'League Spartan','Arial Black',Arial,sans-serif;letter-spacing:.12em;color:#FFFFFF">GREYS</div>
        <div style="font:700 10.5px/1.4 'League Spartan',Arial,sans-serif;letter-spacing:.22em;color:${GOLD};margin-top:7px;text-transform:uppercase">Fine Cheeses &nbsp;&middot;&nbsp; Charcuterie &nbsp;&middot;&nbsp; Wine</div>
      </td></tr>
      <tr><td style="padding:30px 32px 10px;font-size:16px;line-height:1.6;color:${INK}">${inner}</td></tr>
      <tr><td style="padding:18px 32px 26px">
        <div style="height:1px;background:${LINE};margin-bottom:18px"></div>
        ${foot ? `<p style="margin:0 0 10px;font:13px/1.5 Arial,sans-serif;color:${MUTE}">Questions? Just reply to this email and we'll pick the conversation right back up.</p>` : ""}
        <p style="margin:0;font:11.5px/1.7 Arial,sans-serif;color:${MUTE};letter-spacing:.02em">
          <b style="color:${NAVY}">GREYS Fine Cheeses</b><br>
          Memphis (901) 440-4739 &nbsp;&middot;&nbsp; Nashville (615) 900-4739<br>
          <a href="https://greyscheese.com" style="color:${NAVY};text-decoration:none">greyscheese.com</a>
        </p>
      </td></tr>
    </table></div>`;
const btn = (href: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px"><tr><td style="background:${GOLD};border-radius:3px">
     <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 13px/1 'League Spartan',Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${NAVY};text-decoration:none">${esc(label)}</a>
   </td></tr></table>`;
// Donation requests and questions come in here too (the inquiry form's "Donation request" and "Just Ask Us a
// Question", 2026-11-08: occasion "Donation request" / "Question"). Their emails don't talk about catering or a
// proposal. Their subjects still say "GREYS … question" so replies come back (v15's "Your GREYS donation
// request [#CODE]" didn't match the Gmail sync, v16 fixes it).
const isDonation = (lead: any) => /^donation/i.test(String(lead?.occasion || ""));
const isQuestion = (lead: any) => /^question\b/i.test(String(lead?.occasion || ""));
const subjectFor = (lead: any) => isQuestion(lead) ? `Your GREYS question [#${lead.code}]`
  : isDonation(lead) ? `Your GREYS donation question [#${lead.code}]` : `Your GREYS catering question [#${lead.code}]`;
const proposalLink = (q: any) => `${SITE}/catering.html?q=${q.sign_token}`;

async function note(leadId: string, body: string, by = "system") {
  await admin.from("catering_messages").insert({ lead_id: leadId, direction: "note", body, sent_by: by });
}

// ---------- Square ----------
type Env = "production" | "sandbox";
const envNow = (): Env => (Deno.env.get("SQUARE_CATERING_ENV") ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
const tokenFor = (e: Env) => e === "production"
  ? (Deno.env.get("SQUARE_CATERING_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_ACCESS_TOKEN") ?? Deno.env.get("SQUARE_TICKET_ACCESS_TOKEN"))
  : Deno.env.get("SQUARE_EXP_SANDBOX_ACCESS_TOKEN");
const baseFor = (e: Env) => e === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

async function square(e: Env, path: string, init: RequestInit = {}) {
  const token = tokenFor(e);
  if (!token) throw new Error(`No Square ${e} access token is set`);
  const res = await fetch(baseFor(e) + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs = (data as any)?.errors;
    const msg = Array.isArray(errs) && errs.length ? errs.map((x: any) => x.detail || x.code).join("; ") : `Square error (${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data as any;
}
const sandboxLoc: Record<string, string> = {};
async function locationFor(e: Env, shop: string) {
  if (e === "production") return SHOP_LOCATIONS[String(shop || "").toLowerCase()] ?? SHOP_LOCATIONS.memphis;
  const explicit = Deno.env.get("SQUARE_EXP_SANDBOX_LOCATION_ID");
  if (explicit) return explicit;
  if (sandboxLoc.id) return sandboxLoc.id;
  const d = await square(e, "/v2/locations");
  const l = ((d.locations || []) as any[]).find((x) => x.status === "ACTIVE") ?? d.locations?.[0];
  if (!l?.id) throw new Error("The sandbox has no location");
  return (sandboxLoc.id = String(l.id));
}

async function findOrCreateCustomer(e: Env, lead: any) {
  const s = await square(e, "/v2/customers/search", {
    method: "POST", body: JSON.stringify({ limit: 1, query: { filter: { email_address: { exact: lead.email } } } }),
  }).catch(() => ({}));
  const hit = s?.customers?.[0];
  if (hit?.id) return String(hit.id);
  const [given, ...rest] = String(lead.name || "").trim().split(/\s+/);
  const base: Record<string, unknown> = {
    idempotency_key: crypto.randomUUID(), given_name: given || lead.name, family_name: rest.join(" ") || undefined,
    email_address: lead.email, company_name: lead.company || undefined, reference_id: "catering:" + lead.code,
  };
  const digits = String(lead.phone || "").replace(/\D/g, "");
  try {
    const c = await square(e, "/v2/customers", { method: "POST", body: JSON.stringify(digits.length >= 10 ? { ...base, phone_number: lead.phone } : base) });
    return String(c.customer.id);
  } catch (err) {
    if (digits.length < 10) throw err;
    const c = await square(e, "/v2/customers", { method: "POST", body: JSON.stringify({ ...base, idempotency_key: crypto.randomUUID() }) });
    return String(c.customer.id);
  }
}

// ---------- quote math + contract ----------
type Item = { name: string; qty: number; price_cents: number; note?: string; image?: string };
// photo URLs (template cover + per-line photos): https only, nothing else gets stored
const imgUrl = (v: unknown) => { const u = clean(v, 600); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : undefined; };
function normItems(raw: unknown): Item[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 80).map((x: any) => ({
    name: clean(x?.name, 200), qty: Math.max(0, Math.round(Number(x?.qty) * 100) / 100 || 0),
    price_cents: Math.max(0, Math.round(Number(x?.price_cents) || 0)), note: clean(x?.note, 300) || undefined,
    image: imgUrl(x?.image),
  })).filter((x) => x.name && x.qty > 0);
}
function totals(items: Item[], rate: number) {
  const subtotal = items.reduce((s, it) => s + Math.round(it.qty * it.price_cents), 0);
  const tax = Math.round(subtotal * (Number(rate) || 0) / 100);
  return { subtotal, tax, total: subtotal + tax };
}
function balanceDate(q: any, lead: any) {
  const today = todayCT();
  let d = q.balance_due_date || (lead.event_date ? addDays(lead.event_date, -3) : addDays(today, 14));
  if (d < today) d = today;
  return d;
}
async function contractTemplate() {
  const { data } = await admin.from("site_content").select("data").eq("key", "catering_contract").maybeSingle();
  return String((data as any)?.data?.text || "");
}
function fillContract(text: string, lead: any, q: any) {
  const vals: Record<string, string> = {
    name: lead.name, company: lead.company || "", event_date: fmtDate(lead.event_date), event_time: fmtTime(lead.event_time),
    guests: String(lead.guests || "TBD"), total: money(q.total_cents), deposit_pct: String(q.deposit_pct),
    deposit: money(Math.round(q.total_cents * q.deposit_pct / 100)), balance_due_date: fmtDate(balanceDate(q, lead)),
    location: lead.location || "", code: lead.code,
  };
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vals[k] ?? "");
}

// ---------- PDF ----------
const pdfSafe = (s: string) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
  .replace(/·/g, "-").replace(/\t/g, "  ").replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "");

async function buildPdf(lead: any, q: any, contract: string, sig: { name: string; at: string; ip: string; ua: string }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`GREYS Catering Agreement #${lead.code}`);
  doc.setAuthor("GREYS Fine Cheeses");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
  const script = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const W = 612, H = 792, M = 54, gold = rgb(0.878, 0.635, 0.11), ink = rgb(0.13, 0.12, 0.11), mute = rgb(0.43, 0.39, 0.33);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M) newPage(); };
  const text = (s: string, x: number, size: number, font = reg, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font, color });
  const wrap = (s: string, size: number, font: any, width: number) => {
    const out: string[] = [];
    for (const raw of pdfSafe(s).split("\n")) {
      if (!raw.trim()) { out.push(""); continue; }
      let line = "";
      for (const w of raw.split(/\s+/)) {
        const t = line ? line + " " + w : w;
        if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
      }
      out.push(line);
    }
    return out;
  };
  const block = (s: string, size = 10, font = reg, color = ink, lead_ = 1.4, x = M, width = W - 2 * M) => {
    for (const l of wrap(s, size, font, width)) { need(size * lead_); y -= size * lead_; if (l) text(l, x, size, font, color); }
  };

  // header
  // GREYS blue band with white type, like the website header (Maverick 2026-10-10)
  const navy = rgb(0.024, 0.153, 0.227), white = rgb(1, 1, 1);
  page.drawRectangle({ x: 0, y: H - 72, width: W, height: 72, color: navy });
  y = H - 46; text("GREYS", M, 24, serif, white); text("Fine Cheeses - Charcuterie - Wine", M + 92, 10, reg, white);
  y = H - 96; text("Catering Proposal & Agreement", M, 16, bold); text(`#${lead.code}`, W - M - bold.widthOfTextAtSize(`#${lead.code}`, 12), 12, bold, mute);
  y -= 8;
  const facts: [string, string][] = [
    ["Client", lead.name + (lead.company ? ` (${lead.company})` : "")], ["Email", lead.email], ["Phone", lead.phone || "-"],
    ["Event", fmtDate(lead.event_date) + (lead.event_time ? " at " + fmtTime(lead.event_time) : "")],
    ["Guests", String(lead.guests || "TBD")], ["Service", (FULFILL[lead.fulfillment] || "TBD") + (lead.address ? " - " + lead.address : "")],
    ["Store", lead.location || "Memphis"],
  ];
  for (const [k, v] of facts) { for (const [i, l] of wrap(v, 10, reg, W - 2 * M - 70).entries()) { need(14); y -= 14; if (!i) text(k, M, 10, bold, mute); text(l, M + 70, 10); } }

  // items
  y -= 14; need(30); y -= 14; text("Proposal", M, 12, bold);
  y -= 6; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: mute });
  const colQ = W - M - 190, colP = W - M - 110, colT = W - M;
  y -= 14; text("Item", M, 9, bold, mute); text("Qty", colQ, 9, bold, mute); text("Price", colP, 9, bold, mute);
  text("Amount", colT - bold.widthOfTextAtSize("Amount", 9), 9, bold, mute);
  for (const it of (q.items || []) as Item[]) {
    const lines = wrap(it.name, 10, reg, colQ - M - 10);
    const noteLines = it.note ? wrap(it.note, 8.5, reg, colQ - M - 10) : [];
    need(14 * lines.length + 11 * noteLines.length + 4);
    lines.forEach((l, i) => {
      y -= 14; text(l, M, 10);
      if (!i) {
        const amt = money(Math.round(it.qty * it.price_cents));
        text(String(it.qty), colQ, 10); text(money(it.price_cents), colP, 10); text(amt, colT - reg.widthOfTextAtSize(amt, 10), 10);
      }
    });
    for (const l of noteLines) { y -= 11; text(l, M + 8, 8.5, reg, mute); }
  }
  y -= 8; page.drawLine({ start: { x: colQ, y }, end: { x: W - M, y }, thickness: 0.5, color: mute });
  const tot = (k: string, v: string, f = reg) => { need(15); y -= 15; text(k, colQ, 10, f); text(v, colT - f.widthOfTextAtSize(v, 10), 10, f); };
  tot("Subtotal", money(q.subtotal_cents)); tot(`Sales tax (${Number(q.tax_rate)}%)`, money(q.tax_cents)); tot("Total", money(q.total_cents), bold);
  const dep = Math.round(q.total_cents * q.deposit_pct / 100);
  if (q.deposit_pct > 0 && q.deposit_pct < 100) {
    tot(`Deposit (${q.deposit_pct}%)`, money(dep));
    tot("Balance due " + new Date(balanceDate(q, lead) + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }), money(q.total_cents - dep));
  }
  if (q.customer_note) { y -= 10; block(q.customer_note, 9.5, reg, mute); }

  // contract
  y -= 16; need(24); y -= 14; text("Terms", M, 12, bold);
  y -= 4; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: mute });
  y -= 4; block(contract, 9.5, reg, ink, 1.45);

  // signature
  y -= 18; need(110);
  y -= 16; text("Signed electronically by the Client", M, 10, bold);
  y -= 30; text(sig.name, M, 22, script);
  y -= 6; page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.7, color: ink });
  y -= 13; text(`${sig.name} - ${fmtStamp(sig.at)}`, M, 9, reg, mute);
  y -= 12; text(`Agreed by typing their name and checking "I agree" at ${SITE.replace(/^https?:\/\//, "")}/catering.html`, M, 8, reg, mute);
  y -= 11; text(`IP ${sig.ip || "unknown"} - Ref ${q.id}`, M, 8, reg, mute);
  const ua = wrap("Browser: " + (sig.ua || "unknown"), 7, reg, W - 2 * M);
  for (const l of ua.slice(0, 2)) { y -= 10; text(l, M, 7, reg, mute); }
  y -= 22; text("GREYS Fine Cheeses", M, 10, bold); y -= 12; text("Accepted on receipt of the deposit.", M, 9, reg, mute);

  // page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`GREYS catering agreement #${lead.code} - page ${i + 1} of ${pages.length}`, { x: M, y: 28, size: 7.5, font: reg, color: mute }));
  return await doc.save();
}

// ---------- invoice ----------
async function createInvoice(quoteId: string) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", quoteId).single();
  if (!q) throw new Error("quote not found");
  if (q.square_invoice_id) return q;
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
  const e: Env = (q.square_env as Env) || envNow();
  await admin.from("catering_quotes").update({ square_env: e, invoice_error: null }).eq("id", q.id);
  try {
    const location_id = await locationFor(e, lead.location);
    const customer_id = q.square_customer_id || await findOrCreateCustomer(e, lead);
    await admin.from("catering_quotes").update({ square_customer_id: customer_id }).eq("id", q.id);

    let orderId = q.square_order_id as string | null;
    if (!orderId) {
      const items = (q.items || []) as Item[];
      const order: Record<string, unknown> = {
        location_id, customer_id, reference_id: "CAT-" + lead.code, source: { name: "GREYS Catering" },
        line_items: items.map((it) => ({
          name: it.name.slice(0, 500), quantity: String(it.qty),
          // Square rejects fractional quantities (e.g. 1.5 lb) unless a quantity_unit says how precise they are
          ...(Number.isInteger(it.qty) ? {} : { quantity_unit: { measurement_unit: { custom_unit: { name: "Unit", abbreviation: "ea" } }, precision: 2 } }),
          base_price_money: { amount: it.price_cents, currency: "USD" }, note: it.note || undefined,
        })),
      };
      if (Number(q.tax_rate) > 0) order.taxes = [{ uid: "tn-tax", name: "TN Sales Tax", percentage: String(Number(q.tax_rate)), scope: "ORDER", type: "ADDITIVE" }];
      const o = await square(e, "/v2/orders", { method: "POST", body: JSON.stringify({ idempotency_key: q.id + ":order", order }) });
      orderId = String(o.order.id);
      const sqTotal = Number(o.order.total_money?.amount), sqTax = Number(o.order.total_tax_money?.amount || 0);
      // Square's per-line rounding can move tax a cent; its numbers are what the customer pays
      await admin.from("catering_quotes").update({ square_order_id: orderId, total_cents: sqTotal, tax_cents: sqTax, subtotal_cents: sqTotal - sqTax }).eq("id", q.id);
      q.total_cents = sqTotal;
    }

    const today = todayCT(), bal = balanceDate(q, lead);
    const pct = Number(q.deposit_pct);
    const reminders = bal >= addDays(today, 5) ? [{ relative_scheduled_days: -3, message: `A friendly reminder — the balance for your GREYS catering (#${lead.code}) is due soon.` }] : undefined;
    const payment_requests = pct > 0 && pct < 100
      ? [{ request_type: "DEPOSIT", due_date: today, percentage_requested: String(pct) }, { request_type: "BALANCE", due_date: bal, reminders }]
      : [{ request_type: "BALANCE", due_date: pct >= 100 ? today : bal, reminders: pct >= 100 ? undefined : reminders }];
    const when = fmtDate(lead.event_date) + (lead.event_time ? " at " + fmtTime(lead.event_time) : "");
    const about = [when, lead.guests ? `${lead.guests} guests` : "", FULFILL[lead.fulfillment] || "catering"].filter(Boolean).join(" · ") + ".";
    const extra = q.invoice_only ? (q.customer_note ? "\n\n" + q.customer_note : "") : (q.pdf_path ? " Signed agreement attached." : "");
    const inv = await square(e, "/v2/invoices", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: q.id + ":invoice",
        invoice: {
          location_id, order_id: orderId, primary_recipient: { customer_id },
          payment_requests, delivery_method: "EMAIL",
          accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
          title: `GREYS Catering #${lead.code}`.slice(0, 255),
          description: (about + extra).slice(0, 65536),
          sale_or_service_date: lead.event_date || undefined,
        },
      }),
    });
    let invoice = inv.invoice;
    await admin.from("catering_quotes").update({ square_invoice_id: invoice.id, invoice_status: invoice.status }).eq("id", q.id);

    // signed contract as an attachment
    if (q.pdf_path) {
      const { data: file } = await admin.storage.from(BUCKET).download(q.pdf_path);
      if (file) {
        const fd = new FormData();
        fd.append("request", JSON.stringify({ idempotency_key: q.id + ":att", description: "Signed catering agreement" }));
        fd.append("image_file", new Blob([await file.arrayBuffer()], { type: "application/pdf" }), `GREYS-catering-${lead.code}.pdf`);
        const r = await fetch(`${baseFor(e)}/v2/invoices/${invoice.id}/attachments`, {
          method: "POST", headers: { Authorization: "Bearer " + tokenFor(e), "Square-Version": SQUARE_VERSION, Accept: "application/json" }, body: fd,
        });
        if (!r.ok) console.error("attachment", r.status, (await r.text()).slice(0, 400));
        invoice = (await square(e, `/v2/invoices/${invoice.id}`)).invoice;
      }
    }
    const pub = await square(e, `/v2/invoices/${invoice.id}/publish`, { method: "POST", body: JSON.stringify({ version: invoice.version, idempotency_key: q.id + ":publish" }) });
    invoice = pub.invoice;
    const patch = { status: "invoiced", invoice_status: invoice.status, invoice_url: invoice.public_url || null, invoice_number: invoice.invoice_number || null, synced_at: new Date().toISOString() };
    await admin.from("catering_quotes").update(patch).eq("id", q.id);
    await note(lead.id, `Square invoice ${invoice.invoice_number || ""} created${q.invoice_only ? " (no proposal)" : ""} and emailed (${e}). ${pct > 0 && pct < 100 ? `Deposit ${pct}% due now, balance due ${bal}.` : ""}`.trim());
    // invoiced straight from the portal: the lead moves on unless an earlier invoice is already paid on
    if (q.invoice_only) await admin.from("catering_leads").update({ stage: "invoiced" }).eq("id", lead.id).in("stage", ["new", "replied", "quoted", "contract_sent", "signed", "lost"]);
    return { ...q, ...patch, square_invoice_id: invoice.id };
  } catch (err) {
    const msg = String((err as Error).message || err).slice(0, 500);
    await admin.from("catering_quotes").update({ invoice_error: msg }).eq("id", q.id);
    await note(lead.id, "⚠ Square invoice could not be created: " + msg + " — use Retry invoice in the portal.");
    throw err;
  }
}

// ---------- public actions ----------
async function ask(req: Request, b: Record<string, unknown>) {
  if (clean(b.website)) return { ok: true }; // honeypot
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { data: okRate } = await admin.rpc("ticket_rate_hit", { p_bucket: ("cat:" + ip).slice(0, 200), p_limit: 8, p_window_secs: 3600 });
  if (okRate === false) throw new PublicError("Too many messages from this connection — please try again later or call the shop.");
  const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), message = clean(b.message, 4000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Please enter your name and a valid email.");
  const occ = clean(b.occasion, 120);
  if (message.length < 2) throw new PublicError(/^donation/i.test(occ) ? "Tell us what you're requesting." : /^question\b/i.test(occ) ? "Type your question." : "Tell us a little about your event.");
  const date = clean(b.event_date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PublicError("Pick a valid date.");
  const fulfillment = ["pickup", "delivery", "onsite"].includes(clean(b.fulfillment, 20)) ? clean(b.fulfillment, 20) : null;
  const { data: lead, error } = await admin.from("catering_leads").insert({
    name, email, phone: clean(b.phone, 40) || null, company: clean(b.company, 120) || null,
    location: clean(b.location, 40) || "Memphis", event_date: date || null, event_time: clean(b.event_time, 8) || null,
    guests: Math.floor(Number(b.guests) || 0) || null, fulfillment, address: clean(b.address, 300) || null,
    occasion: clean(b.occasion, 120) || null, budget: clean(b.budget, 60) || null,
  }).select("*").single();
  if (error) throw new Error(error.message);
  await admin.from("catering_messages").insert({ lead_id: lead.id, direction: "in", body: message, sent_by: email });
  const facts = [lead.occasion, lead.event_date && fmtDate(lead.event_date) + (lead.event_time ? " " + fmtTime(lead.event_time) : ""),
    lead.guests && `${lead.guests} guests`, lead.fulfillment && FULFILL[lead.fulfillment], lead.location, lead.budget && "Budget " + lead.budget, lead.phone].filter(Boolean).map((x) => esc(String(x))).join(" · ");
  const don = isDonation(lead), qn = isQuestion(lead);
  await sendMail(STAFF_INBOX, `New ${qn ? "question" : don ? "donation request" : "catering inquiry"} from ${name} [#${lead.code}]`,
    shell(`<p><b>${esc(name)}</b>${lead.company ? " (" + esc(lead.company) + ")" : ""} &lt;${esc(email)}&gt; wrote:</p><blockquote style="border-left:3px solid ${GOLD};margin:0;padding:4px 12px">${para(message)}</blockquote>
      <p style="font:13px Arial;color:#6E6353">${facts}</p>${btn(PORTAL + "#catering", "Open in the portal")}`, false), email);
  await sendMail(email, subjectFor(lead),
    shell(`<p>Hi ${esc(name.split(" ")[0])},</p><p>${qn ? "Thanks for reaching out to GREYS! We've got your question and will get back to you by email."
      : don ? "Thanks for thinking of GREYS! We've got your donation request and will get back to you by email."
      : "Thanks for thinking of GREYS for your event! We've got your details and will be in touch shortly with ideas and a proposal."}</p>
      <p style="font:13px Arial;color:#6E6353">What you sent us:</p><blockquote style="border-left:3px solid ${GOLD};margin:0;padding:4px 12px;color:#6E6353">${para(message)}</blockquote>`));
  return { ok: true, code: lead.code };
}

async function loadByToken(token: string) {
  if (!/^[a-f0-9]{24,64}$/.test(token)) throw new PublicError("This link isn't valid.");
  const { data: q } = await admin.from("catering_quotes").select("*").eq("sign_token", token).maybeSingle();
  if (!q) throw new PublicError("This proposal link isn't valid anymore — reply to our email and we'll send a new one.");
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
  return { q, lead };
}
function publicView(q: any, lead: any, contract: string) {
  return {
    ok: true,
    lead: { name: lead.name, company: lead.company, email: lead.email, code: lead.code, event_date: lead.event_date, event_time: lead.event_time,
      guests: lead.guests, fulfillment: lead.fulfillment, address: lead.address, location: lead.location },
    quote: { status: q.status, items: q.items, subtotal_cents: q.subtotal_cents, tax_cents: q.tax_cents, tax_rate: q.tax_rate, total_cents: q.total_cents,
      deposit_pct: q.deposit_pct, deposit_cents: Math.round(q.total_cents * q.deposit_pct / 100), balance_due_date: balanceDate(q, lead),
      customer_note: q.customer_note, signed_name: q.signed_name, signed_at: q.signed_at, invoice_url: q.invoice_url, amount_paid_cents: q.amount_paid_cents,
      image_url: q.image_url || null },
    contract,
  };
}
async function view(b: Record<string, unknown>) {
  const { q, lead } = await loadByToken(clean(b.token, 80));
  if (q.invoice_only) throw new PublicError("This proposal was replaced by an invoice — use the pay link in your invoice email, or reply to our email with any questions.");
  if (q.status === "draft") throw new PublicError("This proposal isn't ready yet — we'll email you when it is.");
  if (q.status === "canceled") throw new PublicError("This proposal was replaced — check your email for the newest link, or reply and we'll resend it.");
  if (!q.viewed_at) {
    await admin.from("catering_quotes").update({ viewed_at: new Date().toISOString() }).eq("id", q.id);
    await note(lead.id, "👀 Customer opened the proposal.");
  }
  const contract = fillContract(q.contract_text || await contractTemplate(), lead, q);
  return publicView(q, lead, contract);
}

async function sign(req: Request, b: Record<string, unknown>) {
  const { q, lead } = await loadByToken(clean(b.token, 80));
  if (q.status !== "sent") {
    if (q.signed_at) return { ...publicView(q, lead, ""), already: true };
    throw new PublicError("This proposal can't be signed right now — reply to our email and we'll help.");
  }
  const name = clean(b.name, 120);
  if (name.length < 2) throw new PublicError("Type your full name to sign.");
  if (b.agree !== true) throw new PublicError("Check the box to agree to the terms.");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ua = clean(req.headers.get("user-agent"), 400);
  const at = new Date().toISOString();
  const contract = fillContract(q.contract_text || await contractTemplate(), lead, q);
  // claim it first so a double-click can't sign twice
  const { data: claimed } = await admin.from("catering_quotes").update({
    status: "signed", signed_name: name, signed_at: at, signed_ip: ip || null, signed_ua: ua || null, contract_text: contract,
  }).eq("id", q.id).eq("status", "sent").select("id");
  if (!claimed?.length) throw new PublicError("This proposal was just signed.");
  q.contract_text = contract; q.signed_name = name; q.signed_at = at;

  let pdfPath: string | null = null;
  try {
    const bytes = await buildPdf(lead, q, contract, { name, at, ip, ua });
    pdfPath = `${lead.code}/${q.id}.pdf`;
    const { error } = await admin.storage.from(BUCKET).upload(pdfPath, new Blob([bytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: true });
    if (error) throw error;
    await admin.from("catering_quotes").update({ pdf_path: pdfPath }).eq("id", q.id);
  } catch (e) {
    console.error("pdf", e);
    await note(lead.id, "⚠ The signed PDF could not be generated: " + String((e as Error).message || e).slice(0, 300));
  }
  await admin.from("catering_leads").update({ stage: "signed", last_message_at: at, unread: true, last_from: "customer" }).eq("id", lead.id);
  await note(lead.id, `✍️ Contract signed by "${name}" (${fmtStamp(at)}, IP ${ip || "?"}).`);

  let invoice: any = null, invoiceError: string | null = null;
  try { invoice = await createInvoice(q.id); } catch (e) { invoiceError = String((e as Error).message || e); }

  const depCents = Math.round(q.total_cents * q.deposit_pct / 100);
  await sendMail(STAFF_INBOX, `✍️ ${lead.name} signed the catering contract [#${lead.code}]`,
    shell(`<p><b>${esc(lead.name)}</b> signed the catering agreement for <b>${esc(fmtDate(lead.event_date))}</b> — total ${money(q.total_cents)}.</p>
      ${invoiceError ? `<p style="color:#9f2d20"><b>The Square invoice didn't go out:</b> ${esc(invoiceError)}<br>Open the lead and hit Retry invoice.</p>` : `<p>Square invoice sent — ${q.deposit_pct > 0 && q.deposit_pct < 100 ? `${q.deposit_pct}% deposit (${money(depCents)}) due now.` : "due as scheduled."}</p>`}
      ${btn(PORTAL + "#catering", "Open in the portal")}`, false), lead.email);
  await sendMail(lead.email, "Re: " + subjectFor(lead),
    shell(`<p>Hi ${esc(lead.name.split(" ")[0])},</p><p>Thank you — your catering agreement for <b>${esc(fmtDate(lead.event_date))}</b> is signed.</p>
      ${invoice?.invoice_url ? `<p>Your invoice is ready. ${q.deposit_pct > 0 && q.deposit_pct < 100 ? `The ${q.deposit_pct}% deposit (${money(depCents)}) holds your date; the balance is due ${esc(fmtDate(balanceDate(q, lead)))}.` : ""} Your signed agreement is attached to the invoice.</p>${btn(invoice.invoice_url, "View & pay invoice")}`
        : `<p>We'll email your invoice shortly.</p>`}
      <p style="font:13px Arial">You can review your proposal any time: <a href="${esc(proposalLink(q))}">${esc(proposalLink(q))}</a></p>`));
  const { data: fresh } = await admin.from("catering_quotes").select("*").eq("id", q.id).single();
  return { ...publicView(fresh, lead, contract), invoice_error: invoiceError ? "Your signature is saved. The invoice will follow by email." : null };
}

// ---------- sync ----------
async function syncQuote(q: any) {
  const e: Env = (q.square_env as Env) || "sandbox";
  const inv = (await square(e, `/v2/invoices/${q.square_invoice_id}`)).invoice;
  const reqs = (inv.payment_requests || []) as any[];
  const paid = reqs.reduce((s, r) => s + Number(r.total_completed_amount_money?.amount || 0), 0);
  const dep = reqs.find((r) => r.request_type === "DEPOSIT");
  const depDone = dep && Number(dep.total_completed_amount_money?.amount || 0) >= Number(dep.computed_amount_money?.amount || 1);
  let status = q.status;
  if (inv.status === "PAID") status = "paid";
  else if (inv.status === "CANCELED" || inv.status === "FAILED") status = "canceled";
  else if (depDone || (inv.status === "PARTIALLY_PAID" && paid > 0)) status = "deposit_paid";
  const patch: Record<string, unknown> = { invoice_status: inv.status, amount_paid_cents: paid, synced_at: new Date().toISOString(), invoice_url: inv.public_url || q.invoice_url };
  if (/REFUNDED/.test(String(inv.status)) && q.square_order_id) {
    const r = await refundedOnOrder(e, q.square_order_id).catch(() => null);
    if (r != null && r !== Number(q.refunded_cents || 0)) { patch.refunded_cents = r; patch.refunded_at = q.refunded_at || new Date().toISOString(); }
  }
  if (status !== q.status) {
    patch.status = status;
    if (status === "deposit_paid" && !q.deposit_paid_at) patch.deposit_paid_at = new Date().toISOString();
    if (status === "paid") { patch.paid_at = new Date().toISOString(); if (!q.deposit_paid_at) patch.deposit_paid_at = patch.paid_at; }
  }
  await admin.from("catering_quotes").update(patch).eq("id", q.id);
  if (status !== q.status) {
    const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
    const stage = status === "paid" ? "paid" : status === "deposit_paid" ? "deposit_paid" : lead.stage;
    await admin.from("catering_leads").update({ stage, unread: true, last_message_at: new Date().toISOString() }).eq("id", lead.id);
    const line = status === "paid" ? `💰 Paid in full — ${money(paid)} received.` : status === "deposit_paid" ? `💵 Deposit paid — ${money(paid)} received so far.` : `Invoice is now ${inv.status}.`;
    await note(lead.id, line);
    if (status === "paid" || status === "deposit_paid") {
      await sendMail(STAFF_INBOX, `${status === "paid" ? "💰 Paid in full" : "💵 Deposit paid"}: ${lead.name} [#${lead.code}]`,
        shell(`<p>${esc(line)}</p><p>${esc(fmtDate(lead.event_date))} · ${esc(String(lead.guests || "?"))} guests · total ${money(q.total_cents)}</p>${btn(PORTAL + "#catering", "Open in the portal")}`, false));
    }
  }
  return { id: q.id, status, invoice_status: inv.status, paid };
}
async function sync(onlyId?: string) {
  let qb = admin.from("catering_quotes").select("*").not("square_invoice_id", "is", null);
  qb = onlyId ? qb.eq("id", onlyId) : qb.in("status", ["invoiced", "deposit_paid"]);
  const { data } = await qb.limit(200);
  const out: any[] = [];
  for (const q of data || []) { try { out.push(await syncQuote(q)); } catch (e) { out.push({ id: q.id, error: String((e as Error).message || e) }); } }
  return { ok: true, env: envNow(), synced: out };
}

// ---------- admin actions ----------
async function reply(who: string, b: Record<string, unknown>) {
  const id = clean(b.lead_id, 64), body = clean(b.body, 8000);
  if (!body) throw new PublicError("Type a message first.");
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", id).single();
  if (!lead) throw new PublicError("Lead not found.");
  const status = await sendMail(lead.email, "Re: " + subjectFor(lead), shell(`<p>${para(body)}</p>`));
  await admin.from("catering_messages").insert({ lead_id: id, direction: "out", body, sent_by: who, email_status: status });
  const stage = lead.stage === "new" ? "replied" : lead.stage;
  await admin.from("catering_leads").update({ stage, last_from: "staff", last_message_at: new Date().toISOString(), unread: false }).eq("id", id);
  if (status !== "sent") throw new PublicError("Saved, but the email didn't send (" + status + ").");
  return { ok: true, stage };
}
async function logIn(b: Record<string, unknown>) {
  const id = clean(b.lead_id, 64), body = clean(b.body, 8000);
  if (!body) throw new PublicError("Type something first.");
  const kind = b.note === true ? "note" : "in";
  await admin.from("catering_messages").insert({ lead_id: id, direction: kind, body, sent_by: kind === "note" ? "staff note" : "logged by staff" });
  if (kind === "in") await admin.from("catering_leads").update({ last_from: "customer", last_message_at: new Date().toISOString() }).eq("id", id);
  return { ok: true };
}
async function newLead(who: string, b: Record<string, unknown>) {
  const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Name and a valid email are required.");
  const fulfillment = ["pickup", "delivery", "onsite"].includes(clean(b.fulfillment, 20)) ? clean(b.fulfillment, 20) : null;
  const { data: lead, error } = await admin.from("catering_leads").insert({
    name, email, phone: clean(b.phone, 40) || null, company: clean(b.company, 120) || null, location: clean(b.location, 40) || "Memphis",
    event_date: clean(b.event_date, 10) || null, event_time: clean(b.event_time, 8) || null, guests: Math.floor(Number(b.guests) || 0) || null,
    fulfillment, address: clean(b.address, 300) || null, occasion: clean(b.occasion, 120) || null, unread: false, last_from: "staff",
  }).select("*").single();
  if (error) throw new PublicError(error.message);
  const msg = clean(b.message, 4000);
  await note(lead.id, msg ? "Added by " + who + ": " + msg : "Added by " + who + ".", who);
  return { ok: true, lead };
}
async function saveQuote(who: string, b: Record<string, unknown>) {
  const leadId = clean(b.lead_id, 64);
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", leadId).single();
  if (!lead) throw new PublicError("Lead not found.");
  // lead details can be corrected from the quote editor
  const lp = (b.lead || {}) as Record<string, unknown>;
  const leadPatch: Record<string, unknown> = {};
  for (const k of ["name", "email", "phone", "company", "location", "event_date", "event_time", "address", "occasion"]) if (k in lp) leadPatch[k] = clean(lp[k], 300) || null;
  if ("guests" in lp) leadPatch.guests = Math.floor(Number(lp.guests) || 0) || null;
  if ("fulfillment" in lp) leadPatch.fulfillment = ["pickup", "delivery", "onsite"].includes(clean(lp.fulfillment, 20)) ? clean(lp.fulfillment, 20) : null;
  if (leadPatch.name === null || leadPatch.email === null) throw new PublicError("Name and email can't be blank.");
  if (Object.keys(leadPatch).length) { const { error } = await admin.from("catering_leads").update(leadPatch).eq("id", leadId); if (error) throw new PublicError(error.message); Object.assign(lead, leadPatch); }

  const items = normItems(b.items);
  const rate = Math.min(20, Math.max(0, Number(b.tax_rate ?? 9.75)));
  const t = totals(items, rate);
  const row: Record<string, unknown> = {
    items, tax_rate: rate, subtotal_cents: t.subtotal, tax_cents: t.tax, total_cents: t.total,
    deposit_pct: Math.min(100, Math.max(0, Math.round(Number(b.deposit_pct ?? 50)))),
    balance_due_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(b.balance_due_date, 10)) ? clean(b.balance_due_date, 10) : null,
    customer_note: clean(b.customer_note, 4000) || null,
    image_url: imgUrl(b.image_url) || null,
    contract_text: clean(b.contract_text, 30000) || null, updated_at: new Date().toISOString(),
  };
  const qid = clean(b.quote_id, 64);
  if (qid) {
    const { data: cur } = await admin.from("catering_quotes").select("status").eq("id", qid).single();
    if (!cur) throw new PublicError("Quote not found.");
    if (!["draft", "sent"].includes(cur.status)) throw new PublicError("This one is already signed or invoiced — cancel its invoice and start a new one to change it.");
    const { data, error } = await admin.from("catering_quotes").update(row).eq("id", qid).select("*").single();
    if (error) throw new PublicError(error.message);
    return { ok: true, quote: data, env: envNow() };
  }
  const { data, error } = await admin.from("catering_quotes").insert({ ...row, lead_id: leadId, created_by: who }).select("*").single();
  if (error) throw new PublicError(error.message);
  return { ok: true, quote: data, env: envNow() };
}
async function sendQuote(who: string, b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", clean(b.quote_id, 64)).single();
  if (!q) throw new PublicError("Quote not found.");
  if (!["draft", "sent"].includes(q.status)) throw new PublicError("Already signed.");
  if (!(q.items || []).length || q.total_cents <= 0) throw new PublicError("Add at least one priced item first.");
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
  if (!lead.event_date) throw new PublicError("Set the event date first.");
  // one live proposal per lead: older unsigned ones stop working
  await admin.from("catering_quotes").update({ status: "canceled" }).eq("lead_id", lead.id).in("status", ["draft", "sent"]).neq("id", q.id);
  const { msg, html } = proposalEmail(q, lead, clean(b.message, 4000));
  const status = await sendMail(lead.email, "Re: " + subjectFor(lead), html);
  await admin.from("catering_messages").insert({ lead_id: lead.id, direction: "out", body: msg + "\n\n📄 Proposal: " + proposalLink(q), sent_by: who, email_status: status });
  await admin.from("catering_quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", q.id);
  await admin.from("catering_leads").update({ stage: "contract_sent", last_from: "staff", last_message_at: new Date().toISOString(), unread: false }).eq("id", lead.id);
  if (status !== "sent") throw new PublicError("Saved, but the email didn't send (" + status + ").");
  return { ok: true, link: proposalLink(q) };
}
// Invoice without a proposal: no contract, no signature — Square bills them right away.
async function sendInvoice(who: string, b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", clean(b.quote_id, 64)).single();
  if (!q) throw new PublicError("Quote not found.");
  if (!["draft", "sent"].includes(q.status)) throw new PublicError("This one is already signed or invoiced.");
  if (!(q.items || []).length || q.total_cents <= 0) throw new PublicError("Add at least one priced item first.");
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
  if (!lead.event_date) throw new PublicError("Set the event date first.");
  // claim it first so a double-click can't invoice twice
  const { data: claimed } = await admin.from("catering_quotes").update({ status: "signed", invoice_only: true, updated_at: new Date().toISOString() })
    .eq("id", q.id).in("status", ["draft", "sent"]).select("id");
  if (!claimed?.length) throw new PublicError("This one was just invoiced.");
  // the invoice replaces any proposal still out for this lead
  await admin.from("catering_quotes").update({ status: "canceled" }).eq("lead_id", lead.id).in("status", ["draft", "sent"]).neq("id", q.id);

  let inv: any;
  try { inv = await createInvoice(q.id); }
  catch (e) { throw new PublicError("Square: " + String((e as Error).message || e) + " — nothing was sent. Fix it and hit Retry invoice."); }

  // our own email in the conversation thread (Square emails its invoice too)
  const { msg, html } = invoiceEmail(q, lead, clean(b.message, 4000), Number(inv.total_cents) || q.total_cents, inv.invoice_url || null);
  const status = await sendMail(lead.email, "Re: " + subjectFor(lead), html);
  await admin.from("catering_messages").insert({ lead_id: lead.id, direction: "out", body: msg + (inv.invoice_url ? "\n\n🧾 Invoice: " + inv.invoice_url : ""), sent_by: who, email_status: status });
  await admin.from("catering_leads").update({ last_from: "staff", last_message_at: new Date().toISOString(), unread: false }).eq("id", lead.id);
  const { data: fresh } = await admin.from("catering_quotes").select("*").eq("id", q.id).single();
  return { ok: true, quote: fresh, email: status, env: fresh?.square_env || envNow() };
}
// The customer emails, shared by send_* and preview so the preview is exactly what goes out.
const emailRow = (k: string, v: string) => `<tr><td style="padding:5px 18px 5px 0;color:${MUTE}">${k}</td><td>${v}</td></tr>`;
function proposalEmail(q: any, lead: any, message: string) {
  const msg = message || `Here's your catering proposal for ${fmtDate(lead.event_date)}. Take a look — when everything looks right, sign at the bottom and you'll go straight to the deposit.`;
  const dep = Math.round(q.total_cents * q.deposit_pct / 100);
  const html = shell(`<p>${para(msg)}</p>
    <table style="font:15px Georgia,serif;border-collapse:collapse;margin:14px 0">${emailRow("Total", `<b>${money(q.total_cents)}</b>`)}
    ${q.deposit_pct > 0 && q.deposit_pct < 100 ? emailRow("Deposit to book", `${money(dep)} (${q.deposit_pct}%)`) : ""}</table>
    ${btn(proposalLink(q), "Review & sign proposal")}`);
  return { msg, html };
}
function invoiceEmail(q: any, lead: any, message: string, total: number, url: string | null) {
  const pct = Number(q.deposit_pct), dep = Math.round(total * pct / 100), balDay = fmtDate(balanceDate(q, lead));
  const msg = message || `Here's the invoice for your GREYS catering on ${fmtDate(lead.event_date)}. You can pay securely online with the button below.`;
  const html = shell(`<p>${para(msg)}</p>
    <table style="font:15px Georgia,serif;border-collapse:collapse;margin:14px 0">${emailRow("Total", `<b>${money(total)}</b>`)}
    ${pct > 0 && pct < 100 ? emailRow(`Deposit (${pct}%)`, `${money(dep)} — due now`) + emailRow("Balance", `${money(total - dep)} — due ${esc(balDay)}`) : emailRow("Due", pct >= 100 ? "Now" : esc(balDay))}</table>
    ${url !== null ? btn(url || "#", "View & pay invoice") : "<p>Your invoice is on its way from Square.</p>"}`);
  return { msg, html };
}
// preview {quote_id, kind: "invoice"|"proposal", message} → the email + what Square will bill. Sends nothing.
async function preview(b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", clean(b.quote_id, 64)).single();
  if (!q) throw new PublicError("Save the quote first.");
  const { data: lead } = await admin.from("catering_leads").select("*").eq("id", q.lead_id).single();
  const kind = clean(b.kind, 20) === "proposal" ? "proposal" : "invoice";
  const message = clean(b.message, 4000);
  const today = todayCT(), bal = balanceDate(q, lead), pct = Number(q.deposit_pct);
  const dep = Math.round(q.total_cents * pct / 100);
  const schedule = pct > 0 && pct < 100
    ? [{ label: `Deposit (${pct}%)`, amount_cents: dep, due: today }, { label: "Balance", amount_cents: q.total_cents - dep, due: bal }]
    : [{ label: "Full amount", amount_cents: q.total_cents, due: pct >= 100 ? today : bal }];
  const when = fmtDate(lead.event_date) + (lead.event_time ? " at " + fmtTime(lead.event_time) : "");
  const about = [when, lead.guests ? `${lead.guests} guests` : "", FULFILL[lead.fulfillment] || "catering"].filter(Boolean).join(" · ") + ".";
  const email = kind === "proposal" ? proposalEmail(q, lead, message) : invoiceEmail(q, lead, message, q.total_cents, "");
  return {
    ok: true, kind, env: q.square_env || envNow(),
    email: { to: lead.email, from: FROM, reply_to: REPLY_TO, subject: "Re: " + subjectFor(lead), html: email.html },
    invoice: {
      title: `GREYS Catering #${lead.code}`, description: about + (q.customer_note ? "\n\n" + q.customer_note : ""),
      recipient: { name: lead.name, company: lead.company, email: lead.email }, location: lead.location || "Memphis",
      service_date: lead.event_date, items: q.items || [], tax_rate: Number(q.tax_rate),
      subtotal_cents: q.subtotal_cents, tax_cents: q.tax_cents, total_cents: q.total_cents, schedule,
      note: "Square sends its own invoice email too; totals can move a cent if Square rounds tax per line.",
    },
    past_event: !!(lead.event_date && lead.event_date < today),
  };
}
// ---------- refunds (2026-10-12) ----------
async function refundedOnOrder(e: Env, orderId: string) {
  const o = (await square(e, `/v2/orders/${orderId}`)).order;
  return ((o?.refunds || []) as any[]).filter((r) => !["REJECTED", "FAILED"].includes(r.status))
    .reduce((s, r) => s + Number(r.amount_money?.amount || 0), 0);
}
async function refund(who: string, b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", clean(b.quote_id, 64)).single();
  if (!q) throw new PublicError("Quote not found.");
  if (!q.square_invoice_id || !q.square_order_id) throw new PublicError("There's no Square invoice on this one.");
  const e: Env = (q.square_env as Env) || "sandbox";
  const order = (await square(e, `/v2/orders/${q.square_order_id}`)).order;
  const paymentIds = ((order?.tenders || []) as any[]).map((t) => t.payment_id || t.id).filter(Boolean);
  if (!paymentIds.length) throw new PublicError("Square has no payment on this invoice yet — hit ↻ Payment status first.");
  const pays: { id: string; left: number; created: string }[] = [];
  for (const id of paymentIds) {
    const p = (await square(e, `/v2/payments/${id}`)).payment;
    if (!p || p.status !== "COMPLETED") continue;
    const left = Number(p.total_money?.amount || 0) - Number(p.refunded_money?.amount || 0);
    if (left > 0) pays.push({ id: p.id, left, created: String(p.created_at || "") });
  }
  const refundable = pays.reduce((s, p) => s + p.left, 0);
  if (refundable <= 0) throw new PublicError("Nothing left to refund on this invoice.");
  const want = b.amount_cents == null || b.amount_cents === "" ? refundable : Math.round(Number(b.amount_cents));
  if (!(want > 0)) throw new PublicError("Enter an amount to refund.");
  if (want > refundable) throw new PublicError(`Only ${money(refundable)} can still be refunded.`);
  const reason = clean(b.reason, 180) || "GREYS catering refund";
  pays.sort((x, y) => y.created.localeCompare(x.created));
  let left = want, done = 0;
  // Square caps idempotency keys at 45 chars; same quote + same refunded-so-far + same amount = a double click
  const key = `r${String(q.id).slice(0, 8)}-${Number(q.refunded_cents || 0)}-${want}`;
  for (const p of pays) {
    if (left <= 0) break;
    const amt = Math.min(left, p.left);
    await square(e, "/v2/refunds", { method: "POST", body: JSON.stringify({
      idempotency_key: (key + "-" + p.id.slice(-12)).slice(0, 45), payment_id: p.id, amount_money: { amount: amt, currency: "USD" }, reason,
    }) });
    left -= amt; done += amt;
  }
  const total = Number(q.refunded_cents || 0) + done;
  await admin.from("catering_quotes").update({ refunded_cents: total, refunded_at: new Date().toISOString() }).eq("id", q.id);
  await note(q.lead_id, `↩ Refunded ${money(done)} by ${who} (${e})${reason ? " — " + reason : ""}. Square returns it to their card in 5–10 business days.`, who);
  const { data: fresh } = await admin.from("catering_quotes").select("*").eq("id", q.id).single();
  return { ok: true, refunded_cents: done, quote: fresh };
}
async function cancelInvoice(who: string, b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("*").eq("id", clean(b.quote_id, 64)).single();
  if (!q) throw new PublicError("Quote not found.");
  if (q.square_invoice_id) {
    const e: Env = (q.square_env as Env) || "sandbox";
    const inv = (await square(e, `/v2/invoices/${q.square_invoice_id}`)).invoice;
    if ((inv.status === "PAID" || inv.status === "PARTIALLY_PAID") && Number(q.refunded_cents || 0) < Number(q.amount_paid_cents || 0)) throw new PublicError("Money has been paid on this invoice — refund it first (↩ Refund).");
    if (!["CANCELED", "FAILED", "REFUNDED"].includes(inv.status)) {
      await square(e, `/v2/invoices/${q.square_invoice_id}/cancel`, { method: "POST", body: JSON.stringify({ version: inv.version }) });
    }
  }
  await admin.from("catering_quotes").update({ status: "canceled", invoice_status: q.square_invoice_id ? "CANCELED" : q.invoice_status }).eq("id", q.id);
  await note(q.lead_id, `${q.invoice_only ? "Invoice" : "Proposal" + (q.square_invoice_id ? " and Square invoice" : "")} canceled by ${who}.`, who);
  return { ok: true };
}
async function contractUrl(b: Record<string, unknown>) {
  const { data: q } = await admin.from("catering_quotes").select("pdf_path").eq("id", clean(b.quote_id, 64)).single();
  if (!q?.pdf_path) throw new PublicError("No signed PDF for this proposal.");
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(q.pdf_path, 600);
  if (error) throw new PublicError(error.message);
  return { ok: true, url: data.signedUrl };
}

// ---------- entry ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    let b: Record<string, unknown> = {};
    try { b = await req.json(); } catch { /* empty */ }
    const action = new URL(req.url).searchParams.get("action") ?? String(b.action ?? "");
    if (action === "ask") return json(await ask(req, b));
    if (action === "view") return json(await view(b));
    if (action === "sign") return json(await sign(req, b));
    const who = await staffEmail(req);
    if (action === "sync") {
      if (!who) {
        const { data: sec } = await admin.from("app_secrets").select("value").eq("name", "cc_cron_secret").maybeSingle();
        if (!sec?.value || clean(b.secret, 200) !== sec.value) return json({ ok: false, error: "Not authorized" }, 403);
      }
      return json(await sync(clean(b.quote_id, 64) || undefined));
    }
    if (!who) return json({ ok: false, error: "Not authorized" }, 403);
    if (action === "reply") return json(await reply(who, b));
    if (action === "log") return json(await logIn(b));
    if (action === "new_lead") return json(await newLead(who, b));
    if (action === "save_quote") return json(await saveQuote(who, b));
    if (action === "send_quote") return json(await sendQuote(who, b));
    if (action === "send_invoice") return json(await sendInvoice(who, b));
    if (action === "create_invoice") {
      const { data: q } = await admin.from("catering_quotes").select("status").eq("id", clean(b.quote_id, 64)).single();
      if (!q || q.status !== "signed") throw new PublicError("Only a signed proposal without an invoice can be invoiced.");
      try { return json({ ok: true, quote: await createInvoice(clean(b.quote_id, 64)) }); }
      catch (e) { throw new PublicError("Square: " + String((e as Error).message || e)); }
    }
    if (action === "preview") return json(await preview(b));
    if (action === "refund") return json(await refund(who, b));
    if (action === "cancel_invoice") return json(await cancelInvoice(who, b));
    if (action === "contract_url") return json(await contractUrl(b));
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json({ ok: false, error: e.message }, 400);
    console.error(`[${ref}]`, e);
    return json({ ok: false, error: `Something went wrong (ref ${ref}).` }, 500);
  }
});
