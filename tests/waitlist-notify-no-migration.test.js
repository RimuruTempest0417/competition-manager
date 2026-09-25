/* v2.22.0：尚未執行 waitlist_notify migration 時的降級行為（獨立成檔！）
 *
 * 為什麼要獨立：欄位探測結果在行程內快取，同一個行程不會中途翻轉。
 *
 * 沒執行 migration 時該有的樣子：
 *   ① 一律視為「通知＝開啟」——既有行為完全不變，不會因為少一個欄位就靜靜地不通知
 *   ② 名單端點回報 notify_schema_ready=false（介面把開關變成停用並說明要先執行 migration）
 *   ③ 調整通知設定的端點回 503＋檔名指引
 *   ④ 候補異動紀錄照常可用（它不需要新欄位）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v222-notify-nomig-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        // 這一場「沒有」waitlist_notify 欄位（其他審核／候補欄位都在）
        competitions: [
            { id: 631, name: '舊資料庫賽事', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: false, waitlist_enabled: true }
        ],
        registrations: [
            { id: 1201, competition_id: 631, user_id: 91, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [{ id: 1, user_id: 91, endpoint: 'https://127.0.0.1:9/abc', p256dh: 'k', auth: 'a', is_active: true }],
        push_log: []
    },
    // 讓假 Supabase 假裝 competitions 沒有這個欄位（含 select 帶到時要回 42703）
    missingColumns: { competitions: ['waitlist_notify'] },
    nextId: { competitions: 700, registrations: 2000, audit_logs: 900, error_logs: 900, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    if (server) server.close();
    if (stub) stub.close();
});

const api = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});

test('v2.22.0（未執行 migration）：名單端點回報「設定停用、一律通知」', async () => {
    const res = await api('/api/competitions/631/teams', { token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, true);          // v2.20.0 的功能不受影響
    assert.strictEqual(body.notify_schema_ready, false);
    assert.strictEqual(body.notify_on_promote, true);     // 沒欄位＝一律通知（既有行為）
});

test('v2.22.0（未執行 migration）：遞補照常通知（不會因為少一個欄位就靜靜不通知）', async () => {
    const before = state.log.filter((l) => /push_subscriptions/.test(l.url)).length;
    const res = await api('/api/registrations/1201/promote', { method: 'POST', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.notify_disabled, false);
    assert.doesNotMatch(body.message, /未通知/);
    assert.ok(state.log.filter((l) => /push_subscriptions/.test(l.url)).length > before);
    assert.strictEqual((state.tables.push_log || []).filter((l) => l.kind === 'waitlist_promoted').length, 1);
});

test('v2.22.0（未執行 migration）：調整通知設定回 503＋檔名指引', async () => {
    const res = await api('/api/competitions/631/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: false } });
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /2026-09-26-v2\.22\.0-waitlist-notify\.sql/);
    assert.match(body.error, /一律視為「通知＝開啟」/);
});

test('v2.22.0（未執行 migration）：候補異動紀錄照常可用', async () => {
    const res = await api('/api/competitions/631/waitlist/history', { token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.logs));
    assert.ok(body.logs.length >= 1, '剛才的遞補應該被記進稽核日誌');
    assert.strictEqual(body.logs[0].action, 'PROMOTE_WAITLIST');
});
