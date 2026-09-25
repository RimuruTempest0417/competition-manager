/* v2.20.0：尚未執行 migration 時的降級行為（獨立成檔！）
 *
 * 為什麼要獨立一個檔案：伺服器會把「欄位探測結果」快取在行程內，同一個行程裡不會中途翻轉
 * （詳見 SKILL 的「migration 缺失的情境要獨立成檔測試」）。這裡讓假 Supabase 從一開始就
 * 假裝 competitions 沒有 requires_approval／waitlist_enabled、registrations 沒有審核欄位。
 *
 * 期待的行為：**網站照常運作**，只是「報名審核」與「候補」兩個功能停用
 * （報名一律直接核准），需要新欄位的端點回 503 並附上 migration 檔案路徑。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v220-nomigration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            // 種子資料裡的兩個開關是「舊程式寫不進去的值」——就算有人手動設了，欄位不存在時也要當成沒開
            { id: 601, name: '未 migration 的賽事', date: '2026-12-10', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1 },
            { id: 602, name: '名額已滿的賽事', date: '2026-12-11', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1 }
        ],
        registrations: [
            { id: 900, competition_id: 602, user_id: 91, username: 'someone', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    // 假裝資料庫還沒有這幾個欄位
    missingColumns: {
        competitions: ['requires_approval', 'waitlist_enabled'],
        registrations: ['reviewed_at', 'reviewed_by', 'review_note']
    },
    nextId: { competitions: 700, registrations: 950, audit_logs: 900, error_logs: 900, push_log: 10 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const userToken = (id, name) => jwt.sign({ sub: id, username: name || `u${id}`, role: 'user' }, SECRET);
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

test('未 migration：審核／候補功能自動停用，報名照舊直接核准', async () => {
    const res = await api('/api/competitions/601/register', {
        method: 'POST', token: userToken(70, 'newbie'), body: {}
    });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.strictEqual(body.status, 'confirmed', '沒有審核欄位 → 一律直接核准');
    assert.strictEqual(body.needs_approval, false);
    assert.match(body.message, /報名成功/);

    const row = state.tables.registrations.find((r) => r.user_id === 70);
    assert.strictEqual(row.status, 'confirmed');
});

test('未 migration：額滿就是擋下來（不會誤判成候補）', async () => {
    const res = await api('/api/competitions/602/register', { method: 'POST', token: userToken(71, 'late'), body: {} });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /已達上限/);
    assert.strictEqual(state.tables.registrations.filter((r) => r.competition_id === 602).length, 1);
});

test('未 migration：新增賽事時不會帶上那兩個開關（避免整筆寫入失敗）', async () => {
    const res = await api('/api/competitions', {
        method: 'POST', token: adminToken(),
        body: { name: '帶開關的賽事', date: '2026-12-20', time: '10:00', requires_approval: true, waitlist_enabled: true }
    });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const row = await res.json();
    const saved = state.tables.competitions.find((c) => String(c.id) === String(row.id));
    assert.ok(saved);
    assert.ok(!('requires_approval' in saved), '欄位不存在時不可以寫入');
    assert.ok(!('waitlist_enabled' in saved), '欄位不存在時不可以寫入');
    assert.strictEqual(saved.name, '帶開關的賽事', '其他欄位照樣寫入成功');
});

test('未 migration：審核與手動遞補端點回 503 並附上 migration 檔案路徑', async () => {
    const row = state.tables.registrations.find((r) => r.user_id === 70);
    const review = await api(`/api/registrations/${row.id}/review`, { method: 'POST', token: adminToken(), body: { action: 'approve' } });
    assert.strictEqual(review.status, 503);
    assert.match((await review.json()).error, /2026-09-26-v2\.20\.0-registration-review\.sql/);

    const promote = await api('/api/competitions/601/registrations/promote', { method: 'POST', token: adminToken(), body: {} });
    assert.strictEqual(promote.status, 503);
    assert.match((await promote.json()).error, /registration-review\.sql/);
});

test('未 migration：名單端點明確回報 schema_ready:false，且不會去查不存在的欄位', async () => {
    const res = await api('/api/competitions/601/registrations', { token: adminToken() });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.strictEqual(body.schema_ready, false);
    assert.strictEqual(body.registrations.length, 1);
    assert.strictEqual(body.registrations[0].status_label, '已核准');
    assert.strictEqual(body.counts.slots, 1);
    assert.ok(!state.log.some((url) => String(url).includes('reviewed_at')), '不可以對不存在的欄位下查詢');
});

test('未 migration：公開人數端點照舊回傳佔名額人數', async () => {
    const body = await (await api('/api/registration-counts')).json();
    assert.strictEqual(body.counts['601'], 1);
    assert.strictEqual(body.counts['602'], 1);
    assert.deepStrictEqual(body.waitlist, {}, '沒有欄位可判斷候補 → 回空物件而不是壞掉');
});
