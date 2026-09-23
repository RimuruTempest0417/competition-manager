/* ============================================================
   通知 / 提醒模組 (v2.8.0)
   - 純本機提醒：狀態存在 localStorage，網頁開啟時檢查並跳出通知。
     不做 Web Push（需要 VAPID 金鑰與伺服器推播端），因此網頁完全關閉時
     不會收到通知 —— 這點在 UI 上會明確告知使用者。
   - 判斷邏輯（dueNotifications）是純函式，可在 Node 中以單元測試驗證。
   - 支援 UMD：瀏覽器掛在 window.CMNotify，Node 測試用 module.exports。
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CMNotify = factory(root);
    }
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'cm-notify';
    const REMIND_WINDOW_HOURS = 24;
    const NOTIFIED_TTL_DAYS = 30;
    const HOUR_MS = 3600000;

    const DEFAULTS = () => ({
        enabled: false,
        newCompetitions: true,
        subscriptions: {},
        seenMaxId: 0,
        notified: {}
    });

    function storage(override) {
        if (override) return override;
        try {
            if (root && root.localStorage) return root.localStorage;
        } catch (e) { /* 無痕模式等 */ }
        return null;
    }

    function loadState(store) {
        const s = storage(store);
        const base = DEFAULTS();
        if (!s) return base;

        try {
            const raw = s.getItem(STORAGE_KEY);
            if (!raw) return base;
            const parsed = JSON.parse(raw);

            return {
                enabled: !!parsed.enabled,
                newCompetitions: parsed.newCompetitions === undefined ? true : !!parsed.newCompetitions,
                subscriptions: (parsed.subscriptions && typeof parsed.subscriptions === 'object') ? parsed.subscriptions : {},
                seenMaxId: Number(parsed.seenMaxId) || 0,
                notified: (parsed.notified && typeof parsed.notified === 'object') ? parsed.notified : {}
            };
        } catch (e) {
            return base;
        }
    }

    function saveState(state, store) {
        const s = storage(store);
        if (!s) return false;
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(state));
            return true;
        } catch (e) {
            return false;
        }
    }

    function maxId(list) {
        return (list || []).reduce((max, c) => {
            const id = Number(c && c.id);
            return Number.isFinite(id) && id > max ? id : max;
        }, 0);
    }

    // 'YYYY-MM-DD' + 'HH:MM' → 本地時間毫秒（缺時間時視為當日 00:00）
    function toStartMs(date, time) {
        const d = String(date || '').slice(0, 10);
        const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;

        let hh = 0, mm = 0;
        const t = String(time || '').match(/^(\d{1,2}):(\d{2})/);
        if (t) { hh = Number(t[1]); mm = Number(t[2]); }

        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, 0, 0).getTime();
    }

    /* 決定「現在」應該跳出哪些通知（純函式）
       回傳 [{ key, tag, title, body, url }]；呼叫端負責顯示與標記。
       - 已通知過的 key 不會重複回傳（除非呼叫端沒把它寫進 state.notified）
       - 新賽事：id 大於 state.seenMaxId 者（可關閉）
       - 開賽提醒：已訂閱且在 remindWindowHours 內即將開始者 */
    function dueNotifications(state, competitions, now, options) {
        const opts = options || {};
        const windowHours = Number(opts.remindWindowHours) || REMIND_WINDOW_HOURS;
        const list = Array.isArray(competitions) ? competitions : [];
        const nowMs = now instanceof Date ? now.getTime() : Number(now);
        const notified = (state && state.notified) || {};
        const out = [];

        // 1) 新賽事發布
        if (state && state.newCompetitions) {
            const seenMax = Number(state.seenMaxId) || 0;
            // seenMaxId 為 0 代表這是第一次執行（還沒有基準），
            // 此時不發通知，只建立基準，避免第一次就跳出十幾筆「新賽事」。
            const fresh = seenMax === 0 ? [] : list.filter((c) => Number(c && c.id) > seenMax);
            if (fresh.length > 0) {
                const key = 'new:' + fresh.map((c) => Number(c.id)).sort((a, b) => a - b).join(',');
                if (!notified[key]) {
                    const names = fresh.slice(0, 3).map((c) => c.name).join('、');
                    out.push({
                        key,
                        tag: 'cm-new-competitions',
                        title: fresh.length === 1 ? '🆕 新賽事發布' : `🆕 新增 ${fresh.length} 場賽事`,
                        body: fresh.length <= 3 ? names : `${names} 等 ${fresh.length} 場`,
                        url: '/'
                    });
                }
            }
        }

        // 2) 已訂閱賽事的開賽提醒
        const subs = (state && state.subscriptions) || {};
        Object.keys(subs).forEach((id) => {
            const item = list.find((c) => String(c && c.id) === String(id));
            if (!item || !item.date) return;

            const startMs = toStartMs(item.date, item.time);
            if (startMs === null) return;

            const diffHours = (startMs - nowMs) / HOUR_MS;
            if (diffHours < 0 || diffHours > windowHours) return;   // 已開始或還沒進入提醒窗

            const key = `remind:${id}:${item.date}:${item.time || '00:00'}`;
            if (notified[key]) return;

            out.push({
                key,
                tag: `cm-remind-${id}`,
                title: '⏰ 賽事提醒',
                body: `${item.name} 將於 ${item.date}${item.time ? ' ' + item.time : ''} 開始` +
                      `（約 ${Math.max(1, Math.round(diffHours))} 小時後）`,
                url: '/'
            });
        });

        return out;
    }

    // 標記已通知，並清掉過期紀錄避免無限成長
    function markNotified(state, keys, now) {
        const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
        const notified = state.notified || (state.notified = {});

        (keys || []).forEach((k) => { notified[k] = new Date(nowMs).toISOString(); });

        const ttlMs = NOTIFIED_TTL_DAYS * 24 * HOUR_MS;
        Object.keys(notified).forEach((k) => {
            const t = Date.parse(notified[k]);
            if (!Number.isFinite(t) || nowMs - t > ttlMs) delete notified[k];
        });

        return state;
    }

    function subscriptionList(state) {
        const subs = (state && state.subscriptions) || {};
        return Object.keys(subs)
            .map((id) => Object.assign({ id }, subs[id]))
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    }

    function isSubscribed(id, store) {
        const state = loadState(store);
        return Object.prototype.hasOwnProperty.call(state.subscriptions, String(id));
    }

    function setSubscribed(id, item, store) {
        const state = loadState(store);
        if (item) {
            state.subscriptions[String(id)] = {
                name: item.name || '',
                date: item.date || '',
                time: item.time || ''
            };
        } else {
            delete state.subscriptions[String(id)];
        }
        saveState(state, store);
        return state;
    }

    // ---------- 瀏覽器端：權限與顯示 ----------
    function permissionState() {
        if (typeof root === 'undefined' || typeof root.Notification === 'undefined') return 'unsupported';
        return root.Notification.permission || 'default';
    }

    async function requestPermission() {
        if (typeof root === 'undefined' || typeof root.Notification === 'undefined') return 'unsupported';
        if (root.Notification.permission === 'granted') return 'granted';
        if (root.Notification.permission === 'denied') return 'denied';

        try {
            return await new Promise((resolve) => {
                const result = root.Notification.requestPermission(resolve);
                if (result && typeof result.then === 'function') result.then(resolve).catch(() => resolve('error'));
            });
        } catch (e) {
            return 'error';
        }
    }

    let swRegistration = null;

    function ensureServiceWorker() {
        if (!root || !root.navigator || !('serviceWorker' in root.navigator)) return Promise.resolve(null);
        if (swRegistration) return swRegistration;

        swRegistration = root.navigator.serviceWorker.register('/sw.js')
            .then((reg) => reg)
            .catch(() => null);

        return swRegistration;
    }

    // 顯示通知：優先走 Service Worker（Android 必須），否則用建構子
    async function show(title, body, url, tag) {
        const options = {
            body: body || '',
            tag: tag || 'cm-notification',
            data: { url: url || '/' },
            requireInteraction: false
        };

        const reg = await ensureServiceWorker();
        if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(title, options);
            return 'service-worker';
        }

        if (typeof root !== 'undefined' && typeof root.Notification === 'function') {
            const n = new root.Notification(title, options);
            return n ? 'constructor' : 'constructor';
        }

        throw new Error('此瀏覽器不支援通知');
    }

    /* 執行一次檢查：計算應跳出的通知 → 顯示 → 標記。
       回傳實際跳出的通知陣列（方便測試與除錯）。 */
    async function runCheck(competitions, options) {
        const opts = options || {};
        const store = opts.storage;
        const now = opts.now instanceof Date ? opts.now : new Date();
        const state = loadState(store);

        // 一律先把「看過的最大 id」推進，避免使用者關閉通知後又重新啟用時，
        // 把累積已久的所有舊賽事一次全部當成新賽事。
        const highest = maxId(competitions);
        const due = state.enabled ? dueNotifications(state, competitions, now) : [];

        const fired = [];
        for (const item of due) {
            try {
                await show(item.title, item.body, item.url, item.tag);
                fired.push(item);
            } catch (e) {
                // 顯示失敗（例如權限被拒）不應中斷流程，下一輪不會重試同一筆
                fired.push(Object.assign({ error: e.message }, item));
            }
        }

        markNotified(state, due.map((d) => d.key), now);
        if (highest > state.seenMaxId) state.seenMaxId = highest;
        saveState(state, store);

        return fired;
    }

    /* 啟動監看：載入時檢查一次，之後每 intervalMs 檢查一次，
       並在分頁重新可見時再檢查（手機切回分頁時最有用）。 */
    function startWatcher(getCompetitions, options) {
        const opts = options || {};
        const intervalMs = Number(opts.intervalMs) || 5 * 60 * 1000;

        const tick = () => {
            let list = [];
            try {
                list = (typeof getCompetitions === 'function' ? getCompetitions() : getCompetitions) || [];
            } catch (e) {
                return Promise.resolve([]);
            }
            return runCheck(list, opts);
        };

        tick();
        const timer = setInterval(tick, intervalMs);

        if (root && root.document && root.document.addEventListener) {
            root.document.addEventListener('visibilitychange', () => {
                if (!root.document.hidden) tick();
            });
        }

        return { tick, stop: () => clearInterval(timer) };
    }

    return {
        STORAGE_KEY,
        REMIND_WINDOW_HOURS,
        DEFAULTS,
        loadState,
        saveState,
        maxId,
        toStartMs,
        dueNotifications,
        markNotified,
        subscriptionList,
        isSubscribed,
        setSubscribed,
        permissionState,
        requestPermission,
        ensureServiceWorker,
        show,
        runCheck,
        startWatcher
    };
});
