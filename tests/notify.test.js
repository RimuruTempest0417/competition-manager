const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CMNotify = require(path.join(__dirname, '..', 'public', 'js', 'notify.js'));

// 假的 localStorage（Node 端沒有 localStorage）
function fakeStore(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        _dump: () => Object.fromEntries(map)
    };
}

const COMPETITIONS = [
    { id: 10, name: '舊賽事', date: '2026-09-01' },
    { id: 11, name: '新賽事 A', date: '2026-09-25', time: '09:00' },
    { id: 12, name: '新賽事 B', date: '2026-09-26', time: '10:00' }
];

test('loadState / saveState：預設值、壞資料容錯、寫回', () => {
    const empty = fakeStore();
    assert.deepStrictEqual(CMNotify.loadState(empty), {
        enabled: false, newCompetitions: true, subscriptions: {}, seenMaxId: 0, notified: {}
    });

    const broken = fakeStore({ 'cm-notify': 'not-json{{' });
    assert.strictEqual(CMNotify.loadState(broken).enabled, false, '壞掉的資料應回預設值');

    const partial = fakeStore({ 'cm-notify': JSON.stringify({ enabled: true, subscriptions: { 11: { name: 'A' } } }) });
    const s = CMNotify.loadState(partial);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.newCompetitions, true, '未設定的欄位應補預設值');
    assert.strictEqual(s.seenMaxId, 0);

    s.seenMaxId = 12;
    assert.strictEqual(CMNotify.saveState(s, partial), true);
    assert.strictEqual(CMNotify.loadState(partial).seenMaxId, 12);
});

test('maxId / toStartMs：基準值與時間解析', () => {
    assert.strictEqual(CMNotify.maxId(COMPETITIONS), 12);
    assert.strictEqual(CMNotify.maxId([]), 0);
    assert.strictEqual(CMNotify.maxId([{ id: 'x' }, { id: null }]), 0, '非數字 id 應忽略');

    const withTime = CMNotify.toStartMs('2026-09-25', '09:30');
    assert.strictEqual(new Date(withTime).getHours(), 9);
    assert.strictEqual(new Date(withTime).getMinutes(), 30);

    const noTime = CMNotify.toStartMs('2026-09-25', '');
    assert.strictEqual(new Date(noTime).getHours(), 0, '缺時間視為當日 00:00');

    assert.strictEqual(CMNotify.toStartMs('', ''), null);
    assert.strictEqual(CMNotify.toStartMs('2026/09/25', ''), null, '格式不符應回 null');
});

test('dueNotifications：新賽事以 id 基準判斷、可關閉、不重複', () => {
    const base = CMNotify.DEFAULTS();
    base.seenMaxId = 10;

    const due = CMNotify.dueNotifications(base, COMPETITIONS, new Date('2026-09-20T00:00:00'));
    assert.strictEqual(due.length, 1, '兩筆新賽事應合併成一則通知');
    assert.match(due[0].title, /新增 2 場賽事/);
    assert.match(due[0].body, /新賽事 A、新賽事 B/);
    assert.strictEqual(due[0].key, 'new:11,12');

    // 已通知過就不會再出現
    const marked = CMNotify.markNotified(base, due.map((d) => d.key), new Date('2026-09-20T00:00:00'));
    assert.deepStrictEqual(CMNotify.dueNotifications(marked, COMPETITIONS, new Date('2026-09-20T00:05:00')), []);

    // 關閉新賽事通知
    const off = Object.assign(CMNotify.DEFAULTS(), { seenMaxId: 10, newCompetitions: false });
    assert.strictEqual(CMNotify.dueNotifications(off, COMPETITIONS, new Date('2026-09-20T00:00:00')).length, 0);

    // 第一次執行（尚無基準）不應把既有賽事全部當成新賽事
    const firstRun = CMNotify.DEFAULTS();
    assert.strictEqual(CMNotify.dueNotifications(firstRun, COMPETITIONS, new Date('2026-09-20T00:00:00')).length, 0);
});

test('dueNotifications：訂閱賽事的開賽提醒（24 小時窗、不重複、不誤報）', () => {
    const state = CMNotify.DEFAULTS();
    state.seenMaxId = 12;
    state.newCompetitions = false;
    state.subscriptions = { 11: { name: '新賽事 A', date: '2026-09-25', time: '09:00' } };

    // 還有 9 小時 → 應提醒
    const due9 = CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-25T00:00:00'));
    assert.strictEqual(due9.length, 1);
    assert.strictEqual(due9[0].tag, 'cm-remind-11');
    assert.match(due9[0].body, /新賽事 A 將於 2026-09-25 09:00 開始（約 9 小時後）/);

    // 還有 30 小時 → 還沒進入提醒窗
    assert.strictEqual(CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-24T03:00:00')).length, 0);

    // 已經開始（過去） → 不提醒
    assert.strictEqual(CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-25T10:00:00')).length, 0);

    // 剛好 24 小時 → 視為進入提醒窗
    assert.strictEqual(CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-24T09:00:00')).length, 1);

    // 訂閱清單裡有但資料已被刪除 → 不提醒也不報錯
    state.subscriptions[999] = { name: '已刪除', date: '2026-09-25', time: '09:00' };
    assert.strictEqual(CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-25T00:00:00')).length, 1);
});

test('dueNotifications：同時有新賽事與訂閱提醒時兩則都會回傳', () => {
    const state = CMNotify.DEFAULTS();
    state.seenMaxId = 10;
    state.subscriptions = { 11: { name: '新賽事 A', date: '2026-09-25', time: '09:00' } };

    const due = CMNotify.dueNotifications(state, COMPETITIONS, new Date('2026-09-25T00:00:00'));
    assert.strictEqual(due.length, 2);
    assert.deepStrictEqual(due.map((d) => d.key).sort(), ['new:11,12', 'remind:11:2026-09-25:09:00']);
});

test('markNotified：標記、清理過期紀錄', () => {
    const state = CMNotify.DEFAULTS();
    const now = new Date('2026-09-25T00:00:00');
    state.notified = { 'old:1': '2026-01-01T00:00:00.000Z' };

    CMNotify.markNotified(state, ['new:11'], now);

    assert.ok(state.notified['new:11'], '新標記應存在');
    assert.strictEqual(state.notified['old:1'], undefined, '超過 30 天的紀錄應被清掉');
});

test('訂閱的存取與清單排序', () => {
    const store = fakeStore();

    assert.strictEqual(CMNotify.isSubscribed(11, store), false);
    CMNotify.setSubscribed(12, { name: 'B', date: '2026-09-26', time: '10:00' }, store);
    CMNotify.setSubscribed(11, { name: 'A', date: '2026-09-25', time: '09:00' }, store);

    assert.strictEqual(CMNotify.isSubscribed(11, store), true);
    assert.deepStrictEqual(CMNotify.subscriptionList(CMNotify.loadState(store)).map((s) => s.id), ['11', '12'], '應依日期排序');

    CMNotify.setSubscribed(11, null, store);
    assert.strictEqual(CMNotify.isSubscribed(11, store), false);
    assert.strictEqual(CMNotify.subscriptionList(CMNotify.loadState(store)).length, 1);
});

test('runCheck：更新基準、標記已通知、顯示失敗不中斷流程', async () => {
    const store = fakeStore();
    const state = CMNotify.loadState(store);
    state.enabled = true;
    state.seenMaxId = 10;
    CMNotify.saveState(state, store);

    // Node 環境沒有 Notification / Service Worker，show() 會失敗，
    // 這裡要驗證的是「書籤簿記」與「失敗不中斷」：
    const fired = await CMNotify.runCheck(COMPETITIONS, {
        storage: store,
        now: new Date('2026-09-25T00:00:00')
    });

    assert.ok(fired.length >= 1, '應嘗試顯示新賽事通知');
    assert.ok(fired.every((f) => f.error), 'Node 環境下顯示必然失敗，應以 error 回報而非拋出');

    const after = CMNotify.loadState(store);
    assert.strictEqual(after.seenMaxId, 12, '看過的最大 id 應被推進');
    assert.ok(Object.keys(after.notified).some((k) => k.startsWith('new:')), '應標記已通知');

    // 關閉通知時不應嘗試顯示，但基準仍要推進
    const store2 = fakeStore();
    const s2 = CMNotify.loadState(store2);
    s2.seenMaxId = 10;
    s2.enabled = false;
    CMNotify.saveState(s2, store2);

    const fired2 = await CMNotify.runCheck(COMPETITIONS, { storage: store2, now: new Date('2026-09-25T00:00:00') });
    assert.strictEqual(fired2.length, 0, '未啟用時不顯示任何通知');
    assert.strictEqual(CMNotify.loadState(store2).seenMaxId, 12, '未啟用時仍應建立基準，避免日後一次灌出大量通知');
});

/* ---------- v2.11.0：iOS / PWA 推播能力判斷 ---------- */

function fakeWin(opts) {
    const o = opts || {};
    const win = {
        navigator: {
            userAgent: o.ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            maxTouchPoints: o.maxTouchPoints === undefined ? 0 : o.maxTouchPoints,
            serviceWorker: o.serviceWorker === false ? undefined : {},
            standalone: o.standaloneFlag === true ? true : undefined
        },
        matchMedia: (q) => ({ matches: q.indexOf('standalone') !== -1 && !!o.displayStandalone })
    };
    if (o.pushManager !== false) win.PushManager = function PushManager() {};
    if (o.notification !== false) win.Notification = { permission: o.permission || 'default' };
    return win;
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_OS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

test('isIosDevice：iPhone / iPad / iPadOS 13+ 偽裝成 Mac 的判斷', () => {
    assert.strictEqual(CMNotify.isIosDevice({ userAgent: IPHONE_UA, maxTouchPoints: 5 }), true);
    // iPadOS 13+ 的 Safari 會回報 Macintosh，必須靠觸控點數辨識
    assert.strictEqual(CMNotify.isIosDevice({ userAgent: IPAD_OS_UA, maxTouchPoints: 5 }), true);
    assert.strictEqual(CMNotify.isIosDevice({ userAgent: IPAD_OS_UA, maxTouchPoints: 0 }), false, '真正的 macOS 不該被誤判');
    assert.strictEqual(CMNotify.isIosDevice({ userAgent: ANDROID_UA, maxTouchPoints: 5 }), false);
    assert.strictEqual(CMNotify.isIosDevice({}), false);
});

test('isStandalone：iOS 旗標與 display-mode 都要認', () => {
    assert.strictEqual(CMNotify.isStandalone(fakeWin({ standaloneFlag: true })), true);
    assert.strictEqual(CMNotify.isStandalone(fakeWin({ displayStandalone: true, ua: ANDROID_UA })), true);
    assert.strictEqual(CMNotify.isStandalone(fakeWin({ ua: ANDROID_UA })), false);
    assert.strictEqual(CMNotify.isStandalone(null), false, '沒有 window 時不應拋錯');
});

test('pushSupportState：iOS 分頁回報「需加入主畫面」而不是「不支援」', () => {
    // iOS Safari 分頁：沒有 PushManager / Notification，但錯誤訊息必須是可操作的那一種
    const iosTab = CMNotify.pushSupportState(fakeWin({ ua: IPHONE_UA, maxTouchPoints: 5, pushManager: false, notification: false }));
    assert.strictEqual(iosTab.level, 'ios-needs-homescreen');
    assert.strictEqual(iosTab.canSubscribe, false);

    // 加入主畫面後（standalone）且瀏覽器有 API → 可用
    const iosApp = CMNotify.pushSupportState(fakeWin({ ua: IPHONE_UA, maxTouchPoints: 5, standaloneFlag: true, permission: 'granted' }));
    assert.strictEqual(iosApp.level, 'ok');
    assert.strictEqual(iosApp.canSubscribe, true);

    // Android Chrome → 可用
    assert.strictEqual(CMNotify.pushSupportState(fakeWin({ ua: ANDROID_UA, maxTouchPoints: 5 })).level, 'ok');

    // 桌機不支援 Push API → 不支援
    assert.strictEqual(CMNotify.pushSupportState(fakeWin({ pushManager: false })).level, 'unsupported');

    // 權限被拒 → 要提示去設定開啟
    assert.strictEqual(CMNotify.pushSupportState(fakeWin({ ua: ANDROID_UA, permission: 'denied' })).level, 'denied');
});
