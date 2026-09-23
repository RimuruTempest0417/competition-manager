/* 匯入 / 匯出 API 的端到端測試。
   為了不碰真實資料庫，這裡起一個「假的 Supabase」HTTP 服務，實作本專案用到的
   PostgREST 行為（admin_users 查詢、competitions 讀寫、audit_logs 寫入），
   再以真實的 JWT 呼叫 Express app，驗證授權、驗證、去重、正規化與稽核紀錄。 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const SECRET = 'integration-test-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    hasTaxonomyColumns: true,
    adminUsers: [{ id: 1, username: 'tester', password: 'pw', role: 'super_admin' }],
    competitions: [{ id: 10, name: '既有賽事', date: '2026-01-01', is_deleted: false, category: null, tags: [] }],
    inserted: [],
    auditLogs: []
};

function startStubSupabase() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const url = new URL(req.url, 'http://127.0.0.1');
                const table = url.pathname.replace(/^\/rest\/v1\//, '');
                const accept = String(req.headers.accept || '');
                const wantsObject = accept.includes('vnd.pgrst.object+json');
                const payload = body ? JSON.parse(body) : null;
                const send = (status, data) => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data === undefined ? [] : data));
                };

                if (req.method === 'GET') {
                    const select = url.searchParams.get('select') || '*';

                    if (table === 'admin_users') {
                        let rows = state.adminUsers;
                        const id = url.searchParams.get('id');
                        const username = url.searchParams.get('username');
                        if (id) rows = rows.filter((u) => `eq.${u.id}` === id);
                        if (username) rows = rows.filter((u) => u.username === username.replace(/^eq\./, ''));
                        if (wantsObject) {
                            return rows.length ? send(200, rows[0]) : send(406, { code: 'PGRST116', message: 'no rows' });
                        }
                        return send(200, rows);
                    }

                    if (table === 'competitions') {
                        // 模擬尚未執行 migration：查詢 category/tags 會回 42703
                        if (select.includes('category') && !state.hasTaxonomyColumns) {
                            return send(400, { code: '42703', message: 'column competitions.category does not exist' });
                        }
                        return send(200, state.competitions);
                    }

                    if (table === 'audit_logs') return send(200, state.auditLogs);
                    return send(200, []);
                }

                if (req.method === 'POST') {
                    if (table === 'competitions') {
                        const rows = Array.isArray(payload) ? payload : [payload];
                        const created = rows.map((r) => {
                            const row = Object.assign({ id: 1000 + state.inserted.length }, r);
                            state.inserted.push(row);
                            state.competitions.push(row);
                            return row;
                        });
                        return send(201, created);
                    }
                    if (table === 'audit_logs') {
                        state.auditLogs.push.apply(state.auditLogs, Array.isArray(payload) ? payload : [payload]);
                        return send(201, []);
                    }
                    return send(201, []);
                }

                send(200, []);
            });
        });

        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('CSV 匯入 / 匯出 API 端到端', async (t) => {
    const stub = await startStubSupabase();
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ sub: 1, username: 'tester', role: 'super_admin' }, SECRET);
    const auth = { Authorization: `Bearer ${token}` };

    t.after(() => { server.close(); stub.close(); });

    await t.test('未帶 token 匯出 → 401', async () => {
        const res = await fetch(`${base}/api/competitions/export.csv`);
        assert.strictEqual(res.status, 401);
    });

    await t.test('匯出 CSV：檔頭、BOM、分類轉中文標籤', async () => {
        state.competitions = [
            { id: 10, name: '既有賽事', date: '2026-01-01', time: '09:00', location: '台北', category: 'ball', tags: ['公開組'], is_registration_open: true, description: '說明', is_deleted: false }
        ];

        const res = await fetch(`${base}/api/competitions/export.csv`, { headers: auth });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /text\/csv/);
        assert.match(res.headers.get('content-disposition') || '', /attachment; filename="competitions-\d{4}-\d{2}-\d{2}\.csv"/);

        // 注意：fetch 的 text() 會依規範剝除 BOM，因此要用原始位元組判斷
        const buf = Buffer.from(await res.arrayBuffer());
        assert.deepStrictEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '應帶 UTF-8 BOM（Excel 不亂碼）');

        const lines = buf.toString('utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
        assert.deepStrictEqual(lines[0].split(','), ['名稱', '分類', '標籤', '地點', '開始日期', '開始時間', '結束日期', '結束時間', '開放報名', '簡介']);
        assert.strictEqual(lines[1], '既有賽事,球類運動,公開組,台北,2026-01-01,09:00,,,是,說明');
        assert.ok(state.auditLogs.some((l) => l.action === 'EXPORT_COMPETITIONS'), '應寫入匯出稽核紀錄');
    });

    await t.test('匯入：正常/重複/格式錯誤三種列各一', async () => {
        state.competitions = [{ id: 10, name: '既有賽事', date: '2026-01-01', is_deleted: false }];
        state.inserted = [];

        const res = await fetch(`${base}/api/competitions/import`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify({
                rows: [
                    { name: '  新賽事 A  ', category: '球拍運動', tags: 'A, a、B', location: '高雄', date: '2026/10/5', time: '9:00', end_date: '2026.10.6', end_time: '17:00', is_registration_open: '是', description: '備註' },
                    { name: '既有賽事', date: '2026-01-01' },
                    { name: '', date: '2026-02-01' }
                ]
            })
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();

        assert.strictEqual(data.total, 3);
        assert.strictEqual(data.created, 1, '應只有 1 筆成功');
        assert.strictEqual(data.skipped.length, 1, '重複的應被跳過');
        assert.strictEqual(data.failed.length, 1, '缺名稱的應失敗');
        assert.match(data.failed[0].reason, /缺少比賽名稱/);
        assert.strictEqual(data.skipped[0].index, 2, '回報的列號應為原始列號');

        const inserted = state.inserted[0];
        assert.strictEqual(inserted.name, '新賽事 A', '名稱應去除前後空白');
        assert.strictEqual(inserted.category, 'racket', '中文分類標籤應轉為 id');
        assert.deepStrictEqual(inserted.tags, ['A', 'B'], '標籤應去重（忽略大小寫）');
        assert.strictEqual(inserted.date, '2026-10-05', '日期應正規化為 YYYY-MM-DD');
        assert.strictEqual(inserted.time, '09:00', '時間應補零');
        assert.strictEqual(inserted.end_date, '2026-10-06');
        assert.strictEqual(inserted.is_registration_open, true);
        assert.strictEqual(inserted.is_deleted, false);
        assert.ok(inserted.created_at, '應帶建立時間');

        assert.ok(state.auditLogs.some((l) => l.action === 'IMPORT_COMPETITIONS' && /成功 1 筆/.test(l.details || '')),
            '稽核紀錄應包含匯入統計');
    });

    await t.test('匯入：同批次內的重複也會被跳過', async () => {
        state.competitions = [];
        state.inserted = [];

        const res = await fetch(`${base}/api/competitions/import`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify({
                rows: [
                    { name: '重複賽事', date: '2026-05-01' },
                    { name: '重複賽事', date: '2026-05-01' },
                    { name: '重複賽事', date: '2026-05-02' }
                ]
            })
        });

        const data = await res.json();
        assert.strictEqual(data.created, 2, '同名但不同日期視為不同賽事');
        assert.strictEqual(data.skipped.length, 1);
    });

    // 「資料庫尚未 migration」的情境另立測試檔（欄位偵測在行程內有快取，
    // 同一個行程無法中途切換狀態，見 import-no-migration.test.js）

    await t.test('匯入：參數錯誤與筆數上限', async () => {
        const post = (body) => fetch(`${base}/api/competitions/import`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify(body)
        });

        assert.strictEqual((await post({})).status, 400, '缺少 rows 應 400');
        assert.strictEqual((await post({ rows: [] })).status, 400, '空陣列應 400');
        assert.strictEqual((await post({ rows: [{ name: '' }, { name: '   ' }] })).status, 400, '全部缺名稱應 400');
        assert.strictEqual((await post({ rows: [{ name: '有效' }, { name: '' }] })).status, 200, '部分有效仍應匯入');

        const tooMany = Array.from({ length: 501 }, (_, i) => ({ name: `賽事${i}` }));
        assert.strictEqual((await post({ rows: tooMany })).status, 400, '超過單次上限應 400');

        const ok500 = Array.from({ length: 500 }, (_, i) => ({ name: `上限賽事${i}`, date: '2026-07-01' }));
        const res500 = await post({ rows: ok500 });
        assert.strictEqual(res500.status, 200, '剛好 500 筆應可匯入');
        assert.strictEqual((await res500.json()).created, 500);
    });
});
