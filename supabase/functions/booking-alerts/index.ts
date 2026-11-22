// booking-alerts — new Wix table reservations → #memphis / #nashville in Greys Chat (verify_jwt = false).
// Cron 'chat-booking-alerts' every 2 min, x-chat-secret = app_secrets 'chat_notify_secret'.
// Looks at the newest reservations per shop, posts any made in the last 30 min via chat_booking_post
// (dedup on ext_id 'wix:<id>'; chat-notify pushes the card to the channel). Skips checkout holds and the
// "(table hold)" reservations table-holds makes for events / experiences.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const WIX_HEADERS = { Authorization: Deno.env.get("WIX_API_KEY") ?? "", "wix-site-id": Deno.env.get("WIX_SITE_ID") ?? "", "Content-Type": "application/json" };
const WIX_RES_URL = "https://www.wixapis.com/table-reservations/reservations/v1/reservations";
const SHOPS: Record<string, string> = { memphis: "908a32b3-cd51-490f-b1cb-635321094200", nashville: "825c5be0-25d3-4d7e-9418-b062b387f448" };
const WINDOW_MS = 30 * 60e3;
const SKIP = new Set(["HELD", "PAYMENT_INFORMATION_PENDING", "CANCELED", "CANCELLED", "DECLINED"]);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

Deno.serve(async (req) => {
  const { data: sec } = await db.from("app_secrets").select("value").eq("name", "chat_notify_secret").maybeSingle();
  if (!sec?.value || req.headers.get("x-chat-secret") !== sec.value) return new Response("forbidden", { status: 403 });
  const out: Record<string, unknown> = {};
  for (const [shop, loc] of Object.entries(SHOPS)) {
    try {
      const r = await fetch(WIX_RES_URL + "/search", { method: "POST", headers: WIX_HEADERS, body: JSON.stringify({ search: {
        filter: { "details.reservationLocationId": { $eq: loc } }, sort: [{ fieldName: "createdDate", order: "DESC" }], cursorPaging: { limit: 50 } } }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { out[shop] = { error: r.status, d }; continue; }
      let posted = 0;
      for (const x of d.reservations || []) {
        if (!x?.id || !x.createdDate || Date.now() - Date.parse(x.createdDate) > WINDOW_MS) continue;
        if (SKIP.has(String(x.status)) || /\(table hold\)/i.test(String(x.reservee?.lastName || ""))) continue;
        const who = [x.reservee?.firstName, x.reservee?.lastName].filter(Boolean).join(" ") || "Guest";
        const f = [["When", x.details?.startDate ? when(x.details.startDate) : "—"], ["Guest", who], ["Party", String(x.details?.partySize ?? "—")]];
        if (x.status && x.status !== "RESERVED") f.push(["Status", String(x.status).replace(/_/g, " ").toLowerCase()]);
        const { data: id } = await db.rpc("chat_booking_post", { p_loc: shop, p_ext: "wix:" + x.id, p_title: "🍽️ New table reservation", p_fields: f, p_at: new Date().toISOString() });
        if (id) posted++;
      }
      out[shop] = { posted };
    } catch (e) { out[shop] = { error: String(e).slice(0, 200) }; }
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
