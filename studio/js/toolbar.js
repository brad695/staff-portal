/* GREYS Studio — context toolbar, color picker, font picker and property popovers */
(function () {
  const GS = window.GS, E = GS.E, R = GS.R, h = GS.h;
  const TB = (GS.TB = {});
  const keepFocus = (e) => { if (E.editing) e.preventDefault(); };

  function tb(icon, title, onclick, opts = {}) {
    const b = h('button', { class: 'tb' + (opts.on ? ' on' : '') + (opts.cls ? ' ' + opts.cls : ''), title, 'aria-label': title, onmousedown: keepFocus, onclick: (e) => onclick(e, b) });
    b.innerHTML = (icon ? GS.icon(icon, 19) : '') + (opts.label ? `<span class="lbl">${opts.label}</span>` : '');
    if (opts.on != null) b.setAttribute('aria-pressed', opts.on ? 'true' : 'false');
    return b;
  }
  const sep = () => h('div', { class: 'sep' });
  const live = (patch) => E.update(patch, { live: true });
  const commit = (patch) => E.update(patch);

  // ---------- Color picker ----------
  const PALETTE = ['#000000', '#333C44', '#5E6C78', '#9AA6B1', '#CBD3DA', '#EEF1F4', '#FFFFFF',
    '#7A1F1F', '#B3261E', '#C2412D', '#EF7D62', '#F4A99A', '#FAD4CB', '#FFF1EC',
    '#5C3D0A', '#8A5A00', '#B87428', '#E6B33C', '#F6D47F', '#FBE9B6', '#FFF6E3',
    '#1E4D2B', '#2F7A47', '#5DAA6E', '#8FBF77', '#C5DDB0', '#E3F0D6', '#F4F9EE',
    '#06273A', '#0E3448', '#1F5A84', '#4C8BB5', '#A9CBE3', '#D9E9F5', '#F0F7FC'];
  function docColors() {
    const set = new Set();
    const add = (c) => { if (c && typeof c === 'string' && c[0] === '#') set.add(c.toUpperCase()); };
    if (!E.design) return [];
    for (const p of E.design.pages) {
      add(p.bg && p.bg.color);
      for (const el of p.els) { add(el.color); add(el.fill); add(el.bgc); el.stroke && add(el.stroke.c); el.border && add(el.border.c); }
    }
    return [...set].slice(0, 21);
  }
  GS.brandColors = () => [...new Set([...(GS.BRAND.colors || []), ...((GS.Store.brand && GS.Store.brand.colors) || [])].map((c) => c.toUpperCase()))];

  // onPick(color, final)
  TB.colorPicker = function (anchor, current, onPick, opts = {}) {
    const cur = (current || '').toUpperCase();
    const wrap = h('div');
    const swRow = (title, colors, extra) => {
      if (!colors.length && !extra) return null;
      const grid = h('div', { class: 'swatches' });
      if (extra) grid.append(extra);
      colors.forEach((c) => grid.append(h('button', { class: 'swatch' + (c === cur ? ' on' : ''), style: { background: c }, title: (GS.BRAND.names && GS.BRAND.names[c]) || c, 'aria-label': c, onmousedown: keepFocus, onclick: () => { onPick(c, true); markOn(c); } })));
      return [h('div', { class: 'psec' }, h('h4', null, title)), grid];
    };
    const markOn = (c) => wrap.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.title === c || s.getAttribute('aria-label') === c));
    const none = opts.allowNone ? h('button', { class: 'swatch none', title: 'No color', 'aria-label': 'No color', onclick: () => onPick('none', true) }) : null;
    wrap.append(...(swRow('Document colors', docColors(), none) || []));
    wrap.append(...swRow('GREYS brand', GS.brandColors()));
    wrap.append(...swRow('Default colors', PALETTE));
    const nat = h('input', { type: 'color', value: /^#[0-9A-F]{6}$/i.test(cur) ? cur : '#06273A', 'aria-label': 'Custom color' });
    const hex = h('input', { class: 'input', value: cur && cur !== 'NONE' ? cur : '', placeholder: '#E6B33C', 'aria-label': 'Hex color', style: { height: '38px' } });
    nat.addEventListener('input', () => { hex.value = nat.value.toUpperCase(); onPick(nat.value.toUpperCase(), false); });
    nat.addEventListener('change', () => onPick(nat.value.toUpperCase(), true));
    hex.addEventListener('change', () => { const v = GS.normHex(hex.value); if (v) { onPick(v, true); if (v.length === 7) nat.value = v; } else hex.value = cur; });
    const row = h('div', { class: 'cp-hex' }, nat, hex);
    if (window.EyeDropper) {
      row.append(h('button', { class: 'ibtn', title: 'Pick a color from the screen', 'aria-label': 'Eyedropper', html: GS.icon('eyedrop', 18), onclick: async () => { try { const r = await new window.EyeDropper().open(); const v = GS.normHex(r.sRGBHex); if (v) { onPick(v, true); hex.value = v; } } catch (e) { /* cancelled */ } } }));
    }
    wrap.append(h('div', { class: 'psec' }, h('h4', null, 'Custom')), row);
    if (opts.addToBrand !== false) {
      wrap.append(h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: async () => {
        const v = GS.normHex(hex.value) || GS.normHex(nat.value);
        if (!v) return;
        const kit = GS.clone(GS.Store.brand || {});
        kit.colors = [...new Set([...(kit.colors || []), v])];
        await GS.Store.saveBrand(kit).catch(() => GS.toast('Could not save the brand color', 'err'));
        GS.toast('Added ' + v + ' to brand colors', 'ok');
      } }, GS.iconEl('plus', 16), 'Add to brand colors'));
    }
    GS.pop.open(anchor, wrap, { title: opts.title || 'Color', onClose: opts.onClose });
  };

  // ---------- Font picker ----------
  const WNAMES = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
  TB.fontPicker = function (anchor) {
    const el = E.selEls().find((e) => e.type === 'text');
    if (!el) return;
    const wrap = h('div');
    const search = h('input', { class: 'input', placeholder: 'Search fonts', 'aria-label': 'Search fonts' });
    const list = h('div', { class: 'fontlist' });
    const weights = h('div', { class: 'chips', style: { marginTop: '10px' } });
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { GS.previewFamily(en.target.dataset.f); io.unobserve(en.target); } }), { root: list }) : null;
    const drawWeights = () => {
      weights.innerHTML = '';
      const cur = E.selEls().find((e) => e.type === 'text') || el;
      const info = GS.fontInfo(cur.font);
      info.w.forEach((w) => weights.append(h('button', { class: 'chip' + ((cur.weight || 400) === w ? ' on' : ''), style: { fontFamily: GS.fontStack(cur.font), fontWeight: w }, onclick: () => { GS.loadFamily(cur.font); commit({ weight: w }); drawWeights(); } }, WNAMES[w] || w)));
    };
    const draw = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      let lastCat = '';
      GS.FONTS.filter((f) => !q || f.f.toLowerCase().includes(q) || f.c.toLowerCase().includes(q)).forEach((f) => {
        if (f.c !== lastCat && !q) { lastCat = f.c; list.append(h('div', { class: 'psec', style: { margin: '10px 0 2px' } }, h('h4', null, f.c === 'Brand' ? 'GREYS brand fonts' : f.c))); }
        const cur = (E.selEls().find((e) => e.type === 'text') || el).font;
        const row = h('button', { class: 'fontrow' + (cur === f.f ? ' on' : ''), dataset: { f: f.f }, style: { fontFamily: GS.fontStack(f.f) }, onclick: () => {
          const s = E.selEls().find((e) => e.type === 'text') || el;
          const w = GS.nearestWeight(f.f, s.weight || 400);
          GS.loadFamily(f.f).then(() => E.render());
          commit((x) => { if (x.type === 'text') { x.font = f.f; x.weight = w; if (!f.i) x.ital = false; } });
          list.querySelectorAll('.fontrow').forEach((r) => r.classList.toggle('on', r.dataset.f === f.f));
          drawWeights();
          GS.bus.emit('fontchosen');
        } }, f.f, f.c === 'Brand' ? h('small', null, 'GREYS') : null);
        list.append(row);
        if (f.c === 'Brand') GS.loadFamily(f.f);
        else if (io) io.observe(row); else GS.previewFamily(f.f);
      });
    };
    search.addEventListener('input', draw);
    wrap.append(search, list, h('div', { class: 'psec' }, h('h4', null, 'Weight')), weights);
    draw(); drawWeights();
    GS.pop.open(anchor, wrap, { title: 'Font', cls: 'wide', onClose: () => { io && io.disconnect(); TB.render(); } });
  };

  // ---------- Popovers ----------
  function transparencyPop(anchor) {
    const sel = E.selEls();
    const v = Math.round((sel[0].op ?? 1) * 100);
    GS.pop.open(anchor, GS.slider({ label: 'Transparency', min: 0, max: 100, value: v, onInput: (x) => live({ op: x / 100 }), onChange: (x) => commit({ op: x / 100 }) }), { title: 'Transparency' });
  }
  function spacingPop(anchor) {
    const el = E.selEls()[0];
    const w = h('div');
    w.append(GS.slider({ label: 'Letter spacing', min: -150, max: 800, step: 10, value: el.ls || 0, onInput: (x) => live({ ls: x }), onChange: (x) => commit({ ls: x }) }));
    if (!el.curve) w.append(GS.slider({ label: 'Line spacing', min: 0.5, max: 3, step: 0.05, value: el.lh || 1.2, onInput: (x) => live({ lh: x }), onChange: (x) => commit({ lh: x }) }));
    GS.pop.open(anchor, w, { title: 'Spacing' });
  }
  function colorInput(value, onInput, onChange, label) {
    const nat = h('input', { type: 'color', value: /^#[0-9A-F]{6}$/i.test(value || '') ? value : '#000000', 'aria-label': label || 'Color', style: { width: '42px', height: '34px', border: '1px solid var(--line)', borderRadius: '8px', padding: '2px', background: '#fff' } });
    nat.addEventListener('input', () => onInput(nat.value.toUpperCase()));
    nat.addEventListener('change', () => onChange(nat.value.toUpperCase()));
    const sw = h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', flex: 1 } });
    GS.brandColors().slice(0, 9).forEach((c) => sw.append(h('button', { class: 'swatch', style: { background: c, width: '24px', height: '24px', borderRadius: '6px' }, title: c, onclick: () => { nat.value = c; onChange(c); } })));
    return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, nat, sw);
  }
  function shadowBlock(el, u) {
    const sh = el.shadow;
    const box = h('div');
    const on = h('input', { type: 'checkbox', checked: !!sh, id: 'fx-shadow' });
    on.addEventListener('change', () => { commit({ shadow: on.checked ? { c: 'rgba(0,0,0,.35)', b: 18 * u, x: 0, y: 8 * u } : null }); effectsPop(TB.lastFx); });
    box.append(h('label', { class: 'tog', for: 'fx-shadow' }, 'Shadow', on));
    if (sh) {
      const set = (k) => (x) => live((e) => { if (e.shadow) e.shadow = Object.assign({}, e.shadow, { [k]: x * u }); });
      const fin = (k) => (x) => commit((e) => { if (e.shadow) e.shadow = Object.assign({}, e.shadow, { [k]: x * u }); });
      box.append(GS.slider({ label: 'Blur', min: 0, max: 80, value: GS.round(sh.b / u, 1), onInput: set('b'), onChange: fin('b') }));
      box.append(GS.slider({ label: 'Offset down', min: -60, max: 60, value: GS.round(sh.y / u, 1), onInput: set('y'), onChange: fin('y') }));
      box.append(GS.slider({ label: 'Offset right', min: -60, max: 60, value: GS.round(sh.x / u, 1), onInput: set('x'), onChange: fin('x') }));
      const dark = h('div', { class: 'seg', style: { marginTop: '6px' } });
      [['Soft', 'rgba(0,0,0,.22)'], ['Strong', 'rgba(0,0,0,.5)'], ['Navy', 'rgba(6,39,58,.55)'], ['Gold', 'rgba(230,179,60,.75)']].forEach(([l, c]) => dark.append(h('button', { class: sh.c === c ? 'on' : '', onclick: () => { commit((e) => { if (e.shadow) e.shadow = Object.assign({}, e.shadow, { c }); }); effectsPop(TB.lastFx); } }, l)));
      box.append(dark);
    }
    return box;
  }
  function effectsPop(anchor) {
    TB.lastFx = anchor;
    const el = E.selEls()[0];
    if (!el) return;
    const u = E.u();
    const w = h('div');
    w.append(shadowBlock(el, u));
    if (el.type === 'text') {
      const st = el.stroke;
      const oOn = h('input', { type: 'checkbox', checked: !!(st && st.w > 0), id: 'fx-outline' });
      oOn.addEventListener('change', () => { commit({ stroke: oOn.checked ? { c: GS.isDark(el.color) ? '#FFFFFF' : '#06273A', w: Math.max(1, el.size * 0.04) } : null }); effectsPop(anchor); });
      w.append(h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '8px 0' } }), h('label', { class: 'tog', for: 'fx-outline' }, 'Outline', oOn));
      if (st && st.w > 0) {
        w.append(GS.slider({ label: 'Thickness', min: 0.5, max: Math.max(20, el.size * 0.25), step: 0.5, value: GS.round(st.w, 1), onInput: (x) => live((e) => { if (e.stroke) e.stroke = Object.assign({}, e.stroke, { w: x }); }), onChange: (x) => commit((e) => { if (e.stroke) e.stroke = Object.assign({}, e.stroke, { w: x }); }) }));
        w.append(colorInput(st.c, (c) => live((e) => { if (e.stroke) e.stroke = Object.assign({}, e.stroke, { c }); }), (c) => commit((e) => { if (e.stroke) e.stroke = Object.assign({}, e.stroke, { c }); }), 'Outline color'));
      }
      const hol = h('input', { type: 'checkbox', checked: !!el.hollow, id: 'fx-hollow' });
      hol.addEventListener('change', () => commit({ hollow: hol.checked }));
      w.append(h('label', { class: 'tog', for: 'fx-hollow' }, 'Hollow letters', hol));
      const bgOn = h('input', { type: 'checkbox', checked: !!el.bgc, id: 'fx-bg' });
      bgOn.addEventListener('change', () => { commit({ bgc: bgOn.checked ? (GS.isDark(el.color) ? '#F6D47F' : '#06273A') : null }); effectsPop(anchor); });
      w.append(h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '8px 0' } }), h('label', { class: 'tog', for: 'fx-bg' }, 'Background box', bgOn));
      if (el.bgc) {
        w.append(colorInput(el.bgc, (c) => live({ bgc: c }), (c) => commit({ bgc: c }), 'Background color'));
        w.append(GS.slider({ label: 'Padding', min: 0.05, max: 1.2, step: 0.05, value: el.bgp ?? 0.25, onInput: (x) => live({ bgp: x }), onChange: (x) => commit({ bgp: x }) }));
        w.append(GS.slider({ label: 'Roundness', min: 0, max: 1, step: 0.05, value: el.bgr ?? 0.35, onInput: (x) => live({ bgr: x }), onChange: (x) => commit({ bgr: x }) }));
      }
      w.append(h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '8px 0' } }));
      w.append(GS.slider({ label: 'Curve', min: -100, max: 100, value: el.curve || 0,
        onInput: (x) => live((e) => { if (e.type !== 'text') return; if (!e.curve && x) e.cw = e.w; e.curve = x || 0; if (!x && e.cw) e.w = e.cw; }),
        onChange: (x) => commit((e) => { if (e.type !== 'text') return; if (!x) { if (e.cw) e.w = e.cw; delete e.cw; e.curve = 0; } else e.curve = x; }) }));
    }
    GS.pop.open(anchor, w, { title: 'Effects', onClose: () => TB.render() });
  }
  function positionPop(anchor) {
    const sel = E.selEls();
    const w = h('div', { class: 'menu' });
    const mi = (label, k, fn) => h('button', { onclick: () => { fn(); } }, label, k ? h('span', { class: 'k' }, k) : null);
    w.append(mi('Bring forward', 'Ctrl+]', () => E.order('forward')), mi('Send backward', 'Ctrl+[', () => E.order('backward')), mi('Bring to front', 'Ctrl+Shift+]', () => E.order('front')), mi('Send to back', 'Ctrl+Shift+[', () => E.order('back')));
    w.append(h('div', { class: 'psec' }, h('h4', null, sel.length > 1 && !E.isGroup() ? 'Align elements' : 'Align to page')));
    const g = h('div', { class: 'grid6' });
    [['left', 'aleft'], ['center', 'acenter'], ['right', 'aright'], ['top', 'atop'], ['middle', 'amiddle'], ['bottom', 'abottom']].forEach(([m, ic]) => g.append(h('button', { title: 'Align ' + m, 'aria-label': 'Align ' + m, html: GS.icon(ic, 18), onclick: () => E.align(m) })));
    w.append(g);
    if (sel.length >= 3) {
      const d = h('div', { class: 'row2', style: { marginTop: '8px' } });
      d.append(h('button', { class: 'btn sm', onclick: () => E.distribute('h') }, GS.iconEl('disth', 16), 'Space evenly ↔'), h('button', { class: 'btn sm', onclick: () => E.distribute('v') }, GS.iconEl('distv', 16), 'Space evenly ↕'));
      w.append(d);
    }
    if (sel.length === 1) {
      const el = sel[0];
      const f = (label, key, ro) => {
        const inp = h('input', { class: 'input', type: 'number', value: GS.round(key === 'rot' ? el.rot || 0 : el[key], 1), disabled: ro || el.lock, 'aria-label': label, style: { height: '34px' } });
        inp.addEventListener('change', () => {
          const v = +inp.value;
          if (!isFinite(v)) return;
          commit((e) => {
            if (key === 'w' && e.type === 'text') { const s = Math.max(1, v); e.w = s; }
            else if (key === 'w' || key === 'h') e[key] = Math.max(1, v);
            else e[key] = v;
          });
        });
        return h('label', null, h('span', { class: 'flabel', style: { margin: '6px 0 4px' } }, label), inp);
      };
      w.append(h('div', { class: 'psec' }, h('h4', null, 'Size & position')));
      w.append(h('div', { class: 'row2' }, f('X', 'x'), f('Y', 'y'), f('Width', 'w', el.type === 'text' && el.curve), f('Height', 'h', el.type === 'text' || el.type === 'line'), f('Rotation °', 'rot')));
    }
    GS.pop.open(anchor, w, { title: 'Position', onClose: () => TB.render() });
  }
  function borderPop(anchor, el) {
    const isImg = el.type === 'image';
    const key = isImg ? 'border' : 'stroke';
    const cur = el[key] || null;
    const w = h('div');
    if (!isImg) {
      const seg = h('div', { class: 'seg' });
      [['none', 'None'], ['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].forEach(([k, l]) => seg.append(h('button', { class: (cur ? cur.dash || 'solid' : 'none') === k ? 'on' : '', onclick: () => {
        commit((e) => { if (k === 'none') e.stroke = null; else e.stroke = Object.assign({ c: '#06273A', w: Math.max(2, 4 * E.u()) }, e.stroke || {}, { dash: k === 'solid' ? undefined : k }); });
        borderPop(anchor, E.selEls()[0]);
      } }, l)));
      w.append(seg);
    } else {
      const on = h('input', { type: 'checkbox', checked: !!(cur && cur.w > 0), id: 'bd-on' });
      on.addEventListener('change', () => { commit({ border: on.checked ? { c: '#FFFFFF', w: Math.max(2, 8 * E.u()) } : null }); borderPop(anchor, E.selEls()[0]); });
      w.append(h('label', { class: 'tog', for: 'bd-on' }, 'Border', on));
    }
    if (cur && cur.w > 0) {
      w.append(GS.slider({ label: 'Thickness', min: 0.5, max: Math.max(40, 30 * E.u()), step: 0.5, value: GS.round(cur.w, 1), onInput: (x) => live((e) => { if (e[key]) e[key] = Object.assign({}, e[key], { w: x }); }), onChange: (x) => commit((e) => { if (e[key]) e[key] = Object.assign({}, e[key], { w: x }); }) }));
      w.append(colorInput(cur.c, (c) => live((e) => { if (e[key]) e[key] = Object.assign({}, e[key], { c }); }), (c) => commit((e) => { if (e[key]) e[key] = Object.assign({}, e[key], { c }); }), 'Border color'));
    }
    if ((el.type === 'shape' && el.shape === 'rect') || (isImg && (!el.mask || el.mask === 'rect'))) {
      w.append(GS.slider({ label: 'Corner rounding', min: 0, max: Math.round(Math.min(el.w, el.h) / 2), value: Math.round(el.r || 0), onInput: (x) => live({ r: x }), onChange: (x) => commit({ r: x }) }));
    }
    GS.pop.open(anchor, w, { title: isImg ? 'Border & corners' : 'Border', onClose: () => TB.render() });
  }
  function gradientPop(anchor) {
    const el = E.selEls()[0];
    const w = h('div');
    const on = h('input', { type: 'checkbox', checked: !!el.grad, id: 'gr-on' });
    on.addEventListener('change', () => { commit((e) => { e.grad = on.checked ? { a: e.fill && e.fill !== 'none' ? e.fill : '#E6B33C', b: '#06273A', angle: 180 } : null; }); gradientPop(anchor); });
    w.append(h('label', { class: 'tog', for: 'gr-on' }, 'Use a gradient fill', on));
    if (el.grad) {
      const g = el.grad;
      const set = (k, v, fin) => (fin ? commit : live)((e) => { if (e.grad) e.grad = Object.assign({}, e.grad, { [k]: v }); });
      w.append(h('span', { class: 'flabel' }, 'Start color'), colorInput(g.a.slice(0, 7), (c) => set('a', c), (c) => set('a', c, 1)));
      w.append(h('span', { class: 'flabel' }, 'End color'), colorInput(g.b.slice(0, 7), (c) => set('b', c), (c) => set('b', c, 1)));
      const fade = h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: () => commit((e) => { if (e.grad) e.grad = Object.assign({}, e.grad, { b: e.grad.a.slice(0, 7) + '00' }); }) }, 'Fade end to clear');
      w.append(fade);
      w.append(GS.slider({ label: 'Angle', min: 0, max: 360, step: 5, value: g.angle ?? 180, onInput: (x) => set('angle', x), onChange: (x) => set('angle', x, 1) }));
    }
    GS.pop.open(anchor, w, { title: 'Gradient', onClose: () => TB.render() });
  }
  function swapShapePop(anchor) {
    const el = E.selEls()[0];
    const g = h('div', { class: 'tiles four' });
    GS.SHAPE_LIST.filter((k) => k !== 'rrect').forEach((k) => {
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 80;
      const c = cv.getContext('2d'); c.fillStyle = '#06273A'; c.translate(8, 8); c.fill(GS.shapePath(k, 64, 64, {}), GS.shapeRule(k));
      g.append(h('button', { class: 'tile', title: GS.SHAPES[k].label, 'aria-label': GS.SHAPES[k].label, onclick: () => commit({ shape: k }) }, cv));
    });
    GS.pop.open(anchor, g, { title: el.type === 'image' ? 'Frame shape' : 'Shape' });
  }
  function maskPop(anchor) {
    const g = h('div', { class: 'tiles four' });
    GS.FRAME_LIST.forEach((k) => {
      const kk = k === 'rrect' ? 'rect' : k;
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 80;
      const c = cv.getContext('2d'); c.fillStyle = '#5E6C78'; c.translate(8, 8); c.fill(GS.shapePath(kk, 64, 64, { r: k === 'rrect' ? 14 : 0 }), GS.shapeRule(kk));
      g.append(h('button', { class: 'tile', title: k === 'rrect' ? 'Rounded' : GS.SHAPES[kk].label, onclick: () => commit((e) => { e.mask = kk; e.r = k === 'rrect' ? Math.min(e.w, e.h) * 0.12 : 0; }) }, cv));
    });
    GS.pop.open(anchor, g, { title: 'Frame shape' });
  }
  function linePop(anchor) {
    const el = E.selEls()[0];
    const w = h('div');
    w.append(GS.slider({ label: 'Thickness', min: 0.5, max: Math.max(40, 30 * E.u()), step: 0.5, value: GS.round(el.sw, 1), onInput: (x) => live((e) => { e.sw = x; e.h = Math.max(x * 5, 16); }), onChange: (x) => commit((e) => { e.sw = x; e.h = Math.max(x * 5, 16); }) }));
    const seg = h('div', { class: 'seg' });
    [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].forEach(([k, l]) => seg.append(h('button', { class: (el.dash || 'solid') === k ? 'on' : '', onclick: () => { commit({ dash: k }); linePop(anchor); } }, l)));
    w.append(h('span', { class: 'flabel' }, 'Style'), seg);
    const ends = (lab, key) => {
      const s = h('div', { class: 'seg' });
      [['none', 'None'], ['arrow', 'Arrow'], ['circle', 'Dot'], ['bar', 'Bar']].forEach(([k, l]) => s.append(h('button', { class: (el[key] || 'none') === k ? 'on' : '', onclick: () => { commit({ [key]: k }); linePop(anchor); } }, l)));
      return [h('span', { class: 'flabel' }, lab), s];
    };
    w.append(...ends('Start', 'capS'), ...ends('End', 'capE'));
    GS.pop.open(anchor, w, { title: 'Line' });
  }
  function adjustPop(anchor) {
    const el = E.selEls()[0];
    const e0 = R.getImg(el.src);
    const w = h('div');
    if (e0) {
      const pr = h('div', { class: 'presets' });
      const curKey = el.filt && el.filt.preset;
      Object.entries(R.FILTER_PRESETS).forEach(([k, p]) => {
        const cv = document.createElement('canvas'); cv.width = 84; cv.height = 84;
        const fake = { type: 'image', src: el.src, x: 0, y: 0, w: 84, h: 84, rot: 0, op: 1, crop: { z: 1, x: 0.5, y: 0.5 }, filt: p.f };
        const c = cv.getContext('2d'); R.drawEl(c, fake, { scale: 1 });
        pr.append(h('button', { class: 'preset' + ((curKey || 'none') === k ? ' on' : ''), onclick: () => { commit({ filt: Object.assign({ preset: k }, p.f) }); adjustPop(anchor); } }, cv, p.label));
      });
      w.append(h('div', { class: 'psec', style: { marginTop: 0 } }, h('h4', null, 'Filters')), pr);
    }
    w.append(h('div', { class: 'psec' }, h('h4', null, 'Adjust')));
    const f = el.filt || {};
    const s = (label, key, min, max) => GS.slider({ label, min, max, value: f[key] || 0,
      onInput: (x) => live((e) => { e.filt = Object.assign({}, e.filt, { [key]: x }); }),
      onChange: (x) => commit((e) => { e.filt = Object.assign({}, e.filt, { [key]: x }); }) });
    w.append(s('Brightness', 'br', -60, 60), s('Contrast', 'ct', -60, 60), s('Saturation', 'sat', -100, 100), s('Warmth', 'warm', -60, 60), s('Blur', 'blur', 0, 40), s('Vignette', 'vig', 0, 90));
    w.append(h('button', { class: 'btn sm block', style: { marginTop: '6px' }, onclick: () => { commit({ filt: {} }); adjustPop(anchor); } }, 'Reset'));
    GS.pop.open(anchor, w, { title: 'Adjust photo', onClose: () => TB.render() });
  }
  function bgPhotoPop(anchor) {
    const bg = E.page().bg || {};
    const w = h('div');
    const setBg = (patch, fin) => { Object.assign(E.page().bg.img, patch); E.render(); if (fin) E.commit(); };
    w.append(GS.slider({ label: 'Darken', min: 0, max: 85, value: Math.round((bg.img.dim || 0) * 100), onInput: (x) => setBg({ dim: x / 100 }), onChange: (x) => setBg({ dim: x / 100 }, 1) }));
    w.append(GS.slider({ label: 'Move left / right', min: 0, max: 100, value: Math.round((bg.img.x ?? 0.5) * 100), onInput: (x) => setBg({ x: x / 100 }), onChange: (x) => setBg({ x: x / 100 }, 1) }));
    w.append(GS.slider({ label: 'Move up / down', min: 0, max: 100, value: Math.round((bg.img.y ?? 0.5) * 100), onInput: (x) => setBg({ y: x / 100 }), onChange: (x) => setBg({ y: x / 100 }, 1) }));
    w.append(h('button', { class: 'btn sm block', style: { marginTop: '8px' }, onclick: () => { delete E.page().bg.img; E.commit(); E.render(); GS.pop.close(); TB.render(); GS.bus.emit('change'); } }, GS.iconEl('trash', 16), 'Remove background photo'));
    GS.pop.open(anchor, w, { title: 'Background photo' });
  }
  TB.bgColorPicker = function (anchor) {
    const bg = E.page().bg || {};
    TB.colorPicker(anchor, bg.color, (c, fin) => {
      E.page().bg = Object.assign({}, E.page().bg, { color: c, grad: null });
      E.render();
      if (fin) { E.commit(); GS.bus.emit('change'); }
    }, { title: 'Background color', onClose: () => TB.render() });
  };

  // ---------- Toolbar builder ----------
  const ctx = () => document.getElementById('ctx');
  let pending = false;
  TB.render = function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; build(); });
  };
  function common(sel) {
    const els = [];
    const locked = sel.every((e) => e.lock);
    els.push(sep());
    if (!locked) {
      els.push(tb('transparency', 'Transparency', (e, b) => transparencyPop(b)));
      els.push(tb('position', 'Position', (e, b) => positionPop(b), { label: GS.isMobile() ? '' : 'Position' }));
    }
    els.push(tb(locked ? 'lock' : 'unlock', locked ? 'Unlock' : 'Lock', () => E.toggleLock(), { on: locked }));
    els.push(tb('copy', 'Duplicate (Ctrl+D)', () => E.dup()));
    if (!locked) els.push(tb('trash', 'Delete', () => E.del()));
    return els;
  }
  function textTools(el, sel) {
    const out = [];
    const fb = h('button', { class: 'tb fontbtn', title: 'Font', onmousedown: keepFocus, onclick: (e) => TB.fontPicker(fb) }, h('span', { style: { fontFamily: GS.fontStack(el.font) } }, el.font), GS.iconEl('chevdown', 16));
    out.push(fb);
    const inp = h('input', { type: 'number', value: GS.round(el.size, el.size < 10 ? 1 : 0), min: 1, max: 2000, 'aria-label': 'Font size' });
    const setSize = (v) => commit((x) => { if (x.type === 'text') { const r = v / x.size; x.size = v; if (x.stroke) x.stroke = Object.assign({}, x.stroke, { w: x.stroke.w * r }); } });
    const step = (d) => { const v = Math.max(1, Math.round((el.size + d) * 10) / 10); inp.value = v; setSize(v); el.size = v; };
    inp.addEventListener('change', () => { const v = GS.clamp(+inp.value || el.size, 1, 2000); setSize(v); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
    out.push(h('div', { class: 'sizebox' }, h('button', { 'aria-label': 'Smaller', onmousedown: keepFocus, onclick: () => step(-Math.max(1, Math.round(el.size * 0.06))), html: GS.icon('minus', 14) }), inp, h('button', { 'aria-label': 'Bigger', onmousedown: keepFocus, onclick: () => step(Math.max(1, Math.round(el.size * 0.06))), html: GS.icon('plus', 14) })));
    const cb = h('button', { class: 'tb', title: 'Text color', 'aria-label': 'Text color', onmousedown: keepFocus, onclick: () => TB.colorPicker(cb, el.color, (c, fin) => (fin ? commit : live)((x) => { if (x.type === 'text') x.color = c; }), { title: 'Text color', onClose: () => TB.render() }) },
      h('span', { class: 'tcolor' }, 'A', h('i', { style: { background: el.color } })));
    out.push(cb);
    const bw = GS.boldWeight(el.font);
    out.push(tb('bold', 'Bold', () => commit((x) => { if (x.type === 'text') x.weight = (x.weight || 400) >= 600 ? GS.nearestWeight(x.font, 400) : GS.boldWeight(x.font); }), { on: (el.weight || 400) >= 600 }));
    out.push(tb('italic', 'Italic', () => commit((x) => { if (x.type === 'text') x.ital = !x.ital; }), { on: !!el.ital }));
    out.push(tb('underline', 'Underline', () => commit((x) => { if (x.type === 'text') x.under = !x.under; }), { on: !!el.under }));
    out.push(tb('case', 'Uppercase', () => commit((x) => { if (x.type === 'text') x.upper = !x.upper; }), { on: !!el.upper }));
    const nextAlign = { left: 'center', center: 'right', right: 'left' };
    out.push(tb('align' + (el.align || 'left'), 'Alignment', () => commit((x) => { if (x.type === 'text') x.align = nextAlign[x.align || 'left']; })));
    out.push(tb('spacing', 'Spacing', (e, b) => spacingPop(b)));
    out.push(tb('effects', 'Effects', (e, b) => effectsPop(b), { label: GS.isMobile() ? '' : 'Effects' }));
    if (!E.editing && sel.length === 1 && !el.lock) out.push(tb('edit', 'Edit text', () => E.startEdit(el.id), { label: GS.isMobile() ? 'Edit' : '' }));
    void bw;
    return out;
  }
  function fillButton(el) {
    const isIcon = el.type === 'icon';
    const fill = el.grad ? null : el.fill;
    const b = h('button', { class: 'tb', title: 'Color', 'aria-label': 'Color', onclick: () => TB.colorPicker(b, fill, (c, fin) => (fin ? commit : live)((x) => { if (x.type === 'shape' || x.type === 'icon') { x.fill = c; if (x.type === 'shape') x.grad = null; } else if (x.type === 'line') x.color = c; }), { title: isIcon ? 'Graphic color' : 'Fill color', allowNone: el.type === 'shape', onClose: () => TB.render() }) },
      h('span', { class: 'sw', style: { background: el.grad ? `linear-gradient(${el.grad.angle}deg, ${el.grad.a}, ${el.grad.b})` : el.fill === 'none' ? 'linear-gradient(135deg,#fff 45%,#E2412F 45%,#E2412F 55%,#fff 55%)' : el.fill || el.color } }));
    return b;
  }
  function build() {
    const bar = ctx();
    if (!bar) return;
    if (GS.pop.isOpen()) { TB.stale = true; return; }
    TB.stale = false;
    bar.innerHTML = '';
    const stageEl = document.getElementById('stage');
    const oldCrop = stageEl && stageEl.querySelector('.crop-bar');
    if (oldCrop) oldCrop.remove();
    if (!E.design) return;
    const sel = E.selEls();
    const add = (...xs) => xs.flat().forEach((x) => x && bar.append(x));
    if (!sel.length) {
      const bg = E.page().bg || {};
      const bb = h('button', { class: 'tb', title: 'Background color', onclick: () => TB.bgColorPicker(bb) }, h('span', { class: 'sw', style: { background: bg.grad ? `linear-gradient(${bg.grad.angle}deg, ${bg.grad.a}, ${bg.grad.b})` : bg.color || '#fff' } }), h('span', { class: 'lbl' }, 'Background'));
      add(bb);
      if (bg.img) add(tb('image', 'Background photo', (e, b) => bgPhotoPop(b), { label: 'Photo' }));
      add(sep(), tb('resize', 'Resize design', () => GS.UI.resizeDialog(), { label: 'Resize' }));
      add(sep(), h('span', { class: 'lbl' }, `Page ${E.pi + 1} of ${E.design.pages.length}`), tb('plus', 'Add page', () => E.addPage(), { label: GS.isMobile() ? '' : 'Add page' }), tb('copy', 'Duplicate page', () => E.dupPage()), tb('trash', E.design.pages.length > 1 ? 'Delete page' : 'Clear page', async () => {
        if (await GS.confirmModal(E.design.pages.length > 1 ? 'Delete this page?' : 'Remove everything on this page?', E.design.pages.length > 1 ? 'Delete page' : 'Clear page', true)) E.delPage();
      }));
      return;
    }
    if (sel.length > 1) {
      add(h('span', { class: 'lbl' }, `${sel.length} selected`));
      add(tb('position', 'Align', (e, b) => positionPop(b), { label: 'Align' }));
      add(E.isGroup() ? tb('ungroup', 'Ungroup (Ctrl+Shift+G)', () => E.ungroup(), { label: 'Ungroup' }) : tb('group', 'Group (Ctrl+G)', () => E.group(), { label: 'Group' }));
      const texts = sel.filter((e) => e.type === 'text');
      if (texts.length === sel.length) add(sep(), ...textTools(texts[0], sel));
      add(common(sel));
      return;
    }
    const el = sel[0];
    if (el.lock) { add(h('span', { class: 'lbl' }, E.elName(el) + ' is locked'), common(sel)); return; }
    if (el.type === 'text') add(textTools(el, sel));
    else if (el.type === 'shape') {
      add(fillButton(el), tb('paint', 'Gradient', (e, b) => gradientPop(b), { on: !!el.grad }), tb('border', 'Border', (e, b) => borderPop(b, el)), tb('shape', 'Change shape', (e, b) => swapShapePop(b)), tb('effects', 'Shadow', (e, b) => effectsPop(b)), tb('flip', 'Flip', () => E.flip('h')));
    } else if (el.type === 'icon') {
      add(fillButton(el), tb('effects', 'Shadow', (e, b) => effectsPop(b)), tb('flip', 'Flip', () => E.flip('h')));
    } else if (el.type === 'line') {
      const cb = h('button', { class: 'tb', title: 'Line color', onclick: () => TB.colorPicker(cb, el.color, (c, fin) => (fin ? commit : live)({ color: c }), { title: 'Line color', onClose: () => TB.render() }) }, h('span', { class: 'sw', style: { background: el.color } }));
      add(cb, tb('line', 'Line style', (e, b) => linePop(b), { label: 'Style' }), tb('effects', 'Shadow', (e, b) => effectsPop(b)));
    } else if (el.type === 'image') {
      if (!el.src) {
        add(tb('image', 'Choose a photo', () => GS.UI.replaceImage(el.id), { label: 'Add photo' }), tb('uploads', 'Upload from device', () => GS.UI.uploadInto(el.id), { label: GS.isMobile() ? '' : 'Upload' }), tb('shape', 'Frame shape', (e, b) => maskPop(b)), tb('border', 'Border & corners', (e, b) => borderPop(b, el)));
      } else if (E.cropping === el.id) {
        add(h('span', { class: 'lbl' }, 'Drag the photo to reposition it'));
      } else {
        add(tb('replace', 'Replace photo', () => GS.UI.replaceImage(el.id), { label: GS.isMobile() ? '' : 'Replace' }));
        if (el.fit !== 'contain') add(tb('crop', 'Crop (double-click)', () => E.startCrop(el.id), { label: GS.isMobile() ? '' : 'Crop' }));
        add(tb('adjust', 'Adjust & filters', (e, b) => adjustPop(b), { label: GS.isMobile() ? '' : 'Adjust' }));
        if (el.fit !== 'contain') add(tb('shape', 'Frame shape', (e, b) => maskPop(b)));
        add(tb('border', 'Border & corners', (e, b) => borderPop(b, el)), tb('effects', 'Shadow', (e, b) => effectsPop(b)), tb('flip', 'Flip', () => E.flip('h')));
        if (el.fit !== 'contain') add(tb('background', 'Use as page background', () => E.setAsBackground(), { label: GS.isMobile() ? '' : 'Set as background' }));
      }
    }
    add(common(sel));
    if (el.type === 'image' && E.cropping === el.id && stageEl) {
      const cr = el.crop || { z: 1 };
      const rng = h('input', { type: 'range', min: 1, max: 4, step: 0.01, value: cr.z || 1, 'aria-label': 'Zoom photo' });
      rng.addEventListener('input', () => live((e) => { e.crop = Object.assign({}, e.crop, { z: +rng.value }); }));
      rng.addEventListener('change', () => E.commit());
      stageEl.append(h('div', { class: 'crop-bar' }, h('span', null, 'Zoom'), rng,
        h('button', { class: 'btn sm', onclick: () => { E.update((e) => { e.crop = { z: 1, x: 0.5, y: 0.5 }; }); TB.render(); } }, 'Reset'),
        h('button', { class: 'btn gold sm', onclick: () => E.endCrop() }, 'Done')));
    }
  }
  GS.bus.on('sel', () => TB.render());
  GS.bus.on('change', () => TB.render());
  GS.bus.on('history', () => TB.render());
  const popClose = GS.pop.close;
  GS.pop.close = function () { const was = GS.pop.isOpen(); popClose(); if (was && TB.stale) TB.render(); };
})();
