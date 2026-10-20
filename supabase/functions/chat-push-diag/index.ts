// chat-push-diag — TEMPORARY (2026-10-19) diagnostics for Greys Chat phone notifications. verify_jwt = false.
// Maverick's Android stayed quiet while Google accepted every push for it, so the device reports in itself:
//   kind 'page' — chat.html's view of this device (permission, service worker, subscription, last error);
//   kind 'sw'   — chat-sw.js, for every push it receives: did showNotification work.
// Only rows for Maverick's two test accounts (emp 13 Brad, 34 Bubba) are kept. Rows go to chat_push_diag
// (RLS on, no anon/authenticated grants). Delete this function and that table once the phone is sorted.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const KEEP = new Set([13, 34]);
const b64norm = (s: unknown) => String(s ?? "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function khash(p: string, a: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64norm(p) + "." + b64norm(a)));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return out({ error: "bad request" }, 400); }
  const kind = String(b?.kind || "");
  if (kind !== "page" && kind !== "sw") return out({ error: "bad kind" }, 400);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  const { data: okRate } = await db.rpc("ticket_rate_hit", { p_bucket: "chatdiag:" + ip, p_limit: 120, p_window_secs: 600 });
  if (okRate === false) return out({ error: "slow down" }, 429);

  let info: any = b.info && typeof b.info === "object" && !Array.isArray(b.info) ? b.info : {};
  if (JSON.stringify(info).length > 4000) info = { truncated: true };
  const endpoint = typeof b.endpoint === "string" && /^https:\/\//.test(b.endpoint) ? b.endpoint.slice(0, 1000) : null;
  let emp: number | null = null, subId: number | null = null;
  if (endpoint) {
    const { data: s } = await db.from("chat_push_subs").select("id,emp_id,p256dh,auth").eq("endpoint", endpoint).maybeSingle();
    if (s) {
      emp = Number(s.emp_id); subId = Number(s.id);
      if (typeof info.kh === "string") info.keys_match = info.kh === await khash(s.p256dh, s.auth);
    } else info.on_file = false;
  }
  if (!emp && Number(info.me)) emp = Number(info.me);
  if (!emp || !KEEP.has(emp)) return out({ ok: true, kept: false });
  const { error } = await db.from("chat_push_diag").insert({
    kind, origin: String(b.origin || "").slice(0, 100), endpoint, sub_id: subId, emp_id: emp,
    ua: (req.headers.get("user-agent") || "").slice(0, 200), info,
  });
  if (error) { console.error(error); return out({ error: "couldn't save" }, 500); }
  return out({ ok: true, kept: true });
});
