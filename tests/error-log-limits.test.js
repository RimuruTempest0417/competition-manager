/* v3.6.1：錯誤日誌的截圖上限與列表瘦身（Roadmap 8.6 ④）
 *
 * 修的是什麼：
 *   ① `POST /api/logs/error` 未登入可寫，卻把 `screenshot` **整包**存進資料庫
 *      （搭配全域 10mb body 上限與每分鐘 30 次 → 匿名者可以一次寫進約 10MB）
 *   ② `GET /api/admin/error-logs` 用 `select('*')` 把 base64 拉回來並 render 成 <img>
 *
 * 這裡驗的就是這兩件事，而且**直接看假資料庫裡的實際內容**，不看回應訊息怎麼說：
 *   - 合法的小圖 → 存；不是圖片或超過上限 → 丟掉圖片但**照樣記錄錯誤**（不能因此漏掉錯誤）
 *   - 超大 body → 413（這個端點單獨的 512kb 上限）
 *   - 列表：不含 screenshot 欄位、has_screenshot 正確，且**就算資料庫裡真的有 400KB 截圖，
 *     列表回應也要很小**（這才是「瘦身」的證據）
 *   - 截圖端點：一般使用者 403、連 admin 都 403（只有超級管理員以上）、404／400 的邊界
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v361-error-log-limits-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const SMALL_IMAGE = 'data:image/png;base64,' + 'A'.repeat(2000);
const HUGE_IMAGE = 'data:image/png;base64,' + 'B'.repeat(400001);   // 超過 400000 上限一個字元
const LEGACY_BIG_IMAGE = 'data:image/png;base64,' + 'C'.repeat(400000);   // 舊資料：資料庫裡真有一包大圖

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 2, username: 'helper', password: 'x', role: 'super_admin', is_active: true },
            { id: 3, username: 'staff', password: 'x', role: 'admin', is_active: true },
            { id: 4, username: 'player', password: 'x', role: 'user', is_active: true }
        ],
        error_logs: [
            { id: 1, error_type: 'frontend_error', message: '沒有截圖的錯誤', stack_trace: 'boom', path: '/a', user_agent: 'UA', severity: 'error', resolved: false, created_at: '2026-09-27T01:00:00.000Z' },
            { id: 2, error_type: 'frontend_error', message: '有舊的大截圖', stack_trace: 'boom\n\n[Screenshot Attached (Base64 Truncated)]: data:image/png', path: '/b', user_agent: 'UA', severity: 'error', resolved: true, created_at: '2026-09-27T00:00:00.000Z', screenshot: LEGACY_BIG_IMAGE }
        ],
        push_subscriptions: [],
        audit_logs: []
    },
    nextId: { error_logs: 500, audit_logs: 900 }
};

test('v3.6.1 錯誤日誌：截圖上限、列表瘦身與截圖端點權限', async (t) => {
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

    const token = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET, { expiresIn: '10m' });
    const asOwner = 'Bearer ' + token(1, 'owner', 'web_owner');
    const asHelper = 'Bearer ' + token(2, 'helper', 'super_admin');
    const asStaff = 'Bearer ' + token(3, 'staff', 'admin');
    const asPlayer = 'Bearer ' + token(4, 'player', 'user');
    const post = (body) => fetch(base + '/api/logs/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    const lastRow = () => state.tables.error_logs[state.tables.error_logs.length - 1];

    /* ---------- ① 合法的小截圖：要存下來，並在 stack_trace 留標記 ---------- */
    const ok = await post({ error_type: 'frontend_error', message: '有小截圖', screenshot: SMALL_IMAGE });
    assert.strictEqual(ok.status, 200, '合法的小截圖應該能寫入');
    assert.strictEqual(lastRow().screenshot, SMALL_IMAGE, '合法的小截圖應該被存下來');
    assert.match(lastRow().stack_trace, /\[Screenshot Attached/, '要留下「有截圖」的標記，前端才知道要顯示按鈕');
    // 標記裡只放前 100 字，不要把整包 base64 再塞一次
    assert.ok(lastRow().stack_trace.length < 4200, `stack_trace 不該被圖片撐大（${lastRow().stack_trace.length} 字元）`);

    /* ---------- ② 不是圖片：丟掉圖片，但錯誤本身照樣記下來 ---------- */
    const notImage = await post({ error_type: 'frontend_error', message: '假裝是截圖', screenshot: 'x'.repeat(5000) });
    assert.strictEqual(notImage.status, 200, '截圖不合法不等於錯誤不記——還是要 200');
    assert.strictEqual(lastRow().screenshot, undefined, '不是 data:image 的內容不該被當成截圖存進資料庫');
    assert.match(lastRow().stack_trace, /\[Screenshot Dropped: 不是合法/, '要留下「為什麼丟掉」的原因');

    /* ---------- ③ 超過上限：同樣丟掉圖片、照記錯誤 ---------- */
    const tooBig = await post({ error_type: 'frontend_error', message: '超大截圖', screenshot: HUGE_IMAGE });
    assert.strictEqual(tooBig.status, 200, '截圖過大也不該讓整筆錯誤消失');
    assert.strictEqual(lastRow().screenshot, undefined, '超過上限的截圖不該被存進資料庫');
    assert.match(lastRow().stack_trace, /Screenshot Dropped: 圖片過大/, '要說明是「過大」而不是「格式錯」');

    /* ---------- ④ body 本身就超限：413（這個端點單獨 512kb，不是全域 10mb）---------- */
    const oversized = await post({ error_type: 'frontend_error', message: 'x', screenshot: 'data:image/png;base64,' + 'D'.repeat(700000) });
    assert.strictEqual(oversized.status, 413, `匿名端點的 body 上限要生效（實際 ${oversized.status}）`);
    // 413 會被全域 Error Handler 以「警告級」記一筆 request_body_too_large（v2.14.0 的刻意行為，
    // 讓超量嘗試看得到、不靜默丟掉）——但那一筆不帶任何圖片內容，超大的 base64 不會落地。
    // 這一輪只有「合法的小圖」該被存下來；非圖片、過大、超量都不該有截圖落地
    // （id 2 是刻意預先埋好的舊資料，用來證明列表不會被它撐大）
    const storedShots = state.tables.error_logs.filter((r) => r.id !== 2 && typeof r.screenshot === 'string');
    assert.strictEqual(storedShots.length, 1, `這一輪只該有一筆截圖落地（實際 ${storedShots.length}）`);
    assert.strictEqual(storedShots[0].screenshot, SMALL_IMAGE, '落地的必須是那筆合法的小圖');
    assert.strictEqual(
        state.tables.error_logs.filter((r) => r.error_type === 'request_body_too_large').length, 1,
        '超量嘗試要留一筆警告級紀錄（可觀測），而不是靜默丟掉');

    /* ---------- ⑤ 列表瘦身：不回截圖本體，回應要很小 ---------- */
    const listRes = await fetch(base + '/api/admin/error-logs', { headers: { Authorization: asHelper } });
    const listBody = await listRes.text();
    assert.strictEqual(listRes.status, 200, '超級管理員要能讀列表');
    const list = JSON.parse(listBody);
    assert.strictEqual(list.logs.length, state.tables.error_logs.length, '列表筆數要和資料庫一致');
    assert.ok(list.logs.every((l) => !('screenshot' in l)),
        '列表不可回傳 screenshot 欄位（資料庫裡那筆 400KB 的舊截圖不該出現在列表）');
    // 關鍵證據：資料庫裡真的有 400KB 的截圖，列表回應卻必須很小
    assert.ok(listBody.length < 20000, `列表回應要小（實際 ${listBody.length} 位元組，資料庫裡有一筆 400KB 截圖）`);
    const withShot = list.logs.find((l) => l.id === 2);
    const withoutShot = list.logs.find((l) => l.id === 1);
    assert.strictEqual(withShot.has_screenshot, true, '有截圖的那筆要標示 has_screenshot=true');
    assert.strictEqual(withoutShot.has_screenshot, false, '沒截圖的那筆要是 false');
    assert.strictEqual(list.logs.find((l) => l.message === '假裝是截圖').has_screenshot, false,
        '被丟棄的截圖不該讓前端顯示「檢視截圖」按鈕');

    /* ---------- ⑥ 截圖端點：權限與邊界 ---------- */
    const shot = (id, auth) => fetch(`${base}/api/admin/error-logs/${id}/screenshot`, { headers: auth ? { Authorization: auth } : {} });
    assert.strictEqual((await shot(2)).status, 401, '未登入不可讀截圖');
    assert.strictEqual((await shot(2, asPlayer)).status, 403, '一般使用者不可讀截圖');
    assert.strictEqual((await shot(2, asStaff)).status, 403, '連 admin 也不行——截圖只有超級管理員以上能看');

    const asHelperShot = await shot(2, asHelper);
    assert.strictEqual(asHelperShot.status, 200, '超級管理員要能讀截圖');
    const shotBody = await asHelperShot.json();
    assert.strictEqual(shotBody.screenshot, LEGACY_BIG_IMAGE, '要回傳那一筆真正的截圖內容');

    const ownerShot = await shot(2, asOwner);
    assert.strictEqual(ownerShot.status, 200, '最高權限帳號也要能讀截圖');

    const noShot = await (await shot(1, asHelper)).json();
    assert.strictEqual(noShot.screenshot, null, '沒有截圖的日誌要回 null（不是 undefined／錯誤）');

    assert.strictEqual((await shot(9999, asHelper)).status, 404, '不存在的日誌編號要 404');
    assert.strictEqual((await shot('abc', asHelper)).status, 400, '非數字編號要 400');
});
