/* v2.26.0：用手機尺寸的真實 Chrome 驗證「推播失敗可視與重送」＋「站內公告／訊息中心」
 *
 * 驗的是使用者真的操作得到的東西：
 *   ① 選單：「📣 公告中心」登入即可看到，訪客看不到
 *   ② 未讀徽章：數量正確；點公告卡片標記已讀後徽章跟著減；「全部標記已讀」後消失
 *   ③ 一般使用者只看得到「所有人」與自己訂閱分類的公告（管理員公告看不到）
 *   ④ 訂閱分類：改了立刻影響看得到的公告（路跑組 → 電子競技）
 *   ⑤ 管理員發布：填表、送出、列表出現、資料庫真的寫入、稽核日誌有紀錄
 *   ⑥ 發布時勾「同時發送推播」：只推給對象使用者的訂閱；失敗會留下原因
 *   ⑦ 推播紀錄看得到失敗筆數、原因、內容，並能「重送給原本的對象」（重送次數寫回紀錄）
 *   ⑧ 下架後使用者看不到，重新上架又看得到
 *   ⑨ 過程中沒有前端例外、也不會下載任何檔案到使用者的電腦
 *
 * 用法：node tests/browser/announcements-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3319);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-announcements-check');
const ADMIN = 'owner-announce';
const PLAYER = 'player-announce';
const PASS = 'checkpass123';

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

function seedState() {
    const base = {
        title: '', body: '', audience: 'all', categories: [], is_pinned: false, is_active: true,
        publish_at: '2026-09-20T00:00:00.000Z', expires_at: null, created_by: 'owner-announce',
        created_at: '2026-09-20T00:00:00.000Z'
    };
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, announce_categories: [] },
                { id: 2, username: 'boss-announce', password: PASS, role: 'admin', is_active: true, announce_categories: ['track'] },
                { id: 91, username: PLAYER, password: PASS, role: 'user', is_active: true, announce_categories: ['track'] },
                { id: 92, username: 'other-announce', password: PASS, role: 'user', is_active: true, announce_categories: [] }
            ],
            competitions: [
                {
                    id: 841, name: '公告測試賽', location: '澳門運動場', date: '2026-12-01', time: '09:00',
                    end_date: null, end_time: null, description: '看列表用',
                    is_registration_open: true, category: 'track', tags: [], is_team_event: false,
                    max_registrations: 20, requires_approval: false, waitlist_enabled: false,
                    registration_deadline: '2026-11-30', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            registrations: [],
            teams: [],
            announcements: [
                Object.assign({}, base, { id: 1, title: '一般公告', body: '所有人都看得到', is_pinned: true }),
                Object.assign({}, base, { id: 2, title: '管理員公告', body: '只有管理員看得到', audience: 'admin' }),
                Object.assign({}, base, { id: 3, title: '路跑組公告', body: '訂閱田徑路跑的人看得到', audience: 'category', categories: ['track'] }),
                Object.assign({}, base, { id: 4, title: '已下架公告', body: '看不到', is_active: false })
            ],
            announcement_reads: [],
            push_subscriptions: [
                {
                    id: 9001, user_id: 91, endpoint: 'http://127.0.0.1:9/push-stub',
                    p256dh: 'stub-p256dh', auth: 'stub-auth', is_active: true, created_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            push_log: [],
            audit_logs: [],
            error_logs: [],
            app_settings: []
        },
        nextId: { announcements: 500, announcement_reads: 500, audit_logs: 1000, push_log: 500, error_logs: 500 },
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
    console.log(`\n🧪 公告中心與推播重送介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);

        const alerts = async () => JSON.parse(await browser.evaluate(`return JSON.stringify(window.__ALERTS__ || []);`));
        const annByTitle = (title) => state.tables.announcements.find((a) => a.title === title);
        const cardTitles = async () => JSON.parse(await browser.evaluate(`
            return JSON.stringify(Array.from(document.querySelectorAll('#announceList [data-announce-id]'))
                .map((el) => el.querySelector('p.font-semibold').textContent.trim()));
        `));
        const snapshot = async () => JSON.parse(await browser.evaluate(`
            const badge = document.getElementById('announceBadge');
            return JSON.stringify({
                modalOpen: !document.getElementById('announcementModal').classList.contains('hidden'),
                adminBoxVisible: !document.getElementById('announceAdminBox').classList.contains('hidden'),
                hintHidden: document.getElementById('announceHint').classList.contains('hidden'),
                status: document.getElementById('announceStatus').classList.contains('hidden') ? '' : document.getElementById('announceStatus').textContent,
                badgeHidden: badge.classList.contains('hidden'),
                badge: badge.textContent.trim(),
                cards: document.querySelectorAll('#announceList [data-announce-id]').length,
                unreadCards: document.querySelectorAll('#announceList .cm-announce-unread').length,
                adminCards: document.querySelectorAll('#announceAdminList [data-action]').length
            });
        `));
        const openAnnouncements = () => browser.evaluate(`
            document.getElementById('announcementsBtn').click();
            return true;
        `);
        const clickCard = (title) => browser.evaluate(`
            const card = Array.from(document.querySelectorAll('#announceList [data-announce-id]'))
                .find((el) => el.textContent.includes(${JSON.stringify(title)}));
            if (!card) return false;
            card.click();
            return true;
        `);
        const setCatCheckbox = (label, checked) => browser.evaluate(`
            const box = Array.from(document.querySelectorAll('#announceCategoryList label'))
                .find((el) => el.textContent.includes(${JSON.stringify(label)}));
            if (!box) return null;
            const input = box.querySelector('input');
            input.checked = ${checked ? 'true' : 'false'};
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return input.checked;
        `);
        const adminRowFor = (title) => browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#announceAdminList > div'));
            const row = rows.find((el) => el.textContent.includes(${JSON.stringify(title)}));
            if (!row) return '';
            return row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160);
        `);

        // ---------- ⓪ 版本號（沿用 v2.25.0 的守門） ----------
        await browser.waitFor(`/v\\d+\\.\\d+\\.\\d+/.test(document.getElementById('appSubtitle').textContent)`, { timeout: 10000 });
        const versionInfo = JSON.parse(await browser.evaluate(`
            return fetch('/api/version').then((r) => r.json()).then((d) => JSON.stringify({
                subtitle: document.getElementById('appSubtitle').textContent, api: d.version, title: document.title
            }));
        `));
        check(versionInfo.subtitle.includes(`v${versionInfo.api}`), `頁首版本號與後端一致（${versionInfo.subtitle}）`);
        check(versionInfo.title.includes(`v${versionInfo.api}`), `<title> 與後端版本一致（${versionInfo.title}）`);

        // ---------- ① 訪客權限 ----------
        const guestMenu = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                adminHidden: document.getElementById('announcementsBtn') === null
                    || document.getElementById('announcementsBtn').classList.contains('hidden'),
                guestAllowed: !!(CM_MENU_PERMISSIONS.guest && CM_MENU_PERMISSIONS.guest.announce),
                userAllowed: !!(CM_MENU_PERMISSIONS.user && CM_MENU_PERMISSIONS.user.announce),
                adminAllowed: !!(CM_MENU_PERMISSIONS.admin && CM_MENU_PERMISSIONS.admin.announce)
            });
        `));
        check(guestMenu.adminHidden, '訪客看不到「公告中心」按鈕');
        check(!guestMenu.guestAllowed && guestMenu.userAllowed && guestMenu.adminAllowed,
            `權限表：登入即可用、訪客不可（guest=${guestMenu.guestAllowed}／user=${guestMenu.userAllowed}／admin=${guestMenu.adminAllowed}）`);

        // ---------- ② 管理員登入：徽章、已讀 ----------
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });
        await browser.waitFor(`document.getElementById('announceBadge') && !document.getElementById('announceBadge').classList.contains('hidden')`, { timeout: 10000 });
        const ownerFirst = await snapshot();
        check(ownerFirst.badge === '3', `管理員未讀徽章顯示 3（含管理員公告）→ ${ownerFirst.badge}`);

        await openAnnouncements();
        await browser.waitFor(`document.querySelectorAll('#announceList [data-announce-id]').length >= 3`, { timeout: 10000 });
        const ownerList = await snapshot();
        check(ownerList.modalOpen && ownerList.cards === 3, `公告中心列出 3 則上架中的公告（${ownerList.cards}）`);
        check(ownerList.unreadCards === 3, `3 則都標示未讀（${ownerList.unreadCards}）`);
        check(ownerList.adminBoxVisible, '管理員看得到「管理公告」區塊');
        check(ownerList.hintHidden, '公告功能正常時不會顯示「尚未啟用」提示');

        const titlesBefore = await cardTitles();
        check(titlesBefore[0] === '一般公告', `置頂公告排在最前面（${titlesBefore.join('、')}）`);

        await clickCard('路跑組公告');
        await browser.waitFor(`document.querySelectorAll('#announceList .cm-announce-unread').length === 2`, { timeout: 8000 });
        const afterRead = await snapshot();
        check(afterRead.badge === '2', `點一則公告後徽章減為 2（${afterRead.badge}）`);
        check(state.tables.announcement_reads.some((r) => String(r.announcement_id) === '3' && String(r.user_id) === '1'),
            '已讀紀錄寫進資料庫');

        await browser.evaluate(`document.getElementById('markAllAnnounceReadBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('announceBadge').classList.contains('hidden')`, { timeout: 8000 });
        const afterAll = await snapshot();
        check(afterAll.badgeHidden && afterAll.unreadCards === 0, '「全部標記已讀」後徽章消失、全部變成已讀');
        check(state.tables.announcement_reads.length >= 3, `已讀紀錄共 ${state.tables.announcement_reads.length} 筆（不重複）`);

        // v2.27.0 修：sky-* 色系不存在 → 白字配透明底＝按鈕隱形。這裡用真的算過 CSS 的斷言守住。
        const announceBtns = JSON.parse(await browser.evaluate(`
            const out = {};
            ['saveAnnounceCatsBtn', 'submitAnnounceBtn', 'markAllAnnounceReadBtn', 'toggleAnnounceFormBtn'].forEach((id) => {
                const el = document.getElementById(id);
                if (!el) { out[id] = null; return; }
                const cs = getComputedStyle(el);
                out[id] = { bg: cs.backgroundColor, color: cs.color, text: el.textContent.trim().slice(0, 12) };
            });
            return JSON.stringify(out);
        `));
        const catBtn = announceBtns.saveAnnounceCatsBtn;
        check(catBtn && catBtn.bg !== 'rgba(0, 0, 0, 0)' && catBtn.color !== catBtn.bg,
            `「儲存訂閱」按鈕看得見（底 ${catBtn && catBtn.bg}／字 ${catBtn && catBtn.color}）`);
        const submitBtnStyle = announceBtns.submitAnnounceBtn;
        check(submitBtnStyle && submitBtnStyle.bg !== 'rgba(0, 0, 0, 0)' && submitBtnStyle.color !== submitBtnStyle.bg,
            `「${submitBtnStyle && submitBtnStyle.text}」按鈕看得見（底 ${submitBtnStyle && submitBtnStyle.bg}／字 ${submitBtnStyle && submitBtnStyle.color}）`);
        const readBtn = announceBtns.markAllAnnounceReadBtn;
        check(readBtn && readBtn.color !== 'rgb(255, 255, 255)', `「全部標記已讀」文字顏色不是白色（${readBtn && readBtn.color}）`);
        const newBtn = announceBtns.toggleAnnounceFormBtn;
        check(newBtn && newBtn.color !== 'rgb(255, 255, 255)', `「${newBtn && newBtn.text}」文字顏色不是白色（${newBtn && newBtn.color}）`);

        await browser.screenshot(path.join(SHOTS, '01-管理員公告中心.png'));

        // ---------- ③ 管理員發布公告（不推播） ----------
        const fillForm = async ({ title, body, audience, categories, notify }) => {
            await browser.evaluate(`
                const setValue = (id, value) => {
                    const el = document.getElementById(id);
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                };
                setValue('announceTitle', ${JSON.stringify(title)});
                setValue('announceBody', ${JSON.stringify(body)});
                const aud = document.getElementById('announceAudience');
                aud.value = ${JSON.stringify(audience)};
                aud.dispatchEvent(new Event('change', { bubbles: true }));
                document.getElementById('announcePinned').checked = false;
                document.getElementById('announceNotifyPush').checked = ${notify ? 'true' : 'false'};
                const target = ${JSON.stringify(categories)};
                document.querySelectorAll('#announceCategoryPick input[type="checkbox"]').forEach((el) => {
                    el.checked = target.includes(el.value);
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                });
                return true;
            `);
        };
        // 順序很重要：先開表單（openAnnounceForm 會清空欄位），再填值，最後送出
        const publish = async (fields) => {
            await browser.evaluate(`
                if (document.getElementById('announceForm').classList.contains('hidden')) {
                    document.getElementById('toggleAnnounceFormBtn').click();
                }
                return true;
            `);
            await fillForm(fields);
            await browser.evaluate(`document.getElementById('announceForm').requestSubmit(); return true;`);
        };

        await publish({ title: '場地異動', body: '本週六改到氹仔運動場，請提早 30 分鐘到。', audience: 'category', categories: ['track'], notify: false });
        await browser.waitFor(`document.getElementById('announceList').textContent.includes('場地異動')`, { timeout: 10000 });
        const published = await snapshot();
        check(/沒有勾選/.test(published.status),
            `不勾推播時明確說明（${published.status.slice(0, 60)}）`);
        const created = annByTitle('場地異動');
        check(!!created && created.audience === 'category' && created.categories.includes('track'),
            `公告寫進資料庫，對象是田徑路跑訂閱者（${created && JSON.stringify(created.categories)}）`);
        const auditCreated = state.tables.audit_logs.filter((l) => l.action === 'CREATE_ANNOUNCEMENT');
        check(auditCreated.length === 1 && /場地異動/.test(String(auditCreated[0].details)),
            `發布留下稽核紀錄（${auditCreated.length} 筆）`);

        const adminRow = await adminRowFor('場地異動');
        check(/已讀 0\/4/.test(adminRow), `管理清單顯示已讀 0／4（有效使用者 4 位）→ ${adminRow}`);

        // ---------- ④ 發布並推播：只推給對象、失敗留下原因 ----------
        await publish({ title: '器材盤點', body: '請各單位於月底前完成器材盤點。', audience: 'category', categories: ['track'], notify: true });
        await browser.waitFor(`document.getElementById('announceList').textContent.includes('器材盤點')`, { timeout: 12000 });
        const pushed = await snapshot();
        check(/推播成功 0 則、失敗 1 則/.test(pushed.status), `推播結果誠實回報（${pushed.status.slice(-60)}）`);

        const pushRow = state.tables.push_log[state.tables.push_log.length - 1];
        check(pushRow && pushRow.kind === 'announcement' && Number(pushRow.failed_count) === 1,
            `推播紀錄記下失敗 1 筆（kind=${pushRow && pushRow.kind}）`);
        check(pushRow && Array.isArray(pushRow.target_user_ids) && pushRow.target_user_ids.length === 2,
            `推播對象只有訂閱該分類的 2 位（${pushRow && JSON.stringify(pushRow.target_user_ids)}）`);
        check(pushRow && /HTTP/.test(String(pushRow.error_detail)), `失敗原因有寫下來（${pushRow && pushRow.error_detail}）`);

        // ---------- ⑤ 推播紀錄：失敗可視與重送 ----------
        await browser.evaluate(`
            document.getElementById('closeAnnouncementBtn2').click();
            document.getElementById('pushLogsBtn').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('pushLogsList').textContent.includes('載入推播紀錄中')`, { timeout: 10000 });
        const logsSnapshot = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                text: document.getElementById('pushLogsList').textContent.replace(/\\s+/g, ' ').trim().slice(0, 400),
                hasResend: !!document.querySelector('#pushLogsList button[data-resend-id]'),
                hintHidden: document.getElementById('pushLogsHint').classList.contains('hidden')
            });
        `));
        check(/失敗 1 則/.test(logsSnapshot.text), `推播紀錄顯示失敗筆數（${logsSnapshot.text.slice(0, 90)}）`);
        check(/原因：/.test(logsSnapshot.text) && /HTTP/.test(logsSnapshot.text), '推播紀錄顯示失敗原因');
        check(/內容：.*器材盤點/.test(logsSnapshot.text), '推播紀錄顯示原本送出的內容');
        check(logsSnapshot.hasResend, '失敗的紀錄有「重送給原本的對象」按鈕');
        check(logsSnapshot.hintHidden, '明細欄位都在時不會顯示「尚未啟用」提示');

        await browser.evaluate(`document.querySelector('#pushLogsList button[data-resend-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('pushLogsStatus').textContent.includes('重送')`, { timeout: 12000 });
        await browser.waitFor(`!document.getElementById('pushLogsStatus').textContent.includes('重送中')`, { timeout: 15000 });
        const resendStatus = await browser.evaluate(`return document.getElementById('pushLogsStatus').textContent;`);
        check(/重送完成：成功 0 則、失敗 1 則/.test(resendStatus), `重送結果誠實回報（${resendStatus.slice(0, 70)}）`);
        const resentRow = state.tables.push_log.find((l) => l.kind === 'announcement');
        check(Number(resentRow.resend_count) === 1 && !!resentRow.resend_at, '重送次數與時間寫回紀錄');
        check(state.tables.audit_logs.some((l) => l.action === 'RESEND_PUSH' && /限 2 位使用者/.test(String(l.details))),
            '重送留下稽核（並寫明送給誰）');
        await browser.screenshot(path.join(SHOTS, '02-推播失敗與重送.png'));
        await browser.evaluate(`document.getElementById('closePushLogsBtn2').click(); return true;`);

        // ---------- ⑥ 下架／重新上架 ----------
        await openAnnouncements();
        await browser.waitFor(`document.querySelectorAll('#announceAdminList > div').length >= 5`, { timeout: 10000 });
        const toggleAdminRow = (title) => browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#announceAdminList > div'))
                .find((el) => el.textContent.includes(${JSON.stringify(title)}));
            window.__TOGGLE_BTN__ = row ? row.querySelector('button[data-action="toggle"]').outerHTML : 'NO_ROW';
            if (row) row.querySelector('button[data-action="toggle"]').click();
            return !!row;
        `);
        const waitToggle = async (pattern) => {
            try {
                await browser.waitFor(`/${pattern}/.test(document.getElementById('announceStatus').textContent)`, { timeout: 10000 });
            } catch (err) {
                const diag = await browser.evaluate(`return JSON.stringify({
                    status: document.getElementById('announceStatus').textContent,
                    btn: window.__TOGGLE_BTN__,
                    alerts: window.__ALERTS__ || []
                });`);
                console.log('   ℹ️ 診斷：', diag);
                console.log('   ℹ️ 最近請求：', JSON.stringify(state.log.slice(-3)));
            }
        };
        await toggleAdminRow('器材盤點');
        await waitToggle('已下架');   // 不能只等「下架」，否則第二次呼叫會誤判
        const offRow = await adminRowFor('器材盤點');
        check(/未上架/.test(offRow), `下架後管理清單標示未上架（${offRow.slice(0, 50)}）`);
        check(!(await cardTitles()).includes('器材盤點'), '下架後使用者列表看不到（管理員亦然）');
        check(annByTitle('器材盤點').is_active === false, '下架狀態寫進資料庫');

        await toggleAdminRow('器材盤點');
        await waitToggle('重新上架');
        check((await cardTitles()).includes('器材盤點'), '重新上架後又看得到');
        check((await alerts()).every((a) => !/❌/.test(a)), '過程中沒有出現錯誤提示', JSON.stringify(await alerts()).slice(0, 120));

        // ---------- ⑦ 一般使用者視角 ----------
        await browser.evaluate(`
            localStorage.clear();
            window.location.href = '/';
            return true;
        `);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 15000 });
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`document.getElementById('announcementsBtn') && !document.getElementById('announcementsBtn').classList.contains('hidden')`, { timeout: 15000 });
        await browser.waitFor(`document.getElementById('announceBadge') && !document.getElementById('announceBadge').classList.contains('hidden')`, { timeout: 10000 });
        const playerBadge = await snapshot();
        check(playerBadge.badge === '4', `一般使用者未讀 4 則（管理員公告不算）→ ${playerBadge.badge}`);

        await openAnnouncements();
        await browser.waitFor(`document.querySelectorAll('#announceList [data-announce-id]').length >= 4`, { timeout: 10000 });
        const playerTitles = await cardTitles();
        check(!playerTitles.includes('管理員公告'), `一般使用者看不到管理員公告（${playerTitles.join('、')}）`);
        check(playerTitles.includes('路跑組公告') && playerTitles.includes('場地異動'),
            '看得到自己訂閱分類（田徑路跑）的公告');
        const playerSnap = await snapshot();
        check(!playerSnap.adminBoxVisible, '一般使用者看不到「管理公告」區塊');

        // ---------- ⑧ 換訂閱分類 ----------
        check(await setCatCheckbox('田徑路跑', false) === false, '取消訂閱田徑路跑');
        check(await setCatCheckbox('電子競技', true) === true, '改訂閱電子競技');
        await browser.evaluate(`document.getElementById('saveAnnounceCatsBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('announceCatStatus').textContent.includes('電子競技')`, { timeout: 10000 });
        await browser.waitFor(`!document.getElementById('announceList').textContent.includes('路跑組公告')`, { timeout: 10000 });
        const afterChange = await cardTitles();
        check(!afterChange.includes('路跑組公告') && !afterChange.includes('場地異動'),
            `換分類後看不到田徑路跑的公告（${afterChange.join('、')}）`);
        check(afterChange.includes('一般公告'), '「所有人」的公告仍然看得到');
        const playerRow = state.tables.admin_users.find((u) => u.id === 91);
        check(JSON.stringify(playerRow.announce_categories) === JSON.stringify(['esports']),
            `訂閱分類寫進資料庫（${JSON.stringify(playerRow.announce_categories)}）`);

        await browser.screenshot(path.join(SHOTS, '03-一般使用者訊息中心.png'));

        // ---------- ⑨ 沒有例外、沒有下載 ----------
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
    console.log(`\n══════ 公告中心與推播重送介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
