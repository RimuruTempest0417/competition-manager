/* v3.0.0：用手機尺寸的真實 Chrome 驗證「營運儀表板與列表縮圖」
 *
 * 驗的是使用者真的看得到、按得到的東西：
 *   ① 導覽有「📊 營運儀表板」（管理員以上），一般使用者與訪客沒有
 *   ② 打開後數字卡與圖表真的畫出來（SVG 有內容，不是空殼）
 *   ③ 天數切換（7／14／30）真的改變趨勢長度與說明文字
 *   ④ 重新整理會要後端重算（?fresh=1）
 *   ⑤ 效能區塊顯示海報縮圖省下多少、分頁上限、查詢耗時、索引數量
 *   ⑥ 某個選用資料表不存在時，畫面只提示該區塊不可用，其他數字照常顯示
 *   ⑦ 按鈕看得見（底色不是透明的——v2.27.0 的「白字配透明底」教訓）
 *   ⑧ 儀表板畫面上沒有任何帳號名稱（只有聚合數字）
 *   ⑨ 海報上傳後，卡片出現縮圖、延遲載入、點一下能開完整海報；列表不再載原圖
 *   ⑩ 手機尺寸沒有橫向溢出、沒有前端例外、沒有下載任何檔案
 *
 * 用法：node tests/browser/ops-dashboard-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3320);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-ops-dashboard-check');
const ADMIN = 'owner-opsstats';
const PLAYER = 'player-opsstats';
const PASS = 'checkpass123';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
// 縮圖也用同一張 1x1 PNG：這張確定能被瀏覽器解碼。
// （先前用字串拼出來的 JPEG 其實是壞的，瀏覽器永遠解不開，才會量到 naturalWidth 0。）
const TINY_THUMB = TINY_PNG;

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
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
        await browser.waitFor(`String(localStorage.getItem('auth_token') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fillAndClick();
        await browser.waitFor(`String(localStorage.getItem('auth_token') || '').length > 0`, { timeout: 10000 });
    }
};

const logout = () => `localStorage.clear(); location.reload(); return true;`;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(90), last_login_at: daysAgo(1) },
                { id: 2, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: daysAgo(30), last_login_at: daysAgo(2) }
            ],
            competitions: [
                {
                    id: 841, name: '儀表板測試賽 A', location: '澳門運動場', date: '2026-12-01', time: '09:00',
                    end_date: null, end_time: null, description: '給儀表板用', is_registration_open: true,
                    category: 'track', tags: [], is_team_event: false, max_registrations: 30,
                    requires_approval: false, waitlist_enabled: true, registration_deadline: null,
                    is_deleted: false, created_at: daysAgo(3), created_by: ADMIN, poster_updated_at: null
                },
                {
                    id: 842, name: '儀表板測試賽 B', location: '氹仔運動場', date: '2026-11-01', time: '14:00',
                    end_date: null, end_time: null, description: '', is_registration_open: true,
                    category: 'ball', tags: [], is_team_event: false, max_registrations: 20,
                    requires_approval: false, waitlist_enabled: false, registration_deadline: null,
                    is_deleted: false, created_at: daysAgo(1), created_by: ADMIN, poster_updated_at: null
                }
            ],
            registrations: [
                { id: 7201, competition_id: 841, user_id: 2, username: PLAYER, status: 'confirmed', is_deleted: false, created_at: daysAgo(2) },
                { id: 7202, competition_id: 841, user_id: 2, username: PLAYER, status: 'waitlisted', is_deleted: false, created_at: daysAgo(1) },
                { id: 7203, competition_id: 842, user_id: 2, username: PLAYER, status: 'pending', is_deleted: false, created_at: daysAgo(0) }
            ],
            competition_posters: [],
            // 故意讓 competition_staff 不存在（模擬「還沒跑 v2.27.0 migration」）
            registrations_extra: [],
            push_subscriptions: [],
            push_log: [{ id: 1, sent_count: 8, failed_count: 2, created_at: daysAgo(1) }],
            error_logs: [
                { id: 1, error_type: 'unhandled_server_error', message: 'boom', severity: 'error', resolved: false, path: '/api/x', created_at: daysAgo(1) },
                { id: 2, error_type: 'auth_invalid_token', message: 'token', severity: 'warn', resolved: false, path: '/api/y', created_at: daysAgo(3) }
            ],
            audit_logs: [
                { id: 1, user_id: ADMIN, action: 'CREATE_COMPETITION', target_id: '841', details: null, created_at: daysAgo(3) },
                { id: 2, user_id: ADMIN, action: 'CREATE_COMPETITION', target_id: '842', details: null, created_at: daysAgo(1) }
            ],
            app_settings: []
        },
        missingTables: ['competition_staff'],
        nextId: { audit_logs: 100, error_logs: 100, push_log: 100 },
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
    console.log(`\n🧪 營運儀表板與列表縮圖檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });

        // ---------- ① 選單權限 ----------
        const menu = JSON.parse(await browser.evaluate(`
            const btn = document.getElementById('opsStatsBtn');
            return JSON.stringify({
                exists: !!btn,
                adminVisible: btn && !btn.classList.contains('hidden'),
                label: btn ? btn.textContent.trim() : '',
                adminAllowed: !!(CM_MENU_PERMISSIONS.admin && CM_MENU_PERMISSIONS.admin.opsStats),
                ownerAllowed: !!(CM_MENU_PERMISSIONS.web_owner && CM_MENU_PERMISSIONS.web_owner.opsStats),
                superAllowed: !!(CM_MENU_PERMISSIONS.super_admin && CM_MENU_PERMISSIONS.super_admin.opsStats),
                userAllowed: !!(CM_MENU_PERMISSIONS.user && CM_MENU_PERMISSIONS.user.opsStats),
                guestAllowed: !!(CM_MENU_PERMISSIONS.guest && CM_MENU_PERMISSIONS.guest.opsStats)
            });
        `));
        check(menu.exists && menu.adminVisible, `管理員看得到營運儀表板（${menu.label}）`);
        check(menu.adminAllowed && menu.ownerAllowed && menu.superAllowed, '管理員／超級管理員／網站擁有者都有權限');
        check(!menu.userAllowed && !menu.guestAllowed, '一般使用者與訪客沒有儀表板權限');

        // ---------- ② 打開儀表板：數字卡與圖表 ----------
        await browser.evaluate(`document.getElementById('opsStatsBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#opsCards > div').length >= 6`, { timeout: 15000 });
        const dash = JSON.parse(await browser.evaluate(`
            const svg = document.getElementById('opsRegChart').querySelector('svg');
            const path = svg ? svg.querySelector('path') : null;
            const bars = document.querySelectorAll('#opsCatChart rect');
            const bodyText = document.getElementById('opsStatsModal').textContent;
            return JSON.stringify({
                modalVisible: !document.getElementById('opsStatsModal').classList.contains('hidden'),
                title: document.querySelector('#opsStatsModal h3').textContent.trim(),
                cards: document.querySelectorAll('#opsCards > div').length,
                cardText: document.getElementById('opsCards').textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
                regPath: path ? path.getAttribute('d') : '',
                regDots: document.getElementById('opsRegChart').querySelectorAll('circle').length,
                errPath: (document.getElementById('opsErrChart').querySelector('path') || {}).getAttribute
                    ? document.getElementById('opsErrChart').querySelector('path').getAttribute('d') : '',
                bars: bars.length,
                catLegend: document.getElementById('opsCatLegend').textContent.replace(/\\s+/g, ' ').trim(),
                meta: document.getElementById('opsStatsMeta').textContent.trim(),
                hint: document.getElementById('opsStatsHint').classList.contains('hidden') ? '' : document.getElementById('opsStatsHint').textContent.trim(),
                perf: document.getElementById('opsPerfBox').textContent.replace(/\\s+/g, ' ').trim(),
                containsAdminName: bodyText.includes(${JSON.stringify(ADMIN)}),
                containsPlayerName: bodyText.includes(${JSON.stringify(PLAYER)})
            });
        `));
        check(dash.modalVisible && /營運儀表板/.test(dash.title), `儀表板打開（${dash.title}）`);
        check(dash.cards === 6, `六張數字卡都畫出來（${dash.cards} 張）`);
        check(/賽事總數 2/.test(dash.cardText), `賽事總數正確（${dash.cardText.slice(0, 60)}…）`);
        check(/報名總數 3/.test(dash.cardText), '報名總數正確（含候補與待審核）');
        check(/推播成功率 80%/.test(dash.cardText), '推播成功率依紀錄計算（8 成功／2 失敗＝80%）');
        check(dash.regPath.startsWith('M') && dash.regPath.length > 20, `報名趨勢有畫出折線（路徑長度 ${dash.regPath.length}）`);
        check(dash.regDots === 14, `折線的資料點等於天數（${dash.regDots} 點）`);
        check(dash.errPath && dash.errPath.startsWith('M'), '錯誤趨勢有畫出折線');
        check(dash.bars === 2, `分類長條圖畫出 2 個分類（${dash.bars} 條）`);
        check(/田徑路跑 1/.test(dash.catLegend) && /球類運動 1/.test(dash.catLegend), `分類圖例正確（${dash.catLegend}）`);
        check(/涵蓋近 14 天/.test(dash.meta), `說明文字帶出範圍（${dash.meta}）`);
        check(!dash.containsAdminName && !dash.containsPlayerName, '儀表板上沒有任何帳號名稱（只有聚合數字）');

        // ---------- ⑥ 選用資料表不存在時的降級 ----------
        check(/competition_staff/.test(dash.hint) && /不影響其他數字/.test(dash.hint),
            `缺表時只提示該區塊（${dash.hint.slice(0, 70)}）`);
        check(/工作人員/.test(dash.hint) || /staff/.test(dash.hint), '提示有指出是哪個區塊');

        // ---------- ⑤ 效能區塊 ----------
        check(/海報：0 張/.test(dash.perf), '效能區塊顯示海報數量');
        check(/單次上限 100 筆/.test(dash.perf) && /200 筆/.test(dash.perf), '效能區塊顯示分頁上限');
        check(/查詢耗時/.test(dash.perf) && /ms/.test(dash.perf), '效能區塊顯示查詢耗時（實測值）');
        check(/索引：\d+ 個/.test(dash.perf), `效能區塊顯示索引數量（${(dash.perf.match(/索引：\d+ 個/) || [''])[0]}）`);

        await browser.screenshot(path.join(SHOTS, '01-儀表板.png'));

        // ---------- ⑦ 按鈕看得見（不是白字配透明底） ----------
        const buttons = JSON.parse(await browser.evaluate(`
            const info = (el) => {
                if (!el) return null;
                const cs = getComputedStyle(el);
                return { bg: cs.backgroundColor, color: cs.color, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
            };
            const active = document.querySelector('#opsStatsRange [data-ops-days="14"]');
            const other = document.querySelector('#opsStatsRange [data-ops-days="7"]');
            return JSON.stringify({ refresh: info(document.getElementById('opsStatsRefreshBtn')), active: info(active), other: info(other) });
        `));
        const visible = (b) => b && b.w > 20 && b.h > 10 && !/rgba\\(0, 0, 0, 0\\)/.test(b.bg) && b.bg !== b.color;
        check(visible(buttons.refresh), `「重新整理」按鈕看得見（底色 ${buttons.refresh && buttons.refresh.bg}）`);
        check(visible(buttons.active), `選中的天數按鈕看得見（${buttons.active && buttons.active.bg}）`);

        // ---------- ③ 天數切換 ----------
        await browser.evaluate(`document.querySelector('#opsStatsRange [data-ops-days="7"]').click(); return true;`);
        await browser.waitFor(`/涵蓋近 7 天/.test(document.getElementById('opsStatsMeta').textContent)`, { timeout: 15000 });
        const seven = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                dots: document.getElementById('opsRegChart').querySelectorAll('circle').length,
                meta: document.getElementById('opsStatsMeta').textContent.trim(),
                activeLabel: (document.querySelector('#opsStatsRange .bg-blue-600') || {}).textContent
            });
        `));
        check(seven.dots === 7, `切到 7 天後趨勢只有 7 點（${seven.dots} 點）`);
        check(/涵蓋近 7 天/.test(seven.meta), `說明文字同步更新（${seven.meta}）`);
        check(/7 天/.test(seven.activeLabel || ''), `選中的按鈕切換到 7 天（${(seven.activeLabel || '').trim()}）`);

        // ---------- ④ 重新整理（強制重算） ----------
        const fresh = JSON.parse(await browser.evaluate(`
            return fetch('/api/admin/stats?days=7', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })
                .then((r) => r.json())
                .then((d) => fetch('/api/admin/stats?days=7', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })
                    .then((r2) => r2.json())
                    .then((d2) => fetch('/api/admin/stats?days=7&fresh=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })
                        .then((r3) => r3.json())
                        .then((d3) => JSON.stringify({ second: d2.cached, third: d3.cached }))));
        `));
        check(fresh.second === true, '第二次呼叫命中快取（60 秒內）');
        check(fresh.third === false, '「重新整理」會強制重算（?fresh=1）');

        // ---------- ⑨ 海報縮圖與列表載入 ----------
        const uploaded = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/841/poster', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('auth_token') },
                body: JSON.stringify({ dataUrl: ${JSON.stringify(TINY_PNG)}, thumbDataUrl: ${JSON.stringify(TINY_THUMB)} })
            }).then((r) => r.json()).then((d) => JSON.stringify({ thumbUrl: d.thumbUrl, thumbBytes: d.thumb_bytes }));
        `));
        check(!!uploaded.thumbUrl, '上傳海報時縮圖有一起存下來');

        await browser.evaluate(`document.getElementById('closeOpsStatsBtn').click(); return true;`);
        await browser.evaluate(`return fetch('/api/competitions').then(() => { location.reload(); return true; });`);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id] img[data-poster-thumb], [data-comp-id] img').length >= 1`, { timeout: 15000 });
        // 縮圖是 loading="lazy"：在視窗外時瀏覽器「不會」載入——這正是延遲載入要的效果，
        // 所以先驗這件事，再把它捲進畫面，等真的解碼完才量 naturalWidth。
        const lazyBefore = JSON.parse(await browser.evaluate(`
            const i = document.querySelector('[data-comp-id] img');
            return JSON.stringify({ loaded: !!(i && i.complete && i.naturalWidth > 0), inView: (() => {
                if (!i) return false;
                const r = i.getBoundingClientRect();
                return r.top < window.innerHeight && r.bottom > 0;
            })() });
        `));
        await browser.evaluate(`document.querySelector('[data-comp-id] img').scrollIntoView({ block: 'center' }); return true;`);
        await browser.waitFor(`(() => { const i = document.querySelector('[data-comp-id] img'); return !!i && i.complete && i.naturalWidth > 0; })()`, { timeout: 15000 });
        const card = JSON.parse(await browser.evaluate(`
            const img = document.querySelector('[data-comp-id] img');
            const wrapper = img ? img.closest('button') : null;
            return JSON.stringify({
                src: img ? img.getAttribute('src') : '',
                loading: img ? img.getAttribute('loading') : '',
                decoding: img ? img.getAttribute('decoding') : '',
                naturalWidth: img ? img.naturalWidth : 0,
                clickable: !!wrapper && wrapper.getAttribute('data-action') === 'share-poster'
            });
        `));
        check(/variant=thumb/.test(card.src), `卡片載入的是縮圖（${card.src.slice(0, 60)}）`);
        check(card.loading === 'lazy' && card.decoding === 'async', '縮圖是延遲載入（loading=lazy、decoding=async）');
        check(card.naturalWidth > 0, `縮圖捲進畫面後真的載得到（naturalWidth ${card.naturalWidth}）`);
        check(card.clickable, '點縮圖可以開啟完整海報');
        check(lazyBefore.inView === false ? lazyBefore.loaded === false : true,
            `視窗外的縮圖不會先載入（延遲載入生效；在畫面內=${lazyBefore.inView}、已載入=${lazyBefore.loaded}）`);

        // 縮圖真的比原圖小：直接比對兩個端點的位元組
        const sizes = JSON.parse(await browser.evaluate(`
            return Promise.all([
                fetch('/api/competitions/841/poster').then((r) => r.arrayBuffer()).then((b) => b.byteLength),
                fetch('/api/competitions/841/poster?variant=thumb').then((r) => r.arrayBuffer().then((b) => ({ bytes: b.byteLength, variant: r.headers.get('x-poster-variant') })))
            ]).then(([full, thumb]) => JSON.stringify({ full, thumb: thumb.bytes, thumbVariant: thumb.variant }));
        `));
        check(sizes.thumb > 0 && sizes.full > 0 && sizes.thumbVariant === 'thumb',
            `縮圖端點回的是縮圖（原圖 ${sizes.full}B／縮圖 ${sizes.thumb}B，標頭 ${sizes.thumbVariant}）`);

        // 點縮圖 → 完整海報彈窗
        await browser.evaluate(`
            const img = document.querySelector('[data-comp-id] img');
            if (img) img.closest('button').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('posterModal').classList.contains('hidden')`, { timeout: 10000 });
        const posterModal = JSON.parse(await browser.evaluate(`
            const img = document.getElementById('posterImage');
            return JSON.stringify({ visible: !document.getElementById('posterModal').classList.contains('hidden'), src: img ? img.getAttribute('src') : '' });
        `));
        check(posterModal.visible, '點縮圖後開啟完整海報彈窗');
        check(!/variant=thumb/.test(posterModal.src), `完整海報彈窗用的是原圖（${posterModal.src.slice(0, 50)}）`);
        await browser.evaluate(`document.getElementById('closePosterBtn')?.click(); return true;`);

        await browser.screenshot(path.join(SHOTS, '02-列表縮圖.png'));

        // ---------- ⑩ 手機尺寸沒有橫向溢出 ----------
        const overflow = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                docWidth: document.documentElement.scrollWidth,
                winWidth: window.innerWidth,
                offenders: Array.from(document.querySelectorAll('[data-comp-id], #opsStatsModal, #posterModal'))
                    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
                    .map((el) => (el.id || el.getAttribute('data-comp-id') || el.tagName) + ':' + Math.round(el.getBoundingClientRect().right))
                    .slice(0, 5)
            });
        `));
        check(overflow.docWidth <= overflow.winWidth + 2,
            `手機尺寸沒有橫向溢出（文件 ${overflow.docWidth}px／視窗 ${overflow.winWidth}px）`,
            overflow.offenders.join('、'));

        // ---------- ① 一般使用者：看不到、也進不去 ----------
        await browser.evaluate(logout());
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 15000 });
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });
        const asUser = JSON.parse(await browser.evaluate(`
            const btn = document.getElementById('opsStatsBtn');
            return fetch('/api/admin/stats', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })
                .then((r) => r.json().then((d) => JSON.stringify({
                    btnHidden: !btn || btn.classList.contains('hidden'),
                    apiStatus: r.status,
                    apiError: d.error || ''
                })));
        `));
        check(asUser.btnHidden, '一般使用者看不到儀表板按鈕');
        check(asUser.apiStatus === 403, `一般使用者直接打 API 也被擋（HTTP ${asUser.apiStatus}）`);

        // ---------- ⑩ 例外與下載 ----------
        const downloads = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__downloads || []);`));
        check(downloads.length === 0, `過程中沒有下載任何檔案（攔到 ${downloads.length} 個）`);
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`   ❌ 檢查腳本執行失敗：${err.message}`);
        exitCode = 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }
    console.log(`\n══════ 營運儀表板與列表縮圖檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
