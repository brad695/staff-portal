/* GREYS Studio — Google Fonts catalog + on-demand loading */
(function () {
  const GS = window.GS;
  // f: family, c: category, a: css2 axis spec (null = single 400 style), w: weights, i: has italic
  const F = (f, c, a, w, i) => ({ f, c, a, w, i: !!i });
  GS.FONTS = [
    F('League Spartan', 'Brand', 'wght@400;500;600;700;800;900', [400, 500, 600, 700, 800, 900]),
    F('Barlow Condensed', 'Brand', 'ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700', [400, 500, 600, 700, 800, 900], 1),
    F('Nunito Sans', 'Brand', 'ital,wght@0,400;0,600;0,700;0,800;0,900;1,400;1,700', [400, 600, 700, 800, 900], 1),
    F('Montserrat', 'Sans', 'ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700', [400, 500, 600, 700, 800, 900], 1),
    F('Poppins', 'Sans', 'ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,700', [400, 500, 600, 700, 800], 1),
    F('Barlow', 'Sans', 'ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,700', [400, 500, 600, 700, 800], 1),
    F('Raleway', 'Sans', 'ital,wght@0,400;0,600;0,700;0,800;1,400;1,700', [400, 600, 700, 800], 1),
    F('Work Sans', 'Sans', 'ital,wght@0,400;0,600;0,700;1,400;1,700', [400, 600, 700], 1),
    F('Josefin Sans', 'Sans', 'ital,wght@0,400;0,600;0,700;1,400;1,700', [400, 600, 700], 1),
    F('Rubik', 'Sans', 'ital,wght@0,400;0,500;0,700;0,800;1,400;1,700', [400, 500, 700, 800], 1),
    F('Archivo', 'Sans', 'ital,wght@0,400;0,600;0,700;0,800;1,400', [400, 600, 700, 800], 1),
    F('Quicksand', 'Sans', 'wght@400;600;700', [400, 600, 700]),
    F('Syne', 'Sans', 'wght@400;600;700;800', [400, 600, 700, 800]),
    F('Playfair Display', 'Serif', 'ital,wght@0,400;0,600;0,700;0,800;0,900;1,400;1,700', [400, 600, 700, 800, 900], 1),
    F('Fraunces', 'Serif', 'ital,wght@0,400;0,600;0,700;0,900;1,400;1,700', [400, 600, 700, 900], 1),
    F('Cormorant Garamond', 'Serif', 'ital,wght@0,400;0,600;0,700;1,400;1,600', [400, 600, 700], 1),
    F('Lora', 'Serif', 'ital,wght@0,400;0,600;0,700;1,400;1,700', [400, 600, 700], 1),
    F('Libre Baskerville', 'Serif', 'ital,wght@0,400;0,700;1,400', [400, 700], 1),
    F('Merriweather', 'Serif', 'ital,wght@0,400;0,700;0,900;1,400;1,700', [400, 700, 900], 1),
    F('Bodoni Moda', 'Serif', 'ital,wght@0,400;0,700;0,900;1,400;1,700', [400, 700, 900], 1),
    F('DM Serif Display', 'Serif', 'ital@0;1', [400], 1),
    F('Cinzel', 'Serif', 'wght@400;600;700;900', [400, 600, 700, 900]),
    F('Roboto Slab', 'Serif', 'wght@400;600;700;800', [400, 600, 700, 800]),
    F('Zilla Slab', 'Serif', 'ital,wght@0,400;0,600;0,700;1,400', [400, 600, 700], 1),
    F('Bebas Neue', 'Display', null, [400]),
    F('Anton', 'Display', null, [400]),
    F('Oswald', 'Display', 'wght@400;500;600;700', [400, 500, 600, 700]),
    F('Archivo Black', 'Display', null, [400]),
    F('Abril Fatface', 'Display', null, [400]),
    F('Alfa Slab One', 'Display', null, [400]),
    F('Shrikhand', 'Display', null, [400]),
    F('Righteous', 'Display', null, [400]),
    F('Bungee', 'Display', null, [400]),
    F('Lilita One', 'Display', null, [400]),
    F('Yeseva One', 'Display', null, [400]),
    F('Fredoka', 'Display', 'wght@400;500;600;700', [400, 500, 600, 700]),
    F('Pacifico', 'Script', null, [400]),
    F('Lobster', 'Script', null, [400]),
    F('Dancing Script', 'Script', 'wght@400;600;700', [400, 600, 700]),
    F('Great Vibes', 'Script', null, [400]),
    F('Sacramento', 'Script', null, [400]),
    F('Satisfy', 'Script', null, [400]),
    F('Allura', 'Script', null, [400]),
    F('Kaushan Script', 'Script', null, [400]),
    F('Caveat', 'Script', 'wght@400;600;700', [400, 600, 700]),
    F('Permanent Marker', 'Script', null, [400]),
    F('Amatic SC', 'Script', 'wght@400;700', [400, 700]),
    F('Space Mono', 'Mono', 'ital,wght@0,400;0,700;1,400;1,700', [400, 700], 1),
    F('Courier Prime', 'Mono', 'ital,wght@0,400;0,700;1,400;1,700', [400, 700], 1),
  ];
  const BY = {};
  GS.FONTS.forEach((x) => (BY[x.f] = x));
  GS.fontInfo = (f) => BY[f] || { f, c: 'Sans', a: null, w: [400, 700], i: true };

  const FALLBACK = { Serif: 'Georgia, "Times New Roman", serif', Script: '"Brush Script MT", cursive', Mono: '"Courier New", monospace' };
  GS.fontStack = (f) => `"${f}", ${FALLBACK[GS.fontInfo(f).c] || 'Arial, Helvetica, sans-serif'}`;
  GS.fontStr = (el, size) => `${el.ital ? 'italic ' : ''}${el.weight || 400} ${size != null ? size : el.size}px ${GS.fontStack(el.font)}`;

  // nearest available weight
  GS.nearestWeight = function (f, want) {
    const ws = GS.fontInfo(f).w;
    let best = ws[0];
    for (const w of ws) if (Math.abs(w - want) < Math.abs(best - want)) best = w;
    return best;
  };
  GS.boldWeight = (f) => {
    const ws = GS.fontInfo(f).w;
    return ws.find((w) => w >= 700) || ws.find((w) => w >= 600) || 700;
  };

  const cssState = {}; // family -> 'preview' | 'loading' | 'full' | 'failed'
  const cssWait = {};
  const faceReady = new Set();
  const faceLoading = new Set();
  const href = (fam, spec, text) => {
    let u = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(fam).replace(/%20/g, '+') + (spec ? ':' + spec : '');
    if (text) u += '&text=' + encodeURIComponent(text);
    return u + '&display=swap';
  };
  const brand = ['League Spartan', 'Barlow Condensed', 'Nunito Sans'];
  brand.forEach((f) => (cssState[f] = 'full')); // loaded by index.html <link>

  GS.loadFamily = function (f) {
    if (cssState[f] === 'full' || cssState[f] === 'failed') return Promise.resolve();
    if (cssWait[f]) return cssWait[f];
    const info = GS.fontInfo(f);
    cssState[f] = 'loading';
    cssWait[f] = new Promise((res) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href(f, info.a);
      const done = (ok) => { cssState[f] = ok ? 'full' : 'failed'; res(); };
      link.onload = () => done(true);
      link.onerror = () => done(false);
      setTimeout(() => res(), 6000);
      document.head.append(link);
    });
    return cssWait[f];
  };

  // Light preview of a family name (only glyphs of its own name)
  GS.previewFamily = function (f) {
    if (cssState[f]) return;
    cssState[f] = 'preview';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href(f, null, f);
    document.head.append(link);
  };

  const faceKey = (el) => `${el.font}|${el.weight || 400}|${el.ital ? 1 : 0}`;
  // Is the exact face loaded? If not, start loading and return false.
  GS.faceReady = function (el) {
    const k = faceKey(el);
    if (faceReady.has(k)) return true;
    if (!faceLoading.has(k)) {
      faceLoading.add(k);
      GS.ensureFace(el).then(() => GS.bus.emit('fontsloaded'));
    }
    return false;
  };
  GS.ensureFace = async function (el) {
    const k = faceKey(el);
    if (faceReady.has(k)) return;
    await GS.loadFamily(el.font);
    try {
      await Promise.race([document.fonts.load(GS.fontStr(el, 40), 'AaBbGgQq'), new Promise((r) => setTimeout(r, 5000))]);
    } catch (e) { /* fall back silently */ }
    faceReady.add(k);
  };
  GS.ensureFontsFor = async function (design) {
    const jobs = [];
    const seen = new Set();
    for (const p of design.pages) for (const el of p.els) {
      if (el.type !== 'text') continue;
      const k = faceKey(el);
      if (seen.has(k)) continue;
      seen.add(k);
      jobs.push(GS.ensureFace(el));
    }
    await Promise.all(jobs);
  };
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => GS.bus.emit('fontsloaded'));
  }
})();
