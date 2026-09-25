/* v2.17.0：批次標記錯誤日誌為已處理的 API 端到端測試。
 *
 * 這個端點是「每次發版巡檢後自動收工」的關鍵：巡檢腳本會把剛讀到的那批紀錄標記為已處理，
 * 讓首頁提示橫幅只針對「下一批新錯誤」再提醒。因此授權、範圍限制（只能動指定的 id）、
 * migration 缺失時的降級、以及稽核紀錄都必須有測試守住。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v217-resolve-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

function seedState(missingColumns = {}) {
    return {
        tables: {
            admin_users: [
                { id: 1, username: 'rimuru', password: 'plain', role: 'web_owner' },
                { id: 2, username: 'viewer', password: 'plain', role: 'user' }
            ],
            error_logs: [
                { id: 11, error_type: 'unhandled_server_error', message: '壞掉了', path: '/api/x', severity: 'error', resolved: false, created_at: iso(30) },
                { id: 12, error_type: 'malformed_json_body', message: '壞 JSON', path: '/api/auth/login', severity: 'warn', resolved: false, created_at: iso(20) },
                { id: 13, error_type: 'auth_invalid_token', message: '權杖過期', path: '/api/auth/me', severity: 'error', resolved: false, created_at: iso(10) },
                { id: 14, error_type: 'unhandled_server_error', message: '早就處理過了', path: '/api/y', severity: 'error', resolved: true, resolved_at: iso(60), resolved_by: 'rimuru', created_at: iso(90) }
            ],
            audit_logs: [],
            competitions: []
        },
        nextId: { audit_logs: 1 },
        missingColumns
    };
}

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { stub, app, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('v2.17.0 批次標記錯誤日誌為已處理', async (t) => {
    const state = seedState();
    const { stub, app, server, base } = await bootApp(state);

    const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
    const owner = { Authorization: 'Bearer ' + sign(1, 'rimuru', 'web_owner') };
    const viewer = { Authorization: 'Bearer ' + sign(2, 'viewer', 'user') };
    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    await t.test('授權：未登入 401、無管理權限 403', async () => {
        assert.strictEqual((await post('/api/admin/error-logs/resolve', { ids: [11] })).status, 401);
        assert.strictEqual((await post('/api/admin/error-logs/resolve', { ids: [11] }, viewer)).status, 403);
    });

    await t.test('參數驗證：非陣列、非正整數、超過單次上限都要擋', async () => {
        const notArray = await post('/api/admin/error-logs/resolve', { ids: '11,12' }, owner);
        assert.strictEqual(notArray.status, 400);
        assert.match((await notArray.json()).error, /必須是陣列/);

        const bad = await post('/api/admin/error-logs/resolve', { ids: [11, 'abc'] }, owner);
        assert.strictEqual(bad.status, 400);
        assert.match((await bad.json()).error, /正整數/);

        const zero = await post('/api/admin/error-logs/resolve', { ids: [0] }, owner);
        assert.strictEqual(zero.status, 400);

        const tooMany = await post('/api/admin/error-logs/resolve', { ids: Array.from({ length: 501 }, (_, i) => i + 1) }, owner);
        assert.strictEqual(tooMany.status, 400);
        assert.match((await tooMany.json()).error, /最多標記 500 筆/);

        // 不得因為一次壞請求就改動任何資料
        assert.ok(state.tables.error_logs.filter((l) => !l.resolved).length === 3);
    });

    await t.test('只標記指定的 id：其他紀錄不受影響，並留下稽核與處理者', async () => {
        const res = await post('/api/admin/error-logs/resolve', { ids: [11, 12, 11] }, owner);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.resolved, 2, '重複的 id 只算一次');
        assert.strictEqual(data.resolved_by, 'rimuru');

        const rows = Object.fromEntries(state.tables.error_logs.map((l) => [l.id, l]));
        assert.strictEqual(rows[11].resolved, true);
        assert.strictEqual(rows[12].resolved, true);
        assert.strictEqual(rows[11].resolved_by, 'rimuru');
        assert.ok(rows[11].resolved_at, '要記錄處理時間');
        assert.strictEqual(rows[13].resolved, false, '沒指定到的紀錄不能被動到');

        const audit = state.tables.audit_logs.find((l) => l.action === 'RESOLVE_ERROR_LOGS');
        assert.ok(audit, '批次標記一定要留稽核紀錄');
        assert.match(String(audit.details), /"resolved":2/);
    });

    await t.test('all_unresolved：一次清掉所有未處理，已處理的不重複計算', async () => {
        const res = await post('/api/admin/error-logs/resolve', { all_unresolved: true }, owner);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.resolved, 1, '只剩 id 13 是未處理');

        // 再跑一次：沒有未處理的紀錄 → 0 筆（重複執行安全）
        const again = await (await post('/api/admin/error-logs/resolve', { all_unresolved: true }, owner)).json();
        assert.strictEqual(again.resolved, 0);
        assert.match(again.message, /沒有需要標記/);
        assert.ok(state.tables.error_logs.every((l) => l.resolved === true));
        assert.ok(state.tables.audit_logs.filter((l) => l.action === 'RESOLVE_ERROR_LOGS').length >= 2,
            '每次批次標記都各自留一筆稽核');
    });

    await t.test('不存在的 id：不報錯、回 0 筆', async () => {
        const data = await (await post('/api/admin/error-logs/resolve', { ids: [999999] }, owner)).json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.resolved, 0);
    });

    await t.test('parseResolveIds：純函式邊界（去重、上限、型別）', () => {
        const { parseResolveIds } = app.__test__;
        assert.deepStrictEqual(parseResolveIds([3, 3, 5]).ids, [3, 5]);
        assert.deepStrictEqual(parseResolveIds(['7']).ids, [7], '字串數字要接受（表單來源）');
        assert.ok(parseResolveIds([]).ids.length === 0);
        assert.match(parseResolveIds(null).error, /陣列/);
        assert.match(parseResolveIds([1, -2]).error, /正整數/);
        assert.match(parseResolveIds(Array.from({ length: 501 }, (_, i) => i + 1)).error, /500/);
    });
});

