/* v2.12.1：密碼雜湊與「明碼自動升級」測試
   - lib/passwords.js 的雜湊／驗證行為
   - 伺服器：舊帳號（明碼）登入成功後自動升級為 scrypt 雜湊，且升級後仍可登入
   - scripts/hash-legacy-passwords.js：一次批次升級 + 自我驗證（跑在假 Supabase 上，不碰真實資料庫） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { startFakeSupabase } = require('./support/fake-supabase');

const {
    hashPassword,
    verifyPassword,
    needsPasswordUpgrade
} = require('../lib/passwords');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'hash-legacy-passwords.js');
const SECRET = 'v2121-password-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

test('v2.12.1 密碼雜湊：雜湊格式、驗證、明碼判斷', () => {
    const hashed = hashPassword('Secret123');
    assert.match(hashed, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.ok(!hashed.includes('Secret123'), '雜湊內容不應包含原始密碼');
    assert.strictEqual(verifyPassword(hashed, 'Secret123'), true);
    assert.strictEqual(verifyPassword(hashed, 'Secret124'), false);
    assert.strictEqual(verifyPassword(hashed, ''), false);

    // 同一組密碼每次雜湊都不同（加鹽）
    assert.notStrictEqual(hashPassword('Secret123'), hashed);

    // 舊資料（明碼）仍可比對，但會被標記為需要升級
    assert.strictEqual(verifyPassword('plain-old', 'plain-old'), true);
    assert.strictEqual(verifyPassword('plain-old', 'plain-old2'), false);
    assert.strictEqual(verifyPassword('plain-old', 'plain-old-longer'), false, '長度不同不應拋錯');
    assert.strictEqual(needsPasswordUpgrade('plain-old'), true);
    assert.strictEqual(needsPasswordUpgrade(hashed), false);
    assert.strictEqual(needsPasswordUpgrade(''), false, '空值不算待升級（避免寫壞資料）');
    assert.strictEqual(needsPasswordUpgrade(null), false);
    assert.strictEqual(verifyPassword('scrypt$bad', 'x'), false, '格式錯誤的雜湊不應通過');
});

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { stub, server, base: `http://127.0.0.1:${server.address().port}`, app };
}

const login = (base, username, password) => fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
});

test('v2.12.1 登入時自動把明碼密碼升級成雜湊（且不影響登入）', async (t) => {
    const state = {
        tables: {
            admin_users: [
                { id: 1, username: 'legacy', password: 'OldPass123', role: 'admin', is_active: true },
                { id: 2, username: 'modern', password: hashPassword('NewPass123'), role: 'admin', is_active: true }
            ],
            audit_logs: [],
            error_logs: []
        },
        missingColumns: {},
        nextId: { admin_users: 50, audit_logs: 1, error_logs: 1 }
    };
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    // 舊帳號：第一次登入成功，且資料庫中的密碼被升級
    const first = await login(base, 'legacy', 'OldPass123');
    assert.strictEqual(first.status, 200, '舊帳號應能登入');
    const row1 = state.tables.admin_users.find(u => u.username === 'legacy');
    assert.match(row1.password, /^scrypt\$/, '登入後密碼應變成 scrypt 雜湊');
    assert.strictEqual(verifyPassword(row1.password, 'OldPass123'), true, '升級後仍能用同一組密碼驗證');
    assert.ok(!row1.password.includes('OldPass123'), '資料庫不應再留明文密碼');

    // 升級後的第二次登入仍正常，且不會再改寫
    const hashedBefore = row1.password;
    const second = await login(base, 'legacy', 'OldPass123');
    assert.strictEqual(second.status, 200);
    assert.strictEqual(row1.password, hashedBefore, '已是雜湊的帳號不應被重複改寫');

    // 升級後錯誤密碼仍然被拒
    const wrong = await login(base, 'legacy', 'WrongPass123');
    assert.strictEqual(wrong.status, 401);

    // 本來就是雜湊的帳號不受影響
    const modernBefore = state.tables.admin_users.find(u => u.username === 'modern').password;
    const modernLogin = await login(base, 'modern', 'NewPass123');
    assert.strictEqual(modernLogin.status, 200);
    assert.strictEqual(state.tables.admin_users.find(u => u.username === 'modern').password, modernBefore);
});

test('v2.12.1 批次升級腳本：先自我驗證、寫入後複驗，且不輸出任何密碼', async (t) => {
    const state = {
        tables: {
            admin_users: [
                { id: 1, username: 'a_plain', password: 'Aa123456', role: 'user', is_active: true },
                { id: 2, username: 'b_plain', password: 'Bb123456', role: 'user', is_active: true },
                { id: 3, username: 'c_hashed', password: hashPassword('Cc123456'), role: 'user', is_active: true }
            ]
        },
        missingColumns: {},
        nextId: { admin_users: 9 }
    };
    const stub = await startFakeSupabase(state);
    t.after(() => stub.close());
    const env = Object.assign({}, process.env, {
        SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
        SUPABASE_KEY: 'stub-key'
    });

    // --dry-run 不寫入（非同步執行，父行程的假 Supabase 才能回應）
    const dry = (await execFileAsync('node', [SCRIPT, '--dry-run'], { env, encoding: 'utf8' })).stdout;
    assert.match(dry, /仍是明碼：2/);
    assert.match(dry, /未做任何寫入/);
    assert.strictEqual(state.tables.admin_users.find(u => u.username === 'a_plain').password, 'Aa123456');

    // 實際執行
    const real = (await execFileAsync('node', [SCRIPT], { env, encoding: 'utf8' })).stdout;
    assert.match(real, /已升級 2\/2/);
    assert.match(real, /剩餘明碼 0 筆、升級後驗證失敗 0 筆/);
    assert.ok(!/Aa123456|Bb123456/.test(dry + real), '輸出不得包含任何密碼');

    // 資料庫狀態：全部已是雜湊，且原密碼仍可驗證
    for (const [name, plain] of [['a_plain', 'Aa123456'], ['b_plain', 'Bb123456']]) {
        const row = state.tables.admin_users.find(u => u.username === name);
        assert.match(row.password, /^scrypt\$/);
        assert.strictEqual(verifyPassword(row.password, plain), true);
    }

    // 再跑一次：應回報「無需處理」
    const again = (await execFileAsync('node', [SCRIPT], { env, encoding: 'utf8' })).stdout;
    assert.match(again, /仍是明碼：0/);
    assert.match(again, /沒有任何明碼密碼/);
});

test('v2.12.1 日誌健康端點會回報還有幾個明碼帳號', async (t) => {
    const state = {
        tables: {
            admin_users: [
                { id: 1, username: 'owner', password: 'plain-owner', role: 'web_owner', is_active: true },
                { id: 2, username: 'plain2', password: 'plain-two', role: 'user', is_active: true },
                { id: 3, username: 'hashed', password: hashPassword('Hashed123'), role: 'user', is_active: true }
            ],
            error_logs: []
        },
        missingColumns: {},
        nextId: { admin_users: 20, error_logs: 1 }
    };
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
    const r = await fetch(base + '/api/admin/error-logs/health', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.plaintext_passwords, 2, '應回報 2 個明碼帳號（只回數量，不回傳內容）');
    assert.ok(!JSON.stringify(body).includes('plain-owner'), '回應不得包含密碼內容');
});
