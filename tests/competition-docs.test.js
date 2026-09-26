/* v3.3.0（P1-6）：賽事規程 PDF 附件的 API 測試
 *
 * 驗的是「規程是公開資訊、但只有管理員能改」：
 *   ① 只有管理員能上傳／移除（未登入 401、一般使用者 403）
 *   ② 檔案一定要真的是 PDF（光看 MIME 或副檔名不算）、上限 3MB
 *   ③ 上傳後任何人都能讀，回傳 application/pdf 且位元組一模一樣
 *   ④ 預設 inline（直接在瀏覽器開），?download=1 則下載
 *   ⑤ 一場賽事一份，重複上傳是覆蓋，不會變成兩份
 *   ⑥ 移除後就讀不到（404）
 *   ⑦ 列表只帶中介資料（標籤／大小／時間），不會把 PDF 內容塞進列表
 *   ⑧ 資料庫還沒建表時給 503 與明確提示，不是 500
 *   ⑨ 每個寫入動作都留稽核
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v330-docs-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

/* 一個最小但結構正確的 PDF（開頭必須是 %PDF- ） */
const PDF_BYTES = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1'
);
const pdfDataUrl = (buffer = PDF_BYTES) => `data:application/pdf;base64,${buffer.toString('base64')}`;

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 5, username: 'judgeLin', password: 'x', role: 'admin', is_active: true },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 861, name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', category: '田徑路跑', is_deleted: false, max_registrations: 10, created_at: '2026-09-01T00:00:00.000Z' },
            { id: 862, name: '春季盃', location: '', date: '2026-03-01', time: '08:00', category: '田徑路跑', is_deleted: false, max_registrations: 10, created_at: '2026-09-02T00:00:00.000Z' }
        ],
        competition_docs: [],
        registrations: [],
        push_subscriptions: [],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    nextId: { audit_logs: 1, error_logs: 1, push_log: 1, app_settings: 1 },
    missingTables: [],
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const judgeToken = () => jwt.sign({ sub: 5, username: 'judgeLin', role: 'admin' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const api = async (method, url, body, token) => {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: token ? authHeaders(token) : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
    return { status: res.status, body: parsed, text, headers: res.headers };
};

const docsOf = (id) => state.tables.competition_docs.filter((d) => String(d.competition_id) === String(id));
const auditsOf = (action) => state.tables.audit_logs.filter((a) => a.action === action);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) server.close();
    if (stub) stub.close();
});

/* ── ① 權限 ── */

test('未登入不能上傳規程（401）', async () => {
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl() });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(docsOf(861).length, 0, '未登入不該寫入任何資料');
});

test('一般使用者不能上傳、也不能移除規程（403）', async () => {
    const up = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl() }, userToken());
    assert.strictEqual(up.status, 403);
    const del = await api('DELETE', '/api/competitions/861/doc', undefined, userToken());
    assert.strictEqual(del.status, 403);
    assert.strictEqual(docsOf(861).length, 0);
});

/* ── ② 檔案驗證 ── */

test('非 PDF 的檔案會被拒絕（就算 MIME 假裝是 PDF）', async () => {
    const png = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: png }, judgeToken());
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /PDF/);
    assert.strictEqual(docsOf(861).length, 0);
});

test('內容不是 PDF（改了副檔名的文字檔）也會被拒絕', async () => {
    const fake = `data:application/pdf;base64,${Buffer.from('這只是一般的文字檔，不是 PDF').toString('base64')}`;
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: fake }, judgeToken());
    assert.strictEqual(res.status, 400);
    assert.strictEqual(docsOf(861).length, 0);
});

test('沒有附檔、空字串、壞 base64 都回 400', async () => {
    for (const payload of [{}, { dataUrl: '' }, { dataUrl: 'not-a-base64!!!' }, { dataUrl: 'data:application/pdf;base64,' }]) {
        const res = await api('POST', '/api/competitions/861/doc', payload, judgeToken());
        assert.strictEqual(res.status, 400, `payload=${JSON.stringify(payload)} 應該被拒絕`);
    }
    assert.strictEqual(docsOf(861).length, 0);
});

test('超過 3MB 的規程回 413，且不會寫入', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(3 * 1024 * 1024 + 64, 0x20)]);
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl(big) }, judgeToken());
    assert.strictEqual(res.status, 413);
    assert.match(res.body.error, /3MB/);
    assert.strictEqual(docsOf(861).length, 0);
});

/* ── ③④ 上傳與公開讀取 ── */

test('管理員上傳規程：寫入資料庫、留稽核、回傳可讀網址', async () => {
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl(), label: '秋季盃競賽規程' }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.label, '秋季盃競賽規程');
    assert.strictEqual(res.body.bytes, PDF_BYTES.length);
    assert.ok(res.body.doc_url.includes('/api/competitions/861/doc'), res.body.doc_url);

    const rows = docsOf(861);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].label, '秋季盃競賽規程');
    assert.strictEqual(rows[0].mime, 'application/pdf');
    assert.strictEqual(rows[0].uploaded_by, 'judgeLin');
    assert.deepStrictEqual(Buffer.from(rows[0].data, 'base64'), PDF_BYTES, '存進去的內容要和原檔一模一樣');

    const audits = auditsOf('UPLOAD_DOC');
    assert.strictEqual(audits.length, 1);
    assert.match(audits[0].details, /秋季盃競賽規程/);
});

test('訪客（未登入）就能讀到規程，位元組完全相同且是 PDF', async () => {
    const res = await fetch(`${base}/api/competitions/861/doc`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition') || '', /^inline;/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual(bytes, PDF_BYTES, '讀回的內容必須和上傳的完全一致');
    assert.strictEqual(bytes.slice(0, 5).toString('latin1'), '%PDF-');
});

test('?download=1 時改成附件下載（檔名帶中文附件名稱）', async () => {
    const res = await fetch(`${base}/api/competitions/861/doc?download=1`);
    assert.strictEqual(res.status, 200);
    const disposition = res.headers.get('content-disposition') || '';
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename\*=UTF-8''/, '中文檔名要用 RFC 5987 編碼');
    assert.match(decodeURIComponent(disposition), /秋季盃競賽規程\.pdf/);
});

test('沒有上傳規程的賽事回 404（不是 500、也不是空檔案）', async () => {
    const res = await fetch(`${base}/api/competitions/862/doc`);
    assert.strictEqual(res.status, 404);
});

test('不存在的賽事：上傳回 404', async () => {
    const res = await api('POST', '/api/competitions/999999/doc', { dataUrl: pdfDataUrl() }, judgeToken());
    assert.strictEqual(res.status, 404);
});

/* ── ⑤ 覆蓋 ── */

test('同一場賽事再上傳一次是覆蓋（不會變成兩份）', async () => {
    const second = Buffer.from(`${PDF_BYTES.toString('latin1')}% 第二版\n`, 'latin1');
    const res = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl(second), label: '規程第二版' }, ownerToken());
    assert.strictEqual(res.status, 200);

    const rows = docsOf(861);
    assert.strictEqual(rows.length, 1, '一場賽事只該有一份規程');
    assert.strictEqual(rows[0].label, '規程第二版');
    assert.strictEqual(rows[0].uploaded_by, 'owner');
    assert.deepStrictEqual(Buffer.from(rows[0].data, 'base64'), second);

    const read = await fetch(`${base}/api/competitions/861/doc`);
    assert.deepStrictEqual(Buffer.from(await read.arrayBuffer()), second, '讀到的應該是覆蓋後的新版');
});

test('沒有填名稱時用預設「賽事規程」', async () => {
    const res = await api('POST', '/api/competitions/862/doc', { dataUrl: pdfDataUrl() }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.label, '賽事規程');
    assert.strictEqual(docsOf(862)[0].label, '賽事規程');
});

test('名稱過長會被截短，不會撐爆資料庫', async () => {
    const long = '規'.repeat(200);
    const res = await api('POST', '/api/competitions/862/doc', { dataUrl: pdfDataUrl(), label: long }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.label.length <= 60, `實際 ${res.body.label.length}`);
});

/* ── ⑦ 列表只帶中介資料 ── */

test('賽事列表帶出規程中介資料，且不會把 PDF 內容塞進列表', async () => {
    const res = await api('GET', '/api/competitions', undefined, judgeToken());
    assert.strictEqual(res.status, 200);
    const list = Array.isArray(res.body) ? res.body : res.body.items;
    const withDoc = list.find((c) => String(c.id) === '861');
    const withoutDoc = list.find((c) => String(c.id) === '999999');
    assert.ok(withDoc.doc_url.includes('/api/competitions/861/doc'), withDoc.doc_url);
    assert.strictEqual(withDoc.doc_label, '規程第二版');
    assert.strictEqual(withDoc.doc_bytes, docsOf(861)[0].bytes);
    assert.strictEqual(withoutDoc, undefined);
    assert.strictEqual(res.text.includes(PDF_BYTES.toString('base64').slice(0, 24)), false, '列表不該包含檔案內容');
});

/* ── ⑧ 沒有建表的降級 ── */

test('資料表還沒建時：上傳／讀取／移除都回 503 並提示要跑哪支 migration', async () => {
    state.missingTables.push('competition_docs');
    try {
        const up = await api('POST', '/api/competitions/861/doc', { dataUrl: pdfDataUrl() }, judgeToken());
        assert.strictEqual(up.status, 503);
        assert.match(up.body.error, /2026-09-26-v3\.3\.0-docs\.sql/);

        const del = await api('DELETE', '/api/competitions/861/doc', undefined, judgeToken());
        assert.strictEqual(del.status, 503);

        const get = await fetch(`${base}/api/competitions/861/doc`);
        assert.strictEqual(get.status, 503);
    } finally {
        state.missingTables.pop();
    }
});

/* ── ⑥⑨ 移除 ── */

test('管理員移除規程：留稽核、之後就讀不到', async () => {
    const before = auditsOf('DELETE_DOC').length;
    const res = await api('DELETE', '/api/competitions/861/doc', undefined, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(docsOf(861).length, 0);
    assert.strictEqual(auditsOf('DELETE_DOC').length, before + 1);
    assert.match(auditsOf('DELETE_DOC').slice(-1)[0].details, /規程第二版/);

    const read = await fetch(`${base}/api/competitions/861/doc`);
    assert.strictEqual(read.status, 404);
});

test('移除不存在的規程不會 500（重複點也安全）', async () => {
    const res = await api('DELETE', '/api/competitions/861/doc', undefined, judgeToken());
    assert.strictEqual(res.status, 200);
});
