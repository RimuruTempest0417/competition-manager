/* v2.26.0：推播失敗明細與重送的 API 測試
 *
 * 驗的是「失敗看得出來、重送送對人」：
 *   ① 推播失敗時 push_log 會留下失敗筆數、原因、送出的內容與對象
 *   ② 看板端點會回報明細是否可用（detail_ready）
 *   ③ 重送只送給原本的對象（不是全站廣播），並留下稽核與重送次數
 *   ④ 沒有內容的舊紀錄、壞編號、不存在的紀錄都有明確回應
 *   ⑤ 權限：一般使用者不能看也不能重送
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v226-pushlog-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = 'v226-cron-secret';

// 推播端點指向必然失敗的位址：這正是我們要驗的「失敗要留下原因」
const DEAD_ENDPOINT = 'http://127.0.0.1:9/push-stub';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true },
            { id: 92, username: 'runnerB', password: 'x', role: 'user', is_active: true },
            { id: 93, username: 'runnerC', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 861, name: '秋季盃', date: '2026-12-01', time: '09:00', is_deleted: false, requires_approval: true, waitlist_enabled: false, is_registration_open: true, max_registrations: 10, waitlist_notify: true }
        ],
        registrations: [
            { id: 5101, competition_id: 861, user_id: 91, username: 'runnerA', status: 'pending', is_deleted: false, created_at: '2026-09-20T00:00:00.000Z' }
        ],
        push_subscriptions: [
            { id: 9001, user_id: 91, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true },
            { id: 9002, user_id: 92, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true },
            { id: 9003, user_id: 93, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true }
        ],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: [
            { key: 'push_digest_time', value: '00:00' },
            { key: 'push_digest_enabled', value: 'true' }
        ]
    },
    nextId: { push_log: 500, audit_logs: 1000, error_logs: 1000 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);

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

const api = (method, url, body, token) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});

const lastLog = () => state.tables.push_log[state.tables.push_log.length - 1];

test('推播失敗時：push_log 留下失敗筆數、原因、內容與對象', async () => {
    const res = await api('POST', '/api/registrations/5101/review', { action: 'approve' }, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.notified, 0, '訂閱端點是壞的，不該有成功送出');

    const row = lastLog();
    assert.ok(row, '應該要有推播紀錄');
    assert.strictEqual(row.kind, 'review_result');
    assert.strictEqual(Number(row.failed_count), 1, '要記下失敗 1 筆');
    assert.match(String(row.error_detail), /HTTP/, `失敗原因要寫進紀錄（${row.error_detail}）`);
    assert.ok(row.payload && /報名已核准/.test(row.payload.title), '要留下送出的內容（重送要用）');
    assert.strictEqual(String(row.target_user_id), '91', '要記下這筆是發給誰');
});

test('看板端點：回報明細可用，並帶著失敗資訊', async () => {
    const res = await api('GET', '/api/admin/push-logs?limit=10', undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.detail_ready, true, '欄位都在，明細應該可用');
    assert.strictEqual(body.hint, null);
    const row = body.logs.find((l) => l.kind === 'review_result');
    assert.ok(row, '紀錄應該在列表裡');
    assert.strictEqual(Number(row.failed_count), 1);
    assert.match(String(row.error_detail), /HTTP/);
});

test('重送：只送給原本的對象，並記錄重送次數與稽核', async () => {
    const row = lastLog();
    const res = await api('POST', `/api/admin/push-logs/${row.id}/resend`, undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.strictEqual(body.total, 1, '只該送給 runnerA 的 1 個訂閱（不是全部 3 個）');
    assert.strictEqual(body.sent, 0, '端點是壞的，仍然失敗');
    assert.strictEqual(body.failed, 1);
    assert.strictEqual(body.resend_count, 1);
    assert.match(String((body.errors || [])[0] || ''), /HTTP/, '要把失敗原因回報給操作的人');

    const updated = state.tables.push_log.find((l) => String(l.id) === String(row.id));
    assert.strictEqual(Number(updated.resend_count), 1, '重送次數要寫回紀錄');
    assert.ok(updated.resend_at, '要記下重送時間');
    assert.strictEqual(Number(updated.resend_sent_count), 0);

    const audit = (state.tables.audit_logs || []).filter((l) => l.action === 'RESEND_PUSH');
    assert.strictEqual(audit.length, 1, '重送要留稽核');
    assert.match(String(audit[0].details), /重送推播紀錄/);
    assert.match(String(audit[0].details), /限使用者 #91/, `稽核要寫明送給誰（${audit[0].details}）`);
});

test('重送公告式的紀錄：只送給當初那組對象', async () => {
    state.tables.push_log.push({
        id: 9001, competition_id: null, kind: 'announcement', sent_count: 0, failed_count: 3,
        error_detail: 'HTTP 500', sent_at: '2026-09-26T01:00:00.000Z', target_user_id: null,
        target_user_ids: [91, 92],
        payload: { kind: 'announce', title: '📣 場地異動', body: '改到氹仔', url: '/?announce=1', tag: 'cm-announce-1' }
    });
    const res = await api('POST', '/api/admin/push-logs/9001/resend', undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.total, 2, '只該送給名單上的兩位（runnerC 不在名單裡）');

    const audit = (state.tables.audit_logs || []).filter((l) => /限 2 位使用者/.test(String(l.details || '')));
    assert.strictEqual(audit.length, 1, `稽核要說明重送對象（${audit.length}）`);
});

test('沒有內容的舊紀錄（v2.26.0 之前）不能重送，並說明原因', async () => {
    state.tables.push_log.push({
        id: 9002, competition_id: 861, kind: 'reminder', sent_count: 3, sent_at: '2026-09-20T01:00:00.000Z'
    });
    const res = await api('POST', '/api/admin/push-logs/9002/resend', undefined, ownerToken());
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /沒有可重送的內容/);
});

test('壞編號 400、找不到 404', async () => {
    assert.strictEqual((await api('POST', '/api/admin/push-logs/abc/resend', undefined, ownerToken())).status, 400);
    assert.strictEqual((await api('POST', '/api/admin/push-logs/0/resend', undefined, ownerToken())).status, 400);
    assert.strictEqual((await api('POST', '/api/admin/push-logs/999999/resend', undefined, ownerToken())).status, 404);
});

test('權限：一般使用者看不到紀錄也不能重送、未登入 401', async () => {
    const row = lastLog();
    assert.strictEqual((await api('GET', '/api/admin/push-logs', undefined, userToken())).status, 403);
    assert.strictEqual((await api('POST', `/api/admin/push-logs/${row.id}/resend`, undefined, userToken())).status, 403);
    assert.strictEqual((await api('GET', '/api/admin/push-logs')).status, 401);
    assert.strictEqual((await api('POST', `/api/admin/push-logs/${row.id}/resend`)).status, 401);
});

test('每日摘要的失敗也會留下明細', async () => {
    /* v3.4.0：讓這條測試與「現在幾點」無關。
       - 摘要的「已發送」旗標寫在 app_settings.push_last_digest_date：先清掉，否則同一輪前面跑過摘要就不再發。
       - 候選賽事改成「1 小時後開賽」（原本寫死今天 23:00，深夜跑時已成過去，永遠不會進候選）。 */
    state.tables.app_settings = state.tables.app_settings.filter((r) => r.key !== 'push_last_digest_date');
    const ofs = 8 * 60;   // 澳門 UTC+8（與伺服器 SITE_UTC_OFFSET 相同）
    const soonAt = new Date(Date.now() + 60 * 60000 + ofs * 60000);
    const soon = {
        date: soonAt.toISOString().slice(0, 10),
        time: `${String(soonAt.getUTCHours()).padStart(2, '0')}:${String(soonAt.getUTCMinutes()).padStart(2, '0')}`
    };
    state.tables.competitions.push({
        id: 862, name: '一小時後開賽盃', date: soon.date, time: soon.time,
        is_deleted: false, is_registration_open: true, created_at: '2026-01-01T00:00:00.000Z'
    });
    const before = state.tables.push_log.length;
    const cron = await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
    assert.strictEqual(cron.status, 200);

    const added = state.tables.push_log.slice(before);
    assert.ok(added.length >= 1, `摘要應該要留下紀錄（新增 ${added.length} 筆）`);
    const digestRow = added.find((l) => l.kind === 'reminder' || l.kind === 'new');
    assert.ok(digestRow, '要有一筆摘要紀錄');
    assert.ok(Number(digestRow.failed_count) >= 1, '失敗筆數要記下來');
    assert.ok(digestRow.payload && digestRow.payload.title, '要留下送出的內容');
});
