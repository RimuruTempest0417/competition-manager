/* v3.6.0：使用說明的瀏覽器檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 為什麼要有這一支：使用說明是「給人看的」，單元測試只能驗資料，驗不到
 *   ① 選單裡到底找不找得到、訪客看不看得到（說明只給登入者就沒意義了）
 *   ② 依身分過濾在畫面上是不是真的成立（一般使用者切得到管理員段落＝權限問題）
 *   ③ 搜尋、切換段落、手機版面是不是真的能用
 *   ④ 操作清單能不能打開、有沒有內容
 *
 * 用法：node tests/browser/guide-check.js
 * （不會下載任何檔案、預設不寫截圖）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3298);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-guide-check');
const OWNER = 'checkowner';
const OWNER_PASS = 'checkpass123';
const USER = 'plainuser';
const USER_PASS = 'plainpass123';

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
    return {
        tables: {
            admin_users: [
                { id: 1, username: OWNER, password: OWNER_PASS, role: 'web_owner', is_active: true },
                { id: 2, username: USER, password: USER_PASS, role: 'user', is_active: true }
            ],
            error_logs: [],
            push_log: [],
            audit_logs: [],
            competitions: [],
            registrations: [],
            announcements: []
        },
        nextId: { admin_users: 50, error_logs: 500 }
    };
}

async function login(browser, username, password) {
    await browser.evaluate(`
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
    await browser.waitFor(`localStorage.getItem('competition_user') !== null`, { timeout: 10000 });
    await browser.waitFor(`document.getElementById('loginModal').classList.contains('hidden')`, { timeout: 10000 });
}

/* 用真實互動開說明：先點 ☰ 選單，再點「📖 使用說明」（直接呼叫函式會掩蓋事件綁定問題） */
async function openGuide(browser) {
    return await browser.evaluate(`
        document.getElementById('navMenuBtn')?.click();
        const btn = document.getElementById('guideBtn');
        if (!btn) { return 'no-button'; }
        if (btn.classList.contains('hidden')) { return 'hidden'; }
        btn.click();
        return 'clicked';
    `);
}

const guideState = (browser) => browser.evaluate(`
    const modal = document.getElementById('guideModal');
    if (!modal) { return JSON.stringify({ error: 'no-modal' }); }
    const nav = document.getElementById('guideNav');
    const body = document.getElementById('guideBody');
    return JSON.stringify({
        open: !modal.classList.contains('hidden'),
        navText: nav ? nav.textContent.replace(/\\s+/g, ' ').trim() : '',
        navItems: nav ? nav.querySelectorAll('[data-guide-section]').length : 0,
        activeItems: nav ? nav.querySelectorAll('[data-guide-section].bg-slate-100').length : 0,
        bodyText: body ? body.textContent.replace(/\\s+/g, ' ').trim() : '',
        stepCount: body ? body.querySelectorAll('ol.cm-guide-steps > li').length : 0,
        roleNote: document.getElementById('guideRoleNote') ? document.getElementById('guideRoleNote').textContent : '',
        panelOverflow: (() => { const p = modal.querySelector('.cm-modal-panel'); return p ? p.scrollWidth - p.clientWidth : -1; })(),
        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
        viewport: window.innerWidth
    });
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
    console.log(`\n🧪 使用說明檢查（伺服器 ${BASE}，假 Supabase :${stubPort}）`);

    let exitCode = 0;
    const browser = await Browser.launch({ width: 1440, height: 900 });
    try {
        // ---------- 1. 訪客也要找得到、看得到 ----------
        console.log('\n👤 訪客（未登入）');
        await browser.goto(BASE, { waitMs: 800 });
        await browser.waitFor(`document.getElementById('guideBtn') !== null`);
        check(true, '選單裡有「📖 使用說明」按鈕');

        const opened = await openGuide(browser);
        check(opened === 'clicked', '訪客點得到「📖 使用說明」（未登入也要看得到）', opened);
        await browser.waitFor(`!document.getElementById('guideModal').classList.contains('hidden')`, { timeout: 5000 });

        let g = JSON.parse(await guideState(browser));
        check(g.open, '說明視窗開啟');
        check(/首頁/.test(g.bodyText) || /賽事列表/.test(g.bodyText), '預設顯示第一段（看懂首頁）');
        check(g.stepCount >= 6, `第一段有實際步驟（${g.stepCount} 條）`);
        check(g.activeItems === 1, `目前段落有明顯標示（${g.activeItems} 個作用中）`);

        // 訪客不得看到管理員段落（依身分過濾）
        check(!/建立與編輯賽事/.test(g.navText), '訪客的段落清單沒有「建立與編輯賽事」');
        check(!/管理員操作清單/.test(g.navText), '訪客的段落清單沒有管理員操作清單');
        check(!/備份與還原/.test(g.navText), '訪客的段落清單沒有「備份與還原」');
        check(/看懂首頁|怎麼報名|通知與推播/.test(g.navText), '訪客看得到公開段落（首頁／報名／通知）');
        check(/目前身分/.test(g.roleNote), '視窗標示目前身分', g.roleNote);

        // ---------- 2. 搜尋與切換段落 ----------
        console.log('\n🔍 搜尋與切換');
        await browser.evaluate(`
            const el = document.getElementById('guideSearch');
            el.value = '候補';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 400));
        let searched = JSON.parse(await guideState(browser));
        check(searched.navItems > 0 && searched.navItems < g.navItems, `搜尋「候補」後段落變少（${g.navItems} → ${searched.navItems}）`);
        check(/候補/.test(searched.bodyText), '搜尋結果的內容真的和候補有關');

        await browser.evaluate(`
            const el = document.getElementById('guideSearch');
            el.value = 'zzz這個詞一定不存在';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 400));
        const empty = JSON.parse(await guideState(browser));
        check(/沒有符合的說明|找不到符合的說明/.test(empty.navText + empty.bodyText), '找不到時有明確提示');

        await browser.evaluate(`
            const el = document.getElementById('guideSearch');
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 400));

        // 切換到「通知與推播」
        const switched = await browser.evaluate(`
            const btn = Array.from(document.querySelectorAll('#guideNav [data-guide-section]'))
                .find((b) => /通知與推播/.test(b.textContent));
            if (!btn) { return 'no-item'; }
            btn.click();
            return 'clicked';
        `);
        await new Promise((r) => setTimeout(r, 200));
        const afterSwitch = JSON.parse(await guideState(browser));
        check(switched === 'clicked', '點得到「通知與推播」段落', switched);
        check(/推播訂閱|加入主畫面/.test(afterSwitch.bodyText), '切換後內容確實換成該段落');
        check(/通知與推播/.test(afterSwitch.activeItems === 1 ? afterSwitch.navText : ''), '切換後只有一個段落處於作用中');

        // ---------- 3. 手機版面 ----------
        console.log('\n📱 手機 390×844');
        await browser.setViewport(390, 844);
        await browser.goto(BASE, { waitMs: 800 });
        await openGuide(browser);
        await browser.waitFor(`!document.getElementById('guideModal').classList.contains('hidden')`, { timeout: 5000 });
        const mobile = JSON.parse(await guideState(browser));
        check(mobile.bodyOverflow <= 0, `說明視窗開著時頁面沒有橫向溢出（${mobile.bodyOverflow}px）`);
        check(mobile.panelOverflow <= 0, `面板本身沒有橫向捲動（${mobile.panelOverflow}px）`);
        check(mobile.navItems > 0 && mobile.stepCount > 0, '手機上段落清單與內容都有出現');
        await browser.evaluate(`document.getElementById('closeGuideModalBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 200));
        check(!JSON.parse(await guideState(browser)).open, '關閉按鈕有效');

        // ---------- 4. 一般使用者：仍然看不到管理員段落 ----------
        console.log('\n🙋 一般使用者（user）');
        await browser.setViewport(1440, 900);
        await browser.goto(BASE, { waitMs: 800 });
        await login(browser, USER, USER_PASS);
        await openGuide(browser);
        await browser.waitFor(`!document.getElementById('guideModal').classList.contains('hidden')`, { timeout: 5000 });
        const userState = JSON.parse(await guideState(browser));
        check(!/建立與編輯賽事/.test(userState.navText), '一般使用者看不到管理員段落（不是藏起來，是沒回傳）');
        check(!/管理員操作清單/.test(userState.navText), '一般使用者看不到管理員操作清單');
        check(/我的報名/.test(userState.navText), '一般使用者看得到「我的報名」段落');
        await browser.evaluate(`document.getElementById('closeGuideModalBtn').click(); return true;`);

        // ---------- 5. 最高權限：管理員段落與操作清單 ----------
        console.log('\n👑 最高權限帳號（web_owner）');
        await browser.goto(BASE, { waitMs: 800 });
        await login(browser, OWNER, OWNER_PASS);
        await openGuide(browser);
        await browser.waitFor(`!document.getElementById('guideModal').classList.contains('hidden')`, { timeout: 5000 });
        const adminState = JSON.parse(await guideState(browser));
        check(/建立與編輯賽事/.test(adminState.navText), '管理員看得到「建立與編輯賽事」');
        check(/成績輸入與公布/.test(adminState.navText), '管理員看得到成績相關說明');
        check(/管理員操作清單/.test(adminState.navText), '管理員看得到操作清單');
        check(/看懂首頁|怎麼報名/.test(adminState.navText), '管理員同時保留公開段落（不是只看得到管理員的）');
        check(adminState.navItems > g.navItems, `管理員可見段落比訪客多（${g.navItems} → ${adminState.navItems}）`);

        const checklistClicked = await browser.evaluate(`
            const btn = document.querySelector('#guideNav [data-guide-section="__checklist"]');
            if (!btn) { return 'no-checklist'; }
            btn.click();
            return 'clicked';
        `);
        await new Promise((r) => setTimeout(r, 200));
        const checklist = JSON.parse(await guideState(browser));
        check(checklistClicked === 'clicked', '點得到管理員操作清單', checklistClicked);
        check(checklist.stepCount >= 10, `操作清單有 ${checklist.stepCount} 個步驟`);
        check(/開好賽事/.test(checklist.bodyText), '操作清單第一步是「開好賽事」');
        check(/公布結果|公布成績/.test(checklist.bodyText), '操作清單包含賽後公布成績的步驟');
        // v3.6.5：掃碼報到已上線 → 改驗「有沒有寫出兩種簽到方式（掃碼／手打）」，
        // 而不是像 v3.6.2 那樣驗它不可以提到 QR。
        check(/現場報到/.test(checklist.bodyText) && /簽到/.test(checklist.bodyText), '操作清單的現場報到寫出系統位置與操作方式');
        check(/掃碼|QR/.test(checklist.bodyText), '操作清單要寫出掃碼報到（已經上線的功能）');
        check(/報到碼/.test(checklist.bodyText), '操作清單要寫出沒有掃碼功能時改用手打報到碼');

        // 搜尋時不應該還留著操作清單（避免搜尋結果裡混進不相關的長清單）
        await browser.evaluate(`
            const el = document.getElementById('guideSearch');
            el.value = '成績';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 400));
        const searchAdmin = JSON.parse(await guideState(browser));
        check(!/管理員操作清單/.test(searchAdmin.navText), '搜尋時不顯示操作清單（只留符合的段落）');
        check(searchAdmin.navItems > 0, '管理員搜尋「成績」找得到段落');

        // ---------- 6. 前端例外 ----------
        await browser.evaluate(`document.getElementById('closeGuideModalBtn').click(); return true;`);
        console.log('');
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
