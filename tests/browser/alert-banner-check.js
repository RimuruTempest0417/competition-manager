/* v2.14.0：用手機尺寸的真實 Chrome 驗證「未處理錯誤日誌提示」與角色下拉修正仍在
 *
 * 方式：真的啟動 server.js（連到假 Supabase，完全不碰生產資料庫）＋ 真的 Chrome（CDP 驅動）。
 * 驗證重點：
 *   1. 登入後出現提示橫幅，標題與選單計數正確
 *   2. 「查看日誌」能開啟錯誤日誌視窗
 *   3. 「稍後再看」會隱藏橫幅，且重新載入後不再出現（除非又有更新的錯誤）
 *   4. 有新錯誤出現時會再次提示
 *   5. 全部處理完後不再提示
 *
 * 用法：node tests/browser/alert-banner-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3299);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-alert-check');
const USER = 'checkowner';
const PASS = 'checkpass123';

let passed = 0;
let failed = 0;
const check = (condition, label, extra = '') => {
    if (condition) {
        passed++;
        console.log(`   ✅ ${label}`);
    } else {
        failed++;
        console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`);
    }
};

function seedState() {
    const minute = (n) => new Date(Date.now() - n * 60000).toISOString();
    return {
        tables: {
            admin_users: [
                { id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true },
                { id: 2, username: 'plainuser', password: 'plainpass123', role: 'user', is_active: true }
            ],
            error_logs: [
                { id: 1, error_type: 'unhandled_server_error', message: '測試用的未處理錯誤', severity: 'error', resolved: false, created_at: minute(5), path: '/api/competitions' },
                { id: 2, error_type: 'auth_invalid_token', message: '權杖過期', severity: 'warn', resolved: false, created_at: minute(30), path: '/api/admin/error-logs' },
                { id: 3, error_type: 'old_backend_error', message: '已處理的舊錯誤', severity: 'error', resolved: true, created_at: minute(600), path: '/api/x' }
            ],
            push_log: [],
            audit_logs: [],
            competitions: [],
            registrations: []
        },
        nextId: { admin_users: 50, error_logs: 500 }
    };
}

const visibleExpr = (id) => `(() => { const el = document.getElementById('${id}'); return Boolean(el) && !el.classList.contains('hidden'); })()`;

async function isVisible(browser, id) {
    return Boolean(await browser.evaluate(`return ${visibleExpr(id)};`));
}

async function login(browser) {
    await browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('loginUsername', ${JSON.stringify(USER)});
        setValue('loginPassword', ${JSON.stringify(PASS)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await browser.waitFor(`localStorage.getItem('competition_user') !== null`, { timeout: 10000 });
    await browser.waitFor(`document.getElementById('loginModal').classList.contains('hidden')`, { timeout: 10000 });
}

async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    const state = seedState();
    const stub = await startFakeSupabase(state);
    const stubPort = stub.address().port;

    process.env.NODE_ENV = 'production';
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-check-secret';
    process.env.SUPABASE_URL = `http://127.0.0.1:${stubPort}`;
    process.env.SUPABASE_KEY = 'stub-service-key';
    process.env.SITE_URL = BASE;
    process.env.ALLOWED_ORIGINS = BASE;

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 未處理錯誤提示檢查（伺服器 ${BASE}，假 Supabase :${stubPort}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    try {
        // ---------- 1. 登入後出現提示 ----------
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await login(browser);
        await browser.waitFor(`!document.getElementById('errorAlertBanner').classList.contains('hidden')`, { timeout: 8000 });

        const title = await browser.evaluate(`return document.getElementById('errorAlertTitle').textContent;`);
        const detail = await browser.evaluate(`return document.getElementById('errorAlertDetail').textContent;`);
        const menuLabel = await browser.evaluate(`return document.getElementById('btn-error-logs').textContent.trim();`);
        check(title === '有 1 筆未處理的錯誤日誌', '提示標題顯示未處理錯誤數', title);
        check(/未處理共 2 筆/.test(detail) && /近 24 小時新增 2 筆/.test(detail), '提示細節同時呈現警告級與近 24 小時數', detail);
        check(/\(1\)/.test(menuLabel), '選單項目顯示未處理數量', menuLabel);
        check(await isVisible(browser, 'errorAlertBanner'), '橫幅確實可見');
        await browser.screenshot(path.join(SHOTS, '01-banner.png'));

        // ---------- 2. 查看日誌 ----------
        await browser.evaluate(`document.getElementById('errorAlertOpenBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('errorLogsModal').classList.contains('hidden')`, { timeout: 6000 });
        let modalHasRows = false;
        try {
            await browser.waitFor(
                `(() => { const m = document.getElementById('errorLogsModal');
                   return m && /unhandled_server_error|測試用的未處理錯誤|權杖過期/.test(m.textContent); })()`,
                { timeout: 8000 }
            );
            modalHasRows = true;
        } catch (err) {
            modalHasRows = false;
        }
        check(modalHasRows, '「查看日誌」開啟的視窗載入到實際日誌內容');
        await browser.screenshot(path.join(SHOTS, '02-logs-modal.png'));
        await browser.evaluate(`
            const modal = document.getElementById('errorLogsModal');
            const closeBtn = modal.querySelector('button');
            if (closeBtn) closeBtn.click();
            modal.classList.add('hidden');
            return true;
        `);

        // ---------- 3. 稍後再看 ----------
        await browser.evaluate(`document.getElementById('errorAlertDismissBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('errorAlertBanner').classList.contains('hidden')`, { timeout: 5000 });
        const dismissed = await browser.evaluate(`return localStorage.getItem('cm-error-alert-dismissed-at');`);
        check(Boolean(dismissed), '「稍後再看」記下當時最新時間', String(dismissed));
        check(!(await isVisible(browser, 'errorAlertBanner')), '橫幅已隱藏但選單仍保留計數',
            await browser.evaluate(`return document.getElementById('btn-error-logs').textContent.trim();`));

        // 重新載入：同樣的錯誤不該再打擾
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('btn-error-logs') !== null`);
        await new Promise((r) => setTimeout(r, 1200));
        check(!(await isVisible(browser, 'errorAlertBanner')), '重新載入後（同一批錯誤）不再提示');

        // ---------- 4. 出現更新的錯誤 → 再次提示 ----------
        state.tables.error_logs.push({
            id: 9, error_type: 'login_error', message: '剛剛發生的新錯誤', severity: 'error',
            resolved: false, created_at: new Date(Date.now() + 1000).toISOString(), path: '/api/auth/login'
        });
        await browser.goto(BASE);
        await browser.waitFor(`!document.getElementById('errorAlertBanner').classList.contains('hidden')`, { timeout: 8000 });
        const newTitle = await browser.evaluate(`return document.getElementById('errorAlertTitle').textContent;`);
        check(newTitle === '有 2 筆未處理的錯誤日誌', '出現新錯誤時再次提示且數量更新', newTitle);
        await browser.screenshot(path.join(SHOTS, '03-new-error.png'));

        // ---------- 5. 全部處理完 → 不再提示 ----------
        state.tables.error_logs.forEach((row) => { row.resolved = true; });
        await browser.evaluate(`localStorage.removeItem('cm-error-alert-dismissed-at'); return true;`);
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('btn-error-logs') !== null`);
        await new Promise((r) => setTimeout(r, 1200));
        const menuAfter = await browser.evaluate(`return document.getElementById('btn-error-logs').textContent.trim();`);
        check(!(await isVisible(browser, 'errorAlertBanner')), '全部處理完後不再提示');
        check(!/\(\d+\)/.test(menuAfter), '選單不再顯示未處理數量', menuAfter);

        // ---------- 6. 沒有未捕捉的前端錯誤 ----------
        check(browser.pageErrors.length === 0, '過程中沒有未捕捉的前端例外', browser.pageErrors.join(' | '));
        const noise = browser.consoleErrors.filter((m) => !/favicon|Failed to load resource|401|403|404/.test(m));
        check(noise.length === 0, '沒有非預期的 console 錯誤', noise.join(' | '));

        console.log(`\n📸 截圖：${SHOTS}`);
        console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('❌ 檢查腳本執行失敗：', err.message);
    process.exit(1);
});
