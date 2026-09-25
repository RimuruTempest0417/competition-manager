/* v2.16.0：稽核日誌強化（篩選、分頁、CSV 匯出、保留天數清理）的 API 端到端測試。
   用 tests/support/fake-supabase.js，完全不碰真實資料庫。
   純函式（parseAuditFilters／auditMatchesQuery／auditLogsToCsvRows）另外直接單元測試，
   因為它們是「查詢條件解讀」與「CSV 安全」的最後一道防線。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v216-audit-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

// 造 250 筆日誌，方便驗證分頁；其中夾雜不同使用者／動作／時間與「需要消歧」的詳情
const auditLogs = [];
for (let i = 0; i < 250; i += 1) {
    auditLogs.push({
        id: i + 1,
        user_id: i % 2 === 0 ? 'rimuru' : 'coach',
        action: i % 3 === 0 ? 'LOGIN_SUCCESS' : (i % 3 === 1 ? 'CREATE_COMPETITION' : 'SEND_PUSH'),
        target_id: String(1000 + i),
        details: i === 5 ? '=cmd|calc!A1' : JSON.stringify({ note: `第 ${i} 筆` }),
        user_agent: 'Mozilla/5.0 (Macintosh)',
        created_at: iso(i * 30)   // 每筆相隔 30 分鐘 → 最早約 5.2 天前
    });
}
// 一筆很舊的（400 天前）用來驗證保留天數清理
auditLogs.push({
    id: 9999, user_id: 'rimuru', action: 'LOGIN_SUCCESS', target_id: null,
    details: JSON.stringify({ note: '很舊的一筆' }), user_agent: '', created_at: iso(400 * 24 * 60)
});
// 一筆未知動作，驗證下拉選單會帶出它
auditLogs.push({
    id: 8888, user_id: 'rimuru', action: 'SOME_NEW_ACTION', target_id: null,
    details: null, user_agent: '', created_at: iso(1)
});

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'rimuru', password: 'plain-owner', role: 'web_owner' },
            { id: 2, username: 'super1', password: 'plain-super', role: 'super_admin' },
            { id: 3, username: 'admin1', password: 'plain-admin', role: 'admin' }
        ],
        competitions: [],
        audit_logs: auditLogs,
        error_logs: []
    },
    nextId: {}
};

test('v2.16.0 稽核日誌 API', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
    const as = (sub, username, role) => ({ Authorization: 'Bearer ' + sign(sub, username, role) });
    const owner = as(1, 'rimuru', 'web_owner');
    const superAdmin = as(2, 'super1', 'super_admin');
    const admin = as(3, 'admin1', 'admin');
    const get = (url, headers) => fetch(base + url, { headers: headers || {} });
    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    // ---------- 授權 ----------
    await t.test('授權：未登入 401、一般管理員 403（稽核日誌只給 super_admin／web_owner）', async () => {
        assert.strictEqual((await get('/api/audit-logs')).status, 401);
        assert.strictEqual((await get('/api/audit-logs', admin)).status, 403);
        assert.strictEqual((await get('/api/audit-logs', superAdmin)).status, 200);
        assert.strictEqual((await get('/api/audit-logs/export', admin)).status, 403);
        assert.strictEqual((await post('/api/audit-logs/cleanup', { days: 365 }, admin)).status, 403);
    });

    // ---------- 列表與分頁 ----------
    await t.test('列表：回傳分頁資訊與動作清單（新動作也列得出來）', async () => {
        const res = await get('/api/audit-logs', owner);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.returned, 100);
        assert.strictEqual(data.limit, 100);
        assert.strictEqual(data.has_more, true);
        assert.strictEqual(data.logs.length, 100);
        // 由新到舊排序
        assert.ok(data.logs[0].created_at >= data.logs[1].created_at);
        const values = data.actions.map((a) => a.value);
        assert.ok(values.includes('LOGIN_SUCCESS'));
        assert.ok(values.includes('SOME_NEW_ACTION'), '未知動作要自動出現在清單');
        assert.strictEqual(data.actions.find((a) => a.value === 'LOGIN_SUCCESS').label, '登入成功');
    });

    await t.test('分頁：offset 前進、最後一頁 has_more=false、limit 上限 500', async () => {
        const page2 = await (await get('/api/audit-logs?limit=100&offset=100', owner)).json();
        assert.strictEqual(page2.offset, 100);
        assert.strictEqual(page2.returned, 100);
        assert.strictEqual(page2.has_more, true);

        const last = await (await get('/api/audit-logs?limit=100&offset=200', owner)).json();
        assert.strictEqual(last.has_more, false);
        assert.ok(last.returned > 0);

        const clamped = await (await get('/api/audit-logs?limit=99999', owner)).json();
        assert.strictEqual(clamped.limit, 500);

        const bogus = await (await get('/api/audit-logs?limit=abc&offset=-5', owner)).json();
        assert.strictEqual(bogus.limit, 100);
        assert.strictEqual(bogus.offset, 0);
    });

    // ---------- 篩選 ----------
    await t.test('篩選：動作、使用者、時間區間、關鍵字', async () => {
        const byAction = await (await get('/api/audit-logs?action=SEND_PUSH&limit=500', owner)).json();
        assert.ok(byAction.logs.length > 0);
        assert.ok(byAction.logs.every((l) => l.action === 'SEND_PUSH'));

        const byUser = await (await get('/api/audit-logs?username=coach&limit=500', owner)).json();
        assert.ok(byUser.logs.length > 0);
        assert.ok(byUser.logs.every((l) => l.user_id === 'coach'));

        // 時間區間：只取最近 6 小時
        const from = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
        const byDate = await (await get(`/api/audit-logs?from=${encodeURIComponent(from)}&limit=500`, owner)).json();
        assert.ok(byDate.logs.length > 0 && byDate.logs.length < 20, `預期少量，實際 ${byDate.logs.length}`);
        assert.ok(byDate.logs.every((l) => l.created_at > from));

        const to = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const older = await (await get(`/api/audit-logs?to=${encodeURIComponent(to)}&limit=500`, owner)).json();
        assert.ok(older.logs.every((l) => l.created_at < to));

        // 關鍵字（大小寫不敏感，可比對詳情內容）
        const byQ = await (await get('/api/audit-logs?q=' + encodeURIComponent('第 7 筆') + '&limit=500', owner)).json();
        assert.strictEqual(byQ.logs.length, 1);
        assert.strictEqual(byQ.logs[0].id, 8);
        assert.ok(byQ.search_window > 0);

        const byUpper = await (await get('/api/audit-logs?q=login_success&limit=500', owner)).json();
        assert.ok(byUpper.logs.length > 0);
        assert.ok(byUpper.logs.every((l) => l.action === 'LOGIN_SUCCESS'));

        // 無效日期一律忽略（不得 500）
        const bad = await get('/api/audit-logs?from=not-a-date&to=2026-13-45', owner);
        assert.strictEqual(bad.status, 200);
    });

    // ---------- CSV 匯出 ----------
    await t.test('匯出 CSV：檔頭、BOM、公式注入消歧、留下匯出稽核', async () => {
        const res = await get('/api/audit-logs/export?action=SEND_PUSH', owner);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/csv/);
        assert.match(res.headers.get('content-disposition'), /attachment; filename="audit-logs-\d{4}-\d{2}-\d{2}\.csv"/);

        // fetch 的 text() 會吃掉 BOM，所以直接看原始位元組（EF BB BF）
        const bytes = new Uint8Array(await res.clone().arrayBuffer());
        assert.deepStrictEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF], '要有 BOM 讓 Excel 正確讀中文');

        const csv = await res.text();
        assert.match(csv.split('\n')[0], /時間,使用者,動作,動作說明,目標,詳情,來源 IP／裝置/);
        assert.ok(csv.includes('發送推播'), '要有中文動作說明');

        const all = await (await get('/api/audit-logs/export', owner)).text();
        assert.ok(all.includes("'=cmd|calc!A1"), '公式開頭的詳情要被消歧（前置單引號）');

        const logs = state.tables.audit_logs;
        const exportAudit = logs.find((l) => l.action === 'EXPORT_AUDIT_LOGS');
        assert.ok(exportAudit, '匯出本身也要留稽核紀錄');
        assert.strictEqual(exportAudit.user_id, 'rimuru');
    });

    // ---------- 保留天數清理 ----------
    await t.test('清理：天數下限 30、dry-run 只算不刪、實際刪除留下稽核與警告日誌', async () => {
        const tooFew = await post('/api/audit-logs/cleanup', { days: 7 }, owner);
        assert.strictEqual(tooFew.status, 400);
        assert.match((await tooFew.json()).error, /不得少於 30 天/);

        const before = state.tables.audit_logs.length;
        const preview = await (await post('/api/audit-logs/cleanup', { days: 365, dry_run: true }, owner)).json();
        assert.strictEqual(preview.success, true);
        assert.strictEqual(preview.would_delete, 1);              // 只有那筆 400 天前的
        assert.strictEqual(state.tables.audit_logs.length, before, 'dry-run 不可刪任何東西');

        const run = await (await post('/api/audit-logs/cleanup', { days: 365 }, owner)).json();
        assert.strictEqual(run.success, true);
        assert.strictEqual(run.deleted, 1);
        assert.ok(!state.tables.audit_logs.some((l) => l.id === 9999), '超過保留期的紀錄要被刪除');
        assert.ok(state.tables.audit_logs.some((l) => l.id === 8888), '保留期內的紀錄不可被誤刪');
        assert.ok(state.tables.audit_logs.some((l) => l.action === 'PURGE_AUDIT_LOGS'), '清理本身要留稽核');
        assert.ok(state.tables.error_logs.some((l) => l.error_type === 'audit_logs_purged' && l.severity === 'warn'),
            '清理要在錯誤日誌留一筆警告級紀錄（事後查得到）');
    });

    // ---------- 純函式 ----------
    await t.test('parseAuditFilters／auditMatchesQuery／auditLogsToCsvRows 純函式行為', () => {
        const { parseAuditFilters, auditMatchesQuery, auditLogsToCsvRows } = app.__test__;

        const f = parseAuditFilters({ limit: '0', offset: 'x', q: '  abc  ', from: '2026-09-01' });
        assert.strictEqual(f.limit, 1);                  // 下限 1
        assert.strictEqual(f.offset, 0);                 // 無效值回預設
        assert.strictEqual(f.q, 'abc');
        assert.match(f.from, /^2026-09-01T00:00:00\.000Z$/);
        assert.strictEqual(parseAuditFilters({}).limit, 100);
        assert.strictEqual(parseAuditFilters({ to: 'oops' }).to, null);
        assert.strictEqual(parseAuditFilters({ action: 'x'.repeat(200) }).action.length, 64);

        assert.strictEqual(auditMatchesQuery({ user_id: 'Gary' }, 'gary'), true);
        assert.strictEqual(auditMatchesQuery({ details: '{"a":"KEY"}' }, 'key'), true);
        assert.strictEqual(auditMatchesQuery({ action: 'LOGIN_SUCCESS' }, 'nope'), false);
        assert.strictEqual(auditMatchesQuery({ action: 'LOGIN_SUCCESS' }, ''), true);

        const rows = auditLogsToCsvRows([{ created_at: '2026-09-25T10:00:00.000Z', user_id: 'rimuru', action: 'LOGIN_SUCCESS', target_id: '5', details: '{"a":1}', user_agent: 'UA' }]);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[1][3], '登入成功');       // 動作中文說明
        assert.strictEqual(rows[1][5], '{"a":1}');
        assert.strictEqual(auditLogsToCsvRows([]).length, 1, '沒有資料也要有表頭');
    });
});
