/* 「資料庫尚未執行 v2.7.0 migration」時的匯入行為。
   獨立成檔的原因：欄位偵測結果在行程內會被快取（避免每個請求都查一次），
   因此必須在行程開始、尚未探測前就讓假 Supabase 處於「沒有 category/tags」的狀態。 */
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
    competitions: [],
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
                const select = url.searchParams.get('select') || '*';
                const payload = body ? JSON.parse(body) : null;
                const send = (status, data) => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data === undefined ? [] : data));
                };

                if (req.method === 'GET') {
                    if (table === 'admin_users') {
                        const rows = state && [{ id: 1, username: 'tester', role: 'super_admin' }];
                        return send(200, String(req.headers.accept || '').includes('vnd.pgrst.object+json') ? rows[0] : rows);
                    }
                    if (table === 'competitions') {
                        // 這個假資料庫「沒有」category / tags 欄位
                        if (select.includes('category') || select.includes('tags')) {
                            return send(400, { code: '42703', message: 'column competitions.category does not exist' });
                        }
                        return send(200, state.competitions);
                    }
                    return send(200, []);
                }

                if (req.method === 'POST' && table === 'competitions') {
                    const rows = Array.isArray(payload) ? payload : [payload];
                    const created = rows.map((r, i) => Object.assign({ id: 500 + i }, r));
                    state.inserted.push.apply(state.inserted, created);
                    state.competitions.push.apply(state.competitions, created);
                    return send(201, created);
                }
                if (req.method === 'POST' && table === 'audit_logs') {
                    state.auditLogs.push.apply(state.auditLogs, Array.isArray(payload) ? payload : [payload]);
                    return send(201, []);
                }
                send(201, []);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('尚未 migration 時：匯入仍成功，但略過分類/標籤並回報警告', async (t) => {
    const stub = await startStubSupabase();
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ sub: 1, username: 'tester', role: 'super_admin' }, SECRET);

    t.after(() => { server.close(); stub.close(); });

    const res = await fetch(`${base}/api/competitions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows: [{ name: '未 migration 匯入', date: '2026-06-01', category: '球類運動', tags: 'A' }] })
    });

    assert.strictEqual(res.status, 200, '沒有欄位時仍應匯入成功，不可整批失敗');
    const data = await res.json();
    assert.strictEqual(data.created, 1);
    assert.ok(data.warnings.some((w) => /category \/ tags/.test(w)), '應明確警告分類/標籤未寫入');

    const inserted = state.inserted[0];
    assert.strictEqual(inserted.name, '未 migration 匯入');
    assert.strictEqual(inserted.category, undefined, '不應送出 category 欄位（避免 42703 讓整批失敗）');
    assert.strictEqual(inserted.tags, undefined, '不應送出 tags 欄位');
    assert.strictEqual(inserted.date, '2026-06-01');

    // 同一行程後續請求應沿用快取，不必再探測一次
    const res2 = await fetch(`${base}/api/competitions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows: [{ name: '第二筆', date: '2026-06-02', category: '球類運動' }] })
    });
    const data2 = await res2.json();
    assert.strictEqual(data2.created, 1);
    assert.strictEqual(state.inserted[1].category, undefined);
    assert.ok(data2.warnings.some((w) => /category \/ tags/.test(w)));
});
