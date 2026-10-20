/* Greys Chat service worker — shows chat notifications on phones and computers.
   Registered by chat.html with scope /chat.html (served from the site root on chat.greyscheese.com
   and staff.greyscheese.com). The chat-notify edge function sends the pushes (Web Push, encrypted);
   each one is {t: title, b: body, c: conversation id, m: message id, tag}. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* TEMPORARY (2026-10-19): report every push this device receives, and whether showing it worked, to the
   chat-push-diag edge function (Maverick's phone stayed quiet while Google accepted the pushes). Remove
   with the chat_push_diag table once that's solved. */
const DIAG = 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/chat-push-diag';
async function diag(info) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    await fetch(DIAG, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'sw', origin: self.location.origin, endpoint: sub ? sub.endpoint : null, info }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (_) {}
}

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { b: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const tag = d.tag || 'greys-chat';
    // one notification per conversation (newest message). If the open chat tab already showed this
    // exact message, replace it quietly instead of buzzing twice; otherwise alert.
    let renotify = true;
    try {
      const shown = await self.registration.getNotifications({ tag });
      if (shown.some(n => n.data && n.data.m && n.data.m === d.m)) renotify = false;
    } catch (_) {}
    let ok = true, err = null;
    try {
      await self.registration.showNotification(d.t || 'Greys Chat', {
        body: d.b || '',
        tag,
        renotify,
        icon: '/icon-192.png',
        badge: '/chat-badge.png',
        timestamp: Date.now(),
        data: { m: d.m || null, c: d.c || null }
      });
    } catch (x) { ok = false; err = String(x && x.name ? x.name + ': ' + x.message : x).slice(0, 300); }
    let showing = null;
    try { showing = (await self.registration.getNotifications({ tag })).length; } catch (_) {}
    await diag({ v: 'sw-diag-1', m: d.m || null, tag, ok, err, showing, renotify,
      perm: (self.Notification && self.Notification.permission) || null, data: !!e.data });
  })());
});

const isChatUrl = u => {
  try {
    const p = new URL(u).pathname;
    return p.endsWith('/chat.html') || (/^chat\./.test(self.location.hostname) && (p === '/' || p === '/index.html'));
  } catch (_) { return false; }
};

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const chat = wins.find(w => isChatUrl(w.url));
    if (chat) {
      try { await chat.focus(); } catch (_) {}
      chat.postMessage({ type: 'open', m: d.m, c: d.c });
      return;
    }
    const hash = d.m && !/^test/.test(d.m) ? '#' + d.m + (d.c ? '@' + d.c : '') : '';
    await self.clients.openWindow('/chat.html' + hash);
  })());
});
