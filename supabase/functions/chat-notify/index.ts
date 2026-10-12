// chat-notify — phone / desktop notifications for Greys Chat (Web Push; verify_jwt = false).
// Called by the chat_messages insert trigger (pg_net) with { id } and the x-chat-secret header
// (app_secrets 'chat_notify_secret'). chat-api calls it with { test: emp_id, endpoint } for
// "Send a test" in Preferences.
//
// Who gets one: everyone in a DM / group DM, people @mentioned (or @channel / @everyone), people
// who started or replied in a thread, and the team on a client conversation when the client writes.
// Skipped when: they wrote it, they're in chat right now (a chat window in front of them within the
// last 2½ minutes — chat_profiles.focus_at, kept fresh by the app), the conversation is muted
// (unless they were @mentioned), or they haven't turned notifications on for any device
// (chat_push_subs — one row per phone / browser).
//
// Delivery is standard Web Push: RFC 8291 (aes128gcm) payload encryption + RFC 8292 VAPID, all in
// WebCrypto. The VAPID key pair is app_secrets 'chat_vapid' {pub, jwk}, made on first use (here or in
// chat-api). Dead subscriptions (404/410 from the push service) are deleted.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ACTIVE_MS = 150 * 1000;
const CONTACT = "mailto:info@greyscheese.com";

const ok = (o: unknown = { ok: true }) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
const plain = (h: string) => String(h || "").replace(/<br\s*\/?>/g, " ").replace(/<\/(li|blockquote|pre)>/g, " ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

/* ---- push crypto ---- */
const te = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (t.length % 4) t += "=";
  const bin = atob(t), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
// RFC 8291: one aes128gcm record, encrypted to the browser's p256dh key + auth secret
async function encryptPush(p256dh: string, auth: string, payload: Uint8Array) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
// RFC 8292: VAPID header, one ES256 JWT per push-service origin (cached ~12h)
const jwtCache = new Map<string, { h: string; exp: number }>();
async function vapidHeader(endpoint: string, v: { pub: string; jwk: JsonWebKey }, contact: string) {
  const aud = new URL(endpoint).origin;
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - 600 > Date.now() / 1000) return hit.h;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const part = (o: unknown) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = part({ typ: "JWT", alg: "ES256" }) + "." + part({ aud, exp, sub: contact });
  const j: any = v.jwk;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned));
  const h = `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`;
  jwtCache.set(aud, { h, exp });
  return h;
}
/* ---- end push crypto ---- */

// VAPID key pair: one app_secrets row so two first calls can't end up with mismatched halves
// (chat-api makes it the same way on first boot; whichever runs first wins)
async function vapidKeys(): Promise<{ pub: string; jwk: JsonWebKey } | null> {
  const read = async () => (await db.from("app_secrets").select("value").eq("name", "chat_vapid").maybeSingle()).data?.value as string | undefined;
  let raw = await read();
  if (!raw) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    await db.from("app_secrets").upsert({ name: "chat_vapid", value: JSON.stringify({ pub, jwk }) }, { onConflict: "name", ignoreDuplicates: true });
    raw = await read();
  }
  try { return JSON.parse(raw || ""); } catch { return null; }
}

type Sub = { id: number; emp_id: number; endpoint: string; p256dh: string; auth: string; fails: number };

async function pushOne(s: Sub, payload: unknown, v: { pub: string; jwk: JsonWebKey }) {
  try {
    const body = await encryptPush(s.p256dh, s.auth, te.encode(JSON.stringify(payload)));
    const r = await fetch(s.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(s.endpoint, v, CONTACT),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) return { ok: true, gone: false, err: "" };
    const t = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
    return { ok: false, gone: r.status === 404 || r.status === 410, err: `${r.status} ${t}`.trim() };
  } catch (e) {
    return { ok: false, gone: false, err: String(e).slice(0, 180) };
  }
}

async function deliver(subs: Sub[], payloadFor: (emp: number) => unknown, v: { pub: string; jwk: JsonWebKey }) {
  let sent = 0;
  const errs: string[] = [];
  await Promise.all(subs.map(async (s) => {
    const r = await pushOne(s, payloadFor(s.emp_id), v);
    if (r.ok) {
      sent++;
      await db.from("chat_push_subs").update({ last_ok_at: new Date().toISOString(), fails: 0, last_err: null }).eq("id", s.id);
    } else {
      errs.push(r.err);
      if (r.gone || (s.fails || 0) >= 20) await db.from("chat_push_subs").delete().eq("id", s.id);
      else await db.from("chat_push_subs").update({ fails: (s.fails || 0) + 1, last_err: r.err }).eq("id", s.id);
    }
  }));
  return { sent, errs };
}

const SUB_COLS = "id,emp_id,endpoint,p256dh,auth,fails";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const { data: sec } = await db.from("app_secrets").select("value").eq("name", "chat_notify_secret").maybeSingle();
  if (!sec?.value || req.headers.get("x-chat-secret") !== sec.value) return new Response("forbidden", { status: 403 });
  const v = await vapidKeys();
  if (!v?.pub || !v?.jwk) return ok({ skipped: "no VAPID key" });

  let b: any = {};
  try { b = await req.json(); } catch { /* empty */ }

  // "Send a test" from Preferences: just this person's device(s)
  if (b.test) {
    let q = db.from("chat_push_subs").select(SUB_COLS).eq("emp_id", Number(b.test));
    if (b.endpoint) q = q.eq("endpoint", String(b.endpoint));
    const { data: subs } = await q;
    const r = await deliver((subs || []) as Sub[], () => ({ t: "Greys Chat", b: "Notifications are on for this device ✓", tag: "greys-test", m: "test-" + Date.now() }), v);
    return ok(r);
  }

  const id = String(b.id || "");
  const { data: m } = await db.from("chat_messages")
    .select("id,convo_id,parent_id,emp_id,author_kind,body_html,is_note,files,fwd,deleted_at").eq("id", id).maybeSingle();
  if (!m || m.deleted_at || m.author_kind === "bot" || m.author_kind === "system") return ok({ skipped: "nothing to send" });

  const { data: c } = await db.from("chat_convos").select("id,kind,name,client_name").eq("id", m.convo_id).maybeSingle();
  if (!c) return ok({ skipped: "no conversation" });
  const { data: mems } = await db.from("chat_members").select("emp_id,muted").eq("convo_id", c.id);
  const memberIds = new Set<number>((mems || []).map((x) => Number(x.emp_id)));
  const muted = new Set<number>((mems || []).filter((x) => x.muted).map((x) => Number(x.emp_id)));

  const html = m.body_html || "";
  const text0 = plain(html);
  const mentioned = new Set([...html.matchAll(/data-uid="(\d+)"/g)].map((x) => Number(x[1])).filter((e) => memberIds.has(e)));
  const want = new Set<number>(mentioned);
  if (!m.is_note) {
    if (c.kind === "dm") memberIds.forEach((e) => want.add(e));
    if (c.kind === "client" && m.author_kind === "client") memberIds.forEach((e) => want.add(e));
    if (html.includes('data-bc="1"') && /@(channel|everyone)\b/i.test(text0)) memberIds.forEach((e) => want.add(e));
    if (m.parent_id) {
      const { data: parent } = await db.from("chat_messages").select("emp_id").eq("id", m.parent_id).maybeSingle();
      const { data: sibs } = await db.from("chat_messages").select("emp_id").eq("parent_id", m.parent_id).is("deleted_at", null);
      [parent, ...(sibs || [])].forEach((x: any) => { if (x?.emp_id && memberIds.has(Number(x.emp_id))) want.add(Number(x.emp_id)); });
    }
  }
  if (m.emp_id) want.delete(Number(m.emp_id));
  for (const e of [...want]) if (muted.has(e) && !mentioned.has(e)) want.delete(e);
  if (!want.size) return ok({ sent: 0, reason: "nobody to notify" });

  const ids = [...want];
  const people = [...new Set([...memberIds, ...ids, ...(m.emp_id ? [Number(m.emp_id)] : [])])];
  const [{ data: profs }, { data: emps }, { data: subs }] = await Promise.all([
    db.from("chat_profiles").select("emp_id,focus_at").in("emp_id", ids),
    db.from("portal_employees").select("id,name,active").in("id", people),
    db.from("chat_push_subs").select(SUB_COLS).in("emp_id", ids),
  ]);
  const focus: Record<number, number> = {};
  (profs || []).forEach((p) => { if (p.focus_at) focus[Number(p.emp_id)] = Date.parse(p.focus_at); });
  const name: Record<number, string> = {}, active: Record<number, boolean> = {};
  (emps || []).forEach((x) => { name[Number(x.id)] = x.name || ""; active[Number(x.id)] = !!x.active; });
  const now = Date.now();
  const targets = ((subs || []) as Sub[]).filter((s) => {
    const e = Number(s.emp_id);
    return want.has(e) && active[e] && !(focus[e] && now - focus[e] < ACTIVE_MS);
  });
  if (!targets.length) return ok({ sent: 0, reason: "no away devices" });

  // Same wording the app uses for its own in-tab notifications (so one silently replaces the other)
  const first = (n: string) => String(n || "").split(" ")[0];
  const fromClient = m.author_kind === "client";
  const sender = fromClient ? (c.client_name || c.name || "Client") : (name[Number(m.emp_id)] || "Someone");
  let text = text0 || (m.files?.length ? "Sent a file" : m.fwd ? "Forwarded a message" : "New message");
  if (text.length > 180) text = text.slice(0, 177) + "…";
  const solo = c.kind === "dm" && memberIds.size <= 2;
  const payloadFor = (e: number) => {
    let t = c.kind === "channel" ? "#" + c.name
      : c.kind === "client" ? (c.name || c.client_name || "Client")
      : solo ? sender
      : [...memberIds].filter((x) => x !== e).map((x) => first(name[x])).filter(Boolean).join(", ") || "Group message";
    if (m.parent_id) t = "Thread in " + t;
    return { t, b: solo || fromClient ? text : `${first(sender)}: ${text}`, c: c.id, m: m.id, tag: "c" + c.id };
  };
  const r = await deliver(targets, payloadFor, v);
  return ok({ ...r, devices: targets.length });
});
