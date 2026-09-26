/* v3.1.2：用手機尺寸的真實 Chrome 驗證「帳號管理」
 *
 * 為什麼要有這支檢查：刪除帳號的按鈕曾經被綁了兩個 click 處理器
 * （一個是舊版遺留的監聽器），點一下會送出兩次 DELETE：
 * 第一次成功、第二次回 404「找不到該帳號」，稽核日誌也留下兩筆。
 * 這支檢查直接數「送了幾個請求」與「留了幾筆稽核」，不靠肉眼。
 *
 * 驗的內容：
 *   ① 選單權限：管理員看得到「帳號管理」，一般使用者與訪客沒有
 *   ② 清單列出帳號，且不含密碼（明文或雜湊）與任何 token
 *   ③ 自己的那一列沒有刪除按鈕
 *   ④ 點一次「刪除」恰好送出一個 DELETE 請求（核心迴歸）
 *   ⑤ 刪除只跳一次確認對話框、只出現一次成功提示
 *   ⑥ 被刪的帳號從清單消失
 *   ⑦ 稽核日誌恰好一筆 DELETE_USER（核心迴歸）
 *   ⑧ 連點兩次仍然只送一個請求（防連點）
 *   ⑨ 開關 modal 兩次後，「重新整理」按一次只送一個請求（重複綁定守衛）
 *   ⑩ 手機尺寸沒有橫向溢出、沒有前端例外、沒有下載任何檔案
 *
 * 用法：node tests/browser/admin-users-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3323);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-admin-users-check');
const OWNER = 'owner-users';
const PEER = 'peer-owner';
const VICTIM = 'victim-one';
const VICTIM2 = 'victim-two';
const PLAYER = 'player-users';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

// 覆蓋對話框並統計，同時攔截 fetch 記錄每個請求（方法＋路徑）
const STUB_AND_COUNT = `
    window.__ALERTS__ = [];
    window.__CONFIRMS__ = 0;
    window.__REQS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => { window.__CONFIRMS__++; return true; };
    if (!window.__FETCH_PATCHED__) {
        window.__FETCH_PATCHED__ = true;
        const orig = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            try { window.__REQS__.push({ method, url: String(url) }); } catch (err) { /* 忽略 */ }
            return orig.apply(this, arguments);
        };
    }
    return true;
`;

// 注意：browser.evaluate 會把內容包成 async 函式，**一定要寫 return**，否則拿到 undefined。
const countReqs = async (browser, method, needle, since) => {
    const reqs = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__REQS__ || [])`));
    return reqs.slice(since).filter((r) => r.method === method && r.url.includes(needle)).length;
};
const reqCount = async (browser) => Number(await browser.evaluate(`return String((window.__REQS__ || []).length)`));

const login = async (browser, username, password) => {
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
    const fillAndClick = () => browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('loginUsername', ${JSON.stringify(username)});
        setValue('loginPassword', ${JSON.stringify(password)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await fillAndClick();
    try {
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fillAndClick();
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
    }
};

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: OWNER, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(120), last_login_at: daysAgo(1), two_factor_enabled: false },
                { id: 2, username: PEER, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(90), last_login_at: daysAgo(2), two_factor_enabled: false },
                { id: 3, username: VICTIM, password: PASS, role: 'user', is_active: true, created_at: daysAgo(10), last_login_at: null, two_factor_enabled: false },
                { id: 4, username: VICTIM2, password: PASS, role: 'user', is_active: true, created_at: daysAgo(9), last_login_at: null, two_factor_enabled: false },
                { id: 5, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: daysAgo(8), last_login_at: null, two_factor_enabled: false }
            ],
            competitions: [],
            registrations: [],
            audit_logs: [],
            error_logs: [],
            app_settings: [],
            push_subscriptions: [],
            push_log: []
        },
        nextId: { audit_logs: 1, error_logs: 1 },
        missingTables: [],
        log: []
    };
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
    console.log(`\n🧪 帳號管理檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    let step = '啟動';
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_AND_COUNT);
        await login(browser, OWNER, PASS);
        await browser.waitFor(`document.getElementById('adminMgmtBtn') !== null`, { timeout: 15000 });

        // ---------- ① 選單權限 ----------
        step = '① 選單權限';
        const menu = JSON.parse(await browser.evaluate(`
            const btn = document.getElementById('adminMgmtBtn');
            return JSON.stringify({
                exists: !!btn,
                label: btn ? btn.textContent.trim() : '',
                ownerVisible: btn && !btn.classList.contains('hidden'),
                ownerAllowed: !!(CM_MENU_PERMISSIONS.web_owner && CM_MENU_PERMISSIONS.web_owner.adminMgmt),
                adminAllowed: !!(CM_MENU_PERMISSIONS.admin && CM_MENU_PERMISSIONS.admin.adminMgmt),
                userAllowed: !!(CM_MENU_PERMISSIONS.user && CM_MENU_PERMISSIONS.user.adminMgmt),
                guestAllowed: !!(CM_MENU_PERMISSIONS.guest && CM_MENU_PERMISSIONS.guest.adminMgmt)
            });
        `));
        check(menu.exists && menu.ownerVisible, `管理員看得到帳號管理（${menu.label}）`);
        check(menu.ownerAllowed && menu.adminAllowed && !menu.userAllowed && !menu.guestAllowed,
            '只有管理員以上有帳號管理權限');

        // ---------- ② 清單內容與個資 ----------
        step = '② 清單內容';
        await browser.evaluate(`document.getElementById('adminMgmtBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#adminList [data-action="delete-admin"]').length >= 1`, { timeout: 15000 });
        const list = JSON.parse(await browser.evaluate(`
            const el = document.getElementById('adminList');
            return JSON.stringify({ text: el.textContent, html: el.innerHTML });
        `));
        check([OWNER, PEER, VICTIM, VICTIM2, PLAYER].every((u) => list.text.includes(u)), '清單列出所有帳號');
        check(!list.html.includes(PASS) && !/totp_secret|eyJhbGciOi|\$2[aby]\$|scrypt/i.test(list.html),
            '清單不含密碼、雜湊或 token');

        // ---------- ③ 自己的那一列沒有刪除按鈕 ----------
        step = '③ 自己那一列';
        const selfRow = JSON.parse(await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#adminList > div'));
            const row = rows.find((r) => r.textContent.includes(${JSON.stringify(OWNER)}));
            return JSON.stringify({
                hasSelfBadge: !!row && row.textContent.includes('你自己'),
                deleteButtons: row ? row.querySelectorAll('[data-action="delete-admin"]').length : -1,
                peerDeleteButtons: (() => {
                    const p = rows.find((r) => r.textContent.includes(${JSON.stringify(PEER)}));
                    return p ? p.querySelectorAll('[data-action="delete-admin"]').length : -1;
                })()
            });
        `));
        check(selfRow.hasSelfBadge && selfRow.deleteButtons === 0, '自己的那一列標示「你自己」且沒有刪除按鈕');
        check(selfRow.peerDeleteButtons === 0, '不能刪除其他網站擁有者（同級保護）');

        // ---------- ④⑤⑥⑦ 點一次刪除：只送一個請求、只一筆稽核 ----------
        step = '④ 刪除一次';
        const before = await reqCount(browser);
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#adminList > div'))
                .find((r) => r.textContent.includes(${JSON.stringify(VICTIM)}));
            row.querySelector('[data-action="delete-admin"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('adminList').textContent.includes(${JSON.stringify(VICTIM)})`, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 800));   // 等背景的稽核寫入與重繪收斂

        const deletes = await countReqs(browser, 'DELETE', '/api/admin/users', before);
        check(deletes === 1, `點一次刪除只送出一個 DELETE 請求（實際 ${deletes} 個）`);
        const confirms = Number(await browser.evaluate(`return String(window.__CONFIRMS__)`));
        check(confirms === 1, `刪除只跳一次確認對話框（實際 ${confirms} 次）`);
        const okAlerts = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__ALERTS__ || [])`))
            .filter((m) => m.includes('已刪除'));
        check(okAlerts.length === 1, `只出現一次刪除成功提示（實際 ${okAlerts.length} 次）`);
        const failAlerts = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__ALERTS__ || [])`))
            .filter((m) => m.includes('刪除失敗'));
        check(failAlerts.length === 0, '沒有出現刪除失敗提示', failAlerts.join('｜'));

        const audit = (state.tables.audit_logs || []).filter((r) => r.action === 'DELETE_USER');
        check(audit.length === 1, `稽核日誌恰好一筆 DELETE_USER（實際 ${audit.length} 筆）`);
        // details 在真實資料庫是 jsonb（回物件），假的替身存字串——兩種都要能判讀
        const auditDetails = (row) => {
            const d = row && row.details;
            if (!d) return {};
            if (typeof d === 'object') return d;
            try { return JSON.parse(d); } catch (err) { return {}; }
        };
        check(audit.length === 1 && auditDetails(audit[0]).deleted_user === VICTIM,
            '稽核紀錄指名被刪除的帳號', JSON.stringify(audit[0] || {}).slice(0, 140));
        check(!(state.tables.admin_users || []).some((u) => u.username === VICTIM), '資料庫裡確實已刪除');

        // ---------- ⑧ 連點兩次
        // ---------- ⑧ 連點兩次仍只送一個請求 ----------
        step = '⑧ 連點兩次';
        const before2 = await reqCount(browser);
        await browser.evaluate(`
            const btn = Array.from(document.querySelectorAll('#adminList > div'))
                .find((r) => r.textContent.includes(${JSON.stringify(VICTIM2)}))
                .querySelector('[data-action="delete-admin"]');
            btn.click();
            btn.click();   // 立刻再點一次（防連點守衛要擋下來）
            return true;
        `);
        await browser.waitFor(`!document.getElementById('adminList').textContent.includes(${JSON.stringify(VICTIM2)})`, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 800));
        const deletes2 = await countReqs(browser, 'DELETE', '/api/admin/users', before2);
        check(deletes2 === 1, `連點兩次仍然只送出一個請求（實際 ${deletes2} 個）`);
        const audit2 = (state.tables.audit_logs || []).filter((r) => r.action === 'DELETE_USER');
        check(audit2.length === 2, `稽核累計兩筆（兩個帳號各一筆，實際 ${audit2.length} 筆）`);

        // ---------- ⑨ 重開 modal
        // ---------- ⑨ 重開 modal 後「重新整理」只送一個請求 ----------
        step = '⑨ 重整按鈕';
        await browser.evaluate(`
            document.getElementById('adminModal').classList.add('hidden');
            document.getElementById('adminMgmtBtn').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#adminList > div').length >= 3`, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 800));
        const before3 = await reqCount(browser);
        await browser.evaluate(`document.getElementById('refreshAdminListBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 1200));
        const refreshes = await countReqs(browser, 'GET', '/api/admin/users', before3);
        check(refreshes === 1, `重新整理只送一個請求（實際 ${refreshes} 個）`);

        // ---------- ⑩ 一般使用者的權限邊界
        // ---------- ⑩ 一般使用者的權限邊界（介面與 API 都要擋） ----------
        step = '⑩ 權限邊界';
        await browser.evaluate(`localStorage.clear(); return true;`);
        await browser.goto(BASE);
        await browser.evaluate(STUB_AND_COUNT);
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 1000));
        const playerView = JSON.parse(await browser.evaluate(`
            const btn = document.getElementById('adminMgmtBtn');
            return JSON.stringify({ visible: !!btn && !btn.classList.contains('hidden') });
        `));
        check(!playerView.visible, '一般使用者看不到帳號管理入口');
        const apiDenied = await browser.evaluate(`
            const res = await fetch('/api/admin/users', { headers: { Authorization: 'Bearer ' } });
            const del = await fetch('/api/admin/users/5', { method: 'DELETE', headers: { Authorization: 'Bearer ' } });
            return JSON.stringify({ list: res.status, del: del.status });
        `);
        const denied = JSON.parse(apiDenied);
        check([401, 403].includes(denied.list) && [401, 403].includes(denied.del),
            `一般使用者直接打 API 被擋（清單 ${denied.list}／刪除 ${denied.del}）`);
        // ---------- ⑪ 手機尺寸與整潔 ----------
        step = '⑪ 手機尺寸';
        const layout = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                width: document.documentElement.scrollWidth,
                viewport: window.innerWidth
            });
        `));
        check(!layout.overflow, `手機尺寸沒有橫向溢出（${layout.width} ≤ ${layout.viewport}）`);
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        await browser.screenshot(path.join(SHOTS, '01-帳號管理.png'));
        console.log(`\n══════ 帳號管理檢查：${pass} 通過 / ${fail} 失敗 ══════`);
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`\n❌ 檢查腳本執行失敗（步驟：${step}）：${err.message}`);
        console.log(String(err.stack || '').split('\n').slice(1, 4).join('\n'));
        exitCode = 1;
    } finally {
        try { await browser.close(); } catch (err) { /* 忽略 */ }
        server.close();
        stub.close();
    }
    process.exit(exitCode);
})();
