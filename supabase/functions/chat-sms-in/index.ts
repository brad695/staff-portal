// chat-sms-in — Twilio webhooks for Greys Chat (verify_jwt = false; Twilio signature checked).
//   POST ?status=<message id>   delivery status callback for a text we sent
//   POST (no query)              an incoming text: a number with an open client conversation → that
//                                conversation (even if it's a staff phone); other staff phones → a group
//                                DM with the managers; anyone else → a new client conversation
// Point the Twilio number's "A message comes in" webhook here (HTTP POST).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const PUBLIC_URL = `${SB_URL}/functions/v1/chat-sms-in`;
const twiml = (s = 200) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: s, headers: { "Content-Type": "text/xml" } });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const e164 = (p: unknown) => {
  const raw = String(p ?? "").trim(), d = raw.replace(/\D/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return /^\d{8,15}$/.test(d) ? "+" + d : "";
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
};

async function validSig(url: string, params: URLSearchParams, sig: string) {
  if (!TW_TOKEN || !sig) return false;
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TW_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const u = new URL(req.url);
  const params = new URLSearchParams(await req.text());
  const status = u.searchParams.get("status");
  const signedUrl = PUBLIC_URL + (status ? `?status=${status}` : "");
  if (!(await validSig(signedUrl, params, req.headers.get("x-twilio-signature") || ""))) return new Response("forbidden", { status: 403 });

  if (status) {
    const st = params.get("MessageStatus") || params.get("SmsStatus") || "";
    const map: Record<string, string> = { delivered: "delivered", sent: "sent", undelivered: "failed", failed: "failed" };
    if (map[st]) await db.from("chat_messages").update({ status: map[st], error: map[st] === "failed" ? (params.get("ErrorCode") ? `Carrier error ${params.get("ErrorCode")}` : "Not delivered") : null }).eq("id", status);
    return twiml();
  }

  const from = params.get("From") || "";
  const body = params.get("Body") || "";
  const sid = params.get("MessageSid") || "";
  if (!from) return twiml();
  const { data: dup } = await db.from("chat_messages").select("id").eq("ext_id", sid).maybeSingle();
  if (dup) return twiml();

  // A number with an open client conversation is a client, even when it's also a staff member's phone
  // (someone set themselves up as a client, e.g. to test) — the reply belongs in that conversation.
  let { data: c } = await db.from("chat_convos").select("id").eq("kind", "client").eq("client_phone", from).eq("archived", false).order("created_at").limit(1).maybeSingle();

  // Otherwise a text from a staff member's phone (e.g. a reply to a shift reminder) goes to a group DM with the managers
  const { data: contacts } = c ? { data: [] as any[] } : await db.from("portal_employee_contacts").select("employee_id,phone");
  const staff = (contacts || []).find((x) => e164(x.phone) === from);
  if (staff) {
    const { data: emps } = await db.from("portal_employees").select("id,role,active");
    const me = (emps || []).find((e) => e.id === staff.employee_id && e.active);
    if (me) {
      const html = "📱 " + esc(body).replace(/\n/g, "<br>");
      // a reply to a chat notification text goes back into that conversation (thread kept);
      // in a client conversation it lands as an internal note — never sent on to the client
      const { data: last } = await db.from("chat_notify_log").select("convo_id,parent_id").eq("emp_id", me.id).eq("ok", true)
        .gte("sent_at", new Date(Date.now() - 12 * 3600e3).toISOString()).order("sent_at", { ascending: false }).limit(1).maybeSingle();
      if (last) {
        const { data: mem } = await db.from("chat_members").select("emp_id").eq("convo_id", last.convo_id).eq("emp_id", me.id).maybeSingle();
        const { data: conv } = await db.from("chat_convos").select("kind").eq("id", last.convo_id).maybeSingle();
        if (mem && conv) {
          await db.from("chat_messages").insert({ convo_id: last.convo_id, parent_id: last.parent_id, emp_id: me.id, author_kind: "staff", body_html: html, is_note: conv.kind === "client" && !last.parent_id, ext_id: sid });
          await db.from("chat_members").update({ last_read_at: new Date().toISOString() }).eq("convo_id", last.convo_id).eq("emp_id", me.id);
          return twiml();
        }
      }
      const ids = [...new Set([me.id, ...(emps || []).filter((e) => e.active && /manager|owner|admin/i.test(e.role || "")).map((e) => e.id)])].sort((a, b) => a - b);
      const dm_key = ids.join("-");
      let { data: dm } = await db.from("chat_convos").select("id").eq("dm_key", dm_key).maybeSingle();
      if (!dm) {
        const { data: nd } = await db.from("chat_convos").insert({ kind: "dm", dm_key, created_by: me.id }).select("id").single();
        dm = nd;
        await db.from("chat_members").insert(ids.map((e) => ({ convo_id: dm!.id, emp_id: e })));
      }
      await db.from("chat_messages").insert({ convo_id: dm!.id, emp_id: me.id, author_kind: "staff", body_html: html, ext_id: sid });
      return twiml();
    }
  }

  if (!c) {
    const pretty = from.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");
    const { data: nc } = await db.from("chat_convos").insert({ kind: "client", name: pretty, client_name: pretty, client_phone: from, client_via: "sms", client_tag: "New texter", client_meta: "Texted the GREYS number" }).select("id").single();
    c = nc;
    const { data: emps } = await db.from("portal_employees").select("id,role").eq("active", true);
    const ids = (emps || []).filter((e) => /manager|owner|admin/i.test(e.role || "")).map((e) => e.id);
    if (ids.length) await db.from("chat_members").insert(ids.map((e) => ({ convo_id: c!.id, emp_id: e })));
  }
  const files: any[] = [];
  const n = Number(params.get("NumMedia") || 0);
  for (let i = 0; i < Math.min(n, 5); i++) {
    const url = params.get(`MediaUrl${i}`) || "", type = params.get(`MediaContentType${i}`) || "";
    if (url) files.push({ ext: url, name: `photo-${i + 1}.${(type.split("/")[1] || "jpg").replace("jpeg", "jpg")}`, kind: type.startsWith("image/") ? "img" : "file", size: "" });
  }
  const html = esc(body).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  await db.from("chat_messages").insert({ convo_id: c!.id, author_kind: "client", body_html: html, via: "sms", ext_id: sid, files });
  return twiml();
});
