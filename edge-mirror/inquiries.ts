// inquiries — HoneyBook-style customer conversations for Experiences and private events.
//
//   ask   (public)  kind "event" (2026-10-08): a private event / big party from the one inquiry
//                   form — shop, guests, date, time in words; never a hold; saved with no
//                   experience and experience_name "Private event".
//                   `answers` [{id,label,value}]: the editable questions from the form
//                   (site_content 'inquiry_form') — added to the first message + details.answers.
//                   Otherwise: customer question from inquiry.html (the all-button form) or the old
//                   experiences.html modal. They pick experience, guests, date and time first.
//                   Time = a window (12–2 or 4–7; the form sends the first open start time in
//                   it) or "other" with their own words (time_window / time_note, 2026-10-06).
//                   Shops that book experiences online (HOLD_LOCATIONS — Memphis and Nashville
//                   since 2026-11-05): an open start time is held 48 h (pending rb reservation +
//                   Wix tables; at-home holds no tables), for experiences that book online
//                   (rb_experience_types.bookable; Maverick 2026-11-05: Raclette, Fondue and
//                   Wine & Cheese Tasting). inquiry.html sends that from its "Hold this time and
//                   ask us first" link; its main button books and pays on experiences.html.
//                   "Other" times, other shops and request-only experiences: no hold — the date
//                   and time ride along for staff.
//                   request: true (inquiry.html since 2026-10-30): a REQUEST — date and time,
//                   nothing held; staff check it and reply (with a booking link to pay).
//                   Then lead + first message, staff alert, customer ack.
//                   A day the shop is closed (rb_day_closed: a Wix holiday, an all-day buyout, a weekday
//                   with no hours) is refused for every experience, held or requested (2026-11-13).
//                   2026-11-14: a party that isn't one of the experience's steps is refused (Fondue: 2, 4,
//                   6 or 8 — rb_experience_types.party_step), and `addons` (keys, e.g. chocolate_fondue)
//                   ride along — priced onto a held booking (rb_experience_addons), on the message and
//                   in details.addons for a request (the portal's booking link carries them).
//   reply (admin)   staff reply from the manager console → emailed to the customer;
//                   sending a booking link (…?book=…) restarts the 48 h hold
//   log   (admin)   paste a reply the customer sent by email into the conversation
//   ingest (secret) Google Apps Script running in brad@greyscheese.com's Gmail posts each
//                   customer reply whose subject carries [#CODE]; it lands in that thread
//                   (a code that belongs to a catering_leads row lands in catering_messages;
//                   one on a Greys Chat client conversation — chat_convos.mail_code, first
//                   letter G–Z — lands in that conversation, 2026-10-12)
//
// Replies from customers go to INQUIRY_REPLY_TO (brad@greyscheese.com for now) until
// inbound email is wired straight into the portal. Mail goes through send-mail.
// verify_jwt = false: `ask` is public (rate-limited); the rest check the admin JWT.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const REPLY_TO = Deno.env.get("INQUIRY_REPLY_TO") || "brad@greyscheese.com";
const STAFF_INBOX = Deno.env.get("INQUIRY_INBOX") || "brad@greyscheese.com";
const FROM = Deno.env.get("INQUIRY_FROM") || "GREYS Fine Cheeses <info@greyscheese.com>";
const SITE = Deno.env.get("TICKET_SITE_URL") || "https://tickets.greyscheese.com";
const PORTAL = "https://staff.greyscheese.com/manager.html";
const MASTER_EMAIL = "bbearo@gmail.com";
// Shops where experiences book online (same list as LOCATIONS in experiences.html / EXP_BOOK_SHOPS in
// inquiry.html). Nashville joined 2026-11-05 (Maverick: experiences book at both shops).
const HOLD_LOCATIONS = ["memphis", "nashville"];
// the time buttons on inquiry.html
const WINDOW_LABELS: Record<string, string> = { "12-2": "12–2 pm", "4-7": "4–7 pm", "other": "Other time" };
const hhmm12 = (t: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(t || "");
  if (!m) return t;
  const h = +m[1];
  return ((h + 11) % 12 + 1) + ":" + m[2] + (h < 12 ? " AM" : " PM");
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
class PublicError extends Error {}
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const usd = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");
// "2, 4, 6 or 8 guests" — same words as rb_party_sizes() in the database
function partySizes(min: number, max: number, step: number) {
  if (step <= 1) return `parties of ${min} to ${max}`;
  if (Math.floor((max - min) / step) >= 7) return `parties of ${min} to ${max}, in steps of ${step}`;
  const n: number[] = [];
  for (let p = min; p <= max; p += step) n.push(p);
  return (n.length > 1 ? n.slice(0, -1).join(", ") + " or " + n[n.length - 1] : String(n[0])) + " guests";
}
const para = (s: string) => esc(s).replace(/\r?\n/g, "<br>").replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');

async function isAdmin(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.startsWith("sb_publishable_")) return false;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return false;
  const email = (data.user?.email || "").toLowerCase();
  if (email === MASTER_EMAIL) return true;
  const { data: row } = await admin.from("app_users").select("email").eq("status", "approved").ilike("email", email).maybeSingle();
  return !!row;
}
async function whoIs(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const { data } = await admin.auth.getUser(token);
  return data.user?.email || "staff";
}

async function sendMail(to: string, subject: string, html: string, replyTo = REPLY_TO) {
  const r = await fetch(SB_URL + "/functions/v1/send-mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE },
    body: JSON.stringify({ to, subject, html, from: FROM, replyTo }),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.ok ? "sent" : "failed: " + JSON.stringify(d).slice(0, 200);
}
// Brand email chrome (Maverick 2026-10-12, same as the catering fn): cream canvas, white card,
// navy header band with the GREYS wordmark + gold rule, gold CTA with navy text, shop footer.
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
const quote = (html: string, muted = false) => `<blockquote style="border-left:3px solid ${GOLD};margin:0;padding:4px 14px;${muted ? "color:" + MUTE : ""}">${html}</blockquote>`;
const subjectFor = (inq: any) => `Your GREYS ${inq.experience_name || "experience"} question [#${inq.code}]`;

// ---------- actions ----------
const HOLD_HOURS = 48;
const fmtCT = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

async function tableHolds(action: string, body: Record<string, unknown>) {
  const r = await fetch(SB_URL + "/functions/v1/table-holds?action=" + action, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.ok !== false, data: d };
}

// The editable questions from the form: [{ id, label, value }], trimmed and capped.
type Answer = { id: string; label: string; value: string };
function answersOf(v: unknown): Answer[] {
  return (Array.isArray(v) ? v : []).slice(0, 30).map((a: any) => ({
    id: clean(a?.id, 40), label: clean(a?.label, 120),
    value: clean(Array.isArray(a?.value) ? a.value.join(", ") : a?.value, 1000),
  })).filter((a) => a.label && a.value);
}
const answerLine = (a: Answer) => a.label + (/[?:]$/.test(a.label) ? " " : ": ") + a.value;

// A private event or big party: nothing is held, staff check the date and reply.
async function askEvent(b: Record<string, unknown>, name: string, email: string, question: string) {
  const phone = clean(b.phone, 40);
  const date = clean(b.preferred_date, 10);
  const party = Math.floor(Number(b.party) || 0);
  const loc = clean(b.location, 40) || "Memphis";
  const win = clean(b.time_window, 10).toLowerCase();
  const other = win === "other";
  const note = clean(b.time_note, 80);
  const time = other ? note : (WINDOW_LABELS[win] || clean(b.preferred_time, 80));
  if (party < 1 || party > 1000) throw new PublicError("How many guests?");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PublicError("Pick a date.");
  if (other && !note) throw new PublicError("Tell us what time works.");
  const answers = answersOf(b.answers);
  const contact = clean(b.contact_pref, 20);
  const facts = [
    time && "Time: " + time,
    ...answers.map(answerLine),
    contact && "Best way to reach them: " + contact,
  ].filter(Boolean) as string[];
  const message = [question || "(No message typed.)", facts.length ? "—\n" + facts.join("\n") : ""].filter(Boolean).join("\n\n");
  const { data: inq, error } = await admin.from("inquiries").insert({
    name, email, phone: phone || null, location: loc,
    experience_type_id: null, experience_name: "Private event", preferred_date: date, preferred_time: time || null, party_size: party,
    details: { kind: "event", answers, contact_pref: contact || null, source: clean(b.source, 40) || null,
      time_window: win || null, time_note: other ? note : null },
  }).select("*").single();
  if (error) throw new Error(error.message);
  await admin.from("inquiry_messages").insert({ inquiry_id: inq.id, direction: "in", body: message, sent_by: email });
  const slot = fmtDay(date) + (time ? " · " + time : "");
  const line = ["<b>Private event</b>", esc(slot), `Guests: ${party}`, esc("GREYS " + loc), inq.phone && `Phone: ${esc(inq.phone)}`].filter(Boolean).join(" · ");
  await sendMail(STAFF_INBOX, `New private event inquiry from ${name} [#${inq.code}]`,
    shell(`<p><b>${esc(name)}</b> &lt;${esc(email)}&gt; asked:</p>${quote(para(message))}
      <p style="font:13px Arial;color:${MUTE}">${line}</p>
      <p style="font:13px Arial">No hold — check the date and reply.</p>
      ${btn(PORTAL + "#inquiries", "Reply in the portal")}`, false), email);
  await sendMail(email, subjectFor(inq),
    shell(`<p>Hi ${esc(name.split(" ")[0])},</p><p>Thanks for thinking of GREYS for your event — we've got your message and will get back to you shortly.</p>
      <p>We'll check <b>${esc(slot)}</b> for your group of ${party} and get right back to you.</p>
      <p style="font:13px Arial;color:${MUTE}">Your message:</p>${quote(para(message), true)}`));
  return { ok: true, code: inq.code, slot, hold_until: null, held: false };
}

// The customer picks experience, guests, date and time first. At a shop that books
// experiences online, that slot is checked and held for them for HOLD_HOURS as a 'pending'
// reservation (rb tables + Wix tables; an at-home experience holds only the date).
// The booking link staff send pays for that same reservation (square-experience-pay).
async function ask(req: Request, b: Record<string, unknown>) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { data: okRate } = await admin.rpc("ticket_rate_hit", { p_bucket: ("inq:" + ip).slice(0, 200), p_limit: 8, p_window_secs: 3600 });
  if (okRate === false) throw new PublicError("Too many messages from this connection — please try again later or call the shop.");
  const name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), question = clean(b.message, 4000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError("Please enter your name and a valid email.");
  if (clean(b.website)) return { ok: true }; // honeypot — bots fill every field
  if (clean(b.kind, 20).toLowerCase() === "event") return await askEvent(b, name, email, question);
  const phone = clean(b.phone, 40);
  const date = clean(b.preferred_date, 10);
  const party = Math.floor(Number(b.party) || 0);
  const loc = clean(b.location, 40) || "Memphis";
  // time_window: "12-2" | "4-7" | "other" (inquiry.html since 2026-10-06; older forms send none)
  const win = clean(b.time_window, 10).toLowerCase();
  const other = win === "other";
  const note = clean(b.time_note, 80);
  // a request: date (and time) only, never a hold (2026-10-30)
  const request = b.request === true;
  if (!b.experience_id) throw new PublicError("Pick an experience.");
  const { data: x } = await admin.from("rb_experience_types")
    .select("id, name, options, at_home, min_party, max_party, active, bookable, party_step, addons").eq("id", clean(b.experience_id, 64)).maybeSingle();
  if (!x || !x.active) throw new PublicError("That experience isn't available.");
  // only an experience that books online is held (request-only ones: Greysing Table, Build a
  // Board, Raclette at Home — rb_experience_types.bookable, 2026-11-05)
  const holds = HOLD_LOCATIONS.includes(loc.toLowerCase()) && !other && !request && x.bookable !== false;
  const time = clean(other ? note : b.preferred_time, holds ? 5 : 80);
  if (party < 1) throw new PublicError("How many guests?");
  if (party < x.min_party || party > x.max_party) throw new PublicError(`${x.name} is for parties of ${x.min_party} to ${x.max_party}.`);
  const step = Math.max(1, Math.floor(Number(x.party_step) || 1));
  if (step > 1 && (party - x.min_party) % step !== 0) throw new PublicError(`${x.name} is for ${partySizes(x.min_party, x.max_party, step)}.`);
  // the add-ons they ticked (chocolate fondue, $12.95 per guest): in the experience's own order, priced the way
  // rb_experience_addons prices them (per guest × the party, or once)
  const addonKeys = Array.isArray(b.addons) ? [...new Set((b.addons as unknown[]).map((k) => clean(k, 40)).filter(Boolean))].slice(0, 10) : [];
  const xAdds: any[] = Array.isArray(x.addons) ? x.addons : [];
  if (addonKeys.some((k) => !xAdds.some((a) => a && a.key === k))) throw new PublicError("That add-on isn't available anymore. Refresh the page and try again.");
  const addons = xAdds.filter((a) => a && addonKeys.includes(a.key)).map((a) => {
    const qty = a.per === "party" ? 1 : party, each = Math.round(Number(a.price_cents) || 0);
    return { key: String(a.key), label: String(a.label || "Add-on"), qty, per: a.per === "party" ? "party" : "guest", total_cents: each * qty };
  });
  const opts: any[] = Array.isArray(x.options) ? x.options : [];
  const opt = opts.find((o) => o && o.key === clean(b.option, 40)) || null;
  if (opts.length && !opt) throw new PublicError("Pick " + opts.map((o) => o.label).join(" or ") + ".");
  const address = x.at_home ? clean(b.address, 300) : "";
  if (x.at_home && address.length < 8) throw new PublicError("Add the address where we'll set up.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PublicError("Pick a date.");
  // A day the shop is closed — a Wix holiday (Thanksgiving), an all-day buyout, a weekday it has no hours —
  // takes no experience: held or a request, at the shop or at home (2026-11-13, Maverick: "we should not be
  // able to book experiences on any day the reservations are not available, they're the same thing").
  // rb_day_closed is the same rule as rb_get_availability's "closed" and the form's date buttons. If the
  // check itself fails, the request still goes through (a hold is checked again by rb_create_experience_v2).
  const { data: shut, error: shutErr } = await admin.rpc("rb_day_closed", { p_location: loc, p_date: date, p_experience: x.id });
  if (shutErr) console.error("rb_day_closed", shutErr.message);
  else if (shut === true) throw new PublicError("We're closed that day. Pick another date.");
  if (holds && !/^\d{2}:\d{2}$/.test(time)) throw new PublicError("Pick a date and an open time.");
  if (other && !note) throw new PublicError("Tell us what time works.");
  const occasion = clean(b.occasion, 60);
  const dietary = (Array.isArray(b.dietary) ? b.dietary : []).map((v) => clean(v, 40)).filter(Boolean).slice(0, 10);
  const contact = clean(b.contact_pref, 20);
  // the editable questions (2026-10-08). An answer with the id "occasion" / "dietary" stands
  // in for the old fields of the same name, so neither shows twice.
  const answers = answersOf(b.answers);
  const has = (id: string) => answers.some((a) => a.id === id);

  // the first message: what they typed, plus every button they pressed
  const winLabel = WINDOW_LABELS[win] || "";
  const facts = [
    winLabel && "Time: " + (other ? "another time — " + note : winLabel + (holds ? " (holding " + hhmm12(time) + ")" : "")),
    opt && "Option: " + opt.label,
    ...addons.map((a) => "Add-on: " + a.label + (a.per === "guest" ? " for " + a.qty : "") + " (" + usd(a.total_cents) + ")"),
    x.at_home && "Address: " + address,
    !has("occasion") && occasion && "Occasion: " + occasion,
    !has("dietary") && dietary.length && "Dietary: " + dietary.join(", "),
    ...answers.map(answerLine),
    contact && "Best way to reach them: " + contact,
  ].filter(Boolean) as string[];
  const message = [question || "(No question typed.)", facts.length ? "—\n" + facts.join("\n") : ""].filter(Boolean).join("\n\n");

  let rid: string | null = null, rcode: string | null = null, holdUntil: string | null = null, slot = "";
  if (holds) {
    const { count: live } = await admin.from("rb_reservations").select("id", { count: "exact", head: true })
      .eq("kind", "experience").eq("status", "pending").eq("email", email).gt("hold_expires_at", new Date().toISOString());
    if ((live || 0) >= 2) throw new PublicError("You already have times on hold with us — reply to our email and we'll sort it out.");

    // 1. claim the slot (validates party, hours, lead time, price option; picks the tables)
    const { data: res, error: rerr } = await admin.rpc("rb_create_experience_v2", {
      p_experience: x.id, p_date: date, p_time: time, p_party: party, p_name: name, p_email: email,
      p_phone: phone, p_notes: "", p_location: loc, p_option: opt ? opt.key : null, p_address: x.at_home ? address : null,
    });
    if (rerr) throw new Error(rerr.message);
    if (!res || res.ok === false) throw new PublicError((res && res.error) || "That time isn't available — pick another.");
    rid = String(res.id); rcode = String(res.code);
    holdUntil = new Date(Date.now() + HOLD_HOURS * 3600000).toISOString();
    // the add-ons go on the held booking too, so its booking link pays for them (total_cents = package + add-ons)
    const held: Record<string, unknown> = { status: "pending", hold_expires_at: holdUntil };
    if (addons.length) {
      const { data: q } = await admin.rpc("rb_experience_addons", { p_experience: x.id, p_party: party, p_keys: addons.map((a) => a.key) });
      if (q && q.ok) {
        const cents = Math.round(Number(q.cents) || 0);
        Object.assign(held, { addons: q.items, addons_cents: cents, total_cents: Math.round(Number(res.total_cents) || 0) + cents });
      } else console.error("rb_experience_addons", q && q.error);
    }
    await admin.from("rb_reservations").update(held).eq("id", rid);
    // 2. the same tables in Wix, so dinner bookings can't take them meanwhile (none for at-home)
    if (!x.at_home) {
      const { data: r } = await admin.from("rb_reservations").select("starts_at, ends_at").eq("id", rid).single();
      const hold = await tableHolds("hold", { source: "experience", source_id: rid, location: loc, start: r?.starts_at, end: r?.ends_at, guests: party, label: (x.name + " – " + name).trim() });
      if (!hold.ok) {
        await admin.from("rb_reservations").update({ status: "cancelled" }).eq("id", rid);
        await tableHolds("release", { source: "experience", source_id: rid }).catch(() => null);
        throw new PublicError("Sorry — that time just filled up. Please pick another time.");
      }
    }
    slot = String(res.time || (date + " " + time));
  } else {
    slot = fmtDay(date) + (time ? " · " + time : "");
  }

  const { data: inq, error } = await admin.from("inquiries").insert({
    name, email, phone: phone || null, location: loc,
    experience_type_id: x.id, experience_name: x.name, preferred_date: date, preferred_time: time || null, party_size: party,
    reservation_id: rid, reservation_code: rcode, hold_expires_at: holdUntil,
    option_label: opt ? opt.label : null, event_address: address || null,
    details: { occasion: occasion || answers.find((a) => a.id === "occasion")?.value || null, dietary, answers, contact_pref: contact || null, option_key: opt ? opt.key : null, source: clean(b.source, 40) || null,
      time_window: win || null, time_note: other ? note : null, request: request || null, addons: addons.length ? addons.map((a) => a.key) : null },
  }).select("*").single();
  if (error) throw new Error(error.message);
  if (rid) await admin.from("rb_reservations").update({ inquiry_id: inq.id }).eq("id", rid);
  await admin.from("inquiry_messages").insert({ inquiry_id: inq.id, direction: "in", body: message, sent_by: email });

  const until = holdUntil ? fmtCT(holdUntil) : "";
  const where = x.at_home ? "at their place" : "GREYS " + loc;
  const line = [`<b>${esc(x.name)}</b>`, esc(slot), `Party: ${party}`, esc(where), inq.phone && `Phone: ${esc(inq.phone)}`].filter(Boolean).join(" · ");
  const holdNote = holdUntil
    ? `<p style="font:13px Arial">⏳ Held for them until <b>${esc(until)}</b>. Send the booking link from the portal to lock it in.</p>`
    : other
      ? `<p style="font:13px Arial">No hold — they asked for another time: <b>${esc(note)}</b>. Check it and reply.</p>`
      : `<p style="font:13px Arial">Request — nothing is held. Check the date and time, then reply (send the booking link to take payment).</p>`;
  await sendMail(STAFF_INBOX, `New experience inquiry from ${name} — ${x.name} [#${inq.code}]`,
    shell(`<p><b>${esc(name)}</b> &lt;${esc(email)}&gt; asked:</p>${quote(para(message))}
      <p style="font:13px Arial;color:${MUTE}">${line}</p>
      ${holdNote}
      ${btn(PORTAL + "#inquiries", "Reply in the portal")}`, false), email);
  const ack = holdUntil
    ? `<p>We're holding <b>${esc(slot)}</b> for your party of ${party} until <b>${esc(until)}</b>.</p>`
    : `<p>We'll check <b>${esc(slot)}</b> for your party of ${party} and get right back to you.</p>`;
  await sendMail(email, subjectFor(inq),
    shell(`<p>Hi ${esc(name.split(" ")[0])},</p><p>Thanks for reaching out about our <b>${esc(x.name)}</b> experience — we've got your message and will get back to you shortly.</p>
      ${ack}
      <p style="font:13px Arial;color:${MUTE}">Your message:</p>${quote(para(message), true)}`));
  return { ok: true, code: inq.code, slot, hold_until: holdUntil, held: !!holdUntil };
}

async function reply(req: Request, b: Record<string, unknown>) {
  const id = clean(b.inquiry_id, 64), body = clean(b.body, 8000);
  if (!body) throw new PublicError("Type a message first.");
  const { data: inq } = await admin.from("inquiries").select("*").eq("id", id).single();
  if (!inq) throw new PublicError("Conversation not found.");
  const status = await sendMail(inq.email, "Re: " + subjectFor(inq), shell(`<p>${para(body)}</p>`));
  const by = await whoIs(req);
  await admin.from("inquiry_messages").insert({ inquiry_id: id, direction: "out", body, sent_by: by, email_status: status });
  // a booking link: experiences.html?book=… today, experiences.greyscheese.com/?book=… later
  const hasLink = /[?&]book=/.test(body);
  if (hasLink && inq.reservation_id) {
    const until = new Date(Date.now() + HOLD_HOURS * 3600000).toISOString();
    const { data: held } = await admin.from("rb_reservations").update({ hold_expires_at: until })
      .eq("id", inq.reservation_id).eq("status", "pending").select("id");
    if (held && held.length) await admin.from("inquiries").update({ hold_expires_at: until }).eq("id", id);
  }
  const stage = hasLink ? "link_sent" : (inq.stage === "new" ? "replied" : inq.stage);
  await admin.from("inquiries").update({ stage, last_from: "staff", last_message_at: new Date().toISOString(), unread: false }).eq("id", id);
  if (status !== "sent") throw new PublicError("Saved, but the email didn't send (" + status + ").");
  return { ok: true, stage };
}

// Keep only what the customer wrote: drop quoted history ("On … wrote:", "> …",
// the Gmail/Outlook separators) and trailing whitespace.
function stripQuoted(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Gmail wraps "On <date> <sender>\nwrote:" onto two lines
    if (/^On .+/.test(l.trim()) && /wrote:\s*$/.test(l.trim() + " " + (lines[i + 1] || "").trim())) break;
    if (/^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l.trim()) && out.length) break;
    if (/^>/.test(l.trim())) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function ingest(b: Record<string, unknown>) {
  const { data: sec } = await admin.from("app_secrets").select("value").eq("name", "inquiry_ingest_secret").maybeSingle();
  if (!sec?.value || clean(b.secret, 200) !== sec.value) return { ok: false, error: "bad secret", status: 403 };
  const subject = clean(b.subject, 500);
  const m = subject.match(/\[#([A-Z0-9]{6})\]/i);
  if (!m) return { ok: true, skipped: "no code" };
  const { data: inq } = await admin.from("inquiries").select("id,email").eq("code", m[1].toUpperCase()).maybeSingle();
  if (!inq) return await ingestCatering(m[1].toUpperCase(), b);
  const gid = clean(b.message_id, 200);
  if (gid) {
    const { data: dup } = await admin.from("inquiry_messages").select("id").eq("gmail_id", gid).maybeSingle();
    if (dup) return { ok: true, skipped: "already have it" };
  }
  const body = stripQuoted(clean(b.body, 20000)).slice(0, 8000) || "(empty reply)";
  const from = clean(b.from, 200);
  await admin.from("inquiry_messages").insert({ inquiry_id: inq.id, direction: "in", body, sent_by: from || "email", gmail_id: gid || null });
  await admin.from("inquiries").update({ last_from: "customer", last_message_at: new Date().toISOString(), unread: true }).eq("id", inq.id);
  return { ok: true, added: true };
}

// Catering conversations share the Gmail sync: their subjects are "Your GREYS catering
// question [#CODE]", so a code that isn't an experience inquiry may be a catering lead.
async function ingestCatering(code: string, b: Record<string, unknown>) {
  const { data: lead } = await admin.from("catering_leads").select("id").eq("code", code).maybeSingle();
  if (!lead) return await ingestChat(code, b);
  const gid = clean(b.message_id, 200);
  if (gid) {
    const { data: dup } = await admin.from("catering_messages").select("id").eq("gmail_id", gid).maybeSingle();
    if (dup) return { ok: true, skipped: "already have it" };
  }
  const body = stripQuoted(clean(b.body, 20000)).slice(0, 8000) || "(empty reply)";
  await admin.from("catering_messages").insert({ lead_id: lead.id, direction: "in", body, sent_by: clean(b.from, 200) || "email", gmail_id: gid || null });
  await admin.from("catering_leads").update({ last_from: "customer", last_message_at: new Date().toISOString(), unread: true }).eq("id", lead.id);
  return { ok: true, added: true, catering: true };
}

// Greys Chat client emails go out as "Your GREYS question [#CODE]" (chat_convos.mail_code, made by
// chat-api; the first letter is G–Z, so it never matches an inquiry's or a lead's hex code). The
// customer's reply goes into that conversation as a client email message — same row shape and the
// same "gmail:<id>" dedupe key as chat-mail-in. The chat_messages triggers alert the staff on it.
async function ingestChat(code: string, b: Record<string, unknown>) {
  const { data: c } = await admin.from("chat_convos").select("id,kind,client_email,archived").eq("mail_code", code).maybeSingle();
  if (!c || c.kind !== "client") return { ok: true, skipped: "unknown code" };
  const gid = clean(b.message_id, 200).replace(/[^\w-]/g, "");
  const ext = gid ? "gmail:" + gid : null;
  if (ext) {
    const { data: dup } = await admin.from("chat_messages").select("id").eq("ext_id", ext).maybeSingle();
    if (dup) return { ok: true, skipped: "already have it" };
  }
  const text = stripQuoted(clean(b.body, 20000)).replace(/\n[ \t]*Sent from my [^\n]{1,60}\s*$/i, "").trim().slice(0, 8000)
    || "(No text in this email — check the inbox for an attachment.)";
  let html = esc(text).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // someone other than the client on the conversation (a coworker they forwarded it to): say who
  const from = clean(b.from, 200), addr = (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();
  if (addr && addr !== String(c.client_email || "").trim().toLowerCase()) {
    const who = (/^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1] || "").trim();
    html = `<b>${esc(who || addr)}</b> (${esc(addr)}):<br>` + html;
  }
  const { error } = await admin.from("chat_messages").insert({
    convo_id: c.id, author_kind: "client", via: "email", subject: clean(b.subject, 200) || null, body_html: html, ext_id: ext,
  });
  if (error) throw new Error(error.message);
  if (c.archived) await admin.from("chat_convos").update({ archived: false }).eq("id", c.id);
  return { ok: true, added: true, chat: true };
}

async function logIn(b: Record<string, unknown>) {
  const id = clean(b.inquiry_id, 64), body = clean(b.body, 8000);
  if (!body) throw new PublicError("Paste the customer's reply first.");
  const kind = b.note === true ? "note" : "in";
  await admin.from("inquiry_messages").insert({ inquiry_id: id, direction: kind, body, sent_by: kind === "note" ? "staff note" : "logged from email" });
  if (kind === "in") await admin.from("inquiries").update({ last_from: "customer", last_message_at: new Date().toISOString() }).eq("id", id);
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const ref = crypto.randomUUID().slice(0, 8);
  try {
    let b: Record<string, unknown> = {};
    try { b = await req.json(); } catch { /* empty */ }
    const action = new URL(req.url).searchParams.get("action") ?? String(b.action ?? "");
    if (action === "ask") return json(await ask(req, b));
    if (action === "ingest") { const r: any = await ingest(b); return json(r, r.status || 200); }
    if (!(await isAdmin(req))) return json({ ok: false, error: "Not authorized" }, 403);
    if (action === "reply") return json(await reply(req, b));
    if (action === "log") return json(await logIn(b));
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json({ ok: false, error: e.message }, 400);
    console.error(`[${ref}]`, e);
    return json({ ok: false, error: `Something went wrong (ref ${ref}).` }, 500);
  }
});
