/* GREYS Studio — the Tools menu, built from the most common Canva complaints and requests:
   find & replace, bulk create (Pro-only in Canva), version history (Pro-only in Canva), rulers & guides,
   a snapping switch, a keyboard shortcut sheet, and a warning before leaving with unsaved changes. */
(function () {
  const GS = window.GS, E = GS.E, R = GS.R, h = GS.h, $ = GS.$;
  const T = (GS.T = {});
  const inEditor = () => !$('#editor').hidden;
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---------- menu ----------
  const btn = $('#ed-tools');
  btn.innerHTML = GS.icon('tools', 18) + '<span class="lbl">Tools</span>';
  btn.onclick = () => T.menu(btn);
  T.menu = function (anchor) {
    if (!E.design) return;
    const m = h('div', { class: 'menu tools-menu' });
    const item = (icon, label, right, fn) => m.append(h('button', { onclick: () => { GS.pop.close(); fn(); } }, GS.iconEl(icon, 18), label, right ? h('span', { class: 'k' }, right) : null));
    const tog = (icon, label, on, key, fn) => m.append(h('button', { role: 'menuitemcheckbox', 'aria-checked': on ? 'true' : 'false', onclick: () => { GS.pop.close(); fn(); } }, GS.iconEl(icon, 18), label, h('span', { class: 'k' }, key ? key + ' · ' : '', h('b', { class: 'onoff' + (on ? ' on' : '') }, on ? 'On' : 'Off'))));
    item('find', 'Find & replace', 'Ctrl+F', () => T.findReplace());
    item('bulk', 'Bulk create from a list', '', () => T.bulkCreate());
    item('history', 'Version history', '', () => T.history());
    m.append(h('hr'));
    tog('ruler', 'Rulers & guides', E.showRulers, 'Shift+R', () => E.setRulers(!E.showRulers));
    tog('magnet', 'Snap to guides & elements', E.snapOn, '', () => E.setSnap(!E.snapOn));
    if (E.showRulers && E.page().guides && ((E.page().guides.v || []).length || (E.page().guides.h || []).length)) item('trash', 'Clear guides on this page', '', () => E.clearGuides());
    m.append(h('hr'));
    item('keyboard', 'Keyboard shortcuts', '?', () => T.shortcuts());
    GS.pop.open(anchor, m, { title: 'Tools', alignRight: true });
  };

  // ---------- find & replace (every text box, every page) ----------
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  T.findReplace = function () {
    if (!E.design) return;
    E.endEdit();
    const f = h('input', { class: 'input', id: 'fr-find', placeholder: 'Find', 'aria-label': 'Find' });
    const r = h('input', { class: 'input', id: 'fr-repl', placeholder: 'Replace with', 'aria-label': 'Replace with' });
    const mc = h('input', { type: 'checkbox', id: 'fr-case' });
    const ww = h('input', { type: 'checkbox', id: 'fr-word' });
    const res = h('div', { class: 'fr-res' });
    const rx = () => (f.value ? new RegExp((ww.checked ? '\\b' : '') + esc(f.value) + (ww.checked ? '\\b' : ''), mc.checked ? 'g' : 'gi') : null);
    const scan = () => {
      const re = rx();
      res.innerHTML = '';
      if (!re) { res.append(h('p', { class: 'muted' }, 'Looks through every text box on every page.')); return; }
      const hits = [];
      E.design.pages.forEach((p, pi) => p.els.forEach((el) => { if (el.type === 'text') { const n = (String(el.text).match(re) || []).length; if (n) hits.push({ pi, el, n }); } }));
      const total = hits.reduce((s, x) => s + x.n, 0);
      res.append(h('p', { class: 'muted' }, total ? `${plural(total, 'match')} on ${plural(new Set(hits.map((x) => x.pi)).size, 'page')}` : 'No matches.'));
      hits.slice(0, 40).forEach((x) => {
        const t = String(x.el.text).replace(/\s+/g, ' ');
        re.lastIndex = 0;
        const m = re.exec(t);
        const at = m ? m.index : 0, a = Math.max(0, at - 24);
        res.append(h('button', { class: 'fr-hit', onclick: () => { E.setPage(x.pi); E.select([x.el.id]); } },
          h('b', null, 'Page ' + (x.pi + 1)), h('span', null, (a ? '…' : '') + t.slice(a, at)), h('mark', null, m ? m[0] : ''), h('span', null, t.slice(at + (m ? m[0].length : 0), at + 60))));
      });
    };
    [f, mc, ww].forEach((x) => x.addEventListener(x === f ? 'input' : 'change', scan));
    const body = h('div', null, h('div', { class: 'row2' }, f, r), h('div', { style: { display: 'flex', gap: '18px' } }, h('label', { class: 'tog', for: 'fr-case' }, mc, ' Match case'), h('label', { class: 'tog', for: 'fr-word' }, ww, ' Whole words')), res);
    scan();
    GS.modal({ title: 'Find & replace', body, actions: [{ label: 'Close' }, { label: 'Replace all', kind: 'primary', onClick: () => {
      const re = rx();
      if (!re) return false;
      let n = 0, skipped = 0;
      E.design.pages.forEach((p) => p.els.forEach((el) => {
        if (el.type !== 'text') return;
        re.lastIndex = 0;
        if (!re.test(String(el.text))) return;
        if (el.lock) { skipped++; return; }
        el.text = String(el.text).replace(re, () => { n++; return r.value; });
        R.syncText(el);
      }));
      if (n) { E.commit(); E.render(); GS.bus.emit('sel'); GS.bus.emit('pages'); }
      GS.toast(n ? `Replaced ${plural(n, 'match')}` + (skipped ? ` (${plural(skipped, 'locked text box')} skipped)` : '') : skipped ? 'The matches are in locked text. Unlock it first.' : 'Nothing to replace.', n ? 'ok' : '');
      scan();
      return false;
    } }] });
  };

  // ---------- bulk create: one page per row of a pasted list ----------
  function parseTable(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return null;
    const first = text.split('\n')[0];
    const delim = first.includes('\t') ? '\t' : first.includes(',') ? ',' : first.includes(';') ? ';' : '\t';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"' && !cell.trim()) { q = true; cell = ''; continue; }
      if (ch === delim) { row.push(cell); cell = ''; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    row.push(cell); rows.push(row);
    const clean = rows.map((x) => x.map((c) => c.trim())).filter((x) => x.some((c) => c));
    if (!clean.length) return null;
    const cols = clean[0].map((c, i) => c || 'Column ' + (i + 1));
    return { cols, rows: clean.slice(1).map((x) => Object.fromEntries(cols.map((c, i) => [c, x[i] || '']))) };
  }
  const holes = (s) => [...String(s).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  T.bulkCreate = function () {
    if (!E.design) return;
    E.endEdit();
    const pg = E.page();
    const texts = pg.els.filter((e) => e.type === 'text');
    if (!texts.length) { GS.toast('Add text to this page first. It becomes the layout for every row.', 'err'); return; }
    let table = null;
    const conn = {};
    const ta = h('textarea', { class: 'input mono', id: 'bk-data', rows: 7, placeholder: 'Copy rows from Google Sheets or Excel and paste here. First row = column names.\n\nCheese\tPrice\tMilk\nComté 24 mo\t$28/lb\tCow\nHumboldt Fog\t$32/lb\tGoat' });
    const info = h('p', { class: 'muted', style: { fontSize: '13px', margin: '8px 0' } });
    const map = h('div', { class: 'bk-map' });
    const sep = h('input', { type: 'checkbox', id: 'bk-sep' });
    const draw = () => {
      table = parseTable(ta.value);
      map.innerHTML = '';
      if (!table || !table.rows.length) { info.textContent = table ? 'Add at least one row under the column names.' : 'Each row makes one page. Put {{Column name}} in your text, or connect text boxes below.'; return; }
      info.textContent = `${plural(table.rows.length, 'row')} · columns: ${table.cols.join(', ')}`;
      map.append(h('h4', null, 'Connect text boxes on this page'));
      texts.forEach((el) => {
        const hs = holes(el.text);
        const label = h('span', { class: 'bk-el' }, E.elName(el));
        if (hs.length) {
          map.append(h('div', { class: 'bk-row' }, label, h('span', { class: 'bk-holes' }, hs.map((x) => h('code', { class: table.cols.includes(x) ? 'ok' : 'bad', title: table.cols.includes(x) ? 'Filled from the ' + x + ' column' : 'No column called ' + x }, '{{' + x + '}}')))));
          return;
        }
        const s = h('select', { class: 'select', 'aria-label': 'Column for ' + E.elName(el) }, h('option', { value: '' }, 'Keep as is'), table.cols.map((c) => h('option', { value: c }, c)));
        if (conn[el.id] && table.cols.includes(conn[el.id])) s.value = conn[el.id];
        else { const g = table.cols.find((c) => String(el.text).trim().toLowerCase() === c.toLowerCase()); if (g) { s.value = g; conn[el.id] = g; } }
        s.addEventListener('change', () => (conn[el.id] = s.value));
        map.append(h('div', { class: 'bk-row' }, label, s));
      });
    };
    ta.addEventListener('input', GS.debounce(draw, 150));
    const body = h('div', null, h('p', { class: 'muted', style: { margin: '0 0 10px', fontSize: '13px' } }, 'Make price signs, name cards or cheese cards from a list. This page is the layout; every row becomes a page in a new design.'), ta, info, map,
      h('label', { class: 'tog', for: 'bk-sep' }, 'Make each row its own design instead', sep));
    draw();
    GS.modal({ title: 'Bulk create', wide: true, body, actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'gold', onClick: async () => {
      if (!table || !table.rows.length) { GS.toast('Paste a list first.', 'err'); return false; }
      const rows = table.rows.slice(0, 200);
      const fill = (el, row) => {
        const hs = holes(el.text);
        if (hs.length) el.text = String(el.text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, k) => (k in row ? row[k] : all));
        else if (conn[el.id]) el.text = row[conn[el.id]] || '';
        R.syncText(el);
      };
      const pageFor = (row) => {
        const gmap = {};
        const p = { id: GS.uid('p'), bg: GS.clone(pg.bg || { color: '#FFFFFF' }), els: pg.els.map((e) => { const c = GS.clone(e); c.id = GS.uid('e'); if (c.gid) c.gid = gmap[c.gid] || (gmap[c.gid] = GS.uid('g')); if (c.type === 'text') { c.text = e.text; fill(c, Object.assign({}, row)); } return c; }) };
        if (pg.guides) p.guides = GS.clone(pg.guides);
        return p;
      };
      const d0 = E.design, base = d0.name || 'Design';
      const firstCol = table.cols[0];
      if (sep.checked) {
        if (rows.length > 40 && !(await GS.confirmModal(`Make ${rows.length} separate designs?`, 'Make them'))) return false;
        GS.toast(`Making ${plural(rows.length, 'design')}…`);
        for (const row of rows) {
          const d = { id: GS.uid('d'), name: `${row[firstCol] || base}`.slice(0, 80), w: d0.w, h: d0.h, unit: d0.unit, kind: d0.kind, createdAt: Date.now(), pages: [pageFor(row)] };
          await GS.Store.saveDesign(d, thumbFor(d)).catch((e) => GS.toast(e.message || 'A design did not save', 'err'));
        }
        GS.toast(`Made ${plural(rows.length, 'design')}. They’re on the home screen.`, 'ok');
        return;
      }
      const d = { id: GS.uid('d'), name: (base + ' · ' + plural(rows.length, 'row')).slice(0, 80), w: d0.w, h: d0.h, unit: d0.unit, kind: d0.kind, createdAt: Date.now(), pages: rows.map(pageFor) };
      await E.save();
      await E.close();
      GS.UI.openDesign(d, { isNew: true, saveNow: true });
      GS.toast(`Made ${plural(rows.length, 'page')}. Download as PDF to print them all.`, 'ok');
    } }] });
  };

  // ---------- version history ----------
  const V = () => GS.Store.versions;
  function thumbFor(d, pageIdx = 0) {
    const s = Math.min(280 / d.w, 280 / d.h);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(d.w * s)); cv.height = Math.max(1, Math.round(d.h * s));
    const ctx = cv.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    R.drawPage(ctx, d, d.pages[pageIdx], { scale: s });
    try { return cv.toDataURL('image/jpeg', 0.74); } catch (e) { return ''; }
  }
  T.thumbFor = thumbFor;
  const snapOf = (d) => ({ id: d.id, name: d.name, w: d.w, h: d.h, unit: d.unit, pages: GS.clone(d.pages) });
  const TEN_MIN = 10 * 60 * 1000;
  let sess = null; // this editing session: the design as it opened, and when we last kept a version
  GS.bus.on('opened', (d, opts) => { sess = { id: d.id, isNew: !!(opts && opts.isNew), base: snapOf(d), done: !!(opts && opts.isNew), lastAt: opts && opts.isNew ? Date.now() : 0 }; });
  GS.bus.on('designsaved', async (d, thumb) => {
    if (!sess || !d || d.id !== sess.id || !V()) return;
    try {
      if (!(await V().available())) return;
      const now = Date.now();
      if (!sess.done) {
        sess.done = true; sess.lastAt = now;
        // keep how it looked before this session's edits, unless a version was kept in the last 10 minutes
        if (now - (await V().latestAt(d.id)) > TEN_MIN) await V().add(sess.base, thumbFor(sess.base), 'opened');
      } else if (now - sess.lastAt > TEN_MIN) { sess.lastAt = now; await V().add(snapOf(d), thumb, 'auto'); }
    } catch (e) { console.warn('version history', e); }
  });
  const REASON = { opened: 'Before editing started', auto: 'While editing', restore: 'Before a restore', manual: 'Saved by hand' };
  const when = (t) => { const d = new Date(t); const today = new Date().toDateString() === d.toDateString(); return (today ? 'Today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  T.history = async function () {
    if (!E.design) return;
    E.endEdit();
    const list = h('div', { class: 'vh-list' }, h('p', { class: 'muted' }, 'Loading…'));
    const big = h('div', { class: 'vh-prev' }, h('p', { class: 'muted' }, 'Pick a version to see it.'));
    let picked = null;
    const m = GS.modal({ title: 'Version history', wide: true, body: h('div', { class: 'vh' }, list, big), actions: [
      { label: 'Save a version now', onClick: async () => { await E.save(); const ok = V() && (await V().add(snapOf(E.design), thumbFor(E.design), 'manual')); GS.toast(ok ? 'Version saved' : 'Version history isn’t switched on yet.', ok ? 'ok' : 'err'); if (ok) load(); return false; } },
      { label: 'Close' },
    ] });
    const pick = (v, row) => {
      picked = v;
      list.querySelectorAll('.vh-item').forEach((x) => x.classList.toggle('on', x === row));
      big.innerHTML = '';
      big.append(v.thumb ? h('img', { src: v.thumb, alt: 'Version preview' }) : h('div', { class: 'muted' }, 'No preview'), h('p', null, h('b', null, when(v.at)), h('br'), REASON[v.reason] || 'Saved', ' · ', plural(v.pageCount || 1, 'page')),
        h('div', { class: 'vh-btns' }, h('button', { class: 'btn primary', onclick: () => restore(v) }, GS.iconEl('history', 16), 'Restore this version'), h('button', { class: 'btn', onclick: () => copyOf(v) }, GS.iconEl('copy', 16), 'Make a copy')));
    };
    const load = async () => {
      list.innerHTML = '';
      if (!V() || !(await V().available())) { list.append(h('p', { class: 'muted' }, 'Version history needs a one-time database update (supabase/sql/2026-11-15_studio_versions.sql). Until then, undo works while the design is open.')); big.innerHTML = ''; return; }
      let vs = [];
      try { vs = (await V().list(E.design.id)) || []; } catch (e) { list.append(h('p', { class: 'muted' }, 'Couldn’t load versions. Try again.')); return; }
      if (!vs.length) { list.append(h('p', { class: 'muted' }, 'No earlier versions yet. Studio keeps one when someone starts editing, then every 10 minutes while they work.')); return; }
      vs.forEach((v) => { const row = h('button', { class: 'vh-item', onclick: () => pick(v, row) }, v.thumb ? h('img', { src: v.thumb, alt: '' }) : h('span'), h('span', null, h('b', null, when(v.at)), h('small', null, REASON[v.reason] || 'Saved'))); list.append(row); });
      pick(vs[0], list.querySelector('.vh-item'));
    };
    async function restore(v) {
      const full = await V().get(v.id).catch(() => null);
      if (!full || !full.pages.length) { GS.toast('That version couldn’t be loaded.', 'err'); return; }
      await E.save();
      await V().add(snapOf(E.design), thumbFor(E.design), 'restore');
      const d = E.design;
      d.w = full.w; d.h = full.h; d.unit = full.unit; d.pages = GS.clone(full.pages);
      d.pages.forEach((p) => p.els.forEach((el) => R.syncText(el)));
      E.pi = 0; E.sel = [];
      E.commit(); E.fit(); R.preload(d);
      GS.bus.emit('design'); GS.bus.emit('pages'); GS.bus.emit('sel');
      m.close();
      GS.toast('Restored the version from ' + when(v.at) + '. Undo brings back what you had.', 'ok');
    }
    async function copyOf(v) {
      const full = await V().get(v.id).catch(() => null);
      if (!full) { GS.toast('That version couldn’t be loaded.', 'err'); return; }
      const d = { id: GS.uid('d'), name: ((E.design.name || 'Design') + ' · ' + when(v.at)).slice(0, 80), w: full.w, h: full.h, unit: full.unit, kind: E.design.kind, createdAt: Date.now(), pages: GS.clone(full.pages) };
      await GS.Store.saveDesign(d, v.thumb).then(() => GS.toast('Copy saved to your designs', 'ok')).catch((e) => GS.toast(e.message || 'Could not make a copy', 'err'));
    }
    load();
  };

  // ---------- keyboard shortcuts ----------
  const KEYS = [
    ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'], ['Save now', 'Ctrl+S'], ['Duplicate', 'Ctrl+D'], ['Copy / paste', 'Ctrl+C / Ctrl+V'],
    ['Select all', 'Ctrl+A'], ['Group / ungroup', 'Ctrl+G / Ctrl+Shift+G'], ['Bring forward / to front', 'Ctrl+] / Ctrl+Shift+]'], ['Send backward / to back', 'Ctrl+[ / Ctrl+Shift+['],
    ['Nudge', 'Arrow keys (Shift = 10)'], ['Add text', 'T'], ['Edit text, crop photo, edit QR link', 'Enter'], ['Price-list tab (inside text)', 'Tab'],
    ['Move without snapping', 'Hold Ctrl or Alt while dragging'], ['Straight line move', 'Hold Shift while dragging'], ['Rulers & guides', 'Shift+R'], ['Find & replace', 'Ctrl+F'],
    ['Zoom in / out / fit', 'Ctrl+= / Ctrl+- / Ctrl+0'], ['Deselect / stop cropping', 'Esc'], ['This list', '?'],
  ];
  T.shortcuts = function () {
    const t = h('div', { class: 'keys' });
    KEYS.forEach(([a, b]) => t.append(h('span', null, a), h('kbd', null, b)));
    GS.modal({ title: 'Keyboard shortcuts', body: h('div', null, t, h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 0' } }, 'On a Mac use Cmd instead of Ctrl.')) });
  };

  // ---------- keys, and don't lose work ----------
  document.addEventListener('keydown', (e) => {
    if (!inEditor() || document.querySelector('.modal-wrap') || typing(e.target) || E.editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); T.findReplace(); }
    else if (!mod && e.key === '?') { e.preventDefault(); T.shortcuts(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (E.design && (E.dirty || E.saving)) { E.save(); e.preventDefault(); e.returnValue = ''; }
  });
})();
