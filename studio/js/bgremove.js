/* GREYS Studio — background remover. Canva's most-loved Pro feature; ours is free and runs on this device:
   U²-Net small (u2netp, Apache-2.0, studio/models/u2netp.onnx, 4.6 MB) through onnxruntime-web, loaded
   from jsDelivr the first time someone uses it (the browser caches both after that). */
(function () {
  const GS = window.GS, E = GS.E, R = GS.R, h = GS.h;
  const ORT = '1.31.1';
  const CDNS = [`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/`, `https://unpkg.com/onnxruntime-web@${ORT}/dist/`];
  const MODEL = 'models/u2netp.onnx';
  const SIZE = 320;
  // edge = how hard the mask is cut: contrast window applied to the model's 0..1 mask
  const EDGES = { soft: [0, 1], normal: [0.12, 0.88], crisp: [0.3, 0.7] };
  let sessionP = null;

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => { s.remove(); rej(new Error('Could not load ' + src)); };
    document.head.append(s);
  });
  function session(step) {
    if (!sessionP) sessionP = (async () => {
      let base = CDNS[0];
      if (!window.ort) {
        step('Loading the background remover (first time only)…');
        let err;
        for (const b of CDNS) { try { await loadScript(b + 'ort.wasm.min.js'); base = b; err = null; break; } catch (e) { err = e; } }
        if (err) throw err;
      }
      const ort = window.ort;
      ort.env.wasm.wasmPaths = base;
      ort.env.wasm.numThreads = 1;
      step('Loading the cutout model…');
      const res = await fetch(MODEL);
      if (!res.ok) throw new Error('model ' + res.status);
      return ort.InferenceSession.create(await res.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })().catch((e) => { sessionP = null; throw e; });
    return sessionP;
  }

  // 0..1 foreground mask, SIZE×SIZE (same pre/post processing as rembg's u2net session)
  async function maskFor(img, step) {
    const ses = await session(step);
    step('Finding the subject…');
    const cv = document.createElement('canvas');
    cv.width = cv.height = SIZE;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, SIZE, SIZE);
    const px = c.getImageData(0, 0, SIZE, SIZE).data;
    const N = SIZE * SIZE, input = new Float32Array(3 * N);
    let mx = 1;
    for (let i = 0; i < N; i++) mx = Math.max(mx, px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) input[k * N + i] = (px[i * 4 + k] / mx - mean[k]) / std[k];
    await new Promise((r) => setTimeout(r, 30)); // let the status paint before the busy bit
    const out = await ses.run({ [ses.inputNames[0]]: new window.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const pred = out[ses.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { const v = pred[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const m = new Float32Array(N), d = hi - lo || 1;
    for (let i = 0; i < N; i++) m[i] = (pred[i] - lo) / d;
    return m;
  }

  // full-size cutout canvas: the photo with the (scaled-up) mask as its alpha
  function cutout(img, mask, edge, maxSide) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const k = maxSide ? Math.min(1, maxSide / Math.max(iw, ih)) : 1;
    const W = Math.max(1, Math.round(iw * k)), H = Math.max(1, Math.round(ih * k));
    const mc = document.createElement('canvas');
    mc.width = mc.height = SIZE;
    const mctx = mc.getContext('2d');
    const md = mctx.createImageData(SIZE, SIZE);
    const [a0, a1] = EDGES[edge] || EDGES.normal;
    for (let i = 0; i < SIZE * SIZE; i++) { md.data[i * 4 + 3] = Math.round(GS.clamp((mask[i] - a0) / (a1 - a0), 0, 1) * 255); }
    mctx.putImageData(md, 0, 0);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const o = out.getContext('2d');
    o.drawImage(img, 0, 0, W, H);
    o.globalCompositeOperation = 'destination-in';
    o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
    o.drawImage(mc, 0, 0, W, H);
    return out;
  }

  GS.BG = {
    maskFor, cutout,
    async open(id) {
      const el = E.byId(id);
      if (!el || el.type !== 'image' || !el.src) return;
      E.endCrop();
      const ent = await R.loadImg(el.src).catch(() => null);
      if (!ent || !ent.img) { GS.toast('That photo hasn’t loaded yet. Try again in a moment.', 'err'); return; }
      const img = ent.img;
      let edge = 'normal', mask = null, busy = true, orig = false;
      const view = h('canvas', { class: 'bg-view', 'aria-label': 'Preview' });
      const status = h('p', { class: 'muted bg-status', role: 'status' }, 'Getting ready…');
      const seg = h('div', { class: 'seg', style: { maxWidth: '320px' } });
      const cmp = h('button', { class: 'btn sm', disabled: true }, 'Hold to compare');
      const paint = () => {
        const maxW = Math.min(560, window.innerWidth - 80), maxH = Math.min(380, window.innerHeight * 0.45);
        const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        const src = mask && !orig ? cutout(img, mask, edge, 1200) : img;
        view.width = Math.round(img.naturalWidth * s); view.height = Math.round(img.naturalHeight * s);
        const c = view.getContext('2d');
        c.clearRect(0, 0, view.width, view.height);
        c.drawImage(src, 0, 0, view.width, view.height);
      };
      const drawSeg = () => {
        seg.innerHTML = '';
        [['soft', 'Soft edge'], ['normal', 'Normal'], ['crisp', 'Crisp edge']].forEach(([k, l]) => seg.append(h('button', { class: edge === k ? 'on' : '', disabled: !mask, onclick: () => { edge = k; drawSeg(); paint(); } }, l)));
      };
      ['pointerdown', 'pointerup', 'pointerleave'].forEach((ev) => cmp.addEventListener(ev, () => { orig = ev === 'pointerdown'; paint(); }));
      drawSeg(); paint();
      const body = h('div', { class: 'bg-body' }, h('div', { class: 'bg-stage' }, view), status, h('div', { class: 'bg-ctl' }, seg, cmp),
        h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'Works best when the subject stands out: a cheese, a board, a person. The original photo stays in your uploads.'));
      const m = GS.modal({ title: 'Remove background', wide: true, body, actions: [{ label: 'Cancel' }, { label: 'Use cutout', kind: 'gold', onClick: async () => {
        if (!mask || busy) return false;
        busy = true;
        status.textContent = 'Saving the cutout…';
        try {
          const blob = await GS.canvasToBlob(cutout(img, mask, edge), 'image/png');
          const name = ((GS.Store.uploads || []).find((u) => u.ref === el.src) || {}).name || 'Photo';
          const rec = await GS.Store.putImage(new File([blob], name.replace(/\.\w+$/, '').slice(0, 60) + ' (cutout).png', { type: 'image/png' }));
          E.update((x) => { if (x.type === 'image') x.src = rec.ref; }, { ids: [id] });
          GS.toast('Background removed', 'ok');
        } catch (e) { busy = false; status.textContent = 'Couldn’t save the cutout: ' + ((e && e.message) || e); return false; }
      } }] });
      try {
        mask = await maskFor(img, (t) => (status.textContent = t));
        busy = false;
        status.textContent = 'Done. Check the edges, then use the cutout.';
        cmp.disabled = false;
        drawSeg(); paint();
      } catch (e) {
        console.warn('bg remove', e);
        status.textContent = 'The background remover couldn’t start here (' + ((e && e.message) || 'error') + '). Check the connection and try again.';
      }
      void m;
    },
  };
})();
