/* v2.20.0：報名審核與候補的 API 端到端測試
 *
 * 驗的是「後端真的照規則辦事」：
 *   ① 需審核的賽事 → 報名變「待審核」，管理員核准／拒絕（含拒絕原因）＋稽核
 *   ② 額滿且開放候補 → 排候補（順位先報名先排）；沒開候補 → 400 名額已滿
 *   ③ 有人取消（讓出名額）→ 自動遞補第一位候補，並通知、留稽核與推播紀錄
 *   ④ 手動遞補端點、名額守門、權限、我的報名狀態與候補順位
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v220-review-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            // 需審核、名額 3
            { id: 501, name: '需審核賽事', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 3, requires_approval: true, waitlist_enabled: true },
            // 不用審核、名額 2、開放候補
            { id: 502, name: '候補賽事', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 2, requires_approval: false, waitlist_enabled: true },
            // 不用審核、名額 1、沒開候補
            { id: 503, name: '滿了就擋', date: '2026-12-03', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1, requires_approval: false, waitlist_enabled: false },
            // 需審核、名額 1、開放候補（驗「遞補進來仍需審核」）
            { id: 504, name: '需審核且候補', date: '2026-12-04', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1, requires_approval: true, waitlist_enabled: true }
        ],
        registrations: [
            // 502：名額 2 已滿（1 已核准 + 1 待審核）
            { id: 700, competition_id: 502, user_id: 90, username: 'full1', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            { id: 701, competition_id: 502, user_id: 91, username: 'full2', status: 'pending', is_deleted: false, created_at: '2026-09-02T00:00:00Z' },
            // 503：名額 1 已滿
            { id: 702, competition_id: 503, user_id: 92, username: 'onlyone', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            // 504：名額 1 已滿（待審核）
            { id: 703, competition_id: 504, user_id: 93, username: 'waitme', status: 'pending', is_deleted: false, created_at: '2026-09-01T00:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { competitions: 600, registrations: 800, audit_logs: 900, error_logs: 900, push_log: 100 },
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

test('v2.20.0：需審核的賽事，報名後是「待審核」（不是直接成功）', async () => {
    const res = await api('/api/competitions/501/register', { method: 'POST', token: userToken(42, 'alice'), body: { note: '我要參加' } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'pending');
    assert.strictEqual(body.status_label, '待審核');
    assert.strictEqual(body.needs_approval, true);
    assert.match(body.message, /等待主辦單位審核/);

    const row = state.tables.registrations.find((r) => r.user_id === 42 && r.competition_id === 501);
    assert.strictEqual(row.status, 'pending');
    assert.ok(auditActions().includes('REGISTER_COMPETITION'));
});

test('v2.20.0：管理員核准 → 已核准、留下審核軌跡與稽核', async () => {
    const row = state.tables.registrations.find((r) => r.user_id === 42 && r.competition_id === 501);
    const res = await api(`/api/registrations/${row.id}/review`, { method: 'POST', token: adminToken(), body: { action: 'approve', note: '資料齊全' } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.registration.status, 'confirmed');
    assert.strictEqual(body.registration.reviewed_by, 'owner');
    assert.ok(body.registration.reviewed_at, '要有審核時間');
    assert.strictEqual(body.status_label, '已核准');
    assert.strictEqual(body.notified, 0, '沒有推播訂閱時要誠實回 0');

    const after = regOf(row.id);
    assert.strictEqual(after.status, 'confirmed');
    assert.strictEqual(after.review_note, '資料齊全');
    assert.ok(auditActions().includes('REGISTER_APPROVED'));
    assert.ok(state.tables.push_log.some((p) => p.kind === 'review_result'), '推播事件要寫 push_log');
});

test('v2.20.0：管理員拒絕 → 未錄取並記錄原因', async () => {
    const res = await api('/api/competitions/501/register', { method: 'POST', token: userToken(43, 'bob'), body: {} });
    assert.strictEqual(res.status, 200);
    const created = state.tables.registrations.find((r) => r.user_id === 43 && r.competition_id === 501);

    const reviewed = await api(`/api/registrations/${created.id}/review`, { method: 'POST', token: adminToken(), body: { action: 'reject', note: '名額優先給在校生' } });
    assert.strictEqual(reviewed.status, 200);
    const body = await reviewed.json();
    assert.strictEqual(body.registration.status, 'rejected');
    assert.strictEqual(body.status_label, '未錄取');
    assert.strictEqual(regOf(created.id).review_note, '名額優先給在校生');
    assert.ok(auditActions().includes('REGISTER_REJECTED'));
});

test('v2.20.0：只有管理員以上能審核（一般用戶 403、亂七八糟的 action 400）', async () => {
    const row = state.tables.registrations.find((r) => r.user_id === 42 && r.competition_id === 501);
    const forbidden = await api(`/api/registrations/${row.id}/review`, { method: 'POST', token: userToken(42, 'alice'), body: { action: 'approve' } });
    assert.strictEqual(forbidden.status, 403);

    const bad = await api(`/api/registrations/${row.id}/review`, { method: 'POST', token: adminToken(), body: { action: '亂寫' } });
    assert.strictEqual(bad.status, 400);

    const missing = await api('/api/registrations/99999/review', { method: 'POST', token: adminToken(), body: { action: 'approve' } });
    assert.strictEqual(missing.status, 404);
});

test('v2.20.0：額滿且開放候補 → 排候補並回報順位（名單統計要正確）', async () => {
    // 502：名額 2 已滿（confirmed + pending 各一）
    const res = await api('/api/competitions/502/register', { method: 'POST', token: userToken(44, 'carol'), body: {} });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'waitlisted');
    assert.strictEqual(body.status_label, '候補');
    assert.strictEqual(body.waitlist_position, 1);
    assert.match(body.message, /已排入候補（第 1 位）/);
    assert.strictEqual(body.registrations, 2, '候補不佔名額 → 佔用名額數不變');

    const second = await (await api('/api/competitions/502/register', { method: 'POST', token: userToken(45, 'dave'), body: {} })).json();
    assert.strictEqual(second.waitlist_position, 2, '第二個候補排第 2 位');

    const list = await (await api('/api/competitions/502/registrations', { token: adminToken() })).json();
    assert.strictEqual(list.counts.confirmed, 1);
    assert.strictEqual(list.counts.pending, 1);
    assert.strictEqual(list.counts.waitlisted, 2);
    assert.strictEqual(list.counts.slots, 2);
    const onlyWait = await (await api('/api/competitions/502/registrations?status=waitlisted', { token: adminToken() })).json();
    assert.strictEqual(onlyWait.total, 2);
    assert.ok(onlyWait.registrations.every((r) => r.status === 'waitlisted'));
    assert.strictEqual(onlyWait.registrations[0].waitlist_position, 1, '候補順位要照先後排');
});

test('v2.20.0：沒開候補的賽事，額滿就是擋下來（附明確原因）', async () => {
    const res = await api('/api/competitions/503/register', { method: 'POST', token: userToken(46, 'erin'), body: {} });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /已達上限/);
    assert.strictEqual(state.tables.registrations.filter((r) => r.competition_id === 503).length, 1, '被擋下不可留下資料');
});

test('v2.20.0：有人取消讓出名額 → 自動遞補第一位候補，並留稽核與推播紀錄', async () => {
    // 502 的 confirmed（id 700）取消 → 候補 carol（第一位）應被遞補
    const res = await api('/api/registrations/700', { method: 'DELETE', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.promoted, '要回報遞補了誰');
    assert.strictEqual(body.promoted.username, 'carol');
    assert.strictEqual(body.promoted.status, 'confirmed', '不需審核的賽事 → 遞補後直接核准');
    assert.strictEqual(body.promoted.status_label, '已核准');

    const carol = state.tables.registrations.find((r) => r.username === 'carol');
    assert.strictEqual(carol.status, 'confirmed');
    assert.strictEqual(carol.review_note, '候補自動遞補');
    assert.ok(auditActions().includes('AUTO_PROMOTE_WAITLIST'));
    assert.ok(state.tables.push_log.some((p) => p.kind === 'waitlist_promoted'));

    // dave 仍是候補，但順位變成第 1
    const list = await (await api('/api/competitions/502/registrations?status=waitlisted', { token: adminToken() })).json();
    assert.strictEqual(list.total, 1);
    assert.strictEqual(list.registrations[0].username, 'dave');
    assert.strictEqual(list.registrations[0].waitlist_position, 1);
});

test('v2.20.0：候補自己取消不會觸發遞補（沒讓出名額）', async () => {
    const before = auditActions().filter((a) => a === 'AUTO_PROMOTE_WAITLIST').length;
    const dave = state.tables.registrations.find((r) => r.username === 'dave');
    const res = await api(`/api/registrations/${dave.id}`, { method: 'DELETE', token: userToken(45, 'dave') });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.promoted, null);
    assert.strictEqual(auditActions().filter((a) => a === 'AUTO_PROMOTE_WAITLIST').length, before, '不該多一筆自動遞補');
});

test('v2.20.0：需審核的賽事，遞補進來仍是「待審核」', async () => {
    // 504 名額 1：waitme（pending）取消 → 候補的新人要被遞補成 pending
    const newcomer = await (await api('/api/competitions/504/register', { method: 'POST', token: userToken(47, 'frank'), body: {} })).json();
    assert.strictEqual(newcomer.status, 'waitlisted');

    const waitme = state.tables.registrations.find((r) => r.username === 'waitme');
    const res = await api(`/api/registrations/${waitme.id}`, { method: 'DELETE', token: adminToken() });
    const body = await res.json();
    assert.strictEqual(body.promoted.status, 'pending', '需審核的賽事遞補後仍要審核');
    assert.strictEqual(body.promoted.status_label, '待審核');
    assert.match(auditActions().join(','), /AUTO_PROMOTE_WAITLIST/);
});

test('v2.20.0：手動遞補端點——沒有候補回 400、有名額才遞補、權限要管理員', async () => {
    const none = await api('/api/competitions/503/registrations/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(none.status, 400);
    assert.match((await none.json()).error, /沒有候補名單/);

    const forbidden = await api('/api/competitions/501/registrations/promote', { method: 'POST', token: userToken(47, 'frank'), body: {} });
    assert.strictEqual(forbidden.status, 403);

    // 501（名額 3、需審核）：前面測試留下 alice（已核准）；這裡自己把名額填滿再讓 gina 進候補
    await api('/api/competitions/501/register', { method: 'POST', token: userToken(48, 'gina'), body: {} });
    const gina = state.tables.registrations.find((r) => r.username === 'gina');
    assert.strictEqual(regOf(gina.id).status, 'pending', '當下還有名額 → 待審核');

    // 填滿名額（1 已核准 alice + 1 待審核 gina + 1 已核准 hank = 3）
    state.tables.registrations.push({ id: 750, competition_id: 501, user_id: 49, username: 'hank', status: 'confirmed', is_deleted: false, created_at: '2026-09-03T00:00:00Z' });

    // 名額滿了 → 下一位進候補
    const waitRes = await (await api('/api/competitions/501/register', { method: 'POST', token: userToken(51, 'ivy'), body: {} })).json();
    assert.strictEqual(waitRes.status, 'waitlisted', '名額已滿 → 排候補');
    assert.strictEqual(waitRes.waitlist_position, 1);
    assert.strictEqual(regOf(gina.id).status, 'pending', '候補出現不影響原本待審核的');

    const full = await api('/api/competitions/501/registrations/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(full.status, 400, '名額已滿（3 人）時不能遞補');
    assert.match((await full.json()).error, /名額已滿/);

    // 讓出一個名額（拒絕 hank）→ 再手動遞補
    const rejected = await api('/api/registrations/750/review', { method: 'POST', token: adminToken(), body: { action: 'reject', note: '手動測試' } });
    assert.strictEqual(rejected.status, 200);
    const promoted = await api('/api/competitions/501/registrations/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(promoted.status, 200);
    const body = await promoted.json();
    assert.strictEqual(body.registration.username, 'ivy', '遞補的是候補隊伍的第一位（gina 是待審核，不是候補）');
    assert.strictEqual(body.registration.status, 'pending', '需審核的賽事手動遞補也是待審核');
    assert.strictEqual(body.status_label, '待審核');
    assert.ok(auditActions().includes('PROMOTE_WAITLIST'));
});

test('v2.20.0：核准時會擋「名額已滿」（不能超收）', async () => {
    // 503 名額 1（onlyone 已核准）。塞一筆 pending 進來模擬管理員想多收
    state.tables.registrations.push({ id: 760, competition_id: 503, user_id: 51, username: 'jack', status: 'pending', is_deleted: false, created_at: '2026-09-05T00:00:00Z' });
    const res = await api('/api/registrations/760/review', { method: 'POST', token: adminToken(), body: { action: 'approve' } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /名額已滿/);
    assert.strictEqual(regOf(760).status, 'pending', '被擋下時狀態不可變');

    // 拒絕則不受名額限制
    const reject = await api('/api/registrations/760/review', { method: 'POST', token: adminToken(), body: { action: 'reject' } });
    assert.strictEqual(reject.status, 200);
});

test('v2.20.0：我的報名會帶狀態與候補順位（未錄取不能自行取消）', async () => {
    const mine = await (await api('/api/my/registrations', { token: userToken(43, 'bob') })).json();
    const row = mine.find((r) => r.competition_id === 501);
    assert.ok(row, '應該看得到自己的報名');
    assert.strictEqual(row.status, 'rejected');
    assert.strictEqual(row.status_label, '未錄取');
    assert.strictEqual(row.can_cancel, false);

    const ginaRow = (await (await api('/api/my/registrations', { token: userToken(48, 'gina') })).json()).find((r) => r.competition_id === 501);
    assert.strictEqual(ginaRow.status_label, '待審核');
});

test('v2.20.0：公開的報名人數端點只回聚合數字（含候補人數）', async () => {
    const res = await api('/api/registration-counts');
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    // 期望值直接從假資料庫算（不依賴其他測試留下的狀態）
    const expected = {};
    const expectedWait = {};
    for (const r of state.tables.registrations) {
        if (r.is_deleted) continue;
        const key = String(r.competition_id);
        if (r.status === 'waitlisted') expectedWait[key] = (expectedWait[key] || 0) + 1;
        else expected[key] = (expected[key] || 0) + 1;
    }
    assert.deepStrictEqual(body.waitlist, expectedWait, '候補人數要與資料庫一致');
    for (const [key, n] of Object.entries(expected)) {
        assert.strictEqual(body.counts[key], n, `賽事 ${key} 的佔名額人數`);
    }
    assert.ok(!JSON.stringify(body).includes('gina'), '公開端點不可洩漏任何帳號名稱');
});

test('v2.20.0：賽事列表要帶候補／需審核資訊，且額滿有候補時仍可報名', async () => {
    // 自己造一個候補，避免依賴前面測試留下的狀態
    const seeded = await (await api('/api/competitions/502/register', { method: 'POST', token: userToken(60, 'kate'), body: {} })).json();
    assert.strictEqual(seeded.status, 'waitlisted');

    const list = await (await api('/api/competitions')).json();
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    assert.strictEqual(byId[501].needs_approval, true);
    assert.strictEqual(byId[502].is_full, true);
    assert.strictEqual(byId[502].can_register, true, '有候補 → 報名還是送得出去');
    assert.strictEqual(byId[502].is_waitlist, true);
    assert.ok(byId[502].waitlist_count >= 1);
    assert.strictEqual(byId[503].can_register, false, '沒開候補 → 額滿就是不能報名');
});
