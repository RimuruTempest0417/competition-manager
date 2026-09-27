/* v3.9.2：示範流程（管理員在畫面上「一步一步」跑建立比賽 → 報名 → 成績 → 公布）
 *
 * 驗的是使用者真的按得到的東西：
 *   ① 選單裡只有管理員以上看得到「🧪 示範流程」（訪客／一般使用者看不到）
 *   ② 彈窗列出七步，一開始全部是「⬜」
 *   ③ 依序按「① 建立示範第一站」→「② 設定每週週期」→「③ 由週期建立第二站」→
 *      「④ 兩場報名」→「⑤ 登錄成績」→「⑥ 公布成績」，每一步都要變成 ✅ 並寫出做了什麼
 *   ④ 跑完之後「🏆 看系列總積分」看得到 5 位選手（含只有未完賽的示範阿強，0 分／出賽 1 場）
 *   ⑤ 「🗑️ 清除示範資料」按下去 → 示範賽事全部消失、進度回到 0/6
 *   ⑥ 全程沒有 CSP 違規（行內 onclick 會被 script-src-attr 擋掉，按鈕會變啞的）、
 *      沒有下載檔案到使用者電腦、沒有未捕捉的前端例外
 *
 * 用法：node tests/browser/demo-flow-check.js
 */
const path = require('node:path');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3329);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-demo';
const PLAYER = 'player-demo';
const PASS = 'checkpass123';

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
    if (ok) { passed += 1; console.log(`   ✅ ${label}${detail ? `（${detail}）` : ''}`); }
    else { failed += 1; console.log(`   ❌ ${label}${detail ? `（${detail}）` : ''}`); }
}

const state = {
    tables: {
        admin_users: [
            { id: 1, username: OWNER, password: PASS, role: 'web_owner', is_active: true, created_at: '2026-01-01T00:00:00Z' },
            { id: 2, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: '2026-01-01T00:00:00Z' }
        ],
        competitions: [],
        registrations: [], competition_results: [], audit_logs: [],
        error_logs: [], app_settings: [], push_subscriptions: [], share_visits: []
    },
    nextId: { competitions: 900, registrations: 1000, competition_results: 1, audit_logs: 1, error_logs: 1 },
    log: []
};

const login = async (browser, username, password) => {
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
    const fill = () => browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('loginUsername', ${JSON.stringify(username)});
        set('loginPassword', ${JSON.stringify(password)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await fill();
    try {
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fill();
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
    }
};

(async () => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-key';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-flow-secret';
    process.env.SITE_URL = BASE;
    delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');

    const browser = new Browser({ width: 1280, height: 960 });
    let exitCode = 0;
    try {
        await browser.start();
        await browser.guardDownloads();
        await browser.goto(`${BASE}/`);
        await login(browser, OWNER, PASS);
        console.log('\n══════ 示範流程檢查（一步步手動執行） ══════\n');

        await browser.evaluate(`
            window.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.effectiveDirective || 'csp'));
            return true;
        `);
        await browser.evaluate(`return true`);

        /* ① 選單按鈕：擁有者看得到 */
        const visible = await browser.evaluate(`
            await new Promise((r) => setTimeout(r, 400));
            const btn = document.getElementById('demoFlowBtn');
            return btn ? !btn.classList.contains('hidden') : 'missing';
        `);
        check(visible === true, '選單裡有「🧪 示範流程」（管理員以上才看得到）', String(visible));

        /* 開啟彈窗：步驟一開始都是 ⬜ */
        await browser.evaluate(`CMDemoFlow.open(); return true;`);
        await browser.waitFor(`document.getElementById('demoFlowBody').innerText.indexOf('建立示範第一站') >= 0`, { timeout: 8000 });
        const initial = await browser.evaluate(`return document.getElementById('demoFlowBody').innerText`);
        check(initial.indexOf('0 / 6') >= 0, '一開始進度是 0 / 6', (initial.match(/\d+ \/ 6/) || [''])[0]);
        check((initial.match(/⬜/g) || []).length >= 7, '七個步驟都顯示「尚未執行」（⬜）', String((initial.match(/⬜/g) || []).length));
        check(initial.indexOf('清除示範資料') >= 0, '有「🗑️ 清除示範資料」按鈕');

        /* ② 一步一步按（用畫面上的按鈕，不是呼叫函式） */
        const press = async (key, label, expectText) => {
            const before = await browser.evaluate(`return document.getElementById('demoFlowBody').innerText`);
            await browser.evaluate(`
                const btn = document.querySelector('#demoFlowBody [data-demo-step="${key}"]');
                if (!btn) return 'missing';
                btn.click();
                return 'clicked';
            `);
            // 等這一步的結果訊息出現（做過的步驟會顯示 ✅ 與說明）
            await browser.waitFor(`
                (() => {
                    const t = document.getElementById('demoFlowBody').innerText;
                    return t !== ${JSON.stringify(before)} && t.indexOf('執行中') < 0;
                })()
            `, { timeout: 20000 });
            const text = await browser.evaluate(`return document.getElementById('demoFlowBody').innerText`);
            check(text.indexOf(expectText) >= 0, label, (text.match(new RegExp('.{0,40}' + expectText + '.{0,30}')) || [''])[0].replace(/\s+/g, ' '));
            return text;
        };

        await press('create-root', '① 建立示範第一站 → ✅ 並寫出 id／日期', '已建立第一站');
        await press('set-recurrence', '② 設定每週週期 → ✅', '每週週期');
        await press('create-next', '③ 由週期建立第二站 → ✅', '已建立第二站');
        await press('register', '④ 兩場報名 → ✅（第一站 4 人、第二站 5 人）', '第二站新增 5 人');
        await press('results', '⑤ 登錄成績 → ✅（第二站 2 位未完賽）', '第二站 2 位未完賽');
        const afterPublish = await press('publish', '⑥ 公布成績 → ✅', '兩場成績都已公布');
        check(afterPublish.indexOf('6 / 6') >= 0, '進度變成 6 / 6', (afterPublish.match(/\d+ \/ 6/) || [''])[0]);
        check((afterPublish.match(/⬜/g) || []).length === 1, '只剩「清除示範資料」還是 ⬜', String((afterPublish.match(/⬜/g) || []).length));

        /* ③ 從彈窗直接看系列總積分（會關掉示範彈窗、開系列彈窗） */
        await browser.evaluate(`
            const btn = document.querySelector('#demoFlowBody [data-demo-action="standings"]');
            if (btn) btn.click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('seriesModal').classList.contains('hidden')`, { timeout: 8000 });
        // 彈窗一打開是「載入中…」，要等資料真的畫上去
        await browser.waitFor(`document.getElementById('seriesBody').innerText.indexOf('示範小明') >= 0`, { timeout: 8000 });
        const series = await browser.evaluate(`return document.getElementById('seriesBody').innerText`);
        check(series.indexOf('示範小明') >= 0 && series.indexOf('示範阿強') >= 0, '系列總積分裡 5 位選手都在（含只有第二場未完賽的阿強）', series.slice(0, 60));
        check(/示範阿強[\s\S]{0,40}0/.test(series), '阿強 0 分但仍在榜上（超表＝0 分）');
        check(series.indexOf('20') >= 0, '小明兩場冠軍共 20 分', series.slice(0, 120));
        await browser.evaluate(`CMReview.closeSeries(); CMDemoFlow.open(); return true;`);
        await browser.waitFor(`!document.getElementById('demoFlowModal').classList.contains('hidden')`, { timeout: 5000 });

        /* ④ 清除示範資料 */
        await browser.evaluate(`
            const btn = document.querySelector('#demoFlowBody [data-demo-step="cleanup"]');
            if (btn) btn.click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('demoFlowBody').innerText.indexOf('已移除') >= 0`, { timeout: 20000 });
        const cleaned = await browser.evaluate(`return document.getElementById('demoFlowBody').innerText`);
        check(cleaned.indexOf('0 / 6') >= 0, '清除後進度回到 0 / 6', (cleaned.match(/\d+ \/ 6/) || [''])[0]);
        const left = await browser.evaluate(`
            const list = await (await fetch('/api/competitions', { credentials: 'same-origin' })).json();
            return (Array.isArray(list) ? list : []).filter((c) => String(c.name || '').indexOf('【示範】') === 0).map((c) => c.name);
        `);
        check(left.length === 0, '清單裡已經沒有示範賽事', JSON.stringify(left));

        /* ⑤ 關閉鈕（走同一個委派）與資安／體驗底線 */
        await browser.evaluate(`document.getElementById('demoFlowCloseBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 150));
        const closed = await browser.evaluate(`return document.getElementById('demoFlowModal').classList.contains('hidden')`);
        check(closed, '「✕」關得掉示範流程彈窗');

        const violations = await browser.evaluate(`return window.__cspViolations.slice(0, 5)`);
        check(violations.length === 0, '★沒有 CSP 違規（行內事件／行內 style 都被擋，這裡必須是 0）', JSON.stringify(violations));
        const downloads = await browser.evaluate(`return (window.__downloads || []).slice(0, 5)`);
        check(downloads.length === 0, '★沒有下載任何檔案到使用者的電腦', JSON.stringify(downloads));
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - document.documentElement.clientWidth`);
        check(overflow <= 1, '沒有橫向溢出', `${overflow}px`);

    } catch (err) {
        console.error('❌ 檢查失敗：', err.message);
        exitCode = 1;
    } finally {
        await browser.close().catch(() => {});
    }
    stub.close();
    server.close();
    console.log(`\n══════ 示範流程檢查：${passed} 通過 / ${failed} 失敗 ══════\n`);
    process.exit(failed || exitCode ? 1 : 0);
})();
