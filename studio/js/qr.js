/* GREYS Studio — QR codes. Canva users ask for QR codes on flyers all the time; ours are a real element
   (type 'qr': data, fg, bg, ecc) drawn as vector squares, so they stay sharp at any size and in print.
   The encoder is vendor/qrcode.js (qrcode-generator by Kazuhiko Arase, MIT). */
(function () {
  const GS = window.GS;
  const cache = new Map();
  GS.QR = {
    // { n: modules per side, path: Path2D of the dark modules in module units } or null
    matrix(data, ecc = 'M') {
      if (!window.qrcode || !data) return null;
      const key = ecc + '|' + data;
      let m = cache.get(key);
      if (m !== undefined) return m;
      try {
        window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
        const q = window.qrcode(0, ecc);
        q.addData(String(data));
        q.make();
        const n = q.getModuleCount();
        const path = new Path2D();
        for (let r = 0; r < n; r++) {
          let c = 0;
          while (c < n) {
            if (!q.isDark(r, c)) { c++; continue; }
            let e = c;
            while (e < n && q.isDark(r, e)) e++;
            path.rect(c, r, e - c, 1);
            c = e;
          }
        }
        m = { n, path };
      } catch (err) { m = null; } // too long for a QR code
      if (cache.size > 60) cache.delete(cache.keys().next().value);
      cache.set(key, m);
      return m;
    },
    ok: (data) => !!GS.QR.matrix(data),
    // what people usually point a GREYS QR at
    LINKS: [['Website', 'https://greyscheese.com'], ['Tickets', 'https://tickets.greyscheese.com'], ['Order online', 'https://orderonline.greyscheese.com']],
    normalize(v) {
      v = String(v || '').trim();
      if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) v = 'https://' + v; // greyscheese.com -> https://greyscheese.com
      return v;
    },
  };
  GS.mk.qr = (o) => Object.assign({ id: GS.uid('e'), type: 'qr', x: 0, y: 0, w: 300, h: 300, rot: 0, op: 1, data: 'https://greyscheese.com', fg: '#06273A', bg: '#FFFFFF', ecc: 'M' }, o);

  // Ask for a link (new code, or edit the selected one). onDone(data)
  GS.qrDialog = function (current, onDone) {
    const h = GS.h;
    const inp = h('input', { class: 'input', id: 'qr-link', value: current || '', placeholder: 'https://tickets.greyscheese.com', 'aria-label': 'Link or text for the QR code' });
    const prev = document.createElement('canvas');
    prev.width = prev.height = 180;
    Object.assign(prev.style, { width: '120px', height: '120px', border: '1px solid var(--line)', borderRadius: '10px', background: '#fff' });
    const note = h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '8px 0 0' } });
    const draw = () => {
      const v = GS.QR.normalize(inp.value);
      const c = prev.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 180, 180);
      if (!v) { note.textContent = 'Paste a link. People scan it with their phone camera.'; return; }
      if (!GS.QR.ok(v)) { note.textContent = 'That’s too long for a QR code. Use a shorter link.'; return; }
      GS.R.drawEl(c, GS.mk.qr({ data: v, w: 180, h: 180 }), { scale: 1 });
      note.textContent = v.length > 120 ? 'Long links make dense codes. Print it at least 1 inch wide.' : 'Print it at least ¾ inch wide so phones can read it.';
    };
    inp.addEventListener('input', draw);
    const chips = h('div', { class: 'chips', style: { margin: '10px 0' } });
    GS.QR.LINKS.forEach(([l, u]) => chips.append(h('button', { class: 'chip', onclick: () => { inp.value = u; draw(); } }, l)));
    const body = h('div', null, inp, chips, h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, prev, note));
    setTimeout(draw, 0);
    GS.modal({
      title: current ? 'Edit QR code' : 'Add a QR code',
      body,
      actions: [{ label: 'Cancel' }, { label: current ? 'Update' : 'Add QR code', kind: 'primary', onClick: () => {
        const v = GS.QR.normalize(inp.value);
        if (!v || !GS.QR.ok(v)) { GS.toast(v ? 'That’s too long for a QR code.' : 'Paste a link first.', 'err'); return false; }
        onDone(v);
      } }],
    });
  };
})();
