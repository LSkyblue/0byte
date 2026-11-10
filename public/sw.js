/* 手机上的新消息提醒：App 在后台或关着时，电脑推过来一条，这里弹通知；点通知打开那个会话。
   不缓存任何东西（页面还是每次跟电脑核对新版本）。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  /* iPhone 要求每次推送都要弹出来（不弹几次就会被取消订阅），所以这里不判断页面开没开——开着的时候电脑本来就不推 */
  e.waitUntil(self.registration.showNotification(d.title || '0byte', {   // 别传空标题：试过，iPhone 上之后就收不到了
    body: d.body || '有新消息',
    tag: d.chat ? 'chat-' + d.chat : 'cc',
    renotify: true,
    icon: '/apple-touch-icon.png?v=2',
    badge: '/favicon-64.png?v=2',
    data: { chat: d.chat || null },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chat = e.notification.data?.chat || null;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { await c.focus(); if (chat) c.postMessage({ type: 'open-chat', chat }); return; }
    }
    await self.clients.openWindow(chat ? '/#chat=' + encodeURIComponent(chat) : '/');
  })());
});
