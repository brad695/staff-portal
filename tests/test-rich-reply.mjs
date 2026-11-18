/*
 * edge-mirror/rich-reply.ts — the reply editor's server side (2026-11-17): what the sanitizer keeps and
 * throws away, the plain-text copy, which files ride as real attachments, and what one reply turns into.
 * Runs the real file in Node (it imports nothing). Storage is a stand-in.
 * Run: node tests/test-rich-reply.mjs
 */
import { sanitize, htmlToText, plainToHtml, resolveFiles, filesHtml, filesText, mailAttachments, buildReply, publicBase, fmtSize, ReplyError, LEAD_BUCKET } from "../edge-mirror/rich-reply.ts";

let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) { ok++; console.log("  ✓ " + name); } else { bad++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 600) : "")); } };
const eq = (name, got, want) => t(name, got === want, { got, want });

const SB = "https://proj.supabase.co";
const LEAD = "11111111-2222-3333-4444-555555555555", OTHER = "99999999-2222-3333-4444-555555555555";
const PREFIX = `cat/${LEAD}/`;
const BASE = publicBase(SB);
const IMG = BASE + PREFIX;
const S = (h, email) => sanitize(h, { imgPrefix: IMG, email });

console.log("\nsanitize · what the editor writes is kept");
eq("bold / italic / underline / strike", S("<b>a</b><i>b</i><u>c</u><strike>d</strike><strong>e</strong><em>f</em>"), "<b>a</b><i>b</i><u>c</u><s>d</s><b>e</b><i>f</i>");
eq("lines the editor makes", S("Hi Jane,<div><br></div><div>Thanks for reaching out!</div>"), "Hi Jane,<div><br></div><div>Thanks for reaching out!</div>");
eq("lists", S("<ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>"), "<ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>");
eq("a link", S('<a href="https://greyscheese.com/menu?a=1&amp;b=2">our menu</a>'), '<a href="https://greyscheese.com/menu?a=1&amp;b=2">our menu</a>');
eq("mailto and tel links", S('<a href="mailto:info@greyscheese.com">email</a> <a href="tel:+1 (901) 440-4739">call</a>'),
  '<a href="mailto:info@greyscheese.com">email</a> <a href="tel:+1 (901) 440-4739">call</a>');
eq("www. gets https://", S('<a href="www.greyscheese.com/x">x</a>'), '<a href="https://www.greyscheese.com/x">x</a>');
eq("text color (execCommand foreColor)", S('<font color="#b91c1c">red</font>'), '<span style="color:#b91c1c">red</span>');
eq("text size (execCommand fontSize)", S('<font size="5">big</font><font size="2">small</font><font size="3">normal</font>'),
  '<span style="font-size:22px">big</span><span style="font-size:13px">small</span>normal');
eq("alignment", S('<div style="text-align: center;">mid</div><div align="right">r</div><div style="text-align:left">l</div>'),
  '<div style="text-align:center">mid</div><div style="text-align:right">r</div><div>l</div>');
eq("quote + headings", S("<blockquote>q</blockquote><h1>A</h1><h3>B</h3><h5>C</h5>"), "<blockquote>q</blockquote><h2>A</h2><h3>B</h3><h3>C</h3>");
eq("a table (pasted from a sheet)", S('<table border="1" class="x"><tbody><tr><th>Item</th><td colspan="2" onclick="x()">Board</td></tr></tbody></table>'),
  '<table><tbody><tr><th>Item</th><td colspan="2">Board</td></tr></tbody></table>');
eq("an image from this lead's folder", S(`<img src="${IMG}abcdefabcdef1234/board.jpg" alt="The board" width="900" onerror="alert(1)" style="float:left">`),
  `<img src="${IMG}abcdefabcdef1234/board.jpg" alt="The board" width="536">`);

console.log("\nsanitize · everything else goes");
eq("script + its text", S("a<script>alert(1)</script>b<SCRIPT src=x></SCRIPT>c"), "abc");
eq("style, comments, Word leftovers", S("a<style>p{color:red}</style><!-- hi --><xml><o:x>1</o:x></xml><o:p>&nbsp;</o:p>ok<!--[if gte mso 9]>x<![endif]--><!DOCTYPE html><![endif]>b"), "a&nbsp;okb");
eq("a pasted picture that is its own data is dropped whole", S(`a<img alt="x" src="data:image/png;base64,${"QUJD".repeat(20_000)}" width="10">b<img src=data:image/gif;base64,R0lG>c`), "abc");
eq("event handlers and classes", S('<div onclick="x()" class="c" id="i" data-x="1">a</div><b onmouseover=alert(1)>b</b>'), "<div>a</div><b>b</b>");
eq("javascript: link", S('<a href="javascript:alert(1)">x</a>'), "x");
eq("javascript: hidden behind entities", S('<a href="jav&#x61;script:alert(1)">x</a><a href="&#106;avascript:alert(1)">y</a><a href=" java\tscript:alert(1)">z</a>'), "xyz");
eq("data: and vbscript: links", S('<a href="data:text/html,<script>alert(1)</script>">x</a><a href="vbscript:x">y</a>'), "xy");
eq("a quote can't break out of href", S(`<a href='https://x.com/"onmouseover="alert(1)'>x</a>`), "x");
eq("an entity can't break out of href", S('<a href="https://x.com/?q=&#x22;onmouseover=alert(1)">x</a>'), '<a href="https://x.com/?q=&amp;#x22;onmouseover=alert(1)">x</a>');
eq("images from anywhere else", S('<img src="https://evil.example/x.png"><img src="data:image/png;base64,AAAA"><img src=x onerror=alert(1)>'), "");
eq("an image from another lead's folder", S(`<img src="${BASE}cat/${OTHER}/abcdefabcdef1234/x.png">`), "");
eq("an image path that climbs out", S(`<img src="${IMG}../../other/x.png">`), "");
eq("iframe / object / svg / form bits", S('<iframe src="https://x"></iframe><object data="x"></object><svg><script>1</script></svg><input value="v"><button>go</button>ok'), "gook");
eq("styles that aren't on the list", S('<span style="position:fixed;top:0;background:url(javascript:x);color:#fff;font-size:9999px">a</span>'), '<span style="color:#fff">a</span>');
eq("a style value can't carry a second rule", S('<span style="color:red;color:#123456;font-weight:900;font-style:italic;text-decoration:underline line-through">a</span>'),
  '<span style="color:#123456;font-weight:bold;font-style:italic;text-decoration:underline line-through">a</span>');
eq("css expression / url in a color", S('<span style="color:expression(alert(1))">a</span><span style="color:url(x)">b</span>'), "ab");
eq("a tag that never closes is text", S("a <img src=x onerror=alert(1)"), "a &lt;img src=x onerror=alert(1)");
eq("loose < > & are escaped", S("1 < 2 > 0 & more &amp; &copy; &#169; &bogus"), "1 &lt; 2 &gt; 0 &amp; more &amp; &copy; &#169; &amp;bogus");
eq("an unknown tag keeps its text", S("<marquee>hi</marquee><custom-x>there</custom-x>"), "hithere");
t("no on*= or javascript: survives a mixed bag", !/on\w+\s*=|javascript:|<script|<style|<iframe/i.test(
  S('<div style="x:expression(1)" onload=a><a href="JaVaScRiPt:1">q</a><img src="' + IMG + 'aaaaaaaaaaaa/x.png" onload="a()"><p onfocus=a contenteditable>z</p></div>')));

console.log("\nsanitize · structure");
eq("open tags get closed", S("<b>a<i>b"), "<b>a<i>b</i></b>");
eq("a stray close is ignored", S("a</b></div>b"), "ab");
eq("an empty span doesn't close its parent early", S('<span style="color:#ff0000">a<span>b</span>c</span>'), '<span style="color:#ff0000">abc</span>');
eq("no link inside a link", S('<a href="https://a.com">x<a href="https://b.com">y</a></a>'), '<a href="https://a.com">x</a><a href="https://b.com">y</a>');
eq("a dropped link doesn't close the real one", S('<a href="https://a.com">x</a><a href="nope">y</a>z'), '<a href="https://a.com">x</a>yz');
eq("blank lines at the edges are trimmed", S("<div><br></div> &nbsp;<br>Hi<div>there</div><div><br></div><p> </p><br>&nbsp; "), "Hi<div>there</div>");
eq("an empty message is empty", S("<div><br></div><div> &nbsp;</div>"), "");
t("very deep nesting doesn't blow up", S("<div>".repeat(500) + "x" + "</div>".repeat(500)).includes("x"));
t("12 images at most", (S(Array.from({ length: 20 }, (_, i) => `<img src="${IMG}aaaaaaaaaaaa/${i}.png">`).join("")).match(/<img /g) || []).length === 12);

console.log("\nsanitize · web addresses typed as text become links");
eq("a bare address", S("see https://greyscheese.com/catering for more"), 'see <a href="https://greyscheese.com/catering">https://greyscheese.com/catering</a> for more');
eq("the period after it stays outside", S("Book here: https://tickets.greyscheese.com/x?book=1&amp;date=2026-12-05."),
  'Book here: <a href="https://tickets.greyscheese.com/x?book=1&amp;date=2026-12-05">https://tickets.greyscheese.com/x?book=1&amp;date=2026-12-05</a>.');
eq("it stops at &nbsp;", S("https://a.com&nbsp;now"), '<a href="https://a.com">https://a.com</a>&nbsp;now');
eq("an address that is already a link is left alone", S('<a href="https://a.com">https://a.com</a>'), '<a href="https://a.com">https://a.com</a>');

console.log("\nsanitize · email mode adds the inline styles mail clients need");
{
  const e = S(`<a href="https://a.com">x</a><ul><li>one</li></ul><blockquote>q</blockquote><img src="${IMG}aaaaaaaaaaaa/x.png" width="200"><span style="color:#b91c1c">r</span><p>p</p>`, true);
  t("links are navy and underlined", e.includes('<a href="https://a.com" style="color:#06273A;text-decoration:underline">x</a>'), e);
  t("lists are indented", e.includes('<ul style="margin:8px 0;padding-left:26px"><li style="margin:2px 0">one</li></ul>'), e);
  t("quotes get the gold bar", /<blockquote style="[^"]*border-left:3px solid #e6b33c[^"]*">q<\/blockquote>/.test(e), e);
  t("images can't overflow", e.includes(`<img src="${IMG}aaaaaaaaaaaa/x.png" alt="" width="200" style="max-width:100%;height:auto;border:0">`), e);
  t("the picked color still wins", e.includes('<span style="color:#b91c1c">r</span>'), e);
  t("paragraph spacing", e.includes('<p style="margin:0 0 12px">p</p>'), e);
  t("a typed address is styled too", S("https://a.com", true) === '<a href="https://a.com" style="color:#06273A;text-decoration:underline">https://a.com</a>', S("https://a.com", true));
  t("stored copy has none of it", !/style=/.test(S('<a href="https://a.com">x</a><ul><li>one</li></ul><p>p</p>')));
}

console.log("\nhtmlToText · the plain copy");
const T = (h) => htmlToText(S(h));
eq("lines and a blank line", T("Hi Jane,<div><br></div><div>Thanks!</div><div>— GREYS</div>"), "Hi Jane,\n\nThanks!\n— GREYS");
eq("a trailing <br> in a line isn't an extra line", T("<div>a<br></div><div>b</div>"), "a\nb");
eq("<br> inside a line", T("a<br>b<br><br>c"), "a\nb\n\nc");
eq("paragraphs get a blank line", T("<p>one</p><p>two</p>"), "one\n\ntwo");
eq("bullets", T("Options:<ul><li>Pick-up</li><li>Delivery</li></ul>Thanks"), "Options:\n• Pick-up\n• Delivery\n\nThanks");
eq("numbers + nesting", T("<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>"), "1. a\n  • x\n2. b");
eq("a link with its own words", T('You can <a href="https://tickets.greyscheese.com/experiences?book=abc&amp;date=2026-12-05">book here</a> any time.'),
  "You can book here: https://tickets.greyscheese.com/experiences?book=abc&date=2026-12-05 any time.");
eq("a link shown as its address", T('<a href="https://a.com/x?a=1&amp;b=2">https://a.com/x?a=1&amp;b=2</a>.'), "https://a.com/x?a=1&b=2 .");
eq("a typed address", T("see https://a.com/x."), "see https://a.com/x .");
eq("mailto", T('<a href="mailto:info@greyscheese.com">email us</a> or <a href="mailto:info@greyscheese.com">info@greyscheese.com</a>'), "email us: info@greyscheese.com or info@greyscheese.com");
eq("an image", T(`Look:<div><img src="${IMG}aaaaaaaaaaaa/x.png"></div>`), "Look:\n[image]");
eq("a table", T("<table><tr><th>Item</th><th>Price</th></tr><tr><td>Board</td><td>$95</td></tr></table>after"), "Item | Price\nBoard | $95\n\nafter");
eq("entities come back as characters", T("Tom &amp; Jerry &lt;3 &nbsp;caf&eacute; &#8212; ok"), "Tom & Jerry <3  caf&eacute; — ok");
eq("pasted markup whitespace collapses", T("<p>\n   one\n   two\n</p>\n<p>three</p>"), "one two\n\nthree");
eq("bold etc. just drop away", T("<b>Total:</b> <i>$1,250</i>"), "Total: $1,250");
t("the booking link is still findable in the text", /[?&]book=/.test(T('<a href="https://tickets.greyscheese.com/experiences?first=Jane&amp;book=abc">Book &amp; pay</a>')));

console.log("\nfiles · checked against Storage");
const PDF = `${PREFIX}aaaaaaaaaaaaaaaa/Private-Events-Memphis.pdf`, JPG = `${PREFIX}bbbbbbbbbbbbbbbb/board.jpg`, DOCX = `${PREFIX}cccccccccccccccc/menu.docx`,
  BIG = `${PREFIX}dddddddddddddddd/huge.pdf`, P2 = `${PREFIX}eeeeeeeeeeeeeeee/two.png`, P3 = `${PREFIX}ffffffffffffffff/three.png`, EMPTY = `${PREFIX}gggggggggggggggg/empty.pdf`;
const STORE = {
  [PDF]: { size: 2_400_000, mimetype: "application/pdf" }, [JPG]: { size: 800_000, mimetype: "image/jpeg" },
  [DOCX]: { size: 60_000, mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  [BIG]: { size: 11_000_000, mimetype: "application/pdf" }, [P2]: { size: 1000, mimetype: "image/png" }, [P3]: { size: 1000, mimetype: "image/png; charset=binary" },
  [EMPTY]: { size: 0, mimetype: "application/pdf" },
  [`cat/${OTHER}/aaaaaaaaaaaaaaaa/secret.pdf`]: { size: 10, mimetype: "application/pdf" },
};
const lists = [];
const admin = { storage: { from: (b) => ({ list: async (folder) => {
  lists.push([b, folder]);
  return { data: Object.keys(STORE).filter((p) => p.startsWith(folder + "/")).map((p) => ({ name: p.slice(folder.length + 1), metadata: STORE[p] })), error: null };
} }) } };
const R = (raw, prefix = PREFIX) => resolveFiles(admin, SB + "/", prefix, raw);
const throws = async (name, fn, re) => { try { await fn(); t(name, false, "no error"); } catch (e) { t(name, e instanceof ReplyError && re.test(e.message), String(e.message)); } };
{
  const f = await R([{ path: PDF, name: "GREYS - Private Events Memphis 2023-2024.pdf" }, { path: JPG, name: "board.jpg" }, { path: DOCX, name: "menu.docx" }]);
  t("it reads the bucket, not the browser", lists.every((l) => l[0] === LEAD_BUCKET) && lists.length === 3);
  eq("the name staff saw is kept", f[0].name, "GREYS - Private Events Memphis 2023-2024.pdf");
  eq("the link is the public file", f[0].url, `${SB}/storage/v1/object/public/lead-files/${PDF}`);
  eq("size comes from Storage", f[0].size, 2_400_000);
  eq("a PDF is a real attachment", f[0].sent, "attached");
  eq("a photo is a real attachment", f[1].sent, "attached");
  eq("a Word file goes as a link", f[2].sent, "link");
  eq("what send-mail gets", JSON.stringify(mailAttachments(f)), JSON.stringify([
    { filename: "GREYS - Private Events Memphis 2023-2024.pdf", mimetype: "application/pdf", url: f[0].url }, { filename: "board.jpg", mimetype: "image/jpeg", url: f[1].url }]));
  const h = filesHtml(f);
  t("the email lists every file with its link", f.every((x) => h.includes(`href="${x.url}"`) && h.includes(x.name.replace(/&/g, "&amp;"))) && /Attachments/.test(h), h);
  t("sizes are shown", h.includes("(2.3 MB)") && h.includes("(781 KB)") && h.includes("(59 KB)"), h);
  eq("the plain copy lists them too", filesText(f).split("\n")[2], `📎 menu.docx — ${f[2].url}`);
  eq("one file says Attachment", /Attachment</.test(filesHtml(f.slice(0, 1))), true);
  eq("no files, no box", filesHtml([]), "");
}
{
  const f = await R([{ path: PDF, name: "a.pdf" }, { path: BIG, name: "huge.pdf" }, { path: JPG, name: "b.jpg" }, { path: P2, name: "2.png" }, { path: P3, name: "3.png" }]);
  eq("over 12 MB together: the big one is a link", f.map((x) => x.sent).join(","), "attached,link,attached,attached,link");
  eq("a type with a charset is read right", f[4].type, "image/png");
}
eq("the same file twice counts once", (await R([{ path: PDF, name: "a.pdf" }, { path: PDF, name: "a.pdf" }])).length, 1);
eq("nothing attached is fine", (await R(undefined)).length, 0);
eq("a name with slashes and quotes is cleaned", (await R([{ path: PDF, name: '../..\\evil"<b>.pdf' }]))[0].name, ".. .. evil b .pdf");
eq("no name falls back to the file's", (await R([{ path: PDF }]))[0].name, "Private-Events-Memphis.pdf");
await throws("another lead's file is refused", () => R([{ path: `cat/${OTHER}/aaaaaaaaaaaaaaaa/secret.pdf`, name: "x" }]), /doesn't belong/);
await throws("an inquiry can't use a catering folder", () => R([{ path: PDF, name: "x" }], `inq/${LEAD}/`), /doesn't belong/);
await throws("a path that climbs is refused", () => R([{ path: `${PREFIX}aaaaaaaaaaaaaaaa/../../x.pdf`, name: "x" }]), /doesn't belong/);
await throws("a made-up path is refused", () => R([{ path: "anything.pdf", name: "x" }]), /doesn't belong/);
await throws("a file that isn't in Storage is refused", () => R([{ path: `${PREFIX}zzzzzzzzzzzzzzzz/ghost.pdf`, name: "x" }]), /didn't finish uploading/);
await throws("an empty file is refused", () => R([{ path: EMPTY, name: "x" }]), /is empty/);
await throws("more than 10 files is refused", () => R(Array.from({ length: 11 }, () => ({ path: PDF, name: "x" }))), /too many/);
await throws("attachments must be a list", () => R("x"), /must be a list/);
eq("fmtSize", [fmtSize(900), fmtSize(15_000), fmtSize(1_048_576), fmtSize(12 * 1048576)].join(" "), "1 KB 15 KB 1.0 MB 12 MB");

console.log("\nbuildReply · one reply");
const B = (b, prefix = PREFIX) => buildReply(admin, SB, prefix, b);
{
  const r = await B({ body: "Hi Jane,\n\nSee https://greyscheese.com & <tell> me \"when\"." });
  eq("a plain reply is stored as plain text", r.html, null);
  eq("…with the same email the old box sent", r.inner, '<p>Hi Jane,<br><br>See <a href="https://greyscheese.com">https://greyscheese.com</a> &amp; &lt;tell&gt; me &quot;when&quot;.</p>');
  eq("…and the same body", r.body, 'Hi Jane,\n\nSee https://greyscheese.com & <tell> me "when".');
  eq("plainToHtml is that same shape", plainToHtml("a\nb"), "<p>a<br>b</p>");
}
{
  const r = await B({ html: 'Hi <b>Jane</b>,<div><br></div><div>The <a href="https://greyscheese.com/catering">catering menu</a> is attached.</div><script>x</script>', body: "ignored when there is html",
    attachments: [{ path: PDF, name: "Private Events.pdf" }, { path: DOCX, name: "menu.docx" }] });
  eq("stored html is the sanitized one", r.html, 'Hi <b>Jane</b>,<div><br></div><div>The <a href="https://greyscheese.com/catering">catering menu</a> is attached.</div>');
  t("the email has the styled message", r.inner.startsWith('<div>Hi <b>Jane</b>,<div><br></div><div>The <a href="https://greyscheese.com/catering" style="color:#06273A;text-decoration:underline">catering menu</a> is attached.</div></div>'), r.inner);
  t("…and the attachments box", /Attachments/.test(r.inner) && r.inner.includes("Private Events.pdf") && r.inner.includes("menu.docx"));
  eq("body = plain text + a line per file", r.body, `Hi Jane,\n\nThe catering menu: https://greyscheese.com/catering is attached.\n\n📎 Private Events.pdf — ${BASE}${PDF}\n📎 menu.docx — ${BASE}${DOCX}`);
  eq("files keep how each one went", r.files.map((f) => f.sent).join(","), "attached,link");
}
{
  const r = await B({ html: "<div><br></div>", attachments: [{ path: JPG, name: "board.jpg" }] });
  eq("files with no words still send", r.body, `📎 board.jpg — ${BASE}${JPG}`);
  eq("…with no html stored", r.html, null);
  t("…and just the box in the email", r.inner.startsWith("<table") && r.inner.includes("board.jpg"), r.inner);
}
{
  const r = await B({ html: `<img src="${IMG}aaaaaaaaaaaaaaaa/pic.png" width="300">` });
  eq("a picture alone is a message", r.body, "[image]");
  t("…and it is in the email", r.inner.includes(`<img src="${IMG}aaaaaaaaaaaaaaaa/pic.png" alt="" width="300" style=`), r.inner);
}
{
  const r = await B({ html: `<img src="${BASE}cat/${OTHER}/aaaaaaaaaaaaaaaa/pic.png">hello` });
  eq("another lead's picture is dropped from the message", r.html, "hello");
}
await throws("nothing at all is refused", () => B({ html: "<div><br></div>", body: "  " }), /Type a message first/);
await throws("a huge message is refused", () => B({ html: "<div>" + "x".repeat(130_000) + "</div>" }), /too long/);
await throws("a file from another lead stops the reply", () => B({ body: "hi", attachments: [{ path: `cat/${OTHER}/aaaaaaaaaaaaaaaa/secret.pdf`, name: "x" }] }), /doesn't belong/);

console.log("\nspeed · hostile input stays fast");
{
  const big = (s) => { const t0 = Date.now(); S(s); return Date.now() - t0; };
  const ms = {};
  const fast = (name, s, limit) => { ms[name] = big(s); t(name, ms[name] < limit, ms[name] + " ms"); };
  fast("100k spaces", " ".repeat(100_000) + "x" + " ".repeat(19_000), 500);
  fast("many unclosed tags", "<a ".repeat(40_000), 500);
  fast("many unclosed quotes", '<a x="'.repeat(20_000), 1500);
  fast("many unclosed single quotes", "<a x='y ".repeat(15_000), 1500);
  fast("many unclosed comments / doctypes", "<! ".repeat(40_000), 500);
  fast("many unclosed data pictures", '<img src="data:'.repeat(8000), 500);
  fast("many stray closes", "</div>".repeat(20_000), 500);
  fast("many addresses", "https://a.com/x ".repeat(7000), 500);
  fast("many blank blocks", "<div><br></div>".repeat(8000), 500);
  console.log("    " + JSON.stringify(ms));
  t("a long run of text", (() => { const t0 = Date.now(); htmlToText("<div>x</div>".repeat(8000)); return Date.now() - t0; })() < 500);
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
