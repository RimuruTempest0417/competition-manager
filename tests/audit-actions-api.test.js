/* v2.19.0：新補上的稽核紀錄（登出、測試推播）真的會寫入資料庫。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v219-audit-actions-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
            audit_logs: [],
            error_logs: [],
            app_settings: [],
            push_subscriptions: [{ id: 7, endpoint: 'https://127.0.0.1:9/abc', p256dh: 'k', auth: 'a', is_active: true }]
        },
        nextId: { audit_logs: 500, error_logs: 500 },
        log: []
    };
}


test('v2.19.0：實際送出推播要留稽核紀錄（SEND_PUSH，含成功與失敗）', async () => {
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-key';
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        // 端點故意指向不可連的地方：送出一定失敗，但「有嘗試送出」就該留紀錄
        const res = await fetch(`${base}/api/push/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: 'https://127.0.0.1:9/abc' })
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));

        const logged = state.tables.audit_logs.filter((a) => a.action === 'SEND_PUSH');
        assert.strictEqual(logged.length, 1, '送出測試推播必須留一筆 SEND_PUSH 稽核');
        assert.strictEqual(String(logged[0].target_id), '7');
        assert.match(String(logged[0].details), /"source":"test"/);
    } finally {
        server.close();
        stub.close();
    }
});
