/* v2.16.0：用手機尺寸的真實 Chrome 驗證「稽核日誌」強化後的操作介面
 *
 * 涵蓋：開啟日誌 → 分頁（較新／較舊）→ 動作下拉（中文標籤）→ 關鍵字查詢 → 時間區間
 *      → 清除條件 → 匯出 CSV（實際攔下 Blob 檢查內容）→ 保留天數清理（先預覽再刪除）
 *      → 過程中不得出現任何前端例外
 *
 * 伺服器：真的 server.js + 假 Supabase（不碰正式資料庫）。
 * 用法：node tests/browser/audit-log-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3299);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-audit-check');
const USER = 'owner-audit';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function seedState() {
    const logs = [];
    // 150 筆（120 筆屬於 coach、30 筆屬於 rimuru），每筆相隔 20 分鐘
    for (let i = 0; i < 150; i += 1) {
        logs.push({
            id: i + 1,
            user_id: i < 120 ? 'coach' : 'rimuru',
            action: i % 2 === 0 ? 'LOGIN_SUCCESS' : 'CREATE_COMPETITION',
            target_id: String(2000 + i),
            details: JSON.stringify({ note: `第 ${i} 筆` }),
            user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            created_at: new Date(Date.now() - i * 20 * 60000).toISOString()
        });
    }
    // 一筆很舊的（400 天前）＋ 一筆帶公式開頭的詳情（驗證 CSV 消歧）
    logs.push({ id: 9001, user_id: 'rimuru', action: 'LOGIN_SUCCESS', target_id: null, details: JSON.stringify({ note: '很舊' }), user_agent: '', created_at: daysAgo(400) });
    logs.push({ id: 9002, user_id: 'rimuru', action: 'SOME_NEW_ACTION', target_id: null, details: '=cmd|calc!A1', user_agent: '', created_at: daysAgo(1) });

    return {
        tables: {
            admin_users: [{ id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true }],
            audit_logs: logs,
            error_logs: [],
            competitions: [],
            registrations: [],
            push_log: []
        },
        nextId: { admin_users: 50, error_logs: 500 }
    };
}

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    window.__blob = null;
    window.__csvText = null;
    URL.createObjectURL = (blob) => { window.__blob = blob; blob.text().then((t) => { window.__csvText = t; }); return 'blob:stub'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {};
    return true;
`;

const readSummary = `return document.getElementById('auditLogSummary').textContent;`;
const listActions = `return Array.from(document.querySelectorAll('#auditLogList span.font-mono')).map((s) => s.textContent.trim());`;
const listText = `return document.getElementById('auditLogList').textContent;`;
const btnState = `return {
    prev: document.getElementById('auditPrevBtn').disabled,
    next: document.getElementById('auditNextBtn').disabled,
    info: document.getElementById('auditPageInfo').textContent
};`;

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
    console.log(`\n🧪 稽核日誌介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);

        // ---------- 1. 登入並開啟日誌 ----------
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
        check(true, '以 web_owner 登入成功');

        await browser.evaluate(`document.getElementById('auditLogBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('auditLogModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#auditLogList > div').length > 0`, { timeout: 8000 });
        const rows = await browser.evaluate(`return document.querySelectorAll('#auditLogList > div').length;`);
        check(rows === 100, `第一頁載入 100 筆（實際 ${rows}）`);
        await browser.screenshot(path.join(SHOTS, '01-日誌列表.png'));

        // ---------- 2. 分頁 ----------
        const summary1 = await browser.evaluate(readSummary);
        // 正式站（PostgREST 有回 count）會顯示精確總數；測試替身拿不到 count 時要老實說「可能還有更多」
        check(/顯示第 1–100 筆/.test(summary1) && /(共 \d+ 筆|可能還有更多)/.test(summary1), `摘要顯示範圍與總數（${summary1}）`);
        const s1 = await browser.evaluate(btnState);
        check(s1.prev === true && s1.next === false, '第一頁：較新停用、較舊可用');

        await browser.evaluate(`document.getElementById('auditNextBtn').click(); return true;`);
        await browser.waitFor(`/第 101–/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        const s2 = await browser.evaluate(btnState);
        check(s2.prev === false && s2.next === true, '第二頁：較新可用、較舊停用（已是舊資料）');
        await browser.evaluate(`document.getElementById('auditPrevBtn').click(); return true;`);
        await browser.waitFor(`/顯示第 1–100 筆/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        check(true, '可按「較新」回到第一頁');

        // ---------- 3. 動作下拉與篩選 ----------
        const options = await browser.evaluate(`
            return Array.from(document.getElementById('auditActionSelect').options).map((o) => o.textContent);
        `);
        check(options.some((o) => o.includes('登入成功（LOGIN_SUCCESS）')), '動作下拉顯示中文標籤');
        check(options.some((o) => o.includes('SOME_NEW_ACTION')), '未知動作也會出現在下拉（不必改程式）');

        await browser.evaluate(`
            const sel = document.getElementById('auditActionSelect');
            sel.value = 'CREATE_COMPETITION';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`/條件：動作 CREATE_COMPETITION/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        const actions = await browser.evaluate(listActions);
        check(actions.length > 0 && actions.every((a) => a === 'CREATE_COMPETITION'), `動作篩選生效（${actions.length} 筆全部符合）`);

        // 關鍵字（使用者名稱）
        await browser.evaluate(`
            const sel = document.getElementById('auditActionSelect');
            sel.value = '';
            document.getElementById('auditSearchInput').value = 'coach';
            document.getElementById('auditSearchBtn').click();
            return true;
        `);
        await browser.waitFor(`/關鍵字「coach」/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        const text = await browser.evaluate(listText);
        check(/使用者: coach/.test(text) && !/使用者: rimuru/.test(text), '關鍵字查詢只留下符合的紀錄');
        await browser.screenshot(path.join(SHOTS, '02-篩選結果.png'));

        // 清除條件
        await browser.evaluate(`document.getElementById('auditClearBtn').click(); return true;`);
        await browser.waitFor(`/顯示第 1–100 筆/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        check(true, '「清除條件」回到完整列表');

        // ---------- 4. 匯出 CSV ----------
        await browser.evaluate(`document.getElementById('auditExportBtn').click(); return true;`);
        await browser.waitFor(`window.__csvText !== null`, { timeout: 10000 });
        const csvText = await browser.evaluate(`return window.__csvText;`);
        const csvLines = csvText.split('\n').filter((l) => l.trim());
        // CSV 產生時「匯出」這筆稽核還沒寫入（+1），而匯出這個動作本身之後才補進資料表（-1）→ 兩者相抵
        const expectedRows = state.tables.audit_logs.length;
        check(/時間,使用者,動作,動作說明,目標,詳情,來源 IP／裝置/.test(csvText), 'CSV 表頭正確（含中文動作說明欄）');
        check(csvLines.length === expectedRows, `CSV 匯出全部紀錄＋表頭（實際 ${csvLines.length} 行，預期 ${expectedRows}）`);
        check(/第 149 筆/.test(csvText) && /很舊/.test(csvText), 'CSV 內容包含最早的紀錄（不只看第一頁）');
        check(csvText.includes("'=cmd|calc!A1"), '公式開頭的詳情已消歧（前置單引號）');
        check(state.tables.audit_logs.some((l) => l.action === 'EXPORT_AUDIT_LOGS'), '匯出動作有留稽核紀錄');

        // ---------- 5. 保留天數清理 ----------
        await browser.evaluate(`document.getElementById('auditCleanupBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('auditCleanupPanel').classList.contains('hidden')`, { timeout: 8000 });
        await browser.evaluate(`
            document.getElementById('auditRetentionDays').value = '30';
            document.getElementById('auditCleanupPreviewBtn').click();
            return true;
        `);
        await browser.waitFor(`/將刪除 \\d+ 筆/.test(document.getElementById('auditCleanupResult').textContent)`, { timeout: 8000 });
        const preview = await browser.evaluate(`return document.getElementById('auditCleanupResult').textContent;`);
        check(/將刪除 1 筆/.test(preview), `預覽顯示將刪除的筆數（${preview}）`);
        check(state.tables.audit_logs.some((l) => l.id === 9001), '只預覽、還沒真的刪');
        await browser.screenshot(path.join(SHOTS, '03-清理預覽.png'));

        await browser.evaluate(`document.getElementById('auditCleanupRunBtn').click(); return true;`);
        await browser.waitFor(`/已刪除 1 筆/.test(document.getElementById('auditCleanupResult').textContent)`, { timeout: 8000 });
        check(!state.tables.audit_logs.some((l) => l.id === 9001), '確認後真的刪除超過保留期的紀錄');
        check(state.tables.audit_logs.some((l) => l.id === 9002), '保留期內的紀錄沒有被誤刪');
        await browser.waitFor(`/共 152 筆|共 151 筆|可能還有更多/.test(document.getElementById('auditLogSummary').textContent)`, { timeout: 8000 });
        check(true, '刪除後自動重新載入列表');

        // ---------- 6. 前端例外 ----------
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 稽核日誌介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err);
    process.exit(1);
});
