/* GREYS Studio — shape, frame and graphic geometry (Path2D builders) */
(function () {
  const GS = window.GS;

  // Mini path language in a 0..100 box, scaled to w x h (M L C Q Z, absolute)
  function norm(d, w, h, p = new Path2D()) {
    const t = d.match(/[MLCQZ]|-?\d*\.?\d+/g);
    let i = 0, cmd = 'M';
    const X = () => (parseFloat(t[i++]) * w) / 100, Y = () => (parseFloat(t[i++]) * h) / 100;
    while (i < t.length) {
      if (/[MLCQZ]/.test(t[i])) cmd = t[i++];
      if (cmd === 'M') { p.moveTo(X(), Y()); cmd = 'L'; }
      else if (cmd === 'L') p.lineTo(X(), Y());
      else if (cmd === 'C') p.bezierCurveTo(X(), Y(), X(), Y(), X(), Y());
      else if (cmd === 'Q') p.quadraticCurveTo(X(), Y(), X(), Y());
      else if (cmd === 'Z') { p.closePath(); }
    }
    return p;
  }
  function rr(p, x, y, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    if (!r) { p.rect(x, y, w, h); return p; }
    p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.arcTo(x + w, y, x + w, y + r, r);
    p.lineTo(x + w, y + h - r); p.arcTo(x + w, y + h, x + w - r, y + h, r);
    p.lineTo(x + r, y + h); p.arcTo(x, y + h, x, y + h - r, r);
    p.lineTo(x, y + r); p.arcTo(x, y, x + r, y, r); p.closePath();
    return p;
  }
  GS.rrPath = (x, y, w, h, r) => rr(new Path2D(), x, y, w, h, r);
  function poly(p, pts) { pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; }
  function ngon(p, n, w, h, rot = -90) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (rot + (360 / n) * i) * GS.RAD; pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]); }
    return poly(p, pts);
  }
  function star(p, n, k, w, h) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (-90 + (180 / n) * i) * GS.RAD, r = i % 2 ? k : 1;
      pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
    }
    return poly(p, pts);
  }
  function ell(p, cx, cy, rx, ry, rot = 0) {
    p.moveTo(cx + rx * Math.cos(rot), cy + rx * Math.sin(rot));
    p.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2);
    return p;
  }
  function sparkle(p, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    p.moveTo(cx, y); p.quadraticCurveTo(cx, cy, x + w, cy); p.quadraticCurveTo(cx, cy, cx, y + h);
    p.quadraticCurveTo(cx, cy, x, cy); p.quadraticCurveTo(cx, cy, cx, y); p.closePath();
    return p;
  }

  // ---------- Shapes (also used as image frames) ----------
  GS.SHAPES = {
    rect: { label: 'Square', b: (p, w, h, el) => rr(p, 0, 0, w, h, el && el.r) },
    ellipse: { label: 'Circle', b: (p, w, h) => ell(p, w / 2, h / 2, w / 2, h / 2) },
    triangle: { label: 'Triangle', b: (p, w, h) => poly(p, [[w / 2, 0], [w, h], [0, h]]) },
    rtriangle: { label: 'Right triangle', b: (p, w, h) => poly(p, [[0, 0], [w, h], [0, h]]) },
    diamond: { label: 'Diamond', b: (p, w, h) => poly(p, [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) },
    pentagon: { label: 'Pentagon', b: (p, w, h) => ngon(p, 5, w, h) },
    hexagon: { label: 'Hexagon', b: (p, w, h) => ngon(p, 6, w, h, 0) },
    octagon: { label: 'Octagon', b: (p, w, h) => ngon(p, 8, w, h, -67.5) },
    star: { label: 'Star', b: (p, w, h) => star(p, 5, 0.45, w, h) },
    burst: { label: 'Burst', b: (p, w, h) => star(p, 16, 0.8, w, h) },
    seal: {
      label: 'Seal', b: (p, w, h) => {
        const n = 18, cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2, am = ((i - 0.5) / n) * Math.PI * 2 - Math.PI / 2;
          const x = cx + rx * 0.9 * Math.cos(a), y = cy + ry * 0.9 * Math.sin(a);
          if (!i) p.moveTo(x, y);
          else p.quadraticCurveTo(cx + rx * 1.1 * Math.cos(am), cy + ry * 1.1 * Math.sin(am), x, y);
        }
        p.closePath();
      },
    },
    sparkle: { label: 'Sparkle', b: (p, w, h) => sparkle(p, 0, 0, w, h) },
    heart: { label: 'Heart', b: (p, w, h) => norm('M50 92 C22 72 0 54 0 30 C0 13 13 2 28 2 C38 2 46 8 50 17 C54 8 62 2 72 2 C87 2 100 13 100 30 C100 54 78 72 50 92 Z', w, h, p) },
    arrow: { label: 'Arrow', b: (p, w, h) => poly(p, [[0, h * 0.3], [w * 0.62, h * 0.3], [w * 0.62, 0], [w, h / 2], [w * 0.62, h], [w * 0.62, h * 0.7], [0, h * 0.7]]) },
    chevron: { label: 'Chevron', b: (p, w, h) => poly(p, [[0, 0], [w * 0.7, 0], [w, h / 2], [w * 0.7, h], [0, h], [w * 0.3, h / 2]]) },
    bubble: {
      label: 'Speech bubble', b: (p, w, h) => {
        const bh = h * 0.8, r = Math.min(w, bh) * 0.18;
        p.moveTo(r, 0); p.lineTo(w - r, 0); p.arcTo(w, 0, w, r, r); p.lineTo(w, bh - r); p.arcTo(w, bh, w - r, bh, r);
        p.lineTo(w * 0.38, bh); p.lineTo(w * 0.18, h); p.lineTo(w * 0.22, bh); p.lineTo(r, bh); p.arcTo(0, bh, 0, bh - r, r);
        p.lineTo(0, r); p.arcTo(0, 0, r, 0, r); p.closePath();
      },
    },
    arch: {
      label: 'Arch', b: (p, w, h) => {
        const r = Math.min(w / 2, h);
        p.moveTo(0, h); p.lineTo(0, r); p.ellipse(w / 2, r, w / 2, r, 0, Math.PI, Math.PI * 2); p.lineTo(w, h); p.closePath();
      },
    },
    semicircle: { label: 'Half circle', b: (p, w, h) => { p.moveTo(0, h); p.ellipse(w / 2, h, w / 2, h, 0, Math.PI, Math.PI * 2); p.closePath(); } },
    ring: { label: 'Ring', rule: 'evenodd', b: (p, w, h) => { ell(p, w / 2, h / 2, w / 2, h / 2); ell(p, w / 2, h / 2, w * 0.33, h * 0.33); } },
    plus: { label: 'Cross', b: (p, w, h) => { const t = 0.32; poly(p, [[w * (0.5 - t / 2), 0], [w * (0.5 + t / 2), 0], [w * (0.5 + t / 2), h * (0.5 - t / 2)], [w, h * (0.5 - t / 2)], [w, h * (0.5 + t / 2)], [w * (0.5 + t / 2), h * (0.5 + t / 2)], [w * (0.5 + t / 2), h], [w * (0.5 - t / 2), h], [w * (0.5 - t / 2), h * (0.5 + t / 2)], [0, h * (0.5 + t / 2)], [0, h * (0.5 - t / 2)], [w * (0.5 - t / 2), h * (0.5 - t / 2)]]); } },
    parallelogram: { label: 'Parallelogram', b: (p, w, h) => poly(p, [[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]]) },
    trapezoid: { label: 'Trapezoid', b: (p, w, h) => poly(p, [[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]) },
    cloud: { label: 'Cloud', b: (p, w, h) => norm('M24 96 C8 96 0 84 0 70 C0 56 10 46 24 47 C25 24 41 8 60 8 C79 8 94 23 95 42 C99 47 100 54 100 62 L100 76 C100 88 91 96 79 96 Z', w, h, p) },
    blob: { label: 'Blob', b: (p, w, h) => norm('M54 3 C78 5 97 24 95 48 C93 73 74 97 47 96 C21 95 3 76 5 50 C7 30 18 21 26 14 C34 7 43 2 54 3 Z', w, h, p) },
    banner: { label: 'Ribbon', b: (p, w, h) => { const n = Math.min(w * 0.12, h * 0.5); poly(p, [[0, 0], [w, 0], [w - n, h / 2], [w, h], [0, h], [n, h / 2]]); } },
    tag: {
      label: 'Price tag', rule: 'evenodd', b: (p, w, h) => {
        const r = Math.min(w, h) * 0.12, tip = Math.min(w * 0.3, h * 0.5);
        p.moveTo(r, 0); p.lineTo(w - tip, 0); p.lineTo(w, h / 2); p.lineTo(w - tip, h); p.lineTo(r, h); p.arcTo(0, h, 0, h - r, r); p.lineTo(0, r); p.arcTo(0, 0, r, 0, r); p.closePath();
        const hr = Math.min(w, h) * 0.08; ell(p, w - tip * 0.85, h / 2, hr, hr);
      },
    },
    ticket: {
      label: 'Ticket', b: (p, w, h) => {
        const n = Math.min(w, h) * 0.14, r = Math.min(w, h) * 0.06;
        p.moveTo(r, 0); p.lineTo(w - r, 0); p.arcTo(w, 0, w, r, r); p.lineTo(w, h / 2 - n);
        p.arc(w, h / 2, n, -Math.PI / 2, Math.PI / 2, true); p.lineTo(w, h - r); p.arcTo(w, h, w - r, h, r);
        p.lineTo(r, h); p.arcTo(0, h, 0, h - r, r); p.lineTo(0, h / 2 + n);
        p.arc(0, h / 2, n, Math.PI / 2, -Math.PI / 2, true); p.lineTo(0, r); p.arcTo(0, 0, r, 0, r); p.closePath();
      },
    },
  };
  // Order for the Elements panel
  GS.SHAPE_LIST = ['rect', 'rrect', 'ellipse', 'triangle', 'rtriangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'burst', 'seal', 'sparkle', 'heart', 'arrow', 'chevron', 'bubble', 'arch', 'semicircle', 'ring', 'plus', 'parallelogram', 'trapezoid', 'cloud', 'blob', 'banner', 'tag', 'ticket'];
  GS.FRAME_LIST = ['rect', 'rrect', 'ellipse', 'arch', 'hexagon', 'diamond', 'heart', 'star', 'blob', 'seal', 'ticket', 'triangle'];

  const pathCache = new Map();
  GS.shapePath = function (kind, w, h, el) {
    const r = el && el.r ? Math.round(el.r * 10) / 10 : 0;
    const key = kind + '|' + Math.round(w * 10) + '|' + Math.round(h * 10) + '|' + r;
    let p = pathCache.get(key);
    if (p) return p;
    p = new Path2D();
    const def = GS.SHAPES[kind] || GS.SHAPES.rect;
    def.b(p, w, h, el || {});
    if (pathCache.size > 400) pathCache.clear();
    pathCache.set(key, p);
    return p;
  };
  GS.shapeRule = (kind) => (GS.SHAPES[kind] && GS.SHAPES[kind].rule) || 'nonzero';

  // ---------- Graphics (100 x 100 box, fill only) ----------
  const c = (cx, cy, r) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z `;
  const sq = (x, y, s) => `M${x} ${y} h${s} v${s} h${-s} Z `;
  function bez(t, a, b, c2) { const u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c2; }
  function rotRect(p, cx, cy, len, th, ang, from = 0) {
    const ca = Math.cos(ang), sa = Math.sin(ang), nx = -sa * th / 2, ny = ca * th / 2;
    const x0 = cx + ca * from, y0 = cy + sa * from, x1 = cx + ca * (from + len), y1 = cy + sa * (from + len);
    poly(p, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]);
  }
  GS.ICONS = {
    cheese: { label: 'Cheese wedge', rule: 'evenodd', d: 'M8 84 L92 84 L92 18 Z ' + c(62, 66, 7) + c(78, 48, 5) + c(80, 72, 4.5) + c(46, 76, 4) },
    wheel: { label: 'Cheese wheel', rule: 'evenodd', d: 'M50 50 L50 6 A44 44 0 1 0 88.1 28 Z ' + c(34, 40, 5) + c(58, 68, 6) + c(34, 68, 4) + c(70, 50, 4) + 'M56 44 L56 0 A44 44 0 0 1 94.1 22 Z ' + c(70, 22, 3.5) },
    board: { label: 'Cheese board', rule: 'evenodd', d: 'M8 30 Q8 22 16 22 L70 22 Q78 22 78 30 L78 44 L90 44 Q96 44 96 50 Q96 56 90 56 L78 56 L78 70 Q78 78 70 78 L16 78 Q8 78 8 70 Z ' + c(89, 50, 3) },
    wine: { label: 'Wine glass', d: 'M30 6 L70 6 C72 28 68 46 50 52 C32 46 28 28 30 6 Z M47.5 50 L52.5 50 L52.5 85 L47.5 85 Z M30 84 C38 80 62 80 70 84 L70 90 L30 90 Z' },
    bottle: { label: 'Wine bottle', rule: 'evenodd', d: 'M43 4 L57 4 L57 24 C57 31 70 35 70 48 L70 92 C70 95 68 97 65 97 L35 97 C32 97 30 95 30 92 L30 48 C30 35 43 31 43 24 Z M35 56 L65 56 L65 78 L35 78 Z' },
    grapes: { label: 'Grapes', d: c(32, 42, 9.5) + c(50, 42, 9.5) + c(68, 42, 9.5) + c(41, 58, 9.5) + c(59, 58, 9.5) + c(50, 74, 9.5) + 'M49 34 C49 26 52 20 58 16 L60 18 C55 22 52 27 52 34 Z M56 26 C60 16 74 12 84 16 C82 26 70 32 56 26 Z' },
    pear: { label: 'Pear', d: 'M50 16 C44 16 42 24 42 32 C42 42 24 48 24 68 C24 85 37 95 50 95 C63 95 76 85 76 68 C76 48 58 42 58 32 C58 24 56 16 50 16 Z M49 5 L52 5 L52 17 L49 17 Z M53 10 C58 3 68 2 74 6 C70 13 61 15 53 10 Z' },
    apple: { label: 'Apple', d: 'M50 30 C40 22 16 24 14 48 C12 72 30 94 43 94 C47 94 50 92 50 92 C50 92 53 94 57 94 C70 94 88 72 86 48 C84 24 60 22 50 30 Z M52 26 C51 14 59 7 70 6 C70 17 63 25 52 26 Z M48 30 C48 22 46 16 42 12 L45 10 C49 15 51 21 51 30 Z' },
    leaf: { label: 'Leaf', rule: 'evenodd', d: 'M10 90 C10 40 40 10 90 10 C90 60 60 90 10 90 Z M20 82 L82 20 L84 22 L22 84 Z' },
    sprig: {
      label: 'Olive sprig', b: (p) => {
        const P0 = [15, 89], P1 = [51, 64], P2 = [89, 13];
        p.moveTo(14, 88); p.quadraticCurveTo(50, 62, 88, 12); p.lineTo(90, 14); p.quadraticCurveTo(52, 66, 16, 90); p.closePath();
        [0.18, 0.32, 0.46, 0.6, 0.74, 0.88].forEach((t, i) => {
          const x = bez(t, P0[0], P1[0], P2[0]), y = bez(t, P0[1], P1[1], P2[1]);
          const dx = 2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]), dy = 2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]);
          const a = Math.atan2(dy, dx), side = i % 2 ? 1 : -1, ra = a + side * 0.7;
          ell(p, x + Math.cos(ra) * 10, y + Math.sin(ra) * 10, 11, 4.6, ra);
        });
        ell(p, 91, 11, 6, 3.6, -0.9);
      },
    },
    utensils: { label: 'Fork & knife', d: 'M20 8 L24 8 L24 32 L28 32 L28 8 L32 8 L32 32 L36 32 L36 8 L40 8 L40 38 C40 44 35 47 33 48 L33 90 C33 94 27 94 27 90 L27 48 C25 47 20 44 20 38 Z M62 8 C78 14 82 36 76 54 L70 54 L70 90 C70 94 62 94 62 90 Z' },
    coffee: { label: 'Coffee', d: 'M16 36 L72 36 L68 84 C67 90 62 94 56 94 L32 94 C26 94 21 90 20 84 Z M70 46 C86 44 92 54 88 63 C85 70 77 73 68 71 L69 64 C75 65 80 63 81 59 C83 54 79 51 71 53 Z M34 8 C28 16 40 20 34 28 L38 29 C44 21 32 17 38 9 Z M50 8 C44 16 56 20 50 28 L54 29 C60 21 48 17 54 9 Z' },
    milk: { label: 'Milk bottle', rule: 'evenodd', d: 'M38 6 L62 6 L62 16 L60 20 C68 26 72 34 72 44 L72 90 C72 94 69 96 65 96 L35 96 C31 96 28 94 28 90 L28 44 C28 34 32 26 40 20 L38 16 Z M34 54 L66 54 L66 74 L34 74 Z' },
    pin: { label: 'Location', rule: 'evenodd', d: 'M50 96 C38 78 16 60 16 38 A34 34 0 0 1 84 38 C84 60 62 78 50 96 Z ' + c(50, 37, 13) },
    phone: { label: 'Phone', rule: 'evenodd', d: 'M28 4 L72 4 Q80 4 80 12 L80 88 Q80 96 72 96 L28 96 Q20 96 20 88 L20 12 Q20 4 28 4 Z M27 14 L73 14 L73 78 L27 78 Z ' + c(50, 87, 4) },
    mail: { label: 'Mail', rule: 'evenodd', d: 'M8 20 L92 20 L92 80 L8 80 Z M14 26 L50 54 L86 26 L86 32 L50 60 L14 32 Z' },
    clock: { label: 'Clock', rule: 'evenodd', d: c(50, 50, 42) + c(50, 50, 34) + 'M47 22 L53 22 L53 53 L47 53 Z M53 48 L71 58 L68 63 L53 54.5 Z' },
    calendar: { label: 'Calendar', rule: 'evenodd', d: 'M12 18 L88 18 L88 90 L12 90 Z M19 36 L81 36 L81 83 L19 83 Z M28 8 L35 8 L35 18 L28 18 Z M65 8 L72 8 L72 18 L65 18 Z ' + sq(26, 44, 12) + sq(44, 44, 12) + sq(62, 44, 12) + sq(26, 62, 12) + sq(44, 62, 12) },
    gift: { label: 'Gift', rule: 'evenodd', d: 'M10 30 L90 30 L90 46 L10 46 Z M16 46 L84 46 L84 92 L16 92 Z M45 30 L55 30 L55 92 L45 92 Z M50 30 C42 12 22 14 28 26 C31 30 42 30 50 30 Z M50 30 C58 12 78 14 72 26 C69 30 58 30 50 30 Z' },
    crown: { label: 'Crown', d: 'M10 78 L14 28 L34 50 L50 18 L66 50 L86 28 L90 78 Z M10 84 L90 84 L90 92 L10 92 Z ' + c(14, 24, 5) + c(50, 14, 5) + c(86, 24, 5) },
    tree: { label: 'Holiday tree', d: 'M50 6 L72 36 L62 36 L80 60 L67 60 L86 84 L14 84 L33 60 L20 60 L38 36 L28 36 Z M44 84 L56 84 L56 96 L44 96 Z' },
    snowflake: {
      label: 'Snowflake', b: (p) => {
        for (let k = 0; k < 6; k++) {
          const a = (k * 60 - 90) * GS.RAD;
          rotRect(p, 50, 50, 44, 6, a);
          const bx = 50 + Math.cos(a) * 26, by = 50 + Math.sin(a) * 26;
          rotRect(p, bx, by, 14, 5, a + 0.8);
          rotRect(p, bx, by, 14, 5, a - 0.8);
        }
        ell(p, 50, 50, 7, 7);
      },
    },
    sun: {
      label: 'Sun', b: (p) => {
        ell(p, 50, 50, 21, 21);
        for (let k = 0; k < 12; k++) {
          const a = k * 30 * GS.RAD, ca = Math.cos(a), sa = Math.sin(a);
          poly(p, [[50 + ca * 46, 50 + sa * 46], [50 + ca * 29 - sa * 5.5, 50 + sa * 29 + ca * 5.5], [50 + ca * 29 + sa * 5.5, 50 + sa * 29 - ca * 5.5]]);
        }
      },
    },
    sparkles: { label: 'Sparkles', b: (p) => { sparkle(p, 6, 14, 58, 72); sparkle(p, 62, 6, 32, 38); sparkle(p, 66, 60, 26, 32); } },
    balloon: { label: 'Balloon', rule: 'evenodd', d: 'M50 6 C30 6 18 22 18 38 C18 56 34 68 45 72 L43 78 L57 78 L55 72 C66 68 82 56 82 38 C82 22 70 6 50 6 Z M34 26 C38 18 46 15 52 15 C44 19 39 24 36 32 Z M49 78 L51 78 C53 84 47 90 50 96 L48 96 C45 90 51 84 49 78 Z' },
    shop: { label: 'Shop', rule: 'evenodd', d: 'M8 32 L18 10 L82 10 L92 32 Z M14 36 L86 36 L86 92 L14 92 Z M42 62 L58 62 L58 92 L42 92 Z M22 46 L36 46 L36 60 L22 60 Z M64 46 L78 46 L78 60 L64 60 Z' },
    truck: { label: 'Delivery', d: 'M4 26 L60 26 L60 72 L4 72 Z M62 40 L80 40 L94 56 L94 72 L62 72 Z ' + c(22, 78, 9) + c(78, 78, 9) },
    megaphone: { label: 'Announce', d: 'M12 40 L12 62 L30 62 L68 86 L68 16 L30 40 Z M74 36 C82 40 86 46 86 51 C86 56 82 62 74 66 Z M32 64 L44 64 L48 86 L38 86 Z' },
    percent: { label: 'Percent', rule: 'evenodd', d: c(27, 27, 13) + c(27, 27, 6) + c(73, 73, 13) + c(73, 73, 6) + 'M70 12 L80 20 L30 88 L20 80 Z' },
    quote: { label: 'Quote', d: 'M12 52 C12 32 24 20 42 18 L42 28 C32 30 28 36 27 44 L42 44 L42 76 L12 76 Z M58 52 C58 32 70 20 88 18 L88 28 C78 30 74 36 73 44 L88 44 L88 76 L58 76 Z' },
    checkc: { label: 'Check', rule: 'evenodd', d: c(50, 50, 44) + 'M27 52 L35 44 L45 54 L66 33 L74 41 L45 70 Z' },
    heart: { label: 'Heart', b: (p) => GS.SHAPES.heart.b(p, 100, 100) },
    star: { label: 'Star', b: (p) => star(p, 5, 0.45, 100, 100) },
  };
  const iconCache = new Map();
  GS.iconPath = function (key) {
    let p = iconCache.get(key);
    if (p) return p;
    const def = GS.ICONS[key] || GS.ICONS.star;
    if (def.d) p = new Path2D(def.d);
    else { p = new Path2D(); def.b(p); }
    iconCache.set(key, p);
    return p;
  };
})();
