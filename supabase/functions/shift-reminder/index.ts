// shift-reminder — emails every employee their shifts for TOMORROW (America/Chicago).
// Runs daily via pg_cron; idempotent — portal_reminder_log guards against double-sends,
// so stray manual calls are harmless. Pass { force: true } to re-send (testing).
//
// Mail goes through the shared `send-mail` function (was: send-confirmation, which is
// now itself just a public proxy to send-mail). Provider choice lives there.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const MAIL_FROM = Deno.env.get("PORTAL_MAIL_FROM") ?? "GREYS Schedule <info@greyscheese.com>";
const LOC_NAMES: Record<string, string> = { memphis: "Memphis", nashville: "Nashville", franklin: "Franklin" };

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const escHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTime = (t: string) => { const p = String(t).split(":").map(Number); const ap = p[0] >= 12 ? "pm" : "am"; return (((p[0] + 11) % 12) + 1) + (p[1] ? ":" + String(p[1]).padStart(2, "0") : "") + ap; };

function tomorrowCentral(): string {
  // today's date in America/Chicago, plus one day
  const now = new Date();
  const central = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
  const d = new Date(central + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/send-mail`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_SERVICE}` },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html: html + `<p style=\"color:#888;font-size:12px\">GREYS staff portal — this is an automated message.</p>` }),
    });
    return r.ok;
  } catch (_) { return false; }
}

Deno.serve(async (req: Request) => {
  let payload: Record<string, any> = {};
  try { payload = await req.json(); } catch (_) { /* ok */ }
  const target = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date ?? "")) ? String(payload.date) : tomorrowCentral();

  // idempotency guard — one run per target date unless forced
  if (payload.force !== true) {
    const { data: done } = await admin.from("portal_reminder_log").select("for_date").eq("for_date", target).maybeSingle();
    if (done) return json({ ok: true, skipped: "already sent for " + target });
  }

  const { data: shifts, error } = await admin.from("portal_shifts").select("*").eq("date", target).order("start_time");
  if (error) return json({ error: error.message }, 500);
  const byEmp: Record<number, any[]> = {};
  (shifts || []).forEach((s: any) => { (byEmp[s.employee_id] ||= []).push(s); });
  const ids = Object.keys(byEmp).map(Number);

  let sent = 0;
  if (ids.length) {
    const [{ data: emps }, { data: contacts }] = await Promise.all([
      admin.from("portal_employees").select("id,name,active").in("id", ids),
      admin.from("portal_employee_contacts").select("*").in("employee_id", ids),
    ]);
    const emailOf: Record<number, string> = {};
    (contacts || []).forEach((c: any) => { if (c.email) emailOf[c.employee_id] = c.email; });
    const dayLabel = new Date(target + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
    for (const id of ids) {
      const emp = (emps || []).find((e: any) => e.id === id);
      if (!emp || emp.active === false || !emailOf[id]) continue;
      const list = "<ul>" + byEmp[id].map((s: any) =>
        `<li>${fmtTime(s.start_time)} – ${fmtTime(s.end_time)} at ${LOC_NAMES[s.location] || s.location}${s.role ? " · " + escHtml(s.role) : ""}${s.note ? " · " + escHtml(s.note) : ""}</li>`).join("") + "</ul>";
      const ok = await sendMail(emailOf[id], `Reminder: you work tomorrow (${dayLabel})`,
        `<p>Hi ${escHtml(String(emp.name).split(" ")[0])},</p><p>Quick reminder — you're on the schedule tomorrow, <strong>${dayLabel}</strong>:</p>${list}`);
      if (ok) sent++;
    }
  }

  await admin.from("portal_reminder_log").upsert({ for_date: target, sent, ran_at: new Date().toISOString() });
  return json({ ok: true, date: target, employees: ids.length, sent });
});
