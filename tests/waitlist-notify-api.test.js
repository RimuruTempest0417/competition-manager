/* v2.22.0：遞補通知開關的 API 端到端測試
 *
 * 這個設定的重點是「關掉通知 ≠ 關掉遞補」：
 *   ① 開啟（預設）→ 遞補後查推播訂閱、寫 push_log
 *   ② 關閉 → 遞補照常成立（狀態、稽核、名單都變），但**完全不碰推播**（連查訂閱都不查）
 *   ③ 關閉的狀態要寫進稽核，而且回報文字要講清楚（「依賽事設定未通知」）
 *   ④ 自動遞補（有人取消正取）也遵守同一個設定
 *   ⑤ 權限、參數、重複設定同一值、找不到賽事
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v222-notify-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            // 不限名額、不需審核、開放候補 → 方便連續遞補（通知開關的行為才是主角）
            { id: 611, name: '通知開關賽', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: false, waitlist_enabled: true, waitlist_notify: true }
        ],
        registrations: [
            { id: 1000, competition_id: 611, user_id: 80, username: 'taken', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            { id: 1001, competition_id: 611, user_id: 81, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z' },
            { id: 1002, competition_id: 611, user_id: 82, username: 'waitB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z' },
            { id: 1003, competition_id: 611, user_id: 83, username: 'waitC', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T03:00:00Z' },
            { id: 1004, competition_id: 611, user_id: 84, username: 'waitD', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T04:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        // 故意放一筆訂閱：開啟通知時才會被查到（關閉時「連查都不查」是這版的驗收重點）
        push_subscriptions: [{ id: 1, user_id: 82, endpoint: 'https://127.0.0.1:9/abc', p256dh: 'k', auth: 'a', is_active: true }],
        push_log: []
    },
    nextId: { competitions: 700, registrations: 2000, audit_logs: 900, error_logs: 900, push_log: 100, push_subscriptions: 10 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 81, username: 'waitA', role: 'user' }, SECRET);

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

const teamsOf = async () => (await (await api('/api/competitions/611/teams', { token: adminToken() })).json());
const regOf = (id) => state.tables.registrations.find((r) => r.id === Number(id));
const pushLogs = (kind) => (state.tables.push_log || []).filter((l) => !kind || l.kind === kind);
/** 這一段期間有沒有「查推播訂閱」的請求（關閉通知時必須是 0） */
const subscriptionQueries = () => state.log.filter((l) => /push_subscriptions/.test(l.url)).length;
const lastAudit = () => (state.tables.audit_logs || [])[(state.tables.audit_logs || []).length - 1] || {};

test('v2.22.0：名單端點回報通知開關（預設開啟）', async () => {
    const body = await teamsOf();
    assert.strictEqual(body.notify_schema_ready, true);
    assert.strictEqual(body.notify_on_promote, true);
});

test('v2.22.0：通知開啟時，指定遞補會查推播訂閱並寫 push_log', async () => {
    const before = subscriptionQueries();
    const res = await api('/api/registrations/1002/promote', { method: 'POST', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.notify_disabled, false);
    assert.doesNotMatch(body.message, /未通知/);
    assert.ok(subscriptionQueries() > before, '開啟通知時應該要查推播訂閱');
    assert.strictEqual(pushLogs('waitlist_promoted').length, 1);
    assert.strictEqual(regOf(1002).status, 'confirmed');
});

test('v2.22.0：關閉通知 → 寫入欄位並留稽核', async () => {
    const res = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: false } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.message, /已關閉/);
    assert.strictEqual(state.tables.competitions.find((c) => c.id === 611).waitlist_notify, false);
    assert.strictEqual(lastAudit().action, 'WAITLIST_NOTIFY');
    assert.match(lastAudit().details, /開啟 → 關閉/);

    const teams = await teamsOf();
    assert.strictEqual(teams.notify_on_promote, false);
});

test('v2.22.0：關閉後「遞補下一位」→ 照樣遞補，但完全不碰推播', async () => {
    const beforeQueries = subscriptionQueries();
    const pushBefore = pushLogs('waitlist_promoted').length;

    const res = await api('/api/competitions/611/registrations/promote', { method: 'POST', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.notify_disabled, true);
    assert.match(body.message, /依賽事設定未通知/);

    // 遞補本身要成立
    assert.strictEqual(regOf(1001).status, 'confirmed');
    assert.strictEqual(body.registration.username, 'waitA');
    // 但推播完全沒動
    assert.strictEqual(subscriptionQueries(), beforeQueries, '關閉通知時不該查推播訂閱');
    assert.strictEqual(pushLogs('waitlist_promoted').length, pushBefore, '關閉通知時不該寫 push_log');
    // 稽核要講清楚為什麼沒通知
    const audit = (state.tables.audit_logs || []).filter((l) => l.action === 'PROMOTE_WAITLIST').pop();
    assert.match(audit.details, /未通知（依賽事設定）/);
});

test('v2.22.0：關閉後「有人取消正取 → 自動遞補」也不通知', async () => {
    const beforeQueries = subscriptionQueries();
    const pushBefore = pushLogs('waitlist_promoted').length;

    const res = await api('/api/registrations/1000', { method: 'DELETE', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.promoted, '取消正取應該要自動遞補');
    assert.strictEqual(body.promoted.notify_disabled, true);
    assert.strictEqual(regOf(1003).status, 'confirmed');

    assert.strictEqual(subscriptionQueries(), beforeQueries, '自動遞補同樣不該查推播訂閱');
    assert.strictEqual(pushLogs('waitlist_promoted').length, pushBefore);
    const audit = (state.tables.audit_logs || []).filter((l) => l.action === 'AUTO_PROMOTE_WAITLIST').pop();
    assert.match(audit.details, /未通知（依賽事設定）/);
});

test('v2.22.0：重新開啟通知 → 之後遞補又會通知', async () => {
    const res = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: true } });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /已開啟/);
    assert.strictEqual((await teamsOf()).notify_on_promote, true);

    const before = subscriptionQueries();
    const pushBefore = pushLogs('waitlist_promoted').length;
    const res2 = await api('/api/competitions/611/registrations/promote', { method: 'POST', token: adminToken() });
    const body2 = await res2.json();
    assert.strictEqual(body2.notify_disabled, false);
    assert.strictEqual(regOf(1004).status, 'confirmed');
    assert.ok(subscriptionQueries() > before);
    assert.strictEqual(pushLogs('waitlist_promoted').length, pushBefore + 1);
});

test('v2.22.0：設定同一個值 → 不重複寫稽核', async () => {
    const auditBefore = (state.tables.audit_logs || []).length;
    const res = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: true } });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /已是開啟/);
    assert.strictEqual((state.tables.audit_logs || []).length, auditBefore);
});

test('v2.22.0：權限與參數檢查', async () => {
    const asUser = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: userToken(), body: { notify: false } });
    assert.strictEqual(asUser.status, 403);

    const anon = await api('/api/competitions/611/waitlist/notify', { method: 'POST', body: { notify: false } });
    assert.strictEqual(anon.status, 401);

    const badType = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: 'no' } });
    assert.strictEqual(badType.status, 400);

    const missing = await api('/api/competitions/611/waitlist/notify', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(missing.status, 400);

    const notFound = await api('/api/competitions/9999/waitlist/notify', { method: 'POST', token: adminToken(), body: { notify: true } });
    assert.strictEqual(notFound.status, 404);
});
