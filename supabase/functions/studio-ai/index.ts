// studio-ai — Magic Write for GREYS Studio (staff.greyscheese.com/studio/), the in-house design tool.
//
// Maverick, 2026-11-14: "do you think you could build me my own version of canva?" then "Yes, add it to the portal".
// The Text panel's Magic Write asks for three headline ideas for a design, or rewrites the selected text
// (shorter, more fun, fancier, fix spelling). The page builds the request text; this function adds the GREYS voice,
// asks Claude for JSON in a fixed shape and hands it back.
//
// POST { kind: "ideas" | "rewrite", prompt } -> { ok: true, data }
//   ideas   -> data = { options: [{ headline, sub, details }] }
//   rewrite -> data = { text }
// POST { kind: "cheese-card", cheese: { name, marketing_name } } -> { ok: true, data }
//   Maverick, 2026-11-15: "anytime we put a new cheese into the system it also generates that card".
//   Cheese Entry (manager.html) calls this after saving a cheese; Claude looks the cheese up on the web and fills the
//   counter card: data = { found, title, sub, origin, milk, treat, desc, note, sources[] }. The page lays the card out
//   with studio/js/cards.js and saves it to studio_designs. Model CARD_MODEL (default claude-sonnet-5-5) with the
//   web search tool; 120 an hour per account, 500 a day overall (separate from Magic Write's limits).
// verify_jwt = false. Managers only: the caller's session must pass is_app_admin (same check as class-email).
// Claude through ANTHROPIC_API_KEY (the secret greys-assistant and order-photo use). Model STUDIO_MODEL
// (default claude-haiku-5-5), effort low. Limits via ticket_rate_hit: 60 an hour per account, 600 a day overall.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("STUDIO_MODEL") || "claude-haiku-5-5";
const CARD_MODEL = Deno.env.get("CARD_MODEL") || "claude-sonnet-5-5";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const SYSTEM = "You write short marketing copy for GREYS Fine Cheeses, a cheese shop, sandwich counter and event space in " +
  "Memphis and Nashville, Tennessee (fine cheeses, charcuterie, wine, classes and tastings, catering boards). " +
  "Voice: warm, witty and confident. One cheese pun at most. Never invent prices, dates, times or other facts the request " +
  "does not give. Copy goes on a social post, flyer or sign, so keep it short and easy to read.";

const IDEAS = {
  type: "object",
  properties: {
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { headline: { type: "string" }, sub: { type: "string" }, details: { type: "string" } },
        required: ["headline", "sub", "details"],
        additionalProperties: false,
      },
    },
  },
  required: ["options"],
  additionalProperties: false,
};
const REWRITE = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

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

// ---------- auth + limits ----------
async function manager(req: Request): Promise<string | null> {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === ANON) return null;
  const user = createClient(SUPABASE_URL, ANON || SERVICE, { global: { headers: { Authorization: "Bearer " + tok } }, auth: { persistSession: false } });
  const { data, error } = await user.rpc("is_app_admin");
  if (error || data !== true) return null;
  const { data: u } = await admin.auth.getUser(tok);
  return u?.user?.email ?? "manager";
}
async function rateOk(bucket: string, limit: number, secs: number) {
  try {
    const { data, error } = await admin.rpc("ticket_rate_hit", { p_bucket: bucket.slice(0, 200), p_limit: limit, p_window_secs: secs });
    return !(!error && data === false);
  } catch (_) {
    return true;
  }
}

// ---------- Claude ----------
async function ask(kind: "ideas" | "rewrite", prompt: string) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: "low", format: { type: "json_schema", schema: kind === "rewrite" ? REWRITE : IDEAS } },
      }),
      signal: ctl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("anthropic " + res.status + ": " + JSON.stringify(j?.error ?? j).slice(0, 300));
    if (j.stop_reason === "refusal") throw new Error("Claude declined that request. Try different wording.");
    const text = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    return { data: JSON.parse(text), usage: j.usage ?? {} };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- cheese counter cards (Cheese Entry) ----------
const CARD_SYSTEM = "You research cheeses for the counter cards at GREYS Fine Cheeses, cheese shops in Memphis and Nashville, " +
  "Tennessee. A counter card is the small printed sign in front of each cheese in the case: its name, one short line " +
  "(maker, age or style), where it is from, the milk, raw or pasteurized, a one-sentence tasting note and the price.\n" +
  "Accuracy comes first: customers rely on the milk and the raw or pasteurized line for allergies and pregnancy. " +
  "Use web search to identify the exact cheese (the maker's or importer's page, a specialty cheese shop or a cheese " +
  "reference) and state only what a source supports. Leave a field empty rather than guess. Register names are often " +
  "ALL CAPS, shortened, misspelled, or carry the maker or importer's name. When you are done, call save_card once.";

const CARD_TOOL = {
  name: "save_card",
  description: "Save the finished counter card. Call it exactly once, after researching.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "true if you identified this exact cheese" },
      title: { type: "string", description: "the cheese's name as customers know it, normal capitalization, about 24 characters at most" },
      sub: { type: "string", description: "one short line: the maker or creamery, the age, or the style; about 28 characters at most" },
      origin: { type: "string", description: "the country; for American cheeses the state" },
      milk: { type: "string", description: "Cow, Goat, Sheep or Buffalo; a blend as 'Sheep & goat' or 'Cow, goat & sheep'; empty if unknown" },
      treat: { type: "string", enum: ["Raw", "Pasteurized", "Thermized", ""], description: "only when a source says so for this cheese as sold in the US; otherwise empty" },
      desc: { type: "string", description: "one appetizing sentence, 60 to 100 characters" },
      note: { type: "string", description: "a few words for staff about anything uncertain; empty if nothing" },
    },
    required: ["found", "title", "sub", "origin", "milk", "treat", "desc", "note"],
    additionalProperties: false,
  },
};

const CARD_EXAMPLES = [
  { title: "1605 Manchego", sub: "La Mancha", origin: "Spain", milk: "Sheep", treat: "Raw", desc: "Raw-milk Manchego with a nutty, buttery bite and a gentle grassy tang." },
  { title: "Alp Blossom", sub: "Hofkäserei Kraus", origin: "Germany", milk: "Cow", treat: "Raw", desc: "Rolled in dried flowers and herbs—a sweet, nutty Alpine cheese as pretty as it tastes." },
  { title: "Balarina", sub: "Aged goat gouda", origin: "Netherlands", milk: "Goat", treat: "Pasteurized", desc: "An aged goat gouda—firm and sweet with notes of caramel and toasted nuts." },
  { title: "Robiola Bosina", sub: "Alta Langa · Piedmont", origin: "Italy", milk: "Cow & sheep", treat: "Pasteurized", desc: "A soft little square of cow and sheep milk—buttery, milky and gently mushroomy." },
  { title: "Linedeline", sub: "Blakesville Creamery", origin: "Wisconsin", milk: "Goat", treat: "", desc: "A goat’s milk take on Morbier with a line of ash—bright, citrusy and a little truffly." },
];

function cardPrompt(name: string, label: string) {
  return "A new cheese was just entered in our register.\n" +
    "Register name: " + JSON.stringify(name) + "\n" +
    (label && label !== name ? "Label name: " + JSON.stringify(label) + "\n" : "") +
    "\nResearch it, then call save_card with:\n" +
    "- title: the cheese's name as customers know it, fixed if the register misspells it. Leave the maker out when it goes in sub.\n" +
    "- sub: the maker or creamery, or the age, or the style (\"Hofkäserei Kraus\", \"Aged 18 months\", \"Aged goat gouda\").\n" +
    "- origin: the country, or the state for an American cheese (\"France\", \"Vermont\", \"Wisconsin\").\n" +
    "- milk: Cow, Goat, Sheep or Buffalo, or a blend written like \"Sheep & goat\".\n" +
    "- treat: Raw, Pasteurized or Thermized only when a source states it for this exact cheese, not just for the maker's cheeses in general; otherwise leave it empty.\n" +
    "- desc: one appetizing sentence of 60 to 100 characters about texture and flavor, maybe one pairing. No prices, no exclamation marks, no \"we\".\n" +
    "- found: false if you could not identify this exact cheese; then fill only what the name makes certain and say what is missing in note.\n" +
    "- note: a few words for staff about anything uncertain, or empty.\n" +
    "\nFinished cards, for the style:\n" + CARD_EXAMPLES.map((x) => JSON.stringify(x)).join("\n");
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const MILK_WORDS: Record<string, string> = { cow: "cow", cows: "cow", goat: "goat", goats: "goat", sheep: "sheep", ewe: "sheep", buffalo: "buffalo", "water buffalo": "buffalo" };
function milkOf(v: unknown) {
  const s = clip(v, 40).toLowerCase().replace(/['’]s\b/g, "").replace(/\bmilk\b/g, "").trim();
  if (!s) return "";
  const parts = s.split(/\s*(?:,|&|\band\b|\+|\/)\s*/).map((p) => MILK_WORDS[p.trim()] ?? "").filter(Boolean);
  const uniq = [...new Set(parts)];
  if (!uniq.length) return "";
  if (uniq.length === 1) return uniq[0][0].toUpperCase() + uniq[0].slice(1);
  const words = uniq.join(", ").replace(/, ([^,]+)$/, " & $1");
  return words[0].toUpperCase() + words.slice(1);
}
function treatOf(v: unknown) {
  const s = clip(v, 30).toLowerCase();
  if (/^raw/.test(s)) return "Raw";
  if (/^pasteuri[sz]ed/.test(s)) return "Pasteurized";
  if (/^thermi[sz]ed/.test(s)) return "Thermized";
  return "";
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-'’(])([a-zà-ÿ])/g, (_m, a, b) => a + b.toUpperCase());

async function researchCheese(name: string, label: string) {
  const deadline = Date.now() + 110_000;
  const messages: any[] = [{ role: "user", content: cardPrompt(name, label) }];
  const sources: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, searches: 0 };
  for (let round = 0; round < 6; round++) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    let j: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: CARD_MODEL,
          max_tokens: 6000,
          system: CARD_SYSTEM,
          messages,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, CARD_TOOL],
          output_config: { effort: "medium" },
        }),
        signal: ctl.signal,
      });
      j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("anthropic " + res.status + ": " + JSON.stringify(j?.error ?? j).slice(0, 300));
    } finally {
      clearTimeout(timer);
    }
    usage.input_tokens += j.usage?.input_tokens ?? 0;
    usage.output_tokens += j.usage?.output_tokens ?? 0;
    usage.searches += j.usage?.server_tool_use?.web_search_requests ?? 0;
    if (j.stop_reason === "refusal") throw new Error("Claude declined to research this cheese.");
    const content: any[] = j.content ?? [];
    for (const b of content) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r?.url && sources.length < 8 && !sources.includes(r.url)) sources.push(r.url);
      }
    }
    const call = content.find((b) => b.type === "tool_use" && b.name === "save_card");
    if (call) {
      const x = call.input ?? {};
      const fallback = titleCase(clip(label || name, 40));
      const data = {
        found: x.found === true,
        title: clip(x.title, 40) || fallback,
        sub: clip(x.sub, 44),
        origin: clip(x.origin, 32),
        milk: milkOf(x.milk),
        treat: treatOf(x.treat),
        desc: clip(x.desc, 160),
        note: clip(x.note, 200),
        sources: sources.slice(0, 5),
      };
      return { data, usage };
    }
    // a long search can pause the turn: hand it back as is and let Claude carry on
    messages.push({ role: "assistant", content });
    if (j.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Now call save_card with the finished card." });
  }
  throw new Error("no card came back in time");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const who = await manager(req);
  if (!who) return json(req, { ok: false, error: "Sign in as a manager to use Magic Write." }, 401);
  if (!KEY) return json(req, { ok: false, error: "Magic Write isn't set up yet (no Anthropic key)." }, 503);
  const b: any = await req.json().catch(() => ({}));
  if (b.kind === "cheese-card") {
    const name = clip(b.cheese?.name, 120), label = clip(b.cheese?.marketing_name, 120);
    if (!name && !label) return json(req, { ok: false, error: "Which cheese? No name came with the request." }, 400);
    if (!(await rateOk("studio-card:" + who, 120, 3600)) || !(await rateOk("studio-card:all", 500, 86400))) {
      return json(req, { ok: false, error: "Too many cards at once. Try again in a few minutes." }, 429);
    }
    const t0 = Date.now();
    try {
      const { data, usage } = await researchCheese(name || label, label);
      console.log(JSON.stringify({ fn: "studio-ai", who, kind: "cheese-card", name, ms: Date.now() - t0, in: usage.input_tokens, out: usage.output_tokens, searches: usage.searches, found: data.found }));
      return json(req, { ok: true, data });
    } catch (e) {
      console.error("studio-ai", who, "cheese-card", name, String(e));
      return json(req, { ok: false, error: "The cheese lookup didn't answer. Try again." }, 502);
    }
  }
  const kind = b.kind === "rewrite" ? "rewrite" : "ideas";
  const prompt = String(b.prompt ?? "").replace(/\u0000/g, "").trim().slice(0, 8000);
  if (!prompt) return json(req, { ok: false, error: "Nothing to write about." }, 400);
  if (!(await rateOk("studio-ai:" + who, 60, 3600)) || !(await rateOk("studio-ai:all", 600, 86400))) {
    return json(req, { ok: false, error: "Magic Write is busy. Try again in a few minutes." }, 429);
  }
  const t0 = Date.now();
  try {
    const { data, usage } = await ask(kind, prompt);
    console.log(JSON.stringify({ fn: "studio-ai", who, kind, ms: Date.now() - t0, in: usage.input_tokens, out: usage.output_tokens }));
    return json(req, { ok: true, data });
  } catch (e) {
    console.error("studio-ai", who, kind, String(e));
    return json(req, { ok: false, error: "Magic Write didn't answer. Try again." }, 502);
  }
});
