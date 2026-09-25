/* v2.15.0：用手機尺寸的真實 Chrome 驗證「兩步驟驗證」完整流程
 *
 * 流程：密碼登入 → 到選單開啟設定 → 產生密鑰 → 用 lib/totp 算出 App 會顯示的碼 → 啟用
 *      → 取得 8 組備援碼 → 登出 → 再次登入（此時要求第二因素）→ 用驗證碼登入
 *      → 再用「備援碼」登入一次 → 檢查備援碼數量遞減、且沒有前端例外
 *
 * 伺服器：真的 server.js + 假 Supabase（不碰正式資料庫）。
 * 用法：node tests/browser/twofactor-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');
const { totp: totpCode } = require(path.join(__dirname, '..', '..', 'lib', 'totp.js'));

const PORT = Number(process.env.CHECK_PORT || 3298);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-2fa-check');
const USER = 'owner2fa';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true,
                  totp_secret: null, totp_enabled: false, totp_confirmed_at: null, totp_recovery_codes: null, totp_last_step: null }
            ],
            error_logs: [],
            audit_logs: [],
            push_log: [],
            competitions: [],
            registrations: []
        },
        nextId: { admin_users: 50, error_logs: 500 }
    };
}

// 在頁面內把 alert 換成記錄器（headless 的 alert 會卡住 CDP）
const STUB_ALERTS = `
    window.__ALERTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    return true;
`;

async function login(browser, password = PASS) {
    await browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('loginUsername', ${JSON.stringify(USER)});
        setValue('loginPassword', ${JSON.stringify(password)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
}

async function typeCodeAndSubmit(browser, selector, code) {
    await browser.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(code)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    `);
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.NODE_ENV = 'production';
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-check-secret';
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-service-key';
    process.env.SITE_URL = BASE;

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 兩步驟驗證流程檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_ALERTS);

        // ---------- 1. 一般登入（尚未啟用 2FA） ----------
        await login(browser);
        await browser.waitFor(`localStorage.getItem('competition_user') !== null`, { timeout: 10000 });
        check(true, '尚未啟用時：密碼即可登入');

        // ---------- 2. 開啟設定視窗 ----------
        await browser.evaluate(`
            document.getElementById('twoFactorBtn').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('twoFactorModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`/未啟用/.test(document.getElementById('twoFactorStatus').textContent)`, { timeout: 8000 });
        check(true, '設定視窗顯示「目前狀態：未啟用」');
        await browser.screenshot(path.join(SHOTS, '01-未啟用.png'));

        // ---------- 3. 產生密鑰 → 用 App 演算法算碼 → 啟用 ----------
        await browser.evaluate(`document.getElementById('twoFactorStartBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('twoFactorSecret').textContent.length > 0`, { timeout: 8000 });
        const secret = await browser.evaluate(`return document.getElementById('twoFactorSecret').textContent.trim();`);
        check(/^[A-Z2-7]{32}$/.test(secret), '產生 160-bit 密鑰（32 個 Base32 字元）', secret);
        await browser.screenshot(path.join(SHOTS, '02-密鑰.png'));

        const code = totpCode(secret);
        await typeCodeAndSubmit(browser, '#twoFactorEnableCode', code);
        await browser.evaluate(`document.getElementById('twoFactorEnableBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('twoFactorRecoverySection').classList.contains('hidden')`, { timeout: 8000 });

        const recoveryCodes = await browser.evaluate(`
            return Array.from(document.querySelectorAll('#twoFactorRecoveryList span')).map((s) => s.textContent.trim());
        `);
        check(recoveryCodes.length === 8, `取得 8 組一次性備援碼（實際 ${recoveryCodes.length}）`);
        check(recoveryCodes.every((c) => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(c)), '備援碼格式正確', recoveryCodes[0]);
        const dbRow = state.tables.admin_users.find((u) => u.id === 1);
        check(dbRow.totp_enabled === true, '資料庫標記為已啟用');
        check(!!dbRow.totp_recovery_codes && !JSON.stringify(dbRow.totp_recovery_codes).includes(recoveryCodes[0]),
            '備援碼只存雜湊、資料庫沒有明文');
        await browser.screenshot(path.join(SHOTS, '03-備援碼.png'));

        // ---------- 4. 登出 → 再登入：應要求第二因素 ----------
        await browser.evaluate(`
            document.getElementById('twoFactorRecoveryDoneBtn').click();
            document.getElementById('closeTwoFactorModalBtn').click();
            return true;
        `);
        // 用真正的登出按鈕（會把記憶體中的 currentUser 一併清掉）
        await browser.evaluate(`
            document.getElementById('logoutBtn').click();
            document.getElementById('authBtn').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('loginModal').classList.contains('hidden')`, { timeout: 8000 });
        await login(browser);
        await browser.waitFor(`!document.getElementById('login2faFields').classList.contains('hidden')`, { timeout: 10000 });
        check(true, '再次登入時要求輸入兩步驟驗證碼');
        await browser.screenshot(path.join(SHOTS, '04-要求驗證碼.png'));

        const tokenBefore = await browser.evaluate(`return localStorage.getItem('auth_token');`);
        check(!tokenBefore, '只輸入密碼時還沒有登入憑證（第二因素未通過）');

        // 錯的碼要被拒絕
        await typeCodeAndSubmit(browser, '#login2faCode', '000000');
        await browser.evaluate(`document.getElementById('submitLoginBtn').click(); return true;`);
        await browser.evaluate(`return new Promise((r) => setTimeout(r, 600));`);
        const stillNoToken = await browser.evaluate(`return localStorage.getItem('auth_token');`);
        check(!stillNoToken, '錯誤的驗證碼不會登入');

        // 正確的碼：用「下一個時間步」，避免與剛才啟用時用掉的那一步相同（防重放機制會拒絕重複使用）
        const loginCode = totpCode(secret, { at: Date.now() + 30000 });
        await typeCodeAndSubmit(browser, '#login2faCode', loginCode);
        await browser.evaluate(`document.getElementById('submitLoginBtn').click(); return true;`);
        await browser.waitFor(`localStorage.getItem('auth_token') !== null`, { timeout: 10000 });
        await browser.waitFor(`document.getElementById('login2faFields').classList.contains('hidden')`, { timeout: 8000 });
        check(true, '輸入正確驗證碼後完成登入');

        // ---------- 5. 用備援碼登入一次 ----------
        // 用真正的登出按鈕（會把記憶體中的 currentUser 一併清掉）
        await browser.evaluate(`
            document.getElementById('logoutBtn').click();
            document.getElementById('authBtn').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('loginModal').classList.contains('hidden')`, { timeout: 8000 });
        await login(browser);
        await browser.waitFor(`!document.getElementById('login2faFields').classList.contains('hidden')`, { timeout: 10000 });
        await browser.evaluate(`document.getElementById('login2faUseRecovery').click(); return true;`);
        await typeCodeAndSubmit(browser, '#login2faCode', recoveryCodes[0]);
        await browser.evaluate(`document.getElementById('submitLoginBtn').click(); return true;`);
        await browser.waitFor(`localStorage.getItem('auth_token') !== null`, { timeout: 10000 });
        const alerts = await browser.evaluate(`return window.__ALERTS__;`);
        check(alerts.some((m) => /備援碼/.test(m) && /剩下 7 組/.test(m)),
            '用備援碼登入成功，並提示剩餘數量', JSON.stringify(alerts));

        const used = state.tables.admin_users.find((u) => u.id === 1).totp_recovery_codes;
        check(used.filter((e) => e.used_at).length === 1, '該備援碼已標記為使用過（不可重複使用）');

        // ---------- 6. 沒有前端例外 ----------
        check(browser.pageErrors.length === 0, '過程中沒有未捕捉的前端例外', browser.pageErrors.join(' | '));
        const noise = browser.consoleErrors.filter((m) => !/favicon|Failed to load resource|401|403/.test(m));
        check(noise.length === 0, '沒有非預期的 console 錯誤', noise.join(' | '));

        console.log(`\n📸 截圖：${SHOTS}`);
        console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('❌ 檢查失敗：', err.message);
    process.exit(1);
});
