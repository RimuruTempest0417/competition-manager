/* v2.24.0：尚未執行 recurrence migration 時的降級行為（獨立成檔！）
 *
 * 為什麼要獨立：欄位探測結果在行程內快取，同一個行程不會中途翻轉。
 *
 * 沒執行 migration 時該有的樣子：
 *   ① 複製賽事照常可用（它不需要新欄位）——而且複製品不會有任何週期欄位，
 *      免得寫入一個不存在的欄位讓整筆新增失敗
 *   ② 設定週期的端點回 503＋檔名指引
 *   ③ 「立即建立下一場」也回 503（不是 500，也不是靜靜地沒做事）
 *   ④ 每日 cron 不會因此壞掉：週期性部分回報 schema: 'missing'，推播照常
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v224-recurrence-nomig-secret';
const CRON = 'v224-recurrence-nomig-cron';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = CRON;

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        // 這一場「沒有」recurrence 相關欄位
        competitions: [
            {
                id: 851, name: '舊資料庫的賽事', location: '澳門', date: '2026-12-01', time: '09:00',
                description: '說明', is_registration_open: true, category: 'road', tags: [],
                is_team_event: false, team_size: null, max_registrations: 50,
                registration_deadline: null, requires_approval: false, waitlist_enabled: true,
                waitlist_notify: true, registration_start_at: null, registration_end_at: null,
                is_deleted: false, created_at: '2026-01-01T00:00:00Z'
            }
        ],
        registrations: [],
        teams: [],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    // 讓假 Supabase 假裝 competitions 沒有這三個欄位
    missingColumns: { competitions: ['recurrence', 'recurrence_until', 'recurrence_parent_id'] },
    nextId: { competitions: 900, registrations: 6000, teams: 8000, audit_logs: 1000, error_logs: 1000, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const comp = (id) => state.tables.competitions.find((c) => c.id === id);

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

test('沒有 migration 時：複製賽事照常可用（不會因為少欄位就壞掉）', async () => {
    const before = state.tables.competitions.length;
    const res = await fetch(`${base}/api/competitions/851/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
        body: '{}'
    });
    assert.strictEqual(res.status, 201, '複製只需要既有欄位');
    const copy = await res.json();
    assert.strictEqual(state.tables.competitions.length, before + 1);
    assert.strictEqual(copy.name, '舊資料庫的賽事（複製）');
    assert.ok(!('recurrence' in copy) || copy.recurrence === undefined, '不可以寫入不存在的欄位');
});

test('沒有 migration 時：設定週期回 503 並指引要跑哪個 SQL', async () => {
    const res = await fetch(`${base}/api/competitions/851/recurrence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
        body: JSON.stringify({ recurrence: 'weekly' })
    });
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /v2\.24\.0/);
    assert.match(body.error, /2026-09-26-v2\.24\.0-recurrence\.sql/);
    assert.strictEqual(comp(851).recurrence, undefined, '不可以偷偷寫進去');
});

test('沒有 migration 時：立即建立下一場回 503（不是 500）', async () => {
    const res = await fetch(`${base}/api/competitions/851/recurrence/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
        body: '{}'
    });
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /v2\.24\.0/);
});

test('沒有 migration 時：每日 cron 照常運作，週期性部分明確回報未啟用', async () => {
    const res = await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: `Bearer ${CRON}` } });
    assert.strictEqual(res.status, 200, '少了週期欄位不該讓整個 cron 壞掉');
    const body = await res.json();
    assert.ok(body.recurring, '要有週期性賽事的處理結果');
    assert.strictEqual(body.recurring.created, 0);
    assert.ok(
        body.recurring.schema === 'missing' || body.recurring.checked === 0,
        `沒有欄位時應該回報未啟用或檢查 0 個系列，實際：${JSON.stringify(body.recurring)}`
    );
});
