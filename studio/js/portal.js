/* GREYS Studio (staff portal) — manager sign-in, links back to the portal, Share to Social Posts / email, Greysie. */
(function () {
  const GS = window.GS, S = GS.Store, E = GS.E, h = GS.h, $ = GS.$;
  const IG_MAX = 2200;

  // ---------- sign-in gate ----------
  const gate = $('#gate'), pw = $('#gate-pw'), go = $('#gate-go'), err = $('#gate-err'), form = $('#gate-form'), wait = $('#gate-wait');
  function showForm(msg) {
    gate.hidden = false; wait.hidden = true; form.hidden = false;
    err.textContent = msg || '';
    setTimeout(() => pw.focus(), 50);
  }
  async function enter() {
    gate.hidden = true;
    S.auth.done();
  }
  async function boot() {
    if (!S.auth.available) { showForm('Sign-in couldn’t load. Check the connection and reload the page.'); go.disabled = true; return; }
    try { if (await S.auth.check()) return enter(); } catch (e) { /* fall through to the form */ }
    showForm('');
  }
  async function signIn() {
    if (!pw.value) { err.textContent = 'Enter the manager password.'; return; }
    go.disabled = true; err.textContent = '';
    try { await S.auth.signIn(pw.value); pw.value = ''; enter(); }
    catch (e) { err.textContent = e.message || 'Sign-in failed'; }
    go.disabled = false;
  }
  go.addEventListener('click', signIn);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  boot();

  // ---------- chrome: back to wherever Studio was opened from (?from=home|social, else the referrer), refresh the list on the way home ----------
  const BACKS = { home: ['/', 'Back to the staff portal'], social: ['/manager#social', 'Back to Social Posts'], manager: ['/manager', 'Back to the manager console'] };
  function cameFrom() {
    let k = null;
    try {
      k = new URLSearchParams(location.search).get('from');
      if (!BACKS[k]) {
        k = null;
        const r = document.referrer ? new URL(document.referrer) : null;
        if (r && r.origin === location.origin && !r.pathname.startsWith('/studio')) k = r.pathname.startsWith('/manager') ? 'manager' : (r.pathname === '/' || r.pathname === '/index.html') ? 'home' : null;
      }
      if (k) sessionStorage.setItem('studio_from', k); else k = sessionStorage.getItem('studio_from');
    } catch (e) { /* storage blocked: default below */ }
    return BACKS[k] || BACKS.manager;
  }
  const [backHref, backTitle] = cameFrom();
  const back = h('a', { class: 'ibtn light', href: backHref, title: backTitle, 'aria-label': backTitle, html: GS.icon('back', 22) });
  const brand = document.querySelector('#home .brand');
  brand.parentNode.insertBefore(back, brand);
  const goHome = GS.UI.goHome;
  GS.UI.goHome = async function () { await goHome.apply(this, arguments); S.refresh(); };
  GS.EXTRA_STICKERS = [
    { ref: '/greysie-cheesemonger-sticker.svg', w: 600, h: 600, name: 'Greysie, cheesemonger' },
    { ref: '/studio/graphics/cow.svg', w: 524, h: 485, name: 'Cow' },
    { ref: '/studio/graphics/goat.svg', w: 484, h: 516, name: 'Goat' },
    { ref: '/studio/graphics/sheep.svg', w: 468, h: 422, name: 'Sheep' },
    { ref: '/studio/graphics/wine-red.svg', w: 420, h: 660, name: 'Red wine glass' },
    { ref: '/studio/graphics/wine-white.svg', w: 420, h: 660, name: 'White wine glass' },
    { ref: '/studio/graphics/wine-rose.svg', w: 420, h: 660, name: 'Rosé glass' },
    { ref: '/studio/graphics/wine-orange.svg', w: 420, h: 660, name: 'Orange wine glass' },
    { ref: '/studio/graphics/wine-sparkling.svg', w: 322, h: 692, name: 'Sparkling flute' },
    { ref: '/studio/graphics/wine-sparkling-rose.svg', w: 322, h: 692, name: 'Sparkling rosé flute' },
    { ref: '/studio/graphics/wine-dessert.svg', w: 462, h: 672, name: 'Dessert wine glass' },
    { ref: '/studio/graphics/wine-port.svg', w: 462, h: 672, name: 'Port glass' },
  ];

  const share = h('button', { class: 'btn ghost-light', id: 'ed-share', title: 'Post to Instagram & Facebook, or get an email link', onclick: () => shareDialog() });
  share.innerHTML = GS.icon('send', 17) + '<span class="lbl">Share</span>';
  $('#ed-download').parentNode.insertBefore(share, $('#ed-download'));

  // ---------- Share: Social Posts (Instagram + Facebook through Zapier) and email image links ----------
  async function renderBlob(d, pi, type, minW) {
    await GS.ensureFontsFor(d);
    await GS.R.preload(d);
    const scale = Math.min(Math.max(1, minW / d.w), GS.X.maxScale(d));
    const cv = GS.X.renderPage(d, d.pages[pi], scale, { flatten: type === 'jpg' });
    return GS.canvasToBlob(cv, type === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
  }
  async function shareDialog() {
    if (!E.design) return;
    E.endEdit(); E.endCrop();
    const d = E.design, pi = E.pi, ratio = d.w / d.h;
    let platforms = ['instagram', 'facebook'], busy = false;
    const prev = h('div', { class: 'dl-prev', style: { marginTop: 0 } }, h('span', { class: 'muted' }, 'Getting the preview ready…'));
    renderBlob(d, pi, 'jpg', 540).then((b) => { prev.innerHTML = ''; prev.append(h('img', { src: URL.createObjectURL(b), alt: 'What will be posted' })); }).catch(() => { prev.innerHTML = ''; });
    const cap = h('textarea', { class: 'input', id: 'sh-cap', rows: 4, placeholder: 'Say something about the cheese…' });
    const count = h('span', { class: 'muted', style: { fontSize: '12px' } });
    const chips = h('div', { class: 'chips' });
    const msg = h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '8px 0 0' } });
    const drawChips = () => {
      chips.innerHTML = '';
      [['instagram', 'Instagram'], ['facebook', 'Facebook']].forEach(([k, l]) => chips.append(h('button', { class: 'chip' + (platforms.includes(k) ? ' on' : ''), 'aria-pressed': platforms.includes(k) ? 'true' : 'false', onclick: () => { platforms = platforms.includes(k) ? platforms.filter((x) => x !== k) : platforms.concat(k); drawChips(); upd(); } }, l)));
    };
    const upd = () => {
      const n = cap.value.length, ig = platforms.includes('instagram');
      count.textContent = ig ? `${n} / ${IG_MAX}` : String(n);
      count.style.color = ig && n > IG_MAX ? 'var(--danger)' : '';
    };
    cap.addEventListener('input', upd);
    drawChips(); upd();
    const warn = platforms && (ratio < 0.8 - 0.01 || ratio > 1.91 + 0.01)
      ? h('p', { class: 'banner', style: { background: '#FFF1EC', color: '#8F2A1C' } }, 'Instagram feed posts must be between 4:5 tall and 1.91:1 wide. This design is ' + GS.sizeLabel(d) + ', so Instagram may refuse it. Facebook is fine.')
      : null;
    const sendBtn = h('button', { class: 'btn gold', onclick: () => social(true) }, GS.iconEl('send', 16), 'Post now');
    const draftBtn = h('button', { class: 'btn', onclick: () => social(false) }, 'Save as draft');
    const emailOut = h('div');
    const emailBtn = h('button', { class: 'btn', onclick: () => emailLink() }, GS.iconEl('image', 16), 'Get an image link for email');
    const body = h('div', null,
      prev,
      d.pages.length > 1 ? h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '6px 0 0' } }, `Shares page ${pi + 1} of ${d.pages.length}. Switch pages to share a different one.`) : null,
      h('div', { class: 'psec' }, h('h4', null, 'Instagram & Facebook')),
      warn,
      h('label', { class: 'flabel', for: 'sh-cap', style: { display: 'flex', justifyContent: 'space-between' } }, 'Caption', count),
      cap,
      h('span', { class: 'flabel' }, 'Post to'), chips,
      h('div', { class: 'row', style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, sendBtn, draftBtn, h('a', { class: 'btn', href: '/manager#social' }, 'Open Social Posts')),
      msg,
      h('div', { class: 'psec' }, h('h4', null, 'Email')),
      h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '0 0 8px' } }, 'Hosts the image so you can paste it into an email campaign or template.'),
      emailBtn, emailOut);
    const m = GS.modal({ title: 'Share', body, wide: true });

    function validate(post) {
      if (!platforms.length) return 'Pick Instagram, Facebook or both.';
      if (platforms.includes('instagram') && cap.value.length > IG_MAX) return `Instagram captions cap at ${IG_MAX} characters.`;
      if (post && !cap.value.trim()) return 'Add a caption before posting.';
      return null;
    }
    async function social(post) {
      if (busy) return;
      const bad = validate(post);
      if (bad) { msg.textContent = bad; msg.style.color = 'var(--danger)'; return; }
      if (post && !(await GS.confirmModal(`Post this to ${platforms.map((p) => (p === 'instagram' ? 'Instagram' : 'Facebook')).join(' and ')} now?`, 'Post now'))) return;
      busy = true; sendBtn.disabled = draftBtn.disabled = true;
      msg.style.color = ''; msg.textContent = 'Preparing the image…';
      try {
        const blob = await renderBlob(d, pi, 'jpg', 1080);
        msg.textContent = 'Uploading…';
        const up = await S.uploadBlob('social-assets', 'studio', blob);
        const { data, error } = await S.sb.from('em_social_posts').insert({ caption: cap.value.trim(), image_url: up.url, platforms, status: 'draft' }).select('id').single();
        if (error) throw new Error(error.message);
        if (!post) { GS.toast('Saved as a draft in Social Posts', 'ok'); m.close(); return; }
        msg.textContent = 'Sending to Instagram & Facebook…';
        const r = await fetch(S.SB_URL + '/functions/v1/social-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: S.SB_KEY, Authorization: 'Bearer ' + (await S.auth.token()) },
          body: JSON.stringify({ post_id: data.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) throw new Error((j.error || 'Posting failed (HTTP ' + r.status + ')') + '. It’s saved as a draft in Social Posts.');
        GS.toast('Sent. Zapier is publishing it now.', 'ok');
        m.close();
      } catch (e) {
        msg.textContent = e.message || String(e);
        msg.style.color = 'var(--danger)';
      }
      busy = false; sendBtn.disabled = draftBtn.disabled = false;
    }
    async function emailLink() {
      emailBtn.disabled = true;
      emailOut.innerHTML = '';
      emailOut.append(h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Uploading…'));
      try {
        const blob = await renderBlob(d, pi, 'png', Math.min(1200, d.w * 2));
        const up = await S.uploadBlob('email-assets', 'studio', blob.size > 9.5e6 ? await renderBlob(d, pi, 'jpg', 1200) : blob);
        const inp = h('input', { class: 'input', value: up.url, readonly: true, 'aria-label': 'Image link', onfocus: (e) => e.target.select() });
        emailOut.innerHTML = '';
        emailOut.append(h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, inp, h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(up.url); GS.toast('Link copied', 'ok'); } catch (e) { inp.select(); GS.toast('Press Ctrl+C to copy'); } } }, 'Copy')));
      } catch (e) {
        emailOut.innerHTML = '';
        emailOut.append(h('p', { style: { color: 'var(--danger)', fontSize: '12.5px' } }, e.message || String(e)));
      }
      emailBtn.disabled = false;
    }
  }
  GS.UI.shareDialog = shareDialog;
})();
