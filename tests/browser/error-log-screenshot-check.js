/* v3.6.1：錯誤日誌截圖與列表瘦身的介面檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 單元測試驗的是資料庫與回應內容，這一支驗的是「使用者真的看到什麼」：
 *   ① 列表的網路回應**實際大小**（用 Resource Timing 的 decodedBodySize 量）——
 *      資料庫裡明明有一筆 400KB 的舊截圖，列表也不該變成數百 KB
 *   ② 只有真的有截圖的那筆才顯示「🖼️ 檢視截圖」按鈕（被丟棄的、沒有的一律不顯示）
 *   ③ 按下去才下載那一筆，而且畫面上真的出現圖片
 *
 * 用法：node tests/browser/error-log-screenshot-check.js
 * （不會下載任何檔案、預設不寫截圖）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3295);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-error-log-shot-check');
const OWNER = 'checkowner';
const PASS = 'checkpass123';

const BIG_SHOT = 'data:image/png;base64,' + 'C'.repeat(400000);   // 舊資料：真的很大

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
            admin_users: [{ id: 1, username: OWNER, password: PASS, role: 'web_owner', is_active: true }],
            error_logs: [
                { id: 1, error_type: 'frontend_error', message: '沒有截圖的錯誤', stack_trace: 'boom', path: '/a', user_agent: 'UA', severity: 'error', resolved: false, created_at: minute(1) },
                { id: 2, error_type: 'frontend_error', message: '有夾帶截圖的錯誤', stack_trace: 'boom\n\n[Screenshot Attached (Base64 Truncated)]: data:image/png', path: '/b', user_agent: 'UA', severity: 'error', resolved: false, created_at: minute(2), screenshot: BIG_SHOT },
                { id: 3, error_type: 'frontend_error', message: '截圖過大被丟棄的錯誤', stack_trace: 'boom\n\n[Screenshot Dropped: 圖片過大（900000 字元，上限 400000）]', path: '/c', user_agent: 'UA', severity: 'warn', resolved: false, created_at: minute(3) }
            ],
            push_subscriptions: [],
            audit_logs: [],
            push_log: [],
            competitions: [],
            registrations: []
        },
        nextId: { error_logs: 500, audit_logs: 900 }
    };
}

async function login(browser) {
    await browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('loginUsername', ${JSON.stringify(OWNER)});
        setValue('loginPassword', ${JSON.stringify(PASS)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await browser.waitFor(`localStorage.getItem('competition_user') !== null`, { timeout: 10000 });
    await browser.waitFor(`document.getElementById('loginModal').classList.contains('hidden')`, { timeout: 10000 });
}

/* 這一頁對 /api/admin/error-logs 的所有請求（刻意不用正規表示式，省得在字串裡跟轉義打架） */
const resourceEntries = (browser) => browser.evaluate(`
    const list = performance.getEntriesByType('resource')
        .filter((e) => e.name.indexOf('/api/admin/error-logs') >= 0)
        .map((e) => ({
            url: e.name.replace(location.origin, ''),
            decoded: Math.round(e.decodedBodySize),
            encoded: Math.round(e.transferSize)
        }));
    return JSON.stringify(list);
`);

async function main() {
    if (process.env.CM_KEEP_SCREENSHOTS === '1') fs.mkdirSync(SHOTS, { recursive: true });
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
    console.log(`\n🧪 錯誤日誌截圖與列表瘦身檢查（伺服器 ${BASE}，假 Supabase :${stubPort}）`);

    let exitCode = 0;
    const browser = await Browser.launch({ width: 1440, height: 900 });
    try {
        await browser.goto(BASE, { waitMs: 800 });
        await login(browser);

        const opened = await browser.evaluate(`
            document.getElementById('navMenuBtn')?.click();
            const btn = document.getElementById('btn-error-logs');
            if (!btn) { return 'no-button'; }
            btn.click();
            return 'clicked';
        `);
        check(opened === 'clicked', '登入後選單裡找得到「錯誤日誌」', opened);
        await browser.waitFor(`!document.getElementById('errorLogsModal').classList.contains('hidden')`, { timeout: 6000 });
        await browser.waitFor(`document.getElementById('errorLogList').textContent.indexOf('有夾帶截圖的錯誤') >= 0`, { timeout: 10000 });
        check(true, '錯誤日誌列表載入完成');

        // ---------- ① 列表回應的實際大小（「瘦身」的關鍵證據）----------
        const entries = JSON.parse(await resourceEntries(browser));
        const listEntry = entries.find((e) => e.url.indexOf('/health') < 0 && e.url.indexOf('/screenshot') < 0);
        console.log('   ℹ️ 這頁的 /api/admin/error-logs 請求：' + JSON.stringify(entries));
        check(Boolean(listEntry), '量得到列表本身的請求（Resource Timing）');
        if (listEntry) {
            console.log(`   ℹ️ 列表回應：解壓後 ${listEntry.decoded} 位元組／傳輸 ${listEntry.encoded} 位元組（資料庫裡有一筆 400KB 截圖）`);
            check(listEntry.decoded > 0 && listEntry.decoded < 100000,
                `列表回應不含截圖本體（${listEntry.decoded} 位元組；若帶了那筆 400KB 截圖會是 40 萬以上）`);
        }

        // ---------- ② 按鈕只出現在真的有截圖的那筆 ----------
        const rows = JSON.parse(await browser.evaluate(`
            const list = Array.from(document.querySelectorAll('#errorLogList > div')).map((row) => {
                const btn = row.querySelector('[data-action="view-log-screenshot"]');
                return {
                    text: row.textContent,
                    hasButton: Boolean(btn),
                    buttonId: btn ? btn.dataset.id : null
                };
            });
            return JSON.stringify(list);
        `));
        check(rows.length === 3, `列表列出 3 筆（實際 ${rows.length}）`);
        const withButton = rows.filter((r) => r.hasButton);
        check(withButton.length === 1, `只有 1 筆顯示「檢視截圖」按鈕（實際 ${withButton.length} 筆）`);
        check(withButton[0] && String(withButton[0].buttonId) === '2',
            '按鈕指向真的有截圖的那一筆（種子資料 id=2）', withButton[0] ? `按鈕 id=${withButton[0].buttonId}` : '(沒有按鈕)');
        check(withButton[0] && withButton[0].text.indexOf('有夾帶截圖的錯誤') >= 0,
            '那一列的內容就是「有夾帶截圖的錯誤」');
        const noShotRow = rows.find((r) => r.text.indexOf('沒有截圖的錯誤') >= 0);
        check(noShotRow && !noShotRow.hasButton, '沒有截圖的那筆不顯示按鈕');
        const droppedRow = rows.find((r) => r.text.indexOf('截圖過大被丟棄的錯誤') >= 0);
        check(droppedRow && !droppedRow.hasButton, '截圖被丟棄的那筆不顯示按鈕（沒有東西可以看）');

        const inlineImgs = await browser.evaluate(`return document.querySelectorAll('#errorLogList img').length;`);
        check(inlineImgs === 0, '列表 DOM 裡沒有直接內嵌的圖片（不再把 base64 render 成 <img>）', `找到 ${inlineImgs} 張`);

        // ---------- ③ 按下才下載，畫面上真的出現圖片 ----------
        const clicked = await browser.evaluate(`
            const btn = document.querySelector('#errorLogList [data-action="view-log-screenshot"]');
            if (!btn) { return 'no-button'; }
            btn.click();
            return 'clicked';
        `);
        check(clicked === 'clicked', '點得到「檢視截圖」', clicked);
        await browser.waitFor(`!document.getElementById('logScreenshotModal').classList.contains('hidden')`, { timeout: 6000 });
        await browser.waitFor(`document.getElementById('logScreenshotImg').getAttribute('src') !== null`, { timeout: 10000 });
        const shot = JSON.parse(await browser.evaluate(`
            const img = document.getElementById('logScreenshotImg');
            const src = img.getAttribute('src') || '';
            const modal = document.getElementById('logScreenshotModal');
            const box = img.getBoundingClientRect();
            return JSON.stringify({
                prefix: src.slice(0, 22),
                length: src.length,
                shown: !img.classList.contains('hidden') && box.width > 0,
                overflow: modal.scrollWidth - modal.clientWidth
            });
        `));
        check(shot.prefix.indexOf('data:image/') === 0, '圖片來源是真正的 data:image', shot.prefix);
        check(shot.length > 400000, `拿到完整截圖（${shot.length} 字元）`);
        check(shot.shown, '圖片實際顯示在畫面上（不是隱藏的）');
        check(shot.overflow <= 0, `截圖視窗沒有橫向捲動（${shot.overflow}px）`);

        const afterClick = JSON.parse(await resourceEntries(browser));
        const shotRequests = afterClick.filter((e) => e.url.indexOf('/screenshot') >= 0).length;
        check(shotRequests === 1, `截圖端點只在按下時被請求一次（實際 ${shotRequests} 次）`);

        await browser.evaluate(`document.getElementById('closeLogScreenshotBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 200));
        check(await browser.evaluate(`return document.getElementById('logScreenshotModal').classList.contains('hidden');`), '關閉按鈕有效');

        // ---------- ④ 手機尺寸與前端例外 ----------
        await browser.setViewport(390, 844);
        await browser.goto(BASE, { waitMs: 800 });
        await login(browser);
        await browser.evaluate(`document.getElementById('btn-error-logs').click(); return true;`);
        await browser.waitFor(`document.getElementById('errorLogList').textContent.indexOf('有夾帶截圖的錯誤') >= 0`, { timeout: 10000 });
        const mobile = JSON.parse(await browser.evaluate(`
            return JSON.stringify({ overflow: document.documentElement.scrollWidth - window.innerWidth });
        `));
        check(mobile.overflow <= 1, `手機上錯誤日誌視窗沒有橫向溢出（${mobile.overflow}px）`);

        check(browser.pageErrors.length === 0, '過程中沒有未捕捉的前端例外', browser.pageErrors.join(' | '));
        const noise = browser.consoleErrors.filter((m) => !/favicon|Failed to load resource|401|403|404/.test(m));
        check(noise.length === 0, '沒有非預期的 console 錯誤', noise.join(' | '));

        console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
        exitCode = failed === 0 ? 0 : 1;
    } catch (err) {
        console.error('❌ 檢查腳本執行失敗：', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }
    process.exit(exitCode);
}

main().catch((err) => {
    console.error('❌ 檢查腳本執行失敗：', err.message);
    process.exit(1);
});
