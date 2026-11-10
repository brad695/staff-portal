// class-email — email the guests of one class (or one Mahjong night / ticketed event).
//
// Maverick, 2026-11-09: "we need to be able to send emails to classes individually. build a template just
// like you did for the newsletter, and add the ability to be able to email an entire class".
//
// Staff write it in the manager console: a class → "✉ Email the class" (everyone booked), or "✉ Email" on one
// booking (just that party). The editor is the Cheese Club newsletter's template editor: the email itself in
// the GREYS site look — navy page, the GREYS logo, the site's menu band, Barlow Condensed headings over Nunito
// Sans text, pictures in brass frames, the gold square button and the light site footer with both shops. Staff
// fill in words and pictures: a headline, an optional top picture, text blocks (optional title + text), picture
// blocks (optional caption) and the class box (date, time, shop + address, and each guest's own tickets and
// confirmation code). Text is cleaned to p / br / b / i / u / links / lists.
//
// WHO GETS IT: the class's bookings that hold a seat — not refunded, and not a declined / abandoned card try
//   ('failed'), a checkout still in progress ('pending'), or 'canceled' / 'refunded'. From each booking: the
//   person who booked, plus every guest who gave their own email (registrations.guest_emails lines up with the
//   "Guests:" roster in notes by index) — the same people the confirmation email went to. One copy per email
//   address. audience {who:"all"} = everyone booked at the moment it sends (people who book later still get
//   it); {who:"some", emails:[…]} = only the people picked (and still booked).
// SENDING: like the newsletter. When an email starts, its recipients are copied into class_email_sends;
//   batches are claimed with class_em_claim (FOR UPDATE SKIP LOCKED) and sent through send-mail (SMTP2GO
//   first), 3 at a time. "Send now" sends straight away (a class is ~20 people); the class-email-run cron
//   (every 2 minutes, only when something is due) starts scheduled ones and finishes anything left.
// From "GREYS <shop> <info@greyscheese.com>", Reply-To the shared inbox (INQUIRY_REPLY_TO = info@). These are
//   service emails about a booking the guest made, so there's no unsubscribe link; the footer says why they
//   got it.
//
// Actions (POST ?action=…), verify_jwt = false — staff only: a manager's session (is_app_admin), or
// app_secrets.cc_cron_secret (the cron):
//   list · get · save · delete · preview · test · send · cancel · run
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const TZ = "America/Chicago";
const RUN_BUDGET_MS = 45_000, SEND_NOW_BUDGET_MS = 25_000, BATCH = 12, PARALLEL = 3;
const MAX_RCPT = 400; // a class is ~20 people; this only stops something silly
type ShopKey = "memphis" | "nashville";
const SHOP_FALLBACK: Record<ShopKey, any> = {
  memphis: { key: "memphis", label: "Memphis", name: "Greys Memphis", address: "709 S Mendenhall Rd", city: "Memphis, TN 38117", phone: null, email: null },
  nashville: { key: "nashville", label: "Nashville", name: "Greys Nashville", address: "4101 Charlotte Ave Ste D130", city: "Nashville, TN 37209", phone: null, email: null },
};

class PublicError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

// ---------- http ----------
function originOk(origin: string) {
  return /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/.test(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
}
function corsFor(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && originOk(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

// ---------- small helpers ----------
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const tidy = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const nowIso = () => new Date().toISOString();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
function todayCT() {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const isoDay = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? "")) ? String(v).slice(0, 10) : "");
const fmtD = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...o });
const longDay = (iso: string) => (iso ? fmtD(iso, { weekday: "long", month: "long", day: "numeric" }) : "");
// "18:00" → "6:00 PM" (anything else is shown as typed)
function fmtTime(t: unknown) {
  const s = tidy(t);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return s;
  const h = +m[1];
  if (h > 23) return s;
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
const firstOf = (name: string) => tidy(name).split(" ")[0] ?? "";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------- auth ----------
async function staff(req: Request, b: any): Promise<string | null> {
  const sec = clean(b.secret, 200);
  if (sec) {
    const { data } = await admin.from("app_secrets").select("value").eq("name", "cc_cron_secret").maybeSingle();
    if (data?.value && sec === data.value) return "cron";
  }
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === ANON) return null;
  if (tok === SERVICE) return "service";
  const user = createClient(SUPABASE_URL, ANON || SERVICE, { global: { headers: { Authorization: "Bearer " + tok } }, auth: { persistSession: false } });
  const { data, error } = await user.rpc("is_app_admin");
  if (error || data !== true) return null;
  const { data: u } = await admin.auth.getUser(tok);
  return u?.user?.email ?? "manager";
}

// ---------- the shops (address, phone, email — from Square, through square-club) ----------
let SHOPS: { at: number; v: Record<ShopKey, any> } | null = null;
async function shopInfo(): Promise<Record<ShopKey, any>> {
  if (SHOPS && Date.now() - SHOPS.at < 10 * 60_000) return SHOPS.v;
  let v: Record<ShopKey, any> = SHOP_FALLBACK;
  try {
    const r = await fetch(SUPABASE_URL + "/functions/v1/square-club?action=config", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d: any = await r.json();
    if (d?.shops?.memphis?.address && d?.shops?.nashville?.address) v = d.shops;
  } catch (err) { console.error("shops", err); }
  SHOPS = { at: Date.now(), v };
  return v;
}
const shopKeyOf = (loc: unknown): ShopKey | null => {
  const k = tidy(loc).toLowerCase();
  return k === "memphis" || k === "nashville" ? k : null;
};
const cityOnly = (city: unknown) => tidy(city).replace(/,?\s*[A-Z]{2}\s*\d{5}(-\d{4})?$/, "").replace(/,\s*$/, "");

// ---------- the class ----------
const EV_COLS = "id, title, date, time, location, kind, party_size, archived, image_url";
async function loadEvent(id: string) {
  if (!isUuid(id)) throw new PublicError("Class not found.", 404);
  const { data, error } = await admin.from("events").select(EV_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error("events: " + error.message);
  if (!data) throw new PublicError("Class not found.", 404);
  return data;
}
type Ctx = { ev: any; loc: string; shop: any | null };
async function ctxFor(ev: any): Promise<Ctx> {
  const k = shopKeyOf(ev.location), shops = await shopInfo();
  return { ev, loc: tidy(ev.location) || "Memphis", shop: k ? (shops[k] ?? SHOP_FALLBACK[k]) : null };
}
const kindOf = (ev: any) => (/mahjong/i.test(String(ev.title ?? "")) ? "mahjong" : ev.kind && ev.kind !== "class" ? "event" : "class");
function ticketsText(seats: number, ev: any) {
  const ps = Math.max(1, Number(ev.party_size) || 1);
  if (ps > 1) return plural(Math.max(1, Math.round(seats / ps)), "table", "tables");
  return plural(Math.max(1, seats), "ticket", "tickets");
}
function mapsUrl(c: Ctx) {
  if (!c.shop?.address) return "";
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(["GREYS Fine Cheeses", c.shop.address, c.shop.city].filter(Boolean).join(", "));
}

// ---------- who's booked ----------
// A booking holds a seat unless it's refunded or one of these (declined / abandoned card try, checkout in
// progress, canceled). 'legacy' (TicketSpice imports), 'paid', 'comp' and blank all count.
const NO_SEAT = new Set(["failed", "pending", "canceled", "cancelled", "refunded"]);
type Guest = { email: string; first_name: string; name: string; reg_id: string; code: string; seats: number; booked_by: string | null };
type Missing = { name: string; reg_id: string; why: string };
// the per-ticket guest roster tucked into notes ("Guests: Ann Lee (Wine pairing); Bo Ray") — same as the console
function guestNames(notes: unknown): { first: string; last: string }[] {
  const m = /(?:^|\n)Guests: ([^\n]*)/.exec(String(notes ?? ""));
  if (!m) return [];
  return m[1].split("; ").map((s) => {
    const mm = /^(.*?)(?:\s*\((.*)\))?$/.exec(s);
    const parts = tidy(mm?.[1] ?? "").split(" ");
    return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
  });
}
async function guestsFor(ev: any): Promise<{ list: Guest[]; missing: Missing[]; bookings: number; seats: number }> {
  const { data, error } = await admin.from("registrations")
    .select("id, code, name, email, qty, notes, guest_emails, refunded, payment_status, created_at")
    .eq("event_id", ev.id).eq("refunded", false).order("created_at").order("id").limit(3000);
  if (error) throw new Error("registrations: " + error.message);
  const by = new Map<string, Guest>();
  const missing: Missing[] = [];
  let bookings = 0, seats = 0;
  for (const r of (data ?? []) as any[]) {
    if (r.refunded || NO_SEAT.has(String(r.payment_status ?? "").trim().toLowerCase())) continue;
    const qty = Math.max(0, Math.floor(Number(r.qty) || 0));
    bookings++; seats += qty;
    const name = tidy(r.name), code = clean(r.code, 40);
    const email = String(r.email ?? "").trim().toLowerCase();
    if (validEmail(email)) {
      const cur = by.get(email);
      if (!cur) by.set(email, { email, first_name: firstOf(name), name, reg_id: String(r.id), code, seats: qty, booked_by: null });
      else if (cur.booked_by) Object.assign(cur, { first_name: cur.first_name || firstOf(name), name: name || cur.name, reg_id: String(r.id), code, seats: qty, booked_by: null });
      else cur.seats += qty; // booked twice: one email, the first booking's code, every ticket counted
    } else {
      missing.push({ name: name || "(no name)", reg_id: String(r.id), why: email ? "the email on the booking doesn't look right" : "no email on the booking" });
    }
    const names = guestNames(r.notes);
    const ge: unknown[] = Array.isArray(r.guest_emails) ? r.guest_emails : [];
    ge.forEach((x, i) => {
      const e = String(x ?? "").trim().toLowerCase();
      if (!validEmail(e) || by.has(e)) return;
      const g = names[i] ?? { first: "", last: "" };
      by.set(e, { email: e, first_name: tidy(g.first), name: tidy(`${g.first} ${g.last}`), reg_id: String(r.id), code, seats: qty, booked_by: name || "someone in your party" });
    });
  }
  return { list: [...by.values()], missing, bookings, seats };
}
type Aud = { who: "all" | "some"; emails: string[] };
function normAud(a: any): Aud {
  if (a?.who !== "some") return { who: "all", emails: [] };
  const emails = Array.isArray(a?.emails)
    ? [...new Set((a.emails as unknown[]).map((e) => String(e ?? "").trim().toLowerCase()).filter(validEmail))].slice(0, MAX_RCPT)
    : [];
  return { who: "some", emails };
}
function pickFrom(list: Guest[], aud: Aud) {
  if (aud.who === "all") return list;
  const s = new Set(aud.emails);
  return list.filter((g) => s.has(g.email));
}

// ---------- the content (class_emails.design) ----------
// { v: 1, headline, hero: { url } | null, button: "directions"|"classes"|"none",
//   blocks: [ {t:"text", title, html} | {t:"photo", url, caption} | {t:"class"} ] }
type TextBlock = { t: "text"; title: string; html: string };
type PhotoBlock = { t: "photo"; url: string; caption: string };
type ClassBlock = { t: "class" };
type Block = TextBlock | PhotoBlock | ClassBlock;
type Button = "directions" | "classes" | "none";
type Design = { v: 1; headline: string; hero: { url: string } | null; button: Button; blocks: Block[] };
const MAX_BLOCKS = 40;
const isDesign = (d: any): d is Design => !!d && typeof d === "object" && !Array.isArray(d) && d.v === 1 && Array.isArray(d.blocks);
const imgUrl = (v: unknown) => {
  const u = clean(v, 600);
  return /^https:\/\/[^\s"'<>\\]+$/i.test(u) ? u : "";
};
// The words in a text block come from the console's editor (contenteditable). Keep only paragraphs, line
// breaks, bold / italic / underline, links (http, https, mailto) and lists — everything else is dropped but
// its words are kept — and make sure every tag is closed. Merge tags pass through. (Same as club-newsletter.)
const RICH = new Map<string, string>(Object.entries({
  p: "p", div: "p", h1: "p", h2: "p", h3: "p", h4: "p", h5: "p", h6: "p", blockquote: "p",
  br: "br", b: "b", strong: "b", i: "i", em: "i", u: "u", a: "a", ul: "ul", ol: "ol", li: "li",
}));
const BLOCK_TAGS = new Set(["p", "ul", "ol"]);
function richText(t: string) {
  return t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function hrefOf(attrs: string) {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return "";
  const h = (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'").trim();
  return /^(https?:\/\/|mailto:)[^\s<>"'\\]+$/i.test(h) && h.length <= 600 ? h : "";
}
function richClean(html: string) {
  const s = String(html ?? "").slice(0, 40_000)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|template|noscript|svg|math|head|title|textarea|select|option)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  const out: string[] = [], open: string[] = []; // open: tags waiting for their close; "-a" = a link that was dropped
  const closeTo = (i: number) => { while (open.length > i) { const t = open.pop()!; if (t !== "-a") out.push(`</${t}>`); } };
  // a tag, or tag-like junk (</…>, <!…>, <?…>); a "<" that starts no tag is just text ("5 < 6")
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<[\/!?][^>]*>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    out.push(richText(s.slice(last, m.index)));
    last = tagRe.lastIndex;
    if (!m[2]) continue;
    const tag = RICH.get(m[2].toLowerCase());
    if (!tag) continue;
    if (tag === "br") { out.push("<br>"); continue; }
    if (m[1]) { // a closing tag: close back to its opener (a stray one is dropped)
      let i = open.length - 1;
      while (i >= 0 && !(open[i] === tag || (tag === "a" && open[i] === "-a"))) i--;
      if (i >= 0) closeTo(i);
      continue;
    }
    if (BLOCK_TAGS.has(tag)) { const i = open.lastIndexOf("p"); if (i >= 0) closeTo(i); } // no paragraph inside a paragraph
    if (tag === "li") { const i = Math.max(open.lastIndexOf("ul"), open.lastIndexOf("ol")); if (i < 0) { out.push("<br>"); continue; } }
    if (tag === "a") {
      const href = hrefOf(m[3] ?? "");
      if (!href || open.includes("a")) { open.push("-a"); continue; }
      out.push(`<a href="${esc(href)}">`); open.push("a"); continue;
    }
    out.push(`<${tag}>`); open.push(tag);
  }
  out.push(richText(s.slice(last)));
  closeTo(0);
  return out.join("")
    .replace(/<(b|i|u)>(\s*)<\/\1>/g, "$2")
    .replace(/<p>\s*<\/p>/g, "") // left by nesting (<div><div>…); a typed blank line is <p><br></p> and stays
    .replace(/(?:<p>(?:\s|&nbsp;|<br>)*<\/p>\s*)+$/i, "")
    .trim()
    .slice(0, 30_000);
}
const hasText = (html: unknown) => !!String(html ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
const richHasText = (html: string) => hasText(html.replace(/<br>/g, " "));
function designFrom(d: any): Design {
  const blocks: Block[] = [];
  const src = d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.blocks) ? (d.blocks as any[]) : [];
  for (const x of src) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!x || typeof x !== "object") continue;
    if (x.t === "text") blocks.push({ t: "text", title: clean(x.title, 160), html: richClean(String(x.html ?? "")) });
    else if (x.t === "photo") blocks.push({ t: "photo", url: imgUrl(x.url), caption: clean(x.caption, 300) });
    else if (x.t === "class") { if (!blocks.some((b) => b.t === "class")) blocks.push({ t: "class" }); }
  }
  const hero = imgUrl(d?.hero?.url);
  const button: Button = d?.button === "classes" || d?.button === "none" ? d.button : "directions";
  return { v: 1, headline: clean(d?.headline, 160), hero: hero ? { url: hero } : null, button, blocks };
}
// something a guest would read: a headline, a top picture, words in a block, or a picture
function designHasContent(d: Design) {
  if (clean(d.headline, 160) || d.hero?.url) return true;
  return d.blocks.some((b) => (b.t === "text" && (clean(b.title, 160) || richHasText(b.html))) || (b.t === "photo" && !!b.url));
}
function needContent(m: any) {
  if (!clean(m.subject, 200)) throw new PublicError("Add a subject first.");
  if (!isDesign(m.design) || !designHasContent(m.design)) throw new PublicError("Write the email first.");
}

// ---------- merge tags ----------
const TAGS = /\{\{\s*(first_name|class|date|time|shop|code|tickets)\s*\}\}/gi;
function mergeValue(key: string, g: Guest, c: Ctx) {
  switch (key.toLowerCase()) {
    case "first_name": return g.first_name || "there";
    case "class": return tidy(c.ev.title) || "your class";
    case "date": return longDay(isoDay(c.ev.date));
    case "time": return fmtTime(c.ev.time);
    case "shop": return c.loc;
    case "code": return g.code || "";
    case "tickets": return ticketsText(g.seats, c.ev);
    default: return "";
  }
}
const mergeTags = (s: string, g: Guest, c: Ctx, html: boolean) =>
  String(s ?? "").replace(TAGS, (_, k) => {
    const v = mergeValue(k, g, c);
    return html ? esc(v) : v;
  });

// ---------- the email: the GREYS site look (same as the club newsletter's template) ----------
const INK = "#06273A", PAPER = "#F5F7F2", CREAM = "#F7F4EC", GOLD = "#E6B33C", BRASS = "#896D39";
const LINE = "#E2DACA", TEXT = "#2E3A46", SUB = "#5E6773";
const FH = "'Barlow Condensed','HelveticaNeue-CondensedBold','Helvetica Neue Condensed Bold','Arial Narrow','sans-serif-condensed','Roboto Condensed',Arial,Helvetica,sans-serif";
const FB = "'Nunito Sans',Helvetica,Arial,sans-serif";
const LOGO = "https://cheeseclub.greyscheese.com/email-logo.png"; // 900x276, light on navy
const LOGO_INK = "https://cheeseclub.greyscheese.com/email-logo-ink.png"; // 900x276, navy on the footer colour
const WEB = "https://www.greyscheese.com";
const TICKETS = "https://tickets.greyscheese.com/";
const NAV: [string, string][] = [
  ["Order &amp; Shop", "https://orderonline.greyscheese.com/"],
  ["Book &amp; Reserve", TICKETS],
  ["Info &amp; FAQ", WEB + "/faq"],
];
const SHOP_PHONE: Record<ShopKey, [string, string]> = { memphis: ["901-440-GREY (4739)", "+19014404739"], nashville: ["615-900-GREY (4739)", "+16159004739"] };
const SOCIAL: [string, string][] = [["Instagram", "https://www.instagram.com/greysfinecheeses/"], ["Facebook", "https://www.facebook.com/901cheese/"]];
const RICH_STYLE: Record<string, string> = {
  p: `margin:0 0 14px;font-family:${FB};font-size:16px;line-height:1.6;color:${TEXT}`,
  ul: `margin:0 0 14px;padding:0 0 0 22px`,
  ol: `margin:0 0 14px;padding:0 0 0 22px`,
  li: `margin:0 0 7px;font-family:${FB};font-size:16px;line-height:1.55;color:${TEXT}`,
  b: `font-weight:800;color:${INK}`,
  a: `color:${BRASS};text-decoration:underline;font-weight:700`,
};
const styleRich = (html: string) =>
  html.replace(/<(p|ul|ol|li|b)>/g, (_, t: string) => `<${t} style="${RICH_STYLE[t]}">`)
    .replace(/<a href="([^"]*)">/g, (_, h: string) => `<a href="${h}" target="_blank" style="${RICH_STYLE.a}">`);
const framed = (url: string, w: number, alt: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${BRASS}" style="background:${BRASS};padding:4px;line-height:0;font-size:0">` +
  `<img src="${esc(url)}" width="${w}" alt="${esc(alt)}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none"></td></tr></table>`;
const BUTTON_TEXT: Record<Exclude<Button, "none">, string> = { directions: "Get directions", classes: "See upcoming classes" };

function emailHtml(m: any, g: Guest, c: Ctx, banner: string | null) {
  const D = designFrom(m.design);
  const ev = c.ev, day = isoDay(ev.date);
  const plain = (s: string) => esc(mergeTags(s, g, c, false));
  const subject = mergeTags(m.subject, g, c, false);
  const headline = plain(D.headline ?? "");
  const pre = mergeTags(m.preheader ?? "", g, c, false) || mergeTags(D.headline ?? "", g, c, false);
  const eyebrow = `GREYS ${esc(c.loc)}${day ? " &middot; " + esc(longDay(day)) : ""}`;
  const maps = mapsUrl(c);
  const row = (inner: string, pad = "0 0 26px") => `<tr><td style="padding:${pad}">${inner}</td></tr>`;

  // the class box: like the club's pickup banner — a calendar badge, the class, when, where, their booking
  const classBox = () => {
    const where = `GREYS ${esc(c.loc)}${c.shop?.address ? ` &middot; ${esc(c.shop.address)}${c.shop.city ? ", " + esc(cityOnly(c.shop.city)) : ""}` : ""}`;
    const theirs = (g.booked_by ? `Booked by ${esc(g.booked_by)}` : `Your booking: ${esc(ticketsText(g.seats, ev))}`) +
      (g.code ? ` &middot; Confirmation <b style="font-weight:800;color:${INK}">${esc(g.code)}</b>` : "");
    const badge = day ? `<td class="cbb" width="86" valign="top" style="padding:16px 0 16px 16px;width:70px">
<table role="presentation" width="70" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:70px;background:#FFFFFF;border:1px solid ${LINE}">
<tr><td align="center" bgcolor="${INK}" style="background:${INK};padding:5px 0;font-family:${FB};font-size:11px;line-height:1;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#FFFFFF">${esc(fmtD(day, { month: "short" }))}</td></tr>
<tr><td align="center" style="padding:5px 0 0;font-family:${FH};font-size:34px;line-height:1.1;font-weight:800;color:${INK}">${esc(fmtD(day, { day: "numeric" }))}</td></tr>
<tr><td align="center" style="padding:2px 0 7px;font-family:${FB};font-size:10px;line-height:1;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${SUB}">${esc(fmtD(day, { weekday: "short" }))}</td></tr>
</table></td>` : "";
    return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background:${CREAM};border-left:6px solid ${GOLD}"><tr>
${badge}<td class="cbx" valign="top" style="padding:16px 18px 16px 16px">
<div class="cbt" style="font-family:${FH};font-size:24px;line-height:1.08;font-weight:700;text-transform:uppercase;color:${INK};overflow-wrap:anywhere;word-break:break-word">${esc(tidy(ev.title))}</div>
<div style="margin-top:7px;font-family:${FB};font-size:15px;line-height:1.5;font-weight:700;color:${INK}">${esc(longDay(day))}${ev.time ? " &middot; " + esc(fmtTime(ev.time)) : ""}</div>
<div style="margin-top:2px;font-family:${FB};font-size:15px;line-height:1.5;color:${TEXT}">${where}${maps ? ` &middot; <a href="${esc(maps)}" target="_blank" style="color:${BRASS};text-decoration:underline;font-weight:700">Get directions</a>` : ""}</div>
<div style="margin-top:6px;font-family:${FB};font-size:14px;line-height:1.45;color:${SUB}">${theirs}</div>
</td></tr></table>`);
  };
  const blocks = D.blocks.map((b) => {
    if (b.t === "class") return classBox();
    if (b.t === "photo") {
      if (!b.url) return "";
      const cap = b.caption ? plain(b.caption) : "";
      return row(framed(b.url, 488, b.caption ? mergeTags(b.caption, g, c, false) : "") +
        (cap ? `<div style="margin:10px 0 0;font-family:${FB};font-size:14px;line-height:1.45;font-style:italic;color:${SUB};text-align:center">${cap}</div>` : ""), "2px 0 26px");
    }
    const title = b.title ? plain(b.title) : "";
    const words = richClean(b.html ?? "");
    if (!title && !richHasText(words)) return "";
    const body = words ? styleRich(mergeTags(words, g, c, true)) : "";
    return row((title
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="3" bgcolor="${BRASS}" style="width:40px;height:3px;background:${BRASS};font-size:0;line-height:0">&nbsp;</td></tr></table>` +
        `<h2 class="h2" style="margin:12px 0 10px;font-family:${FH};font-size:28px;line-height:1.05;font-weight:700;letter-spacing:.01em;text-transform:uppercase;color:${INK}">${title}</h2>`
      : "") + (body ? `<div style="font-family:${FB};font-size:16px;line-height:1.6;color:${TEXT}">${body}</div>` : ""), title ? "0 0 14px" : "0 0 12px");
  }).join("\n");

  // the gold button at the bottom of the card
  const btnHref = D.button === "directions" ? maps : D.button === "classes" ? TICKETS : "";
  const btn = btnHref && D.button !== "none" ? `<tr><td align="center" style="padding:4px 0 30px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${GOLD}" style="background:${GOLD}">
<a href="${esc(btnHref)}" target="_blank" style="display:inline-block;padding:15px 30px;font-family:${FB};font-size:13px;line-height:1.2;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:${INK};text-decoration:none">${BUTTON_TEXT[D.button as Exclude<Button, "none">]}</a>
</td></tr></table></td></tr>` : `<tr><td style="padding:0 0 18px;font-size:0;line-height:0">&nbsp;</td></tr>`;

  // the footer: both shops, like the site's
  const shopCell = (k: ShopKey, shops: Record<ShopKey, any>) => {
    const L = shops[k] ?? SHOP_FALLBACK[k], [ph, tel] = SHOP_PHONE[k];
    return `<td class="col" width="50%" valign="top" style="padding:0 16px 16px 0;font-family:${FB};font-size:13px;line-height:1.6;color:${INK}">` +
      `<div style="font-weight:800;letter-spacing:.08em">${esc(String(L.label ?? k).toUpperCase())}</div>` +
      `${esc(L.address ?? "")}${L.city ? "<br>" + esc(L.city) : ""}<br><a href="tel:${tel}" style="color:${INK};text-decoration:none">${esc(ph)}</a></td>`;
  };
  const shops = SHOPS?.v ?? SHOP_FALLBACK;
  const navCells = NAV.map(([t, u], i) => `<td class="nav" align="center" width="${i === 1 ? 36 : 32}%" style="padding:11px 4px;font-family:${FH};font-size:17px;line-height:1.2;font-weight:700;letter-spacing:1.4px;text-transform:uppercase"><a href="${u}" target="_blank" style="color:#FAFAFA;text-decoration:none">${t}</a></td>`).join("");
  const why = `You're getting this because ${g.booked_by ? "you're on a booking for" : "you booked"} ${esc(tidy(ev.title))}${day ? " on " + esc(fmtD(day, { month: "long", day: "numeric" })) : ""} at GREYS ${esc(c.loc)}.`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Nunito+Sans:ital,wght@0,400;0,700;0,800;1,400&display=swap" rel="stylesheet">
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media screen and (max-width:620px){
.px{padding-left:16px!important;padding-right:16px!important}
.card{padding-left:20px!important;padding-right:20px!important}
.h1{font-size:36px!important}
.h2{font-size:25px!important}
.eye{font-size:11.5px!important;letter-spacing:.14em!important}
.nav{font-size:14px!important;letter-spacing:1px!important;padding-left:2px!important;padding-right:2px!important}
.logo{width:240px!important}
.col{display:block!important;width:100%!important;padding-right:0!important}
.cbb{padding-left:12px!important}
.cbx{padding-left:12px!important;padding-right:12px!important}
.cbt{font-size:21px!important}
}
</style></head>
<body style="margin:0;padding:0;background:${INK}">
${pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(pre)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${INK}" style="background:${INK}"><tr><td align="center" style="padding:0">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
${banner ? `<tr><td style="background:#FDE7A8;padding:9px 16px;font-family:${FB};font-size:13px;line-height:1.45;color:${INK}">${banner}</td></tr>` : ""}
<tr><td class="px" bgcolor="${INK}" style="background:${INK};padding:28px 24px 22px"><a href="${WEB}" target="_blank" style="text-decoration:none"><img class="logo" src="${LOGO}" width="300" height="92" alt="GREYS Fine Cheeses" style="display:block;width:300px;max-width:100%;height:auto;border:0;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.2;font-weight:800;color:${PAPER}"></a></td></tr>
<tr><td class="px" bgcolor="${INK}" style="background:${INK};padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${PAPER};border-bottom:1px solid ${PAPER}"><tr>${navCells}</tr></table></td></tr>
<tr><td class="px" bgcolor="${INK}" style="background:${INK};padding:32px 24px ${D.hero?.url ? "24px" : "30px"}">
<div class="eye" style="font-family:${FB};font-size:12.5px;line-height:1.4;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:${GOLD}">${eyebrow}</div>
${headline ? `<h1 class="h1" style="margin:12px 0 0;font-family:${FH};font-size:46px;line-height:1;font-weight:700;letter-spacing:.01em;text-transform:uppercase;color:${PAPER}">${headline}</h1>` : ""}
</td></tr>
${D.hero?.url ? `<tr><td class="px" bgcolor="${INK}" style="background:${INK};padding:0 24px 30px">${framed(D.hero.url, 544, mergeTags(D.headline ?? "", g, c, false))}</td></tr>` : ""}
<tr><td class="px" bgcolor="${INK}" style="background:${INK};padding:0 24px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF">
<tr><td class="card" style="padding:32px 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${blocks}
${btn}
</table></td></tr>
</table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
<tr><td align="center" bgcolor="${PAPER}" style="background:${PAPER};padding:0;border-top:1px solid #E3E6DE">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
<tr><td class="px" bgcolor="${PAPER}" style="background:${PAPER};padding:28px 24px 26px">
<a href="${WEB}" target="_blank" style="text-decoration:none"><img src="${LOGO_INK}" width="170" height="52" alt="GREYS Fine Cheeses" style="display:block;width:170px;height:auto;border:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:${INK}"></a>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px"><tr>${shopCell("memphis", shops)}${shopCell("nashville", shops)}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:14px 0 0;border-top:1px solid ${LINE};font-family:${FB};font-size:12px;line-height:1.7;color:${SUB}">
${SOCIAL.map(([t, u]) => `<a href="${u}" target="_blank" style="color:${INK};font-weight:800;text-decoration:underline">${t}</a>`).join(" &nbsp;&middot;&nbsp; ")} &nbsp;&middot;&nbsp; <a href="${TICKETS}" target="_blank" style="color:${INK};font-weight:800;text-decoration:underline">Classes &amp; events</a><br>
${why} Questions? Just reply to this email.<br>
&copy; ${new Date().getFullYear()} GREYS Fine Cheeses
</td></tr></table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

const SAMPLE: Guest = { email: "sample@greyscheese.com", first_name: "Sam", name: "Sam Sample", reg_id: "", code: "CHZ-SAMPLE", seats: 2, booked_by: null };
const subjectFor = (m: any, g: Guest, c: Ctx, test: boolean) => (test ? "[TEST] " : "") + mergeTags(m.subject, g, c, false).replace(/\s+/g, " ").trim().slice(0, 200);
const fromFor = (c: Ctx) => `GREYS ${c.loc.replace(/[<>"@,;:]/g, "").slice(0, 40) || "Fine Cheeses"} <${Deno.env.get("CLASS_EMAIL_FROM_ADDR") || "info@greyscheese.com"}>`;
// guests' replies go to the shared inbox (info@ — where lead and chat mail moved 2026-11-03), not a person's
const replyFor = (_c: Ctx) => Deno.env.get("CLASS_EMAIL_REPLY_TO") || Deno.env.get("INQUIRY_REPLY_TO") || "info@greyscheese.com";

async function sendMail(to: string, subject: string, html: string, c: Ctx) {
  try {
    const res = await fetch(SUPABASE_URL + "/functions/v1/send-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
      body: JSON.stringify({ to, subject, html, from: fromFor(c), replyTo: replyFor(c) }),
    });
    const d: any = await res.json().catch(() => ({}));
    if (res.ok && d.ok !== false) return { ok: true as const, error: null };
    return { ok: false as const, error: String(d.error ?? JSON.stringify(d.attempts ?? d) ?? `send-mail ${res.status}`).slice(0, 300) };
  } catch (err) {
    return { ok: false as const, error: String(err).slice(0, 300) };
  }
}

// ---------- class email rows ----------
const LIST_COLS = "id, event_id, subject, preheader, audience, status, send_at, created_by, created_at, updated_at, started_at, finished_at, recipient_count, sent_count, failed_count, last_error";
async function loadEm(id: string) {
  if (!isUuid(id)) throw new PublicError("Email not found.", 404);
  const { data, error } = await admin.from("class_emails").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("class_emails: " + error.message);
  if (!data) throw new PublicError("Email not found.", 404);
  return data;
}
const draftFrom = (b: any) => ({
  subject: clean(b.subject, 200),
  preheader: clean(b.preheader, 200) || null,
  design: designFrom(b.design),
  audience: normAud(b.audience),
});
const guestOut = (g: Guest) => ({ email: g.email, name: g.name, first_name: g.first_name, booked_by: g.booked_by, code: g.code, seats: g.seats, reg_id: g.reg_id });

async function list(b: any) {
  const ev = await loadEvent(clean(b.event_id, 40));
  const [c, gs, ems] = await Promise.all([
    ctxFor(ev),
    guestsFor(ev),
    admin.from("class_emails").select(LIST_COLS).eq("event_id", ev.id).order("created_at", { ascending: false }).limit(60),
  ]);
  if (ems.error) throw new Error("class_emails: " + ems.error.message);
  const today = todayCT();
  return {
    ok: true, today,
    event: {
      id: ev.id, title: tidy(ev.title), date: isoDay(ev.date), time: ev.time, time_label: fmtTime(ev.time), location: c.loc,
      kind: kindOf(ev), party_size: Math.max(1, Number(ev.party_size) || 1), past: isoDay(ev.date) < today,
      image_url: imgUrl(ev.image_url) || null,
      shop: c.shop ? { label: c.shop.label ?? c.loc, address: c.shop.address ?? "", city: c.shop.city ?? "" } : null,
    },
    bookings: gs.bookings, seats: gs.seats,
    guests: gs.list.map(guestOut),
    missing: gs.missing,
    emails: ems.data ?? [],
  };
}
async function get(b: any) {
  const m = await loadEm(clean(b.id, 40));
  const { data: failed } = await admin.from("class_email_sends").select("email, first_name, error").eq("email_id", m.id).eq("status", "failed").order("id").limit(200);
  return { ok: true, email: m, failed: failed ?? [] };
}
async function save(b: any, who: string) {
  const d = draftFrom(b), id = clean(b.id, 40);
  if (id) {
    const cur = await loadEm(id);
    if (b.event_id && clean(b.event_id, 40) !== cur.event_id) throw new PublicError("Email not found.", 404);
    if (!["draft", "scheduled"].includes(cur.status)) throw new PublicError("This email already went out. Copy it into a new draft to send another.", 409);
    const { data, error } = await admin.from("class_emails").update({ ...d, updated_at: nowIso() }).eq("id", id).in("status", ["draft", "scheduled"]).select(LIST_COLS + ", design").maybeSingle();
    if (error) throw new Error("class_emails: " + error.message);
    if (!data) throw new PublicError("This email just started sending, so it can't be changed.", 409);
    return { ok: true, email: data };
  }
  const ev = await loadEvent(clean(b.event_id, 40));
  const { data, error } = await admin.from("class_emails").insert({ ...d, event_id: ev.id, status: "draft", created_by: who }).select(LIST_COLS + ", design").single();
  if (error) throw new Error("class_emails: " + error.message);
  return { ok: true, email: data };
}
async function remove(b: any) {
  const m = await loadEm(clean(b.id, 40));
  if (!["draft", "canceled"].includes(m.status)) throw new PublicError("Only drafts can be deleted.", 409);
  await admin.from("class_emails").delete().eq("id", m.id).in("status", ["draft", "canceled"]);
  return { ok: true };
}
// preview / test work on what's in the editor, saved or not: a saved email's fields, with whatever the editor
// sent on top (a field that wasn't sent keeps its saved value)
async function contentFrom(b: any) {
  const id = clean(b.id, 40);
  const base: any = id ? await loadEm(id) : null;
  if (base && b.event_id && clean(b.event_id, 40) !== base.event_id) throw new PublicError("Email not found.", 404);
  const ev = await loadEvent(base ? base.event_id : clean(b.event_id, 40));
  const d: any = draftFrom(b);
  const m: any = base ? { ...base } : { ...d };
  if (base) for (const k of ["subject", "preheader", "design", "audience"]) if (k in b) m[k] = d[k];
  m.event_id = ev.id;
  return { m, ev };
}
async function sampleGuest(ev: any, aud: Aud): Promise<Guest> {
  try {
    const gs = await guestsFor(ev);
    const picked = pickFrom(gs.list, aud);
    if (picked.length) return picked[0];
    if (gs.list.length) return gs.list[0];
  } catch { /* sample */ }
  return SAMPLE;
}
async function preview(b: any) {
  const { m, ev } = await contentFrom(b);
  const c = await ctxFor(ev), g = await sampleGuest(ev, normAud(m.audience));
  return { ok: true, subject: subjectFor(m, g, c, false), to: g.email, html: emailHtml(m, g, c, null) };
}
async function test(b: any) {
  const to = clean(b.to, 200).toLowerCase();
  if (!validEmail(to)) throw new PublicError("Enter the email address the test should go to.");
  const { m, ev } = await contentFrom(b);
  needContent(m);
  const c = await ctxFor(ev), g = await sampleGuest(ev, normAud(m.audience));
  const html = emailHtml(m, g, c, `<b>Test copy</b> — only you got this. The guest details show ${esc(g.first_name || g.name || "a guest")}'s booking.`);
  const res = await sendMail(to, subjectFor(m, g, c, true), html, c);
  if (!res.ok) throw new PublicError("The test email didn't go out: " + res.error, 502);
  return { ok: true, sent_to: to };
}

// snapshot who it goes to and flip the email to 'sending'
async function start(m: any) {
  if (!["draft", "scheduled"].includes(m.status)) return m;
  needContent(m);
  const ev = await loadEvent(m.event_id);
  const gs = await guestsFor(ev);
  const aud = normAud(m.audience);
  const to = pickFrom(gs.list, aud);
  if (!to.length) {
    const why = aud.who === "some" ? "Nobody you picked is still booked on this class, so nothing was sent." : "Nobody booked on this class has an email, so nothing was sent.";
    await admin.from("class_emails").update({ last_error: why, updated_at: nowIso() }).eq("id", m.id);
    throw new PublicError(why, 409);
  }
  if (to.length > MAX_RCPT) throw new PublicError(`That's ${to.length} people — more than a class email can go to.`, 409);
  await admin.from("class_email_sends").delete().eq("email_id", m.id).eq("status", "queued");
  const rows = to.map((g) => ({ email_id: m.id, registration_id: isUuid(g.reg_id) ? g.reg_id : null, email: g.email, first_name: g.first_name || null, merge: { name: g.name, code: g.code, seats: g.seats, booked_by: g.booked_by } }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("class_email_sends").upsert(rows.slice(i, i + 500), { onConflict: "email_id,email", ignoreDuplicates: true });
    if (error) throw new Error("class_email_sends: " + error.message);
  }
  const { data } = await admin.from("class_emails").update({
    status: "sending", started_at: nowIso(), send_at: m.send_at ?? nowIso(), recipient_count: rows.length, last_error: null, updated_at: nowIso(),
  }).eq("id", m.id).in("status", ["draft", "scheduled"]).select("*").maybeSingle();
  return data ?? (await loadEm(m.id));
}

// send queued recipients until the time budget runs out
async function drain(budgetMs: number, only?: string) {
  const until = Date.now() + budgetMs;
  const out: any[] = [];
  if (!only) {
    const { data: due } = await admin.from("class_emails").select("*").eq("status", "scheduled").lte("send_at", nowIso()).order("send_at").limit(10);
    for (const m of due ?? []) {
      try { await start(m); } catch (err) {
        const msg = String((err as Error).message).slice(0, 300);
        await admin.from("class_emails").update({ status: "draft", last_error: "Scheduled send didn't start: " + msg, updated_at: nowIso() }).eq("id", m.id).eq("status", "scheduled");
        out.push({ id: m.id, error: msg });
      }
    }
  }
  let q = admin.from("class_emails").select("*").eq("status", "sending");
  if (only) q = q.eq("id", only);
  const { data: sending } = await q.order("started_at").limit(10);
  for (const m of sending ?? []) {
    let c: Ctx;
    try { c = await ctxFor(await loadEvent(m.event_id)); } catch (err) {
      await admin.from("class_emails").update({ status: "canceled", last_error: "The class is gone: " + String((err as Error).message).slice(0, 200), updated_at: nowIso() }).eq("id", m.id).eq("status", "sending");
      await admin.from("class_email_sends").update({ status: "skipped" }).eq("email_id", m.id).eq("status", "queued");
      continue;
    }
    let sent = 0, failed = 0;
    while (Date.now() < until - 4000) {
      const { data: batch, error } = await admin.rpc("class_em_claim", { p_email: m.id, p_limit: BATCH });
      if (error) throw new Error("class_em_claim: " + error.message);
      const rows = (batch ?? []) as any[];
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += PARALLEL) {
        await Promise.all(rows.slice(i, i + PARALLEL).map(async (s) => {
          const x = s.merge ?? {};
          const g: Guest = { email: s.email, first_name: s.first_name ?? "", name: String(x.name ?? ""), reg_id: String(s.registration_id ?? ""), code: String(x.code ?? ""), seats: Number(x.seats) || 0, booked_by: x.booked_by ? String(x.booked_by) : null };
          const res = await sendMail(s.email, subjectFor(m, g, c, false), emailHtml(m, g, c, null), c);
          if (res.ok) sent++; else failed++;
          await admin.from("class_email_sends").update(res.ok ? { status: "sent", sent_at: nowIso(), error: null } : { status: "failed", error: res.error })
            .eq("id", s.id).eq("status", "sending");
        }));
      }
    }
    const { data: p } = await admin.rpc("class_em_progress", { p_email: m.id });
    out.push({ id: m.id, sent_now: sent, failed_now: failed, status: (p as any)?.status ?? m.status, sent: (p as any)?.sent_count, of: (p as any)?.recipient_count });
    if (Date.now() >= until - 4000) break;
  }
  return out;
}

async function send(b: any) {
  const m = await loadEm(clean(b.id, 40));
  if (!["draft", "scheduled"].includes(m.status)) throw new PublicError(m.status === "sending" ? "It's already sending." : "This email already went out.", 409);
  const when = clean(b.send_at, 40);
  if (when) {
    const t = Date.parse(when);
    if (Number.isNaN(t)) throw new PublicError("Pick a date and time to send it.");
    if (t > Date.now() + 60_000) {
      if (t > Date.now() + 120 * 86400000) throw new PublicError("Schedule it within the next 4 months.");
      needContent(m);
      const { data } = await admin.from("class_emails").update({ status: "scheduled", send_at: new Date(t).toISOString(), last_error: null, updated_at: nowIso() })
        .eq("id", m.id).in("status", ["draft", "scheduled"]).select(LIST_COLS).maybeSingle();
      return { ok: true, scheduled: true, email: data };
    }
  }
  await start({ ...m, send_at: null });
  const run = await drain(SEND_NOW_BUDGET_MS, m.id);
  const { data } = await admin.from("class_emails").select(LIST_COLS).eq("id", m.id).single();
  return { ok: true, started: true, email: data, run };
}
async function cancel(b: any) {
  const m = await loadEm(clean(b.id, 40));
  if (m.status === "scheduled") {
    const { data } = await admin.from("class_emails").update({ status: "draft", send_at: null, updated_at: nowIso() }).eq("id", m.id).eq("status", "scheduled").select(LIST_COLS).maybeSingle();
    return { ok: true, email: data };
  }
  if (m.status === "sending") {
    await admin.from("class_emails").update({ status: "canceled", updated_at: nowIso() }).eq("id", m.id).eq("status", "sending");
    await admin.from("class_email_sends").update({ status: "skipped" }).eq("email_id", m.id).eq("status", "queued");
    const { data: p } = await admin.rpc("class_em_progress", { p_email: m.id });
    return { ok: true, email: p };
  }
  throw new PublicError("Nothing to stop — it isn't scheduled or sending.", 409);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    const text = await req.text();
    if (text.length > 300_000) return json(req, { ok: false, error: "That's too big to send. Use fewer or smaller photos." }, 413);
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* empty */ }
    if (!body || typeof body !== "object") body = {};
    const action = new URL(req.url).searchParams.get("action") ?? String(body.action ?? "");
    const who = await staff(req, body);
    if (!who) return json(req, { ok: false, error: "Not allowed." }, 403);
    if (action === "list") return json(req, await list(body));
    if (action === "get") return json(req, await get(body));
    if (action === "save") return json(req, await save(body, who));
    if (action === "delete") return json(req, await remove(body));
    if (action === "preview") return json(req, await preview(body));
    if (action === "test") return json(req, await test(body));
    if (action === "send") return json(req, await send(body));
    if (action === "cancel") return json(req, await cancel(body));
    if (action === "run") return json(req, { ok: true, run: await drain(RUN_BUDGET_MS) });
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message }, e.status);
    console.error(`[${ref}]`, e);
    return json(req, { ok: false, error: `Something went wrong (ref ${ref}). Please try again.` }, 500);
  }
});
