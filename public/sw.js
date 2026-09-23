/* 極簡 Service Worker (v2.10.0)
   ============================================================
   1) 顯示通知：Android Chrome 等平台不允許 new Notification()，
      必須由 Service Worker 的 registration.showNotification() 顯示。
   2) Web Push 推播訂閱 (v2.10.0)：接收伺服器推播（新賽事、開賽前提醒），
      即使網頁完全關閉也能收到。推播由後端 /api/cron/reminders 發送。
   ============================================================ */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Web Push：接收到伺服器推播時顯示通知（v2.10.0）
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { title: '比賽管理系統', body: event.data ? event.data.text() : '有新通知' };
    }

    const title = payload.title || '比賽管理系統';
    const options = {
        body: payload.body || '',
        tag: payload.tag || 'cm-push',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        data: { url: payload.url || '/' }
    };

    event.waitUntil(
        self.registration.showNotification(title, options).catch(() => null)
    );
});

// 點通知 → 聚焦既有分頁（沒開就開新分頁）
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const target = (event.notification.data && event.notification.data.url) || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) {
                    if ('navigate' in client) client.navigate(target);
                    return client.focus();
                }
            }
            return self.clients.openWindow ? self.clients.openWindow(target) : null;
        })
    );
});
