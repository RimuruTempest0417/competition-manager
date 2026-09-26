/* v2.21.0：用手機尺寸的真實 Chrome 驗證「候補順位手動調整」與「指定遞補」
 *
 * 驗的是管理員真的操作得到的東西：
 *   - 候補名單每列的 ↑／↓（移動順位）與「⬆️ 遞補」（跳過前面的人）按鈕
 *   - 順位來源說明（依報名時間／管理員手動排定）
 *   - 點 ↑ 之後：畫面順序、資料庫的 waitlist_order、重新開啟後仍然保持
 *   - 指定遞補真的補到「指定的那一位」，且留下稽核與推播紀錄
 *   - 名額已滿時遞補按鈕停用（含每列與區塊層級）
 *   - 一般用戶看不到這些按鈕、直接打 API 會被 403
 *   - 被調整順位的人，在自己的「我的報名」看到的順位也跟著變
 *
 * 用法：node tests/browser/waitlist-manage-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3312);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-waitlist-check');
const ADMIN = 'owner-waitlist';
const PASS = 'checkpass123';

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
                { id: 93, username: 'waitCuser', password: 'userpass123', role: 'user', is_active: true }
            ],
            competitions: [
                // 名額 2、開放候補、不需審核：1 已核准 + 3 位候補
                { id: 811, name: '候補排隊賽', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 2, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-01T00:00:00.000Z' }
            ],
            registrations: [
                { id: 2101, competition_id: 811, user_id: 90, username: 'taken', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
                { id: 2102, competition_id: 811, user_id: 91, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z', waitlist_order: null },
                { id: 2103, competition_id: 811, user_id: 92, username: 'waitB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z', waitlist_order: null },
                { id: 2104, competition_id: 811, user_id: 93, username: 'waitC', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T03:00:00Z', waitlist_order: null }
            ],
            audit_logs: [],
            error_logs: [],
            push_subscriptions: [],
            push_log: []
        },
        nextId: { competitions: 900, registrations: 2200, audit_logs: 900, error_logs: 900, push_log: 10 },
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
    console.log(`\n🧪 候補順位與指定遞補介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        // 目前畫面上的候補順序（讀文字，模擬管理員看到的）
        const order = () => browser.evaluate(`
            return Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1] || '?');
        `);
        const ordersInDb = () => [2102, 2103, 2104].map((id) => {
            const r = state.tables.registrations.find((x) => x.id === id);
            return `${r.username}:${r.waitlist_order === null || r.waitlist_order === undefined ? '-' : r.waitlist_order}`;
        }).join(' ');

        const openTeam = async (expect) => {
            await browser.evaluate(`
                document.querySelector('[data-comp-id="811"] [data-action="manage-teams"]').click();
                return true;
            `);
            await browser.waitFor(`!document.getElementById('teamModal').classList.contains('hidden')`, { timeout: 8000 });
            await browser.waitFor(`document.getElementById('teamModal').textContent.includes(${JSON.stringify(expect)})`, { timeout: 12000 });
        };

        // ---------- 1. 初始狀態 ----------
        await openTeam('🙋 waitA');
        check(JSON.stringify(await order()) === JSON.stringify(['waitA', 'waitB', 'waitC']),
            `初始候補順序依報名時間（${(await order()).join(' → ')}）`);
        const note = await browser.evaluate(`return document.getElementById('waitlistOrderNote').textContent;`);
        check(/依報名時間自動排序/.test(note), `順位來源寫「依報名時間自動排序」（${note}）`);
        check(/手動調整/.test(note), '說明會提示可以手動調整');

        const buttons = await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'));
            return JSON.stringify(rows.map((row) => ({
                name: (row.textContent.match(/🙋\\s*(\\S+)/) || [])[1],
                up: !!row.querySelector('[data-action="waitlist-move"][data-dir="up"]'),
                down: !!row.querySelector('[data-action="waitlist-move"][data-dir="down"]'),
                promote: !!row.querySelector('[data-action="promote-reg"]')
            })));
        `);
        const parsed = JSON.parse(buttons);
        check(parsed.length === 3 && parsed.every((r) => r.up && r.down && r.promote), `每列都有 ↑／↓／遞補 三顆按鈕（${buttons}）`);
        check(await browser.evaluate(`return document.querySelector('#waitlistList [data-waitlist-id]:first-child [data-dir="up"]').disabled;`),
            '第一列的 ↑ 是停用的（已是最前面）');
        check(await browser.evaluate(`return document.querySelector('#waitlistList [data-waitlist-id]:last-child [data-dir="down"]').disabled;`),
            '最後一列的 ↓ 是停用的');
        const promoteDisabledNow = await browser.evaluate(`return document.querySelector('#waitlistList [data-action="promote-reg"]').disabled;`);
        check(promoteDisabledNow === false, '名額還有時「遞補」可以按');
        await browser.screenshot(path.join(SHOTS, '01-候補名單按鈕.png'));

        // ---------- 2. 往上移一位 ----------
        const upClick = () => browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .find((el) => el.textContent.includes('waitC'));
            row.querySelector('[data-dir="up"]').click();
            return true;
        `);
        await upClick();
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitA,waitC,waitB'
        `, { timeout: 12000 });
        check(true, `按「↑」後畫面順序變成 waitA → waitC → waitB`);
        check(ordersInDb() === 'waitA:1 waitB:3 waitC:2', `資料庫依畫面順序寫入 1/2/3（${ordersInDb()}）`);
        const noteAfter = await browser.evaluate(`return document.getElementById('waitlistOrderNote').textContent;`);
        check(/管理員手動排定/.test(noteAfter), `說明改成「管理員手動排定」（${noteAfter}）`);
        check(/新報名的人一律排到最後/.test(noteAfter), '說明會提醒新報名的人排在最後');
        await browser.screenshot(path.join(SHOTS, '02-調整後.png'));

        // ---------- 3. 再往上移到第一位 ----------
        await upClick();
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitC,waitA,waitB'
        `, { timeout: 12000 });
        check(true, '再按一次「↑」把 waitC 移到第一位');
        check(ordersInDb() === 'waitA:2 waitB:3 waitC:1', `資料庫順位同步（${ordersInDb()}）`);

        // ---------- 4. 關掉再開，順序要留著（真的存進資料庫） ----------
        await browser.evaluate(`document.getElementById('closeTeamModalBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 400));
        await openTeam('🙋 waitC');
        check(JSON.stringify(await order()) === JSON.stringify(['waitC', 'waitA', 'waitB']),
            `重新開啟後順序保持（${(await order()).join(' → ')}）`);

        // ---------- 5. 指定遞補（跳過第一位） ----------
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .find((el) => el.textContent.includes('waitA'));
            row.querySelector('[data-action="promote-reg"]').click();
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).length === 2
        `, { timeout: 15000 });
        check(state.tables.registrations.find((r) => r.id === 2102).status === 'confirmed',
            '指定遞補的是 waitA（跳過排第一的 waitC）');
        check(state.tables.registrations.find((r) => r.id === 2104).status === 'waitlisted',
            '原本第一順位的 waitC 沒有被動到');
        check(/指定遞補（原第 2 順位）/.test(String(state.tables.registrations.find((r) => r.id === 2102).review_note)),
            '遞補原因記下「原第 2 順位」（看得出不是照順位）');
        const msg = await browser.evaluate(`return document.getElementById('teamMsg').textContent;`);
        check(/已遞補 waitA/.test(msg) && /推播訂閱/.test(msg), `畫面回報遞補結果與通知狀況（${msg.slice(0, 60)}）`);
        const confirmCalled = await browser.evaluate(`return window.__ALERTS__.length;`);
        check(confirmCalled === 0, '指定遞補不會跳出 alert（改用確認框）');

        // 稽核與推播紀錄
        const auditText = JSON.stringify(state.tables.audit_logs);
        check(/REORDER_WAITLIST/.test(auditText), '調整順位留下稽核（REORDER_WAITLIST）');
        check(/PROMOTE_WAITLIST/.test(auditText) && /未照順位/.test(auditText), '指定遞補留下稽核並註明「未照順位」');
        check(JSON.stringify(state.tables.push_log).includes('waitlist_promoted'), '遞補寫入推播紀錄');

        // ---------- 6. 名額已滿 → 遞補按鈕停用 ----------
        check(await browser.evaluate(`return document.querySelector('#waitlistList [data-action="promote-reg"]').disabled;`),
            '名額已滿後每一列的「遞補」都停用（taken + waitA 已佔滿 2 個名額）');
        const sectionBtn = await browser.evaluate(`return document.getElementById('promoteWaitlistBtn').disabled;`);
        check(sectionBtn === true, '區塊層級的「遞補下一位」也停用');
        check(await browser.evaluate(`return document.getElementById('waitlistOrderNote').textContent.includes('等待') === false;`), '說明文字正常顯示（沒有卡在載入狀態）');
        await browser.screenshot(path.join(SHOTS, '03-名額已滿按鈕停用.png'));

        // 後端也要擋（前端停用只是體驗）
        const blocked = await browser.evaluate(`
            const res = await fetch('/api/registrations/2104/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
                body: '{}'
            });
            return res.status;
        `);
        check(blocked === 400, `即使硬打 API 也會被擋（HTTP ${blocked}）`);

        // ---------- 7. 一般用戶：看不到按鈕、API 403、我的報名順位同步 ----------
        // 最後再調一次（把 waitB 換到第一位），用來驗「我的報名」跟著最新的手動順位走
        const reorderStatus = await browser.evaluate(`
            const res = await fetch('/api/competitions/811/waitlist/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
                body: JSON.stringify({ order: [2103, 2104] })
            });
            return res.status;
        `);
        check(reorderStatus === 200, `管理員調整順位成功（HTTP ${reorderStatus}）`);
        check(state.tables.registrations.find((r) => r.id === 2103).waitlist_order === 1
            && state.tables.registrations.find((r) => r.id === 2104).waitlist_order === 2, '這次調整也寫進資料庫');

        await browser.evaluate(`window.localStorage.clear(); return true;`);
        await browser.goto(BASE);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, 'waitCuser', 'userpass123');
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });
        const userHasButtons = await browser.evaluate(`
            return document.querySelectorAll('[data-action="manage-teams"]').length;
        `);
        check(userHasButtons === 0, '一般用戶看不到「報名／隊伍」入口（因此也看不到候補按鈕）');

        const forbidden = await browser.evaluate(`
            const res = await fetch('/api/competitions/811/waitlist/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
                body: JSON.stringify({ order: [2104, 2103] })
            });
            return res.status;
        `);
        check(forbidden === 403, `一般用戶直接打調整順位 API 會被擋（HTTP ${forbidden}）`);

        await browser.evaluate(`
            document.getElementById('navDropdown')?.classList.remove('hidden');
            document.getElementById('myRegsBtn')?.click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('myRegsModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#myRegsList > div').length > 0`, { timeout: 10000 });
        const myText = await browser.evaluate(`return document.getElementById('myRegsList').textContent.replace(/\\s+/g, ' ');`);
        check(/候補 第 2 位/.test(myText), `我的報名顯示管理員排定的順位（剛被調到第 2 位）（${myText.slice(0, 80)}）`);
        await browser.screenshot(path.join(SHOTS, '04-我的報名順位.png'));

        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 候補順位與指定遞補介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err, err.message);
    process.exit(1);
});
