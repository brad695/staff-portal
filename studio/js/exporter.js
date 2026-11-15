/* GREYS Studio — PNG / JPG / PDF / ZIP export */
(function () {
  const GS = window.GS;
  const X = (GS.X = {});
  const MAX_PIXELS = 16000000;

  X.maxScale = (d) => GS.clamp(Math.sqrt(MAX_PIXELS / (d.w * d.h)), 0.1, 6);
  X.fileBase = (d) => (String(d.name || 'GREYS design').replace(/[\\/:*?"<>|#%]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'GREYS design');

  // opts.bleed (design px): render that much extra on every side (background extended, nothing clipped at the trim)
  X.renderPage = function (design, page, scale, opts = {}) {
    const b = opts.bleed || 0;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round((design.w + b * 2) * scale));
    cv.height = Math.max(1, Math.round((design.h + b * 2) * scale));
    const ctx = cv.getContext('2d');
    if (opts.flatten) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height); }
    const sx = cv.width / (design.w + b * 2), sy = cv.height / (design.h + b * 2);
    ctx.setTransform(sx, 0, 0, sy, b * sx, b * sy);
    ctx.imageSmoothingQuality = 'high';
    GS.R.drawPage(ctx, design, page, { scale, exporting: true, transparent: !!opts.transparent, bleed: b || undefined });
    return cv;
  };
  X.BLEED = 12; // 1/8 in at 96 px to the inch
  // photos that will print soft (print designs) or look stretched (screen designs)
  X.lowResCount = (design) => design.pages.reduce((n, p) => n + p.els.filter((el) => !el.hidden && el.type === 'image' && GS.R.lowRes(el, design)).length, 0);

  // opts: {design, pages:[idx], type:'png'|'jpg'|'pdf', scale, transparent}
  X.exportBlob = async function (opts) {
    const { design, type } = opts;
    const scale = Math.min(opts.scale || 1, X.maxScale(design));
    await GS.ensureFontsFor(design);
    await GS.R.preload(design);
    await new Promise((r) => setTimeout(r, 30));
    const idxs = opts.pages && opts.pages.length ? opts.pages : design.pages.map((_, i) => i);
    const base = X.fileBase(design);
    if (type === 'pdf') return { blob: await makePDF(design, idxs, scale, { marks: !!opts.marks }), filename: base + (opts.marks ? ' - print' : '') + '.pdf' };
    const mime = type === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = type === 'jpg' ? 'jpg' : 'png';
    const files = [];
    for (const i of idxs) {
      const cv = X.renderPage(design, design.pages[i], scale, { transparent: type === 'png' && opts.transparent, flatten: type === 'jpg' });
      const blob = await GS.canvasToBlob(cv, mime, 0.92);
      files.push({ name: idxs.length > 1 ? `${base} - page ${i + 1}.${ext}` : `${base}.${ext}`, blob });
    }
    if (files.length === 1) return { blob: files[0].blob, filename: files[0].name };
    const zipped = await makeZip(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) }))));
    return { blob: zipped, filename: base + '.zip' };
  };

  // PDF pages hold one JPEG each (fonts and effects come out exactly as on screen). With opts.marks the page
  // gets 1/8 in bleed past the trim, crop marks in a 1/4 in margin, and TrimBox/BleedBox for the print shop.
  async function makePDF(design, idxs, scale, opts = {}) {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const offsets = [];
    const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); offset += b.length; };
    const obj = (num, body) => { offsets[num] = offset; push(`${num} 0 obj\n${body}\nendobj\n`); };
    const n = idxs.length;
    const r2 = (v) => GS.round(v, 2);
    const W = r2(design.w * 0.75), H = r2(design.h * 0.75);
    const bl = opts.marks ? X.BLEED : 0;
    const B = r2(bl * 0.75), P = opts.marks ? r2(B + 18) : 0; // bleed and page margin, in points
    const MW = r2(W + P * 2), MH = r2(H + P * 2);
    push('%PDF-1.4\n%âãÏÓ\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${idxs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`);
    let marks = '';
    if (opts.marks) {
      const g = 3, L = [];
      for (const cx of [P, r2(P + W)]) for (const cy of [P, r2(P + H)]) {
        const hx = cx === P ? [0, r2(P - B - g)] : [r2(P + W + B + g), MW];
        const vy = cy === P ? [0, r2(P - B - g)] : [r2(P + H + B + g), MH];
        L.push(`${hx[0]} ${cy} m ${hx[1]} ${cy} l S`, `${cx} ${vy[0]} m ${cx} ${vy[1]} l S`);
      }
      marks = ` 0 G 0.5 w ${L.join(' ')}`;
    }
    for (let i = 0; i < n; i++) {
      const cv = X.renderPage(design, design.pages[idxs[i]], scale, { flatten: true, bleed: bl });
      const bytes = new Uint8Array(await (await GS.canvasToBlob(cv, 'image/jpeg', 0.93)).arrayBuffer());
      const pn = 3 + i * 3, cn = pn + 1, inum = pn + 2;
      const boxes = opts.marks ? ` /TrimBox [${P} ${P} ${r2(P + W)} ${r2(P + H)}] /BleedBox [${r2(P - B)} ${r2(P - B)} ${r2(P + W + B)} ${r2(P + H + B)}]` : '';
      obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${MW} ${MH}]${boxes} /Resources << /XObject << /Im0 ${inum} 0 R >> >> /Contents ${cn} 0 R >>`);
      const content = `q ${r2(W + B * 2)} 0 0 ${r2(H + B * 2)} ${r2(P - B)} ${r2(P - B)} cm /Im0 Do Q${marks}`;
      obj(cn, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      offsets[inum] = offset;
      push(`${inum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      push(bytes);
      push('\nendstream\nendobj\n');
    }
    const size = 3 + n * 3;
    const xref = offset;
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let k = 1; k < size; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(x + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // ---------- ZIP (stored, no compression) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + sz;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  // ---------- Delivery ----------
  X.save = async function (filename, blob) {
    await GS.Store.ready;
    const dl = GS.Store.caps.downloads;
    if (!dl) { const e = new Error('unavailable'); e.code = 'unavailable'; throw e; }
    return dl.save({ filename, data: blob });
  };
  X.copyImage = async function (blob) {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Copying images is not supported here.');
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  };
})();
