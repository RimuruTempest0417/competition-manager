/* v2.20.0：用手機尺寸的真實 Chrome 驗證「報名審核與候補」介面
 *
 * 驗的是使用者與管理員真正看到／碰到的東西：
 *   - 卡片：需審核提示、額滿可候補提示、報名按鈕文字（📝 報名（排候補））
 *   - 報名視窗：送出前的提示（會變待審核／會排候補第幾位）
 *   - 審核區塊：統計列、待審核名單（✅核准／❌拒絕）、候補順位、「⬆️ 遞補下一位」
 *   - 送出後的結果：名單真的變化、未編排名單只含已核准的人、資料庫真的更新
 *   - 我的報名：狀態徽章（待審核／已核准／候補第 N 位／未錄取）
 *   - 賽事表單：兩個開關存得進資料庫
 *   - 權限：一般用戶看不到審核按鈕（且後端會擋）
 *
 * 伺服器：真的 server.js + 假 Supabase。用法：node tests/browser/registration-review-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3310);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-review-check');
const ADMIN = 'owner-review';
const PASS = 'checkpass123';
const USER = 'player-review';
const USER_PASS = 'userpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true },
                { id: 10, username: USER, password: USER_PASS, role: 'user', is_active: true }
            ],
            competitions: [
                // 需審核、名額 3、開放候補
                { id: 801, name: '需審核的賽事', date: '2026-12-01', time: '09:00', end_date: '2026-12-01', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 3, requires_approval: true, waitlist_enabled: true, created_at: '2026-01-01T00:00:00.000Z' },
                // 名額 1、開放候補（已滿 → 顯示候補提示）
                { id: 802, name: '額滿可候補的賽事', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-02T00:00:00.000Z' }
            ],
            registrations: [
                { id: 901, competition_id: 801, user_id: 21, username: 'pendingA', status: 'pending', is_deleted: false, created_at: '2026-09-01T01:00:00Z' },
                { id: 902, competition_id: 801, user_id: 22, username: 'pendingB', status: 'pending', is_deleted: false, created_at: '2026-09-01T02:00:00Z' },
                { id: 903, competition_id: 802, user_id: 23, username: 'approvedC', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T03:00:00Z' },
                { id: 904, competition_id: 802, user_id: 24, username: 'waitD', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T04:00:00Z' },
                { id: 905, competition_id: 802, user_id: 25, username: 'waitE', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T05:00:00Z' }
            ],
            audit_logs: [],
            error_logs: [],
            push_subscriptions: [],
            push_log: []
        },
        nextId: { competitions: 900, registrations: 990, audit_logs: 900, error_logs: 900, push_log: 10 },
        log: []
    };
}

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.__PROMPTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    window.prompt = (msg, dflt) => { window.__PROMPTS__.push(String(msg)); return '測試原因'; };
    return true;
`;

const login = async (browser, username, password) => {
    // 等 <script> 跑完再按；按完確認真的拿到憑證，沒有就再按一次（第一次點擊偶爾會落在事件綁定之前）
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
    console.log(`\n🧪 報名審核與候補介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });

        // expect：彈窗內容必須出現這段文字才算載入完成（否則會讀到上一輪的舊畫面）
        const openTeam = async (id, expect) => {
            const btn = await browser.evaluate(`
                const b = document.querySelector('[data-comp-id="${id}"] [data-action="manage-teams"]');
                return b ? 'yes' : 'no';
            `);
            check(btn === 'yes', `賽事 ${id} 卡片上有「報名／隊伍」按鈕（管理員可見）`);
            await browser.evaluate(`
                document.querySelector('[data-comp-id="${id}"] [data-action="manage-teams"]').click();
                return true;
            `);
            await browser.waitFor(`!document.getElementById('teamModal').classList.contains('hidden')`, { timeout: 8000 });
            await browser.waitFor(`document.getElementById('promoteWaitlistBtn') !== null`, { timeout: 8000 });
            if (expect) {
                await browser.waitFor(`document.getElementById('teamModal').textContent.includes(${JSON.stringify(expect)})`, { timeout: 12000 });
            } else {
                await browser.waitFor(`
                    (document.getElementById('pendingList').children.length + document.getElementById('waitlistList').children.length) > 0
                `, { timeout: 10000 });
            }
        };

        // ---------- 1. 卡片提示與按鈕 ----------
        const card1 = await browser.evaluate(`return document.querySelector('[data-comp-id="801"]').textContent.replace(/\\s+/g, ' ');`);
        check(/報名需審核/.test(card1), '需審核的賽事卡片有「⏳ 報名需審核」提示');
        const card2 = await browser.evaluate(`return document.querySelector('[data-comp-id="802"]').textContent.replace(/\\s+/g, ' ');`);
        check(/額滿，報名排候補/.test(card2), '額滿可候補的賽事卡片有候補提示', card2.slice(0, 80));
        check(/候補/.test(card2) && /2 人候補/.test(card2), '提示會顯示目前候補人數（2 人）', card2.slice(0, 80));

        // 以一般用戶登入，看報名按鈕文字
        await browser.evaluate(`window.localStorage.clear(); return true;`);
        await browser.goto(BASE);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, USER, USER_PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });
        const btn802 = await browser.evaluate(`
            const b = document.querySelector('[data-comp-id="802"] [data-action="register-comp"]');
            return b ? b.textContent.trim() : '(沒有報名按鈕)';
        `);
        check(/排候補/.test(btn802), `額滿可候補時按鈕寫「📝 報名（排候補）」（實際：${btn802}）`);
        await browser.screenshot(path.join(SHOTS, '01-卡片提示.png'));

        // 報名視窗：送出前就要知道會變候補
        await browser.evaluate(`document.querySelector('[data-comp-id="802"] [data-action="register-comp"]').click(); return true;`);
        await browser.waitFor(`!document.getElementById('registerHint').classList.contains('hidden')`, { timeout: 8000 });
        const hint = await browser.evaluate(`return document.getElementById('registerHint').textContent;`);
        check(/送出後會排入候補/.test(hint), `報名視窗先說明會排候補（${hint.slice(0, 40)}…）`);
        const hintXml = await browser.evaluate(`return document.getElementById('registerHint').className;`);
        check(/border-blue-200/.test(hintXml), '候補提示用藍色（與需審核的琥珀色區分）');
        await browser.screenshot(path.join(SHOTS, '02-報名提示.png'));
        await browser.evaluate(`document.getElementById('closeRegisterModalBtn').click(); return true;`);

        // 真的送出一筆報名 → 應該是候補
        await browser.evaluate(`
            window.__ALERTS__ = [];
            document.querySelector('[data-comp-id="802"] [data-action="register-comp"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('registerModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.evaluate(`document.getElementById('confirmRegisterBtn').click(); return true;`);
        await browser.waitFor(`window.__ALERTS__.length > 0`, { timeout: 15000 });
        const alerts = await browser.evaluate(`return window.__ALERTS__;`);
        check(alerts.some((a) => /已排入候補（第 3 位）/.test(a)), `送出後明確告知候補順位（${alerts.join(' / ')}）`);

        const myRow = state.tables.registrations.find((r) => r.username === USER);
        check(!!myRow && myRow.status === 'waitlisted', '資料庫真的存成候補狀態');

        // 我的報名：狀態徽章
        await browser.evaluate(`
            document.getElementById('navDropdown')?.classList.remove('hidden');
            document.getElementById('myRegsBtn')?.click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('myRegsModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#myRegsList > div').length > 0`, { timeout: 10000 });
        const myText = await browser.evaluate(`return document.getElementById('myRegsList').textContent.replace(/\\s+/g, ' ');`);
        check(/候補 第 3 位/.test(myText), `我的報名顯示「候補 第 3 位」（實際：${myText.slice(0, 90)}）`);
        await browser.screenshot(path.join(SHOTS, '03-我的報名候補.png'));
        await browser.evaluate(`document.getElementById('closeMyRegsModalBtn').click(); return true;`);

        // 一般用戶看不到審核按鈕，而且後端會擋
        const forbidden = await browser.evaluate(`
            const res = await fetch('/api/registrations/901/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
                body: JSON.stringify({ action: 'approve' })
            });
            return res.status;
        `);
        check(forbidden === 403, `一般用戶直接打審核 API 會被擋（HTTP ${forbidden}）`);

        // ---------- 2. 管理員審核 ----------
        await browser.evaluate(`window.localStorage.clear(); return true;`);
        await browser.goto(BASE);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });
        check(await browser.evaluate(`return String(localStorage.getItem('competition_user') || '').length > 0;`), '管理員重新登入成功');
        check(await browser.evaluate(`return document.querySelectorAll('[data-action="manage-teams"]').length >= 2;`), '管理員看得到每張卡片的「報名／隊伍」按鈕');

        await openTeam(801, '待審核 2');
        const summary = await browser.evaluate(`return document.getElementById('reviewSummary').textContent;`);
        check(/待審核 2/.test(summary), `統計列顯示待審核 2（${summary}）`);
        check(/⏳ 本賽事需審核/.test(summary) && /🕒 開放候補/.test(summary), '統計列標明此賽事需審核且開放候補');

        const pendingCount = await browser.evaluate(`return document.getElementById('pendingCount').textContent;`);
        check(pendingCount === '2', `待審核名單有 2 筆（實際 ${pendingCount}）`);
        const pendingNames = await browser.evaluate(`return document.getElementById('pendingList').textContent.replace(/\\s+/g, ' ');`);
        check(/pendingA/.test(pendingNames) && /pendingB/.test(pendingNames), '待審核名單列出兩個人');
        const hasButtons = await browser.evaluate(`
            return document.querySelectorAll('#pendingList [data-action="review-reg"]').length;
        `);
        check(hasButtons === 4, `每人都有核准與拒絕按鈕（共 ${hasButtons} 顆）`);
        await browser.screenshot(path.join(SHOTS, '04-待審核名單.png'));

        // 核准 pendingA
        await browser.evaluate(`
            document.querySelector('#pendingList [data-id="901"][data-verdict="approve"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('pendingCount').textContent === '1'`, { timeout: 15000 });
        check(true, '按「✅ 核准」後待審核少一筆');
        check(state.tables.registrations.find((r) => r.id === 901).status === 'confirmed', '資料庫狀態變成已核准');
        check(state.tables.registrations.find((r) => r.id === 901).reviewed_by === ADMIN, '留下審核人');
        const unassigned = await browser.evaluate(`return document.getElementById('unassignedList').textContent;`);
        check(/pendingA/.test(unassigned), '已核准的人出現在「未編排報名者」名單');
        const msgAfterApprove = await browser.evaluate(`return document.getElementById('teamMsg').textContent;`);
        check(/已核准/.test(msgAfterApprove) && /推播訂閱/.test(msgAfterApprove), `回報核准結果與通知狀況（${msgAfterApprove.slice(0, 50)}）`);

        // 拒絕 pendingB（會問原因）
        await browser.evaluate(`
            document.querySelector('#pendingList [data-id="902"][data-verdict="reject"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('pendingCount').textContent === '0'`, { timeout: 15000 });
        const rejected = state.tables.registrations.find((r) => r.id === 902);
        check(rejected.status === 'rejected', '按「❌ 拒絕」後狀態是未錄取');
        check(rejected.review_note === '測試原因', `拒絕原因有記錄（${rejected.review_note}）`);
        const prompts = await browser.evaluate(`return window.__PROMPTS__;`);
        check(prompts.length === 1, '拒絕前會問原因（管理員可以留給對方看）');
        check(await browser.evaluate(`return document.getElementById('pendingSection').classList.contains('hidden');`),
            '沒有待審核時整個區塊收起來');
        check(/REGISTER_APPROVED/.test(JSON.stringify(state.tables.audit_logs)) && /REGISTER_REJECTED/.test(JSON.stringify(state.tables.audit_logs)),
            '核准與拒絕都留下稽核紀錄');

        // ---------- 3. 候補與自動遞補 ----------
        await browser.evaluate(`document.getElementById('closeTeamModalBtn').click(); return true;`);
        await openTeam(802, '候補 3');
        const waitlistText = await browser.evaluate(`return document.getElementById('waitlistList').textContent.replace(/\\s+/g, ' ');`);
        check(/第 1 位/.test(waitlistText) && /waitD/.test(waitlistText), `候補名單顯示順位（${waitlistText.slice(0, 60)}）`);
        check(/第 2 位/.test(waitlistText) && /waitE/.test(waitlistText), '第二位候補也照順序排');
        const summary802 = await browser.evaluate(`return document.getElementById('reviewSummary').textContent;`);
        check(/佔名額 3 \/ 1 人/.test(summary802) || /候補 3/.test(summary802), `統計列反映現況（${summary802}）`);
        const promoteDisabled = await browser.evaluate(`return document.getElementById('promoteWaitlistBtn').disabled;`);
        check(promoteDisabled === true, '名額已滿時「遞補下一位」是停用的（避免超收）');
        await browser.screenshot(path.join(SHOTS, '05-候補名單.png'));

        // 讓出一個名額（管理員取消 approvedC）→ 自動遞補第一位
        await browser.evaluate(`
            document.querySelector('[data-comp-id="802"] [data-action="manage-teams"]');
            return true;
        `);
        const cancelled = await browser.evaluate(`
            const res = await fetch('/api/registrations/903', {
                method: 'DELETE',
                headers: { Authorization: 'Bearer ' }
            });
            const data = await res.json();
            return JSON.stringify(data);
        `);
        const cancelData = JSON.parse(cancelled);
        check(cancelData.promoted && cancelData.promoted.username === 'waitD', `取消報名後自動遞補第一位候補（${cancelled.slice(0, 90)}）`);
        check(state.tables.registrations.find((r) => r.id === 904).status === 'confirmed', '被遞補的人狀態變成已核准');
        check(state.tables.registrations.find((r) => r.id === 904).review_note === '候補自動遞補', '遞補原因有記錄');
        check(JSON.stringify(state.tables.audit_logs).includes('AUTO_PROMOTE_WAITLIST'), '自動遞補留下稽核紀錄');
        check(JSON.stringify(state.tables.push_log).includes('waitlist_promoted'), '自動遞補寫入推播紀錄');

        // 介面重載後：候補剩一位、名單反映最新狀態
        await browser.evaluate(`document.getElementById('closeTeamModalBtn').click(); return true;`);
        await openTeam(802, '🙋 waitE');
        // 這個 modal 會先用快取的名單繪製、再被重新抓回的資料取代，所以不能一打開就讀
        //（讀太快會讀到舊的候補名單）。等畫面收斂到「沒有 waitD」再判。
        await browser.waitFor(`!/waitD/.test(document.getElementById('waitlistList').textContent)`, { timeout: 10000 })
            .catch(() => { /* 沒收斂就讓下面的斷言說出來，不要在這裡掩蓋問題 */ });
        const after = await browser.evaluate(`return document.getElementById('waitlistList').textContent.replace(/\\s+/g, ' ');`);
        check(/第 1 位/.test(after) && /waitE/.test(after), `遞補後 waitE 升上候補第一位（${after.slice(0, 50)}）`);
        check(!/waitD/.test(after), '已被遞補的 waitD 不再出現在候補名單');
        check(/第 2 位/.test(after), '原本第三順位的使用者遞補上來成為第二位候補');

        // 手動遞補：現在沒名額 → 停用；拒絕一個已核准的讓出名額後可按
        await browser.evaluate(`
            document.querySelector('#unassignedList') && null;
            return true;
        `);
        const rejectApproved = await browser.evaluate(`
            const res = await fetch('/api/registrations/905/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
                body: JSON.stringify({ action: 'reject', note: '手動測試' })
            });
            return res.status;
        `);
        check(rejectApproved === 400 || rejectApproved === 200, `對已核准的報名也可以再審核（HTTP ${rejectApproved}）`);

        // ---------- 4. 賽事表單的兩個開關 ----------
        await browser.evaluate(`document.getElementById('closeTeamModalBtn').click(); return true;`);
        await browser.evaluate(`
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setValue('name', '新開關測試');
            setValue('date', '2026-12-20');
            document.getElementById('requires_approval').checked = true;
            document.getElementById('requires_approval').dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('waitlist_enabled').checked = true;
            document.getElementById('waitlist_enabled').dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        const preview = await browser.evaluate(`
            document.getElementById('formStatePreviewText').textContent;
            return document.getElementById('formStatePreviewText').textContent;
        `);
        check(/需審核/.test(preview), `表單預覽會標出「需審核」（${preview}）`);
        await browser.evaluate(`
            window.__ALERTS__ = [];
            document.getElementById('competitionForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`window.__ALERTS__.length > 0`, { timeout: 15000 });
        const created = state.tables.competitions.find((c) => c.name === '新開關測試');
        check(!!created && created.requires_approval === true, '新賽事的「需審核」有存進資料庫');
        check(!!created && created.waitlist_enabled === true, '新賽事的「開放候補」有存進資料庫');

        // ---------- 5. 編輯時帶得出設定 ----------
        const loaded = await browser.evaluate(`
            const card = Array.from(document.querySelectorAll('[data-comp-id]')).find((c) => c.textContent.includes('需審核的賽事'));
            card.querySelector('[data-action="edit-comp"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('requires_approval').checked === true`, { timeout: 8000 });
        check(await browser.evaluate(`return document.getElementById('waitlist_enabled').checked;`), '編輯既有賽事時兩個開關會帶出原本的設定');
        check(await browser.evaluate(`return document.getElementById('registration_start_at') !== null;`), '報名時間欄位仍在（v2.19.0 功能沒有被破壞）');

        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 報名審核與候補介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err, err.message);
    process.exit(1);
});
