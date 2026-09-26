/* v2.27.0：場地地圖連結＋工作人員指派的 API 測試
 *
 * 驗的是「指派指對人、改角色不會變成兩筆、地圖連結存不進去要講」：
 *   ① 工作人員清單（公開，只回角色與帳號名稱）
 *   ② 指派＝新增、改角色＝更新同一列（同一場同一人只有一列）
 *   ③ 沒有 migration 時的降級（另行測試：staff-no-migration）
 *   ④ 地圖連結：合法網址可存、不安全／不像網址的一律 400、沒填就用地址自動產生
 *   ⑤ 權限：一般使用者不能指派也不能移除
 *   ⑥ 每個寫入動作都留稽核
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');
const CMVenue = require('../public/js/venue');

const SECRET = 'v227-venue-staff-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 5, username: 'judgeLin', password: 'x', role: 'admin', is_active: true },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true },
            { id: 92, username: 'runnerB', password: 'x', role: 'user', is_active: false }
        ],
        competitions: [
            { id: 861, name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', is_deleted: false, map_url: null },
            { id: 862, name: '春季盃', location: '', date: '2026-03-01', time: '08:00', is_deleted: false, map_url: 'https://maps.app.goo.gl/custom' },
            { id: 863, name: '無地點賽事', location: '', date: '2026-04-01', time: '07:00', is_deleted: false, map_url: null }
        ],
        competition_staff: [],
        registrations: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    nextId: { competition_staff: 700, competitions: 900, audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const staffOf = (id) => state.tables.competition_staff.filter((r) => String(r.competition_id) === String(id));
const auditsOf = (action) => state.tables.audit_logs.filter((a) => a.action === action);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) server.close();
    if (stub) stub.close();
});

test('工作人員清單：公開端點、空的時候也回得出角色選單', async () => {
    const res = await fetch(`${base}/api/competitions/861/staff`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.schema_ready, true);
    assert.deepStrictEqual(body.staff, []);
    assert.strictEqual(body.summary.total, 0);
    assert.deepStrictEqual(body.roles.map((r) => r.id), ['referee', 'recorder', 'photographer', 'medical', 'other']);
});

test('指派工作人員：新增一筆、回得出角色標籤、留下稽核', async () => {
    const res = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ user_id: 5, role: 'referee', note: '主場地' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.changed, 'created');
    assert.deepStrictEqual(body.assigned, { user_id: 5, username: 'judgeLin', role: 'referee', role_label: '裁判' });
    assert.strictEqual(body.summary.total, 1);
    assert.strictEqual(body.summary.by_role.referee, 1);

    const row = body.staff.find((s) => s.user_id === 5);
    assert.strictEqual(row.username, 'judgeLin');
    assert.strictEqual(row.role_label, '裁判');
    assert.strictEqual(row.note, '主場地');
    assert.strictEqual(row.role_emoji, '⚖️');

    const audit = auditsOf('ASSIGN_STAFF');
    assert.strictEqual(audit.length, 1);
    assert.match(audit[0].details, /指派工作人員：judgeLin 為「裁判」（主場地）/);
    assert.strictEqual(audit[0].target_id, '861');
});

test('改角色＝更新同一列，不會變成兩筆（稽核寫出前後角色）', async () => {
    const res = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ user_id: 5, role: 'photographer' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.changed, 'updated');
    assert.strictEqual(staffOf(861).length, 1, '同一場同一人只能有一列');
    assert.strictEqual(staffOf(861)[0].role, 'photographer');

    const audit = auditsOf('ASSIGN_STAFF')[1];
    assert.match(audit.details, /調整工作人員 judgeLin 的角色：裁判 → 攝影/);
});

test('沒帶 note 不會清掉既有備註；帶空字串才清掉', async () => {
    await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ user_id: 5, role: 'photographer', note: '第二場地' })
    });
    assert.strictEqual(staffOf(861)[0].note, '第二場地');

    await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ user_id: 5, role: 'recorder' })
    });
    assert.strictEqual(staffOf(861)[0].note, '第二場地', '沒帶 note 欄位＝不要動既有備註');

    const res = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ user_id: 5, role: 'recorder', note: '   ' })
    });
    const body = await res.json();
    assert.strictEqual(body.staff.find((s) => s.user_id === 5).note, null, '帶空字串＝清掉備註');
});

test('指派輸入不合法：帳號編號、角色、備註長度都要擋下並講清楚', async () => {
    const cases = [
        [{ user_id: '沒有', role: 'referee' }, /帳號編號不對/],
        [{ user_id: 5, role: '評審' }, /角色不對/],
        [{ user_id: 5, role: 'referee', note: '甲'.repeat(201) }, /備註最多 200 字/]
    ];
    for (const [payload, pattern] of cases) {
        const res = await fetch(`${base}/api/competitions/861/staff`, {
            method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify(payload)
        });
        assert.strictEqual(res.status, 400, JSON.stringify(payload));
        assert.match((await res.json()).error, pattern);
    }
});

test('指派對象：不存在的帳號 404、停用帳號 400、不存在的賽事 404', async () => {
    const missing = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ user_id: 999, role: 'referee' })
    });
    assert.strictEqual(missing.status, 404);
    assert.match((await missing.json()).error, /找不到這個帳號/);

    const inactive = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ user_id: 92, role: 'referee' })
    });
    assert.strictEqual(inactive.status, 400);
    assert.match((await inactive.json()).error, /停用中的帳號/);

    const noComp = await fetch(`${base}/api/competitions/4242/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ user_id: 5, role: 'referee' })
    });
    assert.strictEqual(noComp.status, 404);
    assert.match((await noComp.json()).error, /找不到這筆賽事/);
});

test('移除工作人員：留稽核、之後清單就沒有他', async () => {
    const staffId = staffOf(861)[0].id;
    const res = await fetch(`${base}/api/staff/${staffId}`, { method: 'DELETE', headers: authHeaders(ownerToken()) });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.summary.total, 0);
    assert.deepStrictEqual(body.staff, []);
    assert.strictEqual(body.removed.username, 'judgeLin');

    const audit = auditsOf('REMOVE_STAFF');
    assert.strictEqual(audit.length, 1);
    assert.match(audit[0].details, /移除工作人員：judgeLin（記錄）/);

    const again = await fetch(`${base}/api/staff/${staffId}`, { method: 'DELETE', headers: authHeaders(ownerToken()) });
    assert.strictEqual(again.status, 404);
    assert.match((await again.json()).error, /找不到這筆工作人員指派/);

    const bad = await fetch(`${base}/api/staff/abc`, { method: 'DELETE', headers: authHeaders(ownerToken()) });
    assert.strictEqual(bad.status, 400);
});

test('權限：一般使用者不能指派也不能移除，未登入一律擋下；讀取是公開的', async () => {
    const assign = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(userToken()), body: JSON.stringify({ user_id: 5, role: 'referee' })
    });
    assert.strictEqual(assign.status, 403);

    const remove = await fetch(`${base}/api/staff/700`, { method: 'DELETE', headers: authHeaders(userToken()) });
    assert.strictEqual(remove.status, 403);

    const anon = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: 5, role: 'referee' })
    });
    assert.strictEqual(anon.status, 401);

    const read = await fetch(`${base}/api/competitions/861/staff`);
    assert.strictEqual(read.status, 200);
});

test('工作人員人數：/api/registration-counts 會回聚合數字（不含誰是誰）', async () => {
    await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ user_id: 5, role: 'medical' })
    });
    await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ user_id: 91, role: 'recorder' })
    });

    const res = await fetch(`${base}/api/registration-counts`);
    const body = await res.json();
    assert.strictEqual(body.staff['861'], 2);
    assert.strictEqual(JSON.stringify(body).includes('judgeLin'), false, '聚合端點不該出現帳號名稱');
});

test('地圖連結：合法網址存得進去、沒填就是用地址自動產生', async () => {
    const created = await fetch(`${base}/api/competitions`, {
        method: 'POST', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ name: '地圖測試賽', location: '澳門奧林匹克體育中心', date: '2026-10-10', time: '09:00', map_url: 'maps.app.goo.gl/abc123' })
    });
    assert.strictEqual(created.status, 200);
    const comp = await created.json();
    assert.strictEqual(comp.map_url, 'https://maps.app.goo.gl/abc123', '沒帶協定要自動補 https://');

    const list = await (await fetch(`${base}/api/competitions`)).json();
    const withCustom = list.find((c) => c.id === comp.id);
    assert.strictEqual(withCustom.map_url, 'https://maps.app.goo.gl/abc123');
    assert.strictEqual(withCustom.map_url_custom, 'https://maps.app.goo.gl/abc123');
    assert.strictEqual(withCustom.map_url_auto, false);

    const auto = list.find((c) => c.id === 861);
    assert.strictEqual(auto.map_url, CMVenue.autoMapUrl('澳門氹仔運動場'), '沒填自訂連結＝用地址自動產生');
    assert.strictEqual(auto.map_url_auto, true);

    const noMap = list.find((c) => c.id === 863);
    assert.strictEqual(noMap.map_url, '', '沒有地點也沒有自訂連結＝沒有地圖可按');
    assert.strictEqual(CMVenue.hasMap(noMap), false);
});

test('地圖連結：不安全或不像網址的一律 400，不要靜默丟掉', async () => {
    const bad = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '氹仔運動場', 'https://'];
    for (const map_url of bad) {
        const res = await fetch(`${base}/api/competitions`, {
            method: 'POST', headers: authHeaders(ownerToken()),
            body: JSON.stringify({ name: '壞連結測試', location: '澳門', date: '2026-10-11', time: '09:00', map_url })
        });
        assert.strictEqual(res.status, 400, map_url);
        assert.match((await res.json()).error, /地圖連結格式不對/);
    }
});

test('地圖連結：更新賽事可以換連結，也能清空（沒填就回到地址自動產生）', async () => {
    const updated = await fetch(`${base}/api/competitions/861`, {
        method: 'PUT', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', map_url: 'https://maps.google.com/?q=氹仔運動場' })
    });
    assert.strictEqual(updated.status, 200);
    const row = await updated.json();
    assert.ok(row.map_url.includes('maps.google.com'));

    const audit = state.tables.audit_logs.filter((a) => a.action === 'UPDATE_COMPETITION').pop();
    assert.match(audit.details, /地圖連結/);

    const cleared = await fetch(`${base}/api/competitions/861`, {
        method: 'PUT', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', map_url: '' })
    });
    assert.strictEqual(cleared.status, 200);
    const after = (await (await fetch(`${base}/api/competitions`)).json()).find((c) => c.id === 861);
    assert.strictEqual(after.map_url_custom, '', '清空後資料庫不留自訂連結');
    assert.strictEqual(after.map_url, CMVenue.autoMapUrl('澳門氹仔運動場'), '清空後回到地址自動產生');

    const badUpdate = await fetch(`${base}/api/competitions/861`, {
        method: 'PUT', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', map_url: 'javascript:alert(1)' })
    });
    assert.strictEqual(badUpdate.status, 400);
});

test('複製賽事會沿用同一場地的地圖連結', async () => {
    await fetch(`${base}/api/competitions/861`, {
        method: 'PUT', headers: authHeaders(ownerToken()),
        body: JSON.stringify({ name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', map_url: 'https://maps.app.goo.gl/venue861' })
    });
    const res = await fetch(`${base}/api/competitions/861/duplicate`, {
        method: 'POST', headers: authHeaders(ownerToken()), body: JSON.stringify({ name: '秋季盃（複製）' })
    });
    assert.strictEqual(res.status, 201);
    const copy = await res.json();
    assert.strictEqual(copy.map_url, 'https://maps.app.goo.gl/venue861');
    assert.ok(copy.copied_fields.includes('map'), '回報的複製欄位要含地圖');
});
