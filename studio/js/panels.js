/* GREYS Studio — drawer panels */
(function () {
  const GS = window.GS, E = GS.E, R = GS.R, h = GS.h;
  const P = (GS.P = { tab: null });
  const NAVY = '#06273A', GOLD = '#E6B33C', CREAM = '#FFF6E3', RIND = '#B87428', LGOLD = '#F6D47F';
  const LS = 'League Spartan', BC = 'Barlow Condensed', NS = 'Nunito Sans', PF = 'Playfair Display';

  GS.PHOTOS = [
    { ref: 'p:board.jpg', w: 720, h: 400, name: 'Charcuterie board' },
    { ref: 'p:spread.jpg', w: 720, h: 400, name: 'Grazing table' },
    { ref: 'p:slate.jpg', w: 720, h: 400, name: 'Board on slate' },
    { ref: 'p:class.jpg', w: 720, h: 400, name: 'Class night' },
    { ref: 'p:closeup.jpg', w: 480, h: 860, name: 'Cheese close-up' },
    { ref: 'p:guests.jpg', w: 480, h: 860, name: 'Guests' },
    { ref: 'p:shop.jpg', w: 364, h: 256, name: 'Nashville shop' },
  ];

  // Bend a text element around a circle of `radius` centered at (cx, cy); dir 1 = over the top, -1 = under
  GS.placeArc = function (el, cx, cy, radius, dir) {
    const flat = R.textLayout(Object.assign({}, el, { curve: 0, w: 1e5, bgc: null }));
    const total = flat.lines.reduce((m, l) => Math.max(m, l.w), 1);
    el.curve = dir * GS.clamp((total / radius / (Math.PI * 1.9)) * 100, 4, 100);
    R.syncText(el);
    const L = R.curveLayout(el);
    el.x = cx + L.minX; el.y = cy + L.minY;
    return el;
  };

  // ---------- live thumbnails (redraw when fonts or photos arrive) ----------
  const live = new Set();
  GS.liveThumb = function (draw) {
    const cv = document.createElement('canvas');
    const entry = { cv, draw };
    live.add(entry);
    try { draw(cv); } catch (e) { console.warn(e); }
    return cv;
  };
  const redrawLive = GS.debounce(() => {
    for (const en of live) {
      if (!en.cv.isConnected) { if (en.seen) live.delete(en); continue; }
      en.seen = true;
      try { en.draw(en.cv); } catch (e) { /* ignore */ }
    }
  }, 180);
  GS.bus.on('fontsloaded', redrawLive);
  GS.bus.on('imgloaded', redrawLive);
  GS.redrawLive = redrawLive;

  const darkPage = () => { const bg = E.page().bg || {}; return bg.img ? true : GS.isDark(bg.grad ? bg.grad.b : bg.color || '#FFFFFF'); };
  const inkFor = () => (darkPage() ? CREAM : NAVY);
  const afterAdd = () => { if (GS.isMobile()) P.close(); };

  // ---------- rail / drawer ----------
  const TABS = [['templates', 'Design', 'templates'], ['elements', 'Elements', 'elements'], ['text', 'Text', 'text'], ['uploads', 'Uploads', 'uploads'], ['brand', 'Brand', 'brand'], ['background', 'Background', 'background'], ['layers', 'Layers', 'layers']];
  P.buildRail = function () {
    const rail = document.getElementById('rail');
    rail.innerHTML = '';
    TABS.forEach(([k, label, ic]) => rail.append(h('button', { dataset: { tab: k }, 'aria-label': label, onclick: () => (P.tab === k ? P.close() : P.open(k)) }, GS.iconEl(ic, 22), label)));
    document.getElementById('drawer-close').innerHTML = GS.icon('close', 18);
    document.getElementById('drawer-close').onclick = () => P.close();
  };
  P.open = function (tab) {
    P.tab = tab;
    document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const dr = document.getElementById('drawer');
    dr.hidden = false;
    document.getElementById('drawer-title').textContent = (TABS.find((t) => t[0] === tab) || [])[1] || '';
    P.refresh(true);
    if (E.design) { E.autoFit ? E.fit() : E.render(); }
  };
  P.close = function () {
    P.tab = null;
    document.querySelectorAll('#rail button').forEach((b) => b.classList.remove('on'));
    document.getElementById('drawer').hidden = true;
    if (E.design && E.autoFit) E.fit();
  };
  P.refresh = function (reset) {
    if (!P.tab || !E.design) return;
    const body = document.getElementById('drawer-body');
    const top = reset ? 0 : body.scrollTop;
    body.innerHTML = '';
    const fn = BUILD[P.tab];
    if (fn) body.append(fn());
    body.scrollTop = top;
  };
  const refreshIf = (...tabs) => GS.debounce(() => { if (tabs.includes(P.tab)) P.refresh(); }, 60);
  GS.bus.on('uploads', refreshIf('uploads', 'background'));
  GS.bus.on('brand', refreshIf('brand'));
  GS.bus.on('sel', refreshIf('layers', 'text'));
  GS.bus.on('history', refreshIf('layers'));
  GS.bus.on('pages', refreshIf('layers', 'background'));
  GS.bus.on('replacemode', refreshIf('uploads'));

  const sec = (title, right) => h('div', { class: 'psec' }, h('h4', null, title), right || null);

  // ---------- Templates ----------
  function templatesPanel() {
    const w = h('div');
    const q = h('input', { class: 'input', placeholder: 'Search templates', 'aria-label': 'Search templates' });
    let mode = 'all';
    const chips = h('div', { class: 'chips', style: { margin: '10px 0' } });
    const grid = h('div', { class: 'tplp' });
    const d = E.design;
    const sameShape = (t) => { const m = GS.tplPreview(t); return Math.abs(m.w / m.h - d.w / d.h) < 0.02; };
    const draw = () => {
      chips.innerHTML = '';
      [['all', 'All'], ['fit', 'This size']].forEach(([k, l]) => chips.append(h('button', { class: 'chip' + (mode === k ? ' on' : ''), onclick: () => { mode = k; draw(); } }, l)));
      grid.innerHTML = '';
      const s = q.value.trim().toLowerCase();
      const list = GS.TEMPLATES.filter((t) => (!s || (t.name + ' ' + t.tags).toLowerCase().includes(s)) && (mode === 'all' || sameShape(t)));
      if (!list.length) grid.append(h('div', { class: 'empty' }, 'No templates match. Try another word.'));
      list.forEach((t) => grid.append(tplCard(t, () => useTemplate(t))));
    };
    q.addEventListener('input', draw);
    w.append(q, chips, grid);
    draw();
    return w;
  }
  function tplCard(t, onclick) {
    const m = GS.tplPreview(t);
    const cv = GS.liveThumb((c) => R.thumb(m, m.pages[0], 150, 180, c));
    const size = GS.sizeByKey(t.size);
    return h('button', { class: 'card', onclick, title: t.name },
      h('div', { class: 'thumb' }, cv, m.pages.length > 1 ? h('span', { class: 'pill' }, m.pages.length + ' pages') : null),
      h('div', { class: 'meta' }, h('div', null, h('div', { class: 't' }, t.name), h('div', { class: 's' }, size ? size.label : ''))));
  }
  P.tplCard = tplCard;
  async function useTemplate(t) {
    const pg = E.page();
    const blank = E.design.pages.length === 1 && !pg.els.length && !(pg.bg && pg.bg.img);
    if (blank) { E.applyTemplate(t, 'replace'); if (!E.design.name || /^Untitled/.test(E.design.name)) { E.design.name = t.name; GS.bus.emit('design'); } afterAdd(); return; }
    GS.modal({
      title: 'Use “' + t.name + '”',
      body: h('p', { class: 'muted' }, 'Add it as a new page, or replace the page you are on? It will be resized to fit this design.'),
      actions: [{ label: 'Replace this page', onClick: () => { E.applyTemplate(t, 'replace'); afterAdd(); } }, { label: 'Add as new page', kind: 'primary', onClick: () => { E.applyTemplate(t, 'add'); afterAdd(); } }],
    });
  }

  // ---------- Elements ----------
  function shapeTile(key, onclick, opts = {}) {
    const k = key === 'rrect' ? 'rect' : key;
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 96;
    const c = cv.getContext('2d');
    c.translate(10, 10);
    const p = GS.shapePath(k, 76, 76, { r: key === 'rrect' ? 16 : 0 });
    if (opts.frame) { c.fillStyle = '#B9C3CC'; c.fill(p, GS.shapeRule(k)); }
    else { c.fillStyle = '#5E6C78'; c.fill(p, GS.shapeRule(k)); }
    const label = key === 'rrect' ? 'Rounded square' : GS.SHAPES[k].label;
    return h('button', { class: 'tile', title: label, 'aria-label': (opts.frame ? 'Frame: ' : '') + label, onclick }, cv);
  }
  function addShape(key) {
    const u = E.u(), k = key === 'rrect' ? 'rect' : key;
    const s = 300 * u;
    const ratio = { arrow: [1.6, 1], chevron: [1.3, 1], banner: [2.4, 1], ticket: [2, 1], tag: [1.6, 1], semicircle: [2, 1], parallelogram: [1.6, 1], trapezoid: [1.5, 1], bubble: [1.25, 1], cloud: [1.4, 1] }[k] || [1, 1];
    const fill = darkPage() ? GOLD : NAVY;
    E.add(GS.mk.shape({ shape: k, w: s * ratio[0], h: s * ratio[1], fill, r: key === 'rrect' ? s * 0.16 : 0 }));
    afterAdd();
  }
  function addFrame(key) {
    const u = E.u(), k = key === 'rrect' ? 'rect' : key;
    const s = 420 * u;
    const ratio = { arch: [0.75, 1], ticket: [1.6, 1] }[k] || [1, 1];
    E.add(GS.mk.image({ mask: k, w: s * ratio[0], h: s * ratio[1], r: key === 'rrect' ? s * 0.1 : 0 }));
    afterAdd();
  }
  function lineTile(o, label) {
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 96;
    const c = cv.getContext('2d');
    c.translate(12, 40);
    R.drawEl(c, GS.mk.line(Object.assign({ x: 0, y: 0, w: 72, sw: 4, color: '#5E6C78' }, o, { h: 16 })), { scale: 1 });
    return h('button', { class: 'tile', title: label, 'aria-label': label, onclick: () => { const u = E.u(); E.add(GS.mk.line(Object.assign({ w: 480 * u, sw: Math.max(2, 6 * u), color: inkFor() }, o, { h: Math.max(Math.max(2, 6 * u) * 5, 16) }))); afterAdd(); } }, cv);
  }
  function iconTile(key) {
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 96;
    const c = cv.getContext('2d');
    c.translate(14, 14); c.scale(0.68, 0.68);
    const def = GS.ICONS[key];
    c.fillStyle = '#5E6C78';
    c.fill(GS.iconPath(key), def.rule || 'nonzero');
    return h('button', { class: 'tile', title: def.label, 'aria-label': def.label, onclick: () => { const s = 220 * E.u(); E.add(GS.mk.icon({ icon: key, w: s, h: s, fill: darkPage() ? GOLD : NAVY })); afterAdd(); } }, cv);
  }
  function elementsPanel() {
    const w = h('div');
    const q = h('input', { class: 'input', placeholder: 'Search shapes and graphics', 'aria-label': 'Search elements' });
    const body = h('div');
    const draw = () => {
      body.innerHTML = '';
      const s = q.value.trim().toLowerCase();
      const m = (label) => !s || label.toLowerCase().includes(s);
      const lines = [[{}, 'Line'], [{ dash: 'dashed' }, 'Dashed line'], [{ dash: 'dotted' }, 'Dotted line'], [{ capE: 'arrow' }, 'Arrow'], [{ capS: 'arrow', capE: 'arrow' }, 'Double arrow'], [{ capS: 'circle', capE: 'circle' }, 'Dot line']].filter(([, l]) => m(l));
      if (lines.length) { const g = h('div', { class: 'tiles' }); lines.forEach(([o, l]) => g.append(lineTile(o, l))); body.append(sec('Lines'), g); }
      const shapes = GS.SHAPE_LIST.filter((k) => m(k === 'rrect' ? 'Rounded square' : GS.SHAPES[k].label));
      if (shapes.length) { const g = h('div', { class: 'tiles four' }); shapes.forEach((k) => g.append(shapeTile(k, () => addShape(k)))); body.append(sec('Shapes'), g); }
      const frames = GS.FRAME_LIST.filter((k) => m('frame photo ' + (k === 'rrect' ? 'rounded' : GS.SHAPES[k].label)));
      if (frames.length) { const g = h('div', { class: 'tiles four' }); frames.forEach((k) => g.append(shapeTile(k, () => addFrame(k), { frame: true }))); body.append(sec('Photo frames'), h('p', { class: 'muted', style: { margin: '-4px 0 8px', fontSize: '12.5px' } }, 'Drop a photo on a frame to fill it.'), g); }
      if (m('qr code link scan')) {
        const qrb = h('button', { class: 'qr-add', onclick: () => GS.qrDialog('', (v) => { const s = Math.min(E.design.w, E.design.h) * 0.28; E.add(GS.mk.qr({ data: v, w: s, h: s })); afterAdd(); }) },
          GS.iconEl('qr', 30), h('span', null, h('b', null, 'QR code'), h('small', null, 'Link a flyer to tickets, the menu or ordering')));
        body.append(sec('QR code'), qrb);
      }
      const icons = Object.keys(GS.ICONS).filter((k) => m(GS.ICONS[k].label + ' graphic'));
      if (icons.length) { const g = h('div', { class: 'tiles four' }); icons.forEach((k) => g.append(iconTile(k))); body.append(sec('Graphics'), g); }
      if (!body.children.length) body.append(h('div', { class: 'empty' }, 'Nothing matches “' + s + '”.'));
    };
    q.addEventListener('input', draw);
    w.append(q, body);
    draw();
    return w;
  }

  // ---------- Text ----------
  P.addText = function (kind) {
    const u = E.u(), d = E.design, ink = inkFor();
    const presets = {
      heading: { text: 'Add a heading', font: LS, weight: 800, size: 96 * u, w: d.w * 0.8, align: 'center', lh: 1.05 },
      sub: { text: 'Add a subheading', font: BC, weight: 700, size: 58 * u, w: d.w * 0.7, align: 'center', lh: 1.1 },
      body: { text: 'Add a little bit of body text', font: NS, weight: 400, size: 32 * u, w: d.w * 0.6, align: 'center', lh: 1.45 },
    };
    const el = GS.mk.text(Object.assign({ color: ink }, presets[kind] || presets.body));
    E.add(el);
    afterAdd();
    if (!GS.isMobile()) setTimeout(() => E.startEdit(el.id), 30);
  };
  // menus and price signs: Tab between the item and the price lines prices up with dot leaders
  P.addPriceList = function () {
    const u = E.u(), d = E.design;
    E.add(GS.mk.text({ text: 'Comté, 24 months\t$28\nHumboldt Fog\t$32\nManchego\t$24', font: NS, weight: 700, size: 34 * u, w: d.w * 0.72, align: 'left', lh: 1.55, color: inkFor() }));
    afterAdd();
    GS.toast('Press Tab between an item and its price. Prices line up on the right.');
  };
  GS.bus.on('addtext', () => P.addText('body'));
  const COMBOS = [
    { name: 'Eyebrow + headline', els: (ink, acc) => [{ text: 'FRESH CUT', font: LS, weight: 700, size: 30, ls: 240, color: acc, align: 'center' }, { text: 'Cheese of the Week', font: BC, weight: 800, size: 104, color: ink, align: 'center', lh: 1 }], prev: [['FRESH CUT', LS, 700, 10, 'acc', 2], ['Cheese of the Week', BC, 800, 20, 'ink']] },
    { name: 'Script + caps', els: (ink, acc) => [{ text: 'Wine &', font: PF, ital: true, size: 74, color: acc, align: 'center' }, { text: 'CHEESE NIGHT', font: LS, weight: 800, size: 92, color: ink, align: 'center', lh: 1, ls: 20 }], prev: [['Wine &', PF, 400, 16, 'acc', 0, 1], ['CHEESE NIGHT', LS, 800, 16, 'ink']] },
    { name: 'Big number', els: (ink, acc) => [{ text: '20%', font: LS, weight: 800, size: 210, color: ink, align: 'center', lh: 1 }, { text: 'OFF ALL WEDGES', font: BC, weight: 700, size: 52, ls: 140, color: acc, align: 'center' }], prev: [['20%', LS, 800, 28, 'ink'], ['OFF ALL WEDGES', BC, 700, 10, 'acc', 1.5]] },
    { name: 'Event details', els: (ink, acc) => [{ text: 'Raclette Night', font: BC, weight: 800, size: 104, color: ink, align: 'center', lh: 1 }, { text: 'Friday · 7 PM · Memphis', font: NS, weight: 700, size: 36, color: acc, align: 'center' }], prev: [['Raclette Night', BC, 800, 20, 'ink'], ['Friday · 7 PM · Memphis', NS, 700, 9, 'acc']] },
    { name: 'Quote', els: (ink, acc) => [{ text: '“Best cheese counter in town.”', font: PF, ital: true, size: 58, color: ink, align: 'center', lh: 1.2 }, { text: 'A HAPPY REGULAR', font: LS, weight: 700, size: 24, ls: 220, color: acc, align: 'center' }], prev: [['“Best cheese counter in town.”', PF, 400, 11, 'ink', 0, 1], ['A HAPPY REGULAR', LS, 700, 7, 'acc', 2]] },
    { name: 'Curved badge', els: (ink, acc) => [{ text: 'GREYS FINE CHEESES', font: LS, weight: 800, size: 44, ls: 160, color: ink, curve: 62 }, { text: 'EST. IN MEMPHIS', font: BC, weight: 700, size: 30, ls: 160, color: acc, align: 'center' }], prev: [['GREYS FINE CHEESES', LS, 800, 9, 'ink', 1.5], ['EST. IN MEMPHIS', BC, 700, 8, 'acc', 1.5]] },
  ];
  function addCombo(c) {
    const u = E.u(), d = E.design, ink = inkFor(), acc = darkPage() ? GOLD : RIND;
    const gid = GS.uid('g');
    let y = 0;
    const els = c.els(ink, acc).map((o) => {
      const el = GS.mk.text(Object.assign({}, o, { size: o.size * u, w: d.w * 0.8, gid }));
      R.syncText(el);
      if (el.curve) { el.x = (d.w - el.w) / 2; }
      el.y = y; y += el.h + 10 * u;
      return el;
    });
    els.forEach((el) => { if (!el.curve) el.x = (d.w - el.w) / 2; });
    E.addMany(els);
    afterAdd();
  }
  const SNIPPETS = ['Memphis · (901) 440-4739', 'Nashville · (615) 900-4739', 'greyscheese.com', 'tickets.greyscheese.com', 'Fine Cheeses · Charcuterie · Wine'];
  function textPanel() {
    const w = h('div');
    w.append(magicCard());
    const add = h('div', { class: 'txtadd' },
      h('button', { onclick: () => P.addText('heading'), style: { font: `800 26px ${GS.fontStack(LS)}` } }, 'Add a heading'),
      h('button', { onclick: () => P.addText('sub'), style: { font: `700 19px ${GS.fontStack(BC)}` } }, 'Add a subheading'),
      h('button', { onclick: () => P.addText('body'), style: { font: `400 14px ${GS.fontStack(NS)}` } }, 'Add a little bit of body text'),
      h('button', { class: 'pl', onclick: () => P.addPriceList(), style: { font: `700 14px ${GS.fontStack(NS)}` } }, h('span', null, 'Price list'), h('i', null), h('span', null, '$28')));
    w.append(sec('Click to add text'), add);
    const g = h('div', { class: 'combos' });
    COMBOS.forEach((c) => {
      const tile = h('button', { class: 'combo', title: c.name, 'aria-label': 'Add ' + c.name, onclick: () => addCombo(c) });
      c.prev.forEach(([t, f, wt, sz, col, ls, it]) => { GS.loadFamily(f); tile.append(h('span', { style: { font: `${it ? 'italic ' : ''}${wt} ${sz}px ${GS.fontStack(f)}`, letterSpacing: (ls || 0) + 'px', color: col === 'acc' ? RIND : NAVY, lineHeight: 1.1 } }, t)); });
      g.append(tile);
    });
    w.append(sec('Font combinations'), g);
    const sn = h('div', { class: 'chips' });
    SNIPPETS.forEach((s) => sn.append(h('button', { class: 'chip', onclick: () => { E.add(GS.mk.text({ text: s, font: NS, weight: 700, size: 30 * E.u(), w: E.design.w * 0.7, align: 'center', color: inkFor() })); afterAdd(); } }, s)));
    w.append(sec('GREYS details'), sn);
    return w;
  }

  // ----- Magic Write (asks Claude through the artifact's sample capability) -----
  let magicState = { busy: false, results: null, err: '' };
  function magicCard() {
    const sample = GS.Store.caps.sample;
    if (!sample) return h('div');
    const card = h('div', { class: 'magic' });
    const sel = E.selEls();
    const t = sel.length === 1 && sel[0].type === 'text' ? sel[0] : null;
    card.append(h('h5', null, GS.iconEl('sparkle', 18), 'Magic Write'));
    if (t) {
      card.append(h('p', null, 'Rewrite the selected text:'));
      const chips = h('div', { class: 'chips' });
      [['Shorter', 'Make it shorter and punchier.'], ['More fun', 'Make it more playful and warm, one pun at most.'], ['Fancier', 'Make it more elegant and upscale.'], ['Fix spelling', 'Fix spelling, grammar and capitalization only.']].forEach(([l, ins]) => chips.append(h('button', { class: 'chip', disabled: magicState.busy, onclick: () => rewrite(t, ins) }, l)));
      card.append(chips);
    } else {
      card.append(h('p', null, 'Tell it what the design is for. You get three headline ideas in the GREYS voice.'));
      const ta = h('textarea', { class: 'input', id: 'magic-ask', rows: 3, placeholder: 'Raclette night, Fri Dec 11, 7pm, Memphis. Seats are limited.' });
      ta.value = magicState.ask || '';
      ta.addEventListener('input', () => (magicState.ask = ta.value));
      const go = h('button', { class: 'btn primary sm', disabled: magicState.busy, onclick: () => write(ta.value) }, GS.iconEl('sparkle', 16), magicState.busy ? 'Thinking…' : 'Write it');
      card.append(ta, h('div', { class: 'row' }, go));
    }
    if (magicState.err) card.append(h('p', { style: { color: '#8F2A1C', margin: '8px 0 0' } }, magicState.err));
    if (magicState.results && !t) {
      const opts = h('div', { class: 'opts' });
      magicState.results.forEach((r) => opts.append(h('button', { class: 'opt', onclick: () => addMagic(r) }, h('b', null, r.headline), h('span', null, [r.sub, r.details].filter(Boolean).join(' ')))));
      card.append(opts);
    }
    return card;
  }
  const CONTEXT = 'You write short marketing copy for GREYS Fine Cheeses: a cheese shop, sandwich counter and event space in Memphis and Nashville, Tennessee (fine cheeses, charcuterie, wine, classes and tastings, catering boards). Voice: warm, witty and confident. One cheese pun at most. Never invent prices, dates or facts the request does not give.';
  function errText(e) {
    const c = e && e.code;
    if (c === 'not_granted' || c === 'sampling_disabled') return 'Magic Write is turned off for this page.';
    if (c === 'rate_limited') return 'Too many requests right now. Try again in a minute.';
    if (c === 'cancelled') return '';
    return 'That didn’t work. Try again.';
  }
  async function write(ask) {
    ask = (ask || '').trim();
    if (!ask) { GS.toast('Describe what the design is for first.'); return; }
    magicState = { busy: true, results: null, err: '', ask };
    P.refresh();
    try {
      const d = E.design;
      const res = await GS.Store.caps.sample.json(`${CONTEXT}\n\nDesign: ${GS.sizeLabel(d)} (${d.kind || 'custom'}).\nRequest: ${ask}\n\nReply with only a JSON array of 3 options, each {"headline": string (2 to 6 words), "sub": string (at most 12 words), "details": string (optional, at most 16 words, only facts from the request)}.`, { modelTier: 'quick', kind: 'ideas' });
      const list = (Array.isArray(res) ? res : []).filter((r) => r && r.headline).slice(0, 3).map((r) => ({ headline: String(r.headline), sub: r.sub ? String(r.sub) : '', details: r.details ? String(r.details) : '' }));
      magicState = { busy: false, results: list, err: list.length ? '' : 'No ideas came back. Try describing it differently.', ask };
    } catch (e) {
      magicState = { busy: false, results: null, err: errText(e), ask };
    }
    P.refresh();
  }
  async function rewrite(el, instruction) {
    magicState.busy = true; magicState.err = '';
    P.refresh();
    try {
      const res = await GS.Store.caps.sample.json(`${CONTEXT}\n\nRewrite this text from a design. ${instruction} Keep line breaks where they make sense and keep any facts. Reply with only JSON: {"text": string}.\n\nText:\n"""${String(el.text).slice(0, 2000)}"""`, { modelTier: 'quick', cache: false, kind: 'rewrite' });
      if (res && typeof res.text === 'string' && res.text.trim()) { E.update((x) => { if (x.id === el.id) x.text = res.text.trim(); }, { ids: [el.id] }); }
      magicState.busy = false;
    } catch (e) { magicState.busy = false; magicState.err = errText(e); }
    P.refresh();
  }
  function addMagic(r) {
    const u = E.u(), d = E.design, ink = inkFor(), acc = darkPage() ? GOLD : RIND;
    const gid = GS.uid('g');
    const parts = [GS.mk.text({ text: r.headline, font: BC, weight: 800, size: 104 * u, w: d.w * 0.82, align: 'center', color: ink, lh: 1, gid })];
    if (r.sub) parts.push(GS.mk.text({ text: r.sub, font: NS, weight: 700, size: 36 * u, w: d.w * 0.72, align: 'center', color: acc, lh: 1.3, gid }));
    if (r.details) parts.push(GS.mk.text({ text: r.details, font: NS, weight: 400, size: 28 * u, w: d.w * 0.66, align: 'center', color: ink, lh: 1.4, gid }));
    let y = 0;
    parts.forEach((el) => { R.syncText(el); el.x = (d.w - el.w) / 2; el.y = y; y += el.h + 18 * u; });
    E.addMany(parts);
    afterAdd();
  }

  // ---------- Uploads ----------
  const fileInput = () => document.getElementById('file-input');
  let pickTarget = null;
  P.pickFiles = function (target) {
    pickTarget = target || null;
    const fi = fileInput();
    fi.value = '';
    fi.click();
  };
  async function handleFiles(files) {
    const list = [...files].filter((f) => /^image\//.test(f.type));
    if (!list.length) { GS.toast('Pick a JPG, PNG, WebP or SVG image.', 'err'); return; }
    const target = pickTarget; pickTarget = null;
    for (const f of list) {
      try {
        GS.toast('Uploading ' + (f.name || 'image') + '…');
        const rec = await GS.Store.putImage(f);
        if (target === 'brand') {
          const kit = GS.clone(GS.Store.brand || {});
          kit.logos = [{ ref: rec.ref, w: rec.w, h: rec.h, name: rec.name }].concat(kit.logos || []).slice(0, 40);
          await GS.Store.saveBrand(kit);
        } else if (target === 'background') {
          E.page().bg = Object.assign({}, E.page().bg, { img: { src: rec.ref, x: 0.5, y: 0.5 } });
          E.commit(); E.render(); GS.bus.emit('change');
        } else if (target && E.byId(target)) E.fillFrame(target, rec.ref);
        else if (E.design) E.addImage(rec);
      } catch (e) { GS.toast((e && e.message) || 'Upload failed', 'err'); }
    }
  }
  P.handleFiles = handleFiles;
  function photoTile(rec, opts = {}) {
    const img = h('img', { alt: rec.name || 'Photo', draggable: 'false', loading: 'lazy' });
    GS.Store.resolveURL(rec.ref).then((u) => { if (u) img.src = u; });
    const t = h('button', { class: 'tile photo', title: rec.name || 'Photo', draggable: 'true', onclick: () => (opts.onclick ? opts.onclick(rec) : (E.addImage(rec, { contain: opts.contain }), afterAdd())) }, img);
    t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-greys-ref', JSON.stringify({ ref: rec.ref, w: rec.w, h: rec.h, contain: !!opts.contain })); e.dataTransfer.effectAllowed = 'copy'; });
    if (opts.caption) t.append(h('span', { class: 'cap' }, rec.name));
    if (opts.onRemove) t.append(h('span', { class: 'x', role: 'button', title: 'Remove from uploads', 'aria-label': 'Remove from uploads', html: GS.icon('close', 14), onclick: (e) => { e.stopPropagation(); opts.onRemove(rec); } }));
    return t;
  }
  function uploadsPanel() {
    const w = h('div');
    if (E.replaceTarget && E.byId(E.replaceTarget)) w.append(h('div', { class: 'banner' }, GS.iconEl('replace', 16), 'Pick a photo to put in the selected frame', h('button', { class: 'ibtn sm', style: { marginLeft: 'auto' }, 'aria-label': 'Cancel', html: GS.icon('close', 14), onclick: () => { E.replaceTarget = null; P.refresh(); } })));
    const drop = h('div', { class: 'drop' }, h('button', { class: 'btn primary block', onclick: () => P.pickFiles(E.replaceTarget) }, GS.iconEl('uploads', 18), 'Upload photos'), h('div', { style: { marginTop: '8px' } }, 'or drop them here'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); pickTarget = E.replaceTarget; handleFiles(e.dataTransfer.files); });
    w.append(drop);
    if (GS.Store.mode === 'local') w.append(h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 2px 0' } }, 'Uploads are kept on this device until GREYS Studio is opened on claude.ai.'));
    const ups = GS.Store.uploads || [];
    w.append(sec('Your uploads', ups.length ? h('span', { class: 'muted', style: { fontSize: '12px' } }, ups.length + '') : null));
    if (ups.length) {
      const g = h('div', { class: 'tiles' });
      ups.forEach((u) => g.append(photoTile(u, { onRemove: async (rec) => { if (await GS.confirmModal('Remove this photo from your uploads? Designs that already use it keep it.', 'Remove')) GS.Store.removeUpload(rec).catch(() => GS.toast('Could not remove it', 'err')); } })));
      w.append(g);
    } else w.append(h('div', { class: 'empty', style: { padding: '16px' } }, 'Photos you upload show up here for every design.'));
    const g2 = h('div', { class: 'tiles two' });
    GS.PHOTOS.forEach((p) => g2.append(photoTile(p, { caption: true })));
    w.append(sec('GREYS photos'), g2);
    return w;
  }

  // ---------- Brand ----------
  function lockup(kind, u, w0) {
    const gid = GS.uid('g');
    const W = w0 || 640 * u;
    const mk = (o) => GS.mk.text(Object.assign({ w: W, align: 'center', gid }, o));
    if (kind === 'navy') return [mk({ text: 'GREYS', font: LS, weight: 800, size: 130 * u, color: NAVY, ls: 40, lh: 1 }), mk({ text: 'Fine Cheeses · Charcuterie · Wine', font: LS, weight: 700, size: 25 * u, color: NAVY, ls: 60 })];
    if (kind === 'cream') return [mk({ text: 'GREYS', font: LS, weight: 800, size: 130 * u, color: CREAM, ls: 40, lh: 1 }), mk({ text: 'Fine Cheeses · Charcuterie · Wine', font: LS, weight: 700, size: 25 * u, color: GOLD, ls: 60 })];
    if (kind === 'gold') return [mk({ text: 'GREYS', font: LS, weight: 800, size: 130 * u, color: GOLD, ls: 40, lh: 1 }), mk({ text: 'FINE CHEESES', font: BC, weight: 700, size: 34 * u, color: NAVY, ls: 300 })];
    if (kind === 'stamp') {
      const s = 380 * u;
      return [
        GS.mk.shape({ shape: 'ellipse', w: s, h: s, fill: NAVY, gid }),
        GS.mk.shape({ shape: 'ellipse', w: s * 0.88, h: s * 0.88, fill: 'none', stroke: { c: GOLD, w: 5 * u }, gid }),
        GS.mk.text({ text: 'FINE CHEESES', font: LS, weight: 800, size: 34 * u, ls: 220, color: CREAM, curve: 48, gid }),
        GS.mk.text({ text: 'GREYS', font: LS, weight: 800, size: 84 * u, color: GOLD, w: s, align: 'center', lh: 1, gid }),
        GS.mk.text({ text: 'MEMPHIS · NASHVILLE', font: BC, weight: 700, size: 26 * u, ls: 160, color: CREAM, curve: -30, gid }),
      ];
    }
    return [];
  }
  function layoutLockup(kind, els, u) {
    if (kind === 'stamp') {
      const s = els[0].w;
      els[0].x = 0; els[0].y = 0;
      const ring = els[1]; ring.w = ring.h = s * 0.88; ring.x = ring.y = s * 0.06;
      GS.placeArc(els[2], s / 2, s / 2, s * 0.325, 1);
      const wm = els[3]; R.syncText(wm); wm.x = 0; wm.y = s * 0.5 - wm.h / 2;
      GS.placeArc(els[4], s / 2, s / 2, s * 0.375, -1);
      return els;
    }
    let y = 0;
    els.forEach((el) => { R.syncText(el); el.x = 0; el.y = y; y += el.h + 4 * u; });
    return els;
  }
  function brandPanel() {
    const w = h('div');
    const kit = GS.Store.brand || {};
    w.append(sec('GREYS logos'));
    const g = h('div', { class: 'tiles two' });
    [['navy', '#FFFFFF'], ['cream', NAVY], ['gold', '#FFF6E3'], ['stamp', '#FFFFFF']].forEach(([k, bg]) => {
      const cv = GS.liveThumb((c) => {
        const els = layoutLockup(k, lockup(k, 1, 640), 1);
        const b = R.bounds(els);
        const pad = 30;
        const m = { w: b.w + pad * 2, h: b.h + pad * 2, pages: [{ bg: { color: bg }, els: els.map((e) => Object.assign(e, { x: e.x - b.x + pad, y: e.y - b.y + pad })) }] };
        R.thumb(m, m.pages[0], 140, 110, c);
      });
      g.append(h('button', { class: 'tile', style: { background: bg, aspectRatio: '4/3' }, title: 'Add logo', 'aria-label': 'Add GREYS logo, ' + k, onclick: () => { const u = E.u(); E.addMany(layoutLockup(k, lockup(k, u), u)); afterAdd(); } }, cv));
    });
    w.append(g);
    if (GS.EXTRA_STICKERS && GS.EXTRA_STICKERS.length) {
      const st = h('div', { class: 'tiles' });
      GS.EXTRA_STICKERS.forEach((x) => st.append(photoTile(x, { contain: true })));
      st.querySelectorAll('img').forEach((im) => (im.style.objectFit = 'contain'));
      w.append(sec('Stickers'), st);
    }
    w.append(sec('Your logos & graphics', h('button', { onclick: () => P.pickFiles('brand') }, '+ Upload')));
    if (kit.logos && kit.logos.length) {
      const lg = h('div', { class: 'tiles' });
      kit.logos.forEach((l) => lg.append(photoTile(l, { contain: true, onRemove: async () => { const k2 = GS.clone(GS.Store.brand || {}); k2.logos = (k2.logos || []).filter((x) => x.ref !== l.ref); await GS.Store.saveBrand(k2); } })));
      lg.querySelectorAll('img').forEach((im) => (im.style.objectFit = 'contain'));
      w.append(lg);
    } else w.append(h('div', { class: 'empty', style: { padding: '14px' } }, 'Add PNG logos, Greysie or any art you reuse. Transparent PNGs work best.'));
    w.append(sec('Brand colors'));
    const sw = h('div', { class: 'swatches' });
    GS.brandColors().forEach((c) => sw.append(h('button', { class: 'swatch', style: { background: c }, title: (GS.BRAND.names[c] || c) + ' — click to apply', 'aria-label': 'Apply ' + c, onclick: () => applyColor(c) })));
    w.append(sw, h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Click a color to apply it to what’s selected, or to the page when nothing is.'));
    w.append(sec('Brand fonts'));
    w.append(h('div', { class: 'txtadd' },
      h('button', { onclick: () => P.addText('heading'), style: { font: `800 22px ${GS.fontStack(LS)}` } }, 'League Spartan', h('div', { class: 'muted', style: { font: '600 12px var(--body)' } }, 'Logo and big headlines')),
      h('button', { onclick: () => P.addText('sub'), style: { font: `700 20px ${GS.fontStack(BC)}` } }, 'Barlow Condensed', h('div', { class: 'muted', style: { font: '600 12px var(--body)' } }, 'Titles and cheese names')),
      h('button', { onclick: () => P.addText('body'), style: { font: `400 16px ${GS.fontStack(NS)}` } }, 'Nunito Sans', h('div', { class: 'muted', style: { font: '600 12px var(--body)' } }, 'Body copy and details'))));
    return w;
  }
  function applyColor(c) {
    const sel = E.selEls();
    if (!sel.length) { E.page().bg = Object.assign({}, E.page().bg, { color: c, grad: null }); E.commit(); E.render(); GS.bus.emit('change'); return; }
    E.update((el) => {
      if (el.type === 'text') el.color = c;
      else if (el.type === 'shape') { el.fill = c; el.grad = null; }
      else if (el.type === 'icon') el.fill = c;
      else if (el.type === 'line') el.color = c;
      else if (el.type === 'qr') el.fg = c;
      else if (el.type === 'image') el.border = Object.assign({ w: Math.max(2, 8 * E.u()) }, el.border || {}, { c });
    });
  }

  // ---------- Background ----------
  const GRADS = [['#0E3448', '#06273A'], ['#06273A', '#1F5A84'], ['#F6D47F', '#E6B33C'], ['#E6B33C', '#B87428'], ['#FFF6E3', '#F6D47F'], ['#F8F3E8', '#E9DCC3'], ['#B87428', '#06273A'], ['#FFFFFF', '#EEF1F4']];
  function backgroundPanel() {
    const w = h('div');
    const bg = E.page().bg || {};
    const setBg = (patch) => { E.page().bg = Object.assign({}, E.page().bg, patch); E.commit(); E.render(); GS.bus.emit('change'); P.refresh(); };
    w.append(sec('Colors'));
    const sw = h('div', { class: 'swatches' });
    const add = h('button', { class: 'swatch add', title: 'Custom color', 'aria-label': 'Custom color', html: GS.icon('plus', 16), onclick: () => GS.TB.bgColorPicker(add) });
    sw.append(add);
    [...GS.brandColors(), '#000000', '#333C44', '#9AA6B1', '#EEF1F4', '#C2412D', '#EF7D62', '#2F7A47', '#1F5A84'].forEach((c) => sw.append(h('button', { class: 'swatch' + (!bg.grad && (bg.color || '').toUpperCase() === c ? ' on' : ''), style: { background: c }, title: c, 'aria-label': 'Background ' + c, onclick: () => setBg({ color: c, grad: null }) })));
    w.append(sw);
    w.append(sec('Gradients'));
    const gg = h('div', { class: 'swatches', style: { gridTemplateColumns: 'repeat(4,1fr)' } });
    GRADS.forEach(([a, b]) => gg.append(h('button', { class: 'swatch', style: { background: `linear-gradient(180deg, ${a}, ${b})`, aspectRatio: '1/1' }, title: a + ' to ' + b, onclick: () => setBg({ color: b, grad: { a, b, angle: 180 } }) })));
    w.append(gg);
    w.append(sec('Photo background', h('button', { onclick: () => P.pickFiles('background') }, '+ Upload')));
    if (bg.img) {
      w.append(GS.slider({ label: 'Darken photo', min: 0, max: 85, value: Math.round((bg.img.dim || 0) * 100), onInput: (x) => { E.page().bg.img.dim = x / 100; E.render(); }, onChange: () => E.commit() }));
      w.append(h('button', { class: 'btn sm block', style: { margin: '6px 0 10px' }, onclick: () => { const b2 = Object.assign({}, E.page().bg); delete b2.img; E.page().bg = b2; E.commit(); E.render(); GS.bus.emit('change'); P.refresh(); } }, GS.iconEl('trash', 16), 'Remove photo'));
    }
    const pick = (rec) => setBg({ img: { src: rec.ref, x: 0.5, y: 0.5, dim: (bg.img && bg.img.dim) || 0 } });
    const g = h('div', { class: 'tiles' });
    [...(GS.Store.uploads || []).slice(0, 12), ...GS.PHOTOS].forEach((r) => g.append(photoTile(r, { onclick: pick })));
    w.append(g);
    return w;
  }

  // ---------- Layers ----------
  function layersPanel() {
    const w = h('div');
    const els = E.els().slice().reverse();
    if (!els.length) { w.append(h('div', { class: 'empty' }, 'This page is empty. Add text, photos or shapes and they’ll stack up here.')); return w; }
    w.append(h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 8px' } }, 'Top of the list sits in front. Drag the dots to reorder.'));
    const list = h('div');
    els.forEach((el) => {
      const cv = document.createElement('canvas');
      const s = Math.min(40 / Math.max(1, el.w), 30 / Math.max(1, el.h));
      cv.width = Math.max(1, Math.round(el.w * s * 2)); cv.height = Math.max(1, Math.round(el.h * s * 2));
      const c = cv.getContext('2d');
      c.scale(s * 2, s * 2);
      R.drawEl(c, Object.assign({}, el, { x: 0, y: 0, rot: 0, op: 1, shadow: null }), { scale: s * 2 });
      const on = E.sel.includes(el.id);
      const grip = h('span', { class: 'grip', html: GS.icon('grip', 16), 'aria-hidden': 'true' });
      const row = h('div', { class: 'layer' + (on ? ' on' : ''), dataset: { id: el.id } },
        grip,
        h('div', { class: 'lt', style: { background: el.type === 'text' && GS.isDark(el.color || '#000') === false ? '#5E6C78' : '' } }, cv),
        h('div', { class: 'ln', style: { opacity: el.hidden ? 0.45 : 1 } }, E.elName(el)),
        h('button', { class: 'ibtn sm', title: el.hidden ? 'Show' : 'Hide', 'aria-label': el.hidden ? 'Show' : 'Hide', html: GS.icon(el.hidden ? 'eyeoff' : 'eye', 16), onclick: (e) => { e.stopPropagation(); el.hidden = !el.hidden; if (el.hidden) E.sel = E.sel.filter((x) => x !== el.id); E.commit(); E.render(); P.refresh(); } }),
        h('button', { class: 'ibtn sm', title: el.lock ? 'Unlock' : 'Lock', 'aria-label': el.lock ? 'Unlock' : 'Lock', html: GS.icon(el.lock ? 'lock' : 'unlock', 16), onclick: (e) => { e.stopPropagation(); el.lock = !el.lock; E.commit(); E.render(); GS.bus.emit('sel'); } }));
      row.addEventListener('click', (e) => { if (el.hidden) return; E.select(e.shiftKey || e.metaKey ? (on ? E.sel.filter((x) => x !== el.id) : E.sel.concat(el.id)) : [el.id]); });
      grip.addEventListener('pointerdown', (e) => startLayerDrag(e, row, list, el.id));
      list.append(row);
    });
    w.append(list);
    return w;
  }
  function startLayerDrag(e, row, list, id) {
    e.preventDefault();
    const rows = [...list.querySelectorAll('.layer')];
    const marker = h('div', { class: 'layer-drop' });
    row.classList.add('dragging');
    let target = rows.indexOf(row);
    const move = (ev) => {
      const y = ev.clientY;
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { idx = i; break; } }
      target = idx;
      if (idx >= rows.length) list.append(marker); else list.insertBefore(marker, rows[idx]);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      marker.remove(); row.classList.remove('dragging');
      const from = rows.indexOf(row);
      let to = target > from ? target - 1 : target;
      if (to === from) return;
      const n = E.els().length;
      E.moveLayer(id, n - 1 - to);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  const BUILD = { templates: templatesPanel, elements: elementsPanel, text: textPanel, uploads: uploadsPanel, brand: brandPanel, background: backgroundPanel, layers: layersPanel };
})();
