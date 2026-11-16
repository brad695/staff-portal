/* GREYS Studio — counter cards (cheese and wine) made from plain fields with the Studio's own templates and renderer.
   One copy of the layout rules for both places that make cards:
   - tools/cheese-cards (batch builds from studio/data/*-cards.json), and
   - Cheese Entry in manager.html (a card for every new cheese, 2026-11-15).
   Needs util.js, fonts.js, shapes.js, render.js and templates.js loaded first. */
(function () {
  const GS = (window.GS = window.GS || {}), R = GS.R;
  // Outside the Studio page there is no store: badge pictures are plain /studio/graphics/ paths, and a card someone
  // edited in the Studio may hold a library photo (p:) or graphic (g:), which live under /studio/ too.
  GS.Store = GS.Store || {
    resolveURL: async (ref) => !ref ? null : ref.startsWith('p:') ? '/studio/photos/' + ref.slice(2) : ref.startsWith('g:') ? '/studio/graphics/' + ref.slice(2) : /^(a|d):/.test(ref) ? null : ref,
  };

  const MILKS = ['cow', 'goat', 'sheep'];
  const GLASSES = ['red', 'white', 'rose', 'orange', 'sparkling', 'sparkling-rose', 'dessert', 'port'];
  // each card kind: its template and the sample text the template ships with (that's how the fields are found)
  const KINDS = {
    cheese: { tpl: 'cheese-card', title: 'Comté', sub: 'AGED 18 MONTHS', line: 'France  ·  Cow  ·  Raw', desc: /^Brown butter/, price: '$00.00 / lb', pic: /\/graphics\/cow\.svg$/ },
    wine: { tpl: 'wine-card', title: 'Côte de Brouilly', sub: 'Cru Beaujolais', line: 'Beaujolais, France  ·  Gamay', desc: /^Dark berries/, price: '$00.00', pic: /\/graphics\/wine-red\.svg$/ },
  };
  // the brand faces the cards use, and the sample that pulls in the accented letters
  const FACES = ['700 40px "League Spartan"', '800 40px "League Spartan"', '800 40px "Barlow Condensed"', '400 40px "Nunito Sans"', '800 40px "Nunito Sans"'];
  const SAMPLE = 'AaBbÉéèüä’·—“”–0123456789$';
  const FONT_CSS = 'https://fonts.googleapis.com/css2?family=League+Spartan:wght@400;500;600;700;800;900' +
    '&family=Barlow+Condensed:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700' +
    '&family=Nunito+Sans:ital,wght@0,400;0,600;0,700;0,800;0,900;1,400;1,700&display=swap';

  const lines = (el, w) => { const w0 = el.w; el.w = w; const L = R.textLayout(el); el.w = w0; return L; };
  const range = (a, b, st) => { const o = []; for (let s = a; s >= b - 1e-9; s -= st) o.push(Math.round(s * 100) / 100); return o; };
  function fit1(el, sizes, margin) {
    for (const s of sizes) { el.size = s; if (lines(el, el.w - margin).lines.length === 1) return s; }
    el.size = sizes[sizes.length - 1];
    return null;
  }

  // The card's middle line: "France  ·  Cow  ·  Raw" (cheese) or "Beaujolais, France  ·  Gamay" (wine)
  function lineOf(c, kind) {
    if (kind === 'wine') return c.line || [c.origin, c.grape].filter(Boolean).join('  ·  ');
    return c.line || [c.origin, c.milk, c.treat].filter(Boolean).join('  ·  ');
  }

  // c: { design_id, name, title, sub, line (or origin/milk/treat), desc, price, milk | type } -> { d, diag }
  function build(c, kind) {
    kind = kind || 'cheese';
    const K = KINDS[kind];
    const d = GS.fromTemplate(GS.TEMPLATES.find((t) => t.id === K.tpl));
    const els = d.pages[0].els;
    const T = (txt) => els.find((e) => e.type === 'text' && e.text === txt);
    const title = T(K.title), sub = T(K.sub), line = T(K.line);
    const desc = els.find((e) => e.type === 'text' && K.desc.test(e.text)), price = T(K.price);
    if (!title || !sub || !line || !desc || !price) throw new Error(K.tpl + ' template text changed; update KINDS in studio/js/cards.js');
    const warn = [];

    // title — one line down to 28px, else two lines; bottom stays where the sample's sits
    title.text = c.title || '';
    const BOTTOM = title.y + title.size * title.lh; // 64.3
    let ts = fit1(title, range(46, 28, 1), 4), n = 1;
    if (ts == null) {
      for (const s of range(27, 18, 1)) { title.size = s; if (lines(title, title.w - 4).lines.length <= 2) { ts = s; break; } }
      if (ts == null) warn.push('title too long');
      n = lines(title, title.w - 4).lines.length;
    }
    title.y = Math.max(5, BOTTOM - n * title.size * title.lh);

    // gold subtitle (uppercase) — one line
    sub.text = c.sub || ''; sub.upper = true;
    const sub0 = sub.size, subY = sub.y;
    if (sub.text && fit1(sub, range(12.5, 9, 0.5), 4) == null) warn.push('sub wraps');
    sub.y = subY + (sub0 - sub.size) / 2;

    // origin · milk · treatment — one line
    line.text = lineOf(c, kind);
    const ln0 = line.size, lnY = line.y;
    if (line.text && fit1(line, range(14, 10.5, 0.5), 4) == null) warn.push('origin line wraps');
    line.y = lnY + (ln0 - line.size) / 2;

    // tasting note — at most 3 lines, must clear the rule at y=206
    desc.text = c.desc || '';
    let ok = !desc.text;
    if (!ok) for (const s of range(15, 12, 0.5)) { desc.size = s; const L = lines(desc, desc.w - 8); if (L.lines.length <= 3 && L.height <= 64) { ok = true; break; } }
    if (!ok) warn.push('desc too long');

    // price — one line
    price.text = c.price || '';
    const p0 = price.size, pY = price.y;
    if (price.text && fit1(price, range(30, 18, 1), 4) == null) warn.push('price wraps');
    price.y = pY + (p0 - price.size) * 0.6;

    // badge: wine picks the glass for its style; cheese shows the cow, goat or sheep, and blends keep the gold cheese wheel
    const disc = els.find((e) => e.type === 'shape' && e.shape === 'ellipse');
    const pic = els.find((e) => e.type === 'image' && K.pic.test(e.src || ''));
    if (!disc || !pic) throw new Error(K.tpl + ' template has no badge');
    const milk = String(c.milk || '').trim().toLowerCase();
    if (kind === 'wine') {
      const g = String(c.type || '').trim().toLowerCase();
      if (!GLASSES.includes(g)) throw new Error(c.name + ': unknown wine type ' + c.type);
      pic.src = '/studio/graphics/wine-' + g + '.svg';
    } else if (MILKS.includes(milk)) pic.src = '/studio/graphics/' + milk + '.svg';
    else {
      const at = els.indexOf(disc), keep = els.filter((e) => e !== disc && e !== pic);
      keep.splice(at, 0, GS.mk.icon({ icon: 'wheel', x: 312, y: 22, w: 52, h: 52 }));
      els.length = 0; els.push(...keep);
    }

    els.forEach((e) => R.syncText(e));
    if (c.design_id) d.id = c.design_id;
    d.name = c.name || [c.title, c.sub].filter(Boolean).join(' — ') || d.name;
    d.kind = K.tpl;
    const diag = { title: [title.size, lines(title, title.w).lines.length], sub: sub.size, line: line.size, desc: [desc.size, lines(desc, desc.w).lines.length, Math.round(desc.y + desc.h)], price: price.size, warn };
    return { d, diag };
  }

  // load the badge pictures before drawing; a card must never be saved with an empty frame
  async function prep(d) {
    await R.preload(d);
    const bad = d.pages[0].els.filter((e) => e.type === 'image' && R.imgState(e.src) !== 'ok').map((e) => e.src);
    if (bad.length) throw new Error('picture did not load: ' + bad.join(', '));
  }
  function thumb(d) {
    const s = Math.min(280 / d.w, 280 / d.h);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(d.w * s)); cv.height = Math.max(1, Math.round(d.h * s));
    const ctx = cv.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    R.drawPage(ctx, d, d.pages[0], { scale: s });
    return cv.toDataURL('image/jpeg', 0.74);
  }
  function png(d, s) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(d.w * s); cv.height = Math.round(d.h * s);
    const ctx = cv.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    R.drawPage(ctx, d, d.pages[0], { scale: s, exporting: true });
    return cv.toDataURL('image/png');
  }
  // the studio_designs row, as the Studio itself saves one
  function row(d, thumbUrl, at) {
    const iso = new Date(at || d.createdAt || Date.now()).toISOString();
    return { id: d.id, name: d.name, w: Math.round(d.w), h: Math.round(d.h), unit: d.unit, kind: d.kind, page_count: d.pages.length, thumb: thumbUrl || '', pages: d.pages, created_at: iso, updated_at: iso };
  }

  // Outside the Studio page (manager.html), the brand fonts have to be fetched before anything is measured:
  // a card fitted with a fallback font prints wrong. Pass the card's text so every accented letter's subset loads too.
  // Resolves to true only when all five faces are really there.
  let cssLoad = null;
  function fontCss() {
    if (cssLoad) return cssLoad;
    const have = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /League\+Spartan/.test(l.href) && /Barlow\+Condensed/.test(l.href) && /Nunito\+Sans/.test(l.href));
    if (have) return (cssLoad = Promise.resolve(true));
    cssLoad = new Promise((res) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = FONT_CSS;
      link.onload = () => res(true); link.onerror = () => { cssLoad = null; res(false); };
      setTimeout(() => res(false), 12000);
      document.head.append(link);
    });
    return cssLoad;
  }
  async function loadFonts(text) {
    await fontCss();
    const sample = SAMPLE + String(text || '');
    for (const f of FACES) {
      try { await Promise.race([document.fonts.load(f, sample), new Promise((r) => setTimeout(r, 10000))]); } catch (e) { /* checked below */ }
    }
    const ok = FACES.every((f) => document.fonts.check(f, 'Aa'));
    GS.bus.emit('fontsloaded');
    return ok;
  }

  GS.Cards = { KINDS, MILKS, GLASSES, FACES, SAMPLE, lineOf, build, prep, thumb, png, row, loadFonts };
})();
