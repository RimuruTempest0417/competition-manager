/* v3.0.0 海報縮圖（列表載入優化）
 *
 * 驗的是「有沒有縮圖都要能正常運作」這條線：
 *   1. 上傳帶縮圖 → 存起來，回應附 thumbUrl 與省下的量
 *   2. ?variant=thumb → 回縮圖（並標示 X-Poster-Variant: thumb）
 *   3. 沒有縮圖（舊海報／未跑 migration）→ 自動退回原圖（full-fallback），不是 404
 *   4. 縮圖超過上限 → 只存原圖並在回應說明原因（不靜默忽略）
 *   5. 列表帶 poster_thumb_url；沒有海報時為 null
 *   6. 換海報時會清掉舊縮圖（不會出現「新海報配舊縮圖」）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v300-poster-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

// 1x1 PNG 與一張小 JPEG 的 data URL（內容不重要，重點是 mime 與大小）
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const TINY_JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const BIG_THUMB = `data:image/png;base64,${'A'.repeat(400 * 1024)}`;   // 超過 250KB 上限

function buildState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
            competitions: [
                { id: 3, name: '從來沒有海報的賽事', date: '2026-12-03', time: '09:00', category: 'art', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z', poster_updated_at: null },
                { id: 1, name: '有縮圖的賽事', date: '2026-12-01', time: '09:00', category: 'track', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z', poster_updated_at: '2026-09-20T00:00:00.000Z' },
                { id: 2, name: '沒有海報的賽事', date: '2026-12-02', time: '09:00', category: 'ball', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z', poster_updated_at: null }
            ],
            competition_posters: [],
            registrations: [],
            competition_staff: [],
            push_log: [],
            error_logs: [],
            audit_logs: [],
            app_settings: []
        },
        nextId: { audit_logs: 1, error_logs: 1 },
        missingColumns: {},
        log: []
    };
}

let base = '';
let state = null;
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken()}` });

test.before(async () => {
    state = buildState();
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

const uploadPoster = (id, body) => fetch(`${base}/api/competitions/${id}/poster`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body)
});

test('上傳海報帶縮圖：存下縮圖、回應附 thumbUrl 與省下的流量', async () => {
    const res = await uploadPoster(1, { dataUrl: TINY_PNG, thumbDataUrl: TINY_JPG });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.thumbUrl && body.thumbUrl.includes('variant=thumb'), '回應要附縮圖網址');
    assert.strictEqual(typeof body.thumb_bytes, 'number', '回應要附縮圖大小');
    assert.strictEqual(typeof body.thumb_saved, 'number',
        '回應要說明省下多少流量（縮圖比原圖大時會是負數，照實回報）');

    const row = state.tables.competition_posters.find((p) => String(p.competition_id) === '1');
    assert.ok(row.thumb_data, `縮圖要真的寫進資料庫（實際：${row && row.thumb_data}）`);
    assert.strictEqual(row.thumb_mime, 'image/jpeg');
    assert.strictEqual(row.thumb_bytes, Buffer.from(TINY_JPG.split(',')[1], 'base64').length);

    const audit = state.log.filter((e) => String(e.url).includes('audit_logs') && e.body);
    const text = JSON.stringify(audit);
    assert.ok(text.includes('縮圖'), `稽核要記下縮圖資訊（實際紀錄：${text.slice(0, 200)}）`);
});

test('?variant=thumb 回縮圖，並用標頭標示實際回的是哪一種', async () => {
    const thumb = await fetch(`${base}/api/competitions/1/poster?variant=thumb`);
    assert.strictEqual(thumb.status, 200);
    assert.strictEqual(thumb.headers.get('x-poster-variant'), 'thumb');
    assert.strictEqual(thumb.headers.get('content-type'), 'image/jpeg');
    assert.strictEqual(Number(thumb.headers.get('content-length')), Buffer.from(TINY_JPG.split(',')[1], 'base64').length);

    const full = await fetch(`${base}/api/competitions/1/poster`);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.headers.get('content-type'), 'image/png', '不帶 variant 仍然是原圖');
    assert.ok(Number(full.headers.get('content-length')) > 0);

    // 兩種回應都能設快取，列表載入才有意義
    assert.ok(/max-age=86400/.test(thumb.headers.get('cache-control') || ''));
});

test('沒有縮圖（舊海報）→ 自動退回原圖，不是 404', async () => {
    // 模擬「舊資料」：直接塞一筆只有原圖的海報
    state.tables.competition_posters.push({
        competition_id: 2, mime: 'image/png', bytes: 500, data: TINY_PNG.split(',')[1],
        uploaded_by: 'owner', updated_at: '2026-09-01T00:00:00.000Z', thumb_mime: null, thumb_bytes: null, thumb_data: null
    });
    const res = await fetch(`${base}/api/competitions/2/poster?variant=thumb`);
    assert.strictEqual(res.status, 200, '沒有縮圖也要服務，不能 404');
    assert.strictEqual(res.headers.get('x-poster-variant'), 'full-fallback', '要標示這是退回原圖');
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
});

test('縮圖超過上限：只存原圖並在回應說明原因（不靜默忽略）', async () => {
    const res = await uploadPoster(2, { dataUrl: TINY_PNG, thumbDataUrl: BIG_THUMB });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.thumbUrl, null);
    assert.ok(/超過/.test(body.thumb_note || ''), '要說明為什麼沒有縮圖');

    const row = state.tables.competition_posters.find((p) => String(p.competition_id) === '2');
    assert.strictEqual(row.thumb_data, null, '過大的縮圖不該被存下來');
});

test('換海報時清掉舊縮圖（不會新海報配舊縮圖）', async () => {
    // 先上傳一張有縮圖的
    await uploadPoster(2, { dataUrl: TINY_PNG, thumbDataUrl: TINY_JPG });
    let row = state.tables.competition_posters.find((p) => String(p.competition_id) === '2');
    assert.ok(row.thumb_data);

    // 再換一張「沒有帶縮圖」的 → 舊縮圖必須被清掉
    await uploadPoster(2, { dataUrl: TINY_PNG });
    row = state.tables.competition_posters.find((p) => String(p.competition_id) === '2');
    assert.strictEqual(row.thumb_data, null, '換海報後不該留著舊縮圖');

    const res = await fetch(`${base}/api/competitions/2/poster?variant=thumb`);
    assert.strictEqual(res.headers.get('x-poster-variant'), 'full-fallback');
});

test('列表帶 poster_thumb_url；從來沒有海報的是 null', async () => {
    const list = await (await fetch(`${base}/api/competitions`)).json();
    const withPoster = list.find((c) => c.id === 1);
    const without = list.find((c) => c.id === 3);
    assert.ok(withPoster.poster_thumb_url.includes('variant=thumb'), '有海報要有縮圖網址');
    assert.ok(withPoster.poster_thumb_url.includes('v='), '帶版本參數才能在換圖後更新快取');
    assert.strictEqual(without.poster_thumb_url, null, '從來沒有海報就沒有縮圖網址');
});
