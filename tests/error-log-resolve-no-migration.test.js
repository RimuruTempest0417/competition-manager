/* v2.17.0：**未執行 v2.12.0 migration**（error_logs 沒有 resolved 欄位）時的行為。
 *
 * 為什麼要單獨一個檔案：伺服器會快取「欄位探測」結果（避免每次請求都探一次），
 * 而同一個行程內的快取無法在中途翻轉（前面已成功的測試會把 resolved=true 記住）。
 * node --test 每個檔案是獨立行程，所以 migration 缺失的情境一律獨立成檔
 * （同 tests/registration-no-migration.test.js、tests/import-no-migration.test.js 的做法）。
 *
 * 預期行為：批次標記回 503 + 明確的 migration 檔案提示，且**不得改動任何資料**。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v217-no-migration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'rimuru', password: 'plain', role: 'web_owner' }],
        error_logs: [
            { id: 11, error_type: 'unhandled_server_error', message: '壞掉了', path: '/api/x', severity: 'error', created_at: new Date().toISOString() }
        ],
        audit_logs: [],
        competitions: []
    },
    nextId: { audit_logs: 1 },
    missingColumns: { error_logs: ['resolved', 'resolved_at', 'resolved_by'] }
};

test('v2.17.0 未執行 migration 時：批次標記回 503 且不改動資料', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ sub: 1, username: 'rimuru', role: 'web_owner' }, SECRET);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

    t.after(() => { server.close(); stub.close(); });

    const res = await fetch(base + '/api/admin/error-logs/resolve', {
        method: 'POST', headers, body: JSON.stringify({ ids: [11] })
    });
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /migration/);

    const resAll = await fetch(base + '/api/admin/error-logs/resolve', {
        method: 'POST', headers, body: JSON.stringify({ all_unresolved: true })
    });
    assert.strictEqual(resAll.status, 503);

    assert.strictEqual(state.tables.error_logs.length, 1, '不得刪除或改動任何紀錄');
    assert.strictEqual(state.tables.error_logs[0].resolved, undefined);
    assert.strictEqual(state.tables.audit_logs.length, 0, '降級時不該留下假的稽核紀錄');
});
