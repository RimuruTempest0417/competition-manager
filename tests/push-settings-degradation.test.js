/* v2.25.0：推播設定表（app_settings）不存在時的降級行為（獨立成檔！）
 *
 * 為什麼要獨立：假 Supabase 只在啟動時讀一次「缺哪張表」，同一個行程不會中途翻轉。
 *
 * 沒這張表時該有的樣子：
 *   ① 讀設定 → 回預設值（每日摘要 09:00、事件全開），並誠實標記 schema_ready=false 與說明
 *   ② 寫設定 → 503＋說明（不是 500，也不是靜靜地假裝成功）
 *   ③ 每日排程照常運作：推播用預設值判斷（該發就發，不會因為讀不到設定就整個停掉），
 *      週期性賽事也照常處理
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v225-degrade-secret';
const CRON = 'v225-degrade-cron';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = CRON;

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            { id: 871, name: '賽事', date: '2026-12-01', time: '10:00', is_registration_open: true, is_deleted: false, max_registrations: 10, requires_approval: false, waitlist_enabled: false }
        ],
        registrations: [],
        push_subscriptions: [],
        push_log: [],
        audit_logs: [],
        error_logs: []
    },
    // 讓假 Supabase 假裝沒有這張表
    missingTables: ['app_settings'],
    nextId: { competitions: 900, registrations: 6000, audit_logs: 1000, error_logs: 1000, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    if (server) server.close();
    if (stub) stub.close();
});

test('沒有 app_settings 表時：讀設定回預設值並誠實說明', async () => {
    const res = await fetch(`${base}/api/push/settings`, { headers: { Authorization: `Bearer ${adminToken()}` } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, false, `回應：${JSON.stringify(body)}`);
    assert.strictEqual(body.settings.digest_time, '09:00');
    assert.strictEqual(body.settings.digest_enabled, true, '讀不到設定時仍視為開啟（不會偷偷停掉推播）');
    assert.match(String(body.hint), /app_settings/);
});

test('沒有 app_settings 表時：寫設定回 503（不會假裝成功）', async () => {
    const res = await fetch(`${base}/api/push/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
        body: JSON.stringify({ digest_time: '07:00' })
    });
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /app_settings/);
});

test('沒有 app_settings 表時：每日排程照常運作（用預設值判斷，不會整個停掉）', async () => {
    const res = await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: `Bearer ${CRON}` } });
    assert.strictEqual(res.status, 200, '讀不到設定不該讓排程回 503');
    const body = await res.json();

    assert.ok(body.digest, '仍要回報摘要狀態');
    assert.strictEqual(body.digest.scheduled, '09:00', '讀不到設定時用預設發送時間');
    assert.deepStrictEqual(body.digest.kinds, ['reminder', 'new'], '讀不到設定時事件視為全開');
    assert.ok(body.digest.local_time, '仍要用預設時間判斷現在該不該發');

    // 這是這一版真正要防的退化：欄位名不一致會讓摘要被誤判成「已關閉」，從此不再發推播
    assert.ok(!/每日摘要已關閉|都關掉了/.test(body.digest.reason),
        `讀不到設定時不該被當成關閉（實際：${body.digest.reason}）`);
    assert.ok(body.digest.ran === true || /無法發送|還沒到發送時間|今天已經發送過/.test(body.digest.reason),
        `要嘛發了、要嘛有明確原因（實際：${body.digest.reason}）`);

    assert.ok(body.recurring, '週期性賽事的功能不受影響（摘要出問題也要繼續做其他事）');
});
