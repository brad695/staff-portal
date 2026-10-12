/* Greys Chat service worker — shows chat notifications on phones and computers.
   Registered by chat.html with scope /chat.html (served from the site root on chat.greyscheese.com
   and staff.greyscheese.com). The chat-notify edge function sends the pushes (Web Push, encrypted);
   each one is {t: title, b: body, c: conversation id, m: message id, tag}. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
    await self.registration.showNotification(d.t || 'Greys Chat', {
      body: d.b || '',
      tag,
      renotify,
      icon: '/icon-192.png',
      badge: '/chat-badge.png',
      timestamp: Date.now(),
      data: { m: d.m || null, c: d.c || null }
    });
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
