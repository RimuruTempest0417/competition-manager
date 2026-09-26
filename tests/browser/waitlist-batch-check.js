/* v2.23.0：用手機尺寸的真實 Chrome 驗證「候補收尾」的兩件事
 *
 * 驗的是管理員真的操作得到的東西：
 *   ① 多選一次搬多筆：勾選兩筆 → 批次列出現並顯示「已選 2 筆」與可放的最後位置 →
 *      「搬到第 1 位」後畫面與資料庫同步、勾選自動清空；「清除選取」會收起批次列
 *   ② 異動紀錄可以往回翻：第一頁 30 筆＋「載入更早」→ 第二頁接在後面、不重複也不漏，
 *      全部載完按鈕自動收起、說明改成「已顯示全部 N 筆」
 *
 * 用法：node tests/browser/waitlist-batch-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3314);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-waitlist-batch-check');
const ADMIN = 'owner-waitlist-batch';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* 40 筆種子稽核紀錄（時間遞增，最新的是「種子紀錄 40」）→ 用來驗分頁 */
const seedAudit = () => Array.from({ length: 40 }, (_, i) => ({
    id: 5000 + i,
    action: i % 3 === 0 ? 'REORDER_WAITLIST' : (i % 3 === 1 ? 'PROMOTE_WAITLIST' : 'REGISTER_APPROVED'),
    target_id: 811,
    user_id: 'owner',
    details: `種子紀錄 ${i + 1}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    user_agent: 'seed'
}));

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true }],
            competitions: [
                { id: 811, name: '批次搬移賽', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 4, requires_approval: false, waitlist_enabled: true, waitlist_notify: true, created_at: '2026-01-01T00:00:00.000Z' }
            ],
            registrations: [
                { id: 2101, competition_id: 811, user_id: 90, username: 'taken', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' },
                { id: 2102, competition_id: 811, user_id: 91, username: 'waitA', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T01:00:00Z', waitlist_order: null },
                { id: 2103, competition_id: 811, user_id: 92, username: 'waitB', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z', waitlist_order: null },
                { id: 2104, competition_id: 811, user_id: 93, username: 'waitC', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T03:00:00Z', waitlist_order: null },
                { id: 2105, competition_id: 811, user_id: 94, username: 'waitD', status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T04:00:00Z', waitlist_order: null }
            ],
            audit_logs: seedAudit(),
            error_logs: [],
            push_subscriptions: [],
            push_log: []
        },
        nextId: { competitions: 900, registrations: 2200, audit_logs: 9000, error_logs: 900, push_log: 10 },
        log: []
    };
}

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
    console.log(`\n🧪 候補收尾（批次搬移／異動紀錄分頁）介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        const order = () => browser.evaluate(`
            return Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1] || '?');
        `);
        const ordersInDb = () => [2102, 2103, 2104, 2105].map((id) => {
            const r = state.tables.registrations.find((x) => x.id === id);
            return `${r.username}:${r.waitlist_order === null || r.waitlist_order === undefined ? '-' : r.waitlist_order}`;
        }).join(' ');
        const teamMsg = () => browser.evaluate(`return (document.getElementById('teamMsg') || {}).innerText || '';`);
        const historyRows = () => browser.evaluate(`return document.querySelectorAll('#waitlistHistoryList > div').length;`);

        await browser.evaluate(`
            document.querySelector('[data-comp-id="811"] [data-action="manage-teams"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('teamModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.getElementById('teamModal').textContent.includes('🙋 waitA')`, { timeout: 12000 });

        // ---------- 1. 勾選框與批次列 ----------
        const boxes = await browser.evaluate(`return document.querySelectorAll('#waitlistList input[data-action="waitlist-select"]').length;`);
        check(boxes === 4, `每列都有勾選框（${boxes} 個）`);
        check(await browser.evaluate(`return document.getElementById('waitlistBatchBar').classList.contains('hidden');`),
            '還沒勾選時批次列是收起的');

        await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'));
            ['waitC', 'waitB'].forEach((name) => {
                const row = rows.find((el) => el.textContent.includes(name));
                const box = row.querySelector('input[data-action="waitlist-select"]');
                box.checked = true;
                box.dispatchEvent(new Event('change', { bubbles: true }));
            });
            return true;
        `);
        check(!(await browser.evaluate(`return document.getElementById('waitlistBatchBar').classList.contains('hidden');`)),
            '勾選兩筆後批次列出現');
        check(String(await browser.evaluate(`return document.getElementById('waitlistSelectedCount').innerText;`)) === '2',
            '批次列顯示「已選 2 筆」');
        const targets = await browser.evaluate(`
            return JSON.stringify({ options: document.getElementById('waitlistBatchTarget').options.length,
                last: document.getElementById('waitlistBatchTarget').options[document.getElementById('waitlistBatchTarget').options.length - 1].textContent });
        `);
        check(JSON.parse(targets).last === '第 3 位',
            `一次搬 2 筆時最後只能放到第 3 位（${targets}）`);
        await browser.screenshot(path.join(SHOTS, '01-批次搬移列.png'));

        // ---------- 2. 清除選取 ----------
        await browser.evaluate(`document.getElementById('waitlistBatchClear').click(); return true;`);
        await browser.waitFor(`document.getElementById('waitlistBatchBar').classList.contains('hidden')`, { timeout: 5000 });
        check(true, '按「清除選取」後批次列收起');
        const stillChecked = await browser.evaluate(`return document.querySelectorAll('#waitlistList input[data-action="waitlist-select"]:checked').length;`);
        check(stillChecked === 0, '勾選狀態全部清空');

        // ---------- 3. 異動紀錄分頁（此時 40 筆種子紀錄，還沒動過名單） ----------
        await browser.evaluate(`document.getElementById('waitlistHistoryBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('waitlistHistoryPanel').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#waitlistHistoryList > div').length > 0`, { timeout: 10000 });
        check(await historyRows() === 30, `第一頁顯示 30 筆（實際 ${await historyRows()}）`);
        const note1 = await browser.evaluate(`return document.getElementById('waitlistHistoryNote').innerText;`);
        check(/已顯示 30 筆/.test(note1), `說明顯示「已顯示 30 筆」（${note1}）`);
        check(!(await browser.evaluate(`return document.getElementById('waitlistHistoryMore').classList.contains('hidden');`)),
            '「載入更早」按鈕出現');
        const newest = await browser.evaluate(`return document.querySelector('#waitlistHistoryList > div').innerText;`);
        check(/種子紀錄 40/.test(newest), `第一筆是最新的紀錄（${newest.slice(0, 40).replace(/\n/g, ' ')}）`);
        await browser.screenshot(path.join(SHOTS, '02-紀錄第一頁.png'));

        await browser.evaluate(`document.getElementById('waitlistHistoryMore').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#waitlistHistoryList > div').length > 30`, { timeout: 10000 });
        check(await historyRows() === 40, `載入更早後累積 40 筆（實際 ${await historyRows()}）`);
        const note2 = await browser.evaluate(`return document.getElementById('waitlistHistoryNote').innerText;`);
        check(/已顯示全部 40 筆/.test(note2), `說明改成「已顯示全部 40 筆」（${note2}）`);
        check(await browser.evaluate(`return document.getElementById('waitlistHistoryMore').classList.contains('hidden');`),
            '全部載完後「載入更早」自動收起');
        const oldest = await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#waitlistHistoryList > div'));
            return rows[rows.length - 1].innerText;
        `);
        check(/種子紀錄 1$/.test(oldest.trim()) || /種子紀錄 1\b/.test(oldest), `最後一筆是最早的紀錄（${oldest.slice(0, 40).replace(/\n/g, ' ')}）`);
        const unique = await browser.evaluate(`
            const texts = Array.from(document.querySelectorAll('#waitlistHistoryList > div')).map((d) => d.innerText);
            return JSON.stringify({ total: texts.length, unique: new Set(texts).size });
        `);
        check(JSON.parse(unique).total === JSON.parse(unique).unique, `兩頁之間沒有重複（${unique}）`);
        await browser.screenshot(path.join(SHOTS, '03-紀錄第二頁.png'));
        await browser.evaluate(`document.getElementById('waitlistHistoryClose').click(); return true;`);

        // ---------- 4. 多選搬到最前面 ----------
        await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'));
            ['waitD', 'waitC'].forEach((name) => {
                const row = rows.find((el) => el.textContent.includes(name));
                const box = row.querySelector('input[data-action="waitlist-select"]');
                box.checked = true;
                box.dispatchEvent(new Event('change', { bubbles: true }));
            });
            document.getElementById('waitlistBatchTarget').value = '1';
            document.getElementById('waitlistBatchMove').click();
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitC,waitD,waitA,waitB'
        `, { timeout: 12000 });
        check(true, '勾選 waitC／waitD 搬到第 1 位後：waitC → waitD → waitA → waitB');
        check(ordersInDb() === 'waitA:3 waitB:4 waitC:1 waitD:2', `資料庫順位同步（${ordersInDb()}）`);
        check(/已把選取的 2 筆一起搬到第 1 位/.test(await teamMsg()),
            `有回報訊息（${(await teamMsg()).slice(0, 40)}）`);
        check(await browser.evaluate(`return document.getElementById('waitlistBatchBar').classList.contains('hidden');`),
            '搬完後勾選自動清空、批次列收起');
        await browser.screenshot(path.join(SHOTS, '04-批次搬移後.png'));

        // ---------- 5. 單筆勾選搬到中間 ----------
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .find((el) => el.textContent.includes('waitA'));
            const box = row.querySelector('input[data-action="waitlist-select"]');
            box.checked = true;
            box.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('waitlistBatchTarget').value = '2';
            document.getElementById('waitlistBatchMove').click();
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitC,waitA,waitD,waitB'
        `, { timeout: 12000 });
        check(true, '只勾一筆搬到第 2 位：waitC → waitA → waitD → waitB');
        check(ordersInDb() === 'waitA:2 waitB:4 waitC:1 waitD:3', `資料庫順位同步（${ordersInDb()}）`);

        // ---------- 6. 沒有 JS 錯誤 ----------
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
    console.log(`\n══════ 候補收尾介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
