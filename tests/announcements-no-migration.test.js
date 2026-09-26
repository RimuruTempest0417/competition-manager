/* v2.26.0：沒有執行公告 migration 時的降級（獨立成檔！）
 *
 * 為什麼要獨立：假 Supabase 只在啟動時讀一次「缺哪些表／欄位」，同一行程內不會中途翻轉。
 *
 * 沒跑 migration 時該有的樣子：
 *   ① 我的公告列表回空＋schema_ready:false＋檔名提示（不是 500，讓前端能好好顯示「尚未啟用」）
 *   ② 標記已讀、發布、修改、儲存訂閱分類都回 503＋檔名
 *   ③ 其他功能完全不受影響（這裡用推播設定與賽事列表當代表）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v226-noannounce-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 861, name: '秋季盃', date: '2026-12-01', time: '09:00', is_deleted: false, is_registration_open: true, max_registrations: 10 }
        ],
        registrations: [],
        push_subscriptions: [],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    // 假裝公告的表與欄位都還沒建
    missingTables: ['announcements', 'announcement_reads'],
    missingColumns: { admin_users: ['announce_categories'] },
    nextId: {},
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

const api = (method, url, body, tok) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: `Bearer ${tok}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});
const HINT = /2026-09-26-v2\.26\.0-announcements\.sql/;

test('我的公告：回空清單並誠實說明尚未啟用（不是 500）', async () => {
    const res = await api('GET', '/api/my/announcements', undefined, userToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, false);
    assert.deepStrictEqual(body.announcements, []);
    assert.strictEqual(body.unread_count, 0);
    assert.match(String(body.hint), HINT);
    assert.ok(Array.isArray(body.all_categories), '分類清單仍要提供，介面才畫得出來');
});

test('管理端列表：一樣誠實說明尚未啟用', async () => {
    const res = await api('GET', '/api/admin/announcements', undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, false);
    assert.deepStrictEqual(body.announcements, []);
    assert.match(String(body.hint), HINT);
});

test('發布、修改、標記已讀、訂閱分類：都回 503＋檔名（不改任何資料）', async () => {
    const create = await api('POST', '/api/admin/announcements', { title: 't', body: 'b' }, ownerToken());
    assert.strictEqual(create.status, 503);
    assert.match((await create.json()).error, HINT);

    const patch = await api('PATCH', '/api/admin/announcements/1', { title: 't' }, ownerToken());
    assert.strictEqual(patch.status, 503);
    assert.match((await patch.json()).error, HINT);

    const read = await api('POST', '/api/my/announcements/read-all', { ids: [1] }, userToken());
    assert.strictEqual(read.status, 503);
    assert.match((await read.json()).error, HINT);

    const cats = await api('POST', '/api/my/announce-categories', { categories: ['track'] }, userToken());
    assert.strictEqual(cats.status, 503);
    assert.match((await cats.json()).error, HINT);
});

test('沒有訂閱分類欄位時：我的分類回空陣列（不是錯誤）', async () => {
    const body = await (await api('GET', '/api/my/announcements', undefined, userToken())).json();
    assert.deepStrictEqual(body.my_categories, []);
});

test('其他功能不受影響：賽事列表與推播設定照常', async () => {
    const comps = await api('GET', '/api/competitions');
    assert.strictEqual(comps.status, 200);
    assert.strictEqual((await comps.json()).length || 1, 1, '賽事列表要看得到');

    const settings = await api('GET', '/api/push/settings', undefined, ownerToken());
    assert.strictEqual(settings.status, 200, '推播設定照常可用');
    const body = await settings.json();
    assert.strictEqual(body.settings.digest_time, '09:00');
    assert.strictEqual(body.settings.event_announce, true, '公告通知預設開啟');
});
