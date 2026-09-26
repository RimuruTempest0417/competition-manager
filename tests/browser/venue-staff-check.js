/* v2.27.0：用手機尺寸的真實 Chrome 驗證「場地地圖連結」＋「工作人員指派」
 *
 * 驗的是使用者真的操作得到的東西：
 *   ① 卡片上有地圖連結：沒填自訂連結＝用地址自動產生（並標示「用地址搜尋」）
 *   ② 有填自訂連結＝以自訂連結為準；沒有地點也沒有連結＝不顯示地圖
 *   ③ 工作人員清單公開：訪客／一般使用者看得到誰是裁判，但看不到指派與移除
 *   ④ 管理員可指派（帳號＋角色＋備註）：列表出現、卡片徽章 +1、資料庫與稽核都留下
 *   ⑤ 同一人再指派一次＝改角色，不會變成兩筆
 *   ⑥ 可移除；移除後徽章消失，稽核留紀錄
 *   ⑦ 表單新增「地圖連結」欄位：留空用地址、填了用填的；不安全的連結會被後端擋下並顯示原因
 *   ⑧ 過程中沒有前端例外、也不會下載任何檔案到使用者的電腦
 *
 * 用法：node tests/browser/venue-staff-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');
const CMVenue = require('../../public/js/venue');

const PORT = Number(process.env.CHECK_PORT || 3321);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-venue-staff-check');
const ADMIN = 'owner-venue';
const PLAYER = 'player-venue';
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
    // 登入成功會整頁重載：重載後要重新注入 alert／confirm 的替身，否則後面的檢查收不到訊息
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
    await browser.evaluate(STUB_DIALOGS);
};

const logout = (browser) => browser.evaluate(`
    localStorage.removeItem('auth_token');
    return true;
`).then(() => browser.goto(BASE)).then(() => browser.evaluate(STUB_DIALOGS));

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true },
                { id: 5, username: 'judge-venue', password: PASS, role: 'admin', is_active: true },
                { id: 6, username: 'cam-venue', password: PASS, role: 'user', is_active: true },
                { id: 7, username: 'off-venue', password: PASS, role: 'user', is_active: false },
                { id: 91, username: PLAYER, password: PASS, role: 'user', is_active: true }
            ],
            competitions: [
                {
                    id: 841, name: '地圖測試賽（自動）', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00',
                    end_date: null, end_time: null, description: '沒填自訂連結',
                    is_registration_open: true, category: 'track', tags: [], is_team_event: false,
                    max_registrations: 20, requires_approval: false, waitlist_enabled: false,
                    registration_deadline: '2026-11-30', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z',
                    map_url: null
                },
                {
                    id: 842, name: '地圖測試賽（自訂）', location: '澳門運動場', date: '2026-12-05', time: '09:00',
                    end_date: null, end_time: null, description: '有填自訂連結',
                    is_registration_open: true, category: 'track', tags: [], is_team_event: false,
                    max_registrations: 20, requires_approval: false, waitlist_enabled: false,
                    registration_deadline: '2026-12-04', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z',
                    map_url: 'https://maps.app.goo.gl/custom-venue'
                },
                {
                    id: 843, name: '沒有地點的賽事', location: '', date: '2026-12-09', time: '09:00',
                    end_date: null, end_time: null, description: '',
                    is_registration_open: true, category: 'track', tags: [], is_team_event: false,
                    max_registrations: 20, requires_approval: false, waitlist_enabled: false,
                    registration_deadline: null, is_deleted: false, created_at: '2026-01-01T00:00:00.000Z',
                    map_url: null
                }
            ],
            competition_staff: [
                { id: 701, competition_id: 841, user_id: 5, role: 'referee', note: '主場地', assigned_by: ADMIN, created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' }
            ],
            registrations: [],
            audit_logs: [],
            error_logs: [],
            app_settings: []
        },
        nextId: { competition_staff: 800, competitions: 900, audit_logs: 1, error_logs: 1 },
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
    console.log(`\n🧪 場地地圖連結與工作人員指派介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);

        const staffRows = (compId) => state.tables.competition_staff.filter((r) => String(r.competition_id) === String(compId));
        const auditsOf = (action) => state.tables.audit_logs.filter((a) => a.action === action);

        /* 卡片上的地圖連結資訊：href、是否標示自動、徽章文字 */
        const cardInfo = (name) => browser.evaluate(`
            const card = Array.from(document.querySelectorAll('[data-comp-id]'))
                .find((el) => el.textContent.includes(${JSON.stringify(name)}));
            if (!card) return JSON.stringify({ found: false });
            const link = card.querySelector('a[href*="maps"]');
            const chip = Array.from(card.querySelectorAll('button')).find((b) => b.dataset.action === 'manage-staff');
            return JSON.stringify({
                found: true,
                href: link ? link.getAttribute('href') : '',
                text: link ? link.textContent.trim() : '',
                target: link ? link.getAttribute('target') : '',
                rel: link ? link.getAttribute('rel') : '',
                chip: chip ? chip.textContent.trim() : '',
                adminStaffBtn: !!Array.from(card.querySelectorAll('button')).find((b) => b.dataset.action === 'manage-staff' && b.textContent.includes('工作人員') && !b.textContent.match(/\\d/))
            });
        `).then(JSON.parse);

        const staffSnapshot = () => browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#staffList > div'));
            return JSON.stringify({
                open: !document.getElementById('staffModal').classList.contains('hidden'),
                hintHidden: document.getElementById('staffHint').classList.contains('hidden'),
                adminBoxVisible: !document.getElementById('staffAdminBox').classList.contains('hidden'),
                titles: rows.map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
                removeButtons: document.querySelectorAll('#staffList [data-staff-remove]').length,
                summary: document.getElementById('staffSummary').textContent.replace(/\\s+/g, ' ').trim(),
                status: document.getElementById('staffStatus').classList.contains('hidden') ? '' : document.getElementById('staffStatus').textContent,
                roleOptions: Array.from(document.querySelectorAll('#staffRole option')).map((o) => o.value),
                userOptions: Array.from(document.querySelectorAll('#staffUser option')).map((o) => o.textContent.trim())
            });
        `).then(JSON.parse);

        const openStaffFor = async (name) => {
            await browser.evaluate(`
                const card = Array.from(document.querySelectorAll('[data-comp-id]'))
                    .find((el) => el.textContent.includes(${JSON.stringify(name)}));
                const btn = Array.from(card.querySelectorAll('button')).find((b) => b.dataset.action === 'manage-staff');
                btn.click();
                return true;
            `);
            await browser.waitFor(`!document.getElementById('staffModal').classList.contains('hidden')`, { timeout: 8000 });
            // 清單是抓回來的，要等到「摘要」或「空清單提示」出現才算載完
            await browser.waitFor(`
                document.getElementById('staffSummary').textContent.trim().length > 0
                && document.getElementById('staffList').textContent.trim().length > 0
            `, { timeout: 10000 });
            await new Promise((r) => setTimeout(r, 150));
        };

        // ---------- ⓪ 版本號（沿用 v2.25.0 的守門） ----------
        await browser.waitFor(`/v\\d+\\.\\d+\\.\\d+/.test(document.getElementById('appSubtitle').textContent)`, { timeout: 10000 });
        const versionInfo = JSON.parse(await browser.evaluate(`
            return fetch('/api/version').then((r) => r.json()).then((d) => JSON.stringify({
                subtitle: document.getElementById('appSubtitle').textContent, api: d.version
            }));
        `));
        check(versionInfo.subtitle.includes(`v${versionInfo.api}`), `頁首版本號與後端一致（${versionInfo.subtitle}）`);

        // ---------- ① 訪客視角：地圖連結與工作人員（公開可看） ----------
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 3`, { timeout: 15000 });

        const autoCard = await cardInfo('地圖測試賽（自動）');
        check(autoCard.href === CMVenue.autoMapUrl('澳門氹仔運動場'),
            `沒填自訂連結＝用地址自動產生 Google 地圖連結（${autoCard.href.slice(0, 70)}）`);
        check(autoCard.text.includes('用地址搜尋'), `連結標示「用地址搜尋」（${autoCard.text}）`);
        check(autoCard.target === '_blank' && autoCard.rel.includes('noopener'),
            '地圖連結另開新頁且帶 rel=noopener（不把本站交給外部頁面）');

        const customCard = await cardInfo('地圖測試賽（自訂）');
        check(customCard.href === 'https://maps.app.goo.gl/custom-venue',
            `有填自訂連結＝以自訂連結為準（${customCard.href}）`);
        check(!customCard.text.includes('用地址搜尋'), '自訂連結不會標示「用地址搜尋」');

        const noMapCard = await cardInfo('沒有地點的賽事');
        check(noMapCard.href === '', '沒有地點也沒有自訂連結＝不顯示地圖（不給一個搜不到的連結）');

        check(autoCard.chip.includes('工作人員 1'), `卡片顯示工作人員徽章（${autoCard.chip}）`);

        await openStaffFor('地圖測試賽（自動）');
        const guestStaff = await staffSnapshot();
        check(guestStaff.open, '訪客點工作人員徽章可以看到清單');
        check(guestStaff.titles.length === 1 && guestStaff.titles[0].includes('裁判') && guestStaff.titles[0].includes('judge-venue'),
            `清單顯示角色與帳號名稱（${guestStaff.titles[0]}）`);
        check(guestStaff.summary.includes('裁判 1'), `摘要顯示各角色人數（${guestStaff.summary}）`);
        check(!guestStaff.adminBoxVisible && guestStaff.removeButtons === 0, '訪客看不到指派區塊與移除按鈕');
        check(guestStaff.hintHidden, '功能正常時不會顯示「尚未啟用」提示');

        await browser.screenshot(path.join(SHOTS, '01-訪客看工作人員清單.png'));

        // ---------- ② 管理員：指派工作人員 ----------
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 3`, { timeout: 15000 });
        await openStaffFor('地圖測試賽（自動）');
        await browser.waitFor(`!document.getElementById('staffAdminBox').classList.contains('hidden')`, { timeout: 8000 });

        const adminStaff = await staffSnapshot();
        check(adminStaff.adminBoxVisible, '管理員看得到指派區塊');
        check(adminStaff.removeButtons === 1, '管理員看得到移除按鈕');
        check(adminStaff.roleOptions.join(',') === 'referee,recorder,photographer,medical,other',
            `角色選單來自共用規則（${adminStaff.roleOptions.join('、')}）`);
        check(!adminStaff.userOptions.some((o) => o.includes('off-venue')),
            '停用中的帳號不會出現在可指派清單');

        // v2.27.0 修：這顆按鈕曾經因為 sky-* 色系不存在而隱形（真 Chrome 算過 CSS 才看得到）
        const assignBtnStyle = JSON.parse(await browser.evaluate(`
            const el = document.getElementById('staffAssignBtn');
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return JSON.stringify({ bg: cs.backgroundColor, color: cs.color, w: Math.round(rect.width), h: Math.round(rect.height), text: el.textContent.trim() });
        `));
        check(assignBtnStyle.bg !== 'rgba(0, 0, 0, 0)' && assignBtnStyle.color !== assignBtnStyle.bg && assignBtnStyle.w > 40,
            `「${assignBtnStyle.text}」按鈕看得見（底 ${assignBtnStyle.bg}／字 ${assignBtnStyle.color}／${assignBtnStyle.w}×${assignBtnStyle.h}）`);

        const assignNew = async (username, role, note) => {
            await browser.waitFor(`
                Array.from(document.querySelectorAll('#staffUser option')).some((o) => o.textContent.includes(${JSON.stringify(username)}))
            `, { timeout: 10000 });
            await browser.evaluate(`
                const pick = (id, value) => {
                    const el = document.getElementById(id);
                    el.value = value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                };
                const userId = Array.from(document.querySelectorAll('#staffUser option'))
                    .find((o) => o.textContent.includes(${JSON.stringify(username)})).value;
                pick('staffUser', userId);
                pick('staffRole', ${JSON.stringify(role)});
                const noteEl = document.getElementById('staffNote');
                noteEl.value = ${JSON.stringify(note || '')};
                noteEl.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('staffAssignBtn').click();
                return true;
            `);
        };

        await assignNew('cam-venue', 'photographer', '負責拍照');
        await browser.waitFor(`document.querySelectorAll('#staffList > div').length === 2`, { timeout: 8000 });
        const afterAssign = await staffSnapshot();
        check(afterAssign.status.includes('已指派') && afterAssign.status.includes('攝影'), `指派成功並回報（${afterAssign.status}）`);
        check(afterAssign.titles.some((t) => t.includes('攝影') && t.includes('cam-venue')), '新指派的人出現在清單');
        check(afterAssign.removeButtons === 2, '每列都有移除按鈕');

        const dbRow = staffRows(841).find((r) => String(r.user_id) === '6');
        check(!!dbRow && dbRow.role === 'photographer' && dbRow.note === '負責拍照',
            `資料庫寫入正確（role=${dbRow && dbRow.role}／note=${dbRow && dbRow.note}）`);
        check(staffRows(841).length === 2, '同一場同一人只有一列');
        const assignAudit = auditsOf('ASSIGN_STAFF');
        check(assignAudit.length === 1 && /指派工作人員：cam-venue 為「攝影」（負責拍照）/.test(assignAudit[0].details),
            `留下稽核（${assignAudit[0] && assignAudit[0].details}）`);

        // 卡片徽章要跟著變
        await browser.waitFor(`
            Array.from(document.querySelectorAll('[data-comp-id]')).some((el) => el.textContent.includes('工作人員 2'))
        `, { timeout: 8000 });
        const chipAfter = await cardInfo('地圖測試賽（自動）');
        check(chipAfter.chip.includes('工作人員 2'), `卡片徽章更新為 2（${chipAfter.chip}）`);

        // ---------- ③ 改角色：不會變成兩筆 ----------
        await assignNew('cam-venue', 'recorder', '改當記錄');
        await browser.waitFor(`document.getElementById('staffStatus').textContent.includes('改成')`, { timeout: 8000 });
        const afterChangeRole = await staffSnapshot();
        check(afterChangeRole.status.includes('改成「記錄」'), `改角色回報清楚（${afterChangeRole.status}）`);
        check(afterChangeRole.titles.length === 2 && staffRows(841).length === 2, '改角色不會變成第三筆');
        check(staffRows(841).find((r) => String(r.user_id) === '6').role === 'recorder', '資料庫角色已更新');
        const changeAudit = auditsOf('ASSIGN_STAFF');
        check(/調整工作人員 cam-venue 的角色：攝影 → 記錄/.test(changeAudit[changeAudit.length - 1].details),
            `稽核寫出前後角色（${changeAudit[changeAudit.length - 1].details}）`);

        await browser.screenshot(path.join(SHOTS, '02-管理員指派工作人員.png'));

        // ---------- ④ 移除 ----------
        await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#staffList > div'));
            const row = rows.find((el) => el.textContent.includes('cam-venue'));
            row.querySelector('button[data-staff-remove]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#staffList > div').length === 1`, { timeout: 8000 });
        const afterRemove = await staffSnapshot();
        check(afterRemove.status.includes('已移除 cam-venue'), `移除成功並回報（${afterRemove.status}）`);
        check(staffRows(841).length === 1, '資料庫只剩原本的裁判');
        check(auditsOf('REMOVE_STAFF').length === 1, '移除也留稽核');
        await browser.waitFor(`
            Array.from(document.querySelectorAll('[data-comp-id]')).some((el) => el.textContent.includes('工作人員 1'))
        `, { timeout: 8000 });

        // ---------- ⑤ 一般使用者：看得到清單，看不到操作 ----------
        await logout(browser);
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 3`, { timeout: 15000 });
        await openStaffFor('地圖測試賽（自動）');
        const playerStaff = await staffSnapshot();
        check(playerStaff.titles.length === 1 && playerStaff.titles[0].includes('judge-venue'),
            '一般使用者看得到工作人員清單');
        check(!playerStaff.adminBoxVisible && playerStaff.removeButtons === 0, '一般使用者看不到指派與移除');

        // ---------- ⑥ 表單：地圖連結欄位（只有管理員看得到發佈表單，所以先換回管理員） ----------
        await logout(browser);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.getElementById('submitBtn') !== null`, { timeout: 10000 });
        const fillMapField = (value) => browser.evaluate(`
            const setValue = (id, v) => {
                const el = document.getElementById(id);
                el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            setValue('name', '表單帶地圖連結的賽事');
            setValue('location', '澳門奧林匹克體育中心');
            setValue('date', '2026-12-20');
            setValue('mapUrl', ${JSON.stringify(value)});
            document.getElementById('submitBtn').click();
            return true;
        `);

        // 不安全的連結要先被擋下（後端拒絕、畫面顯示原因）
        await browser.evaluate(`document.getElementById('loginModal').classList.add('hidden'); return true;`);
        await fillMapField('javascript:alert(1)');
        await browser.waitFor(`(window.__ALERTS__ || []).some((m) => m.includes('地圖連結格式不對'))`, { timeout: 10000 });
        const alerts = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__ALERTS__ || []);`));
        check(alerts.some((m) => m.includes('地圖連結格式不對')), '不安全的連結被擋下並說明原因');
        check(state.tables.competitions.every((c) => c.name !== '表單帶地圖連結的賽事'), '被擋下時不會偷偷建立賽事');

        // 合法連結：以填的為準
        await fillMapField('maps.app.goo.gl/form-venue');
        await browser.waitFor(`
            Array.from(document.querySelectorAll('[data-comp-id]')).some((el) => el.textContent.includes('表單帶地圖連結的賽事'))
        `, { timeout: 12000 });
        const formCard = await cardInfo('表單帶地圖連結的賽事');
        check(formCard.href === 'https://maps.app.goo.gl/form-venue', `表單填的連結生效（${formCard.href}）`);

        // 留空：用地址自動產生
        await fillMapField('');
        await browser.evaluate(`
            const setValue = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
            setValue('name', '表單留空的賽事');
            document.getElementById('submitBtn').click();
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('[data-comp-id]')).some((el) => el.textContent.includes('表單留空的賽事'))
        `, { timeout: 12000 });
        const emptyCard = await cardInfo('表單留空的賽事');
        check(emptyCard.href === CMVenue.autoMapUrl('澳門奧林匹克體育中心'),
            `留空＝用地址自動產生（${emptyCard.href.slice(0, 60)}）`);

        await browser.screenshot(path.join(SHOTS, '03-一般使用者看工作人員.png'));

        // ---------- ⑦ 沒有例外、沒有下載 ----------
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
    console.log(`\n══════ 場地與工作人員介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
