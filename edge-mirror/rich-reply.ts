// rich-reply — staff replies written in the manager console's reply editor (2026-11-17, Maverick:
// "when replying we need a full editor, add file, add link etc.").
//
// Shared by the catering and inquiries functions: both import "./rich-reply.ts", so the commit the
// deployed loaders are pinned to carries one copy. Nothing here touches Deno or imports anything —
// the caller hands its Supabase admin client in — so tests/test-rich-reply.mjs runs this file in Node.
//
// A reply is { html?, body?, attachments? }:
//   html         what the editor holds. NEVER trusted: sanitize() keeps a short list of tags, a few
//                inline styles (color, size, bold / italic / underline, alignment), http(s) / mailto / tel
//                links, and images that live in this project's public "lead-files" bucket. Nothing else.
//   body         plain text — a reply from an older page (or anything that isn't the editor). Sent as before.
//   attachments  [{ path, name }] — files the editor already uploaded to lead-files under the lead's own
//                folder ("cat/<lead id>/…" or "inq/<inquiry id>/…"). Size and type come from Storage,
//                not from the browser.
// What goes out: the formatted message in the brand shell + an "Attachments" box that links every file.
// PDFs, images, text, CSV and calendar files also ride as real attachments (send-mail's rules: 3 files,
// 12 MB together here); anything else — Word, Excel, a big file — is the download link only.
// What is stored on the message row: body = plain text (Greys Chat, previews and the booking-link check
// read it), body_html = the sanitized HTML, attachments = [{ name, url, path, size, type, sent }].

export const LEAD_BUCKET = "lead-files";
export class ReplyError extends Error {}

const NAVY = "#06273A", GOLD = "#e6b33c", MUTE = "#6E6353", CREAM = "#F6F1E7", LINE = "#E6DFD0";
const MAX_HTML = 120_000, MAX_STORED = 60_000, MAX_TEXT = 20_000, MAX_DEPTH = 40, MAX_IMGS = 12, MAX_FILES = 10;
const BODY_WIDTH = 536; // the brand shell's text column: 600 − 2 × 32

// ---------- sanitizer ----------
const VOID = new Set(["br", "hr", "img"]);
const RENAME: Record<string, string> = { strong: "b", em: "i", strike: "s", del: "s", h1: "h2", h4: "h3", h5: "h3", h6: "h3", font: "span", center: "div" };
const ALLOW = new Set(["b", "i", "u", "s", "sub", "sup", "p", "div", "br", "hr", "ul", "ol", "li", "blockquote", "h2", "h3", "a", "span", "img",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "pre", "code"]);
const STYLED = new Set(["p", "div", "li", "h2", "h3", "td", "th", "span", "blockquote"]);
// their text is never shown, so it goes with the tag
const DROP_CONTENT = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "svg", "math", "noscript", "template", "textarea",
  "select", "canvas", "audio", "video", "applet", "frameset", "xml", "noembed", "noframes"]);
// inline styles for mail clients (they ignore stylesheets); the portal styles the stored HTML with CSS instead
const EMAIL_STYLE: Record<string, string> = {
  a: `color:${NAVY};text-decoration:underline`,
  p: "margin:0 0 12px",
  h2: `margin:16px 0 8px;font-size:22px;line-height:1.3;color:${NAVY}`,
  h3: `margin:14px 0 6px;font-size:18px;line-height:1.3;color:${NAVY}`,
  ul: "margin:8px 0;padding-left:26px", ol: "margin:8px 0;padding-left:26px", li: "margin:2px 0",
  blockquote: `margin:10px 0;padding:2px 0 2px 14px;border-left:3px solid ${GOLD};color:${MUTE}`,
  hr: `border:0;border-top:1px solid ${LINE};margin:16px 0`,
  img: "max-width:100%;height:auto;border:0",
  table: "border-collapse:collapse;margin:10px 0",
  td: `border:1px solid ${LINE};padding:6px 10px;vertical-align:top`,
  th: `border:1px solid ${LINE};padding:6px 10px;text-align:left;background:${CREAM}`,
  pre: `white-space:pre-wrap;font:13px/1.5 Consolas,Menlo,monospace;background:${CREAM};padding:10px 12px;margin:10px 0`,
  code: "font:13px Consolas,Menlo,monospace",
};
// comment · doctype / conditional · a pasted picture that is its own data (dropped whole) · a tag.
// Every piece stops at the next "<" and quoted values are capped, so junk input can't make this crawl.
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^<>]*>|<img\b[^<>]{0,400}?\bsrc\s*=\s*["']?data:[^"'<>]*["']?[^<>]{0,2000}>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]{0,8192}"|'[^']{0,8192}'|[^'"<>])*)>/g;
const ENTITY_OK = /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});)/g;
const URL_IN_TEXT = /https?:\/\/(?:(?!&nbsp;|&lt;|&gt;|&quot;|&#39;|&#x27;)[^\s<>"'])+/gi;
const COLOR = /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
const FONT_SIZES = [0, 11, 13, 0, 18, 22, 28, 34]; // <font size="1…7">; 3 is the normal size
const SIZE_WORDS: Record<string, number> = { "xx-small": 10, "x-small": 11, small: 13, smaller: 13, medium: 0, large: 18, larger: 18, "x-large": 22, "xx-large": 28, "xxx-large": 34 };

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) { const k = m[1].toLowerCase(); if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? ""; }
  return out;
}
function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function cp(n: number) { try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; } catch { return ""; } }

function fontPx(v: string): number {
  if (v in SIZE_WORDS) return SIZE_WORDS[v];
  let m = /^(\d{1,3}(?:\.\d+)?)px$/.exec(v);
  let px = m ? Number(m[1]) : 0;
  if (!m && (m = /^(\d{1,2}(?:\.\d+)?)pt$/.exec(v))) px = Number(m[1]) * 4 / 3;
  px = Math.round(px);
  return px >= 9 && px <= 40 && px !== 16 ? px : 0;
}
function cleanStyle(raw: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const decl of decodeEntities(raw).split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, "");
    let d = "";
    if (k === "color" && COLOR.test(v)) d = "color:" + v.replace(/\s+/g, "");
    else if (k === "font-size") { const px = fontPx(v); if (px) d = `font-size:${px}px`; }
    else if (k === "font-weight" && /^(?:bold|bolder|[6-9]00)$/.test(v)) d = "font-weight:bold";
    else if (k === "font-style" && v === "italic") d = "font-style:italic";
    else if (k === "text-decoration" || k === "text-decoration-line") {
      const hit = [...new Set(v.match(/\b(?:underline|line-through)\b/g) || [])];
      if (hit.length) d = "text-decoration:" + hit.join(" ");
    } else if (k === "text-align" && /^(?:center|right|justify)$/.test(v)) d = "text-align:" + v;
    const key = d.slice(0, d.indexOf(":"));
    if (d && !seen.has(key)) { seen.add(key); out.push(d); }
  }
  return out.join(";");
}
// The scheme has to be there in plain letters, so an entity can't smuggle another one in; every "&" goes out as "&amp;".
function cleanHref(v: string): string {
  let s = String(v ?? "").trim().replace(/&amp;/gi, "&");
  if (/^www\.[^\s.]+\.\S/i.test(s)) s = "https://" + s;
  if (/^https?:\/\/[^\s"'<>\\^`{|}]+$/i.test(s) || /^mailto:[^\s"'<>\\^`{|}]+@[^\s"'<>\\^`{|}]+$/i.test(s) || /^tel:\+?[\d\s().-]{5,24}$/i.test(s)) {
    return s.replace(/&/g, "&amp;");
  }
  return "";
}

export type SanitizeOpt = { imgPrefix?: string; email?: boolean };

export function sanitize(html: unknown, opt: SanitizeOpt = {}): string {
  const src = String(html ?? "").slice(0, MAX_HTML).replace(/\u0000/g, "");
  const email = !!opt.email, imgPrefix = String(opt.imgPrefix || "");
  let out = "", last = 0, skip = "", imgs = 0;
  const stack: { tag: string; emit: boolean }[] = [];
  const inLink = () => stack.some((e) => e.tag === "a" && e.emit);
  const open = (tag: string, attrs: string, style: string) => {
    const st = [email ? EMAIL_STYLE[tag] || "" : "", style].filter(Boolean).join(";");
    return `<${tag}${attrs}${st ? ` style="${st}"` : ""}>`;
  };
  const closeTo = (i: number) => { while (stack.length > i) { const e = stack.pop()!; if (e.emit) out += `</${e.tag}>`; } };
  const text = (t: string) => {
    if (skip || !t) return;
    const s = t.replace(ENTITY_OK, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (inLink()) { out += s; return; }
    // a web address typed as plain text becomes a link (the old plain reply box did the same)
    out += s.replace(URL_IN_TEXT, (u) => {
      const tail = /[.,;:!?)\]]+$/.exec(u)?.[0] || "";
      const url = tail ? u.slice(0, -tail.length) : u;
      const href = cleanHref(url);
      return href ? `${open("a", ` href="${href}"`, "")}${url}</a>${tail}` : u;
    });
  };
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src))) {
    text(src.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[2] === undefined) continue; // comment, doctype
    const close = m[1] === "/", raw = m[2].toLowerCase(), rawAttrs = m[3] || "";
    if (skip) { if (close && raw === skip) skip = ""; continue; }
    if (DROP_CONTENT.has(raw)) { if (!close && !/\/\s*$/.test(rawAttrs)) skip = raw; continue; }
    const tag = RENAME[raw] || raw;
    if (!ALLOW.has(tag)) continue;
    if (close) {
      if (VOID.has(tag)) continue;
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i >= 0) closeTo(i);
      continue;
    }
    if (tag === "br") { out += "<br>"; continue; }
    if (tag === "hr") { out += open("hr", "", ""); continue; }
    const at = parseAttrs(rawAttrs);
    if (tag === "img") {
      const s = String(at.src || "").trim().replace(/&amp;/gi, "&");
      if (imgPrefix && s.startsWith(imgPrefix) && /^[\w\-.~:/%+,@=()]+$/.test(s) && !s.includes("..") && imgs < MAX_IMGS) {
        imgs++;
        const w = Math.round(Number(at.width));
        const alt = decodeEntities(at.alt || "").replace(/[<>"&\r\n]+/g, " ").trim().slice(0, 150);
        out += open("img", ` src="${s}" alt="${alt}"${w >= 16 && w <= 2400 ? ` width="${Math.min(w, BODY_WIDTH)}"` : ""}`, "");
      }
      continue;
    }
    if (stack.length >= MAX_DEPTH) continue;
    if (tag === "a") {
      const i = stack.findIndex((e) => e.tag === "a");
      if (i >= 0) closeTo(i); // no link inside a link
      const href = cleanHref(at.href || "");
      if (href) out += open("a", ` href="${href}"`, "");
      stack.push({ tag, emit: !!href });
      continue;
    }
    let style = STYLED.has(tag) ? cleanStyle(at.style || "") : "";
    if (raw === "font") {
      const extra: string[] = [];
      const c = String(at.color || "").trim().toLowerCase();
      if (COLOR.test(c) && !/(?:^|;)color:/.test(style)) extra.push("color:" + c);
      const px = FONT_SIZES[Number(at.size)] || 0;
      if (px && !/font-size:/.test(style)) extra.push(`font-size:${px}px`);
      style = [style, ...extra].filter(Boolean).join(";");
    }
    if (raw === "center" && !/text-align:/.test(style)) style = [style, "text-align:center"].filter(Boolean).join(";");
    if (STYLED.has(tag) && tag !== "span" && !/text-align:/.test(style) && /^(?:center|right|justify)$/i.test(at.align || "")) {
      style = [style, "text-align:" + at.align.toLowerCase()].filter(Boolean).join(";");
    }
    if (tag === "span" && !style) { stack.push({ tag, emit: false }); continue; } // a span that carries nothing
    let attrs = "";
    if (tag === "td" || tag === "th") {
      for (const k of ["colspan", "rowspan"]) { const n = Math.round(Number(at[k])); if (n >= 2 && n <= 20) attrs += ` ${k}="${n}"`; }
    }
    out += open(tag, attrs, style);
    stack.push({ tag, emit: true });
  }
  text(src.slice(last));
  closeTo(0);
  return trimEdges(out);
}
// blank lines the editor leaves at the top and bottom
const BLANK_HEAD = /^(?:\s|&nbsp;|<br>|<(div|p)(?: style="[^"]*")?>(?:\s|&nbsp;|<br>)*<\/\1>)+/;
const BLANK_BLOCK = /^<(div|p)(?: style="[^"]*")?>(?:\s|&nbsp;|<br>)*<\/\1>$/;
function trimEdges(h: string): string {
  h = h.replace(BLANK_HEAD, "");
  for (;;) { // the tail, one blank piece at a time (a "$"-anchored pattern would rescan the whole message)
    let e = h.length;
    while (e > 0 && /\s/.test(h[e - 1])) e--;
    if (h.endsWith("&nbsp;", e)) { h = h.slice(0, e - 6); continue; }
    if (h.endsWith("<br>", e)) { h = h.slice(0, e - 4); continue; }
    const tag = h.endsWith("</div>", e) ? "div" : h.endsWith("</p>", e) ? "p" : "";
    const at = tag ? h.lastIndexOf("<" + tag, e - 1) : -1;
    if (at >= 0 && BLANK_BLOCK.test(h.slice(at, e))) { h = h.slice(0, at); continue; }
    return h.slice(0, e);
  }
}

// ---------- plain text (the message row's body) ----------
const BLOCKS = new Set(["p", "div", "li", "h2", "h3", "blockquote", "tr", "pre", "ul", "ol", "table", "thead", "tbody", "tfoot"]);
const SPACED = new Set(["p", "h2", "h3", "blockquote", "table", "pre"]); // a blank line after these

export function htmlToText(safe: string): string {
  const toks = String(safe ?? "").split(/(<[^>]+>)/).filter((t) => t !== "");
  let out = "", gap = false, pre = 0, href = "", linkAt = -1, afterLink = false;
  const lists: { ol: boolean; n: number }[] = [];
  const cells: number[] = [];
  const nl = () => { if (out && !out.endsWith("\n")) out += "\n"; };
  const put = (s: string) => {
    if (!s) return;
    if (gap) { if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n"; gap = false; }
    if (afterLink) { if (!/^\s/.test(s)) out += " "; afterLink = false; }
    out += s;
  };
  const lineHasText = () => /\S/.test(out.slice(out.lastIndexOf("\n") + 1));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t[0] !== "<") {
      if (pre) { put(t); continue; }
      let s = t.replace(/[\t\n\r ]+/g, " ");
      if (!out || out.endsWith("\n") || gap) s = s.replace(/^ +/, "");
      put(s);
      continue;
    }
    const m = /^<(\/?)([a-z0-9]+)/.exec(t);
    if (!m) continue;
    const close = m[1] === "/", tag = m[2];
    if (tag === "br") {
      const next = toks[i + 1] || "";
      const endsBlock = /^<\/(?:p|div|li|h2|h3|blockquote|td|th)>/.test(next);
      if (!(endsBlock && lineHasText())) { afterLink = false; out += "\n"; }
      continue;
    }
    if (tag === "hr") { nl(); put("----------"); nl(); continue; }
    if (tag === "img") { put("[image]"); continue; }
    if (tag === "a") {
      if (!close) { href = decodeEntities(/href="([^"]*)"/.exec(t)?.[1] || ""); linkAt = out.length; continue; }
      if (linkAt >= 0 && href) {
        const label = decodeEntities(out.slice(linkAt)).replace(/ /g, " ").trim();
        const shown = href.replace(/^mailto:|^tel:/i, "");
        const same = (x: string, y: string) => x.replace(/\/+$/, "").toLowerCase() === y.replace(/\/+$/, "").toLowerCase();
        if (!label) put(shown);
        else if (!same(label, href) && !same(label, shown) && !label.includes(shown)) out += ": " + shown;
        afterLink = /^https?:/i.test(href); // a space before whatever follows keeps the address clean when the text is auto-linked again
      }
      href = ""; linkAt = -1;
      continue;
    }
    if (tag === "td" || tag === "th") {
      if (!close) { const n = cells.length - 1; if (n >= 0) { if (cells[n] > 0) put(" | "); cells[n]++; } }
      continue;
    }
    if (!BLOCKS.has(tag)) continue;
    afterLink = false;
    if (!close) {
      nl();
      if (tag === "ul" || tag === "ol") lists.push({ ol: tag === "ol", n: 0 });
      else if (tag === "tr") cells.push(0);
      else if (tag === "pre") pre++;
      else if (tag === "li") {
        const l = lists[lists.length - 1];
        put("  ".repeat(Math.max(0, lists.length - 1)) + (l && l.ol ? `${++l.n}. ` : "• "));
      }
    } else {
      nl();
      if (tag === "ul" || tag === "ol") { lists.pop(); if (!lists.length) gap = true; }
      else if (tag === "tr") cells.pop();
      else if (tag === "pre") pre = Math.max(0, pre - 1);
      if (SPACED.has(tag)) gap = true;
    }
  }
  return decodeEntities(out).replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
}

// plain text → the same HTML the old reply box sent
const escHtml = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export const plainToHtml = (s: string) => `<p>${escHtml(s).replace(/\r?\n/g, "<br>").replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`;

// ---------- files ----------
export type LeadFile = { name: string; url: string; path: string; size: number; type: string; sent: "attached" | "link" };
// what send-mail will carry as a real attachment
const ATTACH_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "text/plain", "text/csv", "text/calendar"]);
const ATTACH_MAX_FILES = 3, ATTACH_MAX_BYTES = 12 * 1024 * 1024;
const PATH_RE = /^(?:cat|inq)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9]{12,40}\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export const publicBase = (sbUrl: string) => String(sbUrl || "").replace(/\/+$/, "") + `/storage/v1/object/public/${LEAD_BUCKET}/`;
export const fmtSize = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

// The editor's uploads, checked against Storage. `prefix` is the lead's own folder — a path outside it is refused.
export async function resolveFiles(admin: any, sbUrl: string, prefix: string, raw: unknown): Promise<LeadFile[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ReplyError("Attachments must be a list.");
  if (raw.length > MAX_FILES) throw new ReplyError(`That's too many files — ${MAX_FILES} at most.`);
  const out: LeadFile[] = [];
  const seen = new Set<string>();
  for (const a of raw as Array<Record<string, unknown> | null>) {
    const path = String(a?.path ?? "");
    if (!PATH_RE.test(path) || !path.startsWith(prefix) || path.includes("..")) throw new ReplyError("One of the files doesn't belong to this conversation — remove it and add it again.");
    if (seen.has(path)) continue;
    seen.add(path);
    const cut = path.lastIndexOf("/"), folder = path.slice(0, cut), file = path.slice(cut + 1);
    const { data, error } = await admin.storage.from(LEAD_BUCKET).list(folder, { limit: 20 });
    const obj = !error && Array.isArray(data) ? data.find((o: any) => o?.name === file) : null;
    if (!obj) throw new ReplyError("One of the files didn't finish uploading — remove it and add it again.");
    const size = Number(obj.metadata?.size ?? obj.metadata?.contentLength ?? 0) || 0;
    if (size <= 0) throw new ReplyError(`${file} is empty — remove it and add it again.`);
    const type = String(obj.metadata?.mimetype || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const name = String(a?.name ?? "").replace(/[\u0000-\u001f\u007f<>"\\/|*?]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || file;
    out.push({ name, url: publicBase(sbUrl) + path, path, size, type, sent: "link" });
  }
  // real attachments, in the order they were added, while they fit
  let n = 0, total = 0;
  for (const f of out) {
    if (ATTACH_TYPES.has(f.type) && n < ATTACH_MAX_FILES && total + f.size <= ATTACH_MAX_BYTES) { f.sent = "attached"; n++; total += f.size; }
  }
  return out;
}

export function filesHtml(files: LeadFile[]): string {
  if (!files.length) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0 0;border-collapse:separate"><tr>
    <td style="background:${CREAM};border:1px solid ${LINE};padding:12px 14px;font:14px/1.6 Arial,sans-serif;color:#221E1B">
      <div style="font:700 11px/1.4 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${MUTE};margin-bottom:4px">${files.length === 1 ? "Attachment" : "Attachments"}</div>
      ${files.map((f) => `<div>&#128206; <a href="${escHtml(f.url)}" style="color:${NAVY};text-decoration:underline">${escHtml(f.name)}</a> <span style="color:${MUTE};font-size:12px">(${fmtSize(f.size)})</span></div>`).join("\n      ")}
    </td></tr></table>`;
}
export const filesText = (files: LeadFile[]) => files.length ? files.map((f) => `📎 ${f.name} — ${f.url}`).join("\n") : "";
// what send-mail attaches: public files in this project's Storage, fetched by URL
export const mailAttachments = (files: LeadFile[]) => files.filter((f) => f.sent === "attached").map((f) => ({ filename: f.name, mimetype: f.type, url: f.url }));

// ---------- one reply ----------
export type Reply = {
  body: string;            // plain text for the message row (with a "📎 name — link" line per file)
  html: string | null;     // sanitized HTML for the message row; null when the reply was plain text
  inner: string;           // what goes inside the email shell
  files: LeadFile[];
};
export async function buildReply(admin: any, sbUrl: string, prefix: string, b: Record<string, unknown>): Promise<Reply> {
  const files = await resolveFiles(admin, sbUrl, prefix, b.attachments);
  const imgPrefix = publicBase(sbUrl) + prefix;
  const rawHtml = typeof b.html === "string" ? b.html : "";
  const plain = String(b.body ?? "").trim().slice(0, 8000);
  const tooLong = () => new ReplyError("That message is too long — trim it down or put the long part in a file.");
  if (rawHtml.length > MAX_HTML) throw tooLong();
  let html = rawHtml ? sanitize(rawHtml, { imgPrefix }) : "";
  let text = html ? htmlToText(html) : "";
  if (html && !text) html = ""; // nothing but blank lines
  if (html.length > MAX_STORED) throw tooLong();
  if (!html && !plain && !files.length) throw new ReplyError("Type a message first.");
  let inner: string;
  if (html) inner = `<div>${sanitize(rawHtml, { imgPrefix, email: true })}</div>`;
  else { text = plain; inner = plain ? plainToHtml(plain) : ""; }
  const list = filesText(files);
  return { body: [text, list].filter(Boolean).join("\n\n"), html: html || null, inner: inner + filesHtml(files), files };
}
