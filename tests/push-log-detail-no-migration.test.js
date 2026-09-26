/* v2.26.0：沒有執行 push_log 明細 migration 時的降級（獨立成檔！）
 *
 * 為什麼要獨立：假 Supabase 只在啟動時讀一次「缺哪些欄位」，同一行程內不會中途翻轉。
 *
 * 沒跑 migration 時該有的樣子：
 *   ① 看板照常列出紀錄，但誠實回報 detail_ready:false 與檔名提示
 *   ② 重送回 503＋檔名（不是 500、也不是假裝成功）
 *   ③ 推播照常運作、紀錄照常寫入（只是退回「只有筆數」的舊格式）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v226-nodetail-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            { id: 861, name: '秋季盃', date: '2026-12-01', time: '09:00', is_deleted: false, requires_approval: true, waitlist_enabled: false, is_registration_open: true, max_registrations: 10, waitlist_notify: true }
        ],
        registrations: [
            { id: 5101, competition_id: 861, user_id: 91, username: 'runnerA', status: 'pending', is_deleted: false, created_at: '2026-09-20T00:00:00.000Z' }
        ],
        push_subscriptions: [
            { id: 9001, user_id: 91, endpoint: 'http://127.0.0.1:9/push-stub', p256dh: 'k', auth: 'a', is_active: true }
        ],
        push_log: [{ id: 700, competition_id: 861, kind: 'reminder', sent_count: 2, sent_at: '2026-09-25T01:00:00.000Z' }],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    // 假裝 push_log 還沒有 v2.26.0 的欄位
    missingColumns: { push_log: ['failed_count', 'error_detail', 'payload', 'target_user_id', 'target_user_ids', 'resend_count'] },
    nextId: { push_log: 800, audit_logs: 1000, error_logs: 1000 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);

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

const api = (method, url, body, tok) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: `Bearer ${tok}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});

test('看板：照常列出紀錄，但誠實說明明細不可用', async () => {
    const res = await api('GET', '/api/admin/push-logs', undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.detail_ready, false);
    assert.match(String(body.hint), /2026-09-26-v2\.26\.0-push-log-detail\.sql/);
    assert.ok(body.logs.length >= 1, '舊紀錄仍然要看得到');
});

test('重送：回 503 並指引檔名（不會假裝成功）', async () => {
    const res = await api('POST', '/api/admin/push-logs/700/resend', undefined, ownerToken());
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /2026-09-26-v2\.26\.0-push-log-detail\.sql/);
});

test('推播本身照常運作（紀錄退回只記筆數，不會因此漏記或報錯）', async () => {
    const before = state.tables.push_log.length;
    const res = await api('POST', '/api/registrations/5101/review', { action: 'approve' }, ownerToken());
    assert.strictEqual(res.status, 200, '審核不該因為明細欄位不存在而失敗');

    const added = state.tables.push_log.slice(before);
    assert.strictEqual(added.length, 1, '仍要留下一筆推播紀錄');
    assert.strictEqual(Number(added[0].sent_count), 0, '端點是壞的，成功數是 0');
    assert.strictEqual(added[0].failed_count, undefined, '沒有欄位就不該硬塞明細');
});
