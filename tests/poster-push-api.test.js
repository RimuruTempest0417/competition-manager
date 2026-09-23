/* v2.10.0：賽事海報（手動上傳）與 Web Push 推播的 API 端到端測試。
   同樣使用 tests/support/fake-supabase.js，完全不碰真實資料庫。
   推播實際送出會失敗（端點是測試用的假網址），因此這裡驗證的是：
   授權、驗證、資料寫入、去重與失效清理邏輯。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v210-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.SITE_UTC_OFFSET = '+08:00';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 12 小時後開賽（澳門時間）→ 應被選為開賽提醒
const soon = new Date(Date.now() + 12 * 3600 * 1000 + 8 * 3600 * 1000);
const soonDate = soon.toISOString().slice(0, 10);
const soonTime = soon.toISOString().slice(11, 16);
const far = new Date(Date.now() + 10 * 24 * 3600 * 1000);

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'admin1', password: 'plain-admin', role: 'admin' },
            { id: 2, username: 'player1', password: 'plain-player', role: 'user' }
        ],
        competitions: [
            { id: 100, name: '即將開賽盃', date: soonDate, time: soonTime, location: '台北', is_deleted: false, is_registration_open: true, created_at: '2026-01-01T00:00:00.000Z' },
            { id: 101, name: '很久以後', date: far.toISOString().slice(0, 10), time: '09:00', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z' }
        ],
        registrations: [],
        competition_teams: [],
        competition_posters: [],
        app_settings: [],
        push_subscriptions: [],
        push_log: [],
        audit_logs: []
    },
    nextId: { push_subscriptions: 1 }
};

test('v2.10.0 海報上傳與推播 API', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
    const asAdmin = { Authorization: `Bearer ${sign(1, 'admin1', 'admin')}` };
    const asPlayer = { Authorization: `Bearer ${sign(2, 'player1', 'user')}` };
    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    // ---------- 海報 ----------
    await t.test('上傳海報：授權與格式驗證', async () => {
        const png = `data:image/png;base64,${PNG_1PX}`;

        assert.strictEqual((await post('/api/competitions/100/poster', { dataUrl: png })).status, 401, '未登入應 401');
        assert.strictEqual((await post('/api/competitions/100/poster', { dataUrl: png }, asPlayer)).status, 403, '一般用戶應 403');

        const bad = await post('/api/competitions/100/poster', { dataUrl: 'not-an-image' }, asAdmin);
        assert.strictEqual(bad.status, 400);
        assert.match((await bad.json()).error, /格式錯誤/);

        const svg = await post('/api/competitions/100/poster', { dataUrl: `data:image/svg+xml;base64,${PNG_1PX}` }, asAdmin);
        assert.strictEqual(svg.status, 400, 'SVG 不可上傳（避免腳本內容）');

        assert.strictEqual((await post('/api/competitions/999/poster', { dataUrl: png }, asAdmin)).status, 404, '不存在的賽事應 404');

        // 超過 3MB
        const huge = Buffer.alloc(3 * 1024 * 1024 + 16, 7).toString('base64');
        const tooBig = await post('/api/competitions/100/poster', { dataUrl: `data:image/png;base64,${huge}` }, asAdmin);
        assert.strictEqual(tooBig.status, 413);
        assert.match((await tooBig.json()).error, /過大/);
    });

    await t.test('上傳成功後：資料表寫入、賽事標記、可取回圖片、稽核', async () => {
        const res = await post('/api/competitions/100/poster', { dataUrl: `data:image/png;base64,${PNG_1PX}` }, asAdmin);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.posterUrl, '/api/competitions/100/poster?v=' + Date.parse(state.tables.competitions.find((c) => c.id === 100).poster_updated_at));
        assert.ok(data.bytes > 10);

        const stored = state.tables.competition_posters.find((p) => String(p.competition_id) === '100');
        assert.ok(stored, '應寫入 competition_posters');
        assert.strictEqual(stored.mime, 'image/png');
        assert.strictEqual(stored.uploaded_by, 'admin1');
        assert.strictEqual(stored.data, PNG_1PX, '內容應為 base64');

        assert.ok(state.tables.competitions.find((c) => c.id === 100).poster_updated_at, 'competitions 應標記 poster_updated_at');
        assert.ok(state.tables.audit_logs.some((l) => l.action === 'UPLOAD_POSTER'), '應寫入稽核');

        // 取回
        const img = await fetch(`${base}/api/competitions/100/poster`);
        assert.strictEqual(img.status, 200);
        assert.strictEqual(img.headers.get('content-type'), 'image/png');
        assert.match(img.headers.get('cache-control') || '', /max-age=86400/);
        assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
        const buffer = Buffer.from(await img.arrayBuffer());
        assert.strictEqual(buffer.toString('base64'), PNG_1PX, '回傳的位元組應與上傳相同');

        // 沒有海報的賽事
        const none = await fetch(`${base}/api/competitions/101/poster`);
        assert.strictEqual(none.status, 404);
    });

    await t.test('移除海報：回到自動生成', async () => {
        const forbidden = await fetch(`${base}/api/competitions/100/poster`, { method: 'DELETE', headers: asPlayer });
        assert.strictEqual(forbidden.status, 403);

        const res = await fetch(`${base}/api/competitions/100/poster`, { method: 'DELETE', headers: asAdmin });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(state.tables.competition_posters.length, 0);
        assert.strictEqual(state.tables.competitions.find((c) => c.id === 100).poster_updated_at, null);
        assert.strictEqual((await fetch(`${base}/api/competitions/100/poster`)).status, 404);
    });

    // ---------- 推播 ----------
    await t.test('VAPID 公鑰：自動產生並存進 app_settings，重複呼叫結果一致', async () => {
        const first = await (await fetch(`${base}/api/push/public-key`)).json();
        assert.ok(first.publicKey && first.publicKey.length > 40, '應回傳公鑰');

        const stored = state.tables.app_settings.find((s) => s.key === 'push_vapid_keys');
        assert.ok(stored, '金鑰應存入 app_settings');
        const parsed = JSON.parse(stored.value);
        assert.strictEqual(parsed.publicKey, first.publicKey);
        assert.ok(parsed.privateKey && parsed.privateKey.length > 40, '私鑰應存在資料庫（不出現在程式碼）');

        const second = await (await fetch(`${base}/api/push/public-key`)).json();
        assert.strictEqual(second.publicKey, first.publicKey, '同一組金鑰');
    });

    const subscription = {
        endpoint: 'https://127.0.0.1:9/push/fake-endpoint-1',
        keys: { p256dh: 'BNc' + 'a'.repeat(85), auth: 'b'.repeat(22) }
    };

    await t.test('推播訂閱：驗證必填欄位、寫入資料表、可關閉', async () => {
        assert.strictEqual((await post('/api/push/subscribe', {})).status, 400);
        assert.strictEqual((await post('/api/push/subscribe', { subscription: { endpoint: 'x' } })).status, 400);

        const res = await post('/api/push/subscribe', { subscription }, asPlayer);
        assert.strictEqual(res.status, 200);

        const row = state.tables.push_subscriptions.find((s) => s.endpoint === subscription.endpoint);
        assert.ok(row, '應寫入 push_subscriptions');
        assert.strictEqual(row.is_active, true);
        assert.strictEqual(row.username, 'player1', '已登入者應記錄帳號');
        assert.strictEqual(row.p256dh, subscription.keys.p256dh);

        // 重複訂閱（同一 endpoint）不應產生第二筆
        await post('/api/push/subscribe', { subscription }, asPlayer);
        assert.strictEqual(state.tables.push_subscriptions.length, 1, '同一端點應合併');

        // 測試推播：端點是假網址 → API 成功但顯示送出失敗，且不可誤標為失效
        const testPush = await post('/api/push/test', { endpoint: subscription.endpoint });
        assert.strictEqual(testPush.status, 200);
        const result = await testPush.json();
        assert.strictEqual(result.ok, false, '假端點不可能成功');
        assert.match(result.message, /送出失敗/);
        assert.strictEqual(state.tables.push_subscriptions[0].is_active, true, '連線失敗不代表訂閱失效');

        assert.strictEqual((await post('/api/push/test', { endpoint: 'https://nope.invalid/x' })).status, 404);
    });

    await t.test('定時推播：需 CRON_SECRET、只挑即將開賽者、同一賽事只推一次', async () => {
        assert.strictEqual((await fetch(`${base}/api/cron/reminders`)).status, 401, '未帶正確權杖應 401');
        assert.strictEqual((await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);

        const first = await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: 'Bearer cron-secret-for-tests' } });
        assert.strictEqual(first.status, 200);
        const data = await first.json();
        assert.strictEqual(data.candidates, 1, '只有 12 小時後開賽的那場');
        assert.strictEqual(data.subscriptions, 1);
        assert.strictEqual(data.sent, 0, '假端點送不出去');
        assert.ok(data.failed >= 1, '應記錄失敗次數');
        assert.strictEqual(data.details[0].id, 100);

        const logRow = state.tables.push_log.find((l) => l.competition_id === 100 && l.kind === 'reminder');
        assert.ok(logRow, '應寫入 push_log 去重紀錄');
        assert.ok(state.tables.app_settings.some((s) => s.key === 'push_last_run'), '應記錄最後執行時間');

        // 第二次執行：已推過 → 不再重複
        const second = await (await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: 'Bearer cron-secret-for-tests' } })).json();
        assert.strictEqual(second.candidates, 0, '同一賽事同一類型不得重複推播');
        assert.strictEqual(state.tables.push_log.filter((l) => l.competition_id === 100 && l.kind === 'reminder').length, 1);
    });

    await t.test('定時推播：沒有訂閱時不報錯，明確回報原因', async () => {
        state.tables.push_subscriptions.forEach((s) => { s.is_active = false; });
        const res = await (await fetch(`${base}/api/cron/reminders`, { headers: { Authorization: 'Bearer cron-secret-for-tests' } })).json();
        assert.strictEqual(res.sent, 0);
        assert.strictEqual(res.subscriptions, 0);
        assert.match(res.reason, /沒有任何有效訂閱/);
    });
});
