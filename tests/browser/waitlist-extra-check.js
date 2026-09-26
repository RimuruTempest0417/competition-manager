/* v2.22.0：用手機尺寸的真實 Chrome 驗證「候補再補強」的四件事
 *
 * 驗的是管理員真的操作得到的東西：
 *   ① 拖曳把手（⠿）拖拉排序 → 放開才送出、畫面與資料庫同步
 *   ② 每列的「第 N 位」下拉 → 一次搬到任意順位
 *   ③ 遞補通知開關 → 關掉後資料庫真的變 false、說明文字跟著改、留稽核
 *   ④ 「🕘 順位異動」面板 → 看得到剛才每一次調整（含操作者與內容）
 *   ⑤ 匯出報名名單 CSV 多了「狀態」「候補順位」兩欄（現場報到直接看得懂）
 *
 * 用法：node tests/browser/waitlist-extra-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3313);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-waitlist-extra-check');
const ADMIN = 'owner-waitlist-extra';
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
            admin_users: [{ id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true }],
            competitions: [
                { id: 811, name: '候補排序賽', date: '2026-12-01', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 2, requires_approval: false, waitlist_enabled: true, waitlist_notify: true, created_at: '2026-01-01T00:00:00.000Z' }
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
    console.log(`\n🧪 候補再補強介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        // 這個檢查會按「匯出報名名單」：先裝下載防護，確保**不會有任何檔案寫到使用者的電腦**
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        const order = () => browser.evaluate(`
            return Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1] || '?');
        `);
        const ordersInDb = () => [2102, 2103, 2104].map((id) => {
            const r = state.tables.registrations.find((x) => x.id === id);
            return `${r.username}:${r.waitlist_order === null || r.waitlist_order === undefined ? '-' : r.waitlist_order}`;
        }).join(' ');
        const teamMsg = () => browser.evaluate(`return (document.getElementById('teamMsg') || {}).innerText || '';`);

        await browser.evaluate(`
            document.querySelector('[data-comp-id="811"] [data-action="manage-teams"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('teamModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.getElementById('teamModal').textContent.includes('🙋 waitA')`, { timeout: 12000 });

        // ---------- 1. 新版控制項都在 ----------
        const handles = await browser.evaluate(`return document.querySelectorAll('#waitlistList [data-waitlist-handle]').length;`);
        check(handles === 3, `每列都有拖曳把手 ⠿（${handles} 個）`);

        const jumps = await browser.evaluate(`
            return JSON.stringify(Array.from(document.querySelectorAll('#waitlistList select[data-action="waitlist-jump"]'))
                .map((s) => ({ value: s.value, options: s.options.length })));
        `);
        const parsedJumps = JSON.parse(jumps);
        check(parsedJumps.length === 3 && parsedJumps.every((j) => j.options === 3),
            `每列都有「第 N 位」下拉，選項數＝候補人數（${jumps}）`);
        check(parsedJumps[0].value === '1' && parsedJumps[2].value === '3',
            `下拉預設是這一列目前的順位（${parsedJumps.map((j) => j.value).join(',')}）`);

        const notifyState = await browser.evaluate(`
            const t = document.getElementById('waitlistNotifyToggle');
            return JSON.stringify({ exists: !!t, checked: t && t.checked, disabled: t && t.disabled,
                note: (document.getElementById('waitlistNotifyNote') || {}).textContent || '' });
        `);
        const ntf = JSON.parse(notifyState);
        check(ntf.exists && ntf.checked === true && ntf.disabled === false,
            `通知開關存在、預設勾選、可以操作（${notifyState}）`);
        check(/遞補時推播通知對方/.test(ntf.note), `開關說明文字正確（${ntf.note}）`);
        check(await browser.evaluate(`return document.getElementById('waitlistHistoryBtn') !== null;`),
            '有「🕘 順位異動」按鈕');
        check(await browser.evaluate(`return document.getElementById('waitlistHistoryPanel').classList.contains('hidden');`),
            '異動紀錄面板預設是收起的');
        await browser.screenshot(path.join(SHOTS, '01-新版控制項.png'));

        // ---------- 2. 用下拉一次搬到第 3 位 ----------
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .find((el) => el.textContent.includes('waitA'));
            const sel = row.querySelector('select[data-action="waitlist-jump"]');
            sel.value = '3';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitB,waitC,waitA'
        `, { timeout: 12000 });
        check(true, '下拉選「第 3 位」後畫面順序變成 waitB → waitC → waitA');
        check(ordersInDb() === 'waitA:3 waitB:1 waitC:2', `資料庫順位同步（${ordersInDb()}）`);
        check(/已更新候補順位/.test(await teamMsg()), `有回報訊息（${(await teamMsg()).slice(0, 40)}）`);
        await browser.screenshot(path.join(SHOTS, '02-下拉搬到第3位.png'));

        // ---------- 3. 拖拉把最後一列拖到最前面 ----------
        // ★拖曳前先把名單捲到看得見的位置：拖曳是靠 elementFromPoint(clientX, clientY) 找要放下的那一列，
        //   名單若被上方的功能擠到可視範圍外／只露出一角，事件座標就命不到列 → 拖曳被丟掉。
        //   真實使用者拖曳前一定會先看到那一列，所以測試要先做同一件事（不然這支檢查只是在賭版面剛好而已）。
        await browser.evaluate(`
            const list = document.getElementById('waitlistList');
            if (list) list.scrollIntoView({ block: 'center' });
            return true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'));
            const last = rows[rows.length - 1];
            const first = rows[0];
            const handle = last.querySelector('[data-waitlist-handle]');
            const hb = handle.getBoundingClientRect();
            const fb = first.getBoundingClientRect();
            const fire = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y
            }));
            fire(handle, 'pointerdown', hb.left + 2, hb.top + 2);
            fire(document, 'pointermove', fb.left + 5, fb.top + 3);
            fire(document, 'pointerup', fb.left + 5, fb.top + 3);
            return true;
        `);
        await browser.waitFor(`
            Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]')).map((el) => (el.textContent.match(/🙋\\s*(\\S+)/) || [])[1]).join(',') === 'waitA,waitB,waitC'
        `, { timeout: 12000 });
        check(true, '拖拉（pointer 事件）把最後一列拖到最前面');
        // 拖曳是「放開才送出」：DOM 會先動，所以一定要等回報訊息出現（＝API 真的回來）再驗資料庫
        await browser.waitFor(`String((document.getElementById('teamMsg') || {}).innerText || '').includes('拖拉')`, { timeout: 12000 });
        check(ordersInDb() === 'waitA:1 waitB:2 waitC:3', `拖拉後資料庫順位同步（${ordersInDb()}）`);
        check(/拖拉/.test(await teamMsg()), `拖拉有回報訊息（${(await teamMsg()).slice(0, 40)}）`);
        await browser.screenshot(path.join(SHOTS, '03-拖拉後.png'));

        // ---------- 4. 通知開關 ----------
        await browser.evaluate(`
            const t = document.getElementById('waitlistNotifyToggle');
            t.checked = false;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        // 等資料庫真的寫入（Node 端輪詢；畫面更新由 loadTeams 重繪，這裡只看資料庫）
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && state.tables.competitions.find((c) => c.id === 811).waitlist_notify !== false) {
            await new Promise((r) => setTimeout(r, 150));
        }
        check(state.tables.competitions.find((c) => c.id === 811).waitlist_notify === false,
            '取消勾選後資料庫的 waitlist_notify 變成 false');
        // 畫面重繪是非同步的（要等 loadTeams 回來才更新說明文字）→ 輪詢等它，避免假紅
        let noteOff = '';
        const noteDeadline = Date.now() + 8000;
        while (Date.now() < noteDeadline) {
            noteOff = await browser.evaluate(`return (document.getElementById('waitlistNotifyNote') || {}).textContent || '';`);
            if (/不通知/.test(noteOff)) break;
            await new Promise((r) => setTimeout(r, 150));
        }
        check(/不通知/.test(noteOff), `說明文字改成「不通知」（${noteOff}）`);
        check((state.tables.audit_logs || []).some((l) => l.action === 'WAITLIST_NOTIFY'),
            '關閉通知有留稽核紀錄');

        await browser.evaluate(`
            const t = document.getElementById('waitlistNotifyToggle');
            t.checked = true;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        const deadline2 = Date.now() + 8000;
        while (Date.now() < deadline2 && state.tables.competitions.find((c) => c.id === 811).waitlist_notify !== true) {
            await new Promise((r) => setTimeout(r, 150));
        }
        check(state.tables.competitions.find((c) => c.id === 811).waitlist_notify === true,
            '重新勾選後又變回 true');
        await browser.screenshot(path.join(SHOTS, '04-通知開關.png'));

        // ---------- 5. 順位異動紀錄面板 ----------
        await browser.evaluate(`document.getElementById('waitlistHistoryBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('waitlistHistoryPanel').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.getElementById('waitlistHistoryList').textContent.includes('調整候補順位')`, { timeout: 10000 });
        const histText = await browser.evaluate(`return document.getElementById('waitlistHistoryList').innerText;`);
        check(/調整候補順位/.test(histText), '紀錄裡看得到「調整候補順位」');
        check(/調整遞補通知設定/.test(histText), '紀錄裡看得到「調整遞補通知設定」（中文動作名稱）');
        check(histText.split('\n').filter((l) => l.trim()).length >= 3, `紀錄至少 3 行（實際 ${histText.split('\n').filter((l) => l.trim()).length} 行）`);
        await browser.screenshot(path.join(SHOTS, '05-順位異動紀錄.png'));

        // ---------- 6. 指定遞補（通知開啟 → 不該出現「未通知」） ----------
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
                .find((el) => el.textContent.includes('waitB'));
            row.querySelector('[data-action="promote-reg"]').click();
            return true;
        `);
        await browser.waitFor(`String((document.getElementById('teamMsg') || {}).innerText || '').includes('已遞補')`, { timeout: 12000 });
        const promoteMsg = await teamMsg();
        check(/已遞補 waitB/.test(promoteMsg), `指定遞補成功（${promoteMsg.slice(0, 60)}）`);
        check(!/未通知/.test(promoteMsg), '通知開啟時訊息不會說「未通知」');
        check(state.tables.registrations.find((r) => r.id === 2103).status === 'confirmed',
            'waitB（原第 2 位）在資料庫變成已核准');
        check(state.tables.registrations.find((r) => r.id === 2104).status === 'waitlisted',
            '被跳過的 waitC 完全不受影響（仍是候補）');
        check(await browser.evaluate(`return document.querySelector('#waitlistList [data-action="promote-reg"]').disabled;`),
            '名額已滿後每列的「遞補」按鈕變成停用');

        // ---------- 7. 匯出 CSV 多了狀態與候補順位 ----------
        // 攔下匯出的內容來驗，但**不觸發真實下載**：回傳假的 blob URL，下載自然不會發生
        await browser.evaluate(`
            const origCreate = URL.createObjectURL;
            URL.createObjectURL = (blob) => { window.__blob = blob; return 'blob:stub'; };
            window.__restoreCreateObjectURL = () => { URL.createObjectURL = origCreate; };
            return true;
        `);
        await browser.evaluate(`document.getElementById('exportRegsCsvBtn').click(); return true;`);
        await browser.waitFor(`window.__blob ? true : false`, { timeout: 10000 });
        const csv = await browser.evaluate(`
            const text = await window.__blob.text();
            return text;
        `);
        const csvLines = String(csv || '').split(/\r?\n/).filter((l) => l.length);
        check(/狀態/.test(csvLines[0] || '') && /候補順位/.test(csvLines[0] || ''),
            `CSV 表頭有「狀態」與「候補順位」（${csvLines[0] || ''}）`, `長度 ${String(csv || '').length}｜前 60 字 ${JSON.stringify(String(csv || '').slice(0, 60))}`);
        check(/已核准/.test(csv), 'CSV 內容看得到「已核准」');
        check(csvLines.length >= 4, `CSV 有 4 筆以上資料列（實際 ${csvLines.length - 1} 筆）`);
        const blocked = await browser.evaluate(`return JSON.stringify(window.__downloads || []);`);
        check(JSON.parse(blocked).some((n) => /報名名單|competitions/.test(n)),
            `下載被攔下來（沒有檔案寫到電腦，攔到：${blocked}）`);
        await browser.evaluate(`window.__restoreCreateObjectURL(); return true;`);

        // ---------- 8. 沒有 JS 錯誤 ----------
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
    console.log(`\n══════ 候補再補強介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
