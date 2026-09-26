/* v3.2.0（P1-7）：用手機尺寸的真實 Chrome 驗證「名單與成績的列印版」
 *
 * 驗的是現場真的會用到的那張紙：
 *   ① 管理員的卡片有「🖨️ 列印名單」；一般使用者沒有這顆按鈕
 *   ② 預覽有賽事名稱、時間、地點、類別、列印時間與摘要句
 *   ③ 預覽列數＝已錄取人數；候補自成一段並標示順位（不會被誤當正取點名）
 *   ④ 取消「包含候補」→ 候補整段消失，摘要句也不再提候補（紙上說的與紙上有的要一致）
 *   ⑤ 勾「包含待審核」→ 出現待審核段
 *   ⑥ 取消「簽到欄」→ 表頭不再有簽到欄
 *   ⑦ 按「列印 / 另存 PDF」→ window.print 恰好被呼叫一次
 *   ⑧ 用 CDP 模擬列印媒介：App 介面（工具列等）真的被隱藏、只留下一張紙（不是只看註解）
 *   ⑨ 真的產生 PDF（Page.printToPDF）：內容是 PDF、大小合理，而且**不寫任何檔案到磁碟**
 *   ⑩ 成績表：已公布可列印（名次表、並列名次照原值），未公布沒有列印按鈕
 *   ⑪ 列印內容不含 email／密碼／雜湊／token（紙本會離開系統，不能夾帶個資）
 *   ⑫ 手機尺寸沒有橫向溢出、沒有前端例外、沒有下載任何檔案
 *
 * 用法：node tests/browser/print-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3324);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-print-check');
const OWNER = 'owner-print';
const PLAYER = 'player-print';
const PASS = 'checkpass123';

const COMP_OPEN = 861;      // 已公布成績
const COMP_DRAFT = 862;     // 未公布成績

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.__PRINT_CALLS__ = 0;
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    window.print = () => { window.__PRINT_CALLS__++; };
    return true;
`;

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
                { id: 1, username: OWNER, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(100), last_login_at: daysAgo(1) },
                { id: 2, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: daysAgo(50), last_login_at: daysAgo(2) }
            ],
            competitions: [
                {
                    id: COMP_OPEN, name: '列印測試賽（已公布）', location: '澳門運動場', date: '2026-12-01', time: '09:00',
                    end_date: null, end_time: null, description: '列印檢查用', is_registration_open: false,
                    category: 'track', tags: [], is_team_event: false, max_registrations: 10,
                    requires_approval: false, waitlist_enabled: true, registration_deadline: null,
                    is_deleted: false, created_at: daysAgo(5), created_by: OWNER, poster_updated_at: null,
                    result_published_at: daysAgo(1), result_published_by: OWNER, result_summary: '計時賽，取最佳成績'
                },
                {
                    id: COMP_DRAFT, name: '列印測試賽（草稿）', location: '氹仔運動場', date: '2026-12-08', time: '14:00',
                    end_date: null, end_time: null, description: '', is_registration_open: true,
                    category: 'ball', tags: [], is_team_event: false, max_registrations: 20,
                    requires_approval: false, waitlist_enabled: false, registration_deadline: null,
                    is_deleted: false, created_at: daysAgo(4), created_by: OWNER, poster_updated_at: null,
                    result_published_at: null, result_published_by: null, result_summary: null
                }
            ],
            registrations: [
                { id: 9001, competition_id: COMP_OPEN, user_id: 11, username: '陳大文', status: 'confirmed', is_deleted: false, created_at: daysAgo(3), note: '' },
                { id: 9002, competition_id: COMP_OPEN, user_id: 12, username: '林小明', status: 'confirmed', is_deleted: false, created_at: daysAgo(3), note: '需要輪椅通道' },
                { id: 9003, competition_id: COMP_OPEN, user_id: 13, username: '李大同', status: 'waitlisted', is_deleted: false, created_at: daysAgo(2), waitlist_order: 1, note: '' },
                { id: 9004, competition_id: COMP_OPEN, user_id: 14, username: '黃小美', status: 'waitlisted', is_deleted: false, created_at: daysAgo(2), waitlist_order: 2, note: '' },
                { id: 9005, competition_id: COMP_OPEN, user_id: 15, username: '吳小強', status: 'pending', is_deleted: false, created_at: daysAgo(1), note: '' },
                { id: 9006, competition_id: COMP_OPEN, user_id: 16, username: '周小華', status: 'rejected', is_deleted: false, created_at: daysAgo(1), note: '' }
            ],
            competition_results: [
                { id: 1, competition_id: COMP_OPEN, registration_id: 9001, user_id: 11, username: '陳大文', display_name: '陳大文', status: 'finished', score_text: '12:30', rank: 1, note: '', recorded_by: OWNER, created_at: daysAgo(1), updated_at: daysAgo(1) },
                { id: 2, competition_id: COMP_OPEN, registration_id: 9002, user_id: 12, username: '林小明', display_name: '林小明', status: 'finished', score_text: '12:30', rank: 1, note: '並列', recorded_by: OWNER, created_at: daysAgo(1), updated_at: daysAgo(1) },
                { id: 3, competition_id: COMP_OPEN, registration_id: 9003, user_id: 13, username: '李大同', display_name: '李大同', status: 'finished', score_text: '13:10', rank: 3, note: '', recorded_by: OWNER, created_at: daysAgo(1), updated_at: daysAgo(1) },
                { id: 4, competition_id: COMP_OPEN, registration_id: 9005, user_id: 15, username: '吳小強', display_name: '吳小強', status: 'dns', score_text: '', rank: null, note: '未到場', recorded_by: OWNER, created_at: daysAgo(1), updated_at: daysAgo(1) }
            ],
            competition_posters: [],
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
    console.log(`\n🧪 列印版檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    let step = '啟動';
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, OWNER, PASS);
        await browser.waitFor(`document.getElementById('compList') !== null || document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        // ---------- ① 列印名單按鈕（管理員） ----------
        step = '① 列印名單按鈕';
        await browser.waitFor(`document.querySelector('[data-comp-id="${COMP_OPEN}"]') !== null`, { timeout: 15000 });
        const buttons = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="${COMP_OPEN}"]');
            const draft = document.querySelector('[data-comp-id="${COMP_DRAFT}"]');
            return JSON.stringify({
                roster: !!card.querySelector('[data-action="print-roster"]'),
                results: !!card.querySelector('[data-action="print-results"]'),
                draftResults: !!draft.querySelector('[data-action="print-results"]'),
                rosterColor: (() => {
                    const b = card.querySelector('[data-action="print-roster"]');
                    return b ? getComputedStyle(b).backgroundColor : null;
                })()
            });
        `));
        check(buttons.roster, '管理員的賽事卡片有「🖨️ 列印名單」');
        check(buttons.results, '已公布的賽事有「🖨️ 列印成績」');
        check(!buttons.draftResults, '未公布成績的賽事沒有列印成績按鈕');
        check(buttons.rosterColor && buttons.rosterColor !== 'rgba(0, 0, 0, 0)', `列印按鈕看得見（底色 ${buttons.rosterColor}）`);

        // ---------- ② 預覽內容 ----------
        step = '② 預覽內容';
        await browser.evaluate(`document.querySelector('[data-comp-id="${COMP_OPEN}"] [data-action="print-roster"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('printSheet') !== null`, { timeout: 15000 });
        const preview = JSON.parse(await browser.evaluate(`
            const sheet = document.getElementById('printSheet');
            return JSON.stringify({
                text: sheet.textContent,
                modalVisible: !document.getElementById('printModal').classList.contains('hidden'),
                headers: Array.from(sheet.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
                groups: Array.from(sheet.querySelectorAll('.print-group h3')).map((h) => h.textContent.trim()),
                rows: sheet.querySelectorAll('tbody tr').length,
                landscape: sheet.classList.contains('landscape')
            });
        `));
        check(preview.modalVisible && /列印測試賽（已公布）/.test(preview.text), '預覽開啟並顯示賽事名稱');
        check(/時間：2026-12-01 09:00/.test(preview.text) && /地點：澳門運動場/.test(preview.text) && /類別：田徑/.test(preview.text),
            '賽事資訊（時間／地點／類別）都在紙上');
        check(/列印時間：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(preview.text), '紙上有列印時間');
        check(/共 4 人．正取 2 人．候補 2 人/.test(preview.text), `摘要句正確（${(preview.text.match(/共 [^．]*．正取[^．]*．候補[^．]*/) || [''])[0]}）`);
        check(preview.rows === 4, `預覽列數＝正取 2＋候補 2（實際 ${preview.rows}）`);
        check(preview.headers.includes('簽到'), '預設有簽到欄');
        check(preview.groups.some((g) => g.includes('候補名單')), '候補自成一段');
        check(/候補 1/.test(preview.text) && /候補 2/.test(preview.text), '候補標示順位（不會被誤當正取）');
        check(!/周小華/.test(preview.text), '未錄取的人不會印出來');

        // ---------- ③ 取消包含候補 ----------
        step = '③ 取消包含候補';
        await browser.evaluate(`
            const cb = document.getElementById('printIncludeWaitlist');
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        const noWait = JSON.parse(await browser.evaluate(`
            const sheet = document.getElementById('printSheet');
            return JSON.stringify({ text: sheet.textContent, rows: sheet.querySelectorAll('tbody tr').length, groups: sheet.querySelectorAll('.print-group').length });
        `));
        check(noWait.rows === 2 && noWait.groups === 1, `取消候補後只剩正取 2 列（實際 ${noWait.rows} 列／${noWait.groups} 段）`);
        check(!/候補/.test(noWait.text), '紙上不再出現「候補」字樣');

        // ---------- ④ 勾包含待審核與簽到欄 ----------
        step = '④ 待審核與簽到欄';
        await browser.evaluate(`
            const w = document.getElementById('printIncludeWaitlist'); w.checked = true; w.dispatchEvent(new Event('change', { bubbles: true }));
            const p = document.getElementById('printIncludePending'); p.checked = true; p.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        const withPending = JSON.parse(await browser.evaluate(`
            const sheet = document.getElementById('printSheet');
            return JSON.stringify({ text: sheet.textContent, groups: Array.from(sheet.querySelectorAll('.print-group h3')).map((h) => h.textContent.trim()) });
        `));
        check(withPending.groups.some((g) => g.includes('待審核')) && /吳小強/.test(withPending.text), '勾選後出現待審核段');
        await browser.evaluate(`
            const s = document.getElementById('printSignColumn'); s.checked = false; s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        const noSign = JSON.parse(await browser.evaluate(`
            return JSON.stringify({ headers: Array.from(document.querySelectorAll('#printSheet thead th')).map((th) => th.textContent.trim()) });
        `));
        check(!noSign.headers.includes('簽到'), '取消簽到欄後表頭沒有簽到');

        // ---------- ⑤ 列印（window.print） ----------
        step = '⑤ 列印';
        const beforePrint = JSON.parse(await browser.evaluate(`return JSON.stringify({ calls: window.__PRINT_CALLS__ })`));
        await browser.evaluate(`document.getElementById('printDoBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 300));
        const afterPrint = JSON.parse(await browser.evaluate(`return JSON.stringify({ calls: window.__PRINT_CALLS__ })`));
        check(afterPrint.calls - beforePrint.calls === 1, `按列印只呼叫一次瀏覽器列印（實際 ${afterPrint.calls - beforePrint.calls} 次）`);

        // ---------- ⑥ 用 CDP 模擬列印媒介：介面真的被隱藏 ----------
        step = '⑥ 列印媒介';
        await browser.send('Emulation.setEmulatedMedia', { media: 'print' });
        const printCss = JSON.parse(await browser.evaluate(`
            const tools = document.getElementById('printPreviewTools');
            const header = document.getElementById('printPreviewHeader');
            const sheet = document.getElementById('printSheet');
            const compList = document.getElementById('compList');
            const sheetBox = sheet.getBoundingClientRect();
            return JSON.stringify({
                tools: getComputedStyle(tools).display,
                header: getComputedStyle(header).display,
                sheetDisplay: getComputedStyle(sheet).display,
                sheetWidth: Math.round(sheetBox.width),
                appHidden: !compList || getComputedStyle(compList).display === 'none' || compList.getBoundingClientRect().height === 0
            });
        `));
        check(printCss.tools === 'none' && printCss.header === 'none', '列印時工具列與標題列被隱藏（看不到 UI 殘骸）');
        check(printCss.sheetDisplay !== 'none' && printCss.sheetWidth > 0, `列印時紙張仍可見（寬 ${printCss.sheetWidth}px）`);
        check(printCss.appHidden, '列印時 App 主體（賽事列表）被隱藏');

        // ---------- ⑦ 真的產生 PDF（不落地） ----------
        step = '⑦ 產生 PDF';
        const pdf = await browser.send('Page.printToPDF', {
            printBackground: true,
            paperWidth: 8.27, paperHeight: 11.69,   // A4（吋）
            marginTop: 0.47, marginBottom: 0.47, marginLeft: 0.47, marginRight: 0.47
        });
        const pdfBase64 = (pdf && pdf.data) || '';
        const pdfHead = Buffer.from(pdfBase64.slice(0, 12), 'base64').toString('latin1');
        check(pdfBase64.length > 2000 && pdfHead.startsWith('%PDF-'), `產生的是真正的 PDF（${Math.round(pdfBase64.length * 0.75 / 1024)} KB，開頭 ${pdfHead.slice(0, 5)}）`);
        await browser.send('Emulation.setEmulatedMedia', { media: '' });

        // 收尾：關掉預覽
        await browser.evaluate(`document.getElementById('printModalClose').click(); return true;`);

        // ---------- ⑧ 成績表列印 ----------
        step = '⑧ 成績表列印';
        await browser.evaluate(`document.querySelector('[data-comp-id="${COMP_OPEN}"] [data-action="print-results"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('printSheet') !== null && /成績表/.test(document.getElementById('printSheet').textContent)`, { timeout: 15000 });
        const resultSheet = JSON.parse(await browser.evaluate(`
            const sheet = document.getElementById('printSheet');
            return JSON.stringify({
                text: sheet.textContent,
                headers: Array.from(sheet.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
                ranks: Array.from(sheet.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent.trim()),
                waitlistOptionHidden: document.getElementById('printIncludeWaitlistLabel').classList.contains('hidden')
            });
        `));
        check(resultSheet.headers.includes('名次') && resultSheet.headers.includes('成績'), '成績表有名次與成績欄');
        check(JSON.stringify(resultSheet.ranks) === JSON.stringify(['1', '1', '3', '—']),
            `名次照原值印（並列 1,1,3、未到場 —）— 實際 ${JSON.stringify(resultSheet.ranks)}`);
        check(/未完賽|未出賽/.test(resultSheet.text) && /13:10/.test(resultSheet.text), '成績與狀態都在紙上');
        check(resultSheet.waitlistOptionHidden, '成績表不會出現「包含候補」選項（那是名單才有的）');
        await browser.evaluate(`document.getElementById('printModalClose').click(); return true;`);

        // ---------- ⑨ 一般使用者：看得到成績列印，沒有名單列印 ----------
        step = '⑨ 一般使用者';
        await browser.evaluate(`localStorage.clear(); return true;`);
        await browser.goto(BASE);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`document.querySelector('[data-comp-id="${COMP_OPEN}"]') !== null`, { timeout: 15000 });
        const playerBtns = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="${COMP_OPEN}"]');
            return JSON.stringify({
                roster: !!card.querySelector('[data-action="print-roster"]'),
                results: !!card.querySelector('[data-action="print-results"]')
            });
        `));
        check(!playerBtns.roster, '一般使用者沒有「列印名單」（名單含未審核資訊）');
        check(playerBtns.results, '一般使用者可以列印已公布的成績表');
        await browser.evaluate(`document.querySelector('[data-comp-id="${COMP_OPEN}"] [data-action="print-results"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('printSheet') !== null`, { timeout: 15000 });
        const playerSheet = JSON.parse(await browser.evaluate(`
            const sheet = document.getElementById('printSheet');
            return JSON.stringify({ text: sheet.textContent, html: sheet.innerHTML });
        `));
        check(!/checkpass123|totp_secret|eyJhbGciOi|\$2[aby]\$/.test(playerSheet.html),
            '列印內容不含密碼、雜湊或 token');
        check(!/@/.test(playerSheet.text), '列印內容不含任何 email');
        await browser.evaluate(`document.getElementById('printModalClose').click(); return true;`);

        // ---------- ⑩ 手機尺寸與整潔 ----------
        step = '⑩ 手機尺寸';
        const layout = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                width: document.documentElement.scrollWidth,
                viewport: window.innerWidth
            });
        `));
        check(!layout.overflow, `手機尺寸沒有橫向溢出（${layout.width} ≤ ${layout.viewport}）`);
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        await browser.screenshot(path.join(SHOTS, '01-列印預覽.png'));
        console.log(`\n══════ 列印版檢查：${pass} 通過 / ${fail} 失敗 ══════`);
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
