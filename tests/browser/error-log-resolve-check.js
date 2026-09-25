/* v2.17.0：用手機尺寸的真實 Chrome 驗證「巡檢後自動標記已處理」的使用者可見效果
 *
 * 情境：網站上有 3 筆未處理的錯誤日誌（2 筆錯誤級、1 筆警告級）。
 *   1. 登入後首頁提示橫幅應該出現，並顯示「有 2 筆未處理的錯誤日誌」
 *   2. 開啟「錯誤日誌」視窗 → 按「🏷️ 全部標記已處理」（這就是巡檢腳本做的事）
 *   3. 清單應立刻變成全部「✓ 已處理」，未處理數歸零，每個項目仍可查看（沒有被刪除）
 *   4. 關閉視窗後：提示橫幅消失、選單上的數字計數也消失
 *   5. 稽核日誌要留下 RESOLVE_ERROR_LOGS（誰在什麼時候清的）
 *
 * 伺服器：真的 server.js + 假 Supabase（不碰正式資料庫）。
 * 用法：node tests/browser/error-log-resolve-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3301);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-error-resolve-check');
const USER = 'owner-errlog';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true }],
            error_logs: [
                { id: 11, error_type: 'unhandled_server_error', message: '測試用：未預期伺服器錯誤', path: '/api/competitions', severity: 'error', resolved: false, created_at: minutesAgo(30) },
                { id: 12, error_type: 'fetch_registrations_error', message: '測試用：讀取報名失敗', path: '/api/registrations', severity: 'error', resolved: false, created_at: minutesAgo(20) },
                { id: 13, error_type: 'malformed_json_body', message: '測試用：壞 JSON', path: '/api/auth/login', severity: 'warn', resolved: false, created_at: minutesAgo(10) }
            ],
            audit_logs: [],
            competitions: [],
            registrations: [],
            push_log: []
        },
        nextId: { admin_users: 50, error_logs: 500, audit_logs: 900 }
    };
}

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.__CONFIRMS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = (m) => { window.__CONFIRMS__.push(String(m)); return true; };
    return true;
`;

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
    console.log(`\n🧪 錯誤日誌「標記已處理」介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);

        // ---------- 1. 登入：提示橫幅應出現 ----------
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
        await browser.waitFor(`!document.getElementById('errorAlertBanner').classList.contains('hidden')`, { timeout: 10000 });
        const bannerText = await browser.evaluate(`return document.getElementById('errorAlertTitle').textContent;`);
        check(/有 2 筆未處理的錯誤日誌/.test(bannerText), `提示橫幅顯示未處理錯誤數（${bannerText}）`);
        const menuLabel = await browser.evaluate(`return document.getElementById('btn-error-logs').textContent.trim();`);
        check(/錯誤日誌 \(2\)/.test(menuLabel), `選單顯示計數（${menuLabel}）`);
        await browser.screenshot(path.join(SHOTS, '01-提示橫幅.png'));

        // ---------- 2. 開啟錯誤日誌視窗 ----------
        await browser.evaluate(`document.getElementById('btn-error-logs').click(); return true;`);
        await browser.waitFor(`!document.getElementById('errorLogsModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#errorLogList > div').length === 3`, { timeout: 8000 });
        const summaryBefore = await browser.evaluate(`return document.getElementById('errorLogSummary').textContent;`);
        check(/未處理 3 筆/.test(summaryBefore), `視窗摘要顯示未處理 3 筆（${summaryBefore}）`);
        await browser.screenshot(path.join(SHOTS, '02-標記前.png'));

        // ---------- 3. 一鍵全部標記已處理 ----------
        await browser.evaluate(`document.getElementById('errorLogResolveAllBtn').click(); return true;`);
        await browser.waitFor(`/已標記 3 筆為已處理/.test((window.__ALERTS__ || []).join(' '))`, { timeout: 10000 });
        const confirms = await browser.evaluate(`return (window.__CONFIRMS__ || []).join(' ');`);
        check(/這會把所有「未處理」的錯誤日誌標記為已處理/.test(confirms), '按下前有明確確認訊息（不是無聲改資料）');

        await browser.waitFor(`/未處理 0 筆/.test(document.getElementById('errorLogSummary').textContent)`, { timeout: 10000 });
        const resolvedBadges = await browser.evaluate(`
            return Array.from(document.querySelectorAll('#errorLogList span')).filter((s) => /已處理/.test(s.textContent)).length;
        `);
        check(resolvedBadges === 3, `清單中 3 筆都標成「✓ 已處理」（實際 ${resolvedBadges}）`);
        const rowsStillThere = await browser.evaluate(`return document.querySelectorAll('#errorLogList > div').length;`);
        check(rowsStillThere === 3, '標記不等於刪除：紀錄仍然看得到');
        await browser.screenshot(path.join(SHOTS, '03-標記後.png'));

        // ---------- 4. 關閉視窗：橫幅與計數都應消失 ----------
        await browser.evaluate(`document.getElementById('closeErrorModalBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('errorAlertBanner').classList.contains('hidden')`, { timeout: 10000 });
        check(true, '標記完提示橫幅自動消失');
        const menuAfter = await browser.evaluate(`return document.getElementById('btn-error-logs').textContent.trim();`);
        check(!/\(\d+\)/.test(menuAfter), `選單計數消失（${menuAfter}）`);

        // ---------- 5. 稽核與資料狀態 ----------
        const dbRows = state.tables.error_logs;
        check(dbRows.every((l) => l.resolved === true), '資料庫中三筆都已標記為已處理');
        check(dbRows.every((l) => l.resolved_by === USER && l.resolved_at), '記錄了處理者與處理時間');
        const audit = state.tables.audit_logs.filter((l) => l.action === 'RESOLVE_ERROR_LOGS');
        check(audit.length === 1, `稽核日誌留下 1 筆批次標記紀錄（實際 ${audit.length}）`);
        check(/all_unresolved/.test(String(audit[0] && audit[0].details)), '稽核內容看得出來是「全部標記」而非逐筆');

        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 錯誤日誌標記介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err);
    process.exit(1);
});
