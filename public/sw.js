/* 極簡 Service Worker (v2.8.0)
   ============================================================
   存在的唯一目的：在 Android Chrome 等平台顯示通知。
   這些平台不允許 new Notification()，必須由 Service Worker 的
   registration.showNotification() 顯示。

   本專案「不做」Web Push 訂閱（那需要 VAPID 金鑰、伺服器推播端與
   額外資料表），因此這裡不處理 push 事件；提醒是在網頁開啟時由
   /js/notify.js 檢查並顯示的本機通知。
   ============================================================ */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
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
