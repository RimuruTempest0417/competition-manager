/* v3.5.4：補齊「8 條沒有測試的端點」之二 —— 未登入可寫的兩個公開端點
 *
 *   POST /api/logs/error        前端錯誤回報（未登入可寫 → 必須節流與截斷欄位）
 *   POST /api/push/unsubscribe  關閉瀏覽器推播（未登入可寫 → 必須節流、缺參數要 400）
 *
 * 為什麼要補：這兩條是「任何人都能寫」的端點，風險最高卻完全沒被測過。
 * 節流（allowPublicWrite）與欄位長度上限是防止被灌爆的唯二防線——
 * 改壞了不會有任何錯誤訊息，只有真的打 31 次才看得出來。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v354-public-write-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        error_logs: [],
        push_subscriptions: [
            { id: 1, endpoint: 'https://push.example/device-a', is_active: true },
            { id: 2, endpoint: 'https://push.example/device-b', is_active: true }
        ],
        audit_logs: []
    },
    nextId: { error_logs: 500, audit_logs: 900 }
};

test('v3.5.4 公開寫入端點：錯誤回報與推播退訂', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    });

    /* ---------- ① POST /api/logs/error：訪客可寫，但要被截斷 ---------- */
    const longUa = 'UA'.repeat(300);            // 600 字元 → 應被截成 400
    const first = await fetch(base + '/api/logs/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': longUa },
        body: JSON.stringify({
            error_type: 'X'.repeat(90),          // 應被截成 60
            message: 'M'.repeat(1200),           // 應被截成 1000
            stack_trace: 'S'.repeat(5000),       // 應被截成 4000
            path: '/page/' + 'p'.repeat(400)     // 應被截成 300
        })
    });
    assert.strictEqual(first.status, 200, '前端錯誤回報未登入也要能寫入');
    assert.strictEqual((await first.json()).success, true);

    const rows = state.tables.error_logs;
    assert.strictEqual(rows.length, 1, '要真的寫進 error_logs');
    const log = rows[0];
    assert.strictEqual(log.error_type.length, 60, `error_type 上限 60（實際 ${log.error_type.length}）`);
    assert.strictEqual(log.message.length, 1000, `message 上限 1000（實際 ${log.message.length}）`);
    assert.strictEqual(log.stack_trace.length, 4000, `stack_trace 上限 4000（實際 ${log.stack_trace.length}）`);
    assert.strictEqual(log.path.length, 300, `path 上限 300（實際 ${log.path.length}）`);
    assert.strictEqual(log.user_agent.length, 400, `user_agent 上限 400（實際 ${log.user_agent.length}）`);
    assert.strictEqual(log.user_id, null, '未登入的錯誤回報不帶使用者');
    assert.strictEqual(log.error_type, 'X'.repeat(60), '截斷要是「保留前段」而不是亂切');

    /* ---------- ② 沒帶欄位時要有安全預設值 ---------- */
    await fetch(base + '/api/logs/error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const fallback = rows[rows.length - 1];
    assert.strictEqual(fallback.error_type, 'frontend_error', '缺 error_type 時的預設分類');
    assert.strictEqual(fallback.message, 'Unknown client error', '缺 message 時的預設訊息');

    /* ---------- ③ screenshot 不留整份 base64，只留前 100 字與標記 ---------- */
    await fetch(base + '/api/logs/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error_type: 'shot', screenshot: 'data:image/png;base64,' + 'A'.repeat(3000) })
    });
    const shot = rows[rows.length - 1];
    assert.match(shot.stack_trace, /Screenshot Attached \(Base64 Truncated\)/,
        '截圖要在 stack_trace 留下「已截斷」的標記');
    assert.ok(!shot.stack_trace.includes('A'.repeat(200)),
        'stack_trace 不得塞進整份 base64（否則日誌表會被灌爆）');

    /* ---------- ④ 節流：同一個 IP 30 次／分鐘，第 31 次起 429 ---------- */
    let throttled = 0;
    for (let i = 0; i < 32; i++) {
        const res = await fetch(base + '/api/logs/error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error_type: 'flood', message: `第 ${i} 次` })
        });
        if (res.status === 429) throttled++;
    }
    assert.ok(throttled > 0, '連續灌 32 次要出現 429（節流失效＝任何人都能灌爆資料庫）');

    /* ---------- ⑤ POST /api/push/unsubscribe：缺 endpoint → 400 ---------- */
    const noEndpoint = await fetch(base + '/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    assert.strictEqual(noEndpoint.status, 400, '沒帶 endpoint 要回 400');

    /* ---------- ⑥ 成功退訂：只把該裝置設為 is_active=false ---------- */
    const okUnsub = await fetch(base + '/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/device-a' })
    });
    assert.strictEqual(okUnsub.status, 200, '正常的退訂要成功');
    const subs = state.tables.push_subscriptions;
    assert.strictEqual(subs.find((s) => s.endpoint === 'https://push.example/device-a').is_active, false,
        '被退訂的裝置要變成 is_active=false（不是刪除，之後可以再訂閱）');
    assert.strictEqual(subs.find((s) => s.endpoint === 'https://push.example/device-b').is_active, true,
        '退訂不能連帶影響其他裝置');

    /* ---------- ⑦ 不存在的 endpoint 也要回 200（不洩漏有沒有訂閱過）---------- */
    const unknown = await fetch(base + '/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/never-seen' })
    });
    assert.strictEqual(unknown.status, 200, '未知的 endpoint 不應報錯（避免被用來探測訂閱是否存在）');
});
