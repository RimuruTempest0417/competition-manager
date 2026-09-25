/* v2.19.0：登出要留稽核紀錄（LOGOUT）。
 *
 * 為什麼獨立成檔：`server.js` 一旦 require 就固定連到當時的假 Supabase，
 * 同一檔案裡再起第二個假服務沒有用（會打到已關閉的前一個）。
 * 不同資料庫狀態 → 一律獨立檔案（同 *_no-migration 系列的作法）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v219-logout-audit-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

test('v2.19.0：登出要留稽核紀錄（LOGOUT）', async () => {
    const state = {
        tables: {
            admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
            audit_logs: [],
            error_logs: []
        },
        nextId: { audit_logs: 500, error_logs: 500 },
        log: []
    };
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const token = jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
        const res = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { success: true });

        const logged = state.tables.audit_logs.filter((a) => a.action === 'LOGOUT');
        assert.strictEqual(logged.length, 1, '登出必須留一筆 LOGOUT 稽核');
        assert.strictEqual(logged[0].user_id, 'owner');
        assert.match(String(logged[0].details), /web_owner/);

        // 未認證不可留紀錄（也不可洩漏任何東西）
        const anon = await fetch(base + '/api/auth/logout', { method: 'POST' });
        assert.strictEqual(anon.status, 401);
        assert.strictEqual(state.tables.audit_logs.filter((a) => a.action === 'LOGOUT').length, 1, '未認證的登出不可留紀錄');
    } finally {
        server.close();
        stub.close();
    }
});
