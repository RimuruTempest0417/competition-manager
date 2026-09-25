/* v2.21.0：候補順位手動調整與指定遞補的 API 端到端測試
 *
 * 驗的是「後端真的照管理員排的順序辦事」：
 *   ① 調整順位 → 資料庫真的寫入 waitlist_order，名單與「我的報名」的順位跟著變
 *   ② 名單變動（漏一筆、夾帶不在名單的 id、重複）→ 整批拒絕，不寫半套結果
 *   ③ 指定遞補 → 跳過排前面的人遞補指定的那一位，留稽核與推播紀錄
 *   ④ 守門：名額已滿不能遞補、不在候補名單不能遞補、權限與未登入
 *   ⑤ 取消正取時的「自動遞補」也照管理員排的順位（不是照報名時間）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v221-waitlist-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            // 名額 2、開放候補、不需審核
            { id: 601, name: '候補排隊賽', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 2, requires_approval: false, waitlist_enabled: true },
            // 不限名額、開放候補、需審核（驗「指定遞補進來仍需審核」）
            { id: 602, name: '不限名額需審核', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: true, waitlist_enabled: true }
        ],
        registrations: [
            // 601：1 已核准（佔 1 個名額，上限 2）＋ 3 位候補
            { id: 801, competition_id: 601, user_id: 90, username: 'taken', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            { id: 802, competition_id: 601, user_id: 91, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z' },
            { id: 803, competition_id: 601, user_id: 92, username: 'waitB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z' },
            { id: 804, competition_id: 601, user_id: 93, username: 'waitC', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T03:00:00Z' },
            // 602：不限名額、兩位候補（用來驗需審核賽事的指定遞補）
            { id: 805, competition_id: 602, user_id: 94, username: 'needA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T04:00:00Z' },
            { id: 806, competition_id: 602, user_id: 95, username: 'needB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T05:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { competitions: 700, registrations: 900, audit_logs: 900, error_logs: 900, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const userToken = (id, username) => jwt.sign({ sub: id, username: username || `u${id}`, role: 'user' }, SECRET);
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

const auditActions = () => (state.tables.audit_logs || []).map((l) => l.action);
const regOf = (id) => state.tables.registrations.find((r) => r.id === Number(id));
const waitlistOrderOf = (id) => (regOf(id) || {}).waitlist_order;
const teamsOf = async (id) => (await (await api(`/api/competitions/${id}/teams`, { token: adminToken() })).json());

test('v2.21.0：名單端點回報「可以調整順位」並附候補順位（初始依報名時間）', async () => {
    const body = await teamsOf(601);
    assert.strictEqual(body.canReorderWaitlist, true);
    assert.deepStrictEqual(body.waitlisted.map((r) => r.username), ['waitA', 'waitB', 'waitC']);
    assert.deepStrictEqual(body.waitlisted.map((r) => r.waitlist_position), [1, 2, 3]);
});

test('v2.21.0：調整順位 → 資料庫真的寫入、名單與「我的報名」都跟著變', async () => {
    const res = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [804, 802, 803] } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.message, /已更新候補順位（3 人）/);
    assert.deepStrictEqual(body.waitlist.map((r) => r.username), ['waitC', 'waitA', 'waitB']);
    assert.deepStrictEqual(body.waitlist.map((r) => r.waitlist_position), [1, 2, 3]);

    assert.strictEqual(waitlistOrderOf(804), 1);
    assert.strictEqual(waitlistOrderOf(802), 2);
    assert.strictEqual(waitlistOrderOf(803), 3);

    const after = await teamsOf(601);
    assert.deepStrictEqual(after.waitlisted.map((r) => r.username), ['waitC', 'waitA', 'waitB']);

    // 當事人看自己的「我的報名」也要是新順位（同一份排序規則）
    const mine = await (await api('/api/my/registrations', { token: userToken(93, 'waitC') })).json();
    const row = mine.find((r) => Number(r.id) === 804);
    assert.strictEqual(row.status_label, '候補');
    assert.strictEqual(row.waitlist_position, 1);

    assert.ok(auditActions().includes('REORDER_WAITLIST'), '調整順位要留稽核');
    const log = state.tables.audit_logs.find((l) => l.action === 'REORDER_WAITLIST');
    assert.match(log.details, /waitC/);
});

test('v2.21.0：順序漏掉名單裡的人 → 整批拒絕且不改任何資料', async () => {
    const before = [802, 803, 804].map(waitlistOrderOf);
    const res = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [804, 802] } });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /漏掉 1 筆/);
    assert.deepStrictEqual([802, 803, 804].map(waitlistOrderOf), before, '拒絕時不得改動任何順位');
});

test('v2.21.0：順序夾帶非候補的人（已核准）→ 拒絕', async () => {
    const res = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [804, 802, 801] } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /不在候補名單/);
});

test('v2.21.0：調整順位的權限與參數檢查', async () => {
    const forbidden = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: userToken(93, 'waitC'), body: { order: [802, 803, 804] } });
    assert.strictEqual(forbidden.status, 403);

    const anonymous = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', body: { order: [802, 803, 804] } });
    assert.strictEqual(anonymous.status, 401);

    const empty = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [] } });
    assert.strictEqual(empty.status, 400);
    assert.match((await empty.json()).error, /完整的候補順序/);

    const missing = await api('/api/competitions/601/waitlist/reorder', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(missing.status, 400);

    const unknownComp = await api('/api/competitions/9999/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [804] } });
    assert.strictEqual(unknownComp.status, 404);
});

test('v2.21.0：指定遞補會跳過排前面的人（指名第三順位）', async () => {
    // 目前順序：waitC(1)、waitA(2)、waitB(3)；名額上限 2、已佔 1 → 還有 1 個名額
    const res = await api('/api/registrations/803/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.registration.status, 'confirmed');
    assert.strictEqual(body.status_label, '已核准');
    assert.match(body.message, /原第 3 順位/);
    assert.strictEqual(body.notified, 0, '沒有推播訂閱時要誠實回 0');

    assert.strictEqual(regOf(803).status, 'confirmed');
    assert.match(regOf(803).review_note, /指定遞補/);
    assert.strictEqual(regOf(803).reviewed_by, 'owner');

    // 排在前面的人沒有被動到
    assert.strictEqual(regOf(804).status, 'waitlisted');
    assert.strictEqual(regOf(802).status, 'waitlisted');
    assert.ok(regOf(802).status === 'waitlisted' && waitlistOrderOf(802) === 2, '手動順位要保留');

    const log = state.tables.audit_logs.find((l) => l.action === 'PROMOTE_WAITLIST' && /指定遞補/.test(l.details));
    assert.ok(log, '指定遞補要留稽核');
    assert.match(log.details, /未照順位/);
    assert.ok(state.tables.push_log.some((p) => p.kind === 'waitlist_promoted'), '遞補要寫推播紀錄');
});

test('v2.21.0：名額已滿時指定遞補會被擋（不能超收）', async () => {
    // 601 現在佔名額 2 = 上限 2
    const res = await api('/api/registrations/804/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /名額已滿（2 人）/);
    assert.strictEqual(regOf(804).status, 'waitlisted', '被擋下時狀態不得改變');
});

test('v2.21.0：指定遞補的對象必須真的在候補名單裡', async () => {
    const notWaitlisted = await api('/api/registrations/801/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(notWaitlisted.status, 400);
    assert.match((await notWaitlisted.json()).error, /不在候補名單/);

    const missing = await api('/api/registrations/99999/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(missing.status, 404);

    const forbidden = await api('/api/registrations/804/promote', { method: 'POST', token: userToken(93, 'waitC'), body: {} });
    assert.strictEqual(forbidden.status, 403);
});

test('v2.21.0：需審核的賽事，指定遞補後仍是「待審核」', async () => {
    const res = await api('/api/registrations/806/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.registration.status, 'pending');
    assert.strictEqual(body.status_label, '待審核');
    assert.strictEqual(regOf(806).status, 'pending');
    assert.strictEqual(regOf(805).status, 'waitlisted', '被跳過的人不受影響');
});

test('v2.21.0：取消正取時的自動遞補，照管理員排定的順位（不是報名時間）', async () => {
    // 601 目前：taken 已核准（將被取消），候補順序 waitC(1)、waitA(2)
    const res = await api('/api/registrations/801', { method: 'DELETE', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.promoted, '讓出名額要自動遞補');
    assert.strictEqual(body.promoted.username, 'waitC', '要遞補手動排第一位的人（waitC 比 waitA 晚報名）');
    assert.strictEqual(regOf(804).status, 'confirmed');
    assert.strictEqual(regOf(802).status, 'waitlisted');
    assert.ok(auditActions().includes('AUTO_PROMOTE_WAITLIST'));
});
