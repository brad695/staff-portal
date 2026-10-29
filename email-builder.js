/* GREYS email builder: the visual editor behind Campaigns > Templates in manager.html.
   window.EmailBuilder.open({...}) shows a full-screen editor. A template's design is JSON
   (em_templates.design); compile() turns it into table-based, inline-styled email HTML
   (em_templates.html), which send-campaign-batch mails through SendGrid.
   {{UNSUBSCRIBE_URL}} and {{POSTAL_ADDRESS}} in the footer are filled in at send time. */
(function () {
'use strict';
if (window.EmailBuilder && window.EmailBuilder.version) return;

const ASSETS = 'https://vdvtrevhqalmjwhjhjug.supabase.co/storage/v1/object/public/email-assets/';
const LINKS = { order: 'https://orderonline.greyscheese.com', tickets: 'https://tickets.greyscheese.com', site: 'https://greyscheese.com' };
const QUICK_LINKS = [['Order online', LINKS.order], ['Tickets', LINKS.tickets], ['Website', LINKS.site]];

/* ---------- small helpers ---------- */
const uid = () => 'b' + Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');
const num = (v, d) => (v === '' || v == null || isNaN(+v) ? d : +v);
function safeUrl(u) {
  u = String(u == null ? '' : u).trim();
  if (!u) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(u) || /^\{\{[A-Z_]+\}\}$/.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(u)) return 'https://' + u;
  return '';
}
function getPath(o, p) { return String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) {
  const ks = String(p).split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = {}; a = a[ks[i]]; }
  a[ks[ks.length - 1]] = v;
}
function isoIn(days) { return new Date(Date.now() + days * 864e5).toISOString().slice(0, 10); }

/* ---------- looks ---------- */
const PRESETS = {
  navy:  { label: 'GREYS navy', bg: '#E9EDF2', body: '#3E4C63', text: '#DDE3EC', heading: '#FFFFFF', accent: '#F2C230', btnText: '#1E2A38', link: '#F2C230', muted: '#A9B4C4', line: '#53627C', card: '#354156', foot: '#5F6B7A' },
  white: { label: 'Clean white', bg: '#EEF1F5', body: '#FFFFFF', text: '#2F3640', heading: '#1E2A38', accent: '#E0A21C', btnText: '#1E2A38', link: '#8A5D00', muted: '#77808C', line: '#E3E6EA', card: '#F5F6F8', foot: '#6B7480' },
  rind:  { label: 'Rind and parchment', bg: '#E7DFD2', body: '#FFFDF8', text: '#3B342D', heading: '#2A241E', accent: '#7A4E25', btnText: '#FFFFFF', link: '#7A4E25', muted: '#8B8177', line: '#E6DDCF', card: '#F4EEE3', foot: '#756A5E' },
};
const COLOR_KEYS = [
  ['bg', 'Page background'], ['body', 'Email background'], ['heading', 'Headings'], ['text', 'Body text'],
  ['accent', 'Buttons'], ['btnText', 'Button text'], ['link', 'Links and highlights'], ['card', 'Cards'],
  ['muted', 'Small print'], ['line', 'Lines'], ['foot', 'Footer text'],
];
const FONTS = {
  classic:  { label: 'Classic', note: 'Serif headings, plain text', head: "Georgia, 'Times New Roman', serif", body: 'Arial, Helvetica, sans-serif' },
  clean:    { label: 'Clean', note: 'Plain sans serif throughout', head: 'Arial, Helvetica, sans-serif', body: 'Arial, Helvetica, sans-serif' },
  bookish:  { label: 'Bookish', note: 'Serif throughout', head: "Georgia, 'Times New Roman', serif", body: "Georgia, 'Times New Roman', serif" },
  friendly: { label: 'Friendly', note: 'Rounder sans serif', head: "'Trebuchet MS', Verdana, sans-serif", body: "'Trebuchet MS', Verdana, sans-serif" },
};
const RADII = { square: 0, soft: 6, round: 14 };

function themeOf(d) {
  const th = (d && d.theme) || {};
  const base = PRESETS[th.preset] || PRESETS.navy;
  const t = {};
  Object.keys(base).forEach((k) => { if (k !== 'label') t[k] = /^#[0-9a-f]{6}$/i.test(th[k] || '') ? th[k] : base[k]; });
  const f = FONTS[th.font] || FONTS.classic;
  t.fh = f.head; t.fb = f.body;
  t.r = RADII[th.radius] != null ? RADII[th.radius] : 6;
  return t;
}

/* ---------- rich text: b, i, u, links, lists, paragraphs. Nothing else survives. ---------- */
const RICH = { P: 'p', DIV: 'p', H1: 'p', H2: 'p', H3: 'p', H4: 'p', BR: 'br', B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', A: 'a', UL: 'ul', OL: 'ol', LI: 'li' };
const BLOCKY = /^(P|DIV|UL|OL|LI|H[1-6]|TABLE|BLOCKQUOTE)$/;
function cleanRich(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  const walk = (node) => {
    let s = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { s += esc(n.nodeValue.replace(/ /g, ' ')); return; }
      if (n.nodeType !== 1) return;
      let tag = RICH[n.tagName];
      const inner = walk(n);
      if (tag === 'p' && [...n.children].some((c) => BLOCKY.test(c.tagName))) tag = null;
      if (n.style && n.style.fontWeight && +n.style.fontWeight >= 600 && !tag) { s += '<b>' + inner + '</b>'; return; }
      if (!tag) { s += inner; return; }
      if (tag === 'br') { s += '<br>'; return; }
      if (tag === 'a') {
        const h = safeUrl(n.getAttribute('href'));
        s += h ? '<a href="' + esc(h) + '">' + inner + '</a>' : inner;
        return;
      }
      s += '<' + tag + '>' + inner + '</' + tag + '>';
    });
    return s;
  };
  return walk(tpl.content).trim();
}
function styleRich(html, t, o) {
  o = o || {};
  const size = o.size || 16;
  const base = 'font-family:' + (o.font || t.fb) + ';font-size:' + size + 'px;line-height:' + (o.lh || 1.6) + ';color:' + (o.color || t.text) + ';';
  const tpl = document.createElement('template');
  tpl.innerHTML = cleanRich(html) || '<p><br></p>';
  const frag = tpl.content;
  let run = null;
  [...frag.childNodes].forEach((n) => {
    if (n.nodeType === 1 && /^(P|UL|OL)$/.test(n.tagName)) { run = null; return; }
    if (n.nodeType === 3 && !n.nodeValue.trim() && !run) { n.remove(); return; }
    if (!run) { run = document.createElement('p'); frag.insertBefore(run, n); }
    run.appendChild(n);
  });
  const blocks = [...frag.children];
  blocks.forEach((n, i) => {
    const mb = i === blocks.length - 1 ? 0 : Math.round(size * 0.9);
    if (n.tagName === 'P') n.setAttribute('style', 'margin:0 0 ' + mb + 'px;' + base + 'text-align:' + (o.align || 'left') + ';');
    else n.setAttribute('style', 'margin:0 0 ' + mb + 'px;padding:0 0 0 22px;' + base);
  });
  frag.querySelectorAll('li').forEach((n) => n.setAttribute('style', 'margin:0 0 6px;'));
  frag.querySelectorAll('a').forEach((n) => {
    n.setAttribute('style', 'color:' + (o.link || t.link) + ';text-decoration:underline;');
    n.setAttribute('target', '_blank');
  });
  const div = document.createElement('div');
  div.appendChild(frag);
  return div.innerHTML;
}
function stripUnsafe(h) {
  return String(h || '')
    .replace(/<(script|iframe|object|embed|form|style|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|form|style|link|meta|base|input|textarea|select|button)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/* ---------- building pieces. ctx.edit adds the hooks the editor needs. ---------- */
const ed = (ctx, path, kind, ph) => (ctx.edit
  ? ' data-eb-edit="' + path + '" data-eb-kind="' + (kind || 'plain') + '" contenteditable="true" spellcheck="true"' + (ph ? ' data-eb-ph="' + esc(ph) + '"' : '')
  : '');
const slot = (ctx, path) => (ctx.edit ? ' data-eb-img="' + path + '"' : '');

function row(b, ctx, inner, o) {
  o = o || {};
  const px = o.px == null ? 32 : o.px;
  const al = o.align && o.align !== 'left' ? o.align : '';
  return '<tr' + (ctx.edit ? ' class="eb-row" data-eb-id="' + b.id + '"' : '') + '><td' + (px ? ' class="eb-px"' : '') + (al ? ' align="' + al + '"' : '') +
    ' style="padding:' + num(b.pt, 16) + 'px ' + px + 'px ' + num(b.pb, 16) + 'px;' + (al ? 'text-align:' + al + ';' : '') +
    (b.bg ? 'background-color:' + b.bg + ';' : '') + '"' + (b.bg ? ' bgcolor="' + b.bg + '"' : '') + '>' + inner + '</td></tr>';
}

function img(ctx, t, o) {
  if (!o.src) {
    if (!ctx.edit) return '';
    return '<div class="eb-ph"' + slot(ctx, o.path) + ' style="height:' + (o.ph || 200) + 'px;border:2px dashed ' + t.line + ';border-radius:' + t.r + 'px;color:' + t.muted +
      ';font:600 14px/1.3 Arial,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;' + (o.style || '') + '">Add a photo</div>';
  }
  const r = o.radius == null ? t.r : o.radius;
  const m = o.align === 'center' ? 'margin:0 auto;' : o.align === 'right' ? 'margin:0 0 0 auto;' : '';
  const tag = '<img src="' + esc(o.src) + '" alt="' + esc(o.alt || '') + '" width="' + o.w + '" style="display:block;width:100%;max-width:' + o.w +
    'px;height:auto;border:0;outline:none;text-decoration:none;' + m + (r ? 'border-radius:' + r + 'px;' : '') + (o.style || '') + '"' + slot(ctx, o.path) + '>';
  const h = safeUrl(o.href);
  return h ? '<a href="' + esc(h) + '" target="_blank" style="text-decoration:none;">' + tag + '</a>' : tag;
}

function button(ctx, t, o) {
  const href = safeUrl(o.href) || '#';
  const out = o.style === 'outline';
  const al = o.align || 'center';
  const pad = o.small ? '10px 20px' : '14px 30px';
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0"' + (al === 'left' ? '' : ' align="' + al + '"') + (o.full ? ' width="100%"' : '') +
    ' style="border-collapse:separate;' + (al === 'center' && !o.full ? 'margin:0 auto;' : '') + '"><tr><td align="center"' + (out ? '' : ' bgcolor="' + t.accent + '"') +
    ' style="border-radius:' + t.r + 'px;' + (out ? '' : 'background-color:' + t.accent + ';') + '"><a href="' + esc(href) + '" target="_blank" style="display:' + (o.full ? 'block' : 'inline-block') +
    ';padding:' + pad + ';border:2px solid ' + t.accent + ';border-radius:' + t.r + 'px;font-family:' + t.fb + ';font-size:' + (o.small ? 14 : 16) +
    'px;font-weight:bold;line-height:1.2;color:' + (out ? t.link : t.btnText) + ';text-decoration:none;text-align:center;"' + ed(ctx, o.path || 'label', 'line', 'Button text') + '>' +
    esc(o.label) + '</a></td></tr></table>';
}

const h2 = (ctx, t, path, text, size, ph, extra) => '<h2 style="margin:0;font-family:' + t.fh + ';font-size:' + size + 'px;line-height:1.25;font-weight:bold;color:' + t.heading + ';' +
  (extra || '') + '"' + ed(ctx, path, 'plain', ph) + '>' + nl2br(text) + '</h2>';
const small = (ctx, t, path, text, extra, ph) => '<div style="font-family:' + t.fb + ';font-size:13px;line-height:1.5;color:' + t.muted + ';' + (extra || '') + '"' + ed(ctx, path, 'line', ph) + '>' + esc(text) + '</div>';
const richDiv = (ctx, t, path, html, o, ph) => '<div' + ed(ctx, path, 'rich', ph || 'Start typing') + '>' + styleRich(html, t, o) + '</div>';
const btnRow = (ctx, t, b, align, pad) => (b.btnLabel
  ? '<div style="padding-top:' + (pad == null ? 16 : pad) + 'px;">' + button(ctx, t, { label: b.btnLabel, href: b.btnHref, align: align || 'left', small: true, path: 'btnLabel' }) + '</div>'
  : '');

/* ---------- blocks ---------- */
const BLOCKS = {};
const def = (type, spec) => { spec.type = type; BLOCKS[type] = spec; };
const BTN_FIELDS = [
  { k: 'btnLabel', t: 'text', label: 'Button text', hint: 'Leave empty for no button.' },
  { k: 'btnHref', t: 'url', label: 'Button link', show: (b) => !!b.btnLabel },
];

def('logo', {
  label: 'Logo', group: 'basics',
  make: () => ({ mode: 'text', word: 'GREYS', tag: 'Fine Cheeses', src: '', width: 180, href: LINKS.site, align: 'center', pt: 28, pb: 8 }),
  fields: [
    { k: 'mode', t: 'seg', label: 'Show', opts: [['text', 'Name'], ['image', 'Logo image']], redraw: true },
    { k: 'word', t: 'text', label: 'Name', show: (b) => b.mode !== 'image' },
    { k: 'tag', t: 'text', label: 'Tagline', show: (b) => b.mode !== 'image' },
    { k: 'src', t: 'image', label: 'Logo image', show: (b) => b.mode === 'image' },
    { k: 'width', t: 'range', label: 'Width', min: 80, max: 360, step: 10, unit: 'px', show: (b) => b.mode === 'image' },
    { k: 'href', t: 'url', label: 'Link' },
    { k: 'align', t: 'align', label: 'Alignment' },
  ],
  images: (b) => (b.mode === 'image' ? [['src', null]] : []),
  render(b, t, ctx) {
    let inner;
    if (b.mode === 'image') {
      inner = img(ctx, t, { src: b.src, alt: 'GREYS Fine Cheeses', w: num(b.width, 180), path: 'src', radius: 0, ph: 80, align: b.align || 'center' });
    } else {
      inner = '<div style="font-family:' + t.fb + ';font-size:26px;font-weight:bold;letter-spacing:3px;line-height:1.15;color:' + t.heading + ';"' + ed(ctx, 'word', 'line', 'Name') + '>' + esc(b.word) + '</div>' +
        (b.tag || ctx.edit ? '<div style="padding-top:4px;font-family:' + t.fb + ';font-size:11px;letter-spacing:4px;text-transform:uppercase;line-height:1.3;color:' + t.link + ';"' + ed(ctx, 'tag', 'line', 'Tagline') + '>' + esc(b.tag) + '</div>' : '');
      const h = safeUrl(b.href);
      if (h && !ctx.edit) inner = '<a href="' + esc(h) + '" target="_blank" style="text-decoration:none;color:' + t.heading + ';">' + inner + '</a>';
    }
    return row(b, ctx, inner, { align: b.align || 'center' });
  },
});

def('heading', {
  label: 'Heading', group: 'basics',
  make: () => ({ text: 'Say what this email is about', size: 'm', align: 'left', pt: 24, pb: 8 }),
  fields: [
    { k: 'text', t: 'textarea', label: 'Heading', rows: 2 },
    { k: 'size', t: 'seg', label: 'Size', opts: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] },
    { k: 'align', t: 'align', label: 'Alignment' },
  ],
  render(b, t, ctx) {
    const px = { s: 20, m: 28, l: 36 }[b.size] || 28;
    return row(b, ctx, '<h1' + (px > 20 ? ' class="eb-h' + px + '"' : '') + ' style="margin:0;font-family:' + t.fh + ';font-size:' + px + 'px;line-height:1.2;font-weight:bold;color:' + t.heading +
      ';text-align:' + (b.align || 'left') + ';"' + ed(ctx, 'text', 'plain', 'Heading') + '>' + nl2br(b.text) + '</h1>', { align: b.align });
  },
});

def('text', {
  label: 'Text', group: 'basics',
  make: () => ({ html: '<p>Write a few friendly lines here. Select words to make them bold or turn them into a link.</p>', size: 16, align: 'left', pt: 8, pb: 16 }),
  fields: [
    { t: 'note', text: 'Click the text in the email to edit it. Select words to make them bold, italic or a link.' },
    { k: 'size', t: 'seg', label: 'Text size', opts: [[14, 'Small'], [16, 'Normal'], [18, 'Large']] },
    { k: 'align', t: 'align', label: 'Alignment' },
  ],
  render(b, t, ctx) {
    return row(b, ctx, richDiv(ctx, t, 'html', b.html, { size: num(b.size, 16), align: b.align }));
  },
});

def('image', {
  label: 'Photo', group: 'basics',
  make: () => ({ src: '', alt: '', href: '', full: false, caption: '', pt: 8, pb: 8 }),
  fields: [
    { k: 'src', t: 'image', label: 'Photo' },
    { k: 'alt', t: 'text', label: 'Describe the photo', hint: 'Read aloud by screen readers and shown when images are turned off.' },
    { k: 'href', t: 'url', label: 'Link (optional)' },
    { k: 'full', t: 'toggle', label: 'Edge to edge' },
    { k: 'caption', t: 'text', label: 'Caption (optional)' },
  ],
  images: () => [['src', 'alt']],
  render(b, t, ctx) {
    const full = !!b.full;
    return row(b, ctx, img(ctx, t, { src: b.src, alt: b.alt, href: b.href, w: full ? 600 : 536, path: 'src', radius: full ? 0 : null, ph: 240 }) +
      (b.caption ? small(ctx, t, 'caption', b.caption, 'padding:8px ' + (full ? '32px' : '0') + ' 0;', 'Caption') : ''), { px: full ? 0 : 32 });
  },
});

def('button', {
  label: 'Button', group: 'basics',
  make: () => ({ label: 'Order for pickup', href: LINKS.order, align: 'center', style: 'fill', full: false, pt: 12, pb: 20 }),
  fields: [
    { k: 'label', t: 'text', label: 'Button text' },
    { k: 'href', t: 'url', label: 'Link' },
    { k: 'style', t: 'seg', label: 'Style', opts: [['fill', 'Solid'], ['outline', 'Outline']] },
    { k: 'align', t: 'align', label: 'Alignment' },
    { k: 'full', t: 'toggle', label: 'Full width' },
  ],
  buttons: () => [['label', 'href']],
  render(b, t, ctx) { return row(b, ctx, button(ctx, t, b), { align: b.align }); },
});

def('columns', {
  label: 'Photo and text', group: 'greys',
  make: () => ({ src: '', alt: '', href: '', side: 'left', title: 'A short title', html: '<p>A couple of sentences that go with the photo.</p>', btnLabel: 'Learn more', btnHref: LINKS.site, pt: 16, pb: 16 }),
  fields: [
    { k: 'src', t: 'image', label: 'Photo' },
    { k: 'alt', t: 'text', label: 'Describe the photo' },
    { k: 'side', t: 'seg', label: 'Photo goes on the', opts: [['left', 'Left'], ['right', 'Right']] },
    { k: 'title', t: 'text', label: 'Title' },
    { t: 'note', text: 'Click the text in the email to edit it.' },
  ].concat(BTN_FIELDS),
  images: () => [['src', 'alt']],
  buttons: () => [['btnLabel', 'btnHref']],
  render(b, t, ctx) {
    const rtl = b.side === 'right';
    const a = '<td class="eb-col eb-col-a" width="50%" valign="top" dir="ltr" style="width:50%;' + (rtl ? 'padding-left:12px;' : 'padding-right:12px;') + '">' +
      img(ctx, t, { src: b.src, alt: b.alt, href: b.href, w: 256, path: 'src', ph: 190 }) + '</td>';
    const c = '<td class="eb-col" width="50%" valign="top" dir="ltr" style="width:50%;' + (rtl ? 'padding-right:12px;' : 'padding-left:12px;') + '">' +
      h2(ctx, t, 'title', b.title, 20, 'Title', 'margin-bottom:8px;') + richDiv(ctx, t, 'html', b.html, { size: 15 }) + btnRow(ctx, t, b, 'left', 14) + '</td>';
    return row(b, ctx, '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="' + (rtl ? 'rtl' : 'ltr') + '"><tr>' + a + c + '</tr></table>');
  },
});

def('images2', {
  label: 'Two photos', group: 'basics',
  make: () => ({ src1: '', alt1: '', href1: '', cap1: '', src2: '', alt2: '', href2: '', cap2: '', pt: 8, pb: 8 }),
  fields: [
    { k: 'src1', t: 'image', label: 'Left photo' }, { k: 'alt1', t: 'text', label: 'Describe the left photo' },
    { k: 'href1', t: 'url', label: 'Left photo link (optional)' }, { k: 'cap1', t: 'text', label: 'Left caption (optional)' },
    { k: 'src2', t: 'image', label: 'Right photo' }, { k: 'alt2', t: 'text', label: 'Describe the right photo' },
    { k: 'href2', t: 'url', label: 'Right photo link (optional)' }, { k: 'cap2', t: 'text', label: 'Right caption (optional)' },
  ],
  images: () => [['src1', 'alt1'], ['src2', 'alt2']],
  render(b, t, ctx) {
    const cell = (n) => '<td class="eb-col' + (n === 1 ? ' eb-col-a' : '') + '" width="50%" valign="top" style="width:50%;' + (n === 1 ? 'padding-right:8px;' : 'padding-left:8px;') + '">' +
      img(ctx, t, { src: b['src' + n], alt: b['alt' + n], href: b['href' + n], w: 260, path: 'src' + n, ph: 180 }) +
      (b['cap' + n] ? small(ctx, t, 'cap' + n, b['cap' + n], 'padding-top:8px;', 'Caption') : '') + '</td>';
    return row(b, ctx, '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' + cell(1) + cell(2) + '</tr></table>');
  },
});

def('cheese', {
  label: 'Cheese of the week', group: 'greys',
  make: () => ({ kicker: 'Cheese of the week', name: 'Name of the cheese', meta: "Cow's milk, Vermont", price: '', src: ASSETS + 'club/only-rinds.jpg', alt: 'A wedge of cheese',
    html: '<p>What it tastes like, what to pair it with, and why we love it this week.</p>', btnLabel: 'Order for pickup', btnHref: LINKS.order, pt: 16, pb: 16 }),
  fields: [
    { k: 'src', t: 'image', label: 'Photo (optional)' },
    { k: 'alt', t: 'text', label: 'Describe the photo', show: (b) => !!b.src },
    { k: 'kicker', t: 'text', label: 'Label' },
    { k: 'name', t: 'text', label: 'Cheese' },
    { k: 'meta', t: 'text', label: 'Milk and origin' },
    { k: 'price', t: 'text', label: 'Price (optional)', ph: '$14 a half pound' },
    { t: 'note', text: 'Click the tasting notes in the email to edit them.' },
  ].concat(BTN_FIELDS),
  buttons: () => [['btnLabel', 'btnHref']],
  render(b, t, ctx) {
    const photo = b.src || ctx.edit
      ? '<tr><td style="padding:0;">' + img(ctx, t, { src: b.src, alt: b.alt, w: 536, path: 'src', radius: 0, ph: 200, style: t.r ? 'border-radius:' + t.r + 'px ' + t.r + 'px 0 0;' : '' }) + '</td></tr>'
      : '';
    const card = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + t.card + '" style="border-collapse:separate;background-color:' + t.card + ';border-radius:' + t.r + 'px;">' +
      photo + '<tr><td style="padding:22px 24px 24px;">' +
      '<div style="font-family:' + t.fb + ';font-size:13px;font-weight:bold;line-height:1.4;color:' + t.link + ';"' + ed(ctx, 'kicker', 'line', 'Label') + '>' + esc(b.kicker) + '</div>' +
      h2(ctx, t, 'name', b.name, 24, 'Cheese name', 'margin:4px 0 2px;') +
      small(ctx, t, 'meta', b.meta, 'font-size:14px;', 'Milk and origin') +
      (b.price ? '<div style="padding-top:6px;font-family:' + t.fb + ';font-size:15px;font-weight:bold;line-height:1.4;color:' + t.heading + ';"' + ed(ctx, 'price', 'line', 'Price') + '>' + esc(b.price) + '</div>' : '') +
      '<div style="padding-top:12px;">' + richDiv(ctx, t, 'html', b.html, { size: 15 }, 'Tasting notes') + '</div>' + btnRow(ctx, t, b, 'left') +
      '</td></tr></table>';
    return row(b, ctx, card);
  },
});

def('event', {
  label: 'Event or class', group: 'greys',
  make: () => ({ date: isoIn(10), title: 'Raclette night', when: 'Saturday, 6 to 8 pm at GREYS Memphis', src: '', alt: '',
    html: '<p>Melted raclette, little potatoes, pickles and a glass of wine. Seats are limited.</p>', btnLabel: 'Get tickets', btnHref: LINKS.tickets, pt: 16, pb: 16 }),
  fields: [
    { k: 'date', t: 'date', label: 'Date' },
    { k: 'title', t: 'text', label: 'Title' },
    { k: 'when', t: 'text', label: 'Time and place' },
    { k: 'src', t: 'image', label: 'Photo (optional)' },
    { k: 'alt', t: 'text', label: 'Describe the photo', show: (b) => !!b.src },
    { t: 'note', text: 'Click the description in the email to edit it.' },
  ].concat(BTN_FIELDS),
  buttons: () => [['btnLabel', 'btnHref']],
  render(b, t, ctx) {
    const d = new Date(String(b.date || '') + 'T12:00:00');
    const ok = !isNaN(d.getTime());
    const mon = ok ? d.toLocaleString('en-US', { month: 'short' }).toUpperCase() : 'DATE';
    const day = ok ? d.getDate() : '?';
    const badge = '<td width="64" valign="top" style="width:64px;padding-right:18px;"><table role="presentation" width="64" cellpadding="0" cellspacing="0" border="0" bgcolor="' + t.accent +
      '" style="border-collapse:separate;background-color:' + t.accent + ';border-radius:' + t.r + 'px;"><tr><td align="center" style="padding:9px 0 10px;font-family:' + t.fb + ';color:' + t.btnText +
      ';text-align:center;"><div style="font-size:12px;font-weight:bold;letter-spacing:1px;line-height:1.2;">' + mon + '</div><div style="font-size:26px;font-weight:bold;line-height:1.1;">' + day + '</div></td></tr></table></td>';
    const info = '<td valign="top">' + h2(ctx, t, 'title', b.title, 22, 'Event title') +
      '<div style="padding-top:4px;font-family:' + t.fb + ';font-size:14px;font-weight:bold;line-height:1.45;color:' + t.link + ';"' + ed(ctx, 'when', 'line', 'Time and place') + '>' + esc(b.when) + '</div>' +
      '<div style="padding-top:10px;">' + richDiv(ctx, t, 'html', b.html, { size: 15 }, 'What to expect') + '</div>' + btnRow(ctx, t, b, 'left') + '</td>';
    const photo = b.src ? img(ctx, t, { src: b.src, alt: b.alt, w: 536, path: 'src', ph: 200 }) + '<div style="height:18px;line-height:18px;font-size:1px;">&nbsp;</div>' : '';
    return row(b, ctx, photo + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' + badge + info + '</tr></table>');
  },
});

def('promo', {
  label: 'Coupon', group: 'greys',
  make: () => ({ kicker: 'This week only', headline: '10% off every cheeseboard', code: 'BOARD10', fine: 'Enter the code when you order online. Ends Sunday.', btnLabel: 'Order a board', btnHref: LINKS.order, pt: 16, pb: 16 }),
  fields: [
    { k: 'kicker', t: 'text', label: 'Label' },
    { k: 'headline', t: 'text', label: 'Offer' },
    { k: 'code', t: 'text', label: 'Coupon code', hint: 'Leave empty if no code is needed.' },
    { k: 'fine', t: 'textarea', label: 'Fine print', rows: 2 },
  ].concat(BTN_FIELDS),
  buttons: () => [['btnLabel', 'btnHref']],
  render(b, t, ctx) {
    const code = b.code ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:16px auto 0;border-collapse:separate;"><tr><td bgcolor="' + t.card +
      '" style="padding:10px 22px;background-color:' + t.card + ';border-radius:' + t.r + "px;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:bold;letter-spacing:3px;color:" + t.heading + ';"' +
      ed(ctx, 'code', 'line', 'CODE') + '>' + esc(b.code) + '</td></tr></table>' : '';
    const box = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:2px dashed ' + t.accent + ';border-radius:' + t.r +
      'px;"><tr><td align="center" style="padding:26px 24px;text-align:center;">' +
      '<div style="font-family:' + t.fb + ';font-size:13px;font-weight:bold;line-height:1.4;color:' + t.link + ';"' + ed(ctx, 'kicker', 'line', 'Label') + '>' + esc(b.kicker) + '</div>' +
      h2(ctx, t, 'headline', b.headline, 26, 'The offer', 'padding-top:4px;text-align:center;') + code +
      (b.fine ? small(ctx, t, 'fine', b.fine, 'padding-top:12px;text-align:center;', 'Fine print') : '') +
      (b.btnLabel ? '<div style="padding-top:18px;">' + button(ctx, t, { label: b.btnLabel, href: b.btnHref, align: 'center', path: 'btnLabel' }) + '</div>' : '') +
      '</td></tr></table>';
    return row(b, ctx, box);
  },
});

def('prices', {
  label: 'Price list', group: 'greys',
  make: () => ({ title: 'Cheeseboards', rows: [
    { name: 'Demi', desc: 'Serves 4 to 6', price: '$50' },
    { name: 'Gathering', desc: 'Serves 10 to 12', price: '$99' },
    { name: 'Custom', desc: 'Built around your event', price: 'from $150' },
  ], pt: 16, pb: 16 }),
  fields: [
    { k: 'title', t: 'text', label: 'Title' },
    { k: 'rows', t: 'rows', label: 'Items', one: 'item', cols: [['name', 'Name'], ['desc', 'Details'], ['price', 'Price']] },
  ],
  render(b, t, ctx) {
    const rows = (b.rows || []).map((r, i) => {
      const line = i ? 'border-top:1px solid ' + t.line + ';' : '';
      return '<tr><td valign="top" style="padding:12px 0;' + line + '"><div style="font-family:' + t.fb + ';font-size:16px;font-weight:bold;line-height:1.3;color:' + t.heading + ';"' +
        ed(ctx, 'rows.' + i + '.name', 'line', 'Name') + '>' + esc(r.name) + '</div>' + (r.desc || ctx.edit ? small(ctx, t, 'rows.' + i + '.desc', r.desc, '', 'Details') : '') +
        '</td><td valign="top" align="right" style="padding:12px 0 12px 16px;' + line + 'font-family:' + t.fb + ';font-size:16px;font-weight:bold;line-height:1.3;color:' + t.link +
        ';white-space:nowrap;text-align:right;"' + ed(ctx, 'rows.' + i + '.price', 'line', 'Price') + '>' + esc(r.price) + '</td></tr>';
    }).join('');
    return row(b, ctx, (b.title || ctx.edit ? h2(ctx, t, 'title', b.title, 20, 'Title', 'margin-bottom:4px;') : '') +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>');
  },
});

def('note', {
  label: 'Note from the owners', group: 'greys',
  make: () => ({ html: '<p>Hi friends,</p><p>A few words about what is new at the shop this week, written the way you would say it at the counter.</p>',
    sign: 'Jackie & Kurt', role: 'Owners, GREYS Fine Cheeses', pt: 24, pb: 20 }),
  fields: [
    { t: 'note', text: 'Click the letter in the email to edit it.' },
    { k: 'sign', t: 'text', label: 'Signed' },
    { k: 'role', t: 'text', label: 'Under the signature' },
  ],
  render(b, t, ctx) {
    return row(b, ctx, richDiv(ctx, t, 'html', b.html, { size: 17, lh: 1.7 }, 'Write your note') +
      '<div style="padding-top:18px;font-family:' + t.fh + ';font-size:22px;font-style:italic;line-height:1.3;color:' + t.heading + ';"' + ed(ctx, 'sign', 'line', 'Your names') + '>' + esc(b.sign) + '</div>' +
      (b.role || ctx.edit ? small(ctx, t, 'role', b.role, 'padding-top:2px;', 'Title') : ''));
  },
});

def('social', {
  label: 'Row of links', group: 'basics',
  make: () => ({ links: [
    { label: 'Order online', href: LINKS.order },
    { label: 'Classes and events', href: LINKS.tickets },
    { label: 'greyscheese.com', href: LINKS.site },
  ], align: 'center', pt: 12, pb: 12 }),
  fields: [
    { k: 'links', t: 'rows', label: 'Links', one: 'link', cols: [['label', 'Text'], ['href', 'Link']] },
    { k: 'align', t: 'align', label: 'Alignment' },
  ],
  buttons: (b) => (b.links || []).map((l, i) => ['links.' + i + '.label', 'links.' + i + '.href']),
  render(b, t, ctx) {
    const sep = '<span style="color:' + t.muted + ';">&nbsp;&nbsp;|&nbsp;&nbsp;</span>';
    const links = (b.links || []).map((l, i) => '<a href="' + esc(safeUrl(l.href) || '#') + '" target="_blank" style="font-family:' + t.fb + ';font-size:14px;font-weight:bold;line-height:1.8;color:' + t.link +
      ';text-decoration:none;"' + ed(ctx, 'links.' + i + '.label', 'line', 'Link text') + '>' + esc(l.label) + '</a>').join(sep);
    return row(b, ctx, '<div style="font-family:' + t.fb + ';font-size:14px;line-height:1.8;text-align:' + (b.align || 'center') + ';">' + links + '</div>', { align: b.align || 'center' });
  },
});

def('divider', {
  label: 'Divider', group: 'basics',
  make: () => ({ style: 'line', pt: 12, pb: 12 }),
  fields: [{ k: 'style', t: 'seg', label: 'Style', opts: [['line', 'Full line'], ['short', 'Short accent']] }],
  render(b, t, ctx) {
    const inner = b.style === 'short'
      ? '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td width="56" height="3" bgcolor="' + t.accent + '" style="width:56px;height:3px;line-height:3px;font-size:1px;background-color:' + t.accent + ';">&nbsp;</td></tr></table>'
      : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="' + t.line + '" style="height:1px;line-height:1px;font-size:1px;background-color:' + t.line + ';">&nbsp;</td></tr></table>';
    return row(b, ctx, inner);
  },
});

def('spacer', {
  label: 'Space', group: 'basics', spacing: false,
  make: () => ({ h: 24, pt: 0, pb: 0 }),
  fields: [{ k: 'h', t: 'range', label: 'Height', min: 8, max: 96, step: 4, unit: 'px' }],
  render(b, t, ctx) {
    const hh = num(b.h, 24);
    return row(b, ctx, '<div style="height:' + hh + 'px;line-height:' + hh + 'px;font-size:1px;">&nbsp;</div>', { px: 0 });
  },
});

def('html', {
  label: 'Custom HTML', group: 'basics',
  make: () => ({ code: '<p style="margin:0;font-family:Arial,sans-serif;font-size:16px;">Your HTML here</p>', pt: 8, pb: 8 }),
  fields: [{ k: 'code', t: 'code', label: 'HTML', hint: 'For layouts the other blocks cannot do. Use inline styles. Scripts and forms are removed.' }],
  render(b, t, ctx) { return row(b, ctx, '<div style="font-family:' + t.fb + ';color:' + t.text + ';">' + stripUnsafe(b.code) + '</div>'); },
});

def('footer', {
  label: 'Footer', group: 'fixed', fixed: true,
  make: () => ({ name: 'GREYS Fine Cheeses', places: 'Memphis and Nashville', addrAuto: true, address: '',
    note: 'You are getting this email because you signed up for news from GREYS Fine Cheeses.', pt: 20, pb: 28 }),
  fields: [
    { t: 'note', text: 'Every email ends with this footer. It always has an unsubscribe link and your mailing address, which the law requires.' },
    { k: 'name', t: 'text', label: 'Business name' },
    { k: 'places', t: 'text', label: 'Locations' },
    { k: 'addrAuto', t: 'toggle', label: 'Use the mailing address on file', redraw: true },
    { k: 'address', t: 'textarea', label: 'Mailing address', rows: 2, show: (b) => b.addrAuto === false },
    { k: 'note', t: 'textarea', label: 'Why they are getting this', rows: 3 },
  ],
  render(b, t, ctx) {
    const s = 'font-family:' + t.fb + ';font-size:12px;line-height:1.6;color:' + t.foot + ';';
    const addr = b.addrAuto !== false
      ? (ctx.edit ? '<span style="font-style:italic;">Your mailing address is added when the email is sent.</span>' : '{{POSTAL_ADDRESS}}')
      : '<span' + ed(ctx, 'address', 'plain', 'Mailing address') + '>' + nl2br(b.address) + '</span>';
    return row(b, ctx,
      '<div style="' + s + 'font-weight:bold;"><span' + ed(ctx, 'name', 'line', 'Business name') + '>' + esc(b.name) + '</span>' +
      (b.places || ctx.edit ? ', <span' + ed(ctx, 'places', 'line', 'Locations') + '>' + esc(b.places) + '</span>' : '') + '</div>' +
      '<div style="' + s + '">' + addr + '</div>' +
      (b.note || ctx.edit ? '<div style="' + s + 'padding-top:10px;"' + ed(ctx, 'note', 'plain', 'Why they are getting this') + '>' + nl2br(b.note) + '</div>' : '') +
      '<div style="' + s + 'padding-top:10px;"><a href="{{UNSUBSCRIBE_URL}}" target="_blank" style="color:' + t.foot + ';text-decoration:underline;">Unsubscribe</a></div>',
      { align: 'center' });
  },
});

/* ---------- starters ---------- */
function mk(type, props) { return Object.assign({ id: uid(), type }, BLOCKS[type].make(), props || {}); }
const THEME = (preset) => ({ preset, font: 'classic', radius: 'soft' });
const STARTERS = {
  weekly: { label: 'Weekly newsletter', subject: 'This week at GREYS', desc: 'A big photo, the cheese of the week and what is coming up.', make: () => ({ v: 1, theme: THEME('navy'),
    preheader: 'This week at GREYS: a new cheese to try and a seat at the table.', blocks: [
      mk('logo'),
      mk('image', { src: ASSETS + 'hero-spread.jpg', alt: 'A spread of cheese, charcuterie and fruit', full: true, pt: 12, pb: 0 }),
      mk('heading', { text: 'This week at GREYS', size: 'l', pt: 28 }),
      mk('text', { html: '<p>Here is what is on the counter, what is coming up, and what we cannot stop eating.</p>' }),
      mk('cheese'), mk('event'),
      mk('button', { label: 'Order for pickup', href: LINKS.order, pt: 16, pb: 32 }),
      mk('footer')] }) },
  promo: { label: 'Sale or coupon', subject: '10% off every cheeseboard this week', desc: 'An offer with a code and your prices.', make: () => ({ v: 1, theme: THEME('navy'),
    preheader: 'This week only: 10% off every cheeseboard, online orders.', blocks: [
      mk('logo'),
      mk('heading', { text: '10% off every cheeseboard', size: 'l', align: 'center', pt: 20 }),
      mk('image', { src: ASSETS + 'board-close.jpg', alt: 'A close-up of a GREYS cheeseboard', pt: 20 }),
      mk('promo'), mk('prices', { pb: 28 }), mk('footer')] }) },
  class: { label: 'Class or event', subject: 'Grab a seat at our next class', desc: 'Sell seats for a class, a tasting or a dinner.', make: () => ({ v: 1, theme: THEME('white'),
    preheader: 'Grab a seat at our next class before it fills up.', blocks: [
      mk('logo'),
      mk('image', { src: ASSETS + 'event.jpg', alt: 'Guests at a GREYS cheese class', full: true, pt: 12, pb: 0 }),
      mk('event', { pt: 28 }),
      mk('text', { html: '<p>Classes are small, hands-on and come with plenty to taste. Bring a friend, or come meet some new ones.</p>' }),
      mk('button', { label: 'See all classes', href: LINKS.tickets, style: 'outline', pb: 32 }),
      mk('footer')] }) },
  note: { label: 'Note from the owners', subject: 'A note from Jackie and Kurt', desc: 'A personal letter with a photo and a cheese to try.', make: () => ({ v: 1, theme: THEME('rind'),
    preheader: 'A few words from the shop.', blocks: [
      mk('logo'), mk('note'),
      mk('image', { src: ASSETS + 'table-wide.jpg', alt: 'A long table set for a GREYS dinner', pt: 8 }),
      mk('cheese', { pb: 28 }), mk('footer')] }) },
  blank: { label: 'Start from scratch', subject: '', desc: 'Your logo, a heading, some text and the footer.', make: () => ({ v: 1, theme: THEME('white'),
    preheader: '', blocks: [mk('logo'), mk('heading'), mk('text'), mk('footer')] }) },
};

function normalize(design) {
  let d = design && typeof design === 'object' && Array.isArray(design.blocks) ? clone(design) : STARTERS.blank.make();
  d.v = 1;
  d.theme = Object.assign(THEME('navy'), d.theme || {});
  if (!PRESETS[d.theme.preset]) d.theme.preset = 'navy';
  d.preheader = String(d.preheader || '');
  const seen = new Set();
  let blocks = d.blocks.filter((b) => b && BLOCKS[b.type]).map((b) => {
    const nb = Object.assign(BLOCKS[b.type].make(), b);
    if (!nb.id || seen.has(nb.id)) nb.id = uid();
    seen.add(nb.id);
    return nb;
  });
  const foot = blocks.find((b) => b.type === 'footer') || mk('footer');
  blocks = blocks.filter((b) => b.type !== 'footer');
  blocks.push(foot);
  d.blocks = blocks;
  return d;
}

/* ---------- compile ---------- */
const BASE_CSS = 'body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}' +
  'img{-ms-interpolation-mode:bicubic;}a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}';
const MOBILE_CSS = '@media only screen and (max-width:620px){.eb-w{width:100%!important;max-width:100%!important;}.eb-outer{padding:0!important;}.eb-card{border-radius:0!important;}' +
  '.eb-px{padding-left:20px!important;padding-right:20px!important;}.eb-col{display:block!important;width:100%!important;max-width:100%!important;padding-left:0!important;padding-right:0!important;}' +
  '.eb-col-a{padding-bottom:16px!important;}.eb-col img{width:100%!important;max-width:100%!important;height:auto!important;}.eb-h36{font-size:30px!important;}.eb-h28{font-size:24px!important;}}';
const EDIT_CSS = 'body{min-height:100vh;}[data-eb-edit]{outline:none;cursor:text;}[data-eb-edit]:empty:before{content:attr(data-eb-ph);opacity:.45;}' +
  '[data-eb-edit]:focus{box-shadow:0 0 0 2px rgba(224,162,28,.35);border-radius:2px;}[data-eb-img]{cursor:pointer;}img[data-eb-img]:hover,.eb-ph:hover{filter:brightness(.93);}' +
  '#eb-hover,#eb-sel{position:absolute;pointer-events:none;z-index:50;display:none;border-radius:2px;}#eb-hover{box-shadow:inset 0 0 0 1px rgba(224,162,28,.9);}' +
  '#eb-sel{box-shadow:inset 0 0 0 2px #E0A21C;}#eb-tag{position:absolute;z-index:61;display:none;transform:translateY(-100%);background:#E0A21C;color:#161a1f;' +
  'font:700 11px/1 Inter,Arial,sans-serif;padding:5px 8px;border-radius:5px 5px 0 0;pointer-events:none;white-space:nowrap;}#eb-tag.in{transform:none;border-radius:0 0 5px 0;}' +
  '#eb-tools{position:absolute;z-index:62;display:none;gap:2px;transform:translate(-100%,-100%);background:#161a1f;border-radius:7px 7px 0 7px;padding:3px;box-shadow:0 4px 14px rgba(0,0,0,.25);}' +
  '#eb-tools.in{transform:translate(-100%,4px);margin-left:-4px;border-radius:7px;}#eb-tools button,#eb-fmt button{width:28px;height:28px;border:0;border-radius:5px;background:transparent;color:#fff;' +
  'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font:700 14px Georgia,serif;}#eb-tools button:hover,#eb-fmt button:hover,#eb-fmt button.on{background:rgba(255,255,255,.16);}' +
  '#eb-tools button:disabled{opacity:.3;cursor:default;background:transparent;}#eb-tools button[data-eb-tool=drag]{cursor:grab;}#eb-fmt .ic{display:contents;}#eb-drop{position:absolute;z-index:70;height:4px;margin-top:-2px;background:#E0A21C;border-radius:2px;display:none;pointer-events:none;box-shadow:0 0 0 2px rgba(255,255,255,.85);}' +
  '#eb-drop span{position:absolute;left:50%;top:-11px;transform:translateX(-50%);background:#E0A21C;color:#161a1f;font:700 11px/1 Inter,Arial,sans-serif;padding:6px 10px;border-radius:12px;white-space:nowrap;}' +
  '#eb-plus{position:absolute;z-index:63;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid #fff;background:#E0A21C;color:#161a1f;padding:0;cursor:pointer;display:none;' +
  'align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.25);}#eb-fmt{position:absolute;z-index:80;display:none;align-items:center;gap:2px;background:#161a1f;border-radius:7px;padding:3px;' +
  'box-shadow:0 4px 14px rgba(0,0,0,.25);}#eb-fmt .lk{display:none;align-items:center;gap:4px;padding-left:4px;}#eb-fmt.link .lk{display:flex;}#eb-fmt.link .ic{display:none;}' +
  '#eb-fmt input{width:210px;height:28px;border:0;border-radius:5px;padding:0 8px;font:13px Inter,Arial,sans-serif;}#eb-fmt .lk button{width:auto;padding:0 8px;font:600 12px Inter,Arial,sans-serif;}' +
  '.eb-empty td{padding:64px 32px!important;text-align:center;font:15px/1.5 Arial,sans-serif;opacity:.7;}';

function renderBlock(b, t, ctx) { return BLOCKS[b.type].render(b, t, ctx); }
function bodyStyle(t) { return 'margin:0;padding:0;background-color:' + t.bg + ';'; }
function bodyInner(d, t, ctx) {
  const body = d.blocks.filter((b) => b.type !== 'footer');
  const foot = d.blocks[d.blocks.length - 1];
  let rows = body.map((b) => renderBlock(b, t, ctx)).join('');
  if (!rows && ctx.edit) rows = '<tr class="eb-empty"><td style="color:' + t.text + ';">Drag blocks here from the left, or click one to add it.</td></tr>';
  const pre = !ctx.edit && d.preheader
    ? '<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:' + t.bg + ';">' + esc(d.preheader) + '&#847;&zwnj;&nbsp;'.repeat(80) + '</div>'
    : '';
  return pre + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + t.bg + '" style="background-color:' + t.bg + ';"><tr><td align="center" class="eb-outer" style="padding:24px 12px;">' +
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    '<table role="presentation" class="eb-w eb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="' + t.body + '" style="width:600px;max-width:600px;border-collapse:separate;background-color:' +
    t.body + ';border-radius:' + t.r + 'px;overflow:hidden;"><tbody id="eb-body">' + rows + '</tbody></table>' +
    '<table role="presentation" class="eb-w" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tbody id="eb-foot">' + renderBlock(foot, t, ctx) + '</tbody></table>' +
    '<!--[if mso]></td></tr></table><![endif]--></td></tr></table>';
}
function compile(design, meta, opts) {
  meta = meta || {}; opts = opts || {};
  const ctx = { edit: !!opts.edit };
  const d = normalize(design);
  const t = themeOf(d);
  return '<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting">' +
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<title>' + esc(meta.subject || 'GREYS Fine Cheeses') + '</title>' +
    '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->' +
    '<style>' + BASE_CSS + MOBILE_CSS + (ctx.edit ? EDIT_CSS : '') + '</style></head><body style="' + bodyStyle(t) + '">' + bodyInner(d, t, ctx) + '</body></html>';
}

/* ---------- thumbnails (template grid, starter picker) ---------- */
function thumb(html) {
  return '<div class="eb-thumb"><iframe sandbox="" scrolling="no" tabindex="-1" aria-hidden="true" loading="lazy" srcdoc="' + esc(html || '') + '"></iframe></div>';
}
function fitThumbs(root) {
  (root || document).querySelectorAll('.eb-thumb').forEach((n) => {
    const f = n.querySelector('iframe');
    const w = n.clientWidth;
    if (!f || !w) return;
    const s = w / 640;
    f.style.transform = 'scale(' + s + ')';
    f.style.height = Math.ceil(n.clientHeight / s) + 'px';
  });
}

/* ---------- editor chrome: styles, icons, tile art ---------- */
const UI_CSS = `
.eb-lock,.eb-lock body{overflow:hidden!important}
.eb-root{position:fixed;inset:0;z-index:3000;display:flex;flex-direction:column;background:#e4e8ed;color:#161a1f;font:14px/1.45 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.eb-root *,.eb-modal *,.eb-pop *,.eb-toast *{box-sizing:border-box}
.eb-root button,.eb-modal button,.eb-pop button{font-family:inherit}
.eb-root button:focus-visible,.eb-modal button:focus-visible,.eb-pop button:focus-visible{outline:2px solid #E0A21C;outline-offset:1px}
.eb-top{height:56px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;background:#fff;border-bottom:1px solid #e3e6ea;position:relative;z-index:7}
.eb-name{font:600 15px Archivo,Inter,sans-serif;border:1px solid transparent;border-radius:6px;padding:6px 8px;min-width:80px;flex:0 1 300px;background:transparent;color:inherit}
.eb-name:hover{border-color:#e3e6ea}.eb-name:focus{outline:none;border-color:#06273a;background:#fff}
.eb-status{font-size:12px;color:#67717d;white-space:nowrap}
.eb-status.dirty{color:#8a5d00}
.eb-sp{flex:1}
.eb-btn{height:34px;padding:0 12px;border-radius:7px;border:1px solid #d5dae1;background:#fff;color:#161a1f;font:600 13px/1 Inter,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;text-decoration:none}
.eb-btn:hover{background:#f4f6f8}.eb-btn:disabled{opacity:.45;cursor:default;background:#fff}
.eb-btn.pri{background:#06273a;border-color:#06273a;color:#fff}.eb-btn.pri:hover{background:#0b3a55}.eb-btn.pri:disabled{background:#06273a}
.eb-btn.ghost{border-color:transparent;background:transparent}.eb-btn.ghost:hover{background:#f1f3f6}
.eb-btn.danger{color:#9b2c2c}
.eb-btn.sm{height:28px;padding:0 9px;font-size:12px}
.eb-ico{width:34px;padding:0}
.eb-seg{display:inline-flex;border:1px solid #d5dae1;border-radius:7px;overflow:hidden;background:#fff;flex:none}
.eb-seg button{height:32px;min-width:34px;padding:0 10px;border:0;border-right:1px solid #e3e6ea;background:transparent;font:600 12.5px Inter,sans-serif;color:#4c5560;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px}
.eb-seg button:last-child{border-right:0}.eb-seg button:hover{background:#f4f6f8}
.eb-seg button.on{background:#06273a;color:#fff}
.eb-seg.full{display:flex}.eb-seg.full button{flex:1}
.eb-checks{height:34px;padding:0 11px;border-radius:17px;border:1px solid #d5dae1;background:#fff;font:600 12.5px Inter,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.eb-checks.ok{color:#2f6f3e;background:#ebf5ee;border-color:#cfe5d5}.eb-checks.warn{color:#8a5d00;background:#fdf3dc;border-color:#f0d99c}.eb-checks.tip{color:#3a4f66;background:#eef3f8;border-color:#d6e0ea}
.eb-main{flex:1;display:flex;min-height:0;position:relative}
.eb-left{width:264px;flex:none;background:#fff;border-right:1px solid #e3e6ea;display:flex;flex-direction:column;min-height:0}
.eb-right{width:308px;flex:none;background:#fff;border-left:1px solid #e3e6ea;display:flex;flex-direction:column;min-height:0}
.eb-tabs{display:flex;align-items:center;gap:4px;padding:6px 12px 0;border-bottom:1px solid #e3e6ea;flex:none}
.eb-tabs>button{flex:1;height:40px;border:0;background:none;font:600 13px Inter,sans-serif;color:#67717d;border-bottom:2px solid transparent;cursor:pointer}
.eb-tabs>button.on{color:#161a1f;border-bottom-color:#E0A21C}
.eb-scroll{flex:1;overflow:auto;padding:14px 14px 28px;overscroll-behavior:contain}
.eb-group{font:600 12px Inter,sans-serif;color:#67717d;margin:2px 2px 8px}
.eb-tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}
.eb-tile{border:1px solid #e3e6ea;border-radius:8px;background:#fff;padding:7px 7px 8px;cursor:grab;text-align:left;font:600 12px/1.25 Inter,sans-serif;color:#161a1f;display:flex;flex-direction:column;gap:6px;user-select:none;-webkit-user-select:none}
.eb-tile:hover{border-color:#d4ad55;box-shadow:0 2px 8px rgba(22,26,31,.08)}
.eb-tile:active{cursor:grabbing}
.eb-tile svg{width:100%;height:auto;display:block;border-radius:4px;background:#f3f5f7}
.eb-note{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#fdf3dc;border:1px solid #f0d99c;font-size:12.5px;line-height:1.45;display:flex;gap:8px;align-items:center;justify-content:space-between}
.eb-note.info{background:#eef3f8;border-color:#d6e0ea;display:block}
.eb-center{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;align-items:center;overflow:hidden}
.eb-fwrap{flex:1;width:100%;max-width:100%;display:flex;min-height:0;transition:max-width .2s ease,padding .2s ease}
.eb-fwrap.phone{max-width:394px;padding:20px 0}
.eb-frame{flex:1;border:0;width:100%;height:100%;background:transparent;display:block}
.eb-fwrap.phone .eb-frame{border-radius:30px;box-shadow:0 0 0 10px #1d232b,0 18px 40px rgba(0,0,0,.25);background:#fff}
.eb-banner{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:4;max-width:calc(100% - 24px);padding:10px 12px;border-radius:9px;background:#fff;border:1px solid #f0d99c;box-shadow:0 6px 20px rgba(22,26,31,.14);font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.eb-ihead{display:flex;align-items:center;gap:6px;padding:10px 12px 10px 14px;border-bottom:1px solid #e3e6ea;min-height:56px;flex:none}
.eb-ihead h3{margin:0;font:600 15px Archivo,Inter,sans-serif;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eb-f{margin:0 0 15px}
.eb-f>label,.eb-lab{display:block;font:600 12.5px Inter,sans-serif;color:#3a424c;margin:0 0 6px}
.eb-in{width:100%;height:36px;border:1px solid #d5dae1;border-radius:7px;padding:0 10px;font:14px Inter,sans-serif;color:#161a1f;background:#fff}
textarea.eb-in{height:auto;padding:8px 10px;resize:vertical;line-height:1.45;min-height:60px}
textarea.eb-in.code{font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;min-height:180px}
.eb-in:focus{outline:none;border-color:#06273a;box-shadow:0 0 0 3px rgba(6,39,58,.12)}
.eb-in.bad{border-color:#c0504d}
.eb-hint{font-size:12px;color:#67717d;margin-top:5px;line-height:1.45}
.eb-hint.bad{color:#9b2c2c}
.eb-count{float:right;font-weight:500;color:#8a929c}.eb-count.over{color:#9b2c2c}
.eb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.eb-chip{height:26px;padding:0 9px;border-radius:13px;border:1px solid #e3e6ea;background:#f6f7f9;font:600 11.5px Inter,sans-serif;color:#3a424c;cursor:pointer}
.eb-chip:hover{border-color:#d4ad55}
.eb-imgf{display:flex;gap:10px;align-items:center}
.eb-imgf .pv{width:76px;height:56px;border-radius:6px;background:#eef1f5 center/cover no-repeat;border:1px solid #e3e6ea;flex:none;display:flex;align-items:center;justify-content:center;color:#8a929c;font-size:11px}
.eb-imgf .acts{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.eb-range{display:flex;align-items:center;gap:10px}.eb-range input{flex:1;accent-color:#06273a;min-width:0}
.eb-range output{font:600 12px Inter,sans-serif;color:#3a424c;min-width:42px;text-align:right}
.eb-tog{display:flex;align-items:center;justify-content:space-between;gap:10px;font:600 12.5px Inter,sans-serif;color:#3a424c;cursor:pointer}
.eb-tog input{appearance:none;-webkit-appearance:none;width:36px;height:20px;border-radius:10px;background:#cfd5dc;position:relative;cursor:pointer;transition:background .15s;flex:none;margin:0}
.eb-tog input:before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.eb-tog input:checked{background:#06273a}.eb-tog input:checked:before{transform:translateX(16px)}
.eb-tog input:focus-visible{outline:2px solid #E0A21C;outline-offset:2px}
.eb-color{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.eb-color .nm{flex:1;font-size:12.5px;color:#3a424c}
.eb-color input[type=color]{width:30px;height:30px;padding:2px;border:1px solid #d5dae1;border-radius:7px;background:#fff;cursor:pointer;flex:none}
.eb-color .eb-in{width:86px;height:30px;flex:none;font:12.5px ui-monospace,Menlo,monospace;padding:0 7px}
.eb-rows .r{border:1px solid #e3e6ea;border-radius:8px;padding:8px;margin-bottom:8px;display:grid;gap:6px;background:#fafbfc}
.eb-rows .ctl{display:flex;gap:4px;justify-content:flex-end}
.eb-mini{height:26px;min-width:26px;padding:0 6px;border:1px solid #e3e6ea;border-radius:6px;background:#fff;cursor:pointer;font:600 12px Inter,sans-serif;color:#3a424c;display:inline-flex;align-items:center;justify-content:center}
.eb-mini:hover{background:#f4f6f8}.eb-mini:disabled{opacity:.4;cursor:default}
details.eb-more{border-top:1px solid #e3e6ea;margin-top:4px;padding-top:12px}
details.eb-more summary{font:600 12.5px Inter,sans-serif;color:#3a424c;cursor:pointer;margin-bottom:12px}
.eb-presets,.eb-fonts{display:grid;gap:8px;margin-bottom:20px}
.eb-preset,.eb-font{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e3e6ea;border-radius:8px;background:#fff;cursor:pointer;text-align:left;color:#161a1f}
.eb-preset:hover,.eb-font:hover{border-color:#d4ad55}
.eb-preset.on,.eb-font.on{border-color:#06273a;box-shadow:0 0 0 2px rgba(6,39,58,.14)}
.eb-preset span,.eb-font span{font:600 13px Inter,sans-serif}
.eb-sw{display:flex;border-radius:5px;overflow:hidden;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.08)}.eb-sw i{width:13px;height:28px;display:block}
.eb-font b{font-size:21px;width:32px;flex:none;font-weight:normal}
.eb-font small{display:block;font:12px Inter,sans-serif;color:#67717d}
.eb-link{background:none;border:0;padding:0;color:#06273a;font:600 12.5px Inter,sans-serif;text-decoration:underline;cursor:pointer}
.eb-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(16px);opacity:0;z-index:3300;background:#161a1f;color:#fff;padding:10px 14px;border-radius:8px;font:600 13px/1.4 Inter,sans-serif;transition:opacity .18s,transform .18s;pointer-events:none;max-width:min(520px,92vw);display:flex;gap:12px;align-items:center}
.eb-toast.on{opacity:1;transform:translateX(-50%)}.eb-toast.err{background:#9b2c2c}
.eb-toast button{background:none;border:0;color:#F2C230;font:700 13px Inter,sans-serif;cursor:pointer;padding:0}
.eb-pop{position:fixed;z-index:3200;background:#fff;border:1px solid #e3e6ea;border-radius:10px;box-shadow:0 12px 32px rgba(22,26,31,.18);padding:14px;width:330px;max-width:calc(100vw - 16px);font:14px/1.45 Inter,sans-serif;color:#161a1f}
.eb-pop h4{margin:0 0 10px;font:600 14px Archivo,Inter,sans-serif}
.eb-pop .row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.eb-clist{list-style:none;margin:0;padding:0;max-height:300px;overflow:auto}
.eb-clist li{display:flex;gap:9px;align-items:flex-start;padding:8px 6px;border-radius:7px;cursor:pointer;font-size:13px;line-height:1.4}
.eb-clist li:hover{background:#f4f6f8}
.eb-clist i{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none;background:#8fa3b8}.eb-clist i.warn{background:#d39b12}
.eb-modal{position:fixed;inset:0;z-index:3100;background:rgba(14,18,23,.48);display:flex;align-items:center;justify-content:center;padding:16px;font:14px/1.45 Inter,sans-serif;color:#161a1f}
.eb-dlg{background:#fff;border-radius:12px;width:min(780px,100%);max-height:min(680px,92vh);display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.eb-dlg.narrow{width:min(440px,100%)}
.eb-dlg header{display:flex;align-items:center;gap:10px;padding:12px 12px 12px 18px;border-bottom:1px solid #e3e6ea;flex:none}
.eb-dlg header h3{margin:0;flex:1;font:600 16px Archivo,Inter,sans-serif}
.eb-dlg .bd{padding:16px 18px;overflow:auto;flex:1}
.eb-dlg footer{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #e3e6ea;flex:none;flex-wrap:wrap}
.eb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px}
.eb-grid button{aspect-ratio:4/3;border:1px solid #e3e6ea;border-radius:8px;background:#eef1f5 center/cover no-repeat;cursor:pointer;padding:0}
.eb-grid button:hover{outline:2px solid #E0A21C;outline-offset:1px}
.eb-dropz{border:2px dashed #cfd5dc;border-radius:10px;padding:38px 16px;text-align:center;color:#4c5560;cursor:pointer;display:block}
.eb-dropz.on{border-color:#E0A21C;background:#fdf8ec}
.eb-dropz b{display:block;font:600 15px Archivo,Inter,sans-serif;color:#161a1f;margin-bottom:4px}
.eb-starters{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
.eb-starter{border:1px solid #e3e6ea;border-radius:10px;background:#fff;padding:10px;cursor:pointer;text-align:left;color:#161a1f}
.eb-starter:hover{border-color:#d4ad55;box-shadow:0 4px 14px rgba(22,26,31,.1)}
.eb-starter b{display:block;font:600 14px Archivo,Inter,sans-serif;margin:10px 2px 2px}.eb-starter span{display:block;font-size:12.5px;line-height:1.4;color:#67717d;margin:0 2px}
.eb-thumb{position:relative;overflow:hidden;aspect-ratio:4/5;background:#eef1f5;border-radius:7px}
.eb-thumb iframe{position:absolute;left:0;top:0;width:640px;height:800px;border:0;transform-origin:0 0;pointer-events:none}
.eb-bbar,.eb-sheet-x,.eb-show-s{display:none}
@media (max-width:899px){
  .eb-top{height:52px;gap:4px;padding:0 6px}
  .eb-hide-s{display:none!important}
  .eb-show-s{display:inline-flex}
  .eb-name{flex:1;min-width:0;font-size:14px;padding:6px 4px}
  .eb-left,.eb-right{position:fixed;left:0;right:0;bottom:58px;width:auto;max-height:64vh;border:0;border-top:1px solid #e3e6ea;border-radius:14px 14px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.16);z-index:8;transform:translateY(calc(100% + 70px));transition:transform .22s ease;visibility:hidden}
  .eb-root.sheet-left .eb-left,.eb-root.sheet-right .eb-right{transform:none;visibility:visible}
  .eb-sheet-x{display:inline-flex}
  .eb-bbar{display:flex;height:58px;flex:none;background:#fff;border-top:1px solid #e3e6ea;z-index:9;position:relative;padding-bottom:env(safe-area-inset-bottom)}
  .eb-bbar button{flex:1;border:0;background:none;font:600 11px Inter,sans-serif;color:#67717d;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer}
  .eb-bbar button.on{color:#06273a}.eb-bbar button.dot svg{color:#E0A21C}
  .eb-fwrap,.eb-fwrap.phone{max-width:100%;padding:0}.eb-fwrap.phone .eb-frame{border-radius:0;box-shadow:none}
  .eb-tiles{grid-template-columns:repeat(3,1fr)}
  .eb-banner{top:8px}
  .eb-dlg{max-height:94vh}
}
`;
const ICONS = {
  back: '<path d="M10 3L5 8l5 5"/>',
  undo: '<path d="M6 3.5L2.5 7 6 10.5"/><path d="M2.5 7h7a3.5 3.5 0 010 7H7"/>',
  redo: '<path d="M10 3.5L13.5 7 10 10.5"/><path d="M13.5 7h-7a3.5 3.5 0 000 7H9"/>',
  desktop: '<rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7.3 12.4h1.4"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V4a1.5 1.5 0 011.5-1.5H11"/>',
  trash: '<path d="M2.5 4.5h11M6.3 4.5V2.8h3.4v1.7M4.2 4.5l.6 9h6.4l.6-9"/>',
  drag: '<path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01" stroke-width="2.6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  warn: '<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3M8 11.6h.01"/>',
  send: '<path d="M14 2L7.2 8.8M14 2l-4.4 12-2.4-5.2L2 6.4z"/>',
  link: '<path d="M6.6 9.4l2.8-2.8M7.2 4.7l.9-.9a2.8 2.8 0 014 4l-.9.9M8.8 11.3l-.9.9a2.8 2.8 0 01-4-4l.9-.9"/>',
  list: '<path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.8 4h.01M2.8 8h.01M2.8 12h.01" stroke-width="1.7"/>',
  add: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M11.5 9v5M9 11.5h5"/>',
  brush: '<path d="M13.5 2.5L7 9"/><path d="M7 9c-1.8-.4-3.6 1-3.6 2.8 0 .9-.5 1.5-1.4 1.7 1 .8 2.6 1 3.8.4C7.2 13.2 7.9 11 7 9z"/>',
  sliders: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4" fill="#fff"/><circle cx="10.5" cy="8" r="1.4" fill="#fff"/><circle cx="5" cy="12" r="1.4" fill="#fff"/>',
  photo: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 11l3.8-3.6 3 2.7 2-1.8 4.2 3.7"/><circle cx="11" cy="5.8" r="1.1"/>',
  aleft: '<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>',
  acenter: '<path d="M2.5 4h11M4.5 8h7M3.5 12h9"/>',
  aright: '<path d="M2.5 4h11M6.5 8h7M4.5 12h9"/>',
};
const ico = (n, s) => '<svg viewBox="0 0 16 16" width="' + (s || 16) + '" height="' + (s || 16) + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';

/* little wireframes for the Add tiles (120 x 64) */
const NAVY = '#3E4C63', INK = '#1e2a38', GREY = '#c6ccd4', PALE = '#dde2e8', GOLDT = '#E0A21C';
const bar = (x, y, w, h, c) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (h || 4) + '" rx="' + Math.min(2, (h || 4) / 2) + '" fill="' + (c || GREY) + '"/>';
const pic = (x, y, w, h) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" fill="#b9c6d4"/><path d="M' + (x + 4) + ' ' + (y + h - 4) + 'l' + (w * 0.3) + ' ' + (-h * 0.4) + 'l' + (w * 0.22) + ' ' + (h * 0.26) + 'l' + (w * 0.14) + ' ' + (-h * 0.14) + 'l' + (w * 0.26) + ' ' + (h * 0.28) + 'z" fill="#9aabbe"/>';
const TILE_ART = {
  logo: '<text x="60" y="34" text-anchor="middle" font-family="Arial" font-weight="700" font-size="15" letter-spacing="2" fill="' + INK + '">GREYS</text>' + bar(42, 40, 36, 3, GOLDT),
  heading: bar(14, 22, 84, 9, INK) + bar(14, 36, 56, 9, INK),
  text: bar(14, 16, 92) + bar(14, 25, 88) + bar(14, 34, 92) + bar(14, 43, 60),
  image: pic(14, 10, 92, 44),
  button: '<rect x="30" y="21" width="60" height="22" rx="5" fill="' + GOLDT + '"/>' + bar(44, 30, 32, 4, INK),
  columns: pic(10, 12, 46, 40) + bar(62, 16, 44, 6, INK) + bar(62, 27, 46) + bar(62, 35, 40) + '<rect x="62" y="43" width="26" height="9" rx="3" fill="' + GOLDT + '"/>',
  images2: pic(10, 14, 48, 36) + pic(62, 14, 48, 36),
  cheese: '<rect x="20" y="5" width="80" height="54" rx="4" fill="' + PALE + '"/>' + pic(20, 5, 80, 22) + bar(27, 31, 30, 3, GOLDT) + bar(27, 37, 50, 6, INK) + bar(27, 46, 44, 3) + '<rect x="27" y="51" width="22" height="5" rx="2" fill="' + GOLDT + '"/>',
  event: '<rect x="14" y="14" width="22" height="26" rx="4" fill="' + GOLDT + '"/>' + bar(19, 19, 12, 3, INK) + bar(18, 26, 14, 8, INK) + bar(44, 15, 54, 6, INK) + bar(44, 25, 40, 3, GOLDT) + bar(44, 33, 60) + bar(44, 40, 50) + '<rect x="44" y="47" width="24" height="8" rx="3" fill="' + GOLDT + '"/>',
  promo: '<rect x="14" y="8" width="92" height="48" rx="4" fill="none" stroke="' + GOLDT + '" stroke-width="2" stroke-dasharray="4 3"/>' + bar(42, 15, 36, 3, GOLDT) + bar(28, 22, 64, 7, INK) + '<rect x="40" y="35" width="40" height="12" rx="3" fill="' + PALE + '"/>' + bar(48, 39, 24, 4, INK),
  prices: bar(14, 10, 40, 6, INK) + [20, 33, 46].map((y, i) => bar(14, y, 46, 4, INK) + bar(92, y, 14, 4, GOLDT) + (i < 2 ? '<rect x="14" y="' + (y + 9) + '" width="92" height="1" fill="' + PALE + '"/>' : '')).join(''),
  note: bar(14, 10, 92) + bar(14, 18, 88) + bar(14, 26, 92) + bar(14, 34, 50) + '<path d="M16 50c6-8 10 6 16-2s8 4 14-3" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>',
  social: bar(16, 30, 24, 4, GOLDT) + bar(48, 30, 26, 4, GOLDT) + bar(82, 30, 22, 4, GOLDT),
  divider: '<rect x="14" y="31" width="92" height="2" fill="' + GREY + '"/>',
  spacer: '<path d="M60 14v36M54 20l6-6 6 6M54 44l6 6 6-6" fill="none" stroke="' + GREY + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  html: '<text x="60" y="38" text-anchor="middle" font-family="Menlo,monospace" font-weight="700" font-size="16" fill="' + NAVY + '">&lt;/&gt;</text>',
};
const tileSvg = (type) => '<svg viewBox="0 0 120 64" aria-hidden="true">' + (TILE_ART[type] || '') + '</svg>';

/* tiny DOM builder */
function el(tag, props, kids) {
  const n = document.createElement(tag);
  if (props) Object.keys(props).forEach((k) => {
    const v = props[k];
    if (v == null || v === false) return;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  [].concat(kids == null ? [] : kids).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}
const btnEl = (cls, html, title, onclick, extra) => el('button', Object.assign({ type: 'button', class: cls, html, title, 'aria-label': title, onclick }, extra || {}));
const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
const isField = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
function injectCss() {
  if (document.getElementById('eb-css')) return;
  document.head.appendChild(el('style', { id: 'eb-css', text: UI_CSS }));
}

/* ---------- editor state ---------- */
let S = null;
const findBlock = (id) => (S && id ? S.design.blocks.find((b) => b.id === id) : null);
const bodyBlocks = () => S.design.blocks.slice(0, -1);
const snap = () => JSON.stringify({ name: S.name, subject: S.subject, design: S.design });
const draftKey = () => 'eb-draft:' + (S.id || 'new');
const FMT_HTML = '<span class="ic">' +
  '<button type="button" data-fmt="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>' +
  '<button type="button" data-fmt="italic" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button>' +
  '<button type="button" data-fmt="link" title="Link (Ctrl+K)" aria-label="Link">' + ico('link', 15) + '</button>' +
  '<button type="button" data-fmt="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">' + ico('list', 15) + '</button>' +
  '<button type="button" data-fmt="clear" title="Clear formatting" style="width:auto;padding:0 8px;font:600 12px Inter,Arial,sans-serif">Clear</button></span>' +
  '<span class="lk"><input type="url" placeholder="Paste or type a link" aria-label="Link address">' +
  '<button type="button" data-fmt="apply">Add link</button><button type="button" data-fmt="unlink">Remove</button>' +
  '<button type="button" data-fmt="cancel" aria-label="Cancel" style="width:28px">' + ico('x', 13) + '</button></span>';

function open(opts) {
  injectCss();
  if (S) teardown(false);
  opts = opts || {};
  const st = opts.design ? null : STARTERS[opts.starter] || STARTERS.weekly;
  const start = opts.design || st.make();
  S = {
    opts, id: opts.id || null, name: opts.name || (st && opts.starter !== 'blank' ? st.label : 'Untitled email'),
    subject: opts.subject || (st ? st.subject : ''),
    design: normalize(start), sel: null, hover: null, plusIdx: null, insertAt: null, drag: null, dropIdx: null, link: null,
    view: 'desktop', tab: 'add', sheet: null, undo: [], redo: [], lastKey: '', lastAt: 0, saving: false, checks: [],
    doc: null, ui: null, timers: {},
  };
  if (opts.preheader && !S.design.preheader) S.design.preheader = String(opts.preheader);
  S.saved = S.id ? snap() : '';
  buildChrome();
  renderLeft(); renderRight(); updateTop();
  loadFrame();
  document.documentElement.classList.add('eb-lock');
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onWinResize);
  setTimeout(checkDraft, 250);
  scheduleChecks();
}

function buildChrome() {
  const nameIn = el('input', { class: 'eb-name', value: S.name, 'aria-label': 'Template name', maxlength: '120', spellcheck: 'false' });
  nameIn.addEventListener('input', () => { commit('name'); S.name = nameIn.value; changed(); });
  const dev = el('div', { class: 'eb-seg eb-hide-s', role: 'group', 'aria-label': 'Preview size' }, [
    btnEl('on', ico('desktop'), 'Desktop preview', () => setView('desktop'), { 'data-view': 'desktop' }),
    btnEl('', ico('phone'), 'Phone preview', () => setView('phone'), { 'data-view': 'phone' }),
  ]);
  const top = el('div', { class: 'eb-top' }, [
    btnEl('eb-btn ghost', ico('back') + '<span class="eb-hide-s">Templates</span>', 'Back to templates', requestClose),
    nameIn,
    el('span', { class: 'eb-status eb-hide-s', 'aria-live': 'polite' }),
    el('span', { class: 'eb-sp' }),
    btnEl('eb-btn ghost eb-ico eb-hide-s', ico('undo'), 'Undo (Ctrl+Z)', undo, { 'data-act': 'undo' }),
    btnEl('eb-btn ghost eb-ico eb-hide-s', ico('redo'), 'Redo (Ctrl+Shift+Z)', redo, { 'data-act': 'redo' }),
    dev,
    btnEl('eb-checks', '', 'Things to check before sending', (e) => openChecks(e.currentTarget), { 'data-act': 'checks' }),
    btnEl('eb-btn eb-hide-s', ico('send') + 'Send test', 'Send a test email', (e) => openTest(e.currentTarget), { 'data-act': 'test' }),
    btnEl('eb-btn pri', 'Save', 'Save (Ctrl+S)', () => save(), { 'data-act': 'save' }),
  ]);
  const left = el('aside', { class: 'eb-left', 'aria-label': 'Add blocks and style' });
  const frame = el('iframe', { class: 'eb-frame', title: 'Email being edited' });
  const fwrap = el('div', { class: 'eb-fwrap' }, frame);
  const center = el('div', { class: 'eb-center' }, fwrap);
  const right = el('aside', { class: 'eb-right', 'aria-label': 'Block settings' });
  const bbar = el('nav', { class: 'eb-bbar', 'aria-label': 'Editor' },
    [['add', 'add', 'Add'], ['design', 'brush', 'Style'], ['edit', 'sliders', 'Edit'], ['test', 'send', 'Test']].map(([k, i, label]) =>
      el('button', { type: 'button', 'data-sheet': k, html: ico(i, 20) + label, onclick: (e) => bbarTap(k, e.currentTarget) })));
  const root = el('div', { class: 'eb-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Email editor' }, [top, el('div', { class: 'eb-main' }, [left, center, right]), bbar]);
  document.body.appendChild(root);
  Object.assign(S, { root, top, nameIn, left, right, center, fwrap, frame, bbar });
}

function setView(v) {
  S.view = v;
  S.fwrap.classList.toggle('phone', v === 'phone');
  S.top.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  setTimeout(() => S && refreshUI(), 260);
}
function bbarTap(k, btn) {
  if (k === 'test') { setSheet(null); openTest(btn); return; }
  if (k === 'add' || k === 'design') {
    const same = S.sheet === 'left' && S.tab === k;
    S.tab = k; renderLeft(); setSheet(same ? null : 'left');
  } else setSheet(S.sheet === 'right' ? null : 'right');
}
function setSheet(s) {
  S.sheet = s;
  S.root.classList.toggle('sheet-left', s === 'left');
  S.root.classList.toggle('sheet-right', s === 'right');
  updateBbar();
}
function updateBbar() {
  S.bbar.querySelectorAll('button').forEach((b) => {
    const k = b.dataset.sheet;
    b.classList.toggle('on', (k === 'edit' && S.sheet === 'right') || ((k === 'add' || k === 'design') && S.sheet === 'left' && S.tab === k));
    b.classList.toggle('dot', k === 'edit' && !!S.sel && S.sheet !== 'right');
  });
}
function updateTop() {
  if (!S) return;
  S.dirty = snap() !== S.saved;
  const st = S.top.querySelector('.eb-status');
  st.textContent = S.saving ? 'Saving...' : S.dirty ? (S.id ? 'Unsaved changes' : 'Not saved yet') : 'All changes saved';
  st.classList.toggle('dirty', S.dirty && !S.saving);
  S.top.querySelector('[data-act=undo]').disabled = !S.undo.length;
  S.top.querySelector('[data-act=redo]').disabled = !S.redo.length;
  S.top.querySelector('[data-act=save]').disabled = S.saving;
}

/* ---------- changes and undo ---------- */
function commit(key) {
  const now = Date.now();
  if (key && key === S.lastKey && now - S.lastAt < 1500) { S.lastAt = now; return; }
  S.undo.push(snap());
  if (S.undo.length > 150) S.undo.shift();
  S.redo = []; S.lastKey = key || ''; S.lastAt = now;
}
function changed() { updateTop(); scheduleDraft(); scheduleChecks(); }
function edit(key, fn, redraw) {
  commit(key); fn(); changed();
  if (redraw === 'all') renderBody();
  else if (redraw === 'theme') scheduleBody();
  else if (redraw) renderRow(redraw);
}
function undo() { if (!S || !S.undo.length) return; S.redo.push(snap()); restore(S.undo.pop()); }
function redo() { if (!S || !S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); }
function restore(json) {
  const o = JSON.parse(json);
  S.name = o.name; S.subject = o.subject; S.design = normalize(o.design); S.lastKey = '';
  if (S.sel && !findBlock(S.sel)) S.sel = null;
  S.nameIn.value = S.name;
  renderBody(); renderLeft(); renderRight(); changed();
}

/* ---------- canvas ---------- */
function loadFrame() {
  S.frame.addEventListener('load', () => {
    if (!S) return;
    S.doc = S.frame.contentDocument;
    wireDoc(); mountUI(); refreshUI();
  }, { once: true });
  S.frame.srcdoc = compile(S.design, { subject: S.subject }, { edit: true });
}
function renderBody() {
  const doc = S.doc;
  if (!doc) return;
  const w = doc.defaultView, y = w.scrollY, t = themeOf(S.design);
  doc.body.setAttribute('style', bodyStyle(t));
  doc.body.innerHTML = bodyInner(S.design, t, { edit: true });
  mountUI(); w.scrollTo(0, y); refreshUI();
}
function scheduleBody() {
  if (S.timers.body) return;
  S.timers.body = requestAnimationFrame(() => { if (!S) return; S.timers.body = 0; renderBody(); });
}
function renderRow(id) {
  const doc = S.doc;
  if (!doc) return;
  const b = findBlock(id), old = rowNode(id);
  if (!b || !old) { renderBody(); return; }
  const tpl = doc.createElement('template');
  tpl.innerHTML = renderBlock(b, themeOf(S.design), { edit: true });
  const n = tpl.content.firstElementChild;
  if (n) old.replaceWith(n);
  refreshUI();
}
function wireDoc() {
  const d = S.doc, w = d.defaultView;
  d.addEventListener('mousedown', onDocDown, true);
  d.addEventListener('click', onDocClick, true);
  d.addEventListener('mousemove', onDocMove);
  d.documentElement.addEventListener('mouseleave', () => { if (S && !S.drag) hoverRow(null); });
  d.addEventListener('input', (e) => { const n = e.target.closest && e.target.closest('[data-eb-edit]'); if (n) syncEditable(n); });
  d.addEventListener('focusin', onDocFocusIn);
  d.addEventListener('focusout', onDocFocusOut);
  d.addEventListener('paste', onDocPaste);
  d.addEventListener('keydown', onDocKey);
  d.addEventListener('dragstart', onDocDragStart);
  d.addEventListener('dragover', onDragOver, true);
  d.addEventListener('drop', onDrop, true);
  d.addEventListener('dragleave', (e) => { if (S && S.drag && !e.relatedTarget) showDrop(null); });
  d.addEventListener('dragend', () => { if (S && S.drag) endDrag(); });
  d.addEventListener('selectionchange', () => { if (S) placeFmt(); });
  w.addEventListener('resize', () => { if (S) refreshUI(); });
  if (w.ResizeObserver) new w.ResizeObserver(() => { if (S) refreshUI(); }).observe(d.body);
}
function mountUI() {
  const d = S.doc;
  const mkUi = (id, tag, html, attrs) => {
    const n = d.createElement(tag);
    n.id = id;
    if (html) n.innerHTML = html;
    if (attrs) Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
    d.body.appendChild(n);
    return n;
  };
  const tools = [['drag', 'drag', 'Drag to move'], ['up', 'up', 'Move up'], ['down', 'down', 'Move down'], ['dup', 'copy', 'Duplicate'], ['del', 'trash', 'Delete']]
    .map(([k, i, tl]) => '<button type="button" data-eb-tool="' + k + '" title="' + tl + '" aria-label="' + tl + '"' + (k === 'drag' ? ' draggable="true"' : '') + '>' + ico(i, 15) + '</button>').join('');
  S.ui = {
    hover: mkUi('eb-hover', 'div'), sel: mkUi('eb-sel', 'div'), tag: mkUi('eb-tag', 'div'),
    tools: mkUi('eb-tools', 'div', tools), drop: mkUi('eb-drop', 'div', '<span>Drop here</span>'),
    plus: mkUi('eb-plus', 'button', ico('plus', 14), { type: 'button', 'data-eb-tool': 'plus', title: 'Add a block here', 'aria-label': 'Add a block here' }),
    fmt: mkUi('eb-fmt', 'div', FMT_HTML),
  };
  S.link = null;
}
const rowNode = (id) => (id && S.doc ? S.doc.querySelector('[data-eb-id="' + id + '"]') : null);
function rectOf(n) {
  const r = n.getBoundingClientRect(), w = S.doc.defaultView;
  return { top: r.top + w.scrollY, left: r.left + w.scrollX, width: r.width, height: r.height };
}
function placeBox(node, id) {
  const n = rowNode(id);
  if (!n) { node.style.display = 'none'; return; }
  const r = rectOf(n);
  Object.assign(node.style, { display: 'block', top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
}
function refreshUI() {
  if (!S || !S.doc || !S.ui) return;
  const u = S.ui, n = rowNode(S.sel), b = findBlock(S.sel);
  placeBox(u.sel, S.sel);
  placeBox(u.hover, S.hover && S.hover !== S.sel ? S.hover : null);
  if (n && b) {
    const r = rectOf(n), inside = r.top < 36, list = bodyBlocks(), idx = list.findIndex((x) => x.id === S.sel);
    u.tag.textContent = BLOCKS[b.type].label;
    u.tag.classList.toggle('in', inside);
    Object.assign(u.tag.style, { display: 'block', top: r.top + 'px', left: r.left + 'px' });
    u.tools.classList.toggle('in', inside);
    Object.assign(u.tools.style, { display: BLOCKS[b.type].fixed ? 'none' : 'flex', top: r.top + 'px', left: r.left + r.width + 'px' });
    u.tools.querySelector('[data-eb-tool=up]').disabled = idx <= 0;
    u.tools.querySelector('[data-eb-tool=down]').disabled = idx >= list.length - 1;
  } else { u.tag.style.display = 'none'; u.tools.style.display = 'none'; }
  placePlus(); placeFmt();
  if (!S.drag) showDrop(S.insertAt, 'New block goes here');
}
function boundaryY(idx) {
  const rows = [...S.doc.querySelectorAll('#eb-body > [data-eb-id]')], w = S.doc.defaultView;
  if (!rows.length) { const r = S.doc.getElementById('eb-body').getBoundingClientRect(); return r.top + w.scrollY + r.height / 2; }
  if (idx < rows.length) return rows[idx].getBoundingClientRect().top + w.scrollY;
  return rows[rows.length - 1].getBoundingClientRect().bottom + w.scrollY;
}
function cardRect() { const c = S.doc.querySelector('.eb-card'); return c ? rectOf(c) : null; }
function showDrop(idx, label) {
  const u = S.ui;
  if (!u) return;
  const c = idx == null ? null : cardRect();
  if (!c) { u.drop.style.display = 'none'; return; }
  Object.assign(u.drop.style, { display: 'block', top: boundaryY(idx) + 'px', left: c.left + 'px', width: c.width + 'px' });
  u.drop.firstChild.textContent = label || 'Drop here';
}
function placePlus() {
  const u = S.ui;
  if (!u) return;
  const c = S.plusIdx == null || S.drag || S.insertAt != null || isPhone() ? null : cardRect();
  if (!c) { u.plus.style.display = 'none'; return; }
  Object.assign(u.plus.style, { display: 'flex', top: boundaryY(S.plusIdx) + 'px', left: c.left + c.width / 2 + 'px' });
}
function hoverRow(id, idx) {
  S.hover = id || null;
  S.plusIdx = id ? idx : null;
  if (!S.ui) return;
  placeBox(S.ui.hover, S.hover && S.hover !== S.sel ? S.hover : null);
  placePlus();
}

/* ---------- canvas events ---------- */
const elOf = (t) => (t && t.nodeType === 1 ? t : t && t.parentElement) || null;
function onDocDown(e) {
  if (POP) closePop();
  const t = elOf(e.target);
  if (t && t.closest('#eb-fmt button, #eb-plus, #eb-tools button:not([data-eb-tool=drag])')) e.preventDefault();
}
function onDocClick(e) {
  const tg = elOf(e.target);
  if (!tg) return;
  if (tg.closest('#eb-fmt')) { onFmtClick(e); return; }
  if (S.link) closeLink(true);
  const tool = tg.closest('[data-eb-tool]');
  if (tool) { e.preventDefault(); e.stopPropagation(); runTool(tool.dataset.ebTool); return; }
  if (tg.closest('a')) e.preventDefault();
  if (tg.closest('.eb-empty')) { S.tab = 'add'; renderLeft(); if (isPhone()) setSheet('left'); return; }
  const r = tg.closest('[data-eb-id]');
  if (!r) { select(null); return; }
  const id = r.dataset.ebId, imgSlot = tg.closest('[data-eb-img]');
  select(id);
  if (imgSlot) { e.preventDefault(); chooseImage(id, imgSlot.dataset.ebImg); }
}
function onDocMove(e) {
  if (!S || S.drag) return;
  const tg = elOf(e.target);
  if (!tg || tg.closest('#eb-plus,#eb-tools,#eb-tag,#eb-fmt')) return;
  const r = tg.closest('[data-eb-id]');
  if (!r) { if (S.hover) hoverRow(null); return; }
  const id = r.dataset.ebId, list = bodyBlocks(), i = list.findIndex((b) => b.id === id);
  let idx = list.length;
  if (i >= 0) { const rc = r.getBoundingClientRect(); idx = e.clientY < rc.top + rc.height / 2 ? i : i + 1; }
  if (id !== S.hover || idx !== S.plusIdx) hoverRow(id, idx);
}
function runTool(k) {
  if (k === 'plus') { startInsert(S.plusIdx); return; }
  const id = S.sel;
  if (!id) return;
  if (k === 'up') moveBy(id, -1);
  else if (k === 'down') moveBy(id, 1);
  else if (k === 'dup') duplicate(id);
  else if (k === 'del') removeBlock(id);
}
function startInsert(idx) {
  if (idx == null) return;
  S.insertAt = idx; S.tab = 'add';
  renderLeft(); refreshUI();
  if (isPhone()) setSheet('left');
}
function cancelInsert() { S.insertAt = null; renderLeft(); refreshUI(); }

function syncEditable(n) {
  const r = n.closest('[data-eb-id]'), b = r && findBlock(r.dataset.ebId);
  if (!b) return;
  const path = n.dataset.ebEdit, kind = n.dataset.ebKind;
  let v;
  if (kind === 'rich') v = cleanRich(n.innerHTML);
  else {
    v = (n.innerText || '').replace(/ /g, ' ').replace(/\n$/, '');
    if (kind === 'line') v = v.replace(/\s*\n\s*/g, ' ');
    if (!v && n.innerHTML === '<br>') n.innerHTML = '';
  }
  if (getPath(b, path) === v) return;
  commit('txt:' + b.id + ':' + path);
  setPath(b, path, v);
  changed();
  if (S.sel === b.id) {
    const inp = S.right.querySelector('[data-eb-key="' + path + '"]');
    if (inp && document.activeElement !== inp) inp.value = v;
  }
  refreshUI();
}
function onDocFocusIn(e) {
  const t = elOf(e.target), r = t && t.closest('[data-eb-id]');
  if (r && t.closest('[data-eb-edit]') && S.sel !== r.dataset.ebId) select(r.dataset.ebId);
  placeFmt();
}
function onDocFocusOut(e) {
  const t = elOf(e.target), n = t && t.closest('[data-eb-edit]'), r = n && n.closest('[data-eb-id]');
  if (!r) return;
  const id = r.dataset.ebId;
  S.lastKey = '';
  setTimeout(() => {
    if (!S || !S.doc) return;
    const a = S.doc.activeElement;
    if (a && a.closest && a.closest('#eb-fmt')) return;
    if (S.doc.hasFocus() && a && a.closest && a.closest('[data-eb-id="' + id + '"]')) return;
    renderRow(id);
  }, 0);
}
function onDocPaste(e) {
  const t = elOf(e.target), n = t && t.closest('[data-eb-edit]');
  if (!n) return;
  e.preventDefault();
  let text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (n.dataset.ebKind === 'line') text = text.replace(/\s*\n\s*/g, ' ');
  S.doc.execCommand('insertText', false, text);
}
function onDocKey(e) {
  const t = elOf(e.target);
  if (t && t.closest('#eb-fmt')) {
    if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeLink(); }
    return;
  }
  const n = t && t.closest('[data-eb-edit]');
  if (n) {
    const kind = n.dataset.ebKind, mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.key === 'Enter' && kind === 'line') { e.preventDefault(); return; }
    if (e.key === 'Enter' && kind === 'plain') { e.preventDefault(); S.doc.execCommand('insertLineBreak'); return; }
    if (mod && /^[biu]$/.test(k) && kind !== 'rich') { e.preventDefault(); return; }
    if (mod && k === 'k' && kind === 'rich') { e.preventDefault(); openLink(); return; }
    if (e.key === 'Escape') { e.preventDefault(); n.blur(); return; }
  }
  onKey(e);
}

/* ---------- text formatting bar ---------- */
function richHost() {
  const a = S.doc && S.doc.activeElement;
  return a && a.closest ? a.closest('[data-eb-kind="rich"]') : null;
}
function placeFmt() {
  const u = S.ui;
  if (!u) return;
  const host = S.link ? S.link.host : richHost();
  if (!host || !host.isConnected) {
    u.fmt.style.display = 'none'; u.fmt.classList.remove('link'); u.tag.style.visibility = '';
    if (S.link) S.link = null;
    return;
  }
  const r = rectOf(host);
  u.fmt.style.display = 'flex';
  u.fmt.style.top = Math.max(2, r.top - (u.fmt.offsetHeight || 34) - 8) + 'px';
  u.fmt.style.left = Math.max(4, r.left) + 'px';
  u.tag.style.visibility = 'hidden';
  if (!S.link) ['bold', 'italic', 'insertUnorderedList'].forEach((c) => {
    const b = u.fmt.querySelector('[data-fmt="' + c + '"]');
    try { b.classList.toggle('on', S.doc.queryCommandState(c)); } catch (_) { /* not supported */ }
  });
}
function onFmtClick(e) {
  const b = elOf(e.target).closest('button[data-fmt]');
  if (!b) return;
  e.preventDefault();
  const c = b.dataset.fmt, d = S.doc, host = richHost();
  if (c === 'link') { openLink(); return; }
  if (c === 'apply') { applyLink(); return; }
  if (c === 'unlink') { restoreRange(); d.execCommand('unlink'); afterExec(); closeLink(); return; }
  if (c === 'cancel') { restoreRange(); closeLink(); return; }
  if (!host) return;
  if (c === 'clear') { d.execCommand('removeFormat'); d.execCommand('unlink'); }
  else d.execCommand(c);
  afterExec(); placeFmt();
}
function afterExec() { const h = S.link ? S.link.host : richHost(); if (h) syncEditable(h); }
function openLink() {
  const host = richHost();
  if (!host) return;
  const sel = S.doc.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const at = range && elOf(range.startContainer);
  const a = at && at.closest('a');
  S.link = { host, range };
  const f = S.ui.fmt, inp = f.querySelector('input');
  f.classList.add('link');
  inp.value = a ? a.getAttribute('href') || '' : '';
  inp.style.outline = '';
  f.querySelector('[data-fmt=unlink]').style.display = a ? '' : 'none';
  placeFmt();
  inp.focus(); inp.select();
}
function restoreRange() {
  if (!S.link) return;
  const { host, range } = S.link;
  host.focus();
  if (range) { const s = S.doc.getSelection(); s.removeAllRanges(); s.addRange(range); }
}
function applyLink() {
  if (!S.link) return;
  const inp = S.ui.fmt.querySelector('input'), url = safeUrl(inp.value);
  if (!url) { inp.style.outline = '2px solid #c0504d'; inp.focus(); return; }
  const host = S.link.host;
  restoreRange();
  const s = S.doc.getSelection();
  if (s.isCollapsed) S.doc.execCommand('insertHTML', false, '<a href="' + esc(url) + '">' + esc(url.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a>');
  else S.doc.execCommand('createLink', false, url);
  syncEditable(host);
  closeLink();
}
function closeLink(silent) {
  S.link = null;
  if (S.ui) S.ui.fmt.classList.remove('link');
  if (!silent) placeFmt();
}

/* ---------- drag and drop ---------- */
function onDocDragStart(e) {
  const t = elOf(e.target), h = t && t.closest('[data-eb-tool="drag"]');
  if (!h) { if (t && (t.tagName === 'IMG' || t.closest('a'))) e.preventDefault(); return; }
  S.drag = { move: S.sel };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', 'eb-move'); } catch (_) { /* ignore */ }
  const n = rowNode(S.sel);
  if (n) try { e.dataTransfer.setDragImage(n, 24, 18); } catch (_) { /* ignore */ }
  setTimeout(() => { if (S && S.ui) { S.ui.tools.style.display = 'none'; S.ui.plus.style.display = 'none'; } }, 0);
}
function onDragOver(e) {
  if (!S || !S.drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = S.drag.move ? 'move' : 'copy';
  const w = S.doc.defaultView;
  if (e.clientY < 48) w.scrollBy(0, -16); else if (e.clientY > w.innerHeight - 48) w.scrollBy(0, 16);
  const idx = indexAt(e.clientY);
  if (idx !== S.dropIdx) { S.dropIdx = idx; showDrop(idx); }
}
function indexAt(y) {
  const rows = [...S.doc.querySelectorAll('#eb-body > [data-eb-id]')];
  for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return i; }
  return rows.length;
}
function onDrop(e) {
  if (!S || !S.drag) return;
  e.preventDefault(); e.stopPropagation();
  const dg = S.drag, idx = S.dropIdx != null ? S.dropIdx : indexAt(e.clientY);
  endDrag();
  if (dg.type) addBlock(dg.type, idx);
  else if (dg.move) moveTo(dg.move, idx);
}
function endDrag() { S.drag = null; S.dropIdx = null; refreshUI(); }

/* ---------- block actions ---------- */
function select(id, scroll) {
  if (!S) return;
  id = id || null;
  if (S.sel !== id) { S.sel = id; renderRight(); updateBbar(); }
  refreshUI();
  if (scroll && id) scrollToRow(id);
}
function scrollToRow(id) {
  const n = rowNode(id);
  if (!n) return;
  const r = n.getBoundingClientRect(), w = S.doc.defaultView;
  if (r.top < 40 || r.bottom > w.innerHeight - 20) w.scrollTo({ top: Math.max(0, r.top + w.scrollY - 80), behavior: 'smooth' });
}
function addBlock(type, idx) {
  const list = S.design.blocks, n = list.length - 1;
  if (idx == null) { const si = list.findIndex((b) => b.id === S.sel); idx = si >= 0 && si < n ? si + 1 : n; }
  idx = Math.max(0, Math.min(idx, n));
  const b = mk(type);
  edit('add', () => list.splice(idx, 0, b), 'all');
  S.insertAt = null;
  renderLeft();
  select(b.id, true);
  if (isPhone()) setSheet(null);
  if (type === 'image') setTimeout(() => { if (S && findBlock(b.id)) chooseImage(b.id, 'src'); }, 150);
}
function moveTo(id, idx) {
  const list = S.design.blocks, from = list.findIndex((b) => b.id === id);
  if (from < 0 || from >= list.length - 1) return;
  const to = idx > from ? idx - 1 : idx;
  if (to === from) return;
  edit('move', () => { const [b] = list.splice(from, 1); list.splice(Math.min(to, list.length - 1), 0, b); }, 'all');
}
function moveBy(id, d) {
  const list = S.design.blocks, i = list.findIndex((b) => b.id === id), j = i + d;
  if (i < 0 || j < 0 || i >= list.length - 1 || j >= list.length - 1) return;
  edit('move', () => { const t = list[i]; list[i] = list[j]; list[j] = t; }, 'all');
  scrollToRow(id);
}
function duplicate(id) {
  const list = S.design.blocks, i = list.findIndex((b) => b.id === id);
  if (i < 0 || BLOCKS[list[i].type].fixed) return;
  const c = clone(list[i]);
  c.id = uid();
  edit('dup', () => list.splice(i + 1, 0, c), 'all');
  select(c.id, true);
}
function removeBlock(id) {
  const list = S.design.blocks, i = list.findIndex((b) => b.id === id);
  if (i < 0) return;
  const spec = BLOCKS[list[i].type];
  if (spec.fixed) { toast('The footer stays. It holds the unsubscribe link every email needs.'); return; }
  edit('del', () => list.splice(i, 1), 'all');
  select(null);
  toast(spec.label + ' deleted', '', { label: 'Undo', fn: undo });
}
async function chooseImage(id, path) {
  const b = findBlock(id);
  if (!b) return;
  const res = await pickImage(getPath(b, path));
  if (!res || !S || !findBlock(id)) return;
  const altKey = path.replace('src', 'alt');
  edit('img', () => {
    setPath(b, path, res.src);
    if (res.alt && altKey !== path && altKey in b && !b[altKey]) b[altKey] = res.alt;
  }, id);
  if (S.sel === id) renderRight();
}

/* ---------- keyboard ---------- */
function onKey(e) {
  if (!S) return;
  const mod = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase();
  if (mod && k === 's') { e.preventDefault(); save(); return; }
  if (S.modal || S.pop) return;
  if (isField(e.target)) return;
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (k === 'escape') {
    if (S.insertAt != null) { cancelInsert(); return; }
    if (S.sheet) { setSheet(null); return; }
    if (S.sel) { select(null); return; }
    return;
  }
  if (!S.sel) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeBlock(S.sel); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(S.sel); return; }
  if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) { e.preventDefault(); moveBy(S.sel, k === 'arrowup' ? -1 : 1); }
}
function onWinResize() {
  if (!S) return;
  if (!isPhone() && S.sheet) setSheet(null);
  refreshUI();
}
function onBeforeUnload(e) {
  if (S && S.dirty) { saveDraft(); e.preventDefault(); e.returnValue = ''; }
}

/* ---------- left panel: Add and Style ---------- */
function renderLeft() {
  const L = S.left, prev = L.querySelector('.eb-scroll'), keep = prev && L.dataset.tab === S.tab ? prev.scrollTop : 0;
  L.innerHTML = '';
  L.dataset.tab = S.tab;
  const tab = (k, label) => el('button', { type: 'button', role: 'tab', class: S.tab === k ? 'on' : '', 'aria-selected': String(S.tab === k), text: label,
    onclick: () => { S.tab = k; renderLeft(); updateBbar(); } });
  const sc = el('div', { class: 'eb-scroll' });
  L.append(el('div', { class: 'eb-tabs', role: 'tablist' }, [tab('add', 'Add'), tab('design', 'Style'), btnEl('eb-btn ghost eb-ico eb-sheet-x', ico('x'), 'Close', () => setSheet(null))]), sc);
  if (S.tab === 'design') renderDesign(sc); else renderAdd(sc);
  sc.scrollTop = keep;
}
function renderAdd(box) {
  if (S.insertAt != null) {
    box.appendChild(el('div', { class: 'eb-note' }, [el('span', { text: 'Pick a block to add at the gold line.' }), el('button', { type: 'button', class: 'eb-link', text: 'Cancel', onclick: cancelInsert })]));
  } else {
    box.appendChild(el('div', { class: 'eb-hint', style: { margin: '0 2px 14px' }, text: isPhone() ? 'Tap a block to add it below the one you picked.' : 'Drag a block into the email, or click one to add it below the selected block.' }));
  }
  [['basics', 'Basics'], ['greys', 'GREYS blocks']].forEach(([g, label]) => {
    box.appendChild(el('div', { class: 'eb-group', text: label }));
    const grid = el('div', { class: 'eb-tiles' });
    Object.keys(BLOCKS).filter((k) => BLOCKS[k].group === g).forEach((k) => {
      const tile = el('div', { class: 'eb-tile', role: 'button', tabindex: '0', draggable: 'true', title: 'Add ' + BLOCKS[k].label.toLowerCase(),
        html: tileSvg(k) + '<span>' + esc(BLOCKS[k].label) + '</span>' });
      tile.addEventListener('click', () => addBlock(k, S.insertAt));
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addBlock(k, S.insertAt); } });
      tile.addEventListener('dragstart', (e) => {
        S.drag = { type: k };
        e.dataTransfer.effectAllowed = 'copy';
        try { e.dataTransfer.setData('text/plain', 'eb:' + k); } catch (_) { /* ignore */ }
        if (S.ui) S.ui.plus.style.display = 'none';
      });
      tile.addEventListener('dragend', () => { if (S && S.drag) endDrag(); });
      grid.appendChild(tile);
    });
    box.appendChild(grid);
  });
}
function colorRow(label, value, onSet, o) {
  o = o || {};
  const pick = el('input', { type: 'color', value: value || '#FFFFFF', 'aria-label': label, title: label });
  const hex = el('input', { class: 'eb-in', value: value || '', placeholder: o.ph || '#000000', 'aria-label': label + ' color code', maxlength: '7', spellcheck: 'false' });
  pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); onSet(pick.value.toUpperCase()); });
  hex.addEventListener('input', () => {
    let v = hex.value.trim();
    if (v && v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) { pick.value = v; onSet(v.toUpperCase()); } else if (!v && o.clear) onSet('');
  });
  if (o.change) { pick.addEventListener('change', o.change); hex.addEventListener('change', o.change); }
  const kids = [el('span', { class: 'nm', text: label }), pick, hex];
  if (o.clear) kids.push(btnEl('eb-mini', ico('x', 12), 'Clear ' + label.toLowerCase(), () => { hex.value = ''; onSet(''); }));
  return el('div', { class: 'eb-color' }, kids);
}
function renderDesign(box) {
  const th = S.design.theme, t = themeOf(S.design);
  box.appendChild(el('div', { class: 'eb-group', text: 'Look' }));
  const ps = el('div', { class: 'eb-presets' });
  Object.keys(PRESETS).forEach((k) => {
    const p = PRESETS[k];
    ps.appendChild(el('button', { type: 'button', class: 'eb-preset' + (th.preset === k ? ' on' : ''), 'aria-pressed': String(th.preset === k),
      html: '<span class="eb-sw">' + [p.bg, p.body, p.heading, p.accent].map((c) => '<i style="background:' + c + '"></i>').join('') + '</span><span>' + esc(p.label) + '</span>',
      onclick: () => { edit('preset', () => { S.design.theme = { preset: k, font: th.font, radius: th.radius }; }, 'all'); renderLeft(); } }));
  });
  box.appendChild(ps);
  box.appendChild(el('div', { class: 'eb-group', text: 'Fonts' }));
  const fs = el('div', { class: 'eb-fonts' });
  Object.keys(FONTS).forEach((k) => {
    const f = FONTS[k];
    fs.appendChild(el('button', { type: 'button', class: 'eb-font' + ((th.font || 'classic') === k ? ' on' : ''), 'aria-pressed': String((th.font || 'classic') === k),
      html: '<b style="font-family:' + esc(f.head) + '">Aa</b><span>' + esc(f.label) + '<small style="font-family:' + esc(f.body) + '">' + esc(f.note) + '</small></span>',
      onclick: () => { edit('font', () => { S.design.theme.font = k; }, 'all'); renderLeft(); } }));
  });
  box.appendChild(fs);
  box.appendChild(el('div', { class: 'eb-group', text: 'Corners' }));
  const rs = el('div', { class: 'eb-seg full', role: 'group', 'aria-label': 'Corners', style: { marginBottom: '20px' } });
  [['square', 'Square'], ['soft', 'Soft'], ['round', 'Round']].forEach(([k, l]) => rs.appendChild(btnEl((th.radius || 'soft') === k ? 'on' : '', l, null,
    () => { edit('radius', () => { S.design.theme.radius = k; }, 'all'); renderLeft(); })));
  box.appendChild(rs);
  box.appendChild(el('div', { class: 'eb-group', text: 'Colors' }));
  COLOR_KEYS.forEach(([k, label]) => box.appendChild(colorRow(label, t[k], (v) => edit('c:' + k, () => { S.design.theme[k] = v; }, 'theme'), { change: () => renderLeft() })));
  if (COLOR_KEYS.some(([k]) => th[k])) {
    box.appendChild(el('button', { type: 'button', class: 'eb-link', style: { marginTop: '6px' }, text: 'Reset colors to ' + PRESETS[th.preset].label,
      onclick: () => { edit('reset', () => { COLOR_KEYS.forEach(([k]) => { delete S.design.theme[k]; }); }, 'all'); renderLeft(); } }));
  }
}

/* ---------- right panel: block settings, or the email's details ---------- */
function renderRight() {
  const R = S.right, prev = R.querySelector('.eb-scroll'), keep = prev && R.dataset.sel === String(S.sel) ? prev.scrollTop : 0;
  R.innerHTML = '';
  R.dataset.sel = String(S.sel);
  const close = btnEl('eb-btn ghost eb-ico eb-sheet-x', ico('x'), 'Close', () => setSheet(null));
  const b = findBlock(S.sel);
  const sc = el('div', { class: 'eb-scroll' });
  if (!b) {
    R.append(el('div', { class: 'eb-ihead' }, [el('h3', { text: 'Email details' }), close]), sc);
    renderDetails(sc);
  } else {
    const spec = BLOCKS[b.type];
    R.append(el('div', { class: 'eb-ihead' }, [
      el('h3', { text: spec.label }),
      spec.fixed ? null : btnEl('eb-btn ghost eb-ico', ico('copy'), 'Duplicate block', () => duplicate(b.id)),
      spec.fixed ? null : btnEl('eb-btn ghost eb-ico', ico('trash'), 'Delete block', () => removeBlock(b.id)),
      btnEl('eb-btn ghost sm eb-hide-s', 'Done', 'Done with this block', () => select(null)),
      close,
    ]), sc);
    spec.fields.forEach((f) => { if (!f.show || f.show(b)) sc.appendChild(field(b, f)); });
    if (spec.spacing !== false) {
      const det = el('details', { class: 'eb-more' }, [el('summary', { text: 'Spacing and background' })]);
      det.open = !!S.moreOpen;
      det.addEventListener('toggle', () => { S.moreOpen = det.open; });
      det.appendChild(field(b, { k: 'pt', t: 'range', label: 'Space above', min: 0, max: 72, step: 4, unit: 'px' }));
      det.appendChild(field(b, { k: 'pb', t: 'range', label: 'Space below', min: 0, max: 72, step: 4, unit: 'px' }));
      det.appendChild(el('div', { class: 'eb-f' }, [el('div', { class: 'eb-lab', text: 'Background' }),
        colorRow('Block background', b.bg || '', (v) => edit('f:' + b.id + ':bg', () => { b.bg = v; }, b.id), { clear: true, ph: 'None' })]));
      sc.appendChild(det);
    }
  }
  sc.scrollTop = keep;
}
function renderDetails(sc) {
  const counted = (id, label, value, max, ph, onInput, hint) => {
    const inp = el('input', { id, class: 'eb-in', value, placeholder: ph, maxlength: '200' });
    const cnt = el('span', { class: 'eb-count' });
    const upd = () => { cnt.textContent = inp.value.length + ' / ' + max; cnt.classList.toggle('over', inp.value.length > max); };
    inp.addEventListener('input', () => { onInput(inp.value); upd(); });
    upd();
    return el('div', { class: 'eb-f' }, [el('label', { for: id }, [label, cnt]), inp, el('div', { class: 'eb-hint', text: hint })]);
  };
  sc.append(
    counted('eb-subject', 'Subject line', S.subject, 60, 'What this email is about', (v) => { commit('subject'); S.subject = v; changed(); },
      'Campaigns start with this subject. You can change it when you send.'),
    counted('eb-pre', 'Preview text', S.design.preheader, 100, 'A line that adds to the subject', (v) => { commit('pre'); S.design.preheader = v; changed(); },
      'Shows next to the subject in most inboxes.'),
    el('div', { class: 'eb-note info', html: isPhone()
      ? 'Tap any part of the email to change it. Tap <b>Add</b> to put in more blocks.'
      : 'Click any part of the email to change it. Drag in blocks from the left, or use the <b>+</b> between blocks.' }),
  );
}

function field(b, f) {
  const wrap = el('div', { class: 'eb-f' });
  if (f.t === 'note') { wrap.appendChild(el('div', { class: 'eb-hint', style: { marginTop: '0' }, text: f.text })); return wrap; }
  const fid = 'ebf-' + b.id + '-' + f.k.replace(/\./g, '-');
  const val = getPath(b, f.k);
  const set = (v) => edit('f:' + b.id + ':' + f.k, () => setPath(b, f.k, v), b.id);
  const spec = BLOCKS[b.type];
  const deps = !!f.redraw || spec.fields.some((x) => x.show);
  const refresh = () => { if (deps) renderRight(); };
  const label = () => el('label', { for: fid, text: f.label });
  const hint = f.hint ? el('div', { class: 'eb-hint', text: f.hint }) : null;
  switch (f.t) {
    case 'text': case 'url': case 'date': {
      const inp = el('input', { id: fid, class: 'eb-in', type: f.t === 'text' ? 'text' : f.t, placeholder: f.ph || (f.t === 'url' ? 'https://' : ''),
        spellcheck: f.t === 'text' ? 'true' : 'false', value: val == null ? '' : String(val) });
      inp.dataset.ebKey = f.k;
      inp.addEventListener('input', () => set(f.t === 'url' ? inp.value.trim() : inp.value));
      inp.addEventListener('change', refresh);
      wrap.append(label(), inp);
      if (f.t === 'url') {
        const warn = el('div', { class: 'eb-hint bad', text: 'That does not look like a web address.' });
        const check = () => { const v = inp.value.trim(), bad = !!v && !safeUrl(v); inp.classList.toggle('bad', bad); warn.style.display = bad ? '' : 'none'; };
        inp.addEventListener('change', () => { const v = inp.value.trim(), s = safeUrl(v); if (s && s !== v) { inp.value = s; set(s); } check(); });
        check();
        wrap.append(warn, el('div', { class: 'eb-chips' }, QUICK_LINKS.map(([l, u]) => el('button', { type: 'button', class: 'eb-chip', text: l,
          onclick: () => { inp.value = u; set(u); check(); } }))));
      }
      break;
    }
    case 'textarea': case 'code': {
      const ta = el('textarea', { id: fid, class: 'eb-in' + (f.t === 'code' ? ' code' : ''), rows: String(f.rows || (f.t === 'code' ? 10 : 3)), spellcheck: f.t === 'code' ? 'false' : 'true' });
      ta.value = val == null ? '' : String(val);
      ta.dataset.ebKey = f.k;
      ta.addEventListener('input', () => set(ta.value));
      wrap.append(label(), ta);
      break;
    }
    case 'seg': case 'align': {
      const opts = f.t === 'align' ? [['left', ico('aleft'), 'Left'], ['center', ico('acenter'), 'Center'], ['right', ico('aright'), 'Right']]
        : f.opts.map(([v, l]) => [v, esc(l), l]);
      const cur = String(val == null ? 'left' : val);
      const sg = el('div', { class: 'eb-seg full', role: 'group', 'aria-label': f.label });
      opts.forEach(([v, html, title]) => sg.appendChild(btnEl(cur === String(v) ? 'on' : '', html, title, () => {
        set(v);
        sg.querySelectorAll('button').forEach((x, i) => { const on = String(opts[i][0]) === String(v); x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        refresh();
      }, { 'aria-pressed': String(cur === String(v)) })));
      wrap.append(el('div', { class: 'eb-lab', text: f.label }), sg);
      break;
    }
    case 'toggle': {
      const cb = el('input', { type: 'checkbox', id: fid, checked: f.k === 'addrAuto' ? val !== false : !!val });
      cb.addEventListener('change', () => { set(cb.checked); refresh(); });
      wrap.appendChild(el('label', { class: 'eb-tog', for: fid }, [el('span', { text: f.label }), cb]));
      break;
    }
    case 'range': {
      const v0 = num(val, f.min), unit = f.unit || '';
      const out = el('output', { text: v0 + unit });
      const rg = el('input', { type: 'range', id: fid, min: String(f.min), max: String(f.max), step: String(f.step || 1), value: String(v0) });
      rg.addEventListener('input', () => { out.textContent = rg.value + unit; set(+rg.value); });
      wrap.append(label(), el('div', { class: 'eb-range' }, [rg, out]));
      break;
    }
    case 'image': {
      const pv = el('div', { class: 'pv', text: val ? '' : 'No photo' });
      if (val) pv.style.backgroundImage = 'url("' + String(val).replace(/"/g, '%22') + '")';
      wrap.append(el('div', { class: 'eb-lab', text: f.label }), el('div', { class: 'eb-imgf' }, [pv, el('div', { class: 'acts' }, [
        btnEl('eb-btn sm', ico('photo', 14) + (val ? 'Change photo' : 'Choose photo'), null, () => chooseImage(b.id, f.k)),
        val ? el('button', { type: 'button', class: 'eb-link', text: 'Remove photo', onclick: () => { set(''); renderRight(); } }) : null,
      ])]));
      break;
    }
    case 'rows': {
      const list = el('div', { class: 'eb-rows' });
      const draw = () => {
        list.innerHTML = '';
        if (!Array.isArray(b[f.k])) b[f.k] = [];
        const arr = b[f.k];
        arr.forEach((r, i) => {
          const card = el('div', { class: 'r' });
          f.cols.forEach(([ck, cl]) => {
            const inp = el('input', { class: 'eb-in', placeholder: cl, 'aria-label': cl + ' ' + (i + 1), value: r[ck] || '' });
            inp.dataset.ebKey = f.k + '.' + i + '.' + ck;
            inp.addEventListener('input', () => edit('f:' + b.id + ':' + f.k + '.' + i + '.' + ck, () => { r[ck] = inp.value; }, b.id));
            card.appendChild(inp);
          });
          const mv = (d) => { edit('rows', () => { arr.splice(i + d, 0, arr.splice(i, 1)[0]); }, b.id); draw(); };
          card.appendChild(el('div', { class: 'ctl' }, [
            btnEl('eb-mini', ico('up', 13), 'Move up', () => mv(-1), { disabled: i === 0 }),
            btnEl('eb-mini', ico('down', 13), 'Move down', () => mv(1), { disabled: i === arr.length - 1 }),
            btnEl('eb-mini', ico('trash', 13), 'Remove', () => { edit('rows', () => { arr.splice(i, 1); }, b.id); draw(); }),
          ]));
          list.appendChild(card);
        });
        list.appendChild(btnEl('eb-btn sm', ico('plus', 13) + 'Add ' + (f.one || 'item'), null, () => {
          edit('rows', () => { arr.push(Object.fromEntries(f.cols.map(([ck]) => [ck, '']))); }, b.id);
          draw();
          const ins = list.querySelectorAll('.r');
          if (ins.length) { const first = ins[ins.length - 1].querySelector('input'); if (first) first.focus(); }
        }));
      };
      draw();
      wrap.append(el('div', { class: 'eb-lab', text: f.label }), list);
      break;
    }
    default: break;
  }
  if (hint) wrap.appendChild(hint);
  return wrap;
}

/* ---------- dialogs, popovers, toasts ---------- */
function modal(title, o) {
  o = o || {};
  const bd = el('div', { class: 'bd' });
  const foot = o.footer ? el('footer') : null;
  let done = null, closed = false;
  const promise = new Promise((res) => { done = res; });
  const close = (v) => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onEsc, true);
    if (S && S.modal === wrap) S.modal = null;
    done(v === undefined ? null : v);
  };
  const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
  const dlg = el('div', { class: 'eb-dlg' + (o.narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('header', null, [el('h3', { text: title }), btnEl('eb-btn ghost eb-ico', ico('x'), 'Close', () => close(null))]), bd, foot]);
  const wrap = el('div', { class: 'eb-modal' }, dlg);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
  document.addEventListener('keydown', onEsc, true);
  document.body.appendChild(wrap);
  if (S) S.modal = wrap;
  return { body: bd, footer: foot, close, promise };
}
function confirmDlg(title, text, buttons) {
  const m = modal(title, { narrow: true, footer: true });
  m.body.appendChild(el('p', { style: { margin: '0' }, text }));
  buttons.forEach(([label, v, cls]) => m.footer.appendChild(btnEl('eb-btn' + (cls ? ' ' + cls : ''), esc(label), null, () => m.close(v))));
  setTimeout(() => { const b = m.footer.querySelector('.pri'); if (b) b.focus(); }, 20);
  return m.promise;
}
let POP = null;
function pop(anchor, build) {
  closePop();
  const box = el('div', { class: 'eb-pop', role: 'dialog' });
  document.body.appendChild(box);
  build(box, closePop);
  const r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  Object.assign(box.style, { left: Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w)) + 'px', top: top + 'px' });
  const outside = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  document.addEventListener('keydown', onEsc, true);
  POP = { box, off: () => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onEsc, true); } };
  if (S) S.pop = box;
}
function closePop() {
  if (!POP) return;
  POP.off(); POP.box.remove(); POP = null;
  if (S) S.pop = null;
}
function toast(msg, kind, action) {
  injectCss();
  let t = document.getElementById('eb-toast');
  if (!t) { t = el('div', { id: 'eb-toast', class: 'eb-toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
  t.className = 'eb-toast' + (kind === 'err' ? ' err' : '');
  t.textContent = msg;
  t.style.pointerEvents = action ? 'auto' : 'none';
  if (action) t.appendChild(el('button', { type: 'button', text: action.label, onclick: () => { t.classList.remove('on'); action.fn(); } }));
  void t.offsetWidth;
  t.classList.add('on');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('on'), action ? 6000 : kind === 'err' ? 5000 : 2600);
}

/* ---------- photos ---------- */
async function shrink(file) {
  if (!/^image\//.test(file.type || '')) throw new Error('That file is not a photo. Use a JPG, PNG, GIF or WebP.');
  if (/gif/.test(file.type)) return file;
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch (_) { return file; }
  const max = 1200;
  if (bmp.width <= max && file.size < 700000) return file;
  const s = Math.min(1, max / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d'), png = file.type === 'image/png';
  if (!png) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise((res) => c.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.85));
  return out || file;
}
function pickImage(current) {
  const m = modal('Choose a photo', { footer: true });
  let tab = 'upload';
  const tabs = el('div', { class: 'eb-seg full', role: 'tablist', style: { marginBottom: '16px' } });
  const pane = el('div');
  const busy = (msg) => { pane.innerHTML = ''; pane.appendChild(el('div', { class: 'eb-hint', style: { padding: '34px 0', textAlign: 'center', fontSize: '14px' }, text: msg })); };
  const fail = (err) => { draw(); toast((err && err.message) || 'That did not work. Try again.', 'err'); };
  const opts = (S && S.opts) || {};
  function drawUpload() {
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' } });
    const z = el('label', { class: 'eb-dropz', tabindex: '0' }, [el('b', { text: 'Drop a photo here' }), el('span', { text: 'or click to choose one. Big photos are resized to 1200 pixels wide.' }), file]);
    const go = async (f) => {
      if (!f) return;
      if (!opts.uploadImage) { toast('Uploading is not set up here.', 'err'); return; }
      busy('Uploading ' + f.name + '...');
      try {
        const url = await opts.uploadImage(await shrink(f), f.name);
        if (!url) throw new Error('The upload did not finish. Try again.');
        m.close({ src: url });
      } catch (err) { fail(err); }
    };
    file.addEventListener('change', () => go(file.files[0]));
    z.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('on'); });
    z.addEventListener('dragleave', () => z.classList.remove('on'));
    z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('on'); go(e.dataTransfer.files[0]); });
    pane.appendChild(z);
  }
  async function drawLibrary() {
    busy('Loading your photos...');
    let list = [];
    try { list = opts.listImages ? await opts.listImages() : []; } catch (err) { fail(err); return; }
    if (tab !== 'library') return;
    pane.innerHTML = '';
    if (!list.length) { pane.appendChild(el('div', { class: 'eb-hint', style: { padding: '28px 0', textAlign: 'center', fontSize: '14px' }, text: 'No photos yet. Upload one and it will show up here.' })); return; }
    const g = el('div', { class: 'eb-grid' });
    list.forEach((it) => g.appendChild(el('button', { type: 'button', title: it.name || '', 'aria-label': it.name || 'Photo',
      style: { backgroundImage: 'url("' + String(it.url).replace(/"/g, '%22') + '")' }, onclick: () => m.close({ src: it.url }) })));
    pane.appendChild(g);
  }
  function drawLink() {
    const inp = el('input', { class: 'eb-in', type: 'url', placeholder: 'https://', 'aria-label': 'Photo address' });
    const go = async () => {
      const u = safeUrl(inp.value);
      if (!/^https?:\/\//i.test(u)) { inp.classList.add('bad'); inp.focus(); return; }
      if (u.indexOf(ASSETS) === 0 || !opts.importImage) { m.close({ src: u }); return; }
      busy('Saving a copy of that photo...');
      try { m.close({ src: (await opts.importImage(u)) || u }); } catch (err) { fail(err); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    pane.append(el('div', { class: 'eb-f' }, [el('label', { text: 'Photo address' }), inp, el('div', { class: 'eb-hint', text: 'We keep a copy, so the email still works if the other site changes or removes the photo.' })]),
      el('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, btnEl('eb-btn pri', 'Use this photo', null, go)));
    setTimeout(() => inp.focus(), 30);
  }
  function draw() {
    tabs.innerHTML = '';
    [['upload', 'Upload'], ['library', 'Your photos'], ['link', 'From a link']].forEach(([k, l]) => tabs.appendChild(btnEl(tab === k ? 'on' : '', esc(l), null,
      () => { tab = k; draw(); }, { role: 'tab', 'aria-selected': String(tab === k) })));
    pane.innerHTML = '';
    if (tab === 'upload') drawUpload(); else if (tab === 'library') drawLibrary(); else drawLink();
  }
  m.body.append(tabs, pane);
  if (current) m.footer.appendChild(btnEl('eb-btn danger', 'Remove photo', null, () => m.close({ src: '' })));
  m.footer.appendChild(btnEl('eb-btn', 'Cancel', null, () => m.close(null)));
  draw();
  return m.promise;
}

/* ---------- test sends and checks ---------- */
function openTest(anchor) {
  pop(anchor, (box, close) => {
    let to = '';
    try { to = localStorage.getItem('eb-test-to') || ''; } catch (_) { /* private mode */ }
    to = to || S.opts.userEmail || '';
    const inp = el('input', { class: 'eb-in', type: 'email', value: to, placeholder: 'name@example.com', 'aria-label': 'Send the test to' });
    const msg = el('div', { class: 'eb-hint', text: 'Sends what you see now through SendGrid, with [TEST] at the start of the subject. You do not need to save first.' });
    const go = btnEl('eb-btn pri', ico('send') + 'Send test', null, async () => {
      const addr = inp.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { inp.classList.add('bad'); inp.focus(); return; }
      if (!S.opts.sendTest) { toast('Test sends are not set up here.', 'err'); return; }
      go.disabled = true; go.textContent = 'Sending...';
      try { localStorage.setItem('eb-test-to', addr); } catch (_) { /* private mode */ }
      try {
        await S.opts.sendTest({ to: addr, subject: S.subject.trim() || S.name, html: compile(S.design, { subject: S.subject }) });
        close();
        toast('Test sent to ' + addr);
      } catch (err) {
        go.disabled = false; go.innerHTML = ico('send') + 'Send test';
        msg.className = 'eb-hint bad';
        msg.textContent = (err && err.message) || 'The test did not send. Try again.';
      }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    box.append(el('h4', { text: 'Send a test email' }), el('div', { class: 'eb-f', style: { marginBottom: '6px' } }, [el('label', { text: 'Send to' }), inp]), msg,
      el('div', { class: 'row' }, [btnEl('eb-btn', 'Cancel', null, close), go]));
    setTimeout(() => inp.focus(), 20);
  });
}
function runChecks() {
  const out = [], d = S.design, subj = S.subject.trim();
  if (!subj) out.push({ lvl: 'warn', msg: 'Add a subject line.', fix: 'subject' });
  else if (subj.length > 70) out.push({ lvl: 'tip', msg: 'The subject is long. Phones show about the first 40 characters.', fix: 'subject' });
  if (!d.preheader.trim()) out.push({ lvl: 'tip', msg: 'Add preview text. It shows next to the subject in the inbox.', fix: 'preheader' });
  if (d.blocks.length < 2) out.push({ lvl: 'warn', msg: 'The email is empty. Add a few blocks.' });
  d.blocks.forEach((b) => {
    const spec = BLOCKS[b.type], L = spec.label;
    (spec.images ? spec.images(b) : []).forEach(([sk, ak]) => {
      const src = getPath(b, sk);
      if (!src) out.push({ lvl: 'warn', msg: L + ': add a photo, or delete the block.', id: b.id });
      else if (/^http:\/\//i.test(src)) out.push({ lvl: 'warn', msg: L + ': the photo address starts with http:, which some inboxes block.', id: b.id });
      else if (ak && !String(getPath(b, ak) || '').trim()) out.push({ lvl: 'tip', msg: L + ': describe the photo for people who cannot see it.', id: b.id });
    });
    (spec.buttons ? spec.buttons(b) : []).forEach(([lk, hk]) => {
      const text = String(getPath(b, lk) || '').trim();
      if (text && !safeUrl(getPath(b, hk))) out.push({ lvl: 'warn', msg: L + ': "' + text.slice(0, 32) + '" needs a link.', id: b.id });
    });
    if (b.type === 'footer' && b.addrAuto === false && !String(b.address || '').trim()) out.push({ lvl: 'warn', msg: 'Footer: add your mailing address. The law requires one.', id: b.id });
  });
  const kb = Math.round(new Blob([compile(d, { subject: S.subject })]).size / 1024);
  if (kb > 92) out.push({ lvl: 'warn', msg: 'This email is ' + kb + ' KB. Gmail cuts off emails over 102 KB, which hides the unsubscribe link.' });
  return out.sort((a, b) => (a.lvl === b.lvl ? 0 : a.lvl === 'warn' ? -1 : 1));
}
function scheduleChecks() {
  clearTimeout(S.timers.checks);
  S.timers.checks = setTimeout(() => { if (!S) return; S.checks = runChecks(); drawChecks(); }, 350);
}
function drawChecks() {
  const b = S.top.querySelector('[data-act=checks]'), warn = S.checks.filter((c) => c.lvl === 'warn').length, tips = S.checks.length - warn;
  b.className = 'eb-checks ' + (warn ? 'warn' : tips ? 'tip' : 'ok');
  b.innerHTML = warn ? ico('warn', 14) + warn + ' to fix' : tips ? ico('check', 14) + tips + (tips === 1 ? ' tip' : ' tips') : ico('check', 14) + 'Ready';
}
function openChecks(anchor) {
  S.checks = runChecks();
  drawChecks();
  pop(anchor, (box, close) => {
    box.appendChild(el('h4', { text: S.checks.length ? 'Before you send' : 'Ready to send' }));
    if (!S.checks.length) {
      box.appendChild(el('div', { class: 'eb-hint', style: { marginTop: '0' }, text: 'The subject, preview text, photos and links all check out. Send yourself a test to see it in a real inbox.' }));
      return;
    }
    const ul = el('ul', { class: 'eb-clist' });
    S.checks.forEach((c) => ul.appendChild(el('li', { tabindex: '0', onclick: () => { close(); goCheck(c); },
      onkeydown: (e) => { if (e.key === 'Enter') { close(); goCheck(c); } } }, [el('i', { class: c.lvl }), el('span', { text: c.msg })])));
    box.appendChild(ul);
  });
}
function goCheck(c) {
  if (c.id) { select(c.id, true); if (isPhone()) setSheet('right'); return; }
  select(null);
  if (isPhone()) setSheet('right');
  const id = c.fix === 'subject' ? 'eb-subject' : c.fix === 'preheader' ? 'eb-pre' : null;
  if (id) setTimeout(() => { const n = document.getElementById(id); if (n) n.focus(); }, 40);
}

/* ---------- save, drafts, close ---------- */
async function save() {
  if (!S || S.saving) return;
  if (!S.opts.onSave) { toast('Saving is not set up here.', 'err'); return; }
  S.saving = true;
  updateTop();
  const oldKey = draftKey(), name = S.name.trim() || 'Untitled email';
  if (name !== S.name) { S.name = name; S.nameIn.value = name; }
  try {
    const row = await S.opts.onSave({ id: S.id, name, subject: S.subject.trim(), preheader: S.design.preheader.trim(), design: clone(S.design), html: compile(S.design, { subject: S.subject }) });
    if (!S) return;
    if (row && row.id) S.id = row.id;
    clearDraft(oldKey); clearDraft();
    S.saved = snap();
    toast('Saved');
  } catch (err) {
    toast((err && err.message) || 'Could not save. Try again.', 'err');
  } finally {
    if (S) { S.saving = false; updateTop(); }
  }
}
function scheduleDraft() { clearTimeout(S.timers.draft); S.timers.draft = setTimeout(saveDraft, 700); }
function saveDraft() {
  if (!S) return;
  try {
    if (snap() !== S.saved) localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), snap: snap() }));
    else localStorage.removeItem(draftKey());
  } catch (_) { /* storage full or blocked */ }
}
function clearDraft(key) { try { localStorage.removeItem(key || draftKey()); } catch (_) { /* blocked */ } }
function checkDraft() {
  if (!S) return;
  let dr = null;
  try { dr = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (_) { dr = null; }
  if (!dr || !dr.snap || dr.snap === snap()) return;
  if (Date.now() - dr.at > 14 * 864e5) { clearDraft(); return; }
  const when = new Date(dr.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const bn = el('div', { class: 'eb-banner', role: 'status' }, [
    el('span', { text: 'You have changes from ' + when + ' that were not saved.' }),
    btnEl('eb-btn sm pri', 'Bring them back', null, () => { bn.remove(); commit('restore'); restore(dr.snap); }),
    btnEl('eb-btn sm', 'Discard', null, () => { bn.remove(); clearDraft(); }),
  ]);
  S.center.appendChild(bn);
}
async function requestClose() {
  if (!S) return;
  if (S.modal) return;
  if (snap() === S.saved) { teardown(true); return; }
  const v = await confirmDlg('Save your changes?', 'This email has changes that are not saved yet.',
    [['Keep editing', null], ['Discard changes', 'discard', 'danger'], ['Save and close', 'save', 'pri']]);
  if (!S) return;
  if (v === 'save') { await save(); if (S && snap() === S.saved) teardown(true); }
  else if (v === 'discard') { clearDraft(); teardown(true); }
}
function teardown(notify) {
  const s = S;
  if (!s) return;
  Object.keys(s.timers).forEach((k) => { clearTimeout(s.timers[k]); cancelAnimationFrame(s.timers[k]); });
  closePop();
  if (s.modal) s.modal.remove();
  window.removeEventListener('beforeunload', onBeforeUnload);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onWinResize);
  s.root.remove();
  document.documentElement.classList.remove('eb-lock');
  S = null;
  if (notify && s.opts.onClose) { try { s.opts.onClose({ id: s.id }); } catch (_) { /* caller error */ } }
}

/* ---------- starter picker (used before the editor opens) ---------- */
function pickStarter() {
  injectCss();
  const m = modal('Start a new email');
  const g = el('div', { class: 'eb-starters' });
  Object.keys(STARTERS).forEach((k) => {
    const s = STARTERS[k];
    g.appendChild(el('button', { type: 'button', class: 'eb-starter', onclick: () => m.close(k),
      html: thumb(compile(s.make(), { subject: s.label })) + '<b>' + esc(s.label) + '</b><span>' + esc(s.desc) + '</span>' }));
  });
  m.body.appendChild(g);
  requestAnimationFrame(() => fitThumbs(g));
  return m.promise;
}

window.EmailBuilder = {
  version: 1,
  open,
  close: () => requestClose(),
  isOpen: () => !!S,
  compile: (design, meta) => compile(design, meta || {}, {}),
  thumb, fitThumbs, pickStarter, toast,
  starters: Object.keys(STARTERS).map((k) => ({ key: k, label: STARTERS[k].label, desc: STARTERS[k].desc, subject: STARTERS[k].subject })),
  starterDesign: (k) => normalize((STARTERS[k] || STARTERS.blank).make()),
  normalize,
};
injectCss();
})();
