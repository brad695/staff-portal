/* GREYS Studio — editor engine: state, history, stage interaction, transforms */
(function () {
  const GS = window.GS, R = GS.R;
  const E = (GS.E = {
    design: null, pi: 0, sel: [], zoom: 1, panX: 0, panY: 0, sw: 800, sh: 600, dpr: 1, autoFit: true,
    hover: null, editing: null, cropping: null, guides: [], marquee: null, tip: null,
    hist: [], hi: -1, clip: null, dirty: false, saving: false, pointers: new Map(), replaceTarget: null,
  });
  const MIN = 4;

  // ---------- accessors ----------
  E.page = () => E.design.pages[E.pi];
  E.els = () => E.page().els;
  E.byId = (id) => E.design && E.els().find((e) => e.id === id);
  E.selEls = () => E.sel.map(E.byId).filter(Boolean);
  E.u = () => Math.sqrt(E.design.w * E.design.h) / 1080;
  E.groupIds = (el) => (el.gid ? E.els().filter((e) => e.gid === el.gid).map((e) => e.id) : [el.id]);
  E.elName = function (el) {
    if (el.type === 'text') return (el.text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Text';
    if (el.type === 'shape') return (GS.SHAPES[el.shape] || {}).label || 'Shape';
    if (el.type === 'icon') return (GS.ICONS[el.icon] || {}).label || 'Graphic';
    if (el.type === 'line') return 'Line';
    if (el.type === 'image') return el.src ? (el.fit === 'contain' ? 'Graphic' : 'Photo') : 'Photo frame';
    return 'Element';
  };
  const toScreen = (x, y) => [E.panX + x * E.zoom, E.panY + y * E.zoom];
  const toDesign = (sx, sy) => [(sx - E.panX) / E.zoom, (sy - E.panY) / E.zoom];
  E.toScreen = toScreen; E.toDesign = toDesign;

  // ---------- mount ----------
  E.mount = function (stage) {
    E.stage = stage;
    E.cv = GS.h('canvas', { class: 'view', 'aria-label': 'Design canvas' });
    E.ov = GS.h('div', { class: 'ov' });
    E.ovSel = GS.h('div', { class: 'ov-sel' });
    E.ov.append(E.ovSel);
    stage.append(E.cv, E.ov);
    E.ctx = E.cv.getContext('2d');
    new ResizeObserver(() => { sizeCanvas(); if (E.design) { if (E.autoFit) E.fit(); else E.render(); } }).observe(stage);
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('pointerleave', () => { if (!drag && E.hover) { E.hover = null; drawOverlay(); } });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dragover', (e) => { e.preventDefault(); });
    stage.addEventListener('drop', onDrop);
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    GS.bus.on('fontsloaded', () => E.render());
    GS.bus.on('imgloaded', () => E.render());
  };
  function sizeCanvas() {
    const r = E.stage.getBoundingClientRect();
    E.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    E.sw = Math.max(1, r.width); E.sh = Math.max(1, r.height);
    E.cv.width = Math.round(E.sw * E.dpr); E.cv.height = Math.round(E.sh * E.dpr);
    E.cv.style.width = E.sw + 'px'; E.cv.style.height = E.sh + 'px';
  }

  // ---------- open / history / save ----------
  const snap = () => JSON.stringify({ w: E.design.w, h: E.design.h, unit: E.design.unit, pages: E.design.pages });
  E.open = function (design) {
    E.design = design;
    E.pi = 0; E.sel = []; E.editing = null; E.cropping = null; E.hover = null; E.replaceTarget = null;
    E.hist = [snap()]; E.hi = 0; E.dirty = false;
    design.pages.forEach((p) => p.els.forEach((el) => R.syncText(el)));
    sizeCanvas(); E.fit();
    R.preload(design);
    GS.bus.emit('design'); GS.bus.emit('sel'); GS.bus.emit('pages'); GS.bus.emit('history');
  };
  E.close = async function () {
    if (!E.design) return;
    E.endEdit(); E.endCrop();
    if (E.dirty) await E.save();
    E.design = null;
  };
  E.commit = function () {
    if (!E.design) return;
    const s = snap();
    if (s === E.hist[E.hi]) return;
    E.hist = E.hist.slice(0, E.hi + 1);
    E.hist.push(s);
    if (E.hist.length > 120) E.hist.shift();
    E.hi = E.hist.length - 1;
    E.markDirty();
    GS.bus.emit('history');
  };
  function restore(s) {
    const o = JSON.parse(s);
    E.design.w = o.w; E.design.h = o.h; E.design.unit = o.unit; E.design.pages = o.pages;
    E.pi = GS.clamp(E.pi, 0, o.pages.length - 1);
    E.sel = E.sel.filter((id) => E.byId(id));
    E.markDirty();
    E.render();
    GS.bus.emit('sel'); GS.bus.emit('pages'); GS.bus.emit('history');
  }
  E.undo = () => { E.endEdit(); E.endCrop(); if (E.hi > 0) restore(E.hist[--E.hi]); };
  E.redo = () => { E.endEdit(); E.endCrop(); if (E.hi < E.hist.length - 1) restore(E.hist[++E.hi]); };
  const saveSoon = GS.debounce(() => E.save(), 1200);
  E.markDirty = function () {
    E.dirty = true;
    GS.bus.emit('save', 'dirty');
    saveSoon();
    GS.bus.emit('pagesdirty');
  };
  function thumbData() {
    const d = E.design, s = Math.min(280 / d.w, 280 / d.h);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(d.w * s)); cv.height = Math.max(1, Math.round(d.h * s));
    const ctx = cv.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    R.drawPage(ctx, d, d.pages[0], { scale: s });
    try { return cv.toDataURL('image/jpeg', 0.74); } catch (e) { return ''; }
  }
  E.save = async function () {
    if (!E.design || !E.dirty) return;
    if (E.saving) { E.saveAgain = true; return; }
    E.saving = true; E.dirty = false;
    GS.bus.emit('save', 'saving');
    try {
      await GS.Store.saveDesign(E.design, thumbData());
      GS.bus.emit('save', 'saved');
    } catch (e) {
      E.dirty = true;
      GS.bus.emit('save', 'error', e);
    }
    E.saving = false;
    if (E.saveAgain) { E.saveAgain = false; if (E.dirty) saveSoon(); }
  };

  // ---------- view ----------
  E.fit = function () {
    if (!E.design) return;
    const pad = GS.isMobile() ? 18 : 44;
    const z = Math.min((E.sw - pad * 2) / E.design.w, (E.sh - pad * 2) / E.design.h);
    E.zoom = GS.clamp(z, 0.02, 8);
    E.panX = (E.sw - E.design.w * E.zoom) / 2;
    E.panY = (E.sh - E.design.h * E.zoom) / 2;
    E.autoFit = true;
    E.render();
    GS.bus.emit('zoom');
  };
  function clampPan() {
    const pw = E.design.w * E.zoom, ph = E.design.h * E.zoom, m = 60;
    const lx = Math.min(m - pw, (E.sw - pw) / 2), hx = Math.max(E.sw - m, (E.sw - pw) / 2);
    const ly = Math.min(m - ph, (E.sh - ph) / 2), hy = Math.max(E.sh - m, (E.sh - ph) / 2);
    E.panX = GS.clamp(E.panX, lx, hx); E.panY = GS.clamp(E.panY, ly, hy);
  }
  E.zoomTo = function (z, ax = E.sw / 2, ay = E.sh / 2) {
    const dx = (ax - E.panX) / E.zoom, dy = (ay - E.panY) / E.zoom;
    E.zoom = GS.clamp(z, 0.03, 8);
    E.panX = ax - dx * E.zoom; E.panY = ay - dy * E.zoom;
    E.autoFit = false;
    clampPan();
    E.render();
    GS.bus.emit('zoom');
  };

  let rq = false;
  E.render = function () {
    if (rq) return;
    rq = true;
    requestAnimationFrame(() => { rq = false; draw(); drawOverlay(); });
  };
  function draw() {
    if (!E.design) return;
    const ctx = E.ctx, d = E.design, pg = E.page(), s = E.zoom * E.dpr, ox = E.panX * E.dpr, oy = E.panY * E.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#E6E9ED';
    ctx.fillRect(0, 0, E.cv.width, E.cv.height);
    ctx.save();
    ctx.shadowColor = 'rgba(16,30,44,.18)'; ctx.shadowBlur = 20 * E.dpr; ctx.shadowOffsetY = 4 * E.dpr;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(ox, oy, d.w * s, d.h * s);
    ctx.restore();
    const skip = new Set();
    if (E.editing) skip.add(E.editing);
    ctx.save();
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.globalAlpha = 0.2;
    for (const el of pg.els) {
      if (el.hidden || skip.has(el.id)) continue;
      const b = R.bounds([el]);
      if (b.x < -0.5 || b.y < -0.5 || b.x + b.w > d.w + 0.5 || b.y + b.h > d.h + 0.5) R.drawEl(ctx, el, { scale: s });
    }
    ctx.restore();
    ctx.save();
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.beginPath(); ctx.rect(0, 0, d.w, d.h); ctx.clip();
    R.drawPage(ctx, d, pg, { scale: s, skip, cropId: E.cropping });
    ctx.restore();
  }

  // ---------- overlay (selection UI in screen space) ----------
  const HANDLES = { tl: [-1, -1], tm: [0, -1], tr: [1, -1], ml: [-1, 0], mr: [1, 0], bl: [-1, 1], bm: [0, 1], br: [1, 1] };
  const HANG = { mr: 0, br: 45, bm: 90, bl: 135, ml: 180, tl: 225, tm: 270, tr: 315 };
  const CURS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  function cursorFor(hk, rot) { const a = ((((HANG[hk] + rot) % 180) + 180) % 180); return CURS[Math.round(a / 45) % 4]; }
  function handleSet(el) {
    if (el.lock) return [];
    if (el.type === 'line') return ['ml', 'mr'];
    if (el.type === 'text') return el.curve ? ['tl', 'tr', 'bl', 'br'] : ['tl', 'tr', 'bl', 'br', 'ml', 'mr'];
    if (el.type === 'image' && el.fit === 'contain') return ['tl', 'tr', 'bl', 'br'];
    return Object.keys(HANDLES);
  }
  function boxStyle(x, y, w, h, rot) {
    const [cx, cy] = toScreen(x + w / 2, y + h / 2), W = w * E.zoom, H = h * E.zoom;
    return `left:${cx - W / 2}px;top:${cy - H / 2}px;width:${W}px;height:${H}px;transform:rotate(${rot || 0}deg)`;
  }
  function drawOverlay() {
    if (!E.design) { E.ovSel.innerHTML = ''; return; }
    let html = '';
    const sel = E.selEls();
    if (E.hover && !E.sel.includes(E.hover) && !drag) {
      const el = E.byId(E.hover);
      if (el) html += `<div class="hov" style="${boxStyle(el.x, el.y, el.w, el.h, el.rot)}"></div>`;
    }
    const moving = drag && drag.moved && drag.kind === 'move';
    if (sel.length === 1 && !E.editing) {
      const el = sel[0];
      const crop = E.cropping === el.id;
      html += `<div class="sbox${el.lock ? ' locked' : ''}${crop ? ' crop' : ''}" style="${boxStyle(el.x, el.y, el.w, el.h, el.rot)}">`;
      if (!moving && !crop) {
        for (const hk of handleSet(el)) html += `<div class="hd ${hk}${el.type === 'text' && (hk === 'ml' || hk === 'mr') ? ' bar' : ''}" data-h="${hk}" style="cursor:${cursorFor(hk, el.rot || 0)}"></div>`;
        if (!el.lock) html += `<div class="rot" data-h="rot" title="Rotate">${GS.icon('replace', 14)}</div>`;
      }
      if (el.lock) html += `<div class="lockb">${GS.icon('lock', 12)}</div>`;
      html += '</div>';
    } else if (sel.length > 1) {
      for (const el of sel) html += `<div class="sbox thin" style="${boxStyle(el.x, el.y, el.w, el.h, el.rot)}"></div>`;
      const b = R.bounds(sel);
      html += `<div class="sbox group" style="${boxStyle(b.x, b.y, b.w, b.h, 0)}">`;
      if (!moving && !sel.some((e) => e.lock)) {
        for (const hk of ['tl', 'tr', 'bl', 'br']) html += `<div class="hd ${hk}" data-h="${hk}" style="cursor:${cursorFor(hk, 0)}"></div>`;
        html += `<div class="rot" data-h="rot" title="Rotate">${GS.icon('replace', 14)}</div>`;
      }
      html += '</div>';
    }
    if (E.editing) {
      const el = E.byId(E.editing);
      if (el) html += `<div class="sbox editing" style="${boxStyle(el.x, el.y, el.w, el.h, el.rot)}"></div>`;
    }
    const [px0, py0] = toScreen(0, 0), [px1, py1] = toScreen(E.design.w, E.design.h);
    for (const g of E.guides) {
      if (g.x != null) { const [sx] = toScreen(g.x, 0); html += `<div class="guide v" style="left:${sx}px;top:${py0}px;height:${py1 - py0}px"></div>`; }
      else { const [, sy] = toScreen(0, g.y); html += `<div class="guide h" style="top:${sy}px;left:${px0}px;width:${px1 - px0}px"></div>`; }
    }
    if (E.marquee) {
      const m = E.marquee, [a, b] = toScreen(m.x, m.y);
      html += `<div class="marq" style="left:${a}px;top:${b}px;width:${m.w * E.zoom}px;height:${m.h * E.zoom}px"></div>`;
    }
    if (E.tip) html += `<div class="tip" style="left:${E.tip.x}px;top:${E.tip.y}px">${E.tip.t}</div>`;
    E.ovSel.innerHTML = html;
    if (E.editing && E.ta) positionTA();
  }

  // ---------- selection ----------
  E.select = function (ids) {
    if (E.editing && !ids.includes(E.editing)) E.endEdit();
    if (E.cropping && !ids.includes(E.cropping)) E.endCrop();
    E.sel = [...new Set(ids)];
    E.replaceTarget = null;
    E.render();
    GS.bus.emit('sel');
  };
  E.hitTest = function (px, py) {
    const els = E.els();
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.hidden) continue;
      if (R.hit(el, px, py, 3 / E.zoom)) return el;
    }
    return null;
  };
  E.selectAll = () => E.select(E.els().filter((e) => !e.hidden).map((e) => e.id));

  // ---------- pointer interaction ----------
  let drag = null;
  function stagePt(e) { const r = E.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  function onDown(e) {
    if (!E.design) return;
    if (e.button === 2) return;
    if (e.target.closest && e.target.closest('textarea.ta')) return;
    GS.pop.close();
    E.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { E.stage.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    if (E.pointers.size === 2) { startPinch(); return; }
    if (E.pointers.size > 2) return;
    const [sx, sy] = stagePt(e), [px, py] = toDesign(sx, sy);
    const hEl = e.target.closest && e.target.closest('[data-h]');
    if (E.editing) E.endEdit();
    if (hEl) { startHandle(hEl.dataset.h, sx, sy, e); return; }
    if (E.cropping) {
      const el = E.byId(E.cropping);
      if (el && R.hit(el, px, py)) { startCropPan(el, sx, sy); return; }
      E.endCrop();
    }
    const hit = E.hitTest(px, py);
    if (hit) {
      const now = performance.now();
      const lt = E.lastTap;
      const dbl = !!(lt && now - lt.t < 380 && lt.id === hit.id && Math.hypot(sx - lt.x, sy - lt.y) < 12);
      E.lastTap = dbl ? null : { t: now, id: hit.id, x: sx, y: sy };
      const wasSole = E.sel.length === 1 && E.sel[0] === hit.id;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const ids = E.groupIds(hit);
        const on = E.sel.includes(hit.id);
        E.select(on ? E.sel.filter((id) => !ids.includes(id)) : E.sel.concat(ids));
      } else if (!E.sel.includes(hit.id)) E.select(E.groupIds(hit));
      drag = { kind: 'move', sx, sy, moved: false, wasSole, dbl, hitId: hit.id, shift: e.shiftKey, starts: E.selEls().map((el) => ({ id: el.id, x: el.x, y: el.y })) };
      prepSnap();
    } else {
      E.lastTap = null;
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) E.select([]);
      if (e.pointerType === 'mouse') drag = { kind: 'marquee', sx, sy, base: e.shiftKey ? [...E.sel] : [] };
      else drag = { kind: 'pan', sx, sy, panX: E.panX, panY: E.panY };
    }
  }

  function onDouble(el) {
    if (el.lock) return;
    if (el.type === 'text') { E.select([el.id]); E.startEdit(el.id); }
    else if (el.type === 'image') {
      E.select([el.id]);
      if (!el.src) GS.bus.emit('pickimage', el.id);
      else E.startCrop(el.id);
    } else E.select([el.id]);
  }

  function onMove(e) {
    if (!E.design) return;
    if (E.pointers.has(e.pointerId)) E.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { doPinch(); return; }
    const [sx, sy] = stagePt(e);
    if (!drag) {
      if (e.pointerType === 'mouse') {
        const [px, py] = toDesign(sx, sy);
        const hit = e.target.closest && e.target.closest('[data-h]') ? null : E.hitTest(px, py);
        const hv = hit && !E.sel.includes(hit.id) ? hit.id : null;
        E.stage.style.cursor = hit && !hit.lock ? 'move' : 'default';
        if (hv !== E.hover) { E.hover = hv; drawOverlay(); }
      }
      return;
    }
    const k = drag.kind;
    if (k === 'move') moveDrag(sx, sy, e);
    else if (k === 'resize') resizeDrag(sx, sy, e);
    else if (k === 'rotate') rotateDrag(sx, sy, e);
    else if (k === 'marquee') marqueeDrag(sx, sy);
    else if (k === 'pan') { E.panX = drag.panX + (sx - drag.sx); E.panY = drag.panY + (sy - drag.sy); E.autoFit = false; clampPan(); E.render(); }
    else if (k === 'crop') cropDrag(sx, sy);
  }

  function onUp(e) {
    E.pointers.delete(e.pointerId);
    if (pinch) { if (E.pointers.size < 2) pinch = null; return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    E.guides = []; E.tip = null; E.marquee = null;
    if (d.kind === 'move') {
      if (d.moved) E.commit();
      else if (d.dbl) { const el = E.byId(d.hitId); if (el) onDouble(el); }
      else if (d.wasSole && !d.shift) {
        const el = E.byId(d.hitId);
        if (el && el.type === 'text' && !el.lock) E.startEdit(el.id);
      }
    } else if (d.kind === 'resize' || d.kind === 'rotate' || d.kind === 'crop') E.commit();
    E.render();
    GS.bus.emit('sel');
  }

  // ----- move + snapping -----
  let snapT = null;
  function prepSnap() {
    const d = E.design, ids = new Set(E.sel);
    const xs = [0, d.w / 2, d.w], ys = [0, d.h / 2, d.h];
    for (const el of E.els()) {
      if (ids.has(el.id) || el.hidden) continue;
      const b = R.bounds([el]);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w); ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    snapT = { xs, ys };
  }
  function snapAxis(vals, targets, thr) {
    let best = null;
    for (const v of vals) for (const t of targets) { const dlt = t - v; if (Math.abs(dlt) <= thr && (!best || Math.abs(dlt) < Math.abs(best.d))) best = { d: dlt, t }; }
    return best;
  }
  function moveDrag(sx, sy, e) {
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
    if (!drag.moved) { drag.moved = true; E.hover = null; }
    const els = E.selEls();
    if (els.some((el) => el.lock)) return;
    let dx = (sx - drag.sx) / E.zoom, dy = (sy - drag.sy) / E.zoom;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    E.guides = [];
    if (!e.altKey && snapT) {
      const starts = drag.starts.map((s) => Object.assign({}, E.byId(s.id), { x: s.x, y: s.y }));
      const b = R.bounds(starts);
      const thr = 6 / E.zoom;
      const bx = snapAxis([b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w], snapT.xs, thr);
      const by = snapAxis([b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h], snapT.ys, thr);
      if (bx) { dx += bx.d; E.guides.push({ x: bx.t }); }
      if (by) { dy += by.d; E.guides.push({ y: by.t }); }
    }
    for (const s of drag.starts) { const el = E.byId(s.id); if (el) { el.x = s.x + dx; el.y = s.y + dy; } }
    E.render();
  }

  // ----- handles -----
  function startHandle(hk, sx, sy, e) {
    const sel = E.selEls();
    if (!sel.length || sel.some((el) => el.lock)) return;
    const [px, py] = toDesign(sx, sy);
    if (hk === 'rot') {
      const b = sel.length === 1 ? { x: sel[0].x, y: sel[0].y, w: sel[0].w, h: sel[0].h } : R.bounds(sel);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      drag = { kind: 'rotate', cx, cy, a0: Math.atan2(py - cy, px - cx), starts: sel.map((el) => ({ id: el.id, x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot || 0 })) };
      return;
    }
    prepSnap();
    if (sel.length === 1) {
      const el = sel[0];
      drag = { kind: 'resize', hk, single: true, st: GS.clone(el) };
    } else {
      const b = R.bounds(sel);
      drag = { kind: 'resize', hk, single: false, b, starts: sel.map((el) => GS.clone(el)) };
    }
  }
  function resizeDrag(sx, sy, e) {
    const [px, py] = toDesign(sx, sy);
    const [hx, hy] = HANDLES[drag.hk];
    if (drag.single) {
      const st = drag.st, el = E.byId(st.id);
      if (!el) return;
      const th = (st.rot || 0) * GS.RAD, co = Math.cos(th), si = Math.sin(th);
      const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
      const ax = cx + co * (-hx * st.w / 2) - si * (-hy * st.h / 2);
      const ay = cy + si * (-hx * st.w / 2) + co * (-hy * st.h / 2);
      const dxl = (px - ax) * co + (py - ay) * si, dyl = -(px - ax) * si + (py - ay) * co;
      let w = hx ? Math.max(MIN, hx * dxl) : st.w, h = hy ? Math.max(MIN, hy * dyl) : st.h;
      const corner = hx && hy;
      const keep = corner && (st.type === 'text' || st.type === 'image' ? true : st.type === 'icon' ? !e.shiftKey : e.shiftKey);
      let s = 1;
      if (corner && keep) {
        s = (hx * dxl * st.w + hy * dyl * st.h) / (st.w * st.w + st.h * st.h);
        s = Math.max(s, MIN / Math.min(st.w, st.h));
        w = st.w * s; h = st.h * s;
      }
      let offY = hy * h / 2;
      if (st.type === 'text') {
        if (corner) {
          s = w / st.w;
          el.size = Math.max(1, st.size * s);
          if (st.stroke) el.stroke = Object.assign({}, st.stroke, { w: st.stroke.w * s });
          if (st.shadow) el.shadow = Object.assign({}, st.shadow, { b: st.shadow.b * s, x: st.shadow.x * s, y: st.shadow.y * s });
        }
        el.w = w;
        if (el.curve) { R.syncText(el); w = el.w; h = el.h; }
        else { R.syncText(el); h = el.h; if (!corner) offY = (h - st.h) / 2; }
      } else if (st.type === 'line') { h = st.h; offY = 0; }
      // snap moving edges for unrotated, free resizes
      E.guides = [];
      if (!st.rot && !(corner && keep) && snapT && !e.altKey && st.type !== 'text') {
        const thr = 6 / E.zoom;
        if (hx) {
          const edge = hx > 0 ? ax + w : ax - w;
          const sn = snapAxis([edge], snapT.xs, thr);
          if (sn) { w += hx * sn.d; E.guides.push({ x: sn.t }); }
        }
        if (hy) {
          const edge = hy > 0 ? ay + h : ay - h;
          const sn = snapAxis([edge], snapT.ys, thr);
          if (sn) { h += hy * sn.d; offY = hy * h / 2; E.guides.push({ y: sn.t }); }
        }
      }
      const ncx = ax + co * (hx * w / 2) - si * offY, ncy = ay + si * (hx * w / 2) + co * offY;
      el.x = ncx - w / 2; el.y = ncy - h / 2; el.w = w; el.h = h;
      E.tip = { x: sx + 16, y: sy + 16, t: st.type === 'text' && corner ? Math.round(el.size) + ' pt' : `${Math.round(w)} × ${Math.round(h)}` };
    } else {
      const b = drag.b;
      const ax = hx > 0 ? b.x : b.x + b.w, ay = hy > 0 ? b.y : b.y + b.h;
      const dxl = px - ax, dyl = py - ay;
      let s = (hx * dxl * b.w + hy * dyl * b.h) / (b.w * b.w + b.h * b.h);
      s = Math.max(s, 0.05);
      for (const st of drag.starts) {
        const el = E.byId(st.id);
        if (!el) continue;
        const cx = ax + (st.x + st.w / 2 - ax) * s, cy = ay + (st.y + st.h / 2 - ay) * s;
        el.w = st.w * s; el.h = st.h * s;
        if (st.type === 'text') { el.size = st.size * s; if (st.stroke) el.stroke = Object.assign({}, st.stroke, { w: st.stroke.w * s }); R.syncText(el); }
        if (st.type === 'line') el.h = st.h;
        if (st.type === 'shape' && st.r) el.r = st.r * s;
        el.x = cx - el.w / 2; el.y = cy - el.h / 2;
      }
      E.tip = { x: sx + 16, y: sy + 16, t: Math.round(s * 100) + '%' };
    }
    E.render();
  }
  function normRot(r) { r = ((r % 360) + 360) % 360; return r > 180 ? r - 360 : r; }
  function rotateDrag(sx, sy, e) {
    const [px, py] = toDesign(sx, sy);
    let delta = (Math.atan2(py - drag.cy, px - drag.cx) - drag.a0) / GS.RAD;
    const single = drag.starts.length === 1;
    const snapTo = (r) => {
      if (e.shiftKey) return Math.round(r / 15) * 15;
      for (const t of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) if (Math.abs(r - t) < 3) return t;
      return r;
    };
    if (single) {
      const st = drag.starts[0], el = E.byId(st.id);
      el.rot = normRot(snapTo(normRot(st.rot + delta)));
      E.tip = { x: sx + 18, y: sy + 18, t: Math.round(el.rot) + '°' };
    } else {
      delta = snapTo(normRot(delta));
      const a = delta * GS.RAD, co = Math.cos(a), si = Math.sin(a);
      for (const st of drag.starts) {
        const el = E.byId(st.id);
        const cx = st.x + st.w / 2 - drag.cx, cy = st.y + st.h / 2 - drag.cy;
        const nx = drag.cx + cx * co - cy * si, ny = drag.cy + cx * si + cy * co;
        el.x = nx - el.w / 2; el.y = ny - el.h / 2; el.rot = normRot(st.rot + delta);
      }
      E.tip = { x: sx + 18, y: sy + 18, t: Math.round(delta) + '°' };
    }
    E.render();
  }
  function marqueeDrag(sx, sy) {
    const [x0, y0] = toDesign(drag.sx, drag.sy), [x1, y1] = toDesign(sx, sy);
    const m = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    E.marquee = m;
    if (Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
    const hits = new Set(drag.base);
    for (const el of E.els()) {
      if (el.hidden) continue;
      const b = R.bounds([el]);
      if (b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y) E.groupIds(el).forEach((id) => hits.add(id));
    }
    E.sel = [...hits];
    E.render();
    GS.bus.emit('sel');
  }

  // ----- crop -----
  E.startCrop = function (id) {
    const el = E.byId(id);
    if (!el || el.type !== 'image' || !el.src || el.fit === 'contain' || el.lock) return;
    E.endEdit();
    E.cropping = id; E.sel = [id];
    el.crop = el.crop || { z: 1, x: 0.5, y: 0.5 };
    E.render(); GS.bus.emit('sel');
  };
  E.endCrop = function () {
    if (!E.cropping) return;
    E.cropping = null;
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  function startCropPan(el, sx, sy) {
    const e = R.getImg(el.src);
    if (!e) return;
    const cr = el.crop || (el.crop = { z: 1, x: 0.5, y: 0.5 });
    const s = Math.max(el.w / e.w, el.h / e.h) * (cr.z || 1);
    drag = { kind: 'crop', id: el.id, sx, sy, x: cr.x ?? 0.5, y: cr.y ?? 0.5, ex: el.w - e.w * s, ey: el.h - e.h * s, rot: (el.rot || 0) * GS.RAD };
  }
  function cropDrag(sx, sy) {
    const el = E.byId(drag.id);
    if (!el) return;
    let dx = (sx - drag.sx) / E.zoom, dy = (sy - drag.sy) / E.zoom;
    const co = Math.cos(-drag.rot), si = Math.sin(-drag.rot);
    const lx = dx * co - dy * si, ly = dx * si + dy * co;
    const nx = drag.ex < -0.5 ? GS.clamp(drag.x + lx / drag.ex, 0, 1) : 0.5;
    const ny = drag.ey < -0.5 ? GS.clamp(drag.y + ly / drag.ey, 0, 1) : 0.5;
    el.crop = Object.assign({}, el.crop, { x: nx, y: ny });
    E.render();
  }

  // ----- pinch / wheel -----
  let pinch = null;
  function startPinch() {
    if (drag && drag.moved) E.commit();
    drag = null; E.guides = []; E.tip = null;
    const [a, b] = [...E.pointers.values()];
    const r = E.stage.getBoundingClientRect();
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, z0: E.zoom, px: E.panX, py: E.panY };
  }
  function doPinch() {
    const pts = [...E.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts, r = E.stage.getBoundingClientRect();
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const z = GS.clamp(pinch.z0 * (d / pinch.d0), 0.03, 8);
    const dx = (pinch.mx - pinch.px) / pinch.z0, dy = (pinch.my - pinch.py) / pinch.z0;
    E.zoom = z; E.panX = mx - dx * z; E.panY = my - dy * z; E.autoFit = false;
    clampPan(); E.render(); GS.bus.emit('zoom');
  }
  function onWheel(e) {
    if (!E.design) return;
    e.preventDefault();
    const [sx, sy] = stagePt(e);
    if (e.ctrlKey || e.metaKey) E.zoomTo(E.zoom * Math.exp(-e.deltaY * 0.0025), sx, sy);
    else { E.panX -= e.deltaX; E.panY -= e.deltaY; E.autoFit = false; clampPan(); E.render(); }
  }

  // ----- drop (files from desktop or photos from the panel) -----
  async function onDrop(e) {
    e.preventDefault();
    if (!E.design) return;
    const [sx, sy] = stagePt(e), [px, py] = toDesign(sx, sy);
    const target = E.hitTest(px, py);
    const frame = target && target.type === 'image' && !target.lock ? target : null;
    const ref = e.dataTransfer.getData('text/x-greys-ref');
    if (ref) {
      const rec = JSON.parse(ref);
      if (frame && frame.fit !== 'contain') { E.fillFrame(frame.id, rec.ref); return; }
      E.addImage(rec, { at: { x: px, y: py }, contain: rec.contain });
      return;
    }
    const files = [...(e.dataTransfer.files || [])].filter((f) => /^image\//.test(f.type));
    for (const f of files) {
      try {
        GS.toast('Uploading ' + (f.name || 'image') + '…');
        const rec = await GS.Store.putImage(f);
        if (frame && files.length === 1) E.fillFrame(frame.id, rec.ref);
        else E.addImage(rec, { at: { x: px, y: py } });
      } catch (err) { GS.toast(err.message || 'Upload failed', 'err'); }
    }
  }

  // ---------- text editing ----------
  E.startEdit = function (id) {
    const el = E.byId(id);
    if (!el || el.type !== 'text' || el.lock) return;
    if (E.editing === id) return;
    E.endEdit(); E.endCrop();
    E.sel = [id]; E.editing = id;
    const ta = GS.h('textarea', { class: 'ta', spellcheck: 'true', 'aria-label': 'Edit text', autocapitalize: 'sentences' });
    ta.value = el.text;
    E.ov.append(ta);
    E.ta = ta;
    positionTA();
    ta.addEventListener('input', () => { el.text = ta.value; R.syncText(el); positionTA(); E.render(); });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) { ev.preventDefault(); E.endEdit(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (E.editing === id && document.activeElement !== ta) E.endEdit(); }, 120));
    ta.focus({ preventScroll: true });
    if (E.justAdded === id) ta.select();
    else { const n = ta.value.length; ta.setSelectionRange(n, n); }
    E.justAdded = null;
    E.render();
    GS.bus.emit('sel');
  };
  function positionTA() {
    const el = E.byId(E.editing), ta = E.ta;
    if (!el || !ta) return;
    const z = E.zoom;
    const L = el.curve ? null : R.textLayout(el);
    const w = (el.curve ? Math.max(el.w, el.size * 6) : el.w) * z;
    const h = Math.max(L ? L.height : el.size * (el.lh || 1.2), el.size * (el.lh || 1.2)) * z;
    const [cx, cy] = toScreen(el.x + el.w / 2, el.y + el.h / 2);
    ta.style.font = GS.fontStr(el, el.size * z);
    Object.assign(ta.style, {
      left: cx - w / 2 + 'px', top: (el.curve ? cy - h / 2 : cy - (el.h * z) / 2) + 'px', width: w + 'px', height: h + 'px',
      transform: el.curve ? 'none' : `rotate(${el.rot || 0}deg)`, transformOrigin: `50% ${(el.h * z) / 2}px`,
      lineHeight: String(el.lh || 1.2), letterSpacing: (((el.ls || 0) / 1000) * el.size * z) + 'px',
      color: el.hollow ? (el.stroke && el.stroke.c) || el.color : el.color, textAlign: el.curve ? 'center' : el.align || 'left',
      textTransform: el.upper ? 'uppercase' : 'none', textDecoration: el.under ? 'underline' : 'none', padding: (L ? L.pad * z : 0) + 'px',
      background: el.bgc || 'transparent', caretColor: GS.isDark(el.color || '#000') ? '#1A8CFF' : '#7CC4FF',
    });
  }
  E.endEdit = function () {
    if (!E.editing) return;
    const id = E.editing, el = E.byId(id);
    E.editing = null;
    if (E.ta) { const t = E.ta; E.ta = null; t.remove(); }
    if (el) {
      if (!String(el.text).trim()) { E.page().els = E.els().filter((x) => x.id !== id); E.sel = E.sel.filter((x) => x !== id); }
      else R.syncText(el);
    }
    E.commit(); E.render(); GS.bus.emit('sel');
  };

  // ---------- element operations ----------
  E.add = function (el, opts = {}) {
    if (!E.design) return null;
    E.endEdit(); E.endCrop();
    if (el.type === 'text') R.syncText(el);
    const d = E.design;
    if (opts.at) { el.x = opts.at.x - el.w / 2; el.y = opts.at.y - el.h / 2; }
    else if (!opts.keepPos) {
      el.x = (d.w - el.w) / 2; el.y = (d.h - el.h) / 2;
      const clash = E.els().some((o) => Math.abs(o.x - el.x) < 1 && Math.abs(o.y - el.y) < 1 && o.type === el.type);
      if (clash) { el.x += 24 * E.u(); el.y += 24 * E.u(); }
    }
    E.page().els.push(el);
    E.sel = [el.id];
    E.justAdded = el.id;
    E.commit(); E.render(); GS.bus.emit('sel');
    return el;
  };
  E.addMany = function (els) {
    E.endEdit(); E.endCrop();
    els.forEach((el) => { if (el.type === 'text') R.syncText(el); });
    const b = R.bounds(els), d = E.design;
    const dx = (d.w - b.w) / 2 - b.x, dy = (d.h - b.h) / 2 - b.y;
    els.forEach((el) => { el.x += dx; el.y += dy; E.page().els.push(el); });
    E.sel = els.map((e) => e.id);
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  // patch: object or function(el); live=true skips history (for slider drags)
  E.update = function (patch, opts = {}) {
    const els = opts.ids ? opts.ids.map(E.byId).filter(Boolean) : E.selEls();
    for (const el of els) {
      if (typeof patch === 'function') patch(el);
      else Object.assign(el, GS.clone(patch));
      if (el.type === 'text') R.syncText(el);
    }
    E.render();
    if (!opts.live) { E.commit(); GS.bus.emit('change'); }
  };
  E.del = function () {
    if (E.editing) return;
    const ids = new Set(E.selEls().filter((e) => !e.lock).map((e) => e.id));
    if (!ids.size) return;
    E.page().els = E.els().filter((e) => !ids.has(e.id));
    E.sel = []; E.cropping = null;
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  function cloneEls(els, off) {
    const gmap = {};
    return els.map((e) => {
      const c = GS.clone(e);
      c.id = GS.uid('e'); c.x += off; c.y += off; c.lock = false;
      if (c.gid) c.gid = gmap[c.gid] || (gmap[c.gid] = GS.uid('g'));
      return c;
    });
  }
  E.dup = function () {
    const sel = E.selEls();
    if (!sel.length) return;
    E.endEdit();
    const copies = cloneEls(sel, 20 * E.u());
    E.page().els.push(...copies);
    E.sel = copies.map((c) => c.id);
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.copy = function () { const s = E.selEls(); if (s.length) E.clip = GS.clone(s); return s.length; };
  E.paste = function () {
    if (!E.clip || !E.design) return;
    const copies = cloneEls(E.clip, 20 * E.u());
    E.clip = GS.clone(copies);
    E.page().els.push(...copies);
    E.sel = copies.map((c) => c.id);
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.group = function () {
    const sel = E.selEls();
    if (sel.length < 2) return;
    const g = GS.uid('g');
    sel.forEach((e) => (e.gid = g));
    E.commit(); GS.bus.emit('sel');
  };
  E.ungroup = function () { E.selEls().forEach((e) => delete e.gid); E.commit(); GS.bus.emit('sel'); };
  E.isGroup = () => { const s = E.selEls(); return s.length > 1 && s[0].gid && s.every((e) => e.gid === s[0].gid); };
  E.order = function (how) {
    const els = E.els(), ids = new Set(E.sel);
    const picked = els.filter((e) => ids.has(e.id)), rest = els.filter((e) => !ids.has(e.id));
    let out;
    if (how === 'front') out = rest.concat(picked);
    else if (how === 'back') out = picked.concat(rest);
    else {
      out = els.slice();
      const idx = out.map((e, i) => (ids.has(e.id) ? i : -1)).filter((i) => i >= 0);
      if (how === 'forward') for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; if (i < out.length - 1 && !ids.has(out[i + 1].id)) { [out[i], out[i + 1]] = [out[i + 1], out[i]]; } }
      else for (const i of idx) { if (i > 0 && !ids.has(out[i - 1].id)) { [out[i], out[i - 1]] = [out[i - 1], out[i]]; } }
    }
    E.page().els = out;
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.moveLayer = function (id, toIndex) {
    const els = E.els(), i = els.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [el] = els.splice(i, 1);
    els.splice(GS.clamp(toIndex, 0, els.length), 0, el);
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.align = function (mode) {
    const sel = E.selEls().filter((e) => !e.lock);
    if (!sel.length) return;
    const ref = sel.length === 1 || E.isGroup() ? { x: 0, y: 0, w: E.design.w, h: E.design.h } : R.bounds(sel);
    const units = E.isGroup() ? [sel] : sel.map((e) => [e]);
    for (const u of units) {
      const b = R.bounds(u);
      let dx = 0, dy = 0;
      if (mode === 'left') dx = ref.x - b.x;
      if (mode === 'center') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
      if (mode === 'top') dy = ref.y - b.y;
      if (mode === 'middle') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      u.forEach((e) => { e.x += dx; e.y += dy; });
    }
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.distribute = function (axis) {
    const sel = E.selEls().filter((e) => !e.lock);
    if (sel.length < 3) return;
    const items = sel.map((e) => ({ e, b: R.bounds([e]) })).sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y));
    const first = items[0].b, last = items[items.length - 1].b;
    const total = items.reduce((s, it) => s + (axis === 'h' ? it.b.w : it.b.h), 0);
    const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
    const gap = (span - total) / (items.length - 1);
    let cur = axis === 'h' ? first.x : first.y;
    for (const it of items) {
      if (axis === 'h') { it.e.x += cur - it.b.x; cur += it.b.w + gap; }
      else { it.e.y += cur - it.b.y; cur += it.b.h + gap; }
    }
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.flip = function (axis) { E.update((el) => { if (el.type !== 'text') el[axis === 'h' ? 'fx' : 'fy'] = !el[axis === 'h' ? 'fx' : 'fy']; }); };
  E.toggleLock = function () {
    const sel = E.selEls();
    const lock = !sel.every((e) => e.lock);
    sel.forEach((e) => (e.lock = lock));
    if (lock) { E.endEdit(); E.endCrop(); }
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.nudge = function (dx, dy) {
    const sel = E.selEls().filter((e) => !e.lock);
    if (!sel.length) return;
    sel.forEach((e) => { e.x += dx; e.y += dy; });
    E.render();
    nudgeCommit();
  };
  const nudgeCommit = GS.debounce(() => E.commit(), 500);

  // ---------- images ----------
  E.fillFrame = function (id, ref) {
    const el = E.byId(id);
    if (!el) return;
    el.src = ref; el.crop = { z: 1, x: 0.5, y: 0.5 }; delete el.fit;
    E.sel = [id];
    E.commit(); E.render(); GS.bus.emit('sel');
  };
  E.addImage = function (rec, opts = {}) {
    if (!E.design) return;
    if (E.replaceTarget && E.byId(E.replaceTarget)) { const id = E.replaceTarget; E.replaceTarget = null; E.fillFrame(id, rec.ref); GS.bus.emit('replacemode'); return; }
    const sel = E.selEls();
    if (!opts.at && sel.length === 1 && sel[0].type === 'image' && !sel[0].src && !sel[0].lock) { E.fillFrame(sel[0].id, rec.ref); return; }
    const d = E.design;
    const frac = opts.contain ? 0.4 : 0.6;
    const s = Math.min((d.w * frac) / (rec.w || 800), (d.h * frac) / (rec.h || 800));
    const el = GS.mk.image({ src: rec.ref, w: (rec.w || 800) * s, h: (rec.h || 800) * s });
    if (opts.contain) el.fit = 'contain';
    E.add(el, { at: opts.at });
  };
  E.setAsBackground = function () {
    const el = E.selEls()[0];
    if (!el || el.type !== 'image' || !el.src) return;
    E.page().bg = Object.assign({}, E.page().bg, { img: { src: el.src, x: 0.5, y: 0.5, filt: el.filt && R.hasFilt(el.filt) ? GS.clone(el.filt) : undefined } });
    E.page().els = E.els().filter((e) => e.id !== el.id);
    E.sel = [];
    E.commit(); E.render(); GS.bus.emit('sel'); GS.bus.emit('change');
  };

  // ---------- pages ----------
  E.setPage = function (i) {
    E.endEdit(); E.endCrop();
    E.pi = GS.clamp(i, 0, E.design.pages.length - 1);
    E.sel = [];
    E.render();
    GS.bus.emit('pages'); GS.bus.emit('sel');
  };
  E.addPage = function (pageObj, at) {
    const pages = E.design.pages;
    const p = pageObj || { id: GS.uid('p'), bg: { color: (E.page().bg && E.page().bg.color) || '#FFFFFF' }, els: [] };
    const idx = at == null ? E.pi + 1 : at;
    pages.splice(idx, 0, p);
    E.commit();
    E.setPage(idx);
  };
  E.dupPage = function (i = E.pi) {
    const src = E.design.pages[i];
    const gmap = {};
    const p = { id: GS.uid('p'), bg: GS.clone(src.bg), els: src.els.map((e) => { const c = GS.clone(e); c.id = GS.uid('e'); if (c.gid) c.gid = gmap[c.gid] || (gmap[c.gid] = GS.uid('g')); return c; }) };
    E.addPage(p, i + 1);
  };
  E.delPage = function (i = E.pi) {
    const pages = E.design.pages;
    if (pages.length === 1) { pages[0].els = []; pages[0].bg = { color: '#FFFFFF' }; E.sel = []; }
    else { pages.splice(i, 1); E.pi = GS.clamp(E.pi >= i ? E.pi - 1 : E.pi, 0, pages.length - 1); }
    E.commit(); E.setPage(E.pi);
  };
  E.movePage = function (i, dir) {
    const pages = E.design.pages, j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    E.pi = j;
    E.commit(); E.setPage(j);
  };

  // Scale a page's content from one size to another (centered, uniform)
  E.fitPage = function (page, fw, fh, tw, th, scale = true) {
    const s = scale ? Math.min(tw / fw, th / fh) : 1;
    for (const el of page.els) {
      const cx = (el.x + el.w / 2 - fw / 2) * s + tw / 2, cy = (el.y + el.h / 2 - fh / 2) * s + th / 2;
      el.w *= s; el.h *= s;
      if (el.type === 'text') { el.size *= s; if (el.stroke) el.stroke.w *= s; }
      if (el.type === 'shape' && el.r) el.r *= s;
      if (el.type === 'shape' && el.stroke) el.stroke.w *= s;
      if (el.type === 'line') { el.sw *= s; }
      if (el.shadow) { el.shadow.b *= s; el.shadow.x *= s; el.shadow.y *= s; }
      if (el.border) el.border.w *= s;
      el.x = cx - el.w / 2; el.y = cy - el.h / 2;
    }
    return page;
  };
  E.resizeDesign = function (w, h, unit, scale) {
    const d = E.design;
    E.endEdit(); E.endCrop();
    d.pages.forEach((p) => E.fitPage(p, d.w, d.h, w, h, scale));
    d.w = w; d.h = h; d.unit = unit || 'px';
    d.pages.forEach((p) => p.els.forEach((el) => R.syncText(el)));
    E.sel = [];
    E.commit(); E.fit(); GS.bus.emit('sel'); GS.bus.emit('design');
  };
  E.applyTemplate = function (t, mode) {
    const m = t.make();
    const d = E.design;
    const pages = GS.withIds(m.pages).map((p) => E.fitPage(p, m.w, m.h, d.w, d.h, true));
    if (mode === 'replace') {
      d.pages.splice(E.pi, 1, ...pages);
      E.commit(); E.setPage(E.pi);
    } else {
      d.pages.splice(E.pi + 1, 0, ...pages);
      E.commit(); E.setPage(E.pi + 1);
    }
    R.preload(d);
  };

  // ---------- keyboard ----------
  E.onKey = function (e) {
    if (!E.design) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key;
    const hasSel = E.sel.length > 0;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? E.redo() : E.undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); E.redo(); return; }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); E.save(); return; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); E.selectAll(); return; }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); E.dup(); return; }
    if (mod && k.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? E.ungroup() : E.group(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); E.zoomTo(E.zoom * 1.25); return; }
    if (mod && k === '-') { e.preventDefault(); E.zoomTo(E.zoom / 1.25); return; }
    if (mod && k === '0') { e.preventDefault(); E.fit(); return; }
    if (mod && k === ']') { e.preventDefault(); E.order(e.shiftKey ? 'front' : 'forward'); return; }
    if (mod && k === '[') { e.preventDefault(); E.order(e.shiftKey ? 'back' : 'backward'); return; }
    if (k === 'Escape') {
      if (GS.pop.isOpen()) { GS.pop.close(); return; }
      if (E.cropping) E.endCrop(); else if (hasSel) E.select([]);
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && hasSel) { e.preventDefault(); E.del(); return; }
    if (k === 'Enter' && E.sel.length === 1) { const el = E.selEls()[0]; if (el.type === 'text') { e.preventDefault(); E.startEdit(el.id); } else if (el.type === 'image' && el.src) { e.preventDefault(); E.cropping ? E.endCrop() : E.startCrop(el.id); } return; }
    if (k.startsWith('Arrow') && hasSel) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : 1;
      E.nudge(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0);
      return;
    }
    if (!mod && (k === 't' || k === 'T')) { e.preventDefault(); GS.bus.emit('addtext'); }
  };
})();
