/* v3.5.0：CORS 白名單 + 登入憑證改存 HttpOnly cookie 的行為測試
 *
 * 這一版把兩個 ZAP 中風險警示處理掉，兩個改動都是「安全性質」而不是功能，
 * 所以測試直接驗性質本身：
 *   1. 回應內容不得再出現 token（否則 JS 還是讀得到，等於白改）
 *   2. cookie 必須 HttpOnly / SameSite=Strict
 *   3. 跨站來源不能用 cookie 打會改變狀態的 API（CSRF 第二道防線）
 *   4. CORS 只反射白名單來源，其他來源完全不給 Access-Control-Allow-Origin
 *   5. Authorization: Bearer 仍要能用（維運腳本、cron、正式站煙霧測試靠它）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const { startFakeSupabase } = require('./support/fake-supabase');
const { authCookieLine, cookieHeader } = require('./support/auth-cookie');

const SECRET = 'v350-auth-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CORS_ALLOWED_ORIGINS = 'https://preview.example';

const sign = (sub, username, role, opts = {}) => jwt.sign({ sub, username, role }, SECRET, opts);

function baseState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: 'owner', password: 'plain-owner123', role: 'web_owner', is_active: true }
            ],
            error_logs: [],
            audit_logs: [],
            competitions: [],
            registrations: [],
            app_settings: []
        },
        missingColumns: {},
        nextId: { error_logs: 700, audit_logs: 700 }
    };
}

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return { stub, server, base, selfOrigin: base };
}

const req = (base, method = 'GET') => (url, body, headers) =>
    fetch(base + url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: method === 'GET' ? undefined : JSON.stringify(body || {})
    });

test('v3.5.0 登入憑證只放在 HttpOnly cookie：回應不含 token、cookie 屬性正確', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const res = await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    // 1) 回應內容絕不可再出現權杖（否則 XSS 仍可從登入回應偷走）
    assert.strictEqual(body.token, undefined, '回應不應再含 token');
    assert.ok(!JSON.stringify(body).includes('eyJ'), '回應內容不應出現任何 JWT 字串');

    // 2) cookie 屬性
    const line = authCookieLine(res);
    assert.match(line, /^cm_token=/, '應以 Set-Cookie 發憑證');
    assert.match(line, /HttpOnly/i, '必須 HttpOnly（JS 讀不到）');
    assert.match(line, /SameSite=Strict/i, '必須 SameSite=Strict（CSRF 第一道防線）');
    assert.match(line, /Path=\//i, 'Path 必須是 /');
    assert.match(line, /Secure/i, 'production 必須 Secure');
    assert.match(line, /Max-Age=43200/, '效期應與 JWT 一致（12 小時）');

    // 3) 帶 cookie 可以取得身分；沒有 cookie 就 401
    const me = await fetch(`${base}/api/auth/me`, { headers: cookieHeader(res) });
    assert.strictEqual(me.status, 200, '帶 cookie 應可通過驗證');
    assert.strictEqual((await me.json()).user.username, 'owner');

    const anon = await fetch(`${base}/api/auth/me`);
    assert.strictEqual(anon.status, 401, '沒有憑證應 401');
});

test('v3.5.0 CSRF：cookie 憑證不得被跨站來源拿來做會改變狀態的請求', async (t) => {
    const state = baseState();
    const { stub, server, base, selfOrigin } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const login = await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' });
    const cookie = cookieHeader(login);

    // 跨站來源 + cookie → 擋下（403）
    const crossSite = await post('/api/push/test', {}, Object.assign({ Origin: 'https://evil.example' }, cookie));
    assert.strictEqual(crossSite.status, 403, '跨站來源用 cookie 打 POST 必須 403');
    assert.match((await crossSite.json()).error, /CSRF/);

    // 同源來源 + cookie → 放行（不是 403；這個端點本身會因為沒有訂閱而回其他狀態碼）
    const sameSite = await post('/api/push/test', {}, Object.assign({ Origin: selfOrigin }, cookie));
    assert.notStrictEqual(sameSite.status, 403, '同源請求不該被 CSRF 檢查擋下');

    // 沒帶 Origin／Referer（curl、我們自己的腳本、cron 就是這樣）→ 放行
    const noOrigin = await post('/api/push/test', {}, cookie);
    assert.notStrictEqual(noOrigin.status, 403, '沒有 Origin 的請求（非瀏覽器）不該被擋');

    // Bearer 憑證不受 CSRF 限制：攻擊者的網站無法讓瀏覽器自動帶上它
    const bearerCross = await post('/api/push/test', {}, {
        Origin: 'https://evil.example',
        Authorization: 'Bearer ' + sign(1, 'owner', 'web_owner')
    });
    assert.notStrictEqual(bearerCross.status, 403, 'Bearer 請求不受 CSRF 檢查影響');

    // 讀取（GET）不受影響
    const getMe = await fetch(`${base}/api/auth/me`, { headers: Object.assign({ Origin: 'https://evil.example' }, cookie) });
    assert.strictEqual(getMe.status, 200, 'GET 不改變狀態，不受 CSRF 檢查限制');
});

test('v3.5.0 CORS 白名單：只反射自家與白名單來源，其餘完全不給 ACAO', async (t) => {
    const state = baseState();
    const { stub, server, base, selfOrigin } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    // 第三方來源 → 沒有 Access-Control-Allow-Origin（瀏覽器會擋下讀取）
    const evil = await fetch(`${base}/api/competitions`, { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(evil.headers.get('access-control-allow-origin'), null, '非白名單來源不得取得 ACAO');

    // 白名單來源 → 反射來源，且允許帶憑證
    const allowed = await fetch(`${base}/api/competitions`, { headers: { Origin: 'https://preview.example' } });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://preview.example');
    assert.strictEqual(allowed.headers.get('access-control-allow-credentials'), 'true');

    // 同源（自己的網域）→ 反射
    const same = await fetch(`${base}/api/competitions`, { headers: { Origin: selfOrigin } });
    assert.strictEqual(same.headers.get('access-control-allow-origin'), selfOrigin);

    // 完全不帶 Origin（curl、腳本）→ 沒有 ACAO 也不影響（CORS 只跟瀏覽器有關）
    const noOrigin = await fetch(`${base}/api/competitions`);
    assert.strictEqual(noOrigin.status, 200);
    assert.strictEqual(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('v3.5.0 登出會清掉 cookie，且 Bearer 仍然可用（向後相容）', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const login = await post('/api/auth/login', { username: 'owner', password: 'plain-owner123' });
    assert.ok(cookieHeader(login).Cookie, '登入應取得 cookie');

    const out = await post('/api/auth/logout', {}, cookieHeader(login));
    assert.strictEqual(out.status, 200);
    const cleared = authCookieLine(out);
    assert.match(cleared, /^cm_token=/, '登出應設定清除 cookie');
    assert.match(cleared, /Max-Age=0|Expires=Thu, 01 Jan 1970/i, 'cookie 應被清掉（Max-Age=0）');

    // 稽核要有 LOGOUT
    assert.ok(state.tables.audit_logs.some((r) => r.action === 'LOGOUT'), '登出應留下稽核紀錄');

    // 舊的 Bearer 寫法仍要能用（維運腳本、cron、正式站煙霧測試）
    const viaBearer = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: 'Bearer ' + sign(1, 'owner', 'web_owner') }
    });
    assert.strictEqual(viaBearer.status, 200, 'Authorization: Bearer 必須維持可用');

    // 中間權杖（stage）仍不可當正式憑證——即使放在 cookie 裡也一樣
    const stage = sign(1, 'owner', 'web_owner', { expiresIn: '5m' });
    const stageRes = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'cm_token=' + jwt.sign({ sub: 1, username: 'owner', role: 'web_owner', stage: '2fa' }, SECRET, { expiresIn: '5m' }) }
    });
    assert.strictEqual(stageRes.status, 401, '帶 stage 的權杖放在 cookie 也要被拒');
    assert.ok(stage);
});
