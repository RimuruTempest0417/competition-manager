/* v2.18.0：還原時「某張表失敗」的行為——必須誠實回報 partial failure。
 *
 * 為什麼單獨一個檔案：這個情境需要「資料庫缺一張表」的狀態，而假 Supabase 的狀態在啟動時固定；
 * 同一個行程內也不能換一個新的 app 實例（server.js 已經被 require 快取，會連到已關閉的假服務）。
 * node --test 每個檔案是獨立行程，所以這種「不同的資料庫狀態」一律獨立成檔（同其他 *-no-migration.test.js）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v218-restore-failure-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'rimuru', password: 'x', role: 'web_owner' }],
        competitions: [],
        push_log: [],
        audit_logs: [],
        error_logs: []
    },
    nextId: { audit_logs: 900, error_logs: 900 },
    // 這張表在（模擬的）資料庫裡不存在 → 還原它一定失敗
    missingTables: ['push_log']
};

test('v2.18.0 還原：某張表失敗時要誠實回報 partial failure，不是假裝成功', async () => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ sub: 1, username: 'rimuru', role: 'web_owner' }, SECRET);

    try {
        const backup = {
            meta: { total_rows: 1, generated_at: '2026-09-26T00:00:00.000Z', version: '2.18.0' },
            tables: { competitions: [], push_log: [{ id: 400, kind: 'reminder' }] }
        };
        backup.meta.checksum = app.__test__.backupChecksum(backup.tables);

        const res = await fetch(base + '/api/admin/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ backup, confirm: 'RESTORE' })
        });
        const data = await res.json();
        assert.strictEqual(data.success, false, '有失敗就不能回 success: true');
        assert.strictEqual(data.failures.length, 1);
        assert.strictEqual(data.failures[0].table, 'push_log');
        assert.strictEqual(data.restored, 0);
        assert.match(data.message, /失敗/);

        assert.ok(state.tables.error_logs.some((l) => l.error_type === 'restore_backup_partial_failure'),
            '部分失敗要寫進錯誤日誌（否則沒人會發現）');
        assert.ok(state.tables.audit_logs.some((l) => l.action === 'RESTORE_BACKUP'),
            '不論成敗都要留稽核紀錄');
    } finally {
        server.close();
        stub.close();
    }
});
