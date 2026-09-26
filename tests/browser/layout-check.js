/* v3.2.1：版面空間檢查（桌機／平板／手機四種尺寸，真實 Chrome）
 *
 * 起因：桌機的賽事卡片把資訊一行一行直排，右邊整片空著；而且卡片右側的按鈕區
 * 用 max-content 寬度把左邊的內容欄擠成 84px 寬（1200px 的卡片只用得到 84px），
 * 主容器又固定 1280px，1920 螢幕會白白空掉 640px。
 *
 * 這支檢查把「用滿寬度」變成可量測的數字，避免以後又改回去：
 *   ① 四種尺寸都沒有橫向溢出
 *   ② 卡片內容欄至少佔卡片一半寬度（不再被按鈕擠扁）
 *   ③ 資訊欄的格數：手機 ≥2 欄、桌機 ≥3 欄、大桌機 ≥4 欄（不留大片空白）
 *   ④ 資訊欄沒有文字溢出（不是靠切字來塞滿）
 *   ⑤ 卡片高度合理（桌機 ≤320px，改回直排馬上就會爆）
 *   ⑥ 卡片上所有按鈕都看得到、按得到
 *   ⑦ 大螢幕（≥1600）主容器要超過 1280px（真的用滿寬度）
 *   ⑧ 頁首、提示列、主內容同一容器寬度（左右對齊）
 *   ⑨ 沒有前端例外
 *
 * 用法：node tests/browser/layout-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3325);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-layout-check');
const ADMIN = 'owner-layout';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const comp = (id, name, extra) => Object.assign({
    id, name, location: '澳門運動場', date: '2026-12-01', time: '09:00',
    end_date: '2026-12-02', end_time: '17:00', description: '測試用說明文字，用來觀察描述區塊的排版。',
    is_registration_open: true, category: 'track', tags: ['公開組', '計時'], is_team_event: false,
    max_registrations: 32, requires_approval: true, waitlist_enabled: true, registration_deadline: '2026-11-20',
    is_deleted: false, created_at: daysAgo(3), created_by: ADMIN, poster_updated_at: null
}, extra || {});

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(90), last_login_at: daysAgo(1) }],
            competitions: [
                comp(701, '澳門盃田徑公開賽'),
                comp(702, '青少年排球聯賽', { category: 'ball', is_team_event: true }),
                comp(703, '冬季游泳計時賽', { category: 'water', description: '' })
            ],
            registrations: [
                { id: 1, competition_id: 701, user_id: 2, username: 'a', status: 'confirmed', is_deleted: false, created_at: daysAgo(1) },
                { id: 2, competition_id: 701, user_id: 3, username: 'b', status: 'pending', is_deleted: false, created_at: daysAgo(1) }
            ],
            error_logs: [], audit_logs: [], app_settings: [], push_subscriptions: [], push_log: [], competition_posters: []
        },
        nextId: { audit_logs: 1, error_logs: 1 },
        missingTables: [],
        log: []
    };
}

const SIZES = [
    { label: '手機 414', width: 414, height: 896, mobile: true, minCols: 2, maxCardHeight: 560 },
    { label: '平板 834', width: 834, height: 1112, mobile: false, minCols: 2, maxCardHeight: 420 },
    { label: '桌機 1440', width: 1440, height: 900, mobile: false, minCols: 3, maxCardHeight: 320 },
    { label: '大桌機 1920', width: 1920, height: 1080, mobile: false, minCols: 4, maxCardHeight: 320 }
];

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
    console.log(`\n🧪 版面空間檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    let exitCode = 1;
    let step = '啟動';
    const done = (ok, label, extra) => check(ok, `${step}｜${label}`, extra);

    try {
        for (const size of SIZES) {
            step = size.label;
            const browser = await Browser.launch({ width: size.width, height: size.height, mobile: size.mobile });
            try {
                await browser.goto(BASE);
                await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
                await browser.evaluate(`
                    document.getElementById('loginModal').classList.remove('hidden');
                    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
                    set('loginUsername', ${JSON.stringify(ADMIN)});
                    set('loginPassword', ${JSON.stringify(PASS)});
                    document.getElementById('submitLoginBtn').click();
                    return true;
                `);
                await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 3`, { timeout: 20000 });
                await new Promise((r) => setTimeout(r, 1000));

                const m = JSON.parse(await browser.evaluate(`
                    const card = document.querySelector('[data-comp-id="701"]');
                    const body = card.querySelector('.cm-card-body');
                    const grids = Array.from(card.querySelectorAll('.cm-meta-grid'));
                    const cells = Array.from(card.querySelectorAll('.cm-meta-grid > *'));
                    const buttons = Array.from(card.querySelectorAll('button'));
                    const main = document.getElementById('mainContent');
                    const header = document.querySelector('.cm-header-inner');
                    const shell = (el) => el ? Math.round(el.getBoundingClientRect().width) : -1;
                    return JSON.stringify({
                        viewport: window.innerWidth,
                        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                        scrollWidth: document.documentElement.scrollWidth,
                        cardWidth: Math.round(card.getBoundingClientRect().width),
                        cardHeight: Math.round(card.getBoundingClientRect().height),
                        bodyWidth: Math.round(body.getBoundingClientRect().width),
                        cols: grids.map((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length),
                        overflowing: cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
                        buttons: buttons.length,
                        buttonsVisible: buttons.filter((b) => b.getBoundingClientRect().width > 0).length,
                        buttonsTooSmall: buttons.filter((b) => b.getBoundingClientRect().height < 18 || b.getBoundingClientRect().width < 40).length,
                        mainWidth: shell(main),
                        headerWidth: shell(header)
                    });
                `));

                done(!m.overflow, '沒有橫向溢出', `${m.scrollWidth} > ${m.viewport}`);
                done(m.bodyWidth >= m.cardWidth * 0.5,
                    `卡片內容欄至少佔一半寬度（${m.bodyWidth} / ${m.cardWidth} = ${Math.round(m.bodyWidth / m.cardWidth * 100)}%）`);
                done(m.cols.every((c) => c >= size.minCols),
                    `資訊欄位數 ≥ ${size.minCols}（實際 [${m.cols}]）`);
                done(m.overflowing === 0, '資訊欄沒有文字被切掉', `${m.overflowing} 個`);
                done(m.cardHeight <= size.maxCardHeight,
                    `卡片高度 ≤ ${size.maxCardHeight}px（實際 ${m.cardHeight}px）`);
                done(m.buttonsVisible === m.buttons && m.buttons > 0,
                    `卡片按鈕全部看得到（${m.buttonsVisible}/${m.buttons}）`);
                done(m.buttonsTooSmall === 0, '按鈕都按得到（高度 ≥18px、寬度 ≥40px）', `${m.buttonsTooSmall} 個過小`);
                done(m.mainWidth === m.headerWidth, `主內容與頁首同寬（${m.mainWidth} / ${m.headerWidth}）`);
                if (size.width >= 1600) {
                    done(m.mainWidth > 1280, `大螢幕用滿寬度（主容器 ${m.mainWidth}px > 1280px）`);
                }
                done(browser.pageErrors.length === 0, '沒有前端例外', browser.pageErrors.join(' | ').slice(0, 160));

                await browser.screenshot(path.join(SHOTS, `layout-${size.width}.png`));
            } finally {
                try { await browser.close(); } catch (err) { /* 忽略 */ }
            }
        }

        console.log(`\n══════ 版面空間檢查：${pass} 通過 / ${fail} 失敗 ══════`);
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`\n❌ 檢查腳本執行失敗（${step}）：${err.message}`);
        console.log(String(err.stack || '').split('\n').slice(1, 4).join('\n'));
        exitCode = 1;
    } finally {
        server.close();
        stub.close();
    }
    process.exit(exitCode);
})();
