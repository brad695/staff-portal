/* GREYS Studio — shared helpers, icons, modals, popovers, toasts */
(function () {
  const GS = (window.GS = window.GS || {});

  GS.$ = (s, r = document) => r.querySelector(s);
  GS.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // Tiny element builder: h('div', {class:'x', onclick: fn, style:{...}}, child, ...)
  GS.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  GS.uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  GS.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  GS.clone = (o) => JSON.parse(JSON.stringify(o));
  GS.round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
  GS.RAD = Math.PI / 180;
  GS.debounce = function (fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.flush = (...a) => { clearTimeout(t); fn(...a); };
    d.cancel = () => clearTimeout(t);
    return d;
  };
  GS.raf = function (fn) {
    let q = false;
    return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(); }); };
  };
  GS.isMobile = () => window.innerWidth < 760;
  GS.fmtAgo = function (ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' days ago';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Colors
  GS.hexToRgb = function (hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    if (isNaN(n)) return { r: 0, g: 0, b: 0, a: 1 };
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  };
  GS.rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => GS.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  GS.normHex = function (v) {
    let s = String(v || '').trim();
    if (!s) return null;
    if (s[0] !== '#') s = '#' + s;
    if (!/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return null;
    if (s.length === 4 || s.length === 5) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
    return s.toUpperCase();
  };
  GS.isDark = function (hex) {
    const { r, g, b } = GS.hexToRgb(hex);
    return (r * 299 + g * 587 + b * 114) / 1000 < 140;
  };

  // Event bus
  const handlers = {};
  GS.bus = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, ...a) { (handlers[ev] || []).slice().forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); },
  };

  // ---------- Icons (24px, stroke) ----------
  const I = {
    templates: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.6"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
    elements: '<circle cx="7.5" cy="7.5" r="4.5"/><rect x="13" y="13" width="8" height="8" rx="1.6"/><path d="M17 3.5l4 6.5h-8z"/><path d="M4 19.5l3.5-5 3.5 5z"/>',
    text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
    uploads: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    brand: '<path d="M12 3l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16l-5.1 2.6 1-5.6-4.1-4 5.7-.8z"/>',
    background: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0 0 22 9.7C22 5.9 17.5 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10.5" cy="7" r="1.1"/><circle cx="15.5" cy="7.5" r="1.1"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z" stroke-width="2.4"/>',
    italic: '<path d="M10 5h8M6 19h8M15 5L9 19"/>',
    underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>',
    alignleft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
    aligncenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
    alignright: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
    case: '<text x="2.5" y="17" font-size="12.5" font-weight="800" fill="currentColor" stroke="none" font-family="Nunito Sans, sans-serif">aA</text>',
    spacing: '<path d="M11 6h9M11 12h9M11 18h9M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2"/>',
    effects: '<path d="M11 3l1.8 4.7L17.5 9.5l-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    transparency: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/>',
    position: '<rect x="4" y="4" width="10" height="10" rx="1.6"/><rect x="10" y="10" width="10" height="10" rx="1.6" fill="currentColor" fill-opacity=".18"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/>',
    adjust: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    replace: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    flip: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 7L4 17h5zM15 7l5 10h-5z"/>',
    group: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.6"/><rect x="7" y="7" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/>',
    ungroup: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M14 4h6v6M4 14v6h6" stroke-dasharray="2 2.4"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    zoomin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/>',
    zoomout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    magic: '<path d="M4 20L15 9M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M7 4v2M6 5h2M19.5 13.5v2M18.5 14.5h2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="M21 15.5l-5-5L5 21"/>',
    resize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    pages: '<rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chevdown: '<path d="M6 9l6 6 6-6"/>',
    chevup: '<path d="M6 15l6-6 6 6"/>',
    chevleft: '<path d="M15 6l-6 6 6 6"/>',
    chevright: '<path d="M9 6l6 6-6 6"/>',
    aleft: '<path d="M4 3v18"/><rect x="7" y="6" width="13" height="4" rx="1"/><rect x="7" y="14" width="8" height="4" rx="1"/>',
    acenter: '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>',
    aright: '<path d="M20 3v18"/><rect x="4" y="6" width="13" height="4" rx="1"/><rect x="9" y="14" width="8" height="4" rx="1"/>',
    atop: '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="13" rx="1"/><rect x="14" y="7" width="4" height="8" rx="1"/>',
    amiddle: '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>',
    abottom: '<path d="M3 20h18"/><rect x="6" y="4" width="4" height="13" rx="1"/><rect x="14" y="9" width="4" height="8" rx="1"/>',
    disth: '<path d="M4 3v18M20 3v18"/><rect x="9" y="7" width="6" height="10" rx="1"/>',
    distv: '<path d="M3 4h18M3 20h18"/><rect x="7" y="9" width="10" height="6" rx="1"/>',
    cloud: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
    cloudcheck: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/><path d="M9.5 13l2 2 3.5-3.5"/>',
    device: '<rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2 19h20"/>',
    grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
    line: '<path d="M4 20L20 4"/>',
    shape: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    border: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/>',
    corner: '<path d="M4 20V11a7 7 0 0 1 7-7h9"/>',
    paint: '<path d="M4 15l7-11 7 11a7 7 0 0 1-14 0z"/>',
    send: '<path d="M4 12l16-8-6 16-3-6z"/><path d="M11 14l9-10"/>',
    sparkle: '<path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    eyedrop: '<path d="M15 4l5 5-2 2-1-1-7 7H7v-3l7-7-1-1z"/><path d="M4 20l3-3"/>',
    curve: '<path d="M4 17c3-8 13-8 16 0"/><path d="M8 11.5l-1-2.5M12 9.5V7M16 11.5l1-2.5"/>',
  };
  GS.icon = function (name, size = 20, extra = '') {
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${I[name] || ''}</svg>`;
  };
  GS.iconEl = (name, size) => {
    const s = document.createElement('span');
    s.className = 'icw';
    s.innerHTML = GS.icon(name, size);
    return s;
  };

  // ---------- Toasts ----------
  GS.toast = function (msg, kind = '') {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const t = GS.h('div', { class: 'toast ' + kind, role: 'status' }, msg);
    root.append(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 5200 : 2600);
  };

  // ---------- Modals ----------
  GS.modal = function ({ title, body, actions = [], wide = false, onClose }) {
    const root = document.getElementById('modal-root');
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const card = GS.h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      GS.h('div', { class: 'modal-head' },
        GS.h('h3', null, title || ''),
        GS.h('button', { class: 'ibtn', 'aria-label': 'Close', html: GS.icon('close'), onclick: close })),
      GS.h('div', { class: 'modal-body' }, body),
      actions.length ? GS.h('div', { class: 'modal-actions' }, actions.map((a) =>
        GS.h('button', { class: 'btn ' + (a.kind || ''), onclick: async () => { const r = a.onClick ? await a.onClick() : undefined; if (r !== false) close(); } }, a.label))) : null);
    const wrap = GS.h('div', { class: 'modal-wrap', onpointerdown: (e) => { if (e.target === wrap) close(); } }, card);
    root.append(wrap);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { const f = card.querySelector('input,select,textarea'); if (f) { f.focus(); f.select && f.select(); } }, 30);
    return { close, card };
  };
  GS.confirmModal = (text, okLabel = 'OK', danger = false) => new Promise((res) => {
    let done = false;
    GS.modal({
      title: 'Are you sure?', body: GS.h('p', { class: 'muted' }, text),
      actions: [{ label: 'Cancel', onClick: () => { done = true; res(false); } }, { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; res(true); } }],
      onClose: () => { if (!done) res(false); },
    });
  });
  GS.promptModal = (title, value = '', okLabel = 'Save') => new Promise((res) => {
    let done = false;
    const inp = GS.h('input', { class: 'input', id: 'prompt-input', value, onkeydown: (e) => { if (e.key === 'Enter') { done = true; res(inp.value.trim()); m.close(); } } });
    const m = GS.modal({
      title, body: inp,
      actions: [{ label: 'Cancel', onClick: () => { done = true; res(null); } }, { label: okLabel, kind: 'primary', onClick: () => { done = true; res(inp.value.trim()); } }],
      onClose: () => { if (!done) res(null); },
    });
  });

  // ---------- Popover (one at a time) ----------
  let popEl = null, popAnchor = null, popCleanup = null;
  GS.pop = {
    open(anchor, content, opts = {}) {
      GS.pop.close();
      popAnchor = anchor;
      const sheet = GS.isMobile();
      popEl = GS.h('div', { class: 'pop' + (sheet ? ' sheet' : '') + (opts.cls ? ' ' + opts.cls : '') });
      if (opts.title) popEl.append(GS.h('div', { class: 'pop-title' }, GS.h('span', null, opts.title), GS.h('button', { class: 'ibtn sm', 'aria-label': 'Close', html: GS.icon('close', 16), onclick: () => GS.pop.close() })));
      popEl.append(content);
      document.body.append(popEl);
      if (!sheet) {
        const r = anchor.getBoundingClientRect();
        const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
        let x = r.left + (opts.alignRight ? r.width - pw : 0), y = r.bottom + 8;
        if (opts.above) y = r.top - ph - 8;
        x = GS.clamp(x, 8, window.innerWidth - pw - 8);
        if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8);
        popEl.style.left = x + 'px';
        popEl.style.top = y + 'px';
      }
      anchor.classList && anchor.classList.add('open');
      const onDown = (e) => {
        if (!popEl) return;
        if (popEl.contains(e.target) || (anchor.contains && anchor.contains(e.target))) return;
        if (e.target.closest && e.target.closest('.modal-wrap')) return;
        GS.pop.close();
      };
      const onKey = (e) => { if (e.key === 'Escape') GS.pop.close(); };
      setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
      document.addEventListener('keydown', onKey);
      popCleanup = () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
      opts.onClose && (popEl._onClose = opts.onClose);
      return popEl;
    },
    close() {
      if (!popEl) return;
      const cb = popEl._onClose;
      popCleanup && popCleanup();
      popAnchor && popAnchor.classList && popAnchor.classList.remove('open');
      popEl.remove();
      popEl = null; popAnchor = null; popCleanup = null;
      cb && cb();
    },
    isOpen: () => !!popEl,
    el: () => popEl,
  };

  // Simple labelled slider row used in many popovers
  GS.slider = function ({ label, min, max, step = 1, value, onInput, onChange, fmt }) {
    const out = GS.h('input', { class: 'num', type: 'number', min, max, step, value: GS.round(value, 2) });
    const rng = GS.h('input', { type: 'range', min, max, step, value });
    rng.addEventListener('input', () => { out.value = GS.round(+rng.value, 2); onInput && onInput(+rng.value); });
    rng.addEventListener('change', () => onChange && onChange(+rng.value));
    out.addEventListener('change', () => { const v = GS.clamp(+out.value || 0, min, max); rng.value = v; out.value = v; onInput && onInput(v); onChange && onChange(v); });
    return GS.h('div', { class: 'srow' }, GS.h('div', { class: 'srow-top' }, GS.h('label', null, label), out), rng);
  };

  // Read a File/Blob to an Image (decoded)
  GS.loadImageFromBlob = (blob) => new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    img.src = url;
  });
  GS.canvasToBlob = (cv, type = 'image/png', q) => new Promise((res, rej) => {
    try { cv.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), type, q); } catch (e) { rej(e); }
  });
})();
