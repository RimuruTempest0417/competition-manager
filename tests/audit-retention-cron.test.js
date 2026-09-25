/* v2.16.0：稽核日誌「保留天數」由每日排程順便清理的自動化行為測試。
 *
 * 重點：**預設不刪任何東西**——只有設了 AUDIT_RETENTION_DAYS（且 >= 30 天）才會清理。
 * 這是刻意的：稽核紀錄是事後追查用的，不能因為部署了新版本就開始默默刪資料。
 * 環境變數在請求時才讀取，所以測試中可以直接新增／移除來驗證兩種行為。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const { startFakeSupabase } = require('./support/fake-supabase');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'v216-audit-retention-secret';
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = 'cron-secret-for-tests';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'rimuru', password: 'plain', role: 'web_owner' }],
        competitions: [],
        registrations: [],
        push_subscriptions: [],
        push_log: [],
        audit_logs: [
            { id: 1, user_id: 'rimuru', action: 'LOGIN_SUCCESS', details: null, user_agent: '', created_at: daysAgo(120) },
            { id: 2, user_id: 'rimuru', action: 'LOGIN_SUCCESS', details: null, user_agent: '', created_at: daysAgo(100) },
            { id: 3, user_id: 'rimuru', action: 'LOGIN_SUCCESS', details: null, user_agent: '', created_at: daysAgo(10) },
            { id: 4, user_id: 'rimuru', action: 'LOGIN_SUCCESS', details: null, user_agent: '', created_at: daysAgo(1) }
        ],
        error_logs: []
    },
    nextId: {}
};

test('v2.16.0 稽核日誌保留天數（每日排程順便清理）', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const cron = () => fetch(base + '/api/cron/reminders', { headers: { Authorization: 'Bearer cron-secret-for-tests' } });

    t.after(() => {
        delete process.env.AUDIT_RETENTION_DAYS;
        server.close();
        stub.close();
    });

    await t.test('沒設定 AUDIT_RETENTION_DAYS：完全不會刪任何稽核紀錄', async () => {
        delete process.env.AUDIT_RETENTION_DAYS;
        const before = state.tables.audit_logs.length;
        const res = await cron();
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.ok, true);
        assert.strictEqual(data.audit_purged, null, '未啟用時應回 null（代表沒做這件事）');
        assert.strictEqual(state.tables.audit_logs.length, before);
    });

    await t.test('設定 90 天：只刪 90 天前的，較新的留著並留下稽核紀錄', async () => {
        process.env.AUDIT_RETENTION_DAYS = '90';
        const res = await cron();
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.audit_purged, 2, '120 天前與 100 天前那兩筆要被刪');

        const ids = state.tables.audit_logs.map((l) => l.id);
        assert.ok(!ids.includes(1) && !ids.includes(2), '超過保留期的要刪掉');
        assert.ok(ids.includes(3) && ids.includes(4), '保留期內的一筆都不能少');

        const purgeAudit = state.tables.audit_logs.find((l) => l.action === 'PURGE_AUDIT_LOGS');
        assert.ok(purgeAudit, '自動清理要留稽核紀錄');
        assert.strictEqual(purgeAudit.user_id, 'system');
        assert.match(String(purgeAudit.details), /"source":"cron"/);
    });

    await t.test('天數設得太小（＜30）時視為未設定，不刪（避免手誤刪光）', async () => {
        state.tables.audit_logs.push({ id: 9, user_id: 'rimuru', action: 'LOGIN_SUCCESS', details: null, user_agent: '', created_at: daysAgo(200) });
        process.env.AUDIT_RETENTION_DAYS = '7';
        const data = await (await cron()).json();
        assert.strictEqual(data.audit_purged, null);
        assert.ok(state.tables.audit_logs.some((l) => l.id === 9), '設定不合理時不可刪資料');
    });
});
