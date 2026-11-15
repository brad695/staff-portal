/* GREYS Studio — sizes, element factories, brand kit defaults and GREYS templates */
(function () {
  const GS = window.GS;
  const NAVY = '#06273A', NAVY2 = '#0E3448', GOLD = '#E6B33C', LGOLD = '#F6D47F', RIND = '#B87428', CREAM = '#FFF6E3', IVORY = '#F8F3E8', ANT = '#896D39';
  const LS = 'League Spartan', BC = 'Barlow Condensed', NS = 'Nunito Sans', PF = 'Playfair Display';
  GS.BRAND = {
    colors: [NAVY, NAVY2, GOLD, LGOLD, RIND, ANT, CREAM, IVORY, '#FFFFFF', '#1B2530', '#EF7D62', '#5B6B78'],
    names: { [NAVY]: 'GREYS navy', [NAVY2]: 'Deep navy', [GOLD]: 'GREYS gold', [LGOLD]: 'Light gold', [RIND]: 'Rind', [ANT]: 'Antique gold', [CREAM]: 'Cream', [IVORY]: 'Ivory', '#EF7D62': 'Coral' },
  };

  GS.SIZES = [
    { k: 'ig-post', label: 'Instagram post', w: 1080, h: 1080, g: 'Social' },
    { k: 'ig-portrait', label: 'Instagram portrait', w: 1080, h: 1350, g: 'Social' },
    { k: 'ig-story', label: 'Story / Reel', w: 1080, h: 1920, g: 'Social' },
    { k: 'fb-post', label: 'Facebook post', w: 1200, h: 630, g: 'Social' },
    { k: 'fb-event', label: 'Facebook event cover', w: 1920, h: 1005, g: 'Social' },
    { k: 'email-header', label: 'Email header', w: 600, h: 200, g: 'Email' },
    { k: 'email-image', label: 'Email image', w: 600, h: 400, g: 'Email' },
    { k: 'flyer', label: 'Flyer', w: 816, h: 1056, unit: 'in', g: 'Print' },
    { k: 'poster', label: 'Poster', w: 1056, h: 1632, unit: 'in', g: 'Print' },
    { k: 'menu', label: 'Menu', w: 408, h: 1056, unit: 'in', g: 'Print' },
    { k: 'card', label: 'Card', w: 480, h: 672, unit: 'in', g: 'Print' },
    { k: 'table-tent', label: 'Table tent', w: 384, h: 576, unit: 'in', g: 'Print' },
    { k: 'cheese-card', label: 'Cheese card', w: 384, h: 288, unit: 'in', g: 'Shop' },
    { k: 'price-tag', label: 'Price tag', w: 288, h: 192, unit: 'in', g: 'Shop' },
    { k: 'gift-card', label: 'Gift card', w: 336, h: 192, unit: 'in', g: 'Shop' },
    { k: 'sign', label: 'Shop sign', w: 1056, h: 816, unit: 'in', g: 'Shop' },
  ];
  GS.sizeText = (w, h, unit) => unit === 'in' ? `${GS.round(w / 96, 2)} × ${GS.round(h / 96, 2)} in` : `${Math.round(w)} × ${Math.round(h)} px`;
  GS.sizeLabel = (d) => GS.sizeText(d.w, d.h, d.unit);
  GS.sizeByKey = (k) => GS.SIZES.find((s) => s.k === k);

  // ---------- Element factories ----------
  const base = (o) => Object.assign({ id: GS.uid('e'), x: 0, y: 0, w: 100, h: 100, rot: 0, op: 1 }, o);
  GS.mk = {
    text: (o) => base(Object.assign({ type: 'text', text: 'Text', font: NS, size: 40, weight: 400, ital: false, color: NAVY, align: 'left', lh: 1.2, ls: 0, upper: false, under: false, h: 10 }, o)),
    shape: (o) => base(Object.assign({ type: 'shape', shape: 'rect', fill: GOLD, r: 0 }, o)),
    image: (o) => base(Object.assign({ type: 'image', src: null, mask: 'rect', r: 0, crop: { z: 1, x: 0.5, y: 0.5 }, filt: {} }, o)),
    line: (o) => { const sw = (o && o.sw) || 4; return base(Object.assign({ type: 'line', sw, color: NAVY, dash: 'solid', capS: 'none', capE: 'none', h: Math.max(sw * 5, 16) }, o)); },
    icon: (o) => base(Object.assign({ type: 'icon', icon: 'cheese', fill: GOLD }, o)),
  };

  // compact template helpers
  const T = (text, x, y, w, size, o = {}) => GS.mk.text(Object.assign({ text, x, y, w, size }, o));
  const B = (x, y, w, h, fill, o = {}) => GS.mk.shape(Object.assign({ x, y, w, h, fill: fill == null ? 'none' : fill }, o));
  const P = (src, x, y, w, h, o = {}) => GS.mk.image(Object.assign({ src, x, y, w, h }, o));
  const IC = (icon, x, y, w, h, fill, o = {}) => GS.mk.icon(Object.assign({ icon, x, y, w, h, fill }, o));
  const LN = (x, y, w, o = {}) => GS.mk.line(Object.assign({ x, y, w }, o));
  const page = (bg, els) => ({ bg: typeof bg === 'string' ? { color: bg } : bg, els });
  const grad = (a, b, angle = 180) => ({ a, b, angle });

  GS.TEMPLATES = [
    {
      id: 'class-night', name: 'Class night', size: 'ig-post', tags: 'class event instagram',
      make: () => ({ w: 1080, h: 1080, pages: [page(NAVY, [
        P('p:class.jpg', 0, 0, 1080, 612),
        B(0, 0, 1080, 210, null, { grad: grad('#06273AB8', '#06273A00') }),
        B(0, 330, 1080, 284, null, { grad: grad('#06273A00', '#06273AFF') }),
        T('GREYS', 64, 54, 320, 54, { font: LS, weight: 800, color: CREAM, ls: 40 }),
        IC('sparkles', 916, 640, 96, 96, GOLD),
        T('CLASSES & EVENTS', 72, 646, 760, 30, { font: LS, weight: 700, color: GOLD, ls: 220 }),
        T('Cheese 101', 66, 690, 900, 128, { font: LS, weight: 800, color: CREAM, lh: 1 }),
        T('Wednesday, Dec 9  ·  6:30 PM  ·  Memphis', 72, 836, 940, 36, { font: NS, weight: 700, color: '#C9D6DF' }),
        B(72, 910, 540, 92, GOLD, { r: 46 }),
        T('Book at tickets.greyscheese.com', 72, 936, 540, 31, { font: NS, weight: 800, color: NAVY, align: 'center' }),
      ])] }),
    },
    {
      id: 'cheese-week', name: 'Cheese of the week', size: 'ig-post', tags: 'cheese feature instagram',
      make: () => ({ w: 1080, h: 1080, pages: [page(IVORY, [
        B(54, 92, 472, 732, null, { shape: 'arch', stroke: { c: GOLD, w: 4 } }),
        P('p:closeup.jpg', 74, 112, 432, 692, { mask: 'arch' }),
        T('CHEESE OF THE WEEK', 572, 150, 440, 26, { font: LS, weight: 700, color: RIND, ls: 200 }),
        T('Bayley Hazen Blue', 566, 194, 450, 96, { font: BC, weight: 800, color: NAVY, lh: 0.95 }),
        T('Jasper Hill Farm · Greensboro, Vermont', 572, 392, 430, 28, { font: NS, ital: true, color: '#4A5A66', lh: 1.3 }),
        LN(572, 482, 90, { sw: 4, color: GOLD }),
        T('Fudgy and rich, with notes of toasted nuts, dark chocolate and a little licorice.', 572, 526, 430, 31, { font: NS, color: '#2A3A46', lh: 1.45 }),
        B(572, 742, 168, 52, NAVY, { r: 26 }),
        T('COW · RAW', 572, 756, 168, 21, { font: LS, weight: 700, color: CREAM, align: 'center', ls: 120 }),
        B(872, 812, 168, 168, GOLD, { shape: 'seal', rot: -8 }),
        T('Ask for a taste', 882, 860, 148, 32, { font: BC, weight: 800, color: NAVY, align: 'center', lh: 1, rot: -8 }),
        T('GREYS  ·  Memphis  ·  Nashville', 54, 934, 800, 26, { font: LS, weight: 700, color: NAVY, ls: 160 }),
      ])] }),
    },
    {
      id: 'board-101', name: 'Board building 101', size: 'ig-portrait', tags: 'carousel how to instagram',
      make: () => {
        const steps = [
          ['1', 'Pick three cheeses', 'Something soft, something firm, something blue. Ask us for a taste.'],
          ['2', 'Add something salty', 'Prosciutto, salami or both. Fold it, roll it, make it easy to grab.'],
          ['3', 'Bring the sweet', 'Honey, fig jam, grapes or pears play nicely with every cheese.'],
          ['4', 'Fill the gaps', 'Crackers, nuts and olives make the board look full and generous.'],
        ];
        const tips = [T('THE GREYS METHOD', 80, 90, 920, 30, { font: LS, weight: 700, color: GOLD, ls: 240 })];
        steps.forEach(([n, t, b], i) => {
          const y = 180 + i * 262;
          tips.push(B(80, y, 96, 96, GOLD, { shape: 'ellipse' }), T(n, 80, y + 22, 96, 44, { font: LS, weight: 800, color: NAVY, align: 'center', lh: 1.15 }),
            T(t, 212, y + 2, 790, 54, { font: BC, weight: 800, color: CREAM, lh: 1 }), T(b, 212, y + 66, 790, 30, { font: NS, color: '#C9D6DF', lh: 1.4 }));
        });
        tips.push(T('GREYS', 600, 1250, 400, 36, { font: LS, weight: 800, color: GOLD, align: 'right', ls: 60 }));
        return { w: 1080, h: 1350, pages: [
          page(IVORY, [
            P('p:slate.jpg', 70, 70, 940, 760, { r: 28 }),
            T('HOW TO', 72, 886, 940, 34, { font: LS, weight: 700, color: RIND, ls: 260 }),
            T('Build a better cheese board', 64, 932, 952, 112, { font: BC, weight: 800, color: NAVY, lh: 0.95 }),
            T('Swipe for the GREYS method  →', 72, 1196, 700, 32, { font: NS, weight: 700, color: NAVY }),
            T('GREYS', 780, 1250, 230, 36, { font: LS, weight: 800, color: NAVY, align: 'right', ls: 60 }),
          ]),
          page(NAVY, tips),
          page(GOLD, [
            P('p:board.jpg', 190, 100, 700, 640, { mask: 'blob' }),
            T('Come build one with us', 80, 790, 920, 100, { font: BC, weight: 800, color: NAVY, align: 'center', lh: 0.95 }),
            T('Build-a-Board classes in Memphis & Nashville', 80, 1004, 920, 36, { font: NS, weight: 700, color: NAVY, align: 'center' }),
            B(290, 1100, 500, 92, NAVY, { r: 46 }),
            T('tickets.greyscheese.com', 290, 1126, 500, 32, { font: NS, weight: 800, color: CREAM, align: 'center' }),
          ]),
        ] };
      },
    },
    {
      id: 'cheesemas', name: 'Cheesemas boards', size: 'ig-post', tags: 'holiday christmas instagram',
      make: () => ({ w: 1080, h: 1080, pages: [page({ color: NAVY, grad: grad(NAVY2, NAVY) }, [
        IC('snowflake', 70, 92, 92, 92, LGOLD, { op: 0.28 }),
        IC('snowflake', 940, 300, 64, 64, LGOLD, { op: 0.22 }),
        IC('snowflake', 110, 560, 56, 56, LGOLD, { op: 0.2 }),
        IC('snowflake', 950, 880, 84, 84, LGOLD, { op: 0.26 }),
        IC('snowflake', 60, 930, 44, 44, LGOLD, { op: 0.2 }),
        P('p:board.jpg', 300, 110, 480, 480, { mask: 'ellipse', border: { c: GOLD, w: 10 } }),
        IC('sparkles', 744, 116, 112, 112, GOLD),
        T('Cheesemas', 0, 632, 1080, 150, { font: LS, weight: 800, color: GOLD, align: 'center', lh: 1 }),
        T('Holiday boards, gift boxes & cheese for the whole crew', 150, 796, 780, 38, { font: NS, weight: 600, color: CREAM, align: 'center', lh: 1.35 }),
        B(300, 930, 480, 84, CREAM, { r: 42 }),
        T('Order at greyscheese.com', 300, 953, 480, 30, { font: NS, weight: 800, color: NAVY, align: 'center' }),
      ])] }),
    },
    {
      id: 'new-arrivals', name: 'New at the counter', size: 'ig-story', tags: 'story reel instagram',
      make: () => ({ w: 1080, h: 1920, pages: [page(NAVY, [
        P('p:closeup.jpg', 0, 0, 1080, 1920),
        B(0, 0, 1080, 360, null, { grad: grad('#06273A99', '#06273A00') }),
        B(0, 880, 1080, 1040, null, { grad: grad('#06273A00', '#06273AF2') }),
        T('GREYS', 0, 120, 1080, 64, { font: LS, weight: 800, color: CREAM, align: 'center', ls: 60 }),
        B(784, 1140, 220, 220, GOLD, { shape: 'burst', rot: 12 }),
        T('NEW', 784, 1214, 220, 60, { font: LS, weight: 800, color: NAVY, align: 'center', rot: 12 }),
        T('FRESH OFF THE TRUCK', 90, 1330, 900, 40, { font: LS, weight: 700, color: GOLD, ls: 220 }),
        T('New at the counter', 84, 1392, 912, 150, { font: BC, weight: 800, color: CREAM, lh: 0.92 }),
        T('Stop in for a taste this weekend in Memphis & Nashville.', 90, 1694, 880, 44, { font: NS, weight: 600, color: '#E7EEF2', lh: 1.35 }),
      ])] }),
    },
    {
      id: 'raclette-flyer', name: 'Raclette night flyer', size: 'flyer', tags: 'event flyer print',
      make: () => ({ w: 816, h: 1056, pages: [page('#FBF6EC', [
        P('p:spread.jpg', 0, 0, 816, 470),
        B(0, 470, 816, 14, GOLD),
        T('GREYS FINE CHEESES PRESENTS', 64, 522, 688, 17, { font: LS, weight: 700, color: RIND, ls: 260, align: 'center' }),
        T('Raclette Night', 40, 556, 736, 104, { font: BC, weight: 800, color: NAVY, align: 'center', lh: 0.95 }),
        T('Melted Alpine cheese scraped tableside over potatoes, pickles and charcuterie.', 118, 678, 580, 24, { font: NS, color: '#3A4A56', align: 'center', lh: 1.45 }),
        B(158, 776, 500, 122, NAVY, { r: 16 }),
        T('Friday, December 11\n7:00 PM  ·  Memphis', 158, 800, 500, 30, { font: LS, weight: 700, color: CREAM, align: 'center', lh: 1.25 }),
        T('Reserve your seat at greyscheese.com', 64, 924, 688, 22, { font: NS, weight: 800, color: NAVY, align: 'center' }),
        B(0, 980, 816, 76, NAVY),
        T('Memphis (901) 440-4739   ·   Nashville (615) 900-4739', 0, 1007, 816, 18, { font: NS, weight: 700, color: LGOLD, align: 'center' }),
      ])] }),
    },
    {
      id: 'pairing-fb', name: 'Wine & cheese night', size: 'fb-post', tags: 'facebook event',
      make: () => ({ w: 1200, h: 630, pages: [page(NAVY, [
        P('p:class.jpg', 0, 0, 640, 630),
        B(640, 0, 6, 630, ANT),
        T('GREYS', 694, 64, 460, 40, { font: LS, weight: 800, color: CREAM, ls: 60 }),
        T('WINE & CHEESE', 694, 166, 460, 26, { font: LS, weight: 700, color: GOLD, ls: 200 }),
        T('Pairing Night', 690, 202, 470, 88, { font: BC, weight: 800, color: CREAM, lh: 0.95 }),
        T('Five cheeses, five wines, one very good evening.', 694, 404, 440, 24, { font: NS, color: '#C9D6DF', lh: 1.4 }),
        B(694, 500, 300, 64, GOLD, { r: 32 }),
        T('Thursday · 7 PM', 694, 518, 300, 23, { font: NS, weight: 800, color: NAVY, align: 'center' }),
      ])] }),
    },
    {
      id: 'sale', name: 'Weekend sale', size: 'ig-post', tags: 'promo sale discount instagram',
      make: () => ({ w: 1080, h: 1080, pages: [page(GOLD, [
        T('GREYS', 0, 64, 1080, 44, { font: LS, weight: 800, color: NAVY, align: 'center', ls: 80 }),
        B(240, 150, 600, 600, NAVY, { shape: 'burst', rot: -8 }),
        T('20%', 234, 300, 600, 220, { font: LS, weight: 800, color: GOLD, align: 'center', lh: 1, rot: -8 }),
        T('OFF', 255, 514, 600, 90, { font: LS, weight: 800, color: CREAM, align: 'center', lh: 1, rot: -8, ls: 120 }),
        T('All cheese wedges this weekend', 90, 806, 900, 56, { font: BC, weight: 800, color: NAVY, align: 'center' }),
        T('In store at GREYS  ·  Memphis & Nashville', 90, 884, 900, 30, { font: NS, weight: 700, color: NAVY, align: 'center' }),
      ])] }),
    },
    {
      id: 'cheese-card', name: 'Cheese counter card', size: 'cheese-card', tags: 'shelf talker sign print',
      make: () => ({ w: 384, h: 288, pages: [page('#FFFFFF', [
        B(0, 0, 384, 96, NAVY),
        T('Comté', 22, 16, 270, 46, { font: BC, weight: 800, color: CREAM, lh: 1.05 }),
        T('AGED 18 MONTHS', 22, 66, 270, 12.5, { font: LS, weight: 700, color: GOLD, ls: 200 }),
        // milk badge: swap in goat.svg or sheep.svg (Brand ▸ Stickers); blends use the gold cheese wheel instead
        B(306, 16, 64, 64, CREAM, { shape: 'ellipse', stroke: { c: GOLD, w: 3 } }),
        P('/studio/graphics/cow.svg', 315, 25, 46, 46, { fit: 'contain' }),
        T('France  ·  Cow  ·  Raw', 22, 112, 340, 14, { font: NS, weight: 800, color: RIND, upper: true, ls: 120 }),
        T('Brown butter, toasted hazelnut and a little sweetness on the finish.', 22, 138, 340, 15, { font: NS, color: '#33424D', lh: 1.4 }),
        LN(22, 206, 340, { sw: 1.5, color: '#E3D7BF' }),
        T('$00.00 / lb', 22, 230, 220, 30, { font: BC, weight: 800, color: NAVY }),
        T('GREYS', 262, 244, 100, 17, { font: LS, weight: 800, color: NAVY, align: 'right', ls: 80 }),
      ])] }),
    },
    {
      id: 'catering-menu', name: 'Catering menu', size: 'flyer', tags: 'menu catering print',
      make: () => {
        const els = [
          B(0, 0, 816, 200, NAVY),
          T('GREYS', 0, 44, 816, 58, { font: LS, weight: 800, color: CREAM, align: 'center', ls: 60, lh: 1 }),
          T('CATERING MENU', 0, 114, 816, 21, { font: LS, weight: 700, color: GOLD, align: 'center', ls: 320 }),
          T('Boards, sandwiches & sides for every crowd', 0, 150, 816, 17, { font: NS, ital: true, color: '#C9D6DF', align: 'center' }),
        ];
        const col = (x, y0, sections) => {
          let y = y0;
          sections.forEach(([head, items]) => {
            els.push(T(head, x, y, 320, 25, { font: BC, weight: 800, color: NAVY, ls: 80, upper: true }), LN(x, y + 32, 320, { sw: 2, color: GOLD }));
            y += 62;
            items.forEach(([name, desc]) => {
              els.push(T(name, x, y, 250, 17, { font: NS, weight: 800, color: NAVY }), T('$00', x + 250, y, 70, 17, { font: NS, weight: 800, color: RIND, align: 'right' }), T(desc, x, y + 24, 320, 13.5, { font: NS, color: '#4A5A66', lh: 1.35 }));
              y += 74;
            });
            y += 18;
          });
        };
        col(64, 244, [['Boards', [['Petite board', 'Serves 6 to 8. Three cheeses, two meats, fruit, nuts and crackers.'], ['Classic board', 'Serves 12 to 15. Five cheeses, three meats and all the fixings.'], ['Grand board', 'Serves 25 or more. Built to be the centerpiece of the room.']]], ['Sandwiches', [['Sandwich platter', 'A mix of our counter favorites, cut in halves for easy grabbing.']]]]);
        col(432, 244, [['Salads & sides', [['Seasonal green salad', 'Market greens, shaved cheese and house vinaigrette.'], ['Pasta salad', 'Herbs, olives and plenty of parmesan.'], ['Fresh fruit', 'Whatever is ripe and looking good this week.']]], ['Sweets & drinks', [['Cookie tray', 'Sweet bites to round out the spread.']]]]);
        els.push(P('p:board.jpg', 64, 826, 336, 150, { r: 12 }), P('p:spread.jpg', 416, 826, 336, 150, { r: 12 }),
          T('Order ahead at greyscheese.com  ·  Memphis (901) 440-4739  ·  Nashville (615) 900-4739', 0, 1004, 816, 13, { font: NS, weight: 700, color: NAVY, align: 'center' }));
        return { w: 816, h: 1056, pages: [page('#FFFFFF', els)] };
      },
    },
    {
      id: 'holiday-hours', name: 'Holiday hours sign', size: 'flyer', tags: 'sign hours holiday print',
      make: () => {
        const rows = [['Thu, Dec 24', '10 AM – 3 PM'], ['Fri, Dec 25', 'Closed'], ['Sat, Dec 26', '11 AM – 5 PM'], ['Thu, Dec 31', '10 AM – 4 PM'], ['Fri, Jan 1', 'Closed']];
        const els = [
          B(36, 36, 744, 984, null, { stroke: { c: NAVY, w: 3 } }),
          B(50, 50, 716, 956, null, { stroke: { c: GOLD, w: 1.5 } }),
          IC('snowflake', 363, 104, 90, 90, GOLD),
          T('Holiday Hours', 60, 222, 696, 86, { font: BC, weight: 800, color: NAVY, align: 'center' }),
          T('GREYS FINE CHEESES', 60, 330, 696, 18, { font: LS, weight: 700, color: RIND, align: 'center', ls: 300 }),
        ];
        rows.forEach(([d, h], i) => {
          const y = 420 + i * 72;
          els.push(T(d, 140, y, 300, 30, { font: NS, weight: 800, color: NAVY }), T(h, 400, y, 276, 30, { font: NS, weight: 600, color: NAVY, align: 'right' }), LN(140, y + 46, 536, { sw: 1, color: '#D9CBB0' }));
        });
        els.push(T('Thank you for a delicious year!', 60, 834, 696, 34, { font: PF, ital: true, color: NAVY, align: 'center' }),
          T('Memphis (901) 440-4739  ·  Nashville (615) 900-4739', 60, 930, 696, 18, { font: NS, weight: 700, color: RIND, align: 'center' }));
        return { w: 816, h: 1056, pages: [page(IVORY, els)] };
      },
    },
    {
      id: 'email-header', name: 'Email header', size: 'email-header', tags: 'email newsletter',
      make: () => ({ w: 600, h: 200, pages: [page(NAVY, [
        P('p:board.jpg', 360, 0, 240, 200),
        B(330, 0, 130, 200, null, { grad: grad('#06273AFF', '#06273A00', 90) }),
        T('GREYS', 36, 50, 300, 66, { font: LS, weight: 800, color: CREAM, lh: 1 }),
        T('FINE CHEESES · CHARCUTERIE · WINE', 38, 122, 320, 12.5, { font: LS, weight: 700, color: GOLD, ls: 160 }),
      ])] }),
    },
    {
      id: 'gift-card', name: 'Gift card', size: 'gift-card', tags: 'gift card print',
      make: () => ({ w: 336, h: 192, pages: [page({ color: NAVY, grad: grad('#123E57', NAVY, 135) }, [
        IC('wheel', 236, 22, 78, 78, GOLD),
        T('GREYS', 24, 24, 200, 40, { font: LS, weight: 800, color: CREAM, lh: 1 }),
        T('FINE CHEESES · CHARCUTERIE · WINE', 24, 68, 200, 8, { font: LS, weight: 700, color: GOLD, ls: 120 }),
        T('GIFT CARD', 24, 134, 200, 26, { font: BC, weight: 800, color: GOLD, ls: 120 }),
        T('greyscheese.com', 186, 152, 126, 10, { font: NS, weight: 700, color: '#C9D6DF', align: 'right' }),
      ])] }),
    },
  ];

  // ---------- New designs ----------
  GS.withIds = (pages) => pages.map((p) => ({ id: GS.uid('p'), bg: GS.clone(p.bg || { color: '#FFFFFF' }), els: p.els.map((e) => Object.assign(GS.clone(e), { id: GS.uid('e') })) }));
  GS.newDesign = (s) => ({
    id: GS.uid('d'), name: 'Untitled ' + (s.label ? s.label.toLowerCase() : 'design'), w: s.w, h: s.h, unit: s.unit || 'px', kind: s.k || 'custom',
    createdAt: Date.now(), pages: [{ id: GS.uid('p'), bg: { color: '#FFFFFF' }, els: [] }],
  });
  GS.fromTemplate = (t) => {
    const m = t.make();
    const s = GS.sizeByKey(t.size) || {};
    return { id: GS.uid('d'), name: t.name, w: m.w, h: m.h, unit: s.unit || 'px', kind: t.size, createdAt: Date.now(), pages: GS.withIds(m.pages) };
  };
  const tplCache = {};
  GS.tplPreview = (t) => (tplCache[t.id] = tplCache[t.id] || t.make());
})();
