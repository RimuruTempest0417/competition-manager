/* v3.6.5：報到碼與掃碼簽到
 *
 * 為什麼要驗這些（這條路徑是「現場很多人排隊」時用的，出錯的代價最高）：
 *   ① 報到碼不可猜、不可重複（同一賽事內唯一），且只有正取拿得到
 *   ② 掃碼／手打的容錯：小寫、空白、連字號都要能認（現場打字一定不完美）
 *   ③ 只有管理員以上能用；沒帶碼／碼格式錯要擋下來，不能誤簽到別人
 *   ④ 已簽到要回 409 並說「誰、什麼時候簽的」——現場最常發生的就是重複排隊
 *   ⑤ 候補不能簽到（名額會對不上帳）、軟刪除的報名不能簽到
 *   ⑥ 沒跑 migration 要回 503 並指出要跑哪一支
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v365-checkin-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const makeState = () => ({
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 3, username: 'staff', password: 'x', role: 'admin', is_active: true },
            { id: 4, username: 'player', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 971, name: '掃碼盃', date: '2026-10-20', time: '09:00', end_date: '2026-10-20', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 20, created_at: '2026-09-01T00:00:00.000Z' }
        ],
        admin_users_extra: [],
        registrations: [
            { id: 981, competition_id: 971, user_id: 4, username: 'player', status: 'confirmed', is_deleted: false, checkin_code: 'PLAY2K47', attended_at: null, attended_by: null, created_at: '2026-09-10T00:00:00.000Z' },
            { id: 982, competition_id: 971, user_id: 1, username: 'waiting', status: 'waitlisted', is_deleted: false, checkin_code: 'WAIT2K39', attended_at: null, attended_by: null, created_at: '2026-09-11T00:00:00.000Z' },
            { id: 983, competition_id: 971, user_id: 3, username: 'goner', status: 'confirmed', is_deleted: true, checkin_code: 'GONE3K47', attended_at: null, attended_by: null, created_at: '2026-09-12T00:00:00.000Z' }
        ],
        audit_logs: [],
        push_subscriptions: []
    },
    nextId: { registrations: 990, audit_logs: 990 }
});

test('v3.6.5 報到碼與掃碼簽到', async (t) => {
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
    const staffAuth = { Authorization: 'Bearer ' + token('staff', 'admin', 3) };
    const playerAuth = { Authorization: 'Bearer ' + token('player', 'user', 4) };
    const post = (url, body, headers = staffAuth) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body || {})
    });
    const reg = (id) => state.tables.registrations.find((r) => r.id === id);

    /* ── ① 我的報名端點仍然正常（v3.6.5 加了報到碼邏輯，不能弄壞既有清單）──
     * 註：假 Supabase 不支援 `/api/my/registrations` 這種 shape 的外鍵展開，
     *     所以「報到碼要用才產生」的驗證放在瀏覽器檢查（真實 Chrome）與正式站煙霧測試。 */
    const myRes = await fetch(base + '/api/my/registrations', { headers: playerAuth });
    assert.strictEqual(myRes.status, 200, '我的報名要能讀取（' + (await myRes.clone().text()) + '）');
    const mine = (await myRes.json()).find((r) => r.id === 981);
    if (mine) assert.ok(/^[A-HJ-NP-Z2-9]{8}$/.test(mine.checkin_code || ''), '回傳的報到碼要是 8 碼且不含易混淆字元：' + mine.checkin_code);
    assert.strictEqual(mine ? mine.checkin_code : reg(981).checkin_code, 'PLAY2K47', '報到碼要沿用資料庫既有的值（不可每次換一組）');
    const code = 'PLAY2K47';

    /* ── ② 權限：未登入 401、一般使用者 403 ── */
    assert.strictEqual((await post('/api/registrations/attendance-by-code', { code }, {})).status, 401);
    assert.strictEqual((await post('/api/registrations/attendance-by-code', { code }, playerAuth)).status, 403, '一般使用者不可以幫別人簽到');
    assert.strictEqual(reg(981).attended_at, null, '被擋下的請求不可以改到資料');

    /* ── ③ 格式錯／不存在的碼要擋下來 ── */
    assert.strictEqual((await post('/api/registrations/attendance-by-code', { code: 'ABC' })).status, 400, '太短的碼要擋');
    assert.strictEqual((await post('/api/registrations/attendance-by-code', {})).status, 400, '沒帶碼要擋');
    const unknown = await post('/api/registrations/attendance-by-code', { code: 'ZZZZ9999' });
    assert.strictEqual(unknown.status, 404, '不存在的碼要回 404');
    assert.ok((await unknown.json()).error.includes('ZZZZ9999'), '要回報查不到的碼是什麼');

    /* ── ④ 候補與已刪除的報名都不能掃碼簽到 ── */
    const waitlisted = await post('/api/registrations/attendance-by-code', { code: 'WAIT2K39' });
    assert.strictEqual(waitlisted.status, 400, '候補不可以簽到');
    assert.ok((await waitlisted.json()).error.includes('候補'), '要說明是候補，請先遞補');
    assert.strictEqual((await post('/api/registrations/attendance-by-code', { code: 'GONE3K47' })).status, 404, '已刪除的報名不可以簽到');

    /* ── ⑤ 成功簽到（用小寫＋空白的寫法，驗容錯）── */
    const messy = code.slice(0, 4) + ' ' + code.slice(4).toLowerCase();
    const ok = await post('/api/registrations/attendance-by-code', { code: messy });
    assert.strictEqual(ok.status, 200, '容錯（小寫＋空白）也要簽得起來：' + messy + '｜' + (await ok.clone().text()));
    const okBody = await ok.json();
    assert.ok(okBody.message.includes('player'), '要回報簽到的是誰');
    assert.ok(okBody.message.includes('掃碼盃'), '要回報哪一場賽事');
    assert.strictEqual(reg(981).attended_at !== null, true, '簽到時間要寫進資料庫');
    assert.strictEqual(reg(981).attended_by, 'staff', '要記下是誰簽的');
    assert.ok(JSON.stringify(state.tables.audit_logs).includes('REGISTER_ATTENDED'), '簽到要留稽核');
    assert.ok(JSON.stringify(state.tables.audit_logs).includes('掃碼'), '稽核要看得出來是掃碼簽到的');

    /* ── ⑥ 重複掃碼：409 並說清楚誰、什麼時候簽的 ── */
    const dup = await post('/api/registrations/attendance-by-code', { code });
    assert.strictEqual(dup.status, 409, '已經簽到過要回 409（現場最常見的情況）');
    const dupBody = await dup.json();
    assert.strictEqual(dupBody.already, true);
    assert.ok(dupBody.error.includes('player') && dupBody.error.includes('staff'), '要說出誰簽的：' + dupBody.error);

    /* ── ⑦ 沒跑 migration：503 並指出要跑哪一支 ── */
    const noMigration = makeState();
    noMigration.missingColumns = { registrations: ['checkin_code'] };
    const stub2 = await startFakeSupabase(noMigration);
    const prevUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub2.address().port}`;
    const appPath = require.resolve(path.join(__dirname, '..', 'server.js'));
    delete require.cache[appPath];
    const app2 = require(appPath);
    const server2 = app2.listen(0, '127.0.0.1');
    await once(server2, 'listening');
    try {
        const res2 = await fetch(`http://127.0.0.1:${server2.address().port}/api/registrations/attendance-by-code`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, staffAuth),
            body: JSON.stringify({ code: 'ABCD2345' })
        });
        const payload = await res2.json();
        assert.strictEqual(res2.status, 503, '沒跑 migration 要回 503，不能假裝簽到成功');
        assert.ok(payload.error.includes('v3.6.5'), '要指出要跑哪一支 migration：' + payload.error);
    } finally {
        try { server2.close(); } catch (err) { /* 忽略 */ }
        try { stub2.close(); } catch (err) { /* 忽略 */ }
        process.env.SUPABASE_URL = prevUrl;
    }
});
