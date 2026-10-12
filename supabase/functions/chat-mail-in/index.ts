// chat-mail-in — client EMAIL replies into Greys Chat (verify_jwt = false).
//
// Chat emails go out with Reply-To info+c<code>@greyscheese.com (chat_convos.reply_token, set by
// chat-api). Mail to info@ lands in brad@greyscheese.com's Gmail; the "Greys Chat mail" Apps Script
// there runs every minute and POSTs each reply addressed to an info+c… address here.
//
// Auth: header x-google-id-token = the script's Google identity token (ScriptApp.getIdentityToken).
// It must be Google-signed, unexpired, for an account listed in app_secrets 'chat_mail_accounts'
// (comma list). Its audience (the script's OAuth client) is pinned on first use in 'chat_mail_aud'.
// The reply code is the second key: only a code stored on a client conversation is accepted.
//
// Body: { id, from, to, cc, deliveredTo, subject, date, text, html, attachments: [{name, type, data(base64)}] }
//       or { ping: true } (setup check).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const str = (v: unknown) => (v == null ? "" : String(v));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const REPLY_RE = /\+c([a-z0-9]{10})@/i;

/* ---- Google identity token ---- */
const b64uBytes = (s: string) => {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
};
let jwks: { keys: any[]; at: number } | null = null;
async function googleKeys(fresh = false): Promise<any[]> {
  if (!jwks || fresh || Date.now() - jwks.at > 3600e3) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    jwks = { keys: ((await r.json()) as any).keys || [], at: Date.now() };
  }
  return jwks.keys;
}
export async function verifyGoogle(tok: string, keys: (fresh?: boolean) => Promise<any[]> = googleKeys) {
  const p = tok.split(".");
  if (p.length !== 3) return null;
  let head: any, claims: any;
  try {
    head = JSON.parse(new TextDecoder().decode(b64uBytes(p[0])));
    claims = JSON.parse(new TextDecoder().decode(b64uBytes(p[1])));
  } catch { return null; }
  if (head.alg !== "RS256" || !head.kid) return null;
  let jwk = (await keys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uBytes(p[2]), new TextEncoder().encode(p[0] + "." + p[1]));
  if (!ok) return null;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60e3) return null;
  if (!claims.email || claims.email_verified === false) return null;
  return claims;
}

/* ---- the reply itself, without the quoted conversation below it ---- */
export function stripQuoted(text: string) {
  const full = "\n" + str(text).replace(/\r\n?/g, "\n");
  const cuts = [
    /\n[ \t>]*On [^\n]{1,300}(\n[^\n]{0,200})?wrote:[ \t]*\n/i, // Gmail / Apple Mail: "On <date>, <name> wrote:" (may wrap)
    /\n[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/i, // Outlook classic
    /\n[ \t]*_{8,}[ \t]*\n/, // Outlook separator line
    /\n[ \t]*\*?From:\*?[^\n]+\n[ \t]*\*?(Sent|Date):\*?[^\n]+\n/i, // Outlook / Yahoo header block
    /\n[ \t]*-{2,}[ \t]*Forwarded message[ \t]*-{2,}/i,
  ];
  let cut = full.length;
  for (const re of cuts) {
    const m = re.exec(full);
    if (m && m.index < cut) cut = m.index;
  }
  let t = full.slice(0, cut)
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n") // stray quoted lines
    .replace(/\n[ \t]*Sent from my [^\n]{1,60}\s*$/i, "") // mobile signature
    .replace(/\n[ \t]*Get Outlook for [^\n]{1,40}\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) t = full.trim();
  return t.slice(0, 8000);
}
const htmlToText = (h: string) => str(h)
  .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const addrOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] || s).trim().toLowerCase();
const nameOf = (s: string) => str(/^\s*"?([^"<]*?)"?\s*</.exec(s)?.[1]).trim();
const size = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const claims = await verifyGoogle(req.headers.get("x-google-id-token") || "");
  if (!claims) return json({ error: "not signed by Google" }, 401);
  const { data: acc } = await db.from("app_secrets").select("value").eq("name", "chat_mail_accounts").maybeSingle();
  const allowed = str(acc?.value).toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!allowed.includes(str(claims.email).toLowerCase())) return json({ error: "account not allowed" }, 403);
  const { data: aud } = await db.from("app_secrets").select("value").eq("name", "chat_mail_aud").maybeSingle();
  if (aud?.value) {
    if (aud.value !== claims.aud) return json({ error: "wrong script" }, 403);
  } else {
    await db.from("app_secrets").insert({ name: "chat_mail_aud", value: str(claims.aud) });
  }

  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (b.ping) return json({ ok: true, account: claims.email });

  const id = str(b.id).replace(/[^\w-]/g, "").slice(0, 64);
  if (!id) return json({ error: "no message id" }, 400);
  const ext = "gmail:" + id;
  const { data: dup } = await db.from("chat_messages").select("id").eq("ext_id", ext).maybeSingle();
  if (dup) return json({ ok: true, dup: true });

  const code = REPLY_RE.exec([b.deliveredTo, b.to, b.cc].map(str).join(" "))?.[1]?.toLowerCase();
  if (!code) return json({ ok: true, skipped: "not a chat reply address" });
  const { data: c } = await db.from("chat_convos").select("id,kind,client_email,client_name").eq("reply_token", code).maybeSingle();
  if (!c || c.kind !== "client") return json({ ok: true, skipped: "unknown reply code" });

  const text = stripQuoted(str(b.text).trim() ? str(b.text) : htmlToText(str(b.html)));
  let html = esc(text).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const from = str(b.from), fromAddr = addrOf(from);
  if (fromAddr && fromAddr !== str(c.client_email).toLowerCase()) {
    html = `<b>${esc(nameOf(from) || fromAddr)}</b> (${esc(fromAddr)}):<br>` + html;
  }

  const files: any[] = [];
  for (const a of (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 5)) {
    let bin: Uint8Array;
    try { bin = Uint8Array.from(atob(str(a.data)), (ch) => ch.charCodeAt(0)); } catch { continue; }
    if (!bin.length || bin.length > 10 * 1024 * 1024) continue;
    const name = str(a.name).replace(/[^\w.\- ()]+/g, "_").slice(-120) || "attachment";
    const type = str(a.type) || "application/octet-stream";
    const path = `${c.id}/${crypto.randomUUID()}/${name}`;
    const { error } = await db.storage.from("chat-files").upload(path, bin, { contentType: type });
    if (!error) files.push({ path, name, size: size(bin.length), kind: type.startsWith("image/") ? "img" : "file" });
  }
  if (!text && !files.length) return json({ ok: true, skipped: "empty" });

  const { error } = await db.from("chat_messages").insert({
    convo_id: c.id, author_kind: "client", via: "email", subject: str(b.subject).slice(0, 200) || null,
    body_html: html, ext_id: ext, files,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, convo: c.id });
});
