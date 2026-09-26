/* v3.0.0 海報縮圖：未跑 migration（沒有 thumb_* 欄位）時的降級行為
 *
 * 為什麼獨立成檔：欄位探測結果在「行程內」快取（正結果快取整輪、負結果 60 秒），
 * 同一個測試檔裡先跑「有欄位」再假裝「沒有欄位」是測不出來的 —— 快取已經記住了。
 * 所以未跑 migration 的情境一律自己一個檔案、從頭就是沒有欄位的狀態。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v300-poster-nomig-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const TINY_JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            { id: 1, name: '測試賽事', date: '2026-12-01', time: '09:00', category: 'track', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z', poster_updated_at: null }
        ],
        competition_posters: [],
        registrations: [],
        competition_staff: [],
        push_log: [],
        error_logs: [],
        audit_logs: [],
        app_settings: []
    },
    // 舊資料庫：thumb_* 欄位不存在（migration 還沒跑）
    missingColumns: { competition_posters: ['thumb_data', 'thumb_mime', 'thumb_bytes'] },
    nextId: { audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET)}`
});

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

test('未跑 migration：上傳海報照常成功，只是沒有縮圖（不該 503 也不該壞掉）', async () => {
    const res = await fetch(`${base}/api/competitions/1/poster`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ dataUrl: TINY_PNG, thumbDataUrl: TINY_JPG })
    });
    assert.strictEqual(res.status, 200, '沒有縮圖欄位也要能上傳海報');
    const body = await res.json();
    assert.strictEqual(body.thumbUrl, null, '沒有縮圖欄位就不能宣稱有縮圖網址');
    assert.ok(body.posterUrl.includes('/poster'), '原圖網址照常');

    const row = state.tables.competition_posters.find((p) => String(p.competition_id) === '1');
    assert.strictEqual(row.thumb_data, undefined, '不該硬塞不存在的欄位（否則真實 Supabase 會回 42703）');
    assert.ok(row.data, '原圖一定要存下來');
    assert.strictEqual(row.mime, 'image/png');
});

test('未跑 migration：?variant=thumb 自動退回原圖，不是 404', async () => {
    const res = await fetch(`${base}/api/competitions/1/poster?variant=thumb`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-poster-variant'), 'full-fallback');
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
});

test('未跑 migration：列表的 poster_thumb_url 仍在（有海報），前端會自動退回原圖', async () => {
    const list = await (await fetch(`${base}/api/competitions`)).json();
    const comp = list.find((c) => c.id === 1);
    assert.ok(comp.poster_thumb_url, '有海報就有縮圖網址（讀不到縮圖時會退回原圖）');
    assert.ok(comp.poster_updated_at, '上傳後要更新 poster_updated_at');
});
