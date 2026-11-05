// order-photo — the staff portal's "Snap Order" home tile (2026-11-05).
//
// A server photographs a filled-in paper "Future Order" form (the Catering Order Form artifact:
// a letter page holding two copies, cut in half). This reads it with Claude (vision + JSON schema
// output) and, once the server has checked the reading, files it as a catering pre-order: a
// `preorders` row with status 'confirmed'. That puts it on the portal calendar (square-orders feed)
// and in Manager → Catering → Pre-Orders. No Square order is made — the server already rang it on
// Square and wrote the ticket # on the form, so square_order_id stays null.
//
//   POST {action:"menu"}                                   → {ok, menu, tax_rate}
//   POST {action:"read", emp, loc, image, type?}           → {ok, read_id, photo, readable, problem, orders:[draft]}
//        image = base64 JPEG/PNG/WebP (no data: prefix). The photo is kept in the private bucket
//        order-forms either way, so a form the model can't read can still be typed in with it attached.
//   POST {action:"create", emp, loc, order, photo?, index?, read_id?, ref?, force?}
//        → {ok:true, preorder} | {ok:false, duplicate:{…}} (same Square ticket # already filed; resend force:true)
//
// emp = the employee ID typed on the portal (portal_employees.login_id, active) — the same trust level
// as the rest of the staff pages (schedule, my hours). Every read is logged to order_photo_reads.
// Model: ORDER_PHOTO_MODEL (default claude-sonnet-5-5), ORDER_PHOTO_EFFORT (default medium), key
// ANTHROPIC_API_KEY (the secret greys-assistant uses). Limits via ticket_rate_hit: 40 reads an hour per
// employee, 400 a day for everyone. verify_jwt = true; the portal calls with the publishable key.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ORDER_PHOTO_MODEL") || "claude-sonnet-5-5";
const EFFORT = Deno.env.get("ORDER_PHOTO_EFFORT") || "medium";
const TZ = "America/Chicago";
const BUCKET = "order-forms";
const TAX_RATE = 9.75;                       // catering is FOOD_AND_BEV at 9.75%, added on top (same as the Pre-Orders tab)
const LOCS: Record<string, { label: string; square: string }> = {
  memphis: { label: "Memphis", square: "LCXWZ0HAQ69RM" },
  nashville: { label: "Nashville", square: "LJ33VDYHS1JAR" },
};

// ---------- the printed form: one entry per quantity box (prices and Square variations as of 2026-11-05) ----------
type Opt = { label: string; name: string; v: string };
type Item = { key: string; section: string; name: string; serves?: string; price: number; v?: string; options?: Opt[] };
const MENU: Item[] = [
  { key: "board_m", section: "Charcuterie Boards", name: "Charcuterie Board — Medium", serves: "serves 20", price: 15000, v: "JADLLVMBI62D2TXQJQL3JL4R" },
  { key: "board_l", section: "Charcuterie Boards", name: "Charcuterie Board — Large", serves: "serves 40", price: 27500, v: "6F2YUIBJMA3JZUDO4JPCDJEM" },
  { key: "board_xl", section: "Charcuterie Boards", name: "Charcuterie Board — Extra Large", serves: "serves 60", price: 45000, v: "TVCCL35FX7EGYICNYQKFJG5P" },
  { key: "demi", section: "Boxes", name: "The Demi", serves: "serves 4", price: 5000, v: "RERY3TTQ5TZX6MLFM4KBGKSL" },
  { key: "gathering", section: "Boxes", name: "The Gathering", serves: "serves 12", price: 9900, v: "DG2RQUKCXGEWLQ3QMHAADN5G" },
  { key: "mini_cc", section: "Boxes", name: "Mini Box — Cheese & Charcuterie", price: 1600, v: "JHKIWBPOZIEM2WRCPCRQV2XP" },
  { key: "mini_c", section: "Boxes", name: "Mini Box — Cheese", price: 1500, v: "T7VNZI3H5YKWPYGY5H2PYYHM" },
  { key: "planche_21", section: "Planches", name: "Planche 2/1", price: 2000, v: "ZJUN45MUD6KADRKLNM7GXUYA" },
  { key: "planche_32", section: "Planches", name: "Planche 3/2", price: 3200, v: "RYMHJF5XXJ6SULHLAVNPZTX7" },
  { key: "planche_53", section: "Planches", name: "Planche 5/3", price: 5000, v: "ONFRDM4CXAN4ISWBWZKUKV7N" },
  { key: "pyramid", section: "Packages", name: "Greys Pyramid", serves: "serves 12", price: 20000, v: "VHH2Y5WFKZXNCR7WFCITQJE4" },
  {
    key: "grand", section: "Packages", name: "Grand Greys", serves: "serves 30", price: 35000, options: [
      { label: "Turkey", name: "Grand Greys — Turkey", v: "7VKNOOWGEYCC7XDN36XRNYGV" },
      { label: "Italian", name: "Grand Greys — Italian", v: "27IOLJ7AWU2J2IUCN7VTHKA2" },
      { label: "Both", name: "Grand Greys — Turkey + Italian", v: "Z3KCE63JNS55TVH72BUDMKGK" },
    ],
  },
  { key: "platter_t", section: "Platters", name: "Sandwich Platter — Turkey", serves: "serves 12", price: 10500, v: "O6WHXMLLIYCNIIQ5S7TKTAAT" },
  { key: "platter_i", section: "Platters", name: "Sandwich Platter — Italian", serves: "serves 12", price: 10500, v: "VCRUZOWNIN3VT3WTTSR4JDTX" },
  { key: "platter_ti", section: "Platters", name: "Sandwich Platter — Turkey + Italian", serves: "serves 12", price: 10500, v: "UTDSMBQSWMP5CYGPXB2L5J5U" },
  { key: "platter_p", section: "Platters", name: "Sandwich Platter — Pimento Cheese", serves: "serves 12", price: 10500, v: "BK2M3NQVGOTDFATTBTAZDBOM" },
  { key: "cheesecake", section: "Platters", name: "Cheesecake", serves: "10 slices", price: 6500, v: "EU6L6DCAWSGDKXT4FVZQA4MJ" },
  { key: "lunch_t_salad", section: "Box Lunches", name: "Box Lunch — Turkey + Salad", price: 1700, v: "CJSO5WIPGPSU4QVGHMFYBJY4" },
  { key: "lunch_t_cake", section: "Box Lunches", name: "Box Lunch — Turkey + Cheesecake", price: 1700, v: "CJSO5WIPGPSU4QVGHMFYBJY4" },
  { key: "lunch_i_salad", section: "Box Lunches", name: "Box Lunch — Italian + Salad", price: 1700, v: "ASJQXKPCDZHSPG6KKDBKV7U7" },
  { key: "lunch_i_cake", section: "Box Lunches", name: "Box Lunch — Italian + Cheesecake", price: 1700, v: "ASJQXKPCDZHSPG6KKDBKV7U7" },
  { key: "lunch_p_salad", section: "Box Lunches", name: "Box Lunch — Pimento Cheese + Salad", price: 1700, v: "PF6UFVS463PQKX6SY7ILOUEL" },
  { key: "lunch_p_cake", section: "Box Lunches", name: "Box Lunch — Pimento Cheese + Cheesecake", price: 1700, v: "PF6UFVS463PQKX6SY7ILOUEL" },
  {
    key: "tea", section: "Extras", name: "Tea (gallon)", price: 1000, options: [
      { label: "Sweet", name: "Tea (gallon) — Sweet", v: "5HCXQOAOQ7OPUYUYAWMFX5IZ" },
      { label: "Unsweet", name: "Tea (gallon) — Unsweet", v: "SY4VNPATTBP6RA2HXN5LA5CB" },
    ],
  },
  { key: "ware_1", section: "Extras", name: "Serveware (each)", price: 125, v: "6IGQIWGO45XTN6Y6ASVLVLBR" },
  { key: "ware_25", section: "Extras", name: "Serveware (set of 25)", price: 2500, v: "TC7VBJ4SNUTSQYUKMXE7WF5P" },
];
const BY_KEY: Record<string, Item> = Object.fromEntries(MENU.map((m) => [m.key, m]));
const FIELDS = ["name", "phone", "date", "time", "ticket", "fulfillment", "address", "notes", "taken_by", "paid", "deposit"];

// ---------- http ----------
const ORIGIN_OK = (o: string) =>
  /^https:\/\/([a-z0-9-]+\.)*greyscheese\.com$/i.test(o) ||
  /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(o) ||
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o);
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": o && ORIGIN_OK(o) ? o : "https://staff.greyscheese.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors(req), "Content-Type": "application/json" } });
class PublicError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const clipText = (v: unknown, max: number) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

// ---------- dates (shop time) ----------
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
function todayLine() {
  const now = new Date();
  const long = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now);
  return long + " (" + ymd(now) + ")";
}
// Wall-clock date + "HH:MM" in shop time → UTC ISO, right on both sides of DST (same as square-orders).
function chicagoISO(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const behind = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    return (ms - Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"))) / 60000;
  };
  let t = guess + behind(guess) * 60000;
  const again = behind(t);
  if (guess + again * 60000 !== t) t = guess + again * 60000;
  return new Date(t).toISOString();
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
function normTime(s: unknown): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return "";
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? String(h).padStart(2, "0") + ":" + m[2] : "";
}

// ---------- who is asking ----------
const likeLit = (s: string) => s.replace(/([\\%_])/g, "\\$1");
async function employee(raw: unknown) {
  const v = String(raw ?? "").trim();
  if (!v || v.length > 40) throw new PublicError("Sign in with your employee ID first.", 401);
  const { data, error } = await admin.from("portal_employees").select("id,name,login_id")
    .eq("active", true).ilike("login_id", likeLit(v)).limit(5);
  if (error) throw error;
  const e = (data ?? []).find((x) => String(x.login_id ?? "").trim().toLowerCase() === v.toLowerCase());
  if (!e) throw new PublicError("That employee ID isn't active here — sign in again.", 401);
  return e as { id: number; name: string; login_id: string };
}
function locOf(raw: unknown) {
  const v = String(raw ?? "").toLowerCase();
  if (!LOCS[v]) throw new PublicError("Pick Memphis or Nashville.");
  return v;
}
async function rateOk(bucket: string, limit: number, secs: number) {
  try {
    const { data, error } = await admin.rpc("ticket_rate_hit", { p_bucket: bucket.slice(0, 200), p_limit: limit, p_window_secs: secs });
    return !(!error && data === false);
  } catch (_) {
    return true;   // the limiter failing must not stop the shop
  }
}

// ---------- menu ----------
function menu() {
  return {
    ok: true,
    tax_rate: TAX_RATE,
    menu: MENU.map((m) => ({
      key: m.key, section: m.section, name: m.name, serves: m.serves ?? "", price_cents: m.price,
      options: m.options ? m.options.map((o) => o.label) : [],
    })),
  };
}

// ---------- reading the photo ----------
const PROMPT = `You read photos of GREYS Fine Cheeses' paper "Future Order" form — a catering order slip a server fills in by hand — and return exactly what is written, as JSON.

THE PRINTED FORM, top to bottom
- Header: "GREYS" on the left, "Future Order" on the right.
- Name ____   Phone ____
- Date ____   Time ____   Square Ticket # [box]
- [ ] Pickup  [ ] Delivery   Address ____
- Item rows. Every row starts with a small QUANTITY BOX on the far left; the number written in that box is how many. A check mark, X or slash in the box means 1. Tally marks count. An empty box means not ordered — leave that item out.
  CHARCUTERIE BOARDS: board_m = "Medium serves 20 $150" · board_l = "Large serves 40 $275" · board_xl = "Extra Large serves 60 $450"
  BOXES: demi = "The Demi serves 4 $50" · gathering = "The Gathering serves 12 $99" · mini_cc = "Mini — Cheese & Charcuterie $16" · mini_c = "Mini — Cheese $15"
  PLANCHES: planche_21 = "Planche 2/1 $20" · planche_32 = "Planche 3/2 $32" · planche_53 = "Planche 5/3 $50"
  PACKAGES: pyramid = "Greys Pyramid serves 12 $200" · grand = "Grand Greys — T / I / Both serves 30 $350". For grand the server circles, underlines or checks T (Turkey), I (Italian) or Both: option is "Turkey", "Italian" or "Both", or "" if nothing is marked.
  PLATTERS: platter_t = "Sandwich — Turkey" · platter_i = "Sandwich — Italian" · platter_ti = "Sandwich — Turkey + Italian" · platter_p = "Sandwich — Pimento Cheese" (all "serves 12 $105") · cheesecake = "Cheesecake 10 slices $65"
  BOX LUNCHES — $17: a small grid. Its rows are the sandwich (Turkey, Italian, Pimento Cheese); its two columns of boxes are the side (Salad, Cheesecake). A number in a box is that many box lunches of that sandwich with that side: lunch_t_salad, lunch_t_cake, lunch_i_salad, lunch_i_cake, lunch_p_salad, lunch_p_cake.
  EXTRAS: tea = "Tea (gal) — Sweet / Unsweet $10" (option "Sweet" or "Unsweet" from the word that is circled or marked, "" if neither; if both are ordered with separate counts, give two entries) · ware_1 = "Serveware — each $1.25" · ware_25 = "Serveware — set of 25 $25"
  OTHER: two blank rows where the server writes an item name and a price after "$". Return those in "other" (price in dollars; qty from its box, or 1 if the box is empty but a name is written).
- Notes / Allergies: a large box of free text.
- Taken By ____ (the server's name)
- [ ] Paid   [ ] Deposit $____   [ ] Picked Up / Sent

RULES
- Report the handwriting, not the printed words. Never add an item that isn't marked. The option field is "" for items without options.
- A letter page holds two copies of the form side by side (left and right halves). Return one order per copy that has anything written on it, left copy first; skip blank copies. Most photos show a single copy.
- If the photo is not this form, or is too blurry, dark or cut off to read, set readable to false and put one short sentence a server can act on in problem (e.g. "Too blurry — hold the phone steady and retake."). Otherwise readable is true and problem is "".
- name: as written. phone: as written; format 10 digits as (901) 555-1234.
- date: the order date as YYYY-MM-DD. Orders are for today or a later day: when no year is written, use the first such date on or after today; "Sat", "tomorrow" and the like mean the next such day. date_written is exactly what was written. No date: date is "".
- time: 24-hour HH:MM. Without am/pm assume shop hours: 7 to 11 are morning, 12 is noon, 1 to 6 are afternoon or evening (1 → 13:00, 5:30 → 17:30); "noon" is 12:00. time_written is exactly what was written. No time: time is "".
- ticket: the Square ticket number as written, without "#". fulfillment: the box that is checked, or "not marked". address: as written, "" if none.
- deposit: the dollars written after "Deposit $" (0 if none). paid: true only when the Paid box is checked.
- notes: everything in the Notes / Allergies box, word for word — keep allergies exactly. taken_by: the name in Taken By.
- When a box, word or number is hard to read, give your best reading and flag it: unsure true on that item, or the field's name in unsure_fields. Honest flags matter more than looking complete — a person checks your reading before the order is saved.`;

const SCHEMA = {
  type: "object",
  properties: {
    readable: { type: "boolean" },
    problem: { type: "string" },
    orders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          date_written: { type: "string" },
          date: { type: "string" },
          time_written: { type: "string" },
          time: { type: "string" },
          ticket: { type: "string" },
          fulfillment: { type: "string", enum: ["pickup", "delivery", "not marked"] },
          address: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", enum: MENU.map((m) => m.key) },
                qty: { type: "integer" },
                option: { type: "string" },
                unsure: { type: "boolean" },
              },
              required: ["key", "qty", "option", "unsure"],
              additionalProperties: false,
            },
          },
          other: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                qty: { type: "integer" },
                price: { type: "number" },
                unsure: { type: "boolean" },
              },
              required: ["name", "qty", "price", "unsure"],
              additionalProperties: false,
            },
          },
          notes: { type: "string" },
          taken_by: { type: "string" },
          paid: { type: "boolean" },
          deposit: { type: "number" },
          unsure_fields: { type: "array", items: { type: "string", enum: FIELDS } },
        },
        required: ["name", "phone", "date_written", "date", "time_written", "time", "ticket", "fulfillment", "address",
          "items", "other", "notes", "taken_by", "paid", "deposit", "unsure_fields"],
        additionalProperties: false,
      },
    },
  },
  required: ["readable", "problem", "orders"],
  additionalProperties: false,
};

function sniff(bytes: Uint8Array): { type: string; ext: string } | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: "image/png", ext: "png" };
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { type: "image/webp", ext: "webp" };
  }
  return null;
}

async function askClaude(b64: string, mediaType: string) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 110_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: [
          { type: "text", text: PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: "Today is " + todayLine() + " in Memphis, Tennessee (Central Time)." },
        ],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: "Read this Future Order form." },
          ],
        }],
        output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
      }),
      signal: ctl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("anthropic " + res.status + ": " + JSON.stringify(j?.error ?? j).slice(0, 400));
    if (j.stop_reason === "max_tokens") throw new Error("reply cut off (max_tokens)");
    if (j.stop_reason === "refusal") throw new Error("model declined to read the photo");
    const text = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    return { out: JSON.parse(text), usage: j.usage ?? {} };
  } finally {
    clearTimeout(timer);
  }
}

// The model's reading → the draft the review screen edits. Prices come from MENU, never the model.
function draft(o: any, index: number, today: string) {
  const lines: { key: string; qty: number; option: string; unsure: boolean }[] = [];
  for (const it of Array.isArray(o?.items) ? o.items : []) {
    const m = BY_KEY[String(it?.key ?? "")];
    const qty = Math.max(0, Math.min(999, Math.round(Number(it?.qty) || 0)));
    if (!m || !qty) continue;
    let option = "";
    if (m.options) {
      const want = String(it?.option ?? "").trim().toLowerCase();
      option = m.options.find((x) => x.label.toLowerCase() === want || (want === "t" && x.label === "Turkey") ||
        (want === "i" && x.label === "Italian"))?.label ?? "";
    }
    const same = lines.find((l) => l.key === m.key && l.option === option);
    if (same) { same.qty += qty; same.unsure = same.unsure || !!it?.unsure; continue; }
    lines.push({ key: m.key, qty, option, unsure: !!it?.unsure || (!!m.options && !option) });
  }
  const other = (Array.isArray(o?.other) ? o.other : [])
    .filter((x: any) => clip(x?.name, 80))
    .map((x: any) => ({
      name: clip(x.name, 80),
      qty: Math.max(1, Math.min(999, Math.round(Number(x.qty) || 1))),
      price_cents: Math.max(0, Math.min(1_000_000, Math.round((Number(x.price) || 0) * 100))),
      unsure: !!x.unsure || !(Number(x.price) > 0),
    }));
  const date = isDate(String(o?.date ?? "")) ? String(o.date) : "";
  const time = normTime(o?.time);
  const deposit = Math.max(0, Math.round((Number(o?.deposit) || 0) * 100));
  const unsure = new Set((Array.isArray(o?.unsure_fields) ? o.unsure_fields : []).map(String).filter((f: string) => FIELDS.includes(f)));
  if (!date) unsure.add("date");
  if (!time) unsure.add("time");
  if (o?.fulfillment === "not marked") unsure.add("fulfillment");
  const warnings: string[] = [];
  if (date && date < today) warnings.push("That date has already passed — check it.");
  return {
    index,
    name: clip(o?.name, 80),
    phone: clip(o?.phone, 30),
    date, date_written: clip(o?.date_written, 40),
    time, time_written: clip(o?.time_written, 40),
    ticket: clip(String(o?.ticket ?? "").replace(/[^A-Za-z0-9-]/g, ""), 20),
    fulfillment: o?.fulfillment === "delivery" ? "delivery" : "pickup",
    address: clip(o?.address, 200),
    notes: clipText(o?.notes, 1500),
    taken_by: clip(o?.taken_by, 60),
    payment: o?.paid ? "paid" : deposit > 0 ? "deposit" : "unpaid",
    deposit_cents: deposit,
    lines, other,
    unsure: [...unsure],
    warnings,
  };
}

async function read(b: Record<string, unknown>) {
  const emp = await employee(b.emp);
  const loc = locOf(b.loc);
  const b64 = String(b.image ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (b64.length < 2000) throw new PublicError("No photo came through — try again.");
  if (b64.length > 9_500_000) throw new PublicError("That photo is too big — retake it.");
  if (!(await rateOk("op:" + emp.id, 40, 3600)) || !(await rateOk("op:all", 400, 86400))) {
    throw new PublicError("That's a lot of photos in a short time — wait a few minutes and try again.", 429);
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch (_) {
    throw new PublicError("That photo didn't come through right — try again.");
  }
  const kind = sniff(bytes);
  if (!kind) throw new PublicError("That file isn't a photo (JPEG, PNG or WebP).");

  const photo = `${loc}/${ymd(new Date())}/${crypto.randomUUID()}.${kind.ext}`;
  const up = await admin.storage.from(BUCKET).upload(photo, bytes, { contentType: kind.type, upsert: false });
  if (up.error) throw new Error("upload: " + up.error.message);

  const t0 = Date.now();
  const log: Record<string, unknown> = { emp_id: emp.id, emp_name: emp.name, loc_slug: loc, photo_path: photo, model: MODEL };
  let out: any = null, problem = "", readable = false, orders: ReturnType<typeof draft>[] = [];
  if (!KEY) {
    problem = "Reading photos isn't set up yet — type the order in below.";
    log.error = "not_configured";
  } else {
    try {
      const r = await askClaude(b64, kind.type);
      out = r.out;
      log.input_tokens = r.usage.input_tokens ?? null;
      log.output_tokens = r.usage.output_tokens ?? null;
      const today = ymd(new Date());
      orders = (Array.isArray(out?.orders) ? out.orders : []).slice(0, 4).map((o: any, i: number) => draft(o, i, today));
      readable = out?.readable !== false && orders.length > 0;
      problem = readable ? "" : clip(out?.problem, 200) || "Couldn't find a filled-in order form in that photo — retake it, or type it in.";
    } catch (e) {
      console.error("order-photo read", e);
      log.error = String(e instanceof Error ? e.message : e).slice(0, 600);
      problem = "Couldn't read it just now — try again, or type it in below.";
    }
  }
  log.ms = Date.now() - t0;
  log.orders_found = orders.length;
  log.result = out;
  const { data: row } = await admin.from("order_photo_reads").insert(log).select("id").single();
  return { ok: true, read_id: row?.id ?? null, photo, readable, problem, orders };
}

// ---------- filing the order ----------
const PHOTO_RE = /^(memphis|nashville)\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
async function create(b: Record<string, unknown>) {
  const emp = await employee(b.emp);
  const loc = locOf(b.loc);
  const o = (b.order ?? {}) as Record<string, any>;
  const name = clip(o.name, 80);
  if (!name) throw new PublicError("Add the customer's name.");
  const date = String(o.date ?? "");
  if (!isDate(date)) throw new PublicError("Add the pickup date.");
  const time = normTime(o.time);
  if (!time) throw new PublicError("Add the pickup time.");
  const pickupAt = chicagoISO(date, time);
  const days = (Date.parse(pickupAt) - Date.now()) / 86400_000;
  if (days < -60 || days > 400) throw new PublicError("That date doesn't look right — check the year.");

  const items: Record<string, unknown>[] = [];
  for (const l of Array.isArray(o.lines) ? o.lines : []) {
    const m = BY_KEY[String(l?.key ?? "")];
    const qty = Math.max(0, Math.min(999, Math.round(Number(l?.qty) || 0)));
    if (!m || !qty) continue;
    let nm = m.name, v = m.v;
    if (m.options) {
      const op = m.options.find((x) => x.label === String(l?.option ?? ""));
      if (!op) throw new PublicError("Pick " + m.options.map((x) => x.label).join(" / ") + " for " + m.name + ".");
      nm = op.name; v = op.v;
    }
    items.push({ name: nm, quantity: qty, unit_price_cents: m.price, catalog_object_id: v, form_key: m.key });
  }
  for (const x of Array.isArray(o.other) ? o.other : []) {
    const nm = clip(x?.name, 80);
    const qty = Math.max(0, Math.min(999, Math.round(Number(x?.qty) || 0)));
    if (!nm || !qty) continue;
    const price = Math.max(0, Math.min(1_000_000, Math.round(Number(x?.price_cents) || 0)));
    items.push({ name: nm, quantity: qty, unit_price_cents: price });
  }
  if (!items.length) throw new PublicError("Add at least one item.");

  const subtotal = items.reduce((n, i) => n + Number(i.quantity) * Number(i.unit_price_cents), 0);
  const tax = Math.round(subtotal * TAX_RATE / 100);
  const total = subtotal + tax;
  const pay = String(o.payment ?? "unpaid");
  const deposit = pay === "deposit" ? Math.max(0, Math.min(total, Math.round(Number(o.deposit_cents) || 0))) : 0;
  const paid = pay === "paid" ? total : deposit;
  const payment_status = pay === "paid" ? "paid" : deposit > 0 ? "partial" : "unpaid";

  const photo = PHOTO_RE.test(String(b.photo ?? "")) ? String(b.photo) : null;
  const index = Math.max(0, Math.min(9, Math.round(Number(b.index) || 0)));
  const ref = photo ? `${photo}#${index}` : /^[0-9a-f-]{36}$/.test(String(b.ref ?? "")) ? `typed:${b.ref}` : null;
  const ticket = clip(String(o.ticket ?? "").replace(/[^A-Za-z0-9-]/g, ""), 20) || null;
  const delivery = o.fulfillment === "delivery";

  if (ref) {   // a second tap on the same form returns the order the first tap made
    const { data: again } = await admin.from("preorders").select("id,customer_name,pickup_at,total_cents,loc_slug")
      .eq("form_ref", ref).maybeSingle();
    if (again) return { ok: true, preorder: again, again: true };
  }
  if (ticket && b.force !== true) {
    const { data: dup } = await admin.from("preorders").select("id,customer_name,pickup_at,status")
      .eq("loc_slug", loc).eq("square_ticket_no", ticket).neq("status", "canceled").limit(1);
    if (dup?.length) return { ok: false, duplicate: dup[0] };
  }

  const row = {
    customer_name: name,
    customer_phone: clip(o.phone, 30) || null,
    pickup_at: pickupAt,
    notes: clipText(o.notes, 1500) || null,
    items,
    subtotal_cents: subtotal,
    tax_cents: tax,
    total_cents: total,
    deposit_cents: deposit,
    paid_cents: paid,
    status: "confirmed",
    payment_status,
    created_by: ("order-form · " + emp.name).slice(0, 80),
    loc_slug: loc,
    square_location_id: LOCS[loc].square,
    source: photo ? "photo" : "form",
    square_ticket_no: ticket,
    fulfillment: delivery ? "delivery" : "pickup",
    delivery_address: delivery ? clip(o.address, 200) || null : null,
    taken_by: clip(o.taken_by, 60) || null,
    form_photo_path: photo,
    form_ref: ref,
  };
  const { data: saved, error } = await admin.from("preorders").insert(row)
    .select("id,customer_name,pickup_at,total_cents,loc_slug").single();
  if (error) {
    if (ref && /duplicate key|form_ref/i.test(error.message)) {
      const { data: again } = await admin.from("preorders").select("id,customer_name,pickup_at,total_cents,loc_slug")
        .eq("form_ref", ref).maybeSingle();
      if (again) return { ok: true, preorder: again, again: true };
    }
    throw new Error("save: " + error.message);
  }
  const readId = String(b.read_id ?? "");
  if (/^[0-9a-f-]{36}$/.test(readId)) {
    const { data: r } = await admin.from("order_photo_reads").select("preorder_ids").eq("id", readId).maybeSingle();
    if (r) await admin.from("order_photo_reads").update({ preorder_ids: [...(r.preorder_ids ?? []), saved.id] }).eq("id", readId);
  }
  return { ok: true, preorder: saved };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !ORIGIN_OK(origin)) return json(req, { ok: false, error: "Not allowed" }, 403);
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(b.action ?? "");
    if (action === "menu") return json(req, menu());
    if (action === "read") return json(req, await read(b));
    if (action === "create") return json(req, await create(b));
    return json(req, { ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof PublicError) return json(req, { ok: false, error: e.message }, e.status);
    const ref = crypto.randomUUID().slice(0, 8);
    console.error("order-photo", ref, e);
    return json(req, { ok: false, error: "Something went wrong — try again. (ref " + ref + ")" }, 500);
  }
});
