/* v2.15.0：兩步驟驗證（TOTP）API 端到端測試
   用假 Supabase（tests/support/fake-supabase.js）跑真實 Express app，完全不碰正式資料庫。
   驗證碼由 lib/totp.js 依「當下時間」算出，等同真實手機 App 產生的碼。 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const { startFakeSupabase } = require('./support/fake-supabase');
const { totp: totpCode, generateSecret } = require(path.join(__dirname, '..', 'lib', 'totp.js'));

const SECRET = 'twofactor-test-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const TFA_COLUMNS = ['totp_secret', 'totp_enabled', 'totp_confirmed_at', 'totp_recovery_codes', 'totp_last_step'];

function baseState(extra = {}) {
    return {
        tables: Object.assign({
            admin_users: [
                { id: 1, username: 'owner', password: 'plain-owner123', role: 'web_owner', is_active: true },
                { id: 2, username: 'boss', password: 'plain-boss123', role: 'super_admin', is_active: true },
                { id: 3, username: 'mgr', password: 'plain-mgr123', role: 'admin', is_active: true },
                { id: 4, username: 'kid', password: 'plain-kid123', role: 'user', is_active: true }
            ],
            error_logs: [],
            audit_logs: [],
            competitions: [],
            registrations: []
        }, extra.tables || {}),
        missingColumns: extra.missingColumns || {},
        nextId: { admin_users: 90, error_logs: 500 }
    };
}

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { stub, server, base: `http://127.0.0.1:${server.address().port}`, app };
}

const sign = (sub, username, role, opts = {}) => jwt.sign({ sub, username, role }, SECRET, opts);
const auth = (sub, username, role) => ({ Authorization: 'Bearer ' + sign(sub, username, role) });

const req = (base, method) => (url, body, headers = {}) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body)
});

test('v2.15.0 未執行 migration 時：兩步驟驗證自動停用，原本的登入不受影響', async (t) => {
    const state = baseState({ missingColumns: { admin_users: TFA_COLUMNS } });
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const get = req(base, 'GET');
    const asOwner = auth(1, 'owner', 'web_owner');

    const status = await (await fetch(`${base}/api/auth/2fa/status`, { headers: asOwner })).json();
    assert.strictEqual(status.schema_ready, false, '欄位不存在時應回報 schema_ready: false');
    assert.strictEqual(status.enabled, false);

    const setup = await post('/api/auth/2fa/setup', {}, asOwner);
    assert.strictEqual(setup.status, 503);
    const setupBody = await setup.json();
    assert.match(setupBody.error, /migrations\/2026-09-26-v2.15.0-admin-2fa\.sql/);
    assert.strictEqual(setupBody.migration_required, true);

    // 舊行為完全不變：沒有 2FA 欄位時照樣能用密碼登入
    const login = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    assert.ok(login.token, '未執行 migration 時仍應正常登入');
    assert.ok(!login.requires_2fa);
});

test('v2.15.0 綁定流程：產生密鑰 → 驗證碼啟用 → 取得一次性備援碼', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const asOwner = auth(1, 'owner', 'web_owner');

    const status0 = await (await fetch(`${base}/api/auth/2fa/status`, { headers: asOwner })).json();
    assert.strictEqual(status0.schema_ready, true);
    assert.strictEqual(status0.enabled, false);

    const setup = await (await post('/api/auth/2fa/setup', {}, asOwner)).json();
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.otpauth_uri, /^otpauth:\/\/totp\//);
    assert.ok(setup.otpauth_uri.includes(setup.secret));
    assert.strictEqual(setup.account, 'owner');

    // 密鑰有存進資料庫，但此時還沒啟用
    const row = state.tables.admin_users.find((u) => u.id === 1);
    assert.strictEqual(row.totp_secret, setup.secret);
    assert.strictEqual(row.totp_enabled, false);

    // 用「App 算出來的碼」啟用
    const code = totpCode(setup.secret);
    const enabled = await (await post('/api/auth/2fa/enable', { code }, asOwner)).json();
    assert.strictEqual(enabled.success, true);
    assert.strictEqual(enabled.recovery_codes.length, 8);
    assert.match(enabled.warning, /只會顯示這一次/);

    const row2 = state.tables.admin_users.find((u) => u.id === 1);
    assert.strictEqual(row2.totp_enabled, true);
    assert.strictEqual(row2.totp_recovery_codes.length, 8);
    // 備援碼只存雜湊，不能是明文
    for (const entry of row2.totp_recovery_codes) {
        assert.ok(entry.salt && entry.hash);
        assert.ok(!enabled.recovery_codes.includes(entry.hash));
    }
    assert.strictEqual(typeof row2.totp_last_step, 'number');

    const status1 = await (await fetch(`${base}/api/auth/2fa/status`, { headers: asOwner })).json();
    assert.strictEqual(status1.enabled, true);
    assert.strictEqual(status1.remaining_recovery_codes, 8);

    // 錯誤的碼不能啟用第二次
    const again = await post('/api/auth/2fa/enable', { code }, asOwner);
    assert.strictEqual(again.status, 400);
});

test('v2.15.0 登入兩段式：中間權杖不能當登入憑證、同一組碼不能重放', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const secret = generateSecret();
    state.tables.admin_users[0].totp_secret = secret;
    state.tables.admin_users[0].totp_enabled = true;
    state.tables.admin_users[0].totp_recovery_codes = [];
    state.tables.admin_users[0].totp_last_step = null;

    // 第一段：密碼正確 → 只拿到中間權杖
    const first = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    assert.strictEqual(first.requires_2fa, true);
    assert.ok(first.challenge_token, '應回傳中間權杖');
    assert.strictEqual(first.token, undefined, '此時還不能發正式權杖');

    // 中間權杖不可以拿去讀受保護的 API（這是整個機制的關鍵）
    const blocked = await fetch(`${base}/api/admin/users`, { headers: { Authorization: 'Bearer ' + first.challenge_token } });
    assert.strictEqual(blocked.status, 401, '中間權杖必須被 authenticateToken 拒絕');

    // 錯的碼
    const wrong = await post('/api/auth/login/2fa', { challenge_token: first.challenge_token, code: '000000' });
    assert.strictEqual(wrong.status, 401);

    // 正確的碼 → 正式權杖
    const code = totpCode(secret);
    const done = await (await post('/api/auth/login/2fa', { challenge_token: first.challenge_token, code })).json();
    assert.ok(done.token, '通過第二因素後才發正式權杖');
    assert.strictEqual(done.used_recovery_code, false);

    const users = await fetch(`${base}/api/admin/users`, { headers: { Authorization: 'Bearer ' + done.token } });
    assert.strictEqual(users.status, 200, '正式權杖可以正常使用');

    // 同一組碼不能再用（同一時間步重放）
    const replay = await post('/api/auth/login/2fa', { challenge_token: first.challenge_token, code });
    assert.strictEqual(replay.status, 401);
    assert.match((await replay.json()).error, /已經用過/);

    // 亂造的權杖也不能通過
    const fake = await post('/api/auth/login/2fa', { challenge_token: sign(1, 'owner', 'web_owner'), code: totpCode(secret) });
    assert.strictEqual(fake.status, 401, '沒有 stage 的權杖不是有效的中間權杖');
});

test('v2.15.0 備援碼：可登入、只能用一次、剩餘數量會遞減', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const asOwner = auth(1, 'owner', 'web_owner');

    const setup = await (await post('/api/auth/2fa/setup', {}, asOwner)).json();
    const enabled = await (await post('/api/auth/2fa/enable', { code: totpCode(setup.secret) }, asOwner)).json();
    const recovery = enabled.recovery_codes[0];

    const first = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    const done = await (await post('/api/auth/login/2fa', { challenge_token: first.challenge_token, code: recovery })).json();
    assert.ok(done.token, '備援碼應可完成登入');
    assert.strictEqual(done.used_recovery_code, true);
    assert.strictEqual(done.remaining_recovery_codes, 7);

    // 同一組備援碼不能再用
    const first2 = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    const reuse = await post('/api/auth/login/2fa', { challenge_token: first2.challenge_token, code: recovery });
    assert.strictEqual(reuse.status, 401, '用過的備援碼不可重複使用');

    // 帶連字號、小寫、省略連字號都要能接受（使用者手抄容易格式不一）
    const first3 = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    const loose = await (await post('/api/auth/login/2fa', {
        challenge_token: first3.challenge_token, code: enabled.recovery_codes[1].toLowerCase().replace(/-/g, '')
    })).json();
    assert.ok(loose.token, '備援碼格式寬鬆比對應可登入');
    assert.strictEqual(loose.remaining_recovery_codes, 6);
});

test('v2.15.0 停用：需要密碼 + 驗證碼，停用後恢復只驗密碼', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const asOwner = auth(1, 'owner', 'web_owner');

    const setup = await (await post('/api/auth/2fa/setup', {}, asOwner)).json();
    await post('/api/auth/2fa/enable', { code: totpCode(setup.secret) }, asOwner);

    // 啟用時用的那一組碼已經被消耗（防重放），所以停用要用「下一個時間步」的碼
    const nextStepCode = () => totpCode(setup.secret, { at: Date.now() + 30000 });

    // 密碼錯 → 401
    const badPwd = await post('/api/auth/2fa/disable', { password: 'wrong-pass', code: nextStepCode() }, asOwner);
    assert.strictEqual(badPwd.status, 401);

    // 密碼對但驗證碼錯 → 401
    const badCode = await post('/api/auth/2fa/disable', { password: 'plain-owner123', code: '000000' }, asOwner);
    assert.strictEqual(badCode.status, 401);

    // 兩者都對 → 停用
    const disabled = await (await post('/api/auth/2fa/disable', { password: 'plain-owner123', code: nextStepCode() }, asOwner)).json();
    assert.strictEqual(disabled.success, true, JSON.stringify(disabled));

    const row = state.tables.admin_users.find((u) => u.id === 1);
    assert.strictEqual(row.totp_enabled, false);
    assert.strictEqual(row.totp_secret, null);
    assert.strictEqual(row.totp_recovery_codes, null);

    // 之後登入只需密碼
    const login = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' })).json();
    assert.ok(login.token);
    assert.ok(!login.requires_2fa);
});

test('v2.15.0 救援與權限：上級可重設下級的兩步驟驗證，一般管理員不行', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    // mgr(id 3, admin) 已啟用 2FA
    const mgrSecret = generateSecret();
    Object.assign(state.tables.admin_users.find((u) => u.id === 3), {
        totp_secret: mgrSecret, totp_enabled: true, totp_recovery_codes: [], totp_last_step: null
    });

    // 未登入 → 401
    assert.strictEqual((await fetch(`${base}/api/admin/users/3/reset-2fa`, { method: 'POST' })).status, 401);

    // admin 不能重設同級（自己也是 admin 時不行這個由 canManageUser 判斷）
    const sameLevel = await post('/api/admin/users/3/reset-2fa', {}, auth(3, 'mgr', 'admin'));
    assert.strictEqual(sameLevel.status, 403);

    // super_admin 可以重設 admin（嚴格低於自己）
    const ok = await (await post('/api/admin/users/3/reset-2fa', {}, auth(2, 'boss', 'super_admin'))).json();
    assert.strictEqual(ok.success, true);
    const row = state.tables.admin_users.find((u) => u.id === 3);
    assert.strictEqual(row.totp_enabled, false);
    assert.strictEqual(row.totp_secret, null);

    // 已停用的帳號不能再重設
    const again = await post('/api/admin/users/3/reset-2fa', {}, auth(2, 'boss', 'super_admin'));
    assert.strictEqual(again.status, 400);

    // 稽核紀錄要有留下
    const audits = state.tables.audit_logs.map((a) => a.action);
    assert.ok(audits.includes('2FA_RESET_BY_ADMIN'), `稽核應包含 2FA_RESET_BY_ADMIN，實際：${audits.join(', ')}`);
});

test('v2.15.0 連續驗證碼錯誤會被鎖定（不會被慢慢猜到）', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const secret = generateSecret();
    Object.assign(state.tables.admin_users.find((u) => u.id === 2), {
        totp_secret: secret, totp_enabled: true, totp_recovery_codes: [], totp_last_step: null
    });

    const first = await (await post('/api/auth/login', { username: 'boss', password: 'plain-boss123' })).json();
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
        const r = await post('/api/auth/login/2fa', { challenge_token: first.challenge_token, code: '111111' });
        lastStatus = r.status;
        if (lastStatus === 429) break;
    }
    assert.strictEqual(lastStatus, 429, '連續錯誤驗證碼應觸發鎖定（IP 門檻）');
});
