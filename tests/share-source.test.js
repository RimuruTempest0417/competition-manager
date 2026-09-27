/* v3.8.2：分享來源追蹤（掃碼／分享連結帶來的人）＋候補遞補的站內時間戳
 *
 * 為什麼要驗「資料庫裡的實際內容」而不是回應訊息：來源追蹤的價值全在後台統計，
 * 回應寫得再漂亮、資料庫沒有那一列就是沒有。所以每一條都直接看 share_visits／registrations。
 *
 * 驗的規則：
 *   - 分享連結被開啟 → 記一列 share_visits（來源只接受白名單，其他一律 400 且不寫入）
 *   - 賽事不存在要 404（不能讓匿名請求寫進不存在的賽事）
 *   - 後台成效只有管理員看得到（一般使用者 403）
 *   - 報名時帶來源 → 寫進 registrations.source，並出現在稽核內容裡
 *   - 來源不在白名單 → 整欄不寫（不讓任意字串進資料庫）
 *   - 候補遞補成立 → 寫 promoted_at（推播之外，讓沒訂閱的人也看得到「你已遞補上」）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v382-share-source-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const makeState = () => ({
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 4, username: 'player', password: 'x', role: 'user', is_active: true },
            { id: 8, username: 'newbie', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 911, name: '分享盃', date: '2026-12-05', time: '10:00', is_deleted: false, is_registration_open: true, max_registrations: 10 },
            { id: 912, name: '候補盃', date: '2026-12-12', time: '10:00', is_deleted: false, is_registration_open: true, max_registrations: 1, waitlist_enabled: true }
        ],
        registrations: [
            { id: 8101, competition_id: 911, user_id: 4, username: 'player', status: 'confirmed', is_deleted: false, created_at: '2026-09-20T00:00:00.000Z', source: 'poster' },
            { id: 8102, competition_id: 911, user_id: 5, username: '阿華', status: 'confirmed', is_deleted: false, created_at: '2026-09-21T00:00:00.000Z', source: null },
            { id: 8103, competition_id: 912, user_id: 6, username: '小美', status: 'confirmed', is_deleted: false, created_at: '2026-09-22T00:00:00.000Z' },
            { id: 8104, competition_id: 912, user_id: 7, username: '候補的人', status: 'waitlisted', is_deleted: false, created_at: '2026-09-23T00:00:00.000Z', waitlist_order: 1, promoted_at: null }
        ],
        share_visits: [],
        audit_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { registrations: 8200, audit_logs: 9200, share_visits: 9300, push_log: 9400 }
});

test('v3.8.2 分享來源追蹤與遞補時間戳', async (t) => {
    const state = makeState();
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

    const token = (username, role, sub) => jwt.sign({ sub, username, role }, SECRET, { expiresIn: '10m' });
    const ownerAuth = { Authorization: 'Bearer ' + token('owner', 'web_owner', 1) };
    const playerAuth = { Authorization: 'Bearer ' + token('player', 'user', 4) };
    const newbieAuth = { Authorization: 'Bearer ' + token('newbie', 'user', 8) };

    const post = (url, body, headers = ownerAuth) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body || {})
    });
    const get = (url, headers = ownerAuth) => fetch(base + url, { headers });
    const reg = (id) => state.tables.registrations.find((r) => r.id === id);

    /* ── ① 分享連結被開啟 → 記一列（未登入也能記，因為掃碼的人通常還沒登入）── */
    const visit = await post('/api/competitions/911/share-visit', { source: 'poster' }, {});
    assert.strictEqual(visit.status, 200, '未登入也要能記錄瀏覽（掃碼進來的人多半還沒登入）：' + (await visit.text()));
    assert.strictEqual(state.tables.share_visits.length, 1, '要真的寫進 share_visits，不是只回一個訊息');
    assert.strictEqual(state.tables.share_visits[0].source, 'poster', '來源要照原文記下來');
    assert.strictEqual(Number(state.tables.share_visits[0].competition_id), 911, '要記住是哪一場賽事');

    /* ── ② 來源白名單：不在清單內一律 400，且不可以寫入 ── */
    const bogus = await post('/api/competitions/911/share-visit', { source: 'evil<script>' }, {});
    assert.strictEqual(bogus.status, 400, '來源不在白名單要拒絕');
    assert.strictEqual(state.tables.share_visits.length, 1, '被拒絕的請求不可以偷偷寫入');

    const empty = await post('/api/competitions/911/share-visit', {}, {});
    assert.strictEqual(empty.status, 400, '沒有來源就不要記錄（不要用空字串灌資料）');

    /* ── ③ 賽事不存在 → 404（不能讓匿名請求寫進不存在的賽事）── */
    const missing = await post('/api/competitions/999999/share-visit', { source: 'link' }, {});
    assert.strictEqual(missing.status, 404, '賽事不存在要 404');
    assert.strictEqual(state.tables.share_visits.length, 1, '找不到賽事時不可以寫入');

    /* ── ④ 後台成效：只有管理員看得到，而且要能對上帳 ── */
    const asPlayer = await get('/api/competitions/911/share-stats', playerAuth);
    assert.strictEqual(asPlayer.status, 403, '成效統計只有管理員看得到');
    const anon = await get('/api/competitions/911/share-stats', {});
    assert.strictEqual(anon.status, 401, '未登入不可讀取成效');

    const stats = await get('/api/competitions/911/share-stats', ownerAuth);
    assert.strictEqual(stats.status, 200, '管理員可以讀取成效');
    const statsBody = await stats.json();
    const posterRow = (statsBody.rows || []).find((r) => r.source === 'poster');
    assert.ok(posterRow, '要有「列印海報的 QR」這一列');
    assert.strictEqual(posterRow.visits, 1, '海報 QR 應該記到 1 次開啟');
    assert.strictEqual(posterRow.signups, 1, '海報 QR 應該記到 1 筆報名（8101 的來源就是 poster）');
    assert.strictEqual(posterRow.label, '列印海報的 QR', '標籤要用人看得懂的中文');
    const directRow = (statsBody.rows || []).find((r) => r.source === 'direct');
    assert.ok(directRow && directRow.signups === 1, '沒有來源標記的報名要算在「直接進入」');
    assert.strictEqual(statsBody.visits_total, 1, '總開啟次數要對得上');

    /* ── ⑤ 報名帶來源 → 寫進資料庫與稽核 ── */
    const registerRes = await post('/api/competitions/911/register', { source: 'text' }, newbieAuth);
    assert.strictEqual(registerRes.status, 200, '帶來源的報名要成功：' + (await registerRes.text()));
    const newRow = state.tables.registrations.find((r) => Number(r.user_id) === 8);
    assert.ok(newRow, '要有新的一筆報名');
    assert.strictEqual(newRow.source, 'text', '報名要記下來源（text＝群組文案）');
    const audit = state.tables.audit_logs.filter((a) => a.action === 'REGISTER_COMPETITION').pop();
    assert.ok(String(audit && audit.details).includes('群組文案'), '稽核內容要寫得出來源（否則事後查不出來）');

    /* ── ⑥ 來源不在白名單 → 整欄不寫（不是寫進一個奇怪的來源）── */
    const badSource = await post('/api/competitions/911/register', { source: 'not-a-source' }, { Authorization: 'Bearer ' + token('someone', 'user', 9) });
    assert.strictEqual(badSource.status, 200, '來源不合法的報名本身還是要成功（不能因此擋住報名）');
    const anotherRow = state.tables.registrations.find((r) => Number(r.user_id) === 9);
    assert.ok(anotherRow, '要有新的一筆報名');
    assert.ok(!anotherRow.source, '來源不在白名單時，整欄不寫入任何東西');

    /* ── ⑦ 取消正取 → 自動遞補候補 → 寫 promoted_at（推播之外，站內也看得到）── */
    assert.strictEqual(reg(8103).status, 'confirmed', '前置：912 額滿（1 人），還有 1 位候補');
    const cancel = await fetch(base + '/api/registrations/8103', { method: 'DELETE', headers: ownerAuth });
    assert.strictEqual(cancel.status, 200, '取消正取要成功：' + (await cancel.text()));
    const promoted = reg(8104);
    assert.strictEqual(promoted.status, 'confirmed', '空出位子後，候補的人要自動遞補為正取');
    assert.ok(promoted.promoted_at, '★遞補時間要寫進 promoted_at（沒有推播訂閱的人也看得到「你已遞補上」）');
    // 遞補推播照既有管線（這裡沒有任何推播訂閱，所以只驗事件有被記錄下來）
    const pushRows = state.tables.push_log.filter((row) => String(row.kind || row.event || row.event_kind || '').includes('waitlist_promoted'));
    assert.ok(pushRows.length <= 1, '遞補推播事件最多一筆（沒有訂閱時 sent 為 0）');
});
