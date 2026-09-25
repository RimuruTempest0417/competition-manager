/* v2.21.0：尚未執行 waitlist_order migration 時的降級行為（獨立成檔！）
 *
 * 為什麼要獨立：伺服器把「欄位探測結果」快取在行程內，同一個行程裡不會中途翻轉
 * （詳見 SKILL 的「migration 缺失的情境要獨立成檔測試」）。
 *
 * 這裡讓假 Supabase 從一開始就假裝 registrations 沒有 waitlist_order 欄位，
 * 而且種子資料也完全沒有這個欄位（模擬真實的舊資料庫）：
 *   - 候補順位自動退回「先報名先排」（created_at）——不能壞掉，也不能排錯
 *   - 調整順位的端點回 503 ＋ 指引，且不寫入任何資料
 *   - 指定遞補照常可用（它不需要這個欄位）
 *   - 前端會拿到 canReorderWaitlist:false（據此不顯示上下移按鈕）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v221-nomigration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    // 假裝資料庫沒有 registrations.waitlist_order（＝使用者還沒執行 v2.21.0 migration）
    missingColumns: { registrations: ['waitlist_order'] },
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            // 名額 1、開放候補（已滿）
            { id: 701, name: '滿了', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1, requires_approval: false, waitlist_enabled: true },
            // 不限名額、開放候補
            { id: 702, name: '不限名額', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0, requires_approval: false, waitlist_enabled: true }
        ],
        registrations: [
            { id: 901, competition_id: 701, user_id: 80, username: 'taken', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            // 刻意讓 id 順序與報名時間相反：先報名的是 late is 902、早的是 903（證明排序看時間不是看 id）
            { id: 902, competition_id: 701, user_id: 81, username: 'lateJoiner', status: 'waitlisted', is_deleted: false, created_at: '2026-09-05T00:00:00Z' },
            { id: 903, competition_id: 701, user_id: 82, username: 'earlyBird', status: 'waitlisted', is_deleted: false, created_at: '2026-09-02T00:00:00Z' },
            { id: 904, competition_id: 702, user_id: 83, username: 'queueA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
            { id: 905, competition_id: 702, user_id: 84, username: 'queueB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-02T00:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { competitions: 800, registrations: 950, audit_logs: 900, error_logs: 900, push_log: 100 },
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

test('v2.21.0：沒有 waitlist_order 欄位時，候補順位仍依報名時間（不是 id）', async () => {
    const res = await api('/api/competitions/701/teams', { token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, true, 'v2.20.0 的欄位在，審核功能仍可用');
    assert.strictEqual(body.canReorderWaitlist, false, '沒有欄位就不能調整順序（前端據此隱藏按鈕）');
    assert.deepStrictEqual(body.waitlisted.map((r) => r.username), ['earlyBird', 'lateJoiner']);
    assert.deepStrictEqual(body.waitlisted.map((r) => r.waitlist_position), [1, 2]);
});

test('v2.21.0：調整順位在未執行 migration 時回 503 ＋ 指引，且不改任何資料', async () => {
    const res = await api('/api/competitions/702/waitlist/reorder', { method: 'POST', token: adminToken(), body: { order: [905, 904] } });
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /v2\.21\.0 migration/);
    assert.match(body.error, /2026-09-26-v2\.21\.0-waitlist-order\.sql/);
    assert.ok(state.tables.registrations.every((r) => r.waitlist_order === undefined), '不該寫入不存在的欄位');
});

test('v2.21.0：指定遞補不需要 waitlist_order，未執行 migration 時仍可用', async () => {
    const res = await api('/api/registrations/905/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.registration.status, 'confirmed');
    assert.strictEqual(body.registration.review_note.includes('指定遞補'), true);
    assert.strictEqual(state.tables.registrations.find((r) => r.id === 905).status, 'confirmed');
    assert.strictEqual(state.tables.registrations.find((r) => r.id === 904).status, 'waitlisted');
});

test('v2.21.0：未執行 migration 時，自動遞補一樣挑「先報名」的那一位', async () => {
    // 701：名額 1 已滿（taken）＋ 候補 earlyBird(1)、lateJoiner(2)
    const res = await api('/api/registrations/901', { method: 'DELETE', token: adminToken() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.promoted.username, 'earlyBird', '要挑最早報名的人');
    assert.strictEqual(state.tables.registrations.find((r) => r.id === 903).status, 'confirmed');
});
