/* GREYS Studio (staff portal) — persistence on the portal's Supabase project.
   Tables studio_designs / studio_uploads / studio_brand and the public bucket studio-assets, all managers-only
   (is_app_admin). Same interface as store.js so the editor code is shared with the claude.ai version. */
(function () {
  const GS = window.GS;
  const SB_URL = 'https://vdvtrevhqalmjwhjhjug.supabase.co';
  const SB_KEY = 'sb_publishable_LnlevWReed7K8cFk_f_Mxg_UywktQ5_';
  const MANAGER_EMAIL = 'manager@greyscheese.com';
  const BUCKET = 'studio-assets';
  const S = (GS.Store = { mode: 'connecting', caps: {}, designs: [], uploads: [], brand: null, designsLoaded: false, slow: false, readOnly: false, portal: true, SB_URL, SB_KEY });
  const sb = window.supabase && window.supabase.createClient ? window.supabase.createClient(SB_URL, SB_KEY) : null;
  S.sb = sb;

  // ---------- sign-in (shared with the manager console: same account, same browser session) ----------
  let release;
  const authed = new Promise((r) => (release = r));
  async function isAdmin() {
    const { data, error } = await sb.rpc('is_app_admin');
    return !error && data === true;
  }
  S.auth = {
    available: !!sb,
    async check() {
      if (!sb) return false;
      const { data } = await sb.auth.getSession();
      if (!data || !data.session) return false;
      return isAdmin();
    },
    async signIn(pw) {
      const { error } = await sb.auth.signInWithPassword({ email: MANAGER_EMAIL, password: pw });
      if (error) throw new Error('Incorrect password');
      if (!(await isAdmin())) { await sb.auth.signOut({ scope: 'local' }); throw new Error('That account is not an approved admin.'); }
    },
    done: () => release(),
    async token() {
      const { data } = await sb.auth.getSession();
      return data && data.session ? data.session.access_token : SB_KEY;
    },
  };

  const iso = (ms) => new Date(ms || Date.now()).toISOString();
  const ms = (t) => (t ? Date.parse(t) : 0);
  const metaOf = (r) => ({ id: r.id, name: r.name, w: r.w, h: r.h, unit: r.unit, kind: r.kind, pageCount: r.page_count, thumb: r.thumb, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) });

  async function loadDesigns() {
    const { data, error } = await sb.from('studio_designs').select('id,name,w,h,unit,kind,page_count,thumb,created_at,updated_at').order('updated_at', { ascending: false }).limit(300);
    if (error) { S.dbError = error.message; console.warn(error); }
    else { S.designs = (data || []).map(metaOf); S.dbError = null; }
    S.designsLoaded = true;
    GS.bus.emit('designs');
  }
  async function loadUploads() {
    const { data, error } = await sb.from('studio_uploads').select('id,url,w,h,name,created_at').order('created_at', { ascending: false }).limit(600);
    if (!error) { S.uploads = (data || []).map((u) => ({ id: u.id, ref: u.url, w: u.w, h: u.h, name: u.name, createdAt: ms(u.created_at) })); GS.bus.emit('uploads'); }
  }
  async function loadBrand() {
    const { data, error } = await sb.from('studio_brand').select('colors,logos').eq('id', 'kit').maybeSingle();
    if (!error) { S.brand = data ? { colors: data.colors || [], logos: data.logos || [] } : null; GS.bus.emit('brand'); }
  }
  S.refresh = GS.debounce(() => { if (S.mode === 'cloud') { loadDesigns(); loadUploads(); loadBrand(); } }, 400);

  S.ready = (async () => {
    await authed;
    S.mode = 'cloud';
    S.caps = { downloads: { save: anchorSave }, sample: ai, assets: true };
    await Promise.all([loadDesigns(), loadUploads(), loadBrand()]);
    GS.bus.emit('store');
    window.addEventListener('focus', () => S.refresh());
  })();

  // ---------- designs ----------
  const queues = {};
  const enqueue = (id, job) => (queues[id] = (queues[id] || Promise.resolve()).catch(() => {}).then(job));

  S.getDesign = async function (id) {
    await S.ready;
    const { data, error } = await sb.from('studio_designs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { id: data.id, name: data.name, w: data.w, h: data.h, unit: data.unit, kind: data.kind, createdAt: ms(data.created_at), pages: data.pages || [] };
  };
  S.saveDesign = function (design, thumb) {
    const id = design.id;
    const pages = GS.clone(design.pages);
    const now = Date.now();
    const row = { id, name: design.name || 'Untitled design', w: Math.round(design.w), h: Math.round(design.h), unit: design.unit || 'px', kind: design.kind || '', page_count: pages.length, thumb: thumb || '', pages, created_at: iso(design.createdAt || now), updated_at: iso(now) };
    return enqueue(id, async () => {
      await S.ready;
      if (JSON.stringify(pages).length > 4e6) { const e = new Error('This design is too big to save. Split it into two designs.'); e.code = 'too_big'; throw e; }
      const { error } = await sb.from('studio_designs').upsert(row, { onConflict: 'id' });
      if (error) { if (/row-level security|permission/i.test(error.message)) S.readOnly = true; throw new Error(error.message); }
      const meta = metaOf(Object.assign({}, row, { created_at: row.created_at, updated_at: row.updated_at }));
      S.designs = [meta].concat(S.designs.filter((d) => d.id !== id));
      GS.bus.emit('designs');
      return meta;
    });
  };
  S.deleteDesign = async function (id) {
    await S.ready;
    const { error } = await sb.from('studio_designs').delete().eq('id', id);
    if (error) throw new Error(error.message);
    S.designs = S.designs.filter((d) => d.id !== id);
    GS.bus.emit('designs');
  };

  // ---------- images ----------
  // Downscale big photos, turn SVG / HEIC / GIF into PNG or JPEG the bucket accepts.
  async function normalizeImage(file) {
    const { img, url } = await GS.loadImageFromBlob(file);
    let iw = img.naturalWidth || 1200, ih = img.naturalHeight || 1200;
    const isSvg = file.type === 'image/svg+xml';
    const MAX = isSvg ? 2400 : 3200;
    if (isSvg && Math.max(iw, ih) < 1200) { const k = 1200 / Math.max(iw, ih); iw *= k; ih *= k; }
    const sc = Math.min(1, MAX / Math.max(iw, ih));
    if (!isSvg && sc === 1 && /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 6e6) return { blob: file, img, w: iw, h: ih, url };
    const cv = document.createElement('canvas');
    cv.width = Math.round(iw * sc); cv.height = Math.round(ih * sc);
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, cv.width, cv.height);
    const png = isSvg || /png|gif|webp/.test(file.type);
    const blob = await GS.canvasToBlob(cv, png ? 'image/png' : 'image/jpeg', 0.9);
    URL.revokeObjectURL(url);
    const r = await GS.loadImageFromBlob(blob);
    return { blob, img: r.img, w: cv.width, h: cv.height, url: r.url };
  }
  S.uploadBlob = async function (bucket, folder, blob) {
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'jpg';
    const path = `${folder}/${new Date().toISOString().slice(0, 10)}/${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (error) throw new Error('Upload failed: ' + error.message);
    return { path, url: sb.storage.from(bucket).getPublicUrl(path).data.publicUrl };
  };
  S.putImage = async function (file, opts = {}) {
    await S.ready;
    if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
    if (file.size > 40e6) throw new Error('That image is over 40 MB. Shrink it first.');
    const n = await normalizeImage(file);
    const up = await S.uploadBlob(BUCKET, 'uploads', n.blob);
    GS.R.seedImg(up.url, n.img);
    const rec = { ref: up.url, w: Math.round(n.w), h: Math.round(n.h), name: (file.name || 'Image').slice(0, 80), createdAt: Date.now() };
    if (opts.library !== false) {
      const { data, error } = await sb.from('studio_uploads').insert({ path: up.path, url: up.url, w: rec.w, h: rec.h, name: rec.name }).select('id').single();
      if (!error && data) rec.id = data.id;
      S.uploads = [rec].concat(S.uploads);
      GS.bus.emit('uploads');
    }
    return rec;
  };
  S.removeUpload = async function (rec) {
    if (rec.id) { const { error } = await sb.from('studio_uploads').delete().eq('id', rec.id); if (error) throw new Error(error.message); }
    S.uploads = S.uploads.filter((u) => u.ref !== rec.ref);
    GS.bus.emit('uploads');
  };
  S.resolveURL = async function (ref) {
    if (!ref) return null;
    if (ref.startsWith('p:')) return 'photos/' + ref.slice(2);
    if (ref.startsWith('g:')) return 'graphics/' + ref.slice(2);
    if (/^(a|d):/.test(ref)) return null;
    return ref;
  };

  // ---------- brand kit ----------
  S.saveBrand = async function (kit) {
    S.brand = kit;
    GS.bus.emit('brand');
    await S.ready;
    const { error } = await sb.from('studio_brand').upsert({ id: 'kit', colors: kit.colors || [], logos: kit.logos || [], updated_at: iso() }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  };
  S.pref = function (k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem('gs:' + k));
      localStorage.setItem('gs:' + k, JSON.stringify(v));
    } catch (e) { return null; }
  };

  // ---------- downloads: a normal page can save files itself ----------
  async function anchorSave({ filename, data }) {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { status: 'saved' };
  }

  // ---------- Magic Write: the studio-ai edge function (Claude, managers only) ----------
  const ai = {
    async json(prompt, opts = {}) {
      const kind = opts.kind === 'rewrite' ? 'rewrite' : 'ideas';
      let res, j = {};
      try {
        res = await fetch(SB_URL + '/functions/v1/studio-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + (await S.auth.token()) },
          body: JSON.stringify({ kind, prompt: String(prompt).slice(0, 8000) }),
        });
        j = await res.json().catch(() => ({}));
      } catch (e) { throw { code: 'upstream_error', message: String(e) }; }
      if (!res.ok || !j.ok) throw { code: res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'not_granted' : 'upstream_error', message: j.error || 'HTTP ' + res.status };
      return kind === 'rewrite' ? j.data : (j.data && j.data.options) || [];
    },
  };
})();
