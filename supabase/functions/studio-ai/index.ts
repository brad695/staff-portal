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
// verify_jwt = false. Managers only: the caller's session must pass is_app_admin (same check as class-email).
// Claude through ANTHROPIC_API_KEY (the secret greys-assistant and order-photo use). Model STUDIO_MODEL
// (default claude-haiku-5-5), effort low. Limits via ticket_rate_hit: 60 an hour per account, 600 a day overall.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("STUDIO_MODEL") || "claude-haiku-5-5";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const who = await manager(req);
  if (!who) return json(req, { ok: false, error: "Sign in as a manager to use Magic Write." }, 401);
  if (!KEY) return json(req, { ok: false, error: "Magic Write isn't set up yet (no Anthropic key)." }, 503);
  const b: any = await req.json().catch(() => ({}));
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
