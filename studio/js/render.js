/* GREYS Studio — renderer shared by the editor view, thumbnails and exports */
(function () {
  const GS = window.GS;
  const R = (GS.R = {});
  let fontEpoch = 0;
  const layoutCache = new Map();
  GS.bus.on('fontsloaded', () => { fontEpoch++; layoutCache.clear(); });

  const mcv = document.createElement('canvas');
  const mctx = mcv.getContext('2d');
  const HAS_LS = 'letterSpacing' in mctx;
  const charW = new Map();

  function measurer(el) {
    mctx.font = GS.fontStr(el);
    const ls = ((el.ls || 0) / 1000) * el.size;
    if (HAS_LS) {
      mctx.letterSpacing = ls + 'px';
      return (s) => (s ? mctx.measureText(s).width - ls : 0);
    }
    const f = mctx.font;
    return (s) => {
      if (!s) return 0;
      if (!ls) return mctx.measureText(s).width;
      let w = 0;
      for (const ch of s) {
        const k = f + ch;
        let cw = charW.get(k);
        if (cw == null) { cw = mctx.measureText(ch).width; charW.set(k, cw); }
        w += cw + ls;
      }
      return w - ls;
    };
  }
  function metrics(el) {
    mctx.font = GS.fontStr(el);
    const m = mctx.measureText('Hgjy');
    let asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
    if (!(asc > 0)) { asc = el.size * 0.82; desc = el.size * 0.22; }
    return { asc, desc };
  }

  // ---------- Text layout ----------
  R.textLayout = function (el) {
    const key = [fontEpoch, el.text, el.font, el.size, el.weight, el.ital ? 1 : 0, Math.round(el.w * 100), el.ls || 0, el.lh, el.upper ? 1 : 0, el.bgc ? el.bgp ?? 0.25 : -1].join('|');
    let L = layoutCache.get(key);
    if (L) return L;
    const size = el.size;
    const pad = el.bgc ? (el.bgp ?? 0.25) * size : 0;
    const maxW = Math.max(1, el.w - pad * 2);
    const txt = el.upper ? String(el.text).toUpperCase() : String(el.text);
    const meas = measurer(el);
    const out = [];
    for (const para of txt.split('\n')) {
      if (!para) { out.push(''); continue; }
      const parts = para.split(/(\s+)/).filter((s) => s.length);
      let line = '';
      for (const part of parts) {
        if (/^\s+$/.test(part)) { line += part; continue; }
        const test = line + part;
        if (line.trim().length && meas(test.trimEnd()) > maxW) { out.push(line); line = part; }
        else line = test;
        while (line.trimEnd().length > 1 && meas(line.trimEnd()) > maxW) {
          let lo = 1, hi = line.length;
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (meas(line.slice(0, mid)) <= maxW) lo = mid; else hi = mid - 1; }
          out.push(line.slice(0, lo));
          line = line.slice(lo);
        }
      }
      out.push(line);
    }
    const lines = out.map((t) => { t = t.replace(/\s+$/, ''); return { t, w: meas(t) }; });
    const { asc, desc } = metrics(el);
    const lh = size * (el.lh || 1.2);
    L = { lines, lh, asc, desc, pad, maxW, height: lines.length * lh + pad * 2, lsPx: ((el.ls || 0) / 1000) * size };
    if (layoutCache.size > 600) layoutCache.clear();
    layoutCache.set(key, L);
    return L;
  };

  R.curveLayout = function (el) {
    const key = ['c', fontEpoch, el.text, el.font, el.size, el.weight, el.ital ? 1 : 0, el.ls || 0, el.upper ? 1 : 0, el.curve].join('|');
    let L = layoutCache.get(key);
    if (L) return L;
    const txt = (el.upper ? String(el.text).toUpperCase() : String(el.text)).replace(/\s*\n\s*/g, ' ');
    mctx.font = GS.fontStr(el);
    if (HAS_LS) mctx.letterSpacing = '0px';
    const ls = ((el.ls || 0) / 1000) * el.size;
    const chars = Array.from(txt);
    const cws = chars.map((ch) => mctx.measureText(ch).width);
    const total = Math.max(1, cws.reduce((a, b) => a + b, 0) + ls * Math.max(0, chars.length - 1));
    const c = GS.clamp(el.curve, -100, 100);
    const phi = Math.max(0.02, (Math.abs(c) / 100) * Math.PI * 1.9);
    const rad = total / phi;
    const { asc, desc } = metrics(el);
    let acc = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pos = [];
    chars.forEach((ch, i) => {
      const s = acc + cws[i] / 2;
      acc += cws[i] + ls;
      const b = (s - total / 2) / rad;
      const p = c > 0 ? { x: rad * Math.sin(b), y: -rad * Math.cos(b), r: b } : { x: rad * Math.sin(b), y: rad * Math.cos(b), r: -b };
      pos.push(p);
      const hw = cws[i] / 2, co = Math.cos(p.r), si = Math.sin(p.r);
      for (const [dx, dy] of [[-hw, -asc], [hw, -asc], [hw, desc], [-hw, desc]]) {
        const x = p.x + dx * co - dy * si, y = p.y + dx * si + dy * co;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    });
    if (!chars.length) { minX = 0; minY = 0; maxX = el.size; maxY = el.size; }
    L = { chars, cws, pos, minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY), asc, desc };
    layoutCache.set(key, L);
    return L;
  };

  // Keep a text element's derived size in step with its content
  R.syncText = function (el) {
    if (el.type !== 'text') return;
    if (el.curve) {
      const L = R.curveLayout(el);
      if (Math.abs(el.w - L.w) > 0.05 || Math.abs(el.h - L.h) > 0.05) {
        el.x += (el.w - L.w) / 2; el.y += (el.h - L.h) / 2; el.w = L.w; el.h = L.h;
      }
    } else {
      const L = R.textLayout(el);
      if (Math.abs(el.h - L.height) > 0.05) el.h = L.height;
    }
  };

  function lineText(ctx, s, x, y, ls, fn) {
    if (!s) return;
    if (HAS_LS || !ls) { ctx[fn](s, x, y); return; }
    for (const ch of s) { ctx[fn](ch, x, y); x += ctx.measureText(ch).width + ls; }
  }

  function setShadow(ctx, sh, sc) {
    if (!sh) { ctx.shadowColor = 'transparent'; return; }
    ctx.shadowColor = sh.c || 'rgba(0,0,0,.35)';
    ctx.shadowBlur = (sh.b || 0) * sc;
    ctx.shadowOffsetX = (sh.x || 0) * sc;
    ctx.shadowOffsetY = (sh.y || 0) * sc;
  }
  const noShadow = (ctx) => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };

  R.linGrad = function (ctx, w, h, g) {
    const a = ((g.angle ?? 180) * Math.PI) / 180;
    const L = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const dx = (Math.sin(a) * L) / 2, dy = (-Math.cos(a) * L) / 2;
    const gr = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    gr.addColorStop(0, g.a); gr.addColorStop(1, g.b);
    return gr;
  };

  function drawText(ctx, el, o) {
    if (el.curve) return drawCurved(ctx, el, o);
    const L = R.textLayout(el);
    GS.faceReady(el);
    if (el.bgc) {
      ctx.save(); noShadow(ctx);
      ctx.fillStyle = el.bgc;
      ctx.fill(GS.rrPath(0, 0, el.w, L.height, (el.bgr ?? 0.35) * Math.min(L.pad * 2 + el.size * 0.2, L.height / 2)));
      ctx.restore();
    }
    ctx.font = GS.fontStr(el);
    if (HAS_LS) ctx.letterSpacing = L.lsPx + 'px';
    ctx.textBaseline = 'alphabetic';
    const pos = L.lines.map((ln, i) => {
      let x = L.pad;
      if (el.align === 'center') x += (L.maxW - ln.w) / 2;
      else if (el.align === 'right') x += L.maxW - ln.w;
      return { x, y: L.pad + i * L.lh + (L.lh - (L.asc + L.desc)) / 2 + L.asc, ln };
    });
    const outline = el.stroke && el.stroke.w > 0;
    if (outline || el.hollow) {
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.strokeStyle = outline ? el.stroke.c : el.color;
      ctx.lineWidth = el.hollow ? Math.max(0.5, outline ? el.stroke.w : el.size * 0.03) : el.stroke.w * 2;
      pos.forEach((p) => lineText(ctx, p.ln.t, p.x, p.y, L.lsPx, 'strokeText'));
      if (!el.hollow) noShadow(ctx);
    }
    ctx.fillStyle = el.color || '#000';
    if (!el.hollow) pos.forEach((p) => lineText(ctx, p.ln.t, p.x, p.y, L.lsPx, 'fillText'));
    if (el.under) {
      noShadow(ctx);
      const th = Math.max(1, el.size * 0.065);
      pos.forEach((p) => { if (p.ln.w) ctx.fillRect(p.x, p.y + el.size * 0.11, p.ln.w, th); });
    }
    if (HAS_LS) ctx.letterSpacing = '0px';
  }

  function drawCurved(ctx, el, o) {
    const L = R.curveLayout(el);
    GS.faceReady(el);
    ctx.font = GS.fontStr(el);
    if (HAS_LS) ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(-L.minX * (el.w / L.w), -L.minY * (el.h / L.h));
    const outline = el.stroke && el.stroke.w > 0;
    const pass = (fn) => L.chars.forEach((ch, i) => {
      const p = L.pos[i];
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx[fn](ch, -L.cws[i] / 2, 0); ctx.restore();
    });
    if (outline || el.hollow) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = outline ? el.stroke.c : el.color;
      ctx.lineWidth = el.hollow ? Math.max(0.5, outline ? el.stroke.w : el.size * 0.03) : el.stroke.w * 2;
      pass('strokeText');
      if (!el.hollow) noShadow(ctx);
    }
    ctx.fillStyle = el.color || '#000';
    if (!el.hollow) pass('fillText');
  }

  function drawShape(ctx, el) {
    const p = GS.shapePath(el.shape, el.w, el.h, el);
    const rule = GS.shapeRule(el.shape);
    const hasFill = el.fill && el.fill !== 'none';
    if (hasFill || el.grad) {
      ctx.fillStyle = el.grad ? R.linGrad(ctx, el.w, el.h, el.grad) : el.fill;
      ctx.fill(p, rule);
    }
    if (el.stroke && el.stroke.w > 0) {
      if (hasFill || el.grad) noShadow(ctx);
      ctx.lineWidth = el.stroke.w;
      ctx.strokeStyle = el.stroke.c;
      ctx.lineJoin = 'round';
      const w = el.stroke.w;
      if (el.stroke.dash === 'dashed') ctx.setLineDash([w * 3, w * 2]);
      else if (el.stroke.dash === 'dotted') { ctx.setLineDash([0.001, w * 2]); ctx.lineCap = 'round'; }
      ctx.stroke(p);
      ctx.setLineDash([]); ctx.lineCap = 'butt';
    }
  }

  function drawLine(ctx, el) {
    const y = el.h / 2, sw = el.sw || 4, len = el.w;
    ctx.strokeStyle = ctx.fillStyle = el.color || '#06273A';
    ctx.lineWidth = sw;
    ctx.lineCap = el.dash === 'dotted' ? 'round' : 'butt';
    if (el.dash === 'dashed') ctx.setLineDash([sw * 3, sw * 2]);
    else if (el.dash === 'dotted') ctx.setLineDash([0.001, sw * 2.2]);
    const ah = sw * 4.2, aw = sw * 2.6;
    const x0 = el.capS === 'arrow' ? ah * 0.8 : 0, x1 = el.capE === 'arrow' ? len - ah * 0.8 : len;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.setLineDash([]);
    const cap = (kind, x, dir) => {
      if (kind === 'arrow') { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dir * ah, y - aw); ctx.lineTo(x - dir * ah, y + aw); ctx.closePath(); ctx.fill(); }
      else if (kind === 'circle') { ctx.beginPath(); ctx.arc(x - dir * sw * 1.6, y, sw * 1.7, 0, Math.PI * 2); ctx.fill(); }
      else if (kind === 'bar') { ctx.fillRect(x - (dir > 0 ? sw : 0), y - sw * 2.2, sw, sw * 4.4); }
    };
    cap(el.capS, 0, -1); cap(el.capE, len, 1);
  }

  function drawIcon(ctx, el) {
    const def = GS.ICONS[el.icon];
    ctx.save();
    ctx.scale(el.w / 100, el.h / 100);
    ctx.fillStyle = el.fill || '#06273A';
    ctx.fill(GS.iconPath(el.icon), (def && def.rule) || 'nonzero');
    ctx.restore();
  }

  // ---------- Images ----------
  const imgs = new Map();
  function loadImg(ref) {
    const e = { st: 'loading' };
    imgs.set(ref, e);
    e.p = (async () => {
      try {
        const url = await GS.Store.resolveURL(ref);
        if (!url) throw new Error('missing');
        let src = url;
        if (!/^(blob|data):/.test(url)) {
          try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            src = URL.createObjectURL(await r.blob());
          } catch (err) { src = url; }
        }
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
        e.img = img; e.w = img.naturalWidth || 1000; e.h = img.naturalHeight || 1000; e.st = 'ok';
      } catch (err) { e.st = 'err'; }
      GS.bus.emit('imgloaded', ref);
    })();
    return e;
  }
  R.getImg = (ref) => {
    if (!ref) return null;
    const e = imgs.get(ref) || loadImg(ref);
    return e.st === 'ok' ? e : null;
  };
  R.imgState = (ref) => (imgs.get(ref) || {}).st;
  R.loadImg = (ref) => { const e = imgs.get(ref) || loadImg(ref); return e.p.then(() => e); };
  R.seedImg = (ref, img) => { imgs.set(ref, { st: 'ok', img, w: img.naturalWidth, h: img.naturalHeight, p: Promise.resolve() }); };
  R.preload = function (design) {
    const refs = new Set();
    design.pages.forEach((p) => { if (p.bg && p.bg.img) refs.add(p.bg.img.src); p.els.forEach((el) => el.type === 'image' && el.src && refs.add(el.src)); });
    return Promise.all([...refs].map((r) => R.loadImg(r)));
  };

  const filtCache = new Map();
  R.hasFilt = (f) => !!(f && (f.br || f.ct || f.sat || f.warm || f.gray || f.sepia || f.blur || f.vig));
  function filtered(ref, e, f, maxDim) {
    const sc = Math.min(1, maxDim / Math.max(e.w, e.h));
    const w = Math.max(1, Math.round(e.w * sc)), h = Math.max(1, Math.round(e.h * sc));
    const key = ref + '|' + w + '|' + JSON.stringify(f);
    let cv = filtCache.get(key);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    if (f.blur > 0) {
      const k = 1 + f.blur / 7;
      const t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(w / k)); t.height = Math.max(1, Math.round(h / k));
      const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(e.img, 0, 0, t.width, t.height);
      c.imageSmoothingQuality = 'high'; c.drawImage(t, 0, 0, w, h);
    } else c.drawImage(e.img, 0, 0, w, h);
    if (f.br || f.ct || f.sat || f.warm || f.gray || f.sepia) {
      try {
        const d = c.getImageData(0, 0, w, h), a = d.data;
        const bf = 1 + (f.br || 0) / 100;
        const C = (f.ct || 0) * 2.2, cf = (259 * (C + 255)) / (255 * (259 - C));
        const sf = 1 + (f.sat || 0) / 100, wm = (f.warm || 0) * 0.32, gm = (f.gray || 0) / 100, sp = (f.sepia || 0) / 100;
        for (let i = 0; i < a.length; i += 4) {
          let r = a[i] * bf, g = a[i + 1] * bf, b = a[i + 2] * bf;
          if (C) { r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128; }
          if (sf !== 1) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * sf; g = l + (g - l) * sf; b = l + (b - l) * sf; }
          if (wm) { r += wm; g += wm * 0.15; b -= wm; }
          if (gm) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r += (l - r) * gm; g += (l - g) * gm; b += (l - b) * gm; }
          if (sp) {
            const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
            r += (sr - r) * sp; g += (sg - g) * sp; b += (sb - b) * sp;
          }
          a[i] = r; a[i + 1] = g; a[i + 2] = b;
        }
        c.putImageData(d, 0, 0);
      } catch (err) { /* tainted canvas: keep unfiltered */ }
    }
    if (f.vig > 0) {
      const gr = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, f.vig / 100)})`);
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
    }
    if (filtCache.size > 40) filtCache.delete(filtCache.keys().next().value);
    filtCache.set(key, cv);
    return cv;
  }
  R.FILTER_PRESETS = {
    none: { label: 'Original', f: {} },
    warm: { label: 'Warm', f: { warm: 22, sat: 8 } },
    golden: { label: 'Golden', f: { warm: 32, br: 6, sat: 14, ct: 6 } },
    vivid: { label: 'Vivid', f: { sat: 38, ct: 14 } },
    cool: { label: 'Cool', f: { warm: -24, sat: -4 } },
    matte: { label: 'Matte', f: { ct: -22, br: 8, sat: -14 } },
    bw: { label: 'B&W', f: { gray: 100, ct: 12 } },
    noir: { label: 'Noir', f: { gray: 100, ct: 38, br: -6, vig: 40 } },
    sepia: { label: 'Sepia', f: { sepia: 85, ct: 4 } },
  };

  // Placeholder for empty frames
  function drawPlaceholder(ctx, el, path, o, loading) {
    ctx.save();
    noShadow(ctx);
    ctx.fillStyle = loading ? '#EEF1F4' : '#D8DEE4';
    if (path) ctx.fill(path); else ctx.fillRect(0, 0, el.w, el.h);
    if (!loading) {
      const s = Math.min(el.w, el.h) * 0.28;
      ctx.translate(el.w / 2, el.h / 2);
      ctx.fillStyle = '#A4AFBA';
      ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.35); ctx.lineTo(-s * 0.15, -s * 0.2); ctx.lineTo(s * 0.1, s * 0.08); ctx.lineTo(s * 0.3, -s * 0.08); ctx.lineTo(s * 0.6, s * 0.35); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.32, -s * 0.38, s * 0.12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawImageEl(ctx, el, o) {
    const masked = (el.mask && el.mask !== 'rect') || el.r > 0;
    const path = masked ? GS.shapePath(el.mask || 'rect', el.w, el.h, { r: el.mask && el.mask !== 'rect' ? 0 : el.r }) : null;
    const e = R.getImg(el.src);
    if (!e) { drawPlaceholder(ctx, el, path, o, el.src && R.imgState(el.src) === 'loading'); drawBorder(ctx, el, path); return; }
    const src = R.hasFilt(el.filt) ? filtered(el.src, e, el.filt, o.exporting ? 6000 : 1600) : e.img;
    const k = (src.width || e.w) / e.w;
    const cr = el.crop || {};
    let s, dw, dh, dx, dy;
    if (el.fit === 'contain') {
      s = Math.min(el.w / e.w, el.h / e.h); dw = e.w * s; dh = e.h * s; dx = (el.w - dw) / 2; dy = (el.h - dh) / 2;
    } else {
      s = Math.max(el.w / e.w, el.h / e.h) * (cr.z || 1); dw = e.w * s; dh = e.h * s;
      dx = (el.w - dw) * (cr.x ?? 0.5); dy = (el.h - dh) * (cr.y ?? 0.5);
    }
    if (o.cropGhost) { ctx.save(); noShadow(ctx); ctx.globalAlpha *= 0.35; ctx.drawImage(src, dx, dy, dw, dh); ctx.restore(); }
    if (!path) {
      if (el.fit === 'contain') ctx.drawImage(src, dx, dy, dw, dh);
      else {
        const sx = (-dx / s) * k, sy = (-dy / s) * k, sw = (el.w / s) * k, sh = (el.h / s) * k;
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, el.w, el.h);
      }
    } else {
      if (el.shadow) { ctx.fillStyle = '#000'; ctx.fill(path); noShadow(ctx); }
      ctx.save(); ctx.clip(path); ctx.drawImage(src, dx, dy, dw, dh); ctx.restore();
    }
    drawBorder(ctx, el, path);
  }
  function drawBorder(ctx, el, path) {
    if (!el.border || !(el.border.w > 0)) return;
    const p = path || GS.shapePath('rect', el.w, el.h, {});
    ctx.save(); noShadow(ctx);
    ctx.clip(p);
    ctx.lineWidth = el.border.w * 2; ctx.strokeStyle = el.border.c; ctx.stroke(p);
    ctx.restore();
  }

  // ---------- Elements & pages ----------
  R.drawEl = function (ctx, el, o = {}) {
    if (el.type === 'text') R.syncText(el);
    ctx.save();
    ctx.globalAlpha *= el.op ?? 1;
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    if (el.rot) ctx.rotate(el.rot * GS.RAD);
    if (el.fx || el.fy) ctx.scale(el.fx ? -1 : 1, el.fy ? -1 : 1);
    ctx.translate(-el.w / 2, -el.h / 2);
    setShadow(ctx, el.shadow, o.scale || 1);
    try {
      if (el.type === 'text') drawText(ctx, el, o);
      else if (el.type === 'shape') drawShape(ctx, el, o);
      else if (el.type === 'image') drawImageEl(ctx, el, o);
      else if (el.type === 'line') drawLine(ctx, el, o);
      else if (el.type === 'icon') drawIcon(ctx, el, o);
    } catch (err) { console.warn('draw failed', el.type, err); }
    ctx.restore();
  };

  R.drawBg = function (ctx, bg, W, H, o = {}) {
    bg = bg || {};
    ctx.save();
    ctx.fillStyle = bg.grad ? R.linGrad(ctx, W, H, bg.grad) : bg.color || '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
    if (bg.img && bg.img.src) {
      const e = R.getImg(bg.img.src);
      if (e) {
        const src = R.hasFilt(bg.img.filt) ? filtered(bg.img.src, e, bg.img.filt, o.exporting ? 6000 : 1600) : e.img;
        const k = (src.width || e.w) / e.w;
        const s = Math.max(W / e.w, H / e.h), dw = e.w * s, dh = e.h * s;
        const dx = (W - dw) * (bg.img.x ?? 0.5), dy = (H - dh) * (bg.img.y ?? 0.5);
        ctx.drawImage(src, (-dx / s) * k, (-dy / s) * k, (W / s) * k, (H / s) * k, 0, 0, W, H);
      }
      if (bg.img.dim) { ctx.fillStyle = `rgba(0,0,0,${bg.img.dim})`; ctx.fillRect(0, 0, W, H); }
    }
    ctx.restore();
  };

  R.drawPage = function (ctx, design, page, o = {}) {
    if (!o.transparent) R.drawBg(ctx, page.bg, design.w, design.h, o);
    for (const el of page.els) {
      if (el.hidden || (o.skip && o.skip.has(el.id))) continue;
      R.drawEl(ctx, el, Object.assign({}, o, { cropGhost: o.cropId === el.id }));
    }
  };

  R.thumb = function (design, page, maxW, maxH, cv) {
    const s = Math.min(maxW / design.w, (maxH || maxW) / design.h);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv = cv || document.createElement('canvas');
    const w = Math.max(1, Math.round(design.w * s * dpr)), h = Math.max(1, Math.round(design.h * s * dpr));
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    cv.style.aspectRatio = design.w + ' / ' + design.h;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, design.w, design.h); ctx.clip();
    R.drawPage(ctx, design, page, { scale: s * dpr });
    ctx.restore();
    return cv;
  };

  // ---------- Geometry ----------
  R.corners = function (el) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = (el.rot || 0) * GS.RAD, co = Math.cos(a), si = Math.sin(a);
    return [[-el.w / 2, -el.h / 2], [el.w / 2, -el.h / 2], [el.w / 2, el.h / 2], [-el.w / 2, el.h / 2]].map(([x, y]) => [cx + x * co - y * si, cy + x * si + y * co]);
  };
  R.bounds = function (els) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) for (const [x, y] of R.corners(el)) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  R.hit = function (el, px, py, tol = 0) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = -(el.rot || 0) * GS.RAD;
    const dx = px - cx, dy = py - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    const extra = el.type === 'line' ? Math.max(tol, 8) : tol;
    return Math.abs(lx) <= el.w / 2 + tol && Math.abs(ly) <= el.h / 2 + extra;
  };
})();
