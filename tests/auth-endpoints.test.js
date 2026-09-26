/* v3.5.4：補齊「8 條沒有測試的端點」之一 —— 登入別名與修改密碼
 *
 * 這兩條端點在路由快照裡存在很久卻沒有測試：
 *   POST /api/admin/login           （登入的別名，早期文件寫過，寫錯路徑會 404）
 *   PUT  /api/auth/change-password  （舊密碼驗證、新密碼格式、稽核、雜湊儲存）
 *
 * 為什麼要補：它們是「密碼」相關的路徑，出錯時使用者直接進不來，
 * 而且 change-password 會改動 admin_users.password——這條路徑一旦寫壞，
 * 只有真的打過它的測試才會發現（不會有任何例外訊息）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');
const { authCookieLine } = require('./support/auth-cookie');
const { hashPassword, verifyPassword } = require('../lib/passwords');

const SECRET = 'v354-auth-endpoints-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const OLD_PASSWORD = 'oldpass123';
const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: hashPassword(OLD_PASSWORD), role: 'web_owner', is_active: true },
            { id: 2, username: 'staff', password: hashPassword(OLD_PASSWORD), role: 'admin', is_active: true }
        ],
        audit_logs: [],
        error_logs: []
    },
    nextId: { admin_users: 50, audit_logs: 900 }
};

test('v3.5.4 登入別名與修改密碼端點', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    // 收尾一定要兩者都關：只關 http server、假 Supabase 的 socket 還在，process 不會結束（250s 卡死過一次）
    t.after(() => {
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    });

    const token = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET, { expiresIn: '10m' });
    const asOwner = 'Bearer ' + token(1, 'owner', 'web_owner');
    const asStaff = 'Bearer ' + token(2, 'staff', 'admin');

    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });
    const put = (url, body, headers) => fetch(base + url, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });
    const row = (id) => state.tables.admin_users.find((u) => u.id === id);

    /* ---------- ① POST /api/admin/login 是 /api/auth/login 的別名 ---------- */
    const badBody = { username: 'owner', password: 'wrong-password' };
    const aliasBad = await post('/api/admin/login', badBody);
    const canonBad = await post('/api/auth/login', badBody);
    assert.strictEqual(aliasBad.status, 401, '別名登入：密碼錯誤要回 401');
    assert.strictEqual(aliasBad.status, canonBad.status, '別名與正式路徑的行為必須一致');

    const aliasOk = await post('/api/admin/login', { username: 'owner', password: OLD_PASSWORD });
    assert.strictEqual(aliasOk.status, 200, '別名登入：正確帳密要能登入');
    const aliasBody = await aliasOk.json();
    assert.ok(!('token' in aliasBody), 'v3.5.0 起憑證不再放在回應內容（別名也不可例外）');
    assert.ok(authCookieLine(aliasOk), '別名登入也要發 HttpOnly cookie 憑證');

    /* ---------- ② PUT /api/auth/change-password：未登入一律 401 ---------- */
    const anon = await put('/api/auth/change-password', { oldPassword: OLD_PASSWORD, newPassword: 'brandnew1' });
    assert.strictEqual(anon.status, 401, '未登入不可修改密碼');
    assert.ok(verifyPassword(row(1).password, OLD_PASSWORD), '未登入的請求不可以改動密碼');

    /* ---------- ③ 新密碼格式（只允許英數字）---------- */
    const badFormat = await put('/api/auth/change-password',
        { oldPassword: OLD_PASSWORD, newPassword: 'abc-123!' }, { Authorization: asStaff });
    assert.strictEqual(badFormat.status, 400, '含符號的新密碼要被擋下');
    assert.match((await badFormat.json()).error, /格式/, '要回可以理解的格式錯誤訊息');

    /* ---------- ④ 舊密碼不正確 ---------- */
    const badOld = await put('/api/auth/change-password',
        { oldPassword: 'not-the-password', newPassword: 'brandnew1' }, { Authorization: asStaff });
    assert.strictEqual(badOld.status, 400, '舊密碼不對要回 400');
    assert.match((await badOld.json()).error, /舊密碼/, '訊息要指出是舊密碼的問題');
    assert.ok(verifyPassword(row(2).password, OLD_PASSWORD), '舊密碼錯誤時不得改動密碼');

    /* ---------- ⑤ 成功修改：雜湊儲存、稽核、舊密碼失效 ---------- */
    const NEW_PASSWORD = 'brandnew9';
    const ok = await put('/api/auth/change-password',
        { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { Authorization: asStaff });
    assert.strictEqual(ok.status, 200, '正確的舊密碼要能改密碼');

    assert.ok(row(2).password.startsWith('scrypt$'), `密碼必須以 scrypt 雜湊儲存（實際 ${String(row(2).password).slice(0, 12)}…）`);
    assert.ok(!String(row(2).password).includes(NEW_PASSWORD), '密碼不得以明碼出現');
    assert.ok(verifyPassword(row(2).password, NEW_PASSWORD), '新密碼要能通過驗證');
    assert.ok(!verifyPassword(row(2).password, OLD_PASSWORD), '舊密碼必須失效');

    const audit = state.tables.audit_logs.filter((l) => l.action === 'CHANGE_PASSWORD');
    assert.strictEqual(audit.length, 1, '修改密碼要留一筆稽核');
    assert.strictEqual(audit[0].user_id, 'staff', '稽核要記到實際改密碼的帳號');
    assert.strictEqual(String(audit[0].target_id), '2', '稽核的對象是該帳號自己');

    /* ---------- ⑥ 改完密碼後用新密碼登入 ---------- */
    const relogin = await post('/api/auth/login', { username: 'staff', password: NEW_PASSWORD });
    assert.strictEqual(relogin.status, 200, '改完密碼要用新密碼登得進去');

    /* ---------- ⑦ 只會改到「自己」：owner 改自己的密碼，不能連帶影響 staff ---------- */
    const staffHashBefore = row(2).password;
    const ownerChange = await put('/api/auth/change-password',
        { oldPassword: OLD_PASSWORD, newPassword: 'ownernew77' }, { Authorization: asOwner });
    assert.strictEqual(ownerChange.status, 200, 'owner 用自己的舊密碼可以改自己的密碼');
    assert.ok(verifyPassword(row(1).password, 'ownernew77'), 'owner 的新密碼要生效');
    assert.strictEqual(row(2).password, staffHashBefore, '改自己的密碼不得動到其他帳號的密碼');
    assert.strictEqual(state.tables.audit_logs.filter((l) => l.action === 'CHANGE_PASSWORD').length, 2,
        '每次成功修改都要有自己的稽核紀錄');
});
