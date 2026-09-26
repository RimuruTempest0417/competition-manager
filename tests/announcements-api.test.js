/* v2.26.0：站內公告／訊息中心的 API 測試
 *
 * 驗的是「誰看得到、什麼時候看得到、誰讀過了、發布時通知對不對人」：
 *   ① 一般使用者只看得到 all 與自己訂閱分類的公告（管理員公告、未來、過期、下架都看不到）
 *   ② 已讀標記冪等，未讀數正確
 *   ③ 我的訂閱分類可設定、會過濾不存在的分類，設完就看得到該分類的公告
 *   ④ 發布公告：驗證、稽核、以及「同時推播」只送給對象使用者的訂閱
 *   ⑤ 修改公告：變更摘要、下架後使用者看不到；驗證錯誤不會寫入
 *   ⑥ 管理端列表：已讀人數、有效使用者數
 *   ⑦ 權限：一般使用者不能發布或看管理端列表
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v226-announce-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const DEAD_ENDPOINT = 'http://127.0.0.1:9/push-stub';
const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true, announce_categories: [] },
            { id: 2, username: 'boss', password: 'x', role: 'admin', is_active: true, announce_categories: ['track'] },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true, announce_categories: ['track'] },
            { id: 92, username: 'runnerB', password: 'x', role: 'user', is_active: true, announce_categories: [] },
            { id: 93, username: 'gone', password: 'x', role: 'user', is_active: false, announce_categories: [] }
        ],
        competitions: [],
        registrations: [],
        announcements: [
            { id: 1, title: '一般公告', body: '所有人都看得到', audience: 'all', categories: [], is_pinned: true, is_active: true, publish_at: iso(-2), expires_at: null, created_by: 'owner', created_at: iso(-2) },
            { id: 2, title: '管理員公告', body: '只有管理員看得到', audience: 'admin', categories: [], is_pinned: false, is_active: true, publish_at: iso(-1), expires_at: null, created_by: 'owner', created_at: iso(-1) },
            { id: 3, title: '路跑組公告', body: '訂閱田徑路跑的人看得到', audience: 'category', categories: ['track'], is_pinned: false, is_active: true, publish_at: iso(-1), expires_at: null, created_by: 'owner', created_at: iso(-1) },
            { id: 4, title: '電競組公告', body: '訂閱電子競技的人看得到', audience: 'category', categories: ['esports'], is_pinned: false, is_active: true, publish_at: iso(-1), expires_at: null, created_by: 'owner', created_at: iso(-1) },
            { id: 5, title: '已下架公告', body: '看不到', audience: 'all', categories: [], is_pinned: false, is_active: false, publish_at: iso(-1), expires_at: null, created_by: 'owner', created_at: iso(-1) },
            { id: 6, title: '預約公告', body: '時間還沒到', audience: 'all', categories: [], is_pinned: false, is_active: true, publish_at: iso(2), expires_at: null, created_by: 'owner', created_at: iso(0) },
            { id: 7, title: '已過期公告', body: '時間已過', audience: 'all', categories: [], is_pinned: false, is_active: true, publish_at: iso(-5), expires_at: iso(-1), created_by: 'owner', created_at: iso(-5) }
        ],
        announcement_reads: [
            { id: 1, announcement_id: 1, user_id: 91, read_at: iso(-1) }
        ],
        push_subscriptions: [
            { id: 9001, user_id: 91, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true },
            { id: 9002, user_id: 92, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true },
            { id: 9003, user_id: 2, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true }
        ],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    nextId: { announcements: 100, announcement_reads: 100, push_log: 500, audit_logs: 1000, error_logs: 1000 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const token = (id, username, role) => jwt.sign({ sub: id, username, role }, SECRET);
const ownerToken = () => token(1, 'owner', 'web_owner');
const userToken = () => token(91, 'runnerA', 'user');
const bossToken = () => token(2, 'boss', 'admin');

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
const myList = async (tok) => (await (await api('GET', '/api/my/announcements', undefined, tok)).json());
const titles = (list) => list.map((a) => a.title);
const annByTitle = (title) => state.tables.announcements.find((a) => a.title === title);

test('使用者視角：只看得到 all 與自己訂閱分類的公告', async () => {
    const body = await myList(userToken());
    assert.strictEqual(body.schema_ready, true);
    assert.deepStrictEqual(titles(body.announcements).sort(), ['一般公告', '路跑組公告'].sort());
    assert.deepStrictEqual(body.my_categories, ['track']);
    assert.strictEqual(body.announcements[0].title, '一般公告', '置頂的要排在最前面');
    assert.strictEqual(body.all_categories.length, 10);
});

test('未讀數與已讀狀態正確（一般公告已讀、路跑組公告未讀）', async () => {
    const body = await myList(userToken());
    assert.strictEqual(body.unread_count, 1);
    const general = body.announcements.find((a) => a.title === '一般公告');
    const road = body.announcements.find((a) => a.title === '路跑組公告');
    assert.strictEqual(general.read, true);
    assert.strictEqual(road.read, false);
});

test('管理員視角：看得到全部上架中的公告（含沒訂閱的分類公告）', async () => {
    const body = await myList(ownerToken());
    assert.deepStrictEqual(titles(body.announcements).sort(),
        ['一般公告', '管理員公告', '路跑組公告', '電競組公告'].sort(),
        '管理員看得到全部上架中的公告（含自己發的分類公告）；下架與預約中的仍然看不到');
});

test('標記已讀：冪等、未讀數歸零', async () => {
    const road = annByTitle('路跑組公告');
    const first = await api('POST', '/api/my/announcements/read-all', { ids: [road.id] }, userToken());
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await first.json()).marked, 1);

    const second = await api('POST', '/api/my/announcements/read-all', { ids: [road.id] }, userToken());
    assert.strictEqual(second.status, 200);
    const rows = state.tables.announcement_reads.filter((r) => String(r.announcement_id) === String(road.id) && String(r.user_id) === '91');
    assert.strictEqual(rows.length, 1, '重複標記不該長出第二列');

    const body = await myList(userToken());
    assert.strictEqual(body.unread_count, 0);
});

test('沒帶 ids 或帶壞值：400', async () => {
    assert.strictEqual((await api('POST', '/api/my/announcements/read-all', {}, userToken())).status, 400);
    assert.strictEqual((await api('POST', '/api/my/announcements/read-all', { ids: ['x'] }, userToken())).status, 400);
});

test('我的訂閱分類：會過濾不存在的分類，設完就看得到該分類公告', async () => {
    const res = await api('POST', '/api/my/announce-categories', { categories: ['esports', '不存在的分類', 'esports'] }, userToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.categories, ['esports']);
    assert.match(body.message, /電子競技/);

    const after = await myList(userToken());
    assert.deepStrictEqual(after.my_categories, ['esports']);
    assert.ok(titles(after.announcements).includes('電競組公告'), '改成訂閱電競後就看得到了');
    assert.ok(!titles(after.announcements).includes('路跑組公告'), '沒訂閱田徑路跑後就看不到了');

    // 還原，後面測試才不會互相影響
    await api('POST', '/api/my/announce-categories', { categories: ['track'] }, userToken());
});

test('發布公告：驗證、稽核、推播只送給對象使用者', async () => {
    const bad = await api('POST', '/api/admin/announcements', { title: '', body: 'x' }, ownerToken());
    assert.strictEqual(bad.status, 400);

    const res = await api('POST', '/api/admin/announcements', {
        title: '場地異動', body: '本週六改到氹仔運動場', audience: 'category',
        categories: ['track'], notify_push: true, is_pinned: true
    }, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.announcement, '要回傳建立好的公告');
    assert.strictEqual(body.push.total, 2, '路跑組有 runnerA 與 boss 兩位訂閱者（不含未訂閱的 runnerB）');

    const audit = state.tables.audit_logs.filter((l) => l.action === 'CREATE_ANNOUNCEMENT');
    assert.strictEqual(audit.length, 1);
    assert.match(String(audit[0].details), /發布公告「場地異動」/);
    assert.match(String(audit[0].details), /特定分類訂閱者：田徑路跑/);

    const pushRow = state.tables.push_log[state.tables.push_log.length - 1];
    assert.strictEqual(pushRow.kind, 'announcement');
    assert.ok(Array.isArray(pushRow.target_user_ids) && pushRow.target_user_ids.length === 2,
        `推播紀錄要記下對象（${JSON.stringify(pushRow.target_user_ids)}）`);
    assert.ok(String(pushRow.payload.title).includes('場地異動'));
    assert.strictEqual(Number(pushRow.failed_count), 2, '端點是壞的，兩筆都失敗');
});

test('發布公告：對象 admin 時只推給管理員', async () => {
    const res = await api('POST', '/api/admin/announcements', {
        title: '內部提醒', body: '請記得盤點器材', audience: 'admin', notify_push: true
    }, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.push.total, 1, '只有 boss 有訂閱（owner 沒有訂閱裝置）');
});

test('站台層「公告通知」關掉時：公告照發、推播跳過並說明', async () => {
    const off = await api('POST', '/api/push/settings', { event_announce: false }, ownerToken());
    assert.strictEqual(off.status, 200);

    const res = await api('POST', '/api/admin/announcements', {
        title: '安靜的公告', body: '不推播', audience: 'all', notify_push: true
    }, ownerToken());
    const body = await res.json();
    assert.strictEqual(body.push.sent, 0);
    assert.match(String(body.push.skipped), /站台設定已關閉/);

    await api('POST', '/api/push/settings', { event_announce: true }, ownerToken());
});

test('修改公告：變更摘要、下架後使用者看不到', async () => {
    const created = annByTitle('場地異動');
    const res = await api('PATCH', `/api/admin/announcements/${created.id}`, {
        is_pinned: false, body: '本週六改到氹仔運動場（請提早 30 分鐘到）'
    }, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.changes.some((c) => /置頂/.test(c)), `要看得到置頂的變化（${body.changes}）`);
    assert.ok(body.changes.some((c) => /內容已更新/.test(c)));

    const updated = state.tables.announcements.find((a) => String(a.id) === String(created.id));
    assert.strictEqual(updated.is_pinned, false);
    assert.match(updated.body, /提早 30 分鐘/);

    const audit = state.tables.audit_logs.filter((l) => l.action === 'UPDATE_ANNOUNCEMENT');
    assert.strictEqual(audit.length, 1);

    // 下架 → 一般使用者看不到
    await api('POST', '/api/my/announce-categories', { categories: ['track'] }, userToken());
    assert.ok(titles((await myList(userToken())).announcements).includes('場地異動'));
    const off = await api('PATCH', `/api/admin/announcements/${created.id}`, { is_active: false }, ownerToken());
    assert.strictEqual(off.status, 200);
    assert.ok(!titles((await myList(userToken())).announcements).includes('場地異動'), '下架後不該再出現');
});

test('修改公告：驗證錯誤不會寫入、找不到與壞編號有明確回應', async () => {
    const target = annByTitle('一般公告');
    const bad = await api('PATCH', `/api/admin/announcements/${target.id}`, { title: '   ' }, ownerToken());
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(state.tables.announcements.find((a) => a.id === 1).title, '一般公告', '被擋下來時不可以改到資料');

    assert.strictEqual((await api('PATCH', '/api/admin/announcements/99999', { title: 'x' }, ownerToken())).status, 404);
    assert.strictEqual((await api('PATCH', '/api/admin/announcements/abc', { title: 'x' }, ownerToken())).status, 400);
});

test('管理端列表：已讀人數、有效使用者數、上架狀態', async () => {
    const res = await api('GET', '/api/admin/announcements', undefined, ownerToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, true);
    assert.strictEqual(body.total_users, 4, '有效使用者 4 位（停用的不算）');
    const general = body.announcements.find((a) => a.id === 1);
    assert.strictEqual(general.read_count, 1);
    assert.strictEqual(general.is_live, true);
    const inactive = body.announcements.find((a) => a.id === 5);
    assert.strictEqual(inactive.is_live, false);
    assert.strictEqual(body.announcements.find((a) => a.id === 2).audience_label, '管理員以上');
});

test('權限：一般使用者不能發布、修改、看管理端列表；未登入 401', async () => {
    assert.strictEqual((await api('GET', '/api/admin/announcements', undefined, userToken())).status, 403);
    assert.strictEqual((await api('POST', '/api/admin/announcements', { title: 'x', body: 'y' }, userToken())).status, 403);
    assert.strictEqual((await api('PATCH', '/api/admin/announcements/1', { title: 'x' }, userToken())).status, 403);
    assert.strictEqual((await api('GET', '/api/my/announcements')).status, 401);
    assert.strictEqual((await api('POST', '/api/my/announcements/read-all', { ids: [1] })).status, 401);
    assert.strictEqual((await api('GET', '/api/my/announcements', undefined, bossToken())).status, 200, '管理員也看得到自己的公告列表');
});
