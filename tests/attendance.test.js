/* v3.6.2：現場報到（簽到）與現場代報名（Roadmap 8.7 ⑤）
 *
 * 使用者在 2026-09-26 定的方式：現場報到採「先由管理員勾選簽到」（方案 C），
 * 所以這裡驗的是「勾選」這件事在系統裡真的是可追溯、可取消、且名額對得上帳：
 *   - 只有管理員以上能簽到；一般使用者 403、未登入 401
 *   - **只有「正取」可以簽到**（候補與待審核要先核准／遞補）——這是規則的核心
 *   - 簽到會寫下 attended_at 與 attended_by（誰在什麼時候勾的），取消簽到也要留稽核
 *   - 現場代報名：可以臨時建名額（即使報名已截止），但仍然守名額上限、不重複報名
 *   - 名單回應帶「應到／已簽到／現場代報名」統計，且只有管理員看得到
 *
 * 驗證方式同 v3.6.1：**直接看假資料庫裡的實際內容**，不看回應訊息怎麼說。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v362-attendance-secret';
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
            { id: 901, name: '秋季盃', date: '2026-12-01', time: '09:00', is_deleted: false, is_registration_open: true, max_registrations: 2 },
            { id: 902, name: '已額滿盃', date: '2026-12-08', time: '09:00', is_deleted: false, is_registration_open: true, max_registrations: 1 }
        ],
        registrations: [
            { id: 7001, competition_id: 901, user_id: 4, username: '阿明', team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-20T00:00:00.000Z', attended_at: null, attended_by: null, onsite: false },
            { id: 7002, competition_id: 901, user_id: 5, username: '阿華', team_name: null, note: null, status: 'waitlisted', is_deleted: false, created_at: '2026-09-21T00:00:00.000Z', attended_at: null, attended_by: null, onsite: false },
            { id: 7003, competition_id: 902, user_id: 6, username: '小美', team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-22T00:00:00.000Z', attended_at: null, attended_by: null, onsite: false },
            { id: 7004, competition_id: 901, user_id: 7, username: '已刪除的人', team_name: null, note: null, status: 'confirmed', is_deleted: true, created_at: '2026-09-19T00:00:00.000Z', attended_at: null, attended_by: null, onsite: false }
        ],
        audit_logs: [],
        push_subscriptions: []
    },
    nextId: { registrations: 8000, audit_logs: 9000 }
});

function startServer(state) {
    const stub = startFakeSupabase(state);
    return stub;
}

test('v3.6.2 現場報到與代報名', async (t) => {
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
    const staffAuth = { Authorization: 'Bearer ' + token('staff', 'admin', 3) };
    const playerAuth = { Authorization: 'Bearer ' + token('player', 'user', 4) };

    const post = (url, body, headers = ownerAuth) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body || {})
    });
    const get = (url, headers = ownerAuth) => fetch(base + url, { headers });
    const reg = (id) => state.tables.registrations.find((r) => r.id === id);
    const audits = (action) => state.tables.audit_logs.filter((a) => a.action === action);

    /* ── ① 簽到：權限 ── */
    const anon = await post('/api/registrations/7001/attendance', { attended: true }, {});
    assert.strictEqual(anon.status, 401, '未登入不可簽到');
    const asPlayer = await post('/api/registrations/7001/attendance', { attended: true }, playerAuth);
    assert.strictEqual(asPlayer.status, 403, '一般使用者不可簽到');
    assert.strictEqual(reg(7001).attended_at, null, '被擋下的請求不可以偷偷改到資料');

    /* ── ② 正取可以簽到，且留下「誰、什麼時候」── */
    const ok = await post('/api/registrations/7001/attendance', { attended: true }, staffAuth);
    assert.strictEqual(ok.status, 200, '管理員可以勾選簽到（' + (await ok.text()) + '）');
    assert.ok(reg(7001).attended_at, '簽到時間要寫進資料庫（不是只回一個訊息）');
    assert.strictEqual(reg(7001).attended_by, 'staff', '要記下是誰勾的');
    assert.strictEqual(audits('REGISTER_ATTENDED').length, 1, '簽到要有稽核紀錄');
    assert.ok(String(audits('REGISTER_ATTENDED')[0].details || '').includes('阿明'), '稽核要寫得出是誰簽到');

    /* ── ③ 候補不能簽到（規則核心：先核准／遞補）── */
    const waitlisted = await post('/api/registrations/7002/attendance', { attended: true });
    assert.strictEqual(waitlisted.status, 400, '候補者不可簽到');
    assert.ok((await waitlisted.json()).error.includes('正取'), '錯誤訊息要說清楚為什麼不能簽');
    assert.strictEqual(reg(7002).attended_at, null, '候補者不會被寫入簽到時間');

    /* ── ④ 取消簽到（勾錯是常態，要能取消且留下紀錄）── */
    const undo = await post('/api/registrations/7001/attendance', { attended: false });
    assert.strictEqual(undo.status, 200);
    assert.strictEqual(reg(7001).attended_at, null, '取消簽到要把時間清掉');
    assert.strictEqual(reg(7001).attended_by, null);
    assert.strictEqual(audits('REGISTER_ATTENDANCE_UNDONE').length, 1, '取消簽到也要有稽核紀錄');

    /* ── ⑤ 邊界：不存在／已刪除 ── */
    assert.strictEqual((await post('/api/registrations/99999/attendance', { attended: true })).status, 404);
    assert.strictEqual((await post('/api/registrations/7004/attendance', { attended: true })).status, 404, '已刪除的報名不可簽到');
    assert.strictEqual(reg(7004).attended_at, null);

    /* ── ⑥ 現場代報名：可以臨時加人（即使報名已截止），但守名額上限 ── */
    const anonOnsite = await post('/api/competitions/901/onsite-registration', { username: '路人甲' }, {});
    assert.strictEqual(anonOnsite.status, 401, '未登入不可代報名');
    const playerOnsite = await post('/api/competitions/901/onsite-registration', { username: '路人甲' }, playerAuth);
    assert.strictEqual(playerOnsite.status, 403, '一般使用者不可代報名');
    assert.strictEqual((await post('/api/competitions/901/onsite-registration', { username: '   ' })).status, 400, '沒姓名要擋下來');
    assert.strictEqual(state.tables.registrations.filter((r) => r.username === '路人甲').length, 0, '被擋下的代報名不可以建檔');

    const created = await post('/api/competitions/901/onsite-registration', { username: '路人甲', note: '現場臨時參加' }, staffAuth);
    assert.strictEqual(created.status, 200, '管理員可以現場代報名（' + (await created.text()) + '）');
    const onsiteRow = state.tables.registrations.find((r) => r.username === '路人甲');
    assert.ok(onsiteRow, '代報名要真的建立一筆紀錄');
    assert.strictEqual(onsiteRow.status, 'confirmed', '現場代報名當場就算正取（管理員在場）');
    assert.strictEqual(onsiteRow.onsite, true, '要標記是現場代報名，才能和線上報名區分');
    assert.strictEqual(onsiteRow.note, '現場臨時參加', '備註要保留管理員填的內容');
    assert.strictEqual(onsiteRow.user_id, null, '沒有對應帳號的人 user_id 留 null（現場臨時參加）');
    assert.strictEqual(audits('REGISTER_ONSITE').length, 1, '代報名要有稽核紀錄');

    /* ── ⑦ 代報名：同名不重複（大小寫不同也算同名）＋額滿要擋 ── */
    const dup = await post('/api/competitions/901/onsite-registration', { username: '路人甲' });
    assert.strictEqual(dup.status, 409, '同名不可重複代報名');
    const dupPayload = await dup.json();
    assert.strictEqual(dupPayload.existing_id, onsiteRow.id, '要告訴管理員既有紀錄是哪一筆（去簽到就好）');
    assert.strictEqual(dupPayload.error.includes('簽到'), true, '要指引管理員去名單上簽到');

    // 901 名額 2：已核准的有 7001（阿明）＋路人甲 → 額滿
    const full = await post('/api/competitions/901/onsite-registration', { username: '路人乙' });
    assert.strictEqual(full.status, 409, '額滿時不可再代報名');
    assert.strictEqual((await full.json()).full, true, '要回報是「額滿」而不是其他錯誤');
    assert.strictEqual(state.tables.registrations.filter((r) => r.username === '路人乙').length, 0, '額滿時不可以偷偷建檔');

    /* ── ⑧ 姓名剛好是既有帳號 → 連結帳號（這樣那位選手在自己的「我的報名」就看得到）── */
    const linked = await post('/api/competitions/902/onsite-registration', { username: 'player' });
    // 902 名額 1 且已有小美（正取）→ 額滿；先提高名額再試，模擬現場「主辦臨時加開名額」
    assert.strictEqual(linked.status, 409, '902 已額滿');
    state.tables.competitions.find((c) => c.id === 902).max_registrations = 3;
    const linked2 = await post('/api/competitions/902/onsite-registration', { username: 'PLAYER' });
    assert.strictEqual(linked2.status, 200, '提高名額後可以代報名');
    assert.strictEqual((await linked2.json()).linked_account, true, '姓名等於既有帳號時要連結帳號');
    const linkedRow = state.tables.registrations.find((r) => r.username === 'PLAYER');
    assert.strictEqual(linkedRow.user_id, 4, '連結帳號要把 user_id 接上');

    // 大小寫不同視為同一人（902 名額已調到 3，不會被名額檢查先擋掉）
    const dupCase = await post('/api/competitions/902/onsite-registration', { username: 'Player' });
    assert.strictEqual(dupCase.status, 409, '大小寫不同視為同一人，避免重複');
    assert.strictEqual((await dupCase.json()).existing_id, linkedRow.id, '要指出既有的是哪一筆');

    /* ── ⑨ 名單帶「應到／已簽到／現場代報名」統計，且只有管理員看得到 ── */
    await post('/api/registrations/7001/attendance', { attended: true });
    const listRes = await get('/api/competitions/901/registrations');
    const list = await listRes.json();
    assert.ok(list.attendance, '管理員看得到現場報到統計');
    assert.strictEqual(list.attendance.expected, 2, '應到＝正取人數（阿明＋路人甲）');
    assert.strictEqual(list.attendance.attended, 1, '已簽到 1 人');
    assert.strictEqual(list.attendance.onsite, 1, '現場代報名 1 人');
    assert.strictEqual(list.attendance_schema_ready, true);
    const mine = list.registrations.find((r) => r.id === 7001);
    assert.ok(mine.attended_at, '名單要帶每一筆的簽到時間（前端才畫得出勾選狀態）');
    assert.strictEqual(mine.attended_by, 'owner');

    const playerList = await (await get('/api/competitions/901/registrations', playerAuth)).json();
    assert.strictEqual(playerList.attendance, undefined, '一般使用者不該看到整場的簽到統計');

    /* ── ⑩ 資料庫還沒跑 migration → 503 並說清楚要跑哪一支（不可以假裝成功）── */
    const noMigration = makeState();
    noMigration.missingColumns = { registrations: ['attended_at'] };
    const stub2 = await startFakeSupabase(noMigration);
    const prevUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub2.address().port}`;
    const app2Path = require.resolve(path.join(__dirname, '..', 'server.js'));
    delete require.cache[app2Path];
    const app2 = require(app2Path);
    const server2 = app2.listen(0, '127.0.0.1');
    await once(server2, 'listening');
    try {
        const res2 = await fetch(`http://127.0.0.1:${server2.address().port}/api/registrations/1/attendance`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, ownerAuth),
            body: JSON.stringify({ attended: true })
        });
        const payload = await res2.json();
        assert.strictEqual(res2.status, 503, '沒跑 migration 時要明確回 503，不能假裝簽到成功');
        assert.ok(payload.error.includes('v3.6.2'), '要告訴管理員要跑哪一支 migration');
    } finally {
        try { server2.close(); } catch (err) { /* 忽略 */ }
        try { stub2.close(); } catch (err) { /* 忽略 */ }
        process.env.SUPABASE_URL = prevUrl;
    }
});
