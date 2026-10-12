// chat-api — the only door into Greys Chat.
//
// Every chat_* table is RLS-locked with no anon/authenticated grants; this function
// (service role) is the sole reader/writer. Browsers sign in with their portal
// employee ID (same trust level as the rest of the staff portal) and get a signed
// session token (HMAC-SHA256 keyed on the service-role key, 30-day expiry).
//
// Realtime: DB triggers (chat_ping) broadcast content-free pings {t,c,m} on the
// public 'greys-chat' topic. Clients refetch the row here, so no content ever
// leaves except through a membership check.
//
// Catering leads (2026-10-12): every catering_leads row has a client conversation (chat_convos.lead_id)
// with all managers on it; DB triggers mirror messages both ways with catering_messages (see
// sql/2026-10-12_chat_catering_leads.sql). Here: lead details on boot/convo (managers only),
// lead_stage, and lead emails sent in the catering format.
//
// POST { a: <action>, ...args }   header x-chat-token: <token>   (verify_jwt = false)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TW_FROM = Deno.env.get("TWILIO_FROM") ?? "";
const CHAT_FROM = Deno.env.get("CHAT_MAIL_FROM") ?? "info@greyscheese.com";
// Catering leads (chat_convos.lead_id): emails keep the catering subject "[#CODE]" and Reply-To, so the
// customer's reply comes back through the inquiry Gmail sync → catering_messages → a DB trigger → chat.
const LEAD_REPLY_TO = Deno.env.get("CATERING_REPLY_TO") || Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com";
const LEAD_FROM_ADDR = (/<([^>]+)>/.exec(Deno.env.get("INQUIRY_FROM") || "") || [])[1] || CHAT_FROM;
const STAGES = ["new", "replied", "quoted", "contract_sent", "signed", "invoiced", "deposit_paid", "paid", "lost"];
const LEAD_COLS = "id,code,name,email,phone,company,location,event_date,event_time,guests,fulfillment,address,occasion,budget,stage,unread,last_message_at,created_at,beo_rev";
const QUOTE_COLS = "lead_id,status,total_cents,deposit_pct,amount_paid_cents,invoice_status,invoice_url,invoice_number,sent_at,viewed_at,signed_at,signed_name,invoice_only,balance_due_date,deposit_paid_at,paid_at,created_at";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-chat-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }
const fail = (s: number, m: string): never => { throw new HttpErr(s, m); };
const str = (v: unknown) => (v == null ? "" : String(v));
const likeLit = (s: string) => s.replace(/([\\%_])/g, "\\$1");

/* ---------- tokens ---------- */
const enc = new TextEncoder();
let _key: CryptoKey | null = null;
async function key() {
  if (!_key) _key = await crypto.subtle.importKey("raw", enc.encode("greys-chat:" + SB_SERVICE), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return _key;
}
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mint(emp: number) {
  const body = `${emp}.${Date.now() + 30 * 864e5}`;
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await key(), enc.encode(body)));
}
async function verify(tok: string): Promise<number | null> {
  const p = tok.split(".");
  if (p.length !== 3) return null;
  const body = p[0] + "." + p[1];
  const sig = b64u(await crypto.subtle.sign("HMAC", await key(), enc.encode(body)));
  if (sig !== p[2] || Number(p[1]) < Date.now()) return null;
  return Number(p[0]) || null;
}

/* ---------- phone / desktop notifications (Web Push) ----------
   The VAPID key pair lives in app_secrets 'chat_vapid' as {pub, jwk}; it's made here on first use
   (one row, so two first calls can't end up with mismatched halves). Only `pub` ever leaves.
   chat-notify does the sending. */
async function vapidPub(): Promise<string> {
  const read = async () => (await db.from("app_secrets").select("value").eq("name", "chat_vapid").maybeSingle()).data?.value as string | undefined;
  let v = await read();
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    await db.from("app_secrets").upsert({ name: "chat_vapid", value: JSON.stringify({ pub, jwk }) }, { onConflict: "name", ignoreDuplicates: true });
    v = await read();
  }
  try { return JSON.parse(v || "{}").pub || ""; } catch { return ""; }
}
// only real browser push services — chat-notify POSTs to these URLs
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const b64norm = (s: unknown) => str(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* ---------- html sanitizer (stored messages render as HTML in every browser) ---------- */
const ALLOW = new Set(["b", "i", "s", "code", "pre", "blockquote", "ul", "ol", "li", "br", "a", "span"]);
function sanitize(html: string): string {
  const s = str(html).slice(0, 40000);
  let out = "";
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^<>]*)>/g;
  let last = 0, m: RegExpExecArray | null;
  const text = (t: string) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  while ((m = re.exec(s))) {
    out += text(s.slice(last, m.index));
    last = re.lastIndex;
    const close = m[1] === "/", tag = m[2].toLowerCase(), attrs = m[3] || "";
    if (!ALLOW.has(tag)) continue;
    if (tag === "br") { out += "<br>"; continue; }
    if (close) {
      const i = stack.lastIndexOf(tag);
      if (i >= 0) { while (stack.length > i) out += `</${stack.pop()}>`; }
      continue;
    }
    const at = (n: string) => { const r = new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, "i").exec(attrs); return r ? r[1] : ""; };
    if (tag === "a") {
      const href = at("href").replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(href)) { continue; }
      out += `<a href="${href.replace(/"/g, "%22").replace(/</g, "%3C")}" target="_blank" rel="noopener">`;
      stack.push("a"); continue;
    }
    if (tag === "span") {
      const cls = at("class");
      if (/\bmention\b/.test(cls)) {
        const uid = at("data-uid").replace(/[^a-z0-9]/gi, "");
        out += uid ? `<span class="mention" data-uid="${uid}">` : `<span class="mention bc" data-bc="1">`;
      } else if (/\bchlink\b/.test(cls)) {
        out += `<span class="chlink" data-go="${at("data-go").replace(/[^a-z0-9-]/gi, "")}">`;
      } else out += "<span>";
      stack.push("span"); continue;
    }
    out += `<${tag}>`; stack.push(tag);
  }
  out += text(s.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out.replace(/^(\s|<br>|&nbsp;)+|(\s|<br>|&nbsp;)+$/g, "");
}
const plain = (h: string) => str(h).replace(/<br\s*\/?>/g, "\n").replace(/<\/(li|blockquote|pre)>/g, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

/* ---------- helpers ---------- */
const e164 = (p: unknown) => {
  const raw = str(p).trim(), d = raw.replace(/\D/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return /^\d{8,15}$/.test(d) ? "+" + d : "";
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
};
const isMgr = (e: any) => /manager|owner|admin/i.test(str(e?.role));
async function emp(id: number) {
  const { data } = await db.from("portal_employees").select("id,name,role,location,active").eq("id", id).maybeSingle();
  return data && data.active ? data : null;
}
async function convo(id: string) {
  const { data } = await db.from("chat_convos").select("*").eq("id", id).maybeSingle();
  return data;
}
async function member(cid: string, me: number) {
  const { data } = await db.from("chat_members").select("*").eq("convo_id", cid).eq("emp_id", me).maybeSingle();
  return data;
}
async function mustMember(cid: string, me: number) {
  const m = await member(cid, me);
  if (!m) fail(403, "You're not in this conversation.");
  return m;
}
async function signFiles(rows: any[]) {
  const paths: string[] = [];
  rows.forEach((r) => (r.files || []).forEach((f: any) => f.path && paths.push(f.path)));
  if (!paths.length) return;
  const { data } = await db.storage.from("chat-files").createSignedUrls(paths, 60 * 60 * 24 * 7);
  const map: Record<string, string> = {};
  (data || []).forEach((d: any) => { if (d.path && d.signedUrl) map[d.path] = d.signedUrl; });
  rows.forEach((r) => (r.files || []).forEach((f: any) => { if (f.path) f.url = map[f.path] || ""; }));
}
// .in() filters ride in the URL, so long id lists go in slices
async function inAll(ids: string[], q: (part: string[]) => PromiseLike<{ data: any[] | null }>, size = 100): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += size) { const { data } = await q(ids.slice(i, i + size)); out.push(...(data || [])); }
  return out;
}
async function withReactions(rows: any[]) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const rx = await inAll(ids, (p) => db.from("chat_reactions").select("message_id,emp_id,emoji").in("message_id", p), 150);
  const by: Record<string, Record<string, number[]>> = {};
  rx.forEach((r) => { ((by[r.message_id] ||= {})[r.emoji] ||= []).push(r.emp_id); });
  rows.forEach((r) => (r.rx = by[r.id] || {}));
  await signFiles(rows);
  return rows;
}
const MSG_COLS = "id,convo_id,parent_id,emp_id,author_kind,body_html,via,is_note,subject,status,error,files,card,fwd,also_channel,pinned_by,edited_at,deleted_at,created_at";

async function sendSms(to: string, body: string, msgId: string) {
  const phone = e164(to);
  if (!phone) return { ok: false, err: "That client has no valid mobile number." };
  if (!(TW_SID && TW_TOKEN && TW_FROM)) return { ok: false, err: "Texting isn't set up." };
  const p = new URLSearchParams({ To: phone, Body: body.slice(0, 1550), StatusCallback: `${SB_URL}/functions/v1/chat-sms-in?status=${msgId}` });
  if (/^MG[0-9a-fA-F]{32}$/.test(TW_FROM)) p.set("MessagingServiceSid", TW_FROM); else p.set("From", TW_FROM);
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: p.toString(),
    });
    const d: any = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, sid: d.sid } : { ok: false, err: str(d.message || r.status) };
  } catch (e) { return { ok: false, err: String(e) }; }
}
// Client email replies come back into chat: Reply-To is info+c<code>@greyscheese.com (one private code
// per client conversation). info@ mail lands in brad@greyscheese.com's Gmail, where the "Greys Chat
// mail" Apps Script hands those replies to chat-mail-in.
async function replyAddress(c: any) {
  let code = str(c.reply_token);
  if (!/^[a-z0-9]{10}$/.test(code)) {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 symbols, no look-alikes
    code = [...crypto.getRandomValues(new Uint8Array(10))].map((x) => abc[x % 32]).join("");
    await db.from("chat_convos").update({ reply_token: code }).eq("id", c.id).is("reply_token", null);
    const { data } = await db.from("chat_convos").select("reply_token").eq("id", c.id).maybeSingle(); // a racing send may have won
    code = str(data?.reply_token) || code;
  }
  const [local, domain] = CHAT_FROM.split("@");
  return `${local}+c${code}@${domain}`;
}
// Until the Gmail script has checked in (chat-mail-in pins app_secrets 'chat_mail_aud' on its first
// call), replies keep going to the sender's own inbox as before.
async function replyTo(c: any, me: number) {
  const { data: live } = await db.from("app_secrets").select("name").eq("name", "chat_mail_aud").maybeSingle();
  if (live) return replyAddress(c);
  const { data: ct } = await db.from("portal_employee_contacts").select("email").eq("employee_id", me).maybeSingle();
  return str(ct?.email);
}
const escH = (s: unknown) => str(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// attachments go out as links (signed for 7 days)
const fileList = (files: any[]) => files.length
  ? `<p style="margin:14px 0 0;font-size:14px">${files.map((f) => `📎 <a href="${escH(f.url)}">${escH(f.name)}</a>`).join("<br>")}</p>` : "";
async function mail(to: string, subject: string, html: string, from: string, replyTo: string) {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/send-mail`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}` },
      body: JSON.stringify({ to, subject, html, from, replyTo }),
    });
    const d: any = await r.json().catch(() => ({}));
    return d.ok ? { ok: true } : { ok: false, err: "Email didn't send. Try again." };
  } catch (e) { return { ok: false, err: String(e) }; }
}
async function sendEmail(to: string, subject: string, html: string, fromName: string, replyTo: string, files: any[] = []) {
  if (!to) return { ok: false, err: "That client has no email address." };
  const body = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d1c1d">${html}${fileList(files)}</div>
    <p style="margin-top:24px;color:#6b7280;font-size:13px">${escH(fromName)}<br>GREYS Fine Cheeses · greyscheese.com</p>`;
  return mail(to, subject, body, `${fromName} at GREYS <${CHAT_FROM}>`, replyTo || CHAT_FROM);
}
// a catering lead gets the same branded email as the rest of its thread (catering function's look)
async function sendLeadEmail(to: string, subject: string, html: string, fromName: string, files: any[] = []) {
  if (!to) return { ok: false, err: "This lead has no email address." };
  const body = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#221E1B;line-height:1.55">
     <div style="background:#06273A;color:#FFFFFF;padding:14px 18px;margin-bottom:18px;font:700 22px Georgia,serif;letter-spacing:.04em">GREYS <span style="font:400 12px Arial;color:#FFFFFF">Fine Cheeses · Charcuterie · Wine</span></div>
     <div style="font-size:16px">${html}</div>${fileList(files)}
     <p style="margin-top:22px">${escH(fromName)}<br><span style="font:13px Arial;color:#6E6353">GREYS Fine Cheeses · greyscheese.com</span></p>
     <p style="font:12px Arial;color:#6E6353;margin-top:28px">Just reply to this email to keep the conversation going.</p></div>`;
  return mail(to, subject, body, `${fromName} at GREYS <${LEAD_FROM_ADDR}>`, LEAD_REPLY_TO);
}
const leadSubject = (code: string) => `Re: Your GREYS catering question [#${code}]`;

/* ---------- catering leads ---------- */
// lead row + its current proposal/invoice (newest one that isn't canceled), by lead id
async function leadsFor(ids: string[]) {
  const out: Record<string, any> = {};
  if (!ids.length) return out;
  (await inAll(ids, (p) => db.from("catering_leads").select(LEAD_COLS).in("id", p))).forEach((l) => (out[l.id] = { ...l, quote: null }));
  const qs = await inAll(ids, (p) => db.from("catering_quotes").select(QUOTE_COLS).in("lead_id", p).neq("status", "canceled"));
  qs.sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)))
    .forEach((q) => { const l = out[q.lead_id]; if (l && !l.quote) l.quote = q; });
  return out;
}
// lead details only ever go to managers (catering data is manager-only in the portal too)
async function withLeads(list: any[], mgr: boolean) {
  const ids = [...new Set(list.filter((c) => c.lead_id).map((c) => str(c.lead_id)))];
  if (!ids.length || !mgr) return list;
  const map = await leadsFor(ids);
  list.forEach((c) => { if (c.lead_id) c.lead = map[c.lead_id] || null; });
  return list;
}

/* ---------- actions ---------- */
async function boot(me: number) {
  const { data: people } = await db.from("portal_employees").select("id,name,role,location,active").eq("active", true).order("name");
  const { data: profs } = await db.from("chat_profiles").select("*");
  const pmap: Record<number, any> = {};
  (profs || []).forEach((p) => (pmap[p.emp_id] = p));
  const { data: contacts } = await db.from("portal_employee_contacts").select("employee_id,email,phone");
  const cmap: Record<number, any> = {};
  (contacts || []).forEach((c) => (cmap[c.employee_id] = c));
  const ppl = (people || []).map((e) => ({
    id: e.id, name: e.name, role: e.role, location: e.location,
    title: pmap[e.id]?.title || "", color: pmap[e.id]?.color || "",
    status_e: pmap[e.id]?.status_emoji || "", status_t: pmap[e.id]?.status_text || "",
    away: !!pmap[e.id]?.away, email: cmap[e.id]?.email || "",
  }));
  if (!pmap[me]) await db.from("chat_profiles").insert({ emp_id: me });
  const mgr = isMgr((people || []).find((e) => e.id === me));
  // managers are on every catering lead (a new manager catches up here)
  if (mgr) await db.rpc("chat_lead_join", { p_emp: me });

  const { data: mine } = await db.from("chat_members").select("*").eq("emp_id", me);
  const myIds = (mine || []).map((m) => m.convo_id);
  const { data: pub } = await db.from("chat_convos").select("*").eq("kind", "channel").eq("is_private", false).eq("archived", false);
  const memConvos = await inAll(myIds, (p) => db.from("chat_convos").select("*").in("id", p));
  const all: Record<string, any> = {};
  [...(pub || []), ...memConvos].forEach((c) => (all[c.id] = c));
  const ids = Object.keys(all);
  const mems = await inAll(ids, (p) => db.from("chat_members").select("convo_id,emp_id").in("convo_id", p));
  const memBy: Record<string, number[]> = {};
  mems.forEach((m) => (memBy[m.convo_id] ||= []).push(m.emp_id));
  const myBy: Record<string, any> = {};
  (mine || []).forEach((m) => (myBy[m.convo_id] = m));
  const convos = await withLeads(Object.values(all).map((c) => ({ ...c, members: memBy[c.id] || [], me: myBy[c.id] || null })), mgr);

  // recent history for every conversation I'm in (45 days, newest 4000)
  let msgs: any[] = [];
  if (myIds.length) {
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    msgs = (await inAll(myIds, (p) => db.from("chat_messages").select(MSG_COLS).in("convo_id", p).is("deleted_at", null)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(4000)))
      .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at))).slice(0, 4000);
    // conversations quiet for 45 days still show their last few messages (one call for all of them)
    const have = new Set(msgs.map((m) => m.convo_id));
    const quiet = myIds.filter((c) => !have.has(c));
    if (quiet.length) {
      const { data: old } = await db.rpc("chat_tail", { p_convos: quiet, p_n: 25 });
      msgs.push(...((old || []) as any[]).map((m) => { const o: any = {}; MSG_COLS.split(",").forEach((k) => (o[k] = m[k])); return o; }));
    }
    // thread parents older than the window
    const known = new Set(msgs.map((m) => m.id));
    const missing = [...new Set(msgs.filter((m) => m.parent_id && !known.has(m.parent_id)).map((m) => m.parent_id))] as string[];
    if (missing.length) msgs.push(...(await inAll(missing, (p) => db.from("chat_messages").select(MSG_COLS).in("id", p))));
  }
  await withReactions(msgs);
  const { data: saved } = await db.from("chat_saved").select("message_id,done").eq("emp_id", me);
  return { me, people: ppl, convos, messages: msgs, saved: saved || [], activity_seen_at: pmap[me]?.activity_seen_at || null, sms: !!(TW_SID && TW_TOKEN && TW_FROM), vapid: await vapidPub().catch(() => "") };
}

async function handle(a: string, b: any, me: number) {
  switch (a) {
    case "boot": return boot(me);

    case "msg": {
      const { data: m } = await db.from("chat_messages").select(MSG_COLS).eq("id", str(b.id)).maybeSingle();
      if (!m) return { msg: null };
      if (!(await member(m.convo_id, me))) return { msg: null };
      await withReactions([m]);
      return { msg: m };
    }
    case "convo": {
      const c = await convo(str(b.id));
      if (!c) return { convo: null };
      const mine = await member(c.id, me);
      if (!mine && (c.kind !== "channel" || c.is_private)) return { convo: null };
      const { data: mems } = await db.from("chat_members").select("emp_id").eq("convo_id", c.id);
      const [out] = await withLeads([{ ...c, members: (mems || []).map((x) => x.emp_id), me: mine }], !!mine && isMgr(await emp(me)));
      return { convo: out };
    }
    case "since": {
      // catch-up after sleep / a dropped realtime connection: anything new, edited or deleted
      const after = new Date(Number(b.after) || Date.now() - 5 * 60000).toISOString();
      const { data: mine } = await db.from("chat_members").select("convo_id").eq("emp_id", me);
      const ids = (mine || []).map((m) => m.convo_id);
      if (!ids.length) return { messages: [], convos: [] };
      const data = (await inAll(ids, (p) => db.from("chat_messages").select(MSG_COLS).in("convo_id", p)
        .or(`created_at.gt.${after},edited_at.gt.${after},deleted_at.gt.${after}`).order("created_at").limit(500)))
        .sort((x, y) => str(x.created_at).localeCompare(str(y.created_at))).slice(0, 500);
      return { messages: await withReactions(data), convos: ids };
    }
    case "people": {
      const { data: people } = await db.from("portal_employees").select("id,name,role,location").eq("active", true).order("name");
      const { data: profs } = await db.from("chat_profiles").select("emp_id,title,color,status_emoji,status_text,away");
      const pmap: Record<number, any> = {};
      (profs || []).forEach((p) => (pmap[p.emp_id] = p));
      return { people: (people || []).map((e) => ({ id: e.id, name: e.name, role: e.role, location: e.location, title: pmap[e.id]?.title || "", color: pmap[e.id]?.color || "", status_e: pmap[e.id]?.status_emoji || "", status_t: pmap[e.id]?.status_text || "", away: !!pmap[e.id]?.away })) };
    }
    case "unread": {
      // small summary for the portal home tile
      const { data: mine } = await db.from("chat_members").select("convo_id,last_read_at,muted").eq("emp_id", me);
      const rows = (mine || []).filter((m) => !m.muted);
      if (!rows.length) return { items: [] };
      const lr: Record<string, number> = {};
      rows.forEach((r) => (lr[r.convo_id] = Date.parse(r.last_read_at)));
      const min = new Date(Math.min(...rows.map((r) => lr[r.convo_id]))).toISOString();
      const ms = await inAll(rows.map((r) => r.convo_id), (p) => db.from("chat_messages").select("convo_id,emp_id,created_at").in("convo_id", p)
        .is("parent_id", null).is("deleted_at", null).gt("created_at", min).limit(3000));
      const cnt: Record<string, number> = {};
      ms.forEach((m) => { if (m.emp_id === me) return; if (Date.parse(m.created_at) > lr[m.convo_id]) cnt[m.convo_id] = (cnt[m.convo_id] || 0) + 1; });
      const ids = Object.keys(cnt);
      if (!ids.length) return { items: [] };
      const cs = await inAll(ids, (p) => db.from("chat_convos").select("id,kind,name,client_name,lead_id").in("id", p));
      const mem = await inAll(ids, (p) => db.from("chat_members").select("convo_id,emp_id").in("convo_id", p));
      const { data: ppl } = await db.from("portal_employees").select("id,name");
      const pn: Record<number, string> = {};
      (ppl || []).forEach((p) => (pn[p.id] = p.name));
      const items = (cs || []).map((c) => {
        let name = c.kind === "channel" ? "#" + c.name : c.kind === "client" ? (c.client_name || c.name) : "";
        if (c.kind === "dm") {
          const o = (mem || []).filter((m) => m.convo_id === c.id && m.emp_id !== me).map((m) => str(pn[m.emp_id]).split(" ")[0]);
          name = o.join(", ") || "You";
        }
        return { id: c.id, kind: c.kind, name, n: cnt[c.id] };
      }).sort((x, y) => (x.kind === "channel" ? 1 : 0) - (y.kind === "channel" ? 1 : 0) || y.n - x.n);
      return { items };
    }
    case "history": {
      await mustMember(str(b.convo), me);
      const { data } = await db.from("chat_messages").select(MSG_COLS).eq("convo_id", str(b.convo)).is("deleted_at", null)
        .lt("created_at", str(b.before)).order("created_at", { ascending: false }).limit(200);
      return { messages: await withReactions(data || []) };
    }

    case "send": {
      const cid = str(b.convo);
      const c = await convo(cid);
      if (!c) fail(404, "Conversation not found.");
      await mustMember(cid, me);
      const html = sanitize(b.html);
      const files = Array.isArray(b.files) ? b.files.slice(0, 10).map((f: any) => ({ path: str(f.path), name: str(f.name).slice(0, 200), size: str(f.size), kind: str(f.kind) })).filter((f: any) => f.path.startsWith(`${cid}/`)) : [];
      if (!html && !files.length && !b.fwd) fail(400, "Message is empty.");
      const row: any = { convo_id: cid, emp_id: me, author_kind: "staff", body_html: html, files };
      if (b.parent) {
        const { data: p } = await db.from("chat_messages").select("id,convo_id,parent_id").eq("id", str(b.parent)).maybeSingle();
        if (!p || p.convo_id !== cid) fail(400, "Thread not found.");
        row.parent_id = p.parent_id || p.id;
      }
      if (b.fwd && b.fwd.id) {
        const { data: src } = await db.from("chat_messages").select("id,convo_id,emp_id,author_kind,body_html,created_at").eq("id", str(b.fwd.id)).maybeSingle();
        if (src && (await member(src.convo_id, me))) {
          const sc = await convo(src.convo_id);
          row.fwd = { emp_id: src.emp_id, kind: src.author_kind, html: src.body_html, ts: src.created_at, from: sc?.kind === "channel" ? "#" + sc.name : (sc?.client_name || "a direct message") };
        }
      }
      let via: string | null = null;
      // a catering lead: the email subject is fixed so the customer's reply finds its way back
      const lead = c.lead_id ? (await db.from("catering_leads").select("id,code,email").eq("id", c.lead_id).maybeSingle()).data : null;
      if (c.kind === "client" && !row.parent_id) {
        if (b.note) row.is_note = true;
        else {
          via = b.via === "email" ? "email" : "sms"; row.via = via; row.status = "sending";
          if (via === "email") row.subject = lead ? leadSubject(lead.code) : (str(b.subject).slice(0, 200) || "GREYS Fine Cheeses");
        }
      }
      const { data: ins, error } = await db.from("chat_messages").insert(row).select(MSG_COLS).single();
      if (error) fail(500, error.message);
      if (b.also && row.parent_id && c.kind !== "client") {
        await db.from("chat_messages").insert({ ...row, parent_id: null, also_channel: true });
      }
      await db.from("chat_members").update({ last_read_at: new Date().toISOString() }).eq("convo_id", cid).eq("emp_id", me);
      if (via) {
        const sender = await emp(me);
        const first = str(sender?.name).split(" ")[0] || "GREYS";
        let res: any;
        if (files.length) await signFiles([ins]);
        if (via === "sms") {
          const fileLinks = files.length ? "\n" + ins.files.map((f: any) => f.url).join("\n") : "";
          res = await sendSms(str(c.client_phone), plain(html) + fileLinks + `\n– ${first}, GREYS`, ins.id);
        } else if (lead) {
          res = await sendLeadEmail(str(lead.email || c.client_email), ins.subject, html, str(sender?.name || "GREYS"), ins.files || []);
        } else {
          res = await sendEmail(str(c.client_email), ins.subject, html, str(sender?.name || "GREYS"), await replyTo(c, me), ins.files || []);
        }
        const upd = res.ok ? { status: via === "sms" ? "sent" : "delivered", ext_id: res.sid || null } : { status: "failed", error: res.err };
        await db.from("chat_messages").update(upd).eq("id", ins.id);
        Object.assign(ins, upd);
      }
      await withReactions([ins]);
      return { msg: ins };
    }
    case "edit": {
      const { data: m } = await db.from("chat_messages").select("id,emp_id,via").eq("id", str(b.id)).maybeSingle();
      if (!m || m.emp_id !== me) fail(403, "You can only edit your own messages.");
      if (m.via) fail(400, "Texts and emails already went out, so they can't be edited.");
      const html = sanitize(b.html);
      if (!html) fail(400, "Message is empty.");
      await db.from("chat_messages").update({ body_html: html, edited_at: new Date().toISOString() }).eq("id", m.id);
      return { ok: true };
    }
    case "delete": {
      const { data: m } = await db.from("chat_messages").select("id,emp_id,convo_id").eq("id", str(b.id)).maybeSingle();
      if (!m) return { ok: true };
      const e = await emp(me);
      if (m.emp_id !== me && !isMgr(e)) fail(403, "You can only delete your own messages.");
      await db.from("chat_messages").update({ deleted_at: new Date().toISOString(), body_html: "", files: [] }).eq("id", m.id);
      return { ok: true };
    }
    case "react": {
      const { data: m } = await db.from("chat_messages").select("id,convo_id").eq("id", str(b.id)).maybeSingle();
      if (!m) fail(404, "Message not found.");
      await mustMember(m.convo_id, me);
      const emoji = str(b.emoji).slice(0, 16);
      if (!emoji) fail(400, "No emoji.");
      const { data: ex } = await db.from("chat_reactions").select("emoji").eq("message_id", m.id).eq("emp_id", me).eq("emoji", emoji).maybeSingle();
      if (ex && b.on !== true) await db.from("chat_reactions").delete().eq("message_id", m.id).eq("emp_id", me).eq("emoji", emoji);
      else if (!ex) await db.from("chat_reactions").insert({ message_id: m.id, emp_id: me, emoji });
      return { ok: true };
    }
    case "pin": {
      const { data: m } = await db.from("chat_messages").select("id,convo_id,pinned_by").eq("id", str(b.id)).maybeSingle();
      if (!m) fail(404, "Message not found.");
      await mustMember(m.convo_id, me);
      await db.from("chat_messages").update({ pinned_by: m.pinned_by ? null : me }).eq("id", m.id);
      return { ok: true };
    }
    case "save": {
      const id = str(b.id);
      if (b.remove) await db.from("chat_saved").delete().eq("emp_id", me).eq("message_id", id);
      else await db.from("chat_saved").upsert({ emp_id: me, message_id: id, done: !!b.done });
      return { ok: true };
    }
    case "read": {
      await db.from("chat_members").update({ last_read_at: b.at ? new Date(b.at).toISOString() : new Date().toISOString() }).eq("convo_id", str(b.convo)).eq("emp_id", me);
      // reading a lead here clears its "unread" dot in the manager console too
      const { data: c } = await db.from("chat_convos").select("lead_id").eq("id", str(b.convo)).maybeSingle();
      if (c?.lead_id && (await member(str(b.convo), me))) await db.from("catering_leads").update({ unread: false }).eq("id", c.lead_id).eq("unread", true);
      return { ok: true };
    }
    case "lead_stage": {
      const c = await convo(str(b.convo));
      if (!c?.lead_id) fail(404, "That isn't a catering lead.");
      await mustMember(c.id, me);
      const e = await emp(me);
      if (!isMgr(e)) fail(403, "Only managers can move catering leads.");
      const st = str(b.stage);
      if (!STAGES.includes(st)) fail(400, "Pick a stage.");
      const { error } = await db.rpc("chat_lead_set_stage", { p_lead: c.lead_id, p_stage: st, p_by: str(e?.name) });
      if (error) fail(500, error.message);
      return { ok: true };
    }
    case "prefs": {
      const upd: any = {};
      if (typeof b.muted === "boolean") upd.muted = b.muted;
      if (typeof b.starred === "boolean") upd.starred = b.starred;
      await db.from("chat_members").update(upd).eq("convo_id", str(b.convo)).eq("emp_id", me);
      return { ok: true };
    }
    case "update_convo": {
      const c = await convo(str(b.convo));
      if (!c) fail(404, "Conversation not found.");
      await mustMember(c.id, me);
      const upd: any = {};
      if (b.topic != null) upd.topic = str(b.topic).slice(0, 250);
      if (b.description != null) upd.description = str(b.description).slice(0, 1000);
      if (b.name != null && c.kind === "channel") upd.name = str(b.name).toLowerCase().replace(/[^a-z0-9-_]+/g, "-").slice(0, 80) || c.name;
      if (Array.isArray(b.bookmarks)) upd.bookmarks = b.bookmarks.slice(0, 20).map((x: any) => ({ t: str(x.t).slice(0, 80), u: /^https?:\/\//.test(str(x.u)) ? str(x.u) : "", e: str(x.e).slice(0, 8) })).filter((x: any) => x.u);
      if (c.kind === "client" && c.lead_id) {
        // a catering lead's contact lives on the lead (the manager console shows the same); a trigger copies it here
        const lu: any = {};
        if (b.client_name != null && str(b.client_name).trim()) lu.name = str(b.client_name).trim().slice(0, 120);
        if (b.client_email != null && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(b.client_email).trim())) lu.email = str(b.client_email).trim().toLowerCase().slice(0, 200);
        if (b.client_phone != null) lu.phone = str(b.client_phone).trim().slice(0, 40) || null;
        if (Object.keys(lu).length) {
          if (!isMgr(await emp(me))) fail(403, "Only managers can edit catering leads.");
          const { error: le } = await db.from("catering_leads").update(lu).eq("id", c.lead_id);
          if (le) fail(400, le.message);
        }
        if (b.client_via === "sms" || b.client_via === "email") upd.client_via = b.client_via;
      } else if (c.kind === "client") {
        for (const k of ["client_name", "client_phone", "client_email", "client_tag", "client_meta"]) if (b[k] != null) upd[k] = k === "client_phone" ? e164(b[k]) : str(b[k]).slice(0, 200);
        if (b.client_via === "sms" || b.client_via === "email") upd.client_via = b.client_via;
      }
      if (!Object.keys(upd).length) return { ok: true };
      const { error } = await db.from("chat_convos").update(upd).eq("id", c.id);
      if (error) fail(400, /unique/.test(error.message) ? "A channel with that name already exists." : error.message);
      return { ok: true };
    }
    case "create_channel": {
      const name = str(b.name).toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
      if (!name) fail(400, "Give the channel a name.");
      const { data: c, error } = await db.from("chat_convos").insert({ kind: "channel", name, is_private: !!b.private, topic: str(b.topic).slice(0, 250), created_by: me }).select().single();
      if (error) fail(400, /unique/.test(error.message) ? "A channel with that name already exists." : error.message);
      const ids = [me, ...((b.members || []) as any[]).map(Number).filter(Boolean)];
      await db.from("chat_members").upsert([...new Set(ids)].map((e) => ({ convo_id: c.id, emp_id: e })));
      return { id: c.id };
    }
    case "join": {
      const c = await convo(str(b.convo));
      if (!c || c.kind !== "channel" || c.is_private) fail(403, "That channel is private.");
      await db.from("chat_members").upsert({ convo_id: c.id, emp_id: me });
      return { ok: true };
    }
    case "leave": {
      const c = await convo(str(b.convo));
      if (c?.lead_id && isMgr(await emp(me))) fail(400, "Managers stay on every catering lead. Mute it instead.");
      await db.from("chat_members").delete().eq("convo_id", str(b.convo)).eq("emp_id", me);
      return { ok: true };
    }
    case "remove_member": {
      // managers, or whoever made the conversation; never from a DM or #general
      const c = await convo(str(b.convo));
      if (!c || c.kind === "dm") fail(400, "People can't be removed from a direct message.");
      if (c.kind === "channel" && c.name === "general") fail(400, "Everyone stays in #general.");
      const who = Number(b.emp);
      if (!who || who === me) fail(400, "To take yourself out, leave instead.");
      await mustMember(c.id, me);
      if (!isMgr(await emp(me)) && Number(c.created_by) !== me) fail(403, "Only managers or whoever made this channel can remove people.");
      if (c.lead_id && isMgr(await emp(who))) fail(400, "Managers stay on every catering lead.");
      await db.from("chat_members").delete().eq("convo_id", c.id).eq("emp_id", who);
      return { ok: true };
    }
    case "add_members": {
      const c = await convo(str(b.convo));
      if (!c || c.kind === "dm") fail(400, "Start a new group message instead.");
      await mustMember(c.id, me);
      const ids = ((b.ids || []) as any[]).map(Number).filter(Boolean);
      if (c.lead_id && ids.length) {
        // catering leads stay with managers (the lead's details are manager-only)
        const { data: ppl } = await db.from("portal_employees").select("id,role,active").in("id", ids);
        if ((ppl || []).length !== ids.length || (ppl || []).some((p) => !p.active || !isMgr(p))) fail(400, "Only managers can be on catering leads.");
      }
      if (ids.length) await db.from("chat_members").upsert(ids.map((e) => ({ convo_id: c.id, emp_id: e })));
      return { ok: true };
    }
    case "dm": {
      const ids = [...new Set([me, ...((b.ids || []) as any[]).map(Number).filter(Boolean)])].sort((x, y) => x - y);
      if (ids.length > 9) fail(400, "Group messages can have up to 9 people.");
      const dm_key = ids.join("-");
      const { data: ex } = await db.from("chat_convos").select("id").eq("dm_key", dm_key).maybeSingle();
      if (ex) { await db.from("chat_members").upsert(ids.map((e) => ({ convo_id: ex.id, emp_id: e })), { ignoreDuplicates: true }); return { id: ex.id }; }
      const { data: c, error } = await db.from("chat_convos").insert({ kind: "dm", dm_key, created_by: me }).select().single();
      if (error) fail(500, error.message);
      await db.from("chat_members").insert(ids.map((e) => ({ convo_id: c.id, emp_id: e })));
      return { id: c.id };
    }
    case "create_client": {
      const name = str(b.name).trim().slice(0, 120);
      if (!name) fail(400, "Add the client's name.");
      const phone = e164(b.phone), email = str(b.email).trim().slice(0, 200);
      if (!phone && !email) fail(400, "Add a mobile number or an email.");
      if (phone) {
        const { data: ex } = await db.from("chat_convos").select("id").eq("kind", "client").eq("client_phone", phone).eq("archived", false)
          .is("lead_id", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (ex) { await db.from("chat_members").upsert({ convo_id: ex.id, emp_id: me }); return { id: ex.id, existed: true }; }
      }
      const { data: c, error } = await db.from("chat_convos").insert({
        kind: "client", name, client_name: name, client_phone: phone || null, client_email: email || null,
        client_via: phone ? "sms" : "email", client_tag: str(b.tag).slice(0, 120), client_meta: str(b.meta).slice(0, 200), created_by: me,
      }).select().single();
      if (error) fail(500, error.message);
      const { data: mgrs } = await db.from("portal_employees").select("id,role").eq("active", true);
      const ids = new Set([me, ...(mgrs || []).filter(isMgr).map((x) => x.id)]);
      await db.from("chat_members").insert([...ids].map((e) => ({ convo_id: c.id, emp_id: e })));
      return { id: c.id };
    }
    case "profile": {
      const upd: any = { seen_at: new Date().toISOString() };
      if (b.status_e != null) upd.status_emoji = str(b.status_e).slice(0, 16);
      if (b.status_t != null) upd.status_text = str(b.status_t).slice(0, 100);
      if (typeof b.away === "boolean") upd.away = b.away;
      if (b.title != null) upd.title = str(b.title).slice(0, 80);
      if (b.activity_seen) upd.activity_seen_at = new Date().toISOString();
      // the app says when a chat window is in front of someone; chat-notify skips them while it is
      if (typeof b.active === "boolean") upd.focus_at = b.active ? new Date().toISOString() : null;
      await db.from("chat_profiles").upsert({ emp_id: me, ...upd });
      return { ok: true };
    }
    case "upload": {
      const cid = str(b.convo);
      await mustMember(cid, me);
      const name = str(b.name).replace(/[^\w.\- ()]+/g, "_").slice(-120) || "file";
      const bin = Uint8Array.from(atob(str(b.data)), (ch) => ch.charCodeAt(0));
      if (bin.length > 25 * 1024 * 1024) fail(400, "Files can be up to 25 MB.");
      const path = `${cid}/${crypto.randomUUID()}/${name}`;
      const { error } = await db.storage.from("chat-files").upload(path, bin, { contentType: str(b.type) || "application/octet-stream" });
      if (error) fail(500, error.message);
      const { data: s } = await db.storage.from("chat-files").createSignedUrl(path, 60 * 60 * 24 * 7);
      return { path, url: s?.signedUrl || "" };
    }
    case "push_sub": { // this device turned notifications on (or the app re-confirming it on load)
      const s = b.sub || {};
      const endpoint = str(s.endpoint), p256dh = b64norm(s.keys?.p256dh), auth = b64norm(s.keys?.auth);
      let host = "";
      try { const u = new URL(endpoint); if (u.protocol === "https:") host = u.hostname; } catch { /* not a URL */ }
      if (!host || !PUSH_HOSTS.test(host) || endpoint.length > 1000) fail(400, "This browser's notification service isn't supported.");
      if (!/^[A-Za-z0-9_-]{86,88}$/.test(p256dh) || !/^[A-Za-z0-9_-]{21,24}$/.test(auth)) fail(400, "This browser sent bad notification keys.");
      // one row per device; a shared device follows whoever signed in last
      const { error } = await db.from("chat_push_subs").upsert(
        { emp_id: me, endpoint, p256dh, auth, ua: str(b.ua).slice(0, 200), fails: 0, last_err: null, updated_at: new Date().toISOString() },
        { onConflict: "endpoint" },
      );
      if (error) fail(500, "Couldn't save this device. Try again.");
      return { ok: true };
    }
    case "push_unsub": {
      await db.from("chat_push_subs").delete().eq("endpoint", str(b.endpoint)).eq("emp_id", me);
      return { ok: true };
    }
    case "push_test": {
      const { data: sec } = await db.from("app_secrets").select("value").eq("name", "chat_notify_secret").maybeSingle();
      const r = await fetch(`${SB_URL}/functions/v1/chat-notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-chat-secret": sec?.value || "" },
        body: JSON.stringify({ test: me, endpoint: str(b.endpoint) || undefined }),
      }).catch(() => null);
      const d: any = r ? await r.json().catch(() => ({})) : {};
      return { sent: Number(d.sent || 0) };
    }
  }
  fail(400, "Unknown action.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  try {
    if (b.a === "login") {
      const id = str(b.login_id).trim();
      if (!id) fail(400, "Enter your employee ID.");
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
      const { data: okRate } = await db.rpc("ticket_rate_hit", { p_bucket: "chatlogin:" + ip, p_limit: 12, p_window_secs: 600 });
      if (okRate === false) fail(429, "Too many tries. Wait 10 minutes and try again.");
      const { data } = await db.from("portal_employees").select("id,name").ilike("login_id", likeLit(id)).eq("active", true);
      if (!data || data.length !== 1) fail(401, "No employee found with that ID. Ask your manager to add you.");
      return json({ token: await mint(data![0].id), me: data![0].id });
    }
    const me = await verify(req.headers.get("x-chat-token") || "");
    if (!me || !(await emp(me))) return json({ error: "Please sign in again.", signin: true }, 401);
    return json(await handle(str(b.a), b, me));
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
