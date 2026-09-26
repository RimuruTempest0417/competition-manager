/* v3.1.0：沒有執行 migration 時的降級行為（獨立成檔）
 *
 * 為什麼要獨立：欄位／資料表探測的結果在行程內有快取，同一個測試檔裡
 * 不可能同時測「有」和「沒有」兩種資料庫狀態。這裡整支都在「缺欄位／缺表」的世界。
 *
 * 要驗的是「功能沒開要說清楚，而且不能拖垮別的」：
 *   ① 成績端點回 503 並附上 migration 檔名（使用者知道要做什麼）
 *   ② 沒有成績表時，「我的成績」回空陣列而不是 500（前台不用為了這個壞掉）
 *   ③ 賽事列表、報名、公開設定等既有功能完全不受影響
 *   ④ 寫入端點在缺表時也不能留下半筆資料
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v310-results-nomigration';
const MIGRATION_FILE = 'migrations/2026-09-27-v3.1.0-results.sql';
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
            { id: 861, name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', is_deleted: false, max_registrations: 10 }
        ],
        registrations: [
            { id: 11, competition_id: 861, user_id: 91, username: 'runnerA', status: 'confirmed', is_deleted: false }
        ],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    // 沒跑 migration：沒有 competition_results 表、competitions 也沒有 result_published_at 欄位
    missingTables: ['competition_results'],
    missingColumns: { competitions: ['result_published_at'] },
    nextId: { competitions: 900, audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const api = async (method, url, body, token) => {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: token ? authHeaders(token) : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

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

test('① 成績端點：回 503 並指出要執行哪一支 migration', async () => {
    const pub = await api('GET', '/api/competitions/861/results');
    assert.strictEqual(pub.status, 503);
    assert.match(pub.body.error, /2026-09-27-v3\.1\.0-results\.sql/);
    assert.ok(pub.body.error.includes(MIGRATION_FILE));

    const sheet = await api('GET', '/api/competitions/861/result-sheet', undefined, ownerToken());
    assert.strictEqual(sheet.status, 503);
    assert.match(sheet.body.error, /v3\.1\.0-results/);

    const save = await api('PUT', '/api/competitions/861/results', { results: [{ registration_id: 11, score_text: '12:00' }] }, ownerToken());
    assert.strictEqual(save.status, 503);
    assert.match(save.body.error, /v3\.1\.0-results/);

    const publish = await api('POST', '/api/competitions/861/results/publish', { confirm: true }, ownerToken());
    assert.strictEqual(publish.status, 503);
    assert.match(publish.body.error, /v3\.1\.0-results/);

    const unpublish = await api('POST', '/api/competitions/861/results/unpublish', { confirm: true }, ownerToken());
    assert.strictEqual(unpublish.status, 503);
});

test('② 我的成績：沒有表時回空陣列，不是 500（前台不用為此壞掉）', async () => {
    const res = await api('GET', '/api/my/results', undefined, userToken());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
    assert.strictEqual((await api('GET', '/api/my/results')).status, 401, '沒登入仍然是 401，不是 500');
});

test('③ 既有功能不受影響：賽事列表、報名名單、公開設定都照常', async () => {
    const comps = await api('GET', '/api/competitions');
    assert.strictEqual(comps.status, 200);
    const list = Array.isArray(comps.body) ? comps.body : comps.body.competitions;
    assert.strictEqual(list.some((c) => String(c.id) === '861'), true, '賽事列表照常回得出秋季盃');
    assert.strictEqual(list.find((c) => String(c.id) === '861').poster_thumb_url === undefined
        || list.find((c) => String(c.id) === '861').poster_thumb_url === null, true, '沒有海報欄位時不會硬塞縮圖網址');

    const regs = await api('GET', '/api/competitions/861/registrations', undefined, ownerToken());
    assert.strictEqual(regs.status, 200, '報名名單照常');

    const pub = await api('GET', '/api/public-config');
    assert.strictEqual(pub.status, 200, '公開設定照常');
});

test('④ 缺表時不留半筆資料，也不會寫出「成績」相關的稽核', async () => {
    const before = state.tables.audit_logs.length;
    await api('PUT', '/api/competitions/861/results', { results: [{ registration_id: 11, score_text: '12:00', status: 'finished' }] }, ownerToken());
    await api('POST', '/api/competitions/861/results/publish', { confirm: true }, ownerToken());
    assert.strictEqual(state.tables.audit_logs.filter((a) => /RESULTS/.test(String(a.action))).length, 0,
        '沒有真的寫入就不該留下「已登錄／已公布」的稽核紀錄');
    assert.strictEqual(state.tables.audit_logs.length, before);
});
