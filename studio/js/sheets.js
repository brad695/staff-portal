/* GREYS Studio — print sheets: small designs (the cheese and wine counter cards) laid out several to a page with
   cut marks, as one PDF. Used by the 🖨 Print Cards tab in manager.html (Cheese Case), 2026-11-16.
   The layout half (LAYOUTS, plan, pages, marks) and pdf() need nothing else loaded, so a page can draw its sheet
   preview before the renderer arrives. fonts() and jpeg() need util.js, fonts.js and render.js (plus cards.js for the
   brand fonts and picture paths outside the Studio page). */
(function () {
  const GS = (window.GS = window.GS || {});
  const PT = 72; // PDF points to the inch
  const PX = 96; // design px to the inch (print designs)
  const r2 = (v) => Math.round(v * 100) / 100;

  // Paper, grid and card size in inches. Cards fill left to right, top to bottom; the grid sits in the middle of the page.
  const LAYOUTS = {
    'letter-6': { name: 'Letter paper · 6 to a sheet', paper: [8.5, 11], cols: 2, rows: 3, card: [4, 3], gap: [0, 0] },
    // business-card size (the Studio's gift-card designs, 3.5 × 2 in) — the gift note cards on the Shipping tab
    'letter-10': { name: 'Letter paper · 10 to a sheet', paper: [8.5, 11], cols: 2, rows: 5, card: [3.5, 2], gap: [0, 0] },
    // counter cards (cheese + wine) since 2026-11-19 — 3.5 × 2.5 in, 8 to a sheet
    'letter-8': { name: 'Letter paper · 8 to a sheet', paper: [8.5, 11], cols: 2, rows: 4, card: [3.5, 2.5], gap: [0, 0] },
  };
  const DEFAULT = 'letter-8';

  // -> { W, H, per, slots: [{ x, y, w, h }] } in points, measured from the top-left corner of the page
  function plan(key) {
    const k = LAYOUTS[key] ? key : DEFAULT, L = LAYOUTS[k];
    const W = L.paper[0] * PT, H = L.paper[1] * PT, cw = L.card[0] * PT, ch = L.card[1] * PT, gx = L.gap[0] * PT, gy = L.gap[1] * PT;
    const x0 = (W - L.cols * cw - (L.cols - 1) * gx) / 2, y0 = (H - L.rows * ch - (L.rows - 1) * gy) / 2;
    const slots = [];
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) slots.push({ x: r2(x0 + c * (cw + gx)), y: r2(y0 + r * (ch + gy)), w: cw, h: ch });
    return { key: k, name: L.name, W, H, cols: L.cols, rows: L.rows, per: L.cols * L.rows, slots, card: L.card.slice(), paper: L.paper.slice() };
  }

  // [{ id, n }] -> pages of ids: each card n times, in list order, `per` to a page
  function pages(list, per) {
    const flat = [];
    for (const x of list || []) for (let i = 0; i < Math.max(0, Math.floor(+x.n || 0)); i++) flat.push(x.id);
    const out = [];
    for (let i = 0; i < flat.length; i += per) out.push(flat.slice(i, i + per));
    return out;
  }

  // Cut marks for a page holding `count` cards: short ticks in the margins, in line with every card edge, so a ruler
  // laid from tick to tick is the cut. They stop just short of the cards and never cross one.
  // -> [[x1, y1, x2, y2], …] in points from the top-left corner
  const MARK_GAP = 0.05 * PT, MARK_LEN = 0.3 * PT;
  function marks(P, count) {
    const used = P.slots.slice(0, Math.max(0, Math.min(count, P.per)));
    if (!used.length) return [];
    const uniq = (a) => a.sort((p, q) => p - q).filter((v, i) => !i || v - a[i - 1] > 0.01);
    const xs = uniq(used.flatMap((s) => [s.x, s.x + s.w])), ys = uniq(used.flatMap((s) => [s.y, s.y + s.h]));
    const left = xs[0], right = xs[xs.length - 1], top = ys[0], bottom = ys[ys.length - 1];
    const out = [];
    for (const x of xs) {
      out.push([x, Math.max(0, top - MARK_GAP - MARK_LEN), x, top - MARK_GAP]);
      out.push([x, bottom + MARK_GAP, x, Math.min(P.H, bottom + MARK_GAP + MARK_LEN)]);
    }
    for (const y of ys) {
      out.push([Math.max(0, left - MARK_GAP - MARK_LEN), y, left - MARK_GAP, y]);
      out.push([right + MARK_GAP, y, Math.min(P.W, right + MARK_GAP + MARK_LEN), y]);
    }
    return out.filter((m) => Math.abs(m[2] - m[0]) + Math.abs(m[3] - m[1]) > 1).map((m) => m.map(r2));
  }

  // ---------- fonts ----------
  // Load every font face the designs use, with the letters they use, and wait for them. A design drawn with a
  // fallback font wraps differently, so a caller should stop when this returns anything.
  // -> the font families that didn't load
  const faceKey = (el) => el.font + '|' + (el.weight || 400) + '|' + (el.ital ? 1 : 0);
  const bare = (f) => String(f || '').replace(/^["']|["']$/g, '');
  function hasFamily(fam) {
    for (const f of document.fonts) if (f.status === 'loaded' && bare(f.family) === fam) return true;
    return false;
  }
  async function fonts(designs) {
    const faces = new Map();
    for (const d of designs || []) for (const p of d.pages || []) for (const el of p.els || []) {
      if (el.type !== 'text' || !el.font) continue;
      const k = faceKey(el), f = faces.get(k) || { el, chars: new Set('Aa') };
      const t = String(el.text || '');
      for (const ch of t + t.toUpperCase()) if (ch.trim()) f.chars.add(ch);
      faces.set(k, f);
    }
    const all = [...faces.values()], text = (f) => [...f.chars].join('');
    // outside the Studio page the brand stylesheet isn't on the page yet: cards.js adds it and loads the card faces
    if (GS.Cards && GS.Cards.loadFonts) await GS.Cards.loadFonts(all.map(text).join(''));
    await Promise.all(all.map(async (f) => {
      await GS.loadFamily(f.el.font);
      try { await Promise.race([document.fonts.load(GS.fontStr(f.el, 40), text(f)), new Promise((r) => setTimeout(r, 10000))]); } catch (e) { /* checked below */ }
    }));
    const missing = new Set();
    for (const f of all) {
      let ok = false;
      try { ok = document.fonts.check(GS.fontStr(f.el, 40), text(f)) && hasFamily(f.el.font); } catch (e) { ok = false; }
      if (!ok) missing.add(f.el.font);
    }
    GS.bus.emit('fontsloaded');
    return [...missing];
  }

  // ---------- pictures ----------
  // The renderer remembers a picture that failed, so one bad moment on the network would stick until the page is
  // reloaded. Give each failed picture one fresh try.
  async function retryPicture(ref) {
    try {
      const url = await GS.Store.resolveURL(ref);
      if (!url) return;
      const r = await fetch(url, { cache: 'reload' });
      if (!r.ok) return;
      const img = new Image(), src = URL.createObjectURL(await r.blob());
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      if (img.naturalWidth && img.naturalHeight) GS.R.seedImg(ref, img);
    } catch (e) { /* still missing: jpeg() reports it */ }
  }

  // The first page of a design as a JPEG at `dpi` (print designs are 96 px to the inch).  -> { bytes, w, h }
  // Throws (code 'picture', refs) rather than hand back a card with an empty picture frame.
  async function jpeg(design, dpi, quality) {
    const R = GS.R, page = design.pages[0];
    await R.preload(design);
    const refs = [];
    if (page.bg && page.bg.img && page.bg.img.src) refs.push(page.bg.img.src);
    for (const el of page.els || []) if (el.type === 'image' && el.src && !el.hidden) refs.push(el.src);
    for (const ref of refs) if (R.imgState(ref) !== 'ok') await retryPicture(ref);
    const bad = refs.filter((ref) => R.imgState(ref) !== 'ok');
    if (bad.length) { const e = new Error('a picture did not load'); e.code = 'picture'; e.refs = bad; throw e; }
    const s = (dpi || 300) / PX;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(design.w * s)); cv.height = Math.max(1, Math.round(design.h * s));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(cv.width / design.w, 0, 0, cv.height / design.h, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    R.drawPage(ctx, design, page, { scale: s, exporting: true });
    // toDataURL, not toBlob: toBlob waits for the browser to go idle, which can take a second or two per card
    const bin = atob(cv.toDataURL('image/jpeg', quality || 0.94).split(',')[1]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, w: cv.width, h: cv.height };
  }

  // ---------- PDF ----------
  // o: { layout, pages: [[key, …]], images: { key: { bytes, w, h } }, marks, title }  -> Blob (application/pdf)
  // Pages are the real paper size, and PrintScaling None asks the print dialog for 100% so a 4 in card prints 4 in.
  // Each card's picture is stored once, however many copies are on the sheets.
  function pdf(o) {
    const P = plan(o.layout), enc = new TextEncoder(), chunks = [], offsets = [];
    let offset = 0;
    const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); offset += b.length; };
    const obj = (num, body) => { offsets[num] = offset; push(num + ' 0 obj\n' + body + '\nendobj\n'); };
    const list = (o.pages || []).filter((ids) => ids && ids.length), n = list.length;
    const keys = [...new Set(list.flat())].filter((k) => o.images[k]);
    const first = 4 + n * 2, num = {};
    keys.forEach((k, i) => (num[k] = first + i));
    const str = (s) => String(s || '').replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1');
    const d = new Date(), z = (v) => String(v).padStart(2, '0');
    const stamp = 'D:' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
    push('%PDF-1.6\n%âãÏÓ\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>');
    obj(2, '<< /Type /Pages /Kids [' + list.map((_, i) => 4 + i * 2 + ' 0 R').join(' ') + '] /Count ' + n + ' >>');
    obj(3, '<< /Title (' + str(o.title || 'GREYS counter cards') + ') /Creator (GREYS Studio) /Producer (GREYS Studio) /CreationDate (' + stamp + ') >>');
    list.forEach((ids, i) => {
      const pn = 4 + i * 2, cn = pn + 1, ops = [], res = [];
      ids.forEach((k, j) => {
        const s = P.slots[j], im = o.images[k];
        if (!s || !im) return;
        const sc = Math.min(s.w / im.w, s.h / im.h), w = im.w * sc, h = im.h * sc; // fits the slot, centered
        const x = s.x + (s.w - w) / 2, y = s.y + (s.h - h) / 2;
        ops.push('q ' + r2(w) + ' 0 0 ' + r2(h) + ' ' + r2(x) + ' ' + r2(P.H - y - h) + ' cm /I' + num[k] + ' Do Q');
        if (!res.includes(num[k])) res.push(num[k]);
      });
      if (o.marks !== false) {
        const m = marks(P, ids.length);
        if (m.length) ops.push('0 G 0.5 w ' + m.map((a) => a[0] + ' ' + r2(P.H - a[1]) + ' m ' + a[2] + ' ' + r2(P.H - a[3]) + ' l S').join(' '));
      }
      const content = ops.join('\n');
      obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + r2(P.W) + ' ' + r2(P.H) + '] /Resources << /XObject << ' + res.map((v) => '/I' + v + ' ' + v + ' 0 R').join(' ') + ' >> >> /Contents ' + cn + ' 0 R >>');
      obj(cn, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    });
    keys.forEach((k) => {
      const im = o.images[k];
      offsets[num[k]] = offset;
      push(num[k] + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
      push(im.bytes);
      push('\nendstream\nendobj\n');
    });
    const size = first + keys.length, xref = offset;
    let x = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (let k = 1; k < size; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(x + 'trailer\n<< /Size ' + size + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  GS.Sheets = { LAYOUTS, DEFAULT, PT, plan, pages, marks, fonts, jpeg, pdf };
})();
