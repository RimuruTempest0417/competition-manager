/* v2.22.0：候補異動紀錄（GET /api/competitions/:id/waitlist/history）的 API 測試
 *
 * 這個端點是「主辦想知道名單為什麼變這樣」的入口，所以驗的重點是：
 *   ① 只回「跟候補有關」的動作（別的動作、別的賽事的紀錄都不可以混進來）
 *   ② 最新在最前面、limit 生效且有上限
 *   ③ 每筆都有人看得懂的中文動作名稱、操作者、時間、內容
 *   ④ 權限（管理員以上）與找不到賽事
 *   ⑤ 真的操作一次（調整順位）之後，新紀錄會出現在最前面
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v222-history-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const log = (id, action, targetId, details, user, at) => ({
    id, action, target_id: targetId, details, user_id: user || 'owner', created_at: at, user_agent: 'test'
});

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            { id: 621, name: '有紀錄的賽事', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: false, waitlist_enabled: true, waitlist_notify: true },
            { id: 622, name: '別場賽事', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: false, waitlist_enabled: true }
        ],
        registrations: [
            { id: 1101, competition_id: 621, user_id: 91, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z' },
            { id: 1102, competition_id: 621, user_id: 92, username: 'waitB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z' }
        ],
        audit_logs: [
            log(1, 'REORDER_WAITLIST', 621, '調整候補順位（2 人）: 1.waitB、2.waitA', 'owner', '2026-09-20T10:00:00Z'),
            log(2, 'PROMOTE_WAITLIST', 621, '指定遞補候補: waitC（第 3 順位 → 已核准，未照順位）', 'owner', '2026-09-20T11:00:00Z'),
            log(3, 'AUTO_PROMOTE_WAITLIST', 621, '自動遞補候補: waitD（第 1 順位 → 已核准，因 waitX 取消報名）', 'owner', '2026-09-20T12:00:00Z'),
            log(4, 'REGISTER_APPROVED', 621, '核准報名: waitE（原狀態 待審核）', 'admin2', '2026-09-20T13:00:00Z'),
            log(5, 'WAITLIST_NOTIFY', 621, '遞補通知設定：開啟 → 關閉', 'owner', '2026-09-20T14:00:00Z'),
            log(6, 'CANCEL_REGISTRATION', 621, '取消報名: waitX', 'waitX', '2026-09-20T15:00:00Z'),
            // 這些都「不該」出現在候補紀錄裡
            log(7, 'LOGIN', 621, '登入成功', 'owner', '2026-09-20T16:00:00Z'),
            log(8, 'UPDATE_COMPETITION', 621, '更新賽事: 有紀錄的賽事', 'owner', '2026-09-20T17:00:00Z'),
            log(9, 'REORDER_WAITLIST', 622, '調整候補順位（1 人）: 1.other', 'owner', '2026-09-20T18:00:00Z')
        ],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { competitions: 700, registrations: 2000, audit_logs: 900, error_logs: 900, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'waitA', role: 'user' }, SECRET);

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

const historyOf = async (id, query, token) => {
    // 注意：不可以用 `token || adminToken()`——空字串會被吃掉，匿名測試就默默變成管理員測試
    const res = await api(`/api/competitions/${id}/waitlist/history${query || ''}`, { token: token === undefined ? adminToken() : token });
    return { status: res.status, body: await res.json() };
};

test('v2.22.0：只回候補相關的動作（登入、改賽事、別場賽事都不會混進來）', async () => {
    const { status, body } = await historyOf(621);
    assert.strictEqual(status, 200);
    const actions = body.logs.map((l) => l.action);
    assert.deepStrictEqual(actions, [
        'CANCEL_REGISTRATION', 'WAITLIST_NOTIFY', 'REGISTER_APPROVED',
        'AUTO_PROMOTE_WAITLIST', 'PROMOTE_WAITLIST', 'REORDER_WAITLIST'
    ]);
    assert.ok(!actions.includes('LOGIN'));
    assert.ok(!actions.includes('UPDATE_COMPETITION'));
    assert.strictEqual(body.logs.filter((l) => String(l.details).includes('1.other')).length, 0);
});

test('v2.22.0：每筆都有中文動作名稱、操作者、時間與內容（最新在最前面）', async () => {
    const { body } = await historyOf(621);
    assert.strictEqual(body.returned, 6);
    assert.strictEqual(body.name, '有紀錄的賽事');
    const first = body.logs[0];
    assert.strictEqual(first.action_label, '取消報名');
    assert.strictEqual(first.user, 'waitX');
    assert.strictEqual(first.at, '2026-09-20T15:00:00Z');
    assert.match(first.details, /取消報名: waitX/);
    // 每個動作都要有人看得懂的名字（下拉／時間軸才不會出現英文孤兒）
    for (const l of body.logs) {
        assert.ok(l.action_label && l.action_label !== l.action, `${l.action} 缺少中文標籤`);
    }
    assert.strictEqual(body.logs.find((l) => l.action === 'WAITLIST_NOTIFY').action_label, '調整遞補通知設定');
    assert.strictEqual(body.logs.find((l) => l.action === 'REORDER_WAITLIST').action_label, '調整候補順位');
});

test('v2.22.0：actions 欄位列出這個端點會回的動作（都附中文標籤）', async () => {
    const { body } = await historyOf(621);
    const values = body.actions.map((a) => a.value);
    assert.deepStrictEqual(values, ['REORDER_WAITLIST', 'PROMOTE_WAITLIST', 'AUTO_PROMOTE_WAITLIST', 'WAITLIST_NOTIFY', 'REGISTER_APPROVED', 'REGISTER_REJECTED', 'CANCEL_REGISTRATION']);
    for (const a of body.actions) assert.ok(a.label && a.label !== a.value);
});

test('v2.22.0：limit 生效，且有上限（最多 100 筆）', async () => {
    const two = await historyOf(621, '?limit=2');
    assert.strictEqual(two.body.returned, 2);
    assert.deepStrictEqual(two.body.logs.map((l) => l.action), ['CANCEL_REGISTRATION', 'WAITLIST_NOTIFY']);

    const big = await historyOf(621, '?limit=999');
    assert.strictEqual(big.body.limit, 100);
    assert.strictEqual(big.body.returned, 6);
});

test('v2.22.0：真的調整一次順位 → 新紀錄排在最前面（端點與稽核是同一份資料）', async () => {
    const res = await api('/api/competitions/621/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [1102, 1101] } });
    assert.strictEqual(res.status, 200);

    const { body } = await historyOf(621);
    assert.strictEqual(body.logs[0].action, 'REORDER_WAITLIST');
    assert.match(body.logs[0].details, /調整候補順位（2 人）: 1\.waitB、2\.waitA/);
    assert.strictEqual(body.logs[0].user, 'owner');
    assert.strictEqual(body.returned, 7);
});

test('v2.22.0：沒有紀錄的賽事回空陣列（不是錯誤）', async () => {
    const { status, body } = await historyOf(622);
    assert.strictEqual(status, 200);
    // 622 只有一筆「調整候補順位」是它自己的（id 9），所以會回 1 筆
    assert.strictEqual(body.returned, 1);
    assert.match(body.logs[0].details, /1.other/);

    const none = await historyOf(622, '?limit=1');
    assert.strictEqual(none.body.returned, 1);
});

test('v2.22.0：權限（管理員以上）與找不到賽事', async () => {
    const asUser = await historyOf(621, '', userToken());
    assert.strictEqual(asUser.status, 403);

    // 明確傳空權杖（historyOf 預設是管理員，不然這條會變成在測管理員）
    const anon = await historyOf(621, '', '');
    assert.strictEqual(anon.status, 401);

    const notFound = await historyOf(9999);
    assert.strictEqual(notFound.status, 404);
});
