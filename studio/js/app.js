/* GREYS Studio — home screen, routing, editor chrome, export + resize dialogs */
(function () {
  const GS = window.GS, E = GS.E, R = GS.R, P = GS.P, h = GS.h, $ = GS.$;
  const UI = (GS.UI = {});
  const home = $('#home'), editor = $('#editor');
  const inEditor = () => !editor.hidden;

  // ---------- static chrome ----------
  $('#home-create').innerHTML = GS.icon('plus', 18) + '<span>Create a design</span>';
  $('#ed-back').innerHTML = GS.icon('back', 22);
  $('#ed-undo').innerHTML = GS.icon('undo', 20);
  $('#ed-redo').innerHTML = GS.icon('redo', 20);
  $('#ed-resize').innerHTML = GS.icon('resize', 16) + '<span>Resize</span>';
  $('#ed-download').innerHTML = GS.icon('download', 18) + '<span class="lbl">Download</span>';
  E.mount($('#stage'));
  P.buildRail();

  // ---------- home ----------
  function sizeIcon(w, hh) {
    const s = Math.min(54 / w, 46 / hh);
    return h('div', { class: 'shape' }, h('i', { style: { width: Math.max(10, w * s) + 'px', height: Math.max(8, hh * s) + 'px' } }));
  }
  function renderSizes() {
    const row = $('#size-row');
    row.innerHTML = '';
    GS.SIZES.forEach((s) => row.append(h('button', { class: 'size-card', onclick: () => UI.newFromSize(s) }, sizeIcon(s.w, s.h), h('b', null, s.label), h('small', null, GS.sizeText(s.w, s.h, s.unit)))));
    row.append(h('button', { class: 'size-card', onclick: () => UI.customSize() }, h('div', { class: 'shape' }, GS.iconEl('plus', 28)), h('b', null, 'Custom size'), h('small', null, 'px or inches')));
  }
  function renderTemplates() {
    const g = $('#home-templates');
    g.innerHTML = '';
    GS.TEMPLATES.forEach((t) => g.append(P.tplCard(t, () => UI.newFromTemplate(t))));
  }
  function statusHTML(where) {
    const m = GS.Store.mode;
    if (m === 'cloud') return GS.icon('cloudcheck', 16) + `<span>${where === 'home' ? 'Designs save to GREYS Studio' : 'Saved'}</span>`;
    if (m === 'local') return GS.icon('device', 16) + '<span>Saving on this device</span>';
    return GS.icon('cloud', 16) + '<span>Connecting…</span>';
  }
  function renderDesigns() {
    const g = $('#home-designs');
    g.innerHTML = '';
    $('#home-status').innerHTML = statusHTML('home');
    const S = GS.Store;
    const note = $('#designs-note');
    note.textContent = S.slow ? 'Can’t reach saved designs yet. Showing what’s loaded.' : S.dbError ? 'Saved designs couldn’t load. Reload to try again.' : S.mode === 'local' ? 'Kept in this browser. Open on claude.ai to save to the cloud.' : '';
    if (!S.designsLoaded) { for (let i = 0; i < 4; i++) g.append(h('div', { class: 'skel' })); return; }
    if (!S.designs.length) { renderFilter(0, 0); g.append(h('div', { class: 'empty' }, h('b', null, 'No designs yet. '), 'Pick a size above or start from a GREYS template below.')); return; }
    // filter chips (only once there are cheese cards to split out) + search
    const isCard = (d) => d.kind === 'cheese-card';
    const nCards = S.designs.filter(isCard).length;
    if (!nCards && homeFilter !== 'all') homeFilter = 'all';
    renderFilter(nCards, S.designs.length - nCards);
    const q = fold($('#designs-q').value);
    let list = S.designs;
    if (homeFilter === 'cards') list = list.filter(isCard).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    else if (homeFilter === 'other') list = list.filter((d) => !isCard(d));
    if (q) list = list.filter((d) => fold(d.name).includes(q));
    if (!list.length) { g.append(h('div', { class: 'empty' }, h('b', null, 'Nothing matches. '), q ? 'Try a different search.' : 'Pick another filter.')); return; }
    list.forEach((d) => {
      const img = d.thumb ? h('img', { src: d.thumb, alt: '' }) : h('div', { class: 'muted' }, GS.iconEl('image', 28));
      const more = h('button', { class: 'ibtn sm', title: 'More', 'aria-label': 'More actions for ' + d.name, html: GS.icon('more', 18), onclick: (e) => { e.stopPropagation(); designMenu(more, d); } });
      g.append(h('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => UI.openById(d.id), onkeydown: (e) => { if (e.key === 'Enter') UI.openById(d.id); } },
        h('div', { class: 'thumb' }, img, d.pageCount > 1 ? h('span', { class: 'pill' }, d.pageCount + ' pages') : null),
        h('div', { class: 'meta' }, h('div', null, h('div', { class: 't' }, d.name || 'Untitled'), h('div', { class: 's' }, GS.fmtAgo(d.updatedAt) + ' · ' + GS.sizeText(d.w, d.h, d.unit))), more)));
    });
  }
  let homeFilter = 'all';
  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  function renderFilter(nCards, nOther) {
    const box = $('#designs-filter');
    box.innerHTML = '';
    $('#designs-q').hidden = nCards + nOther < 7;
    if (!nCards) return;
    [['all', 'All', nCards + nOther], ['cards', 'Cheese cards', nCards], ['other', 'Everything else', nOther]].forEach(([k, label, n]) => {
      box.append(h('button', { class: 'chip' + (homeFilter === k ? ' on' : ''), 'aria-pressed': homeFilter === k ? 'true' : 'false', onclick: () => { homeFilter = k; renderDesigns(); } }, `${label} · ${n}`));
    });
  }
  $('#designs-q').addEventListener('input', GS.debounce(() => renderDesigns(), 120));
  function designMenu(anchor, d) {
    const m = h('div', { class: 'menu' },
      h('button', { onclick: () => { GS.pop.close(); UI.openById(d.id); } }, GS.iconEl('edit', 18), 'Open'),
      h('button', { onclick: async () => { GS.pop.close(); const n = await GS.promptModal('Rename design', d.name || ''); if (!n) return; const full = await GS.Store.getDesign(d.id); if (!full) return; full.name = n; await GS.Store.saveDesign(full, d.thumb).catch((e) => GS.toast(e.message || 'Could not rename', 'err')); } }, GS.iconEl('text', 18), 'Rename'),
      h('button', { onclick: async () => { GS.pop.close(); const full = await GS.Store.getDesign(d.id); if (!full) return; const copy = Object.assign(full, { id: GS.uid('d'), name: (d.name || 'Design') + ' copy', createdAt: Date.now() }); await GS.Store.saveDesign(copy, d.thumb).catch((e) => GS.toast(e.message || 'Could not duplicate', 'err')); GS.toast('Made a copy', 'ok'); } }, GS.iconEl('copy', 18), 'Make a copy'),
      h('hr'),
      h('button', { style: { color: 'var(--danger)' }, onclick: async () => { GS.pop.close(); if (await GS.confirmModal('Delete “' + (d.name || 'Untitled') + '”? This can’t be undone.', 'Delete', true)) GS.Store.deleteDesign(d.id).catch(() => GS.toast('Could not delete it', 'err')); } }, GS.iconEl('trash', 18), 'Delete'));
    GS.pop.open(anchor, m, { alignRight: true });
  }
  $('#home-create').onclick = () => {
    const m = h('div', { class: 'menu' });
    GS.SIZES.forEach((s) => m.append(h('button', { onclick: () => { GS.pop.close(); UI.newFromSize(s); } }, s.label, h('span', { class: 'k' }, GS.sizeText(s.w, s.h, s.unit)))));
    m.append(h('hr'), h('button', { onclick: () => { GS.pop.close(); UI.customSize(); } }, GS.iconEl('plus', 18), 'Custom size'));
    GS.pop.open($('#home-create'), m, { title: 'Create a design', alignRight: true });
  };
  GS.bus.on('designs', () => { if (!inEditor()) renderDesigns(); });
  GS.bus.on('store', () => { renderDesigns(); updateStatus(); });

  UI.customSize = function () {
    const w = h('input', { class: 'input', id: 'cs-w', type: 'number', value: 1080, min: 1 });
    const hh = h('input', { class: 'input', id: 'cs-h', type: 'number', value: 1080, min: 1 });
    const unit = h('select', { class: 'select', id: 'cs-unit' }, h('option', { value: 'px' }, 'Pixels'), h('option', { value: 'in' }, 'Inches'));
    unit.addEventListener('change', () => { if (unit.value === 'in' && +w.value > 60) { w.value = 8.5; hh.value = 11; } else if (unit.value === 'px' && +w.value < 60) { w.value = 1080; hh.value = 1080; } });
    GS.modal({
      title: 'Custom size',
      body: h('div', null, h('div', { class: 'row2' }, h('label', null, h('span', { class: 'flabel' }, 'Width'), w), h('label', null, h('span', { class: 'flabel' }, 'Height'), hh)), h('label', null, h('span', { class: 'flabel' }, 'Units'), unit)),
      actions: [{ label: 'Cancel' }, { label: 'Create design', kind: 'primary', onClick: () => {
        const k = unit.value === 'in' ? 96 : 1;
        const W = Math.round(+w.value * k), H = Math.round(+hh.value * k);
        if (!(W >= 16 && H >= 16 && W <= 8000 && H <= 8000)) { GS.toast('Use a size between 16 and 8,000 pixels a side.', 'err'); return false; }
        UI.newFromSize({ label: 'design', w: W, h: H, unit: unit.value, k: 'custom' });
      } }],
    });
  };

  // ---------- open / close ----------
  UI.newFromSize = (s) => openDesign(GS.newDesign(s), { isNew: true, blank: true });
  UI.newFromTemplate = (t) => openDesign(GS.fromTemplate(t), { isNew: true });
  function showEditor() { home.hidden = true; editor.hidden = false; GS.pop.close(); }
  function openDesign(design, opts = {}) {
    showEditor();
    E.open(design);
    $('#ed-name').value = design.name || '';
    if (!GS.isMobile()) P.open(opts.blank ? 'templates' : opts.isNew ? 'uploads' : 'templates');
    else P.close();
    E.fit();
    if (opts.saveNow) { E.dirty = true; E.save(); }
    if (!opts.isNew || opts.saveNow) setHash();
    else if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* keep */ } }
    saveState = 'saved';
    updateStatus();
    GS.TB.render();
  }
  UI.openById = async function (id) {
    showEditor();
    $('#ctx').innerHTML = '<span class="lbl">Opening…</span>';
    try {
      const d = await GS.Store.getDesign(id);
      if (!d) throw new Error('missing');
      openDesign(d);
    } catch (e) {
      GS.toast('That design couldn’t be opened.', 'err');
      UI.goHome();
    }
  };
  UI.goHome = async function () {
    await E.close();
    GS.pop.close();
    P.close();
    editor.hidden = true; home.hidden = false;
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname + location.search); }
      catch (e) { suppressHash = true; location.hash = ''; }
    }
    renderDesigns();
    GS.redrawLive();
  };
  $('#ed-back').onclick = () => UI.goHome();

  let suppressHash = false;
  function setHash() {
    if (!E.design) return;
    const tag = 'd-' + E.design.id;
    if (location.hash.slice(1) !== tag) { suppressHash = true; location.hash = tag; }
  }
  async function route() {
    if (suppressHash) { suppressHash = false; return; }
    const m = /^#d-([a-z0-9]+)$/i.exec(location.hash);
    if (m) {
      if (E.design && E.design.id === m[1]) return;
      await GS.Store.ready;
      if (E.design) await E.close();
      UI.openById(m[1]);
    } else if (inEditor()) UI.goHome();
  }
  window.addEventListener('hashchange', route);

  // ---------- editor chrome ----------
  $('#ed-name').addEventListener('change', () => { if (!E.design) return; E.design.name = $('#ed-name').value.trim() || 'Untitled design'; E.markDirty(); });
  $('#ed-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  $('#ed-undo').onclick = () => E.undo();
  $('#ed-redo').onclick = () => E.redo();
  $('#ed-resize').onclick = () => UI.resizeDialog();
  $('#ed-download').onclick = () => UI.exportDialog();
  GS.bus.on('history', () => { $('#ed-undo').disabled = E.hi <= 0; $('#ed-redo').disabled = E.hi >= E.hist.length - 1; });
  GS.bus.on('design', () => { if (E.design) $('#ed-name').value = E.design.name || ''; });
  let saveState = 'saved', saveErrShown = false;
  function updateStatus() {
    const el = $('#ed-status');
    el.classList.toggle('err', saveState === 'error');
    if (saveState === 'saving') el.innerHTML = GS.icon('cloud', 16) + '<span>Saving…</span>';
    else if (saveState === 'error') el.innerHTML = GS.icon('cloud', 16) + '<span>Not saved</span>';
    else if (saveState === 'dirty') el.innerHTML = GS.icon('cloud', 16) + '<span>Edited</span>';
    else el.innerHTML = statusHTML('ed');
  }
  GS.bus.on('save', (st, err) => {
    saveState = st;
    updateStatus();
    if (st === 'saved' && inEditor()) setHash();
    if (st === 'error' && !saveErrShown) {
      saveErrShown = true;
      GS.toast(err && err.code === 'too_big' ? err.message : GS.Store.readOnly ? 'You can view designs here but not save changes.' : 'Couldn’t save. Retrying when you make the next change.', 'err');
      setTimeout(() => (saveErrShown = false), 15000);
    }
  });

  // pages strip
  function renderPages() {
    const box = $('#pages');
    box.innerHTML = '';
    if (!E.design) return;
    E.design.pages.forEach((p, i) => {
      const cv = R.thumb(E.design, p, 80, 30);
      box.append(h('button', { class: 'pg' + (i === E.pi ? ' on' : ''), title: 'Page ' + (i + 1), 'aria-label': 'Page ' + (i + 1), onclick: () => E.setPage(i) }, cv, E.design.pages.length > 1 ? h('b', null, i + 1) : null));
    });
    box.append(h('button', { class: 'ibtn sm', title: 'Add page', 'aria-label': 'Add page', html: GS.icon('plus', 18), onclick: () => E.addPage() }));
    const on = box.querySelector('.pg.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const pagesSoon = GS.debounce(renderPages, 450);
  GS.bus.on('pages', renderPages);
  GS.bus.on('design', renderPages);
  GS.bus.on('pagesdirty', pagesSoon);
  GS.bus.on('imgloaded', pagesSoon);
  GS.bus.on('fontsloaded', pagesSoon);

  // zoom control
  function renderZoom() {
    const z = $('#zoom');
    z.innerHTML = '';
    if (!E.design) return;
    const pct = h('button', { class: 'z', title: 'Zoom', onclick: () => {
      const m = h('div', { class: 'menu' });
      [['Fit to screen', () => E.fit()], ['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['100%', 1], ['150%', 1.5], ['200%', 2]].forEach(([l, v]) => m.append(h('button', { onclick: () => { GS.pop.close(); typeof v === 'function' ? v() : E.zoomTo(v); } }, l)));
      GS.pop.open(pct, m, { above: true, alignRight: true });
    } }, Math.round(E.zoom * 100) + '%');
    z.append(h('button', { class: 'ibtn sm', title: 'Zoom out', 'aria-label': 'Zoom out', html: GS.icon('zoomout', 18), onclick: () => E.zoomTo(E.zoom / 1.25) }), pct,
      h('button', { class: 'ibtn sm', title: 'Zoom in', 'aria-label': 'Zoom in', html: GS.icon('zoomin', 18), onclick: () => E.zoomTo(E.zoom * 1.25) }),
      h('button', { class: 'ibtn sm', title: 'Fit (Ctrl+0)', 'aria-label': 'Fit to screen', html: GS.icon('fit', 18), onclick: () => E.fit() }));
  }
  GS.bus.on('zoom', renderZoom);
  GS.bus.on('design', renderZoom);

  // ---------- images: replace flow ----------
  UI.replaceImage = function (id) {
    E.replaceTarget = id;
    P.open('uploads');
    GS.bus.emit('replacemode');
  };
  UI.uploadInto = (id) => P.pickFiles(id);
  GS.bus.on('pickimage', (id) => UI.replaceImage(id));
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files; if (f && f.length) P.handleFiles(f); });

  // ---------- export ----------
  UI.exportDialog = function () {
    if (!E.design) return;
    E.endEdit();
    const d = E.design;
    const print = d.unit === 'in';
    const maxS = GS.X.maxScale(d);
    let type = print ? 'pdf' : 'png', scale = print ? Math.min(3.125, maxS) : d.w <= 700 ? Math.min(2, maxS) : 1, which = 'all', transparent = false;
    const body = h('div');
    const typeSeg = h('div', { class: 'seg' }), scaleSeg = h('div', { class: 'seg' }), pageSeg = h('div', { class: 'seg' });
    const tr = h('input', { type: 'checkbox', id: 'ex-tr' });
    const trRow = h('label', { class: 'tog', for: 'ex-tr' }, 'Transparent background', tr);
    const info = h('p', { class: 'muted', style: { margin: '12px 0 0', fontSize: '13px' } });
    const prev = h('div', { class: 'dl-prev', hidden: true });
    tr.addEventListener('change', () => (transparent = tr.checked));
    const scales = () => (print ? [[1, 'Screen'], [2, '2×'], [3.125, 'Print · 300 dpi']] : [[1, '1×'], [2, '2×'], [3, '3×']]).filter(([s]) => s <= maxS + 0.001);
    const draw = () => {
      typeSeg.innerHTML = ''; scaleSeg.innerHTML = ''; pageSeg.innerHTML = '';
      [['png', 'PNG'], ['jpg', 'JPG'], ['pdf', 'PDF']].forEach(([k, l]) => typeSeg.append(h('button', { class: type === k ? 'on' : '', onclick: () => { type = k; draw(); } }, l)));
      const sc = scales();
      if (!sc.some(([s]) => s === scale)) scale = sc[sc.length - 1][0];
      sc.forEach(([s, l]) => scaleSeg.append(h('button', { class: scale === s ? 'on' : '', onclick: () => { scale = s; draw(); } }, l)));
      [['current', 'This page'], ['all', `All ${d.pages.length} pages`]].forEach(([k, l]) => pageSeg.append(h('button', { class: which === k ? 'on' : '', onclick: () => { which = k; draw(); } }, l)));
      trRow.hidden = type !== 'png';
      const pw = Math.round(d.w * scale), ph = Math.round(d.h * scale);
      const many = which === 'all' && d.pages.length > 1;
      info.textContent = `${pw} × ${ph} px` + (print ? ` · ${GS.sizeLabel(d)}` : '') + (many && type !== 'pdf' ? ' · pages come zipped together' : '') + (type === 'pdf' ? ' · best for printing' : type === 'jpg' ? ' · smallest file' : ' · best for social and email');
    };
    body.append(h('span', { class: 'flabel', style: { marginTop: 0 } }, 'File type'), typeSeg, h('span', { class: 'flabel' }, 'Size'), scaleSeg);
    if (d.pages.length > 1) body.append(h('span', { class: 'flabel' }, 'Pages'), pageSeg);
    body.append(trRow, info, prev);
    draw();
    const dl = GS.Store.caps.downloads;
    if (!dl) body.append(h('p', { class: 'banner', style: { marginTop: '12px' } }, 'Downloads work when GREYS Studio is open on claude.ai. Here you can copy the image or right-click the preview to save it.'));
    const run = async (mode) => {
      const pages = which === 'current' || d.pages.length === 1 ? [E.pi] : d.pages.map((_, i) => i);
      const btns = m.card.querySelectorAll('.modal-actions .btn');
      btns.forEach((b) => (b.disabled = true));
      GS.toast('Preparing your file…');
      try {
        const out = await GS.X.exportBlob({ design: d, pages, type: mode === 'copy' ? 'png' : type, scale, transparent });
        if (/^image\//.test(out.blob.type)) { prev.hidden = false; prev.innerHTML = ''; prev.append(h('img', { src: URL.createObjectURL(out.blob), alt: 'Export preview' })); }
        if (mode === 'copy') { await GS.X.copyImage(out.blob); GS.toast('Image copied', 'ok'); }
        else { await GS.X.save(out.filename, out.blob); GS.toast('Saved ' + out.filename, 'ok'); m.close(); }
      } catch (e) {
        const c = e && e.code;
        if (c === 'declined') { /* viewer said no */ }
        else if (c === 'rate_limited') GS.toast('A save prompt is already open. Try again in a moment.', 'err');
        else if (c === 'too_large') GS.toast('That file is too big. Try a smaller size.', 'err');
        else if (c === 'unavailable' || c === 'not_granted' || c === 'capability_disabled') GS.toast('Downloads aren’t available in this view. Use Copy image instead.', 'err');
        else GS.toast((e && e.message) || 'Export failed', 'err');
      }
      btns.forEach((b) => (b.disabled = false));
    };
    const actions = [{ label: 'Copy image', onClick: () => { run('copy'); return false; } }];
    actions.push({ label: 'Download', kind: 'gold', onClick: () => { run('save'); return false; } });
    const m = GS.modal({ title: 'Download', body, actions });
  };

  // ---------- resize ----------
  UI.resizeDialog = function () {
    if (!E.design) return;
    const d = E.design;
    let pick = null;
    const list = h('div', { class: 'menu', style: { maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '10px', padding: '4px' } });
    const w = h('input', { class: 'input', type: 'number', value: d.unit === 'in' ? GS.round(d.w / 96, 2) : d.w, 'aria-label': 'Width' });
    const hh = h('input', { class: 'input', type: 'number', value: d.unit === 'in' ? GS.round(d.h / 96, 2) : d.h, 'aria-label': 'Height' });
    const unit = h('select', { class: 'select', 'aria-label': 'Units' }, h('option', { value: 'px' }, 'px'), h('option', { value: 'in' }, 'in'));
    unit.value = d.unit === 'in' ? 'in' : 'px';
    const sc = h('input', { type: 'checkbox', checked: true, id: 'rs-scale' });
    GS.SIZES.forEach((s) => list.append(h('button', { onclick: (e) => {
      pick = s; unit.value = s.unit === 'in' ? 'in' : 'px';
      w.value = s.unit === 'in' ? GS.round(s.w / 96, 2) : s.w; hh.value = s.unit === 'in' ? GS.round(s.h / 96, 2) : s.h;
      list.querySelectorAll('button').forEach((b) => (b.style.background = '')); e.currentTarget.style.background = '#E3EEFF';
    } }, s.label, h('span', { class: 'k' }, GS.sizeText(s.w, s.h, s.unit)))));
    const read = () => {
      const k = unit.value === 'in' ? 96 : 1;
      const W = Math.round(+w.value * k), H = Math.round(+hh.value * k);
      if (!(W >= 16 && H >= 16 && W <= 8000 && H <= 8000)) { GS.toast('Use a size between 16 and 8,000 pixels a side.', 'err'); return null; }
      return { W, H, unit: unit.value };
    };
    GS.modal({
      title: 'Resize design',
      wide: true,
      body: h('div', null, list, h('div', { class: 'row2', style: { gridTemplateColumns: '1fr 1fr 90px', marginTop: '12px' } }, w, hh, unit), h('label', { class: 'tog', for: 'rs-scale' }, 'Scale everything to fit the new size', sc)),
      actions: [
        { label: 'Make a resized copy', onClick: async () => {
          const r = read(); if (!r) return false;
          await E.save();
          const copy = GS.clone(E.design);
          copy.id = GS.uid('d'); copy.name = (E.design.name || 'Design') + (pick ? ' · ' + pick.label : ' · resized'); copy.createdAt = Date.now();
          copy.pages.forEach((p) => E.fitPage(p, copy.w, copy.h, r.W, r.H, sc.checked));
          copy.w = r.W; copy.h = r.H; copy.unit = r.unit; copy.kind = pick ? pick.k : 'custom';
          await E.close();
          openDesign(copy, { isNew: true, saveNow: true });
        } },
        { label: 'Resize this design', kind: 'primary', onClick: () => { const r = read(); if (!r) return false; E.resizeDesign(r.W, r.H, r.unit, sc.checked); if (pick) E.design.kind = pick.k; } },
      ],
    });
  };

  // ---------- keyboard, clipboard ----------
  document.addEventListener('keydown', (e) => {
    if (!inEditor() || document.querySelector('.modal-wrap')) return;
    E.onKey(e);
  });
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  document.addEventListener('copy', (e) => {
    if (!inEditor() || typing(e.target) || !E.sel.length) return;
    const n = E.copy();
    if (n) { e.clipboardData.setData('text/plain', 'greys-studio:' + n); e.preventDefault(); }
  });
  document.addEventListener('cut', (e) => {
    if (!inEditor() || typing(e.target) || !E.sel.length) return;
    const n = E.copy();
    if (n) { e.clipboardData.setData('text/plain', 'greys-studio:' + n); e.preventDefault(); E.del(); }
  });
  document.addEventListener('paste', async (e) => {
    if (!inEditor() || typing(e.target) || !E.design) return;
    const files = [...(e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
    const text = e.clipboardData.getData('text/plain') || '';
    e.preventDefault();
    if (files.length) { P.handleFiles(files); return; }
    if (text.startsWith('greys-studio:') || (!text && E.clip)) { E.paste(); return; }
    if (text.trim()) E.add(GS.mk.text({ text: text.trim().slice(0, 2000), font: 'Nunito Sans', size: 36 * E.u(), w: E.design.w * 0.7, align: 'center', color: GS.isDark((E.page().bg || {}).color || '#FFFFFF') ? '#FFF6E3' : '#06273A' }));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && E.dirty) E.save(); });
  window.addEventListener('pagehide', () => { if (E.dirty) E.save(); });
  window.addEventListener('resize', GS.debounce(() => { GS.TB.render(); }, 200));

  // ---------- boot ----------
  renderSizes();
  renderTemplates();
  renderDesigns();
  if (/^#d-/.test(location.hash)) route();
})();
