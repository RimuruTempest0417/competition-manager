/* v2.18.0：資料備份與還原的 API 端到端測試。
 *
 * 這支測試守的是「資料安全」的核心承諾：
 *   1. 備份內容完整、有 checksum、可選擇要不要含日誌／海報圖片
 *   2. 預設只檢查（dry_run 不寫任何資料）
 *   3. 沒有明確 confirm 不能還原
 *   4. 還原是 upsert（有就更新、沒有就新增），而且**不會刪除**備份中沒有的資料
 *   5. checksum 不符要拒絕（除非 force），避免還原半份壞資料
 *   6. 授權只給 super_admin／web_owner
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v218-backup-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

function seedState(extra = {}) {
    return Object.assign({
        tables: {
            admin_users: [
                { id: 1, username: 'rimuru', password: 'scrypt$aa$bb', role: 'web_owner', created_at: '2026-01-01T00:00:00.000Z' },
                { id: 2, username: 'admin1', password: 'scrypt$cc$dd', role: 'admin', created_at: '2026-01-02T00:00:00.000Z' }
            ],
            competitions: [
                { id: 100, name: '春季盃', date: '2026-10-01', location: '澳門', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z' },
                { id: 101, name: '夏季盃', date: '2026-11-01', location: '香港', is_deleted: false, created_at: '2026-01-02T00:00:00.000Z' }
            ],
            registrations: [
                { id: 200, competition_id: 100, user_id: 2, is_active: true, created_at: '2026-01-03T00:00:00.000Z' }
            ],
            competition_teams: [
                { id: 300, competition_id: 100, name: 'A 隊', created_at: '2026-01-04T00:00:00.000Z' }
            ],
            competition_posters: [
                { competition_id: 100, image_data: 'data:image/png;base64,AAAA', updated_at: '2026-01-05T00:00:00.000Z' }
            ],
            app_settings: [{ key: 'site_title', value: '比賽管理系統' }],
            push_subscriptions: [{ endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a', is_active: true }],
            push_log: [{ id: 400, competition_id: 100, kind: 'reminder', sent_at: '2026-01-06T00:00:00.000Z' }],
            audit_logs: [{ id: 500, user_id: 'rimuru', action: 'LOGIN_SUCCESS', created_at: '2026-01-07T00:00:00.000Z' }],
            error_logs: [{ id: 600, error_type: 'malformed_json_body', message: 'x', created_at: '2026-01-08T00:00:00.000Z' }]
        },
        nextId: { audit_logs: 900, error_logs: 900 },
        log: []
    }, extra);
}

test('v2.18.0 資料備份與還原', async (t) => {
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
    const owner = { Authorization: 'Bearer ' + sign(1, 'rimuru', 'web_owner') };
    const superAdmin = { Authorization: 'Bearer ' + sign(2, 'admin1', 'admin') };
    const get = (url, headers) => fetch(base + url, { headers: headers || {} });
    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    // ---------- 備份 ----------
    await t.test('授權：未登入 401、一般管理員 403、超級管理員可用', async () => {
        assert.strictEqual((await get('/api/admin/backup')).status, 401);
        assert.strictEqual((await get('/api/admin/backup', superAdmin)).status, 403);
        assert.strictEqual((await get('/api/admin/backup', owner)).status, 200);
    });

    let backup = null;
    await t.test('備份內容：含核心表、meta 完整、帶 checksum、預設不含日誌', async () => {
        const res = await get('/api/admin/backup', owner);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-disposition') || '', /attachment; filename="cm-backup-.*\.json"/);
        backup = await res.json();

        assert.strictEqual(backup.meta.app, 'competition-manager');
        assert.ok(backup.meta.version, '要記錄應用版本');
        assert.ok(backup.meta.generated_at && backup.meta.generated_by);
        assert.strictEqual(backup.meta.total_rows, 10, 'app_settings 1＋admin_users 2＋competitions 2＋posters 1＋registrations 1＋teams 1＋subs 1＋push_log 1＝10');
        assert.strictEqual(backup.meta.tables.competitions.rows, 2);
        assert.match(backup.meta.checksum, /^[a-f0-9]{64}$/);

        const names = Object.keys(backup.tables);
        assert.ok(names.includes('competitions') && names.includes('admin_users') && names.includes('competition_posters'));
        assert.ok(!names.includes('audit_logs') && !names.includes('error_logs'), '日誌預設不備份（量大且已有 CSV 匯出）');

        // checksum 必須真的等於內容的雜湊（可被驗證）
        assert.strictEqual(app.__test__.backupChecksum(backup.tables), backup.meta.checksum);
        assert.strictEqual(app.__test__.verifyBackupIntegrity(backup).ok, true);

        const audit = state.tables.audit_logs.find((l) => l.action === 'EXPORT_BACKUP');
        assert.ok(audit, '備份本身要留稽核紀錄');
    });

    await t.test('備份選項：include_logs 會帶上日誌、include_posters=false 會略過海報', async () => {
        const withLogs = await (await get('/api/admin/backup?include_logs=true', owner)).json();
        assert.ok(Object.keys(withLogs.tables).includes('audit_logs'));
        assert.ok(Object.keys(withLogs.tables).includes('error_logs'));
        assert.strictEqual(withLogs.meta.tables.error_logs.rows, 1);

        const noPosters = await (await get('/api/admin/backup?include_posters=false', owner)).json();
        assert.ok(!Object.keys(noPosters.tables).includes('competition_posters'));
        assert.match(noPosters.meta.skipped.join(''), /competition_posters/);
        assert.ok(noPosters.tables.competitions.length === 2, '其他表不受影響');
    });

    await t.test('備份選項：tables= 只能挑已開放的表，不認識的表名會回報', async () => {
        const only = await (await get('/api/admin/backup?tables=competitions,admin_users', owner)).json();
        assert.deepStrictEqual(Object.keys(only.tables).sort(), ['admin_users', 'competitions']);

        const unknown = await (await get('/api/admin/backup?tables=competitions,not_a_table', owner)).json();
        assert.deepStrictEqual(unknown.meta.unknown_tables, ['not_a_table']);
        assert.deepStrictEqual(Object.keys(unknown.tables), ['competitions']);
    });

    // ---------- 還原：檢查 ----------
    await t.test('還原檢查（dry_run）：列出計畫但不寫入任何資料', async () => {
        // 只比「資料表」：稽核日誌本來就會多一筆 RESTORE_BACKUP_DRY_RUN，那是預期行為
        const dataTables = () => JSON.stringify(Object.fromEntries(
            Object.entries(state.tables).filter(([name]) => name !== 'audit_logs' && name !== 'error_logs')
        ));
        const before = dataTables();
        const res = await post('/api/admin/restore', { backup, dry_run: true }, owner);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.dry_run, true);
        assert.strictEqual(data.would_restore, backup.meta.total_rows);
        const tables = data.plan.map((p) => p.table);
        // 匯出／還原順序必須讓 competitions 先於 registrations 與 competition_posters（外部鍵相依）
        assert.ok(tables.indexOf('competitions') < tables.indexOf('registrations'));
        assert.ok(tables.indexOf('competitions') < tables.indexOf('competition_posters'));
        assert.ok(tables.indexOf('admin_users') < tables.indexOf('registrations'));
        assert.strictEqual(dataTables(), before, 'dry-run 不可改動任何資料');
        assert.ok(state.tables.audit_logs.some((l) => l.action === 'RESTORE_BACKUP_DRY_RUN'), '檢查也要留稽核');
    });

    await t.test('還原：沒有 confirm 直接拒絕（避免誤觸）', async () => {
        const res = await post('/api/admin/restore', { backup }, owner);
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /confirm/);
    });

    await t.test('還原：upsert 更新既有、新增缺少的，且不刪除備份中沒有的資料', async () => {
        // 模擬「備份之後又有人改了資料、也新增了資料」
        const plan = JSON.parse(JSON.stringify(backup));
        plan.tables.competitions = plan.tables.competitions.map((c) => (c.id === 100 ? Object.assign({}, c, { name: '春季盃（備份當下）' }) : c));
        plan.tables.competitions.push({ id: 999, name: '備份後才新增的賽事', date: '2026-12-01', is_deleted: false });
        plan.meta.checksum = app.__test__.backupChecksum(plan.tables);

        // 現在的資料庫：100 已被改名、還有一筆 102 是備份裡沒有的
        state.tables.competitions = state.tables.competitions.map((c) => (c.id === 100 ? Object.assign({}, c, { name: '春季盃（後來被改壞了）' }) : c));
        state.tables.competitions.push({ id: 102, name: '備份裡沒有的賽事', date: '2027-01-01', is_deleted: false });

        const res = await post('/api/admin/restore', { backup: plan, confirm: 'RESTORE' }, owner);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.ok(data.restored >= 9);

        const byId = Object.fromEntries(state.tables.competitions.map((c) => [c.id, c]));
        assert.strictEqual(byId[100].name, '春季盃（備份當下）', '既有資料要被備份內容覆蓋（upsert 更新）');
        assert.ok(byId[999], '備份中新增的資料要寫進去');
        assert.ok(byId[102], '**備份中沒有的資料不可被刪除**');

        const audit = state.tables.audit_logs.find((l) => l.action === 'RESTORE_BACKUP');
        assert.ok(audit, '還原必須留稽核');
        assert.match(String(audit.details), /"restored"/);
    });

    await t.test('還原：upsert 用對主鍵（app_settings 用 key、posters 用 competition_id）', async () => {
        state.log.length = 0;
        await post('/api/admin/restore', { backup, confirm: 'RESTORE' }, owner);
        const urls = state.log.filter((l) => l.method === 'POST').map((l) => l.url);
        const settings = urls.find((u) => u.includes('app_settings'));
        const posters = urls.find((u) => u.includes('competition_posters'));
        assert.match(settings, /on_conflict=key/);
        assert.match(posters, /on_conflict=competition_id/);
    });

    // ---------- 還原：保護機制 ----------
    await t.test('checksum 不符：預設拒絕，force 才放行', async () => {
        const tampered = JSON.parse(JSON.stringify(backup));
        tampered.tables.competitions[0].name = '被偷改的';

        const rejected = await post('/api/admin/restore', { backup: tampered, confirm: 'RESTORE' }, owner);
        const rejectedBody = await rejected.text();
        assert.strictEqual(rejected.status, 400, rejectedBody.slice(0, 300));
        assert.match(JSON.parse(rejectedBody).error, /checksum/);

        const forced = await post('/api/admin/restore', { backup: tampered, confirm: 'RESTORE', force: true }, owner);
        assert.strictEqual(forced.status, 200);
    });

    await t.test('結構驗證：非物件、缺 meta、不認識的表、內容不是陣列都要擋', async () => {
        const cases = [
            { backup: 'not-an-object', match: /不是物件/ },
            { backup: { tables: { competitions: [] } }, match: /缺少 meta/ },
            { backup: { meta: {}, tables: { evil_table: [] } }, match: /不認識的資料表/ },
            { backup: { meta: {}, tables: { competitions: 'oops' } }, match: /不是陣列/ },
            { backup: { meta: {}, tables: {} }, match: /沒有任何資料表/ }
        ];
        for (const c of cases) {
            const res = await post('/api/admin/restore', { backup: c.backup, confirm: 'RESTORE' }, owner);
            const text = await res.text();
            assert.strictEqual(res.status, 400, `${JSON.stringify(c.backup).slice(0, 60)} → ${text.slice(0, 300)}`);
            assert.match(JSON.parse(text).error, c.match);
        }
    });

    // ---------- 純函式 ----------
    await t.test('純函式：chunkRows／resolveBackupTables／verifyBackupIntegrity 邊界', () => {
        const { chunkRows, resolveBackupTables, verifyBackupIntegrity, backupChecksum } = app.__test__;

        assert.strictEqual(chunkRows(Array.from({ length: 401 }, (_, i) => i), 200).length, 3);
        assert.strictEqual(chunkRows([], 200).length, 0);

        const all = resolveBackupTables({});
        assert.ok(all.tables.includes('competitions') && all.tables.includes('competition_posters'));
        assert.ok(!all.tables.includes('audit_logs'));

        const noPosters = resolveBackupTables({ includePosters: false });
        assert.ok(!noPosters.tables.includes('competition_posters'));

        const withLogs = resolveBackupTables({ includeLogs: true });
        assert.ok(withLogs.tables.includes('audit_logs') && withLogs.tables.includes('error_logs'));

        const onlyKnown = resolveBackupTables({ only: ['competitions', 'bogus'] });
        assert.deepStrictEqual(onlyKnown.tables, ['competitions']);
        assert.deepStrictEqual(onlyKnown.unknown, ['bogus']);

        // checksum 不受鍵的順序影響（JSON 往返後仍可驗證）
        const a = { competitions: [{ id: 1 }], admin_users: [] };
        const b = { admin_users: [], competitions: [{ id: 1 }] };
        assert.strictEqual(backupChecksum(a), backupChecksum(b));
        assert.strictEqual(verifyBackupIntegrity({ meta: { checksum: backupChecksum(a) }, tables: a }).ok, true);
        assert.strictEqual(verifyBackupIntegrity({ meta: { checksum: 'deadbeef' }, tables: a }).ok, false);
    });
});
