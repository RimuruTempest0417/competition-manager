/* v3.5.2：自動化檢查流量不寫系統錯誤日誌
 *
 * 背景：`tests/browser/prod-smoke.js` 會對正式站故意送出壞 JSON 與無效權杖來驗證拒絕行為。
 * 那是預期中的回應，不是系統異常，但伺服器照規矩記錄 → 2026-09-26 觀察到 28 筆
 * `malformed_json_body` 全是它造成的（UA=node、path=/api/auth/login），把提示橫幅與巡檢清單灌成假訊號。
 *
 * 這份測試釘住三件事：
 *   1. 帶了有效標記（X-CM-Self-Test，JWT_SECRET 簽、purpose:'self_test'）→ **不寫**錯誤日誌，但回應行為完全不變
 *   2. 沒帶標記 → 照樣寫（不能因為多了這個機制就漏記真實錯誤）
 *   3. 標記簽章不對 → 照樣寫（標記不是「任何人都能按的靜音鍵」）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v352-self-test-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';   // 由 bootApp 覆寫

function baseState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: 'owner', password: 'plain-owner123', role: 'web_owner', is_active: true }],
            error_logs: [],
            audit_logs: [],
            competitions: [],
            registrations: [],
            app_settings: []
        },
        missingColumns: {},
        nextId: { error_logs: 900, audit_logs: 900 }
    };
}

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return { stub, server, base };
}

const selfTestHeader = (secret = SECRET) => ({
    'X-CM-Self-Test': jwt.sign({ sub: 0, username: 'prod-smoke', purpose: 'self_test' }, secret, { expiresIn: '5m' })
});

const brokenJson = (base, headers) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: '{ 這不是合法 JSON'
});

const settle = () => new Promise((r) => setTimeout(r, 300));   // logErrorToDb 為非阻塞

test('v3.5.2 帶有效標記的檢查流量：回應照舊，但不寫錯誤日誌', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const res = await brokenJson(base, selfTestHeader());
    assert.strictEqual(res.status, 400, '壞 JSON 仍必須回 400（標記不改變回應行為）');
    assert.match((await res.json()).error, /格式錯誤/);

    await settle();
    assert.strictEqual(state.tables.error_logs.length, 0, '帶標記的檢查流量不應寫入任何錯誤日誌');

    // 健康端點要能證明「標記真的被認得」（而不是剛好什麼都沒記）
    const token = jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET, { expiresIn: '5m' });
    const health = await fetch(`${base}/api/admin/error-logs/health`, { headers: { Authorization: 'Bearer ' + token } });
    const h = await health.json();
    assert.strictEqual(health.status, 200);
    assert.ok(h.self_test_skipped >= 1, `健康端點應回報略過筆數，實際 ${JSON.stringify(h.self_test_skipped)}`);
});

test('v3.5.2 沒帶標記或簽章不對：照樣寫入（不會漏記真實錯誤）', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    // 沒有任何標記 → 一般使用者送壞 JSON，必須被記錄
    await brokenJson(base);
    await settle();
    assert.ok(state.tables.error_logs.some((l) => l.error_type === 'malformed_json_body'),
        '沒有標記時必須照常記錄 malformed_json_body');

    // 假標記（用別的密鑰簽）→ 也不能靜音
    await brokenJson(base, selfTestHeader('attacker-secret'));
    await settle();
    const malformedCount = state.tables.error_logs.filter((l) => l.error_type === 'malformed_json_body').length;
    assert.strictEqual(malformedCount, 2, `偽造標記不該生效，實際記錄 ${malformedCount} 筆`);

    // 亂寫的字串標記 → 一樣照記
    await brokenJson(base, { 'X-CM-Self-Test': 'not-a-jwt' });
    await settle();
    assert.strictEqual(state.tables.error_logs.filter((l) => l.error_type === 'malformed_json_body').length, 3);
});

test('v3.5.2 無效權杖的 401 檢查流量也不寫日誌（auth_invalid_token）', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    // prod-smoke 有一堆「拿亂打的權杖打受保護端點」的探測，這些以前會留下 auth_invalid_token
    const bad = await fetch(`${base}/api/admin/users`, {
        headers: Object.assign({ Authorization: 'Bearer definitely-wrong' }, selfTestHeader())
    });
    assert.strictEqual(bad.status, 401, '無效權杖仍必須回 401');
    await settle();
    assert.strictEqual(state.tables.error_logs.filter((l) => l.error_type === 'auth_invalid_token').length, 0,
        '帶標記的無效權杖檢查不應寫入 auth_invalid_token');

    // 對照：沒有標記時要記
    await fetch(`${base}/api/admin/users`, { headers: { Authorization: 'Bearer definitely-wrong' } });
    await settle();
    assert.ok(state.tables.error_logs.some((l) => l.error_type === 'auth_invalid_token'),
        '沒有標記的無效權杖仍應被記錄');
});
