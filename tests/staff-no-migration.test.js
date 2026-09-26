/* v2.27.0：沒有執行 migration 時的降級行為（獨立成檔）
 *
 * 為什麼要獨立：欄位／資料表探測的結果在行程內有快取，同一個測試檔裡
 * 不可能同時測「有」和「沒有」兩種資料庫狀態。這裡整支都在「缺欄位／缺表」的世界。
 *
 * 要驗的是「功能沒開要說清楚，而且不能拖垮別的」：
 *   ① 工作人員清單照樣回得出（空清單＋schema_ready:false＋檔名），不是錯誤畫面
 *   ② 指派與移除回 503 並附檔名（使用者知道該做什麼）
 *   ③ 賽事仍可建立／更新，地圖連結沒存進去要誠實回報（map_url_saved:false）
 *   ④ 地圖連結照樣可用：用地址自動產生（不依賴資料庫欄位）
 *   ⑤ /api/registration-counts 少一個工作人員數字也不能整包失敗
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');
const CMVenue = require('../public/js/venue');

const SECRET = 'v227-nomigration-secret';
const MIGRATION_FILE = 'migrations/2026-09-26-v2.27.0-venue-staff.sql';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 5, username: 'judgeLin', password: 'x', role: 'admin', is_active: true }
        ],
        competitions: [
            { id: 861, name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', is_deleted: false }
        ],
        registrations: [
            { id: 1, competition_id: 861, user_id: 5, username: 'judgeLin', is_deleted: false }
        ],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    // 沒跑 migration：沒有 competition_staff 表、competitions 也沒有 map_url 欄位
    missingTables: ['competition_staff'],
    missingColumns: { competitions: ['map_url'] },
    nextId: { competitions: 900, audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken()}` });

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

test('工作人員清單：沒有資料表時回空清單＋schema_ready:false＋檔名，不是錯誤', async () => {
    const res = await fetch(`${base}/api/competitions/861/staff`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.schema_ready, false);
    assert.deepStrictEqual(body.staff, []);
    assert.match(body.hint, new RegExp(MIGRATION_FILE.replace(/[./]/g, '\\$&')));
    assert.strictEqual(body.roles.length, 5, '角色選單還是要回得出，前端才知道有哪些角色');
});

test('指派與移除：回 503 並附上要執行的檔名', async () => {
    const assign = await fetch(`${base}/api/competitions/861/staff`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ user_id: 5, role: 'referee' })
    });
    assert.strictEqual(assign.status, 503);
    assert.match((await assign.json()).error, /v2\.27\.0-venue-staff\.sql/);

    const remove = await fetch(`${base}/api/staff/1`, { method: 'DELETE', headers: authHeaders() });
    assert.strictEqual(remove.status, 503);
    assert.match((await remove.json()).error, /v2\.27\.0-venue-staff\.sql/);
});

test('賽事仍可建立：地圖連結沒存進去要誠實回報，不要假裝成功', async () => {
    const res = await fetch(`${base}/api/competitions`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ name: '沒 migration 也能建', location: '澳門運動場', date: '2026-10-20', time: '09:00', map_url: 'https://maps.app.goo.gl/x' })
    });
    assert.strictEqual(res.status, 200, '缺欄位不該讓整筆賽事存不進去');
    const body = await res.json();
    assert.strictEqual(body.map_url_saved, false);
    assert.match(body.warning, /地圖連結欄位/);
    assert.match(body.warning, /v2\.27\.0-venue-staff\.sql/);
    assert.strictEqual(body.map_url, undefined, '沒有欄位就不該帶 map_url 進 payload');
});

test('賽事仍可更新：沒帶地圖連結時，警告不該出現（沒有東西被丟掉）', async () => {
    const res = await fetch(`${base}/api/competitions/861`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.map_url_saved, undefined);
    assert.strictEqual(body.warning, undefined);
});

test('地圖連結不依賴資料庫：用地址自動產生，沒有欄位也照樣有地圖可按', async () => {
    const list = await (await fetch(`${base}/api/competitions`)).json();
    const comp = list.find((c) => c.id === 861);
    assert.strictEqual(comp.map_url, CMVenue.autoMapUrl('澳門氹仔運動場'));
    assert.strictEqual(comp.map_url_auto, true);
    assert.strictEqual(comp.map_url_custom, '');
});

test('其他功能不受影響：報名人數照常、只是少一個工作人員數字', async () => {
    const res = await fetch(`${base}/api/registration-counts`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.unavailable, undefined, '不該整包變成 unavailable');
    assert.strictEqual(body.counts['861'], 1);
    assert.deepStrictEqual(body.staff, {});
});
