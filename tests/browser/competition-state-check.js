/* v2.19.0：用手機尺寸的真實 Chrome 驗證「賽事狀態機」介面
 *
 * 驗的是使用者真正看到／碰到的東西：
 *   - 每張卡片的狀態徽章（報名中／尚未開放／進行中／已結束…）是不是後端判定的那一種
 *   - 狀態篩選列的數字與點擊篩選
 *   - 報名按鈕是否照 can_register 顯示/鎖住，鎖住時要看得出原因
 *   - 表單的報名開始／截止欄位與「即時狀態預覽」（用與後端同一份規則算）
 *   - 邊界真的會自動切換（種一筆「1 秒前剛截止」與「30 秒後才開始」的賽事）
 *
 * 伺服器：真的 server.js + 假 Supabase。用法：node tests/browser/competition-state-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3305);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-state-check');
const USER = 'owner-state';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true }],
            competitions: [
                // 報名中（無報名截止，開賽還很久）
                { id: 601, name: '開放報名中的賽事', date: day(20), time: '09:00', end_date: day(20), end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 0, created_at: '2026-01-01T00:00:00.000Z' },
                // 尚未開放報名
                { id: 602, name: '還沒開放報名的賽事', date: day(25), time: '09:00', is_registration_open: true, is_deleted: false, registration_start_at: iso(2 * DAY), created_at: '2026-01-02T00:00:00.000Z' },
                // 進行中（昨天開始、明天結束）
                { id: 603, name: '正在進行的賽事', date: day(-1), time: '00:00', end_date: day(1), end_time: '23:59', is_registration_open: true, is_deleted: false, created_at: '2026-01-03T00:00:00.000Z' },
                // 已結束
                { id: 604, name: '已經結束的賽事', date: day(-6), time: '09:00', is_registration_open: true, is_deleted: false, created_at: '2026-01-04T00:00:00.000Z' },
                // 邊界①：30 秒前剛截止 → 現在應該是「報名已截止」
                { id: 605, name: '剛剛截止的賽事', date: day(15), time: '09:00', is_registration_open: true, is_deleted: false, registration_end_at: iso(-30 * 1000), created_at: '2026-01-05T00:00:00.000Z' },
                // 邊界②：30 秒後才開放報名 → 現在應該是「尚未開放報名」
                { id: 606, name: '馬上要開放的賽事', date: day(18), time: '09:00', is_registration_open: true, is_deleted: false, registration_start_at: iso(30 * 1000), created_at: '2026-01-06T00:00:00.000Z' }
            ],
            registrations: [],
            audit_logs: [],
            error_logs: []
        },
        nextId: { competitions: 700, audit_logs: 900, error_logs: 900 },
        log: []
    };
}

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    return true;
`;

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
    console.log(`\n🧪 賽事狀態機介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await browser.evaluate(`
            document.getElementById('loginModal').classList.remove('hidden');
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            setValue('loginUsername', ${JSON.stringify(USER)});
            setValue('loginPassword', ${JSON.stringify(PASS)});
            document.getElementById('submitLoginBtn').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 6`, { timeout: 15000 });

        // ---------- 1. 狀態徽章 ----------
        const badges = await browser.evaluate(`
            const out = {};
            document.querySelectorAll('[data-comp-id]').forEach((card) => {
                const badge = card.querySelector('span.rounded-full');
                out[card.getAttribute('data-comp-id')] = card.textContent.replace(/\\s+/g, ' ');
            });
            return out;
        `);
        check(/開放報名中的賽事[\s\S]*報名中/.test(badges['601']), '報名中的賽事顯示「報名中」徽章');
        check(/還沒開放報名的賽事[\s\S]*尚未開放報名/.test(badges['602']), '未到報名開始時間顯示「尚未開放報名」');
        check(/正在進行的賽事[\s\S]*進行中/.test(badges['603']), '已開賽未結束顯示「進行中」');
        check(/已經結束的賽事[\s\S]*已結束/.test(badges['604']), '已過結束時間顯示「已結束」');
        check(/剛剛截止的賽事[\s\S]*報名已截止/.test(badges['605']), '30 秒前剛截止 → 自動切成「報名已截止」（邊界）');
        check(/馬上要開放的賽事[\s\S]*尚未開放報名/.test(badges['606']), '30 秒後才開放 → 現在是「尚未開放報名」（邊界）');
        await browser.screenshot(path.join(SHOTS, '01-狀態徽章.png'));

        // ---------- 2. 篩選列 ----------
        const chips = await browser.evaluate(`
            return Array.from(document.querySelectorAll('#stateFilterBar .cm-state-chip')).map((b) => b.textContent.replace(/\\s+/g, ' ').trim());
        `);
        check(chips.length === 6, `狀態篩選列有 6 個籤（實際 ${chips.length}）`, JSON.stringify(chips));
        check(chips.some((c) => /^全部 6$/.test(c)), '「全部」籤的數字是 6');
        check(chips.some((c) => /報名中 1/.test(c)) && chips.some((c) => /進行中 1/.test(c)) && chips.some((c) => /已結束 1/.test(c)),
            '各狀態數字正確（報名中 1／進行中 1／已結束 1）', JSON.stringify(chips));
        check(chips.some((c) => /報名已截止 1/.test(c)) && chips.some((c) => /尚未開放 2/.test(c)),
            '「報名已截止 1」「尚未開放 2」（含邊界兩筆）', JSON.stringify(chips));

        await browser.evaluate(`
            document.querySelector('#stateFilterBar [data-state-filter="ongoing"]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length === 1`, { timeout: 8000 });
        const ongoingOnly = await browser.evaluate(`return document.querySelector('[data-comp-id]').getAttribute('data-comp-id');`);
        check(ongoingOnly === '603', `點「進行中」只留下進行中的賽事（實際 ${ongoingOnly}）`);
        check(await browser.evaluate(`return document.querySelector('#stateFilterBar [data-state-filter="ongoing"]').getAttribute('aria-pressed');`) === 'true',
            '被選取的籤有 aria-pressed=true（無障礙）');
        await browser.screenshot(path.join(SHOTS, '02-狀態篩選.png'));

        // 回到全部
        await browser.evaluate(`document.querySelector('#stateFilterBar [data-state-filter=""]').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length === 6`, { timeout: 8000 });
        check(true, '可以切回「全部」');

        // ---------- 3. 報名按鈕照狀態決定 ----------
        const buttons = await browser.evaluate(`
            const out = {};
            document.querySelectorAll('[data-comp-id]').forEach((card) => {
                const btn = card.querySelector('[data-action="register-comp"], [data-action="my-regs"]');
                out[card.getAttribute('data-comp-id')] = btn ? btn.textContent.trim() : '(沒有按鈕)';
            });
            return out;
        `);
        check(buttons['601'] === '📝 報名', `報名中的賽事可報名（按鈕：${buttons['601']}）`);
        check(/🔒/.test(buttons['602']) && /報名將於/.test(buttons['602']), `尚未開放 → 鎖住並說明（${buttons['602']}）`);
        check(/🔒/.test(buttons['603']) && /已開始/.test(buttons['603']), `進行中 → 鎖住並說明（${buttons['603']}）`);
        check(/🔒/.test(buttons['604']) && /已結束/.test(buttons['604']), `已結束 → 鎖住並說明（${buttons['604']}）`);
        check(/🔒/.test(buttons['605']) && /已於/.test(buttons['605']), `剛截止 → 鎖住並說明（${buttons['605']}）`);

        // 確認鎖住的按鈕真的按不下去（送出會被後端擋）
        await browser.evaluate(`
            window.__ALERTS__ = [];
            const btn = document.querySelector('[data-comp-id="604"] [data-action="register-comp"]');
            if (btn) btn.click();
            return true;
        `);
        await browser.waitFor(`window.__ALERTS__.length > 0`, { timeout: 8000 }).catch(() => {});
        const alerts = await browser.evaluate(`return window.__ALERTS__;`);
        check(alerts.length === 0 || !/成功/.test(alerts.join('')), `已結束的賽事按報名不會成功（訊息：${alerts.join(' / ').slice(0, 60) || '無'}）`);

        // ---------- 4. 表單的報名時間與即時預覽 ----------

        // 表單是頁面上的「➕ 發佈新比賽」區塊（管理員才看得到），不是彈窗
        check(await browser.evaluate(`return document.getElementById('createSection').offsetParent !== null;`),
            '管理員登入後看得到發佈賽事的表單區塊');
        await browser.waitFor(`document.getElementById('registration_start_at') !== null`, { timeout: 8000 });
        check(await browser.evaluate(`return document.getElementById('registration_start_at') !== null;`), '表單有「報名開始」欄位');
        check(await browser.evaluate(`return document.getElementById('registration_end_at') !== null;`), '表單有「報名截止」欄位');

        const preview = await browser.evaluate(`
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setValue('name', '預覽測試');
            setValue('date', ${JSON.stringify(day(10))});
            setValue('registration_start_at', ${JSON.stringify(day(2) + 'T09:00')});
            setValue('registration_end_at', ${JSON.stringify(day(5) + 'T18:00')});
            document.getElementById('is_registration_open').checked = true;
            document.getElementById('is_registration_open').dispatchEvent(new Event('change', { bubbles: true }));
            return {
                text: document.getElementById('formStatePreviewText').textContent,
                detail: document.getElementById('formStateDetail').textContent
            };
        `);
        check(preview.text === '尚未開放報名', `報名開始在未來 → 預覽顯示「尚未開放報名」（實際 ${preview.text}）`);
        check(/報名將於/.test(preview.detail), `預覽說明報名開始時間（${preview.detail}）`);

        const preview2 = await browser.evaluate(`
            const el = document.getElementById('registration_start_at');
            el.value = ${JSON.stringify(day(-1) + 'T09:00')};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('formStatePreviewText').textContent;
        `);
        check(preview2 === '報名中', `報名已經開始 → 預覽顯示「報名中」（實際 ${preview2}）`);
        await browser.screenshot(path.join(SHOTS, '03-表單預覽.png'));

        // 取消勾選「開放報名中」→ 預覽應變成不可報名
        const preview3 = await browser.evaluate(`
            const cb = document.getElementById('is_registration_open');
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('formStatePreviewText').textContent;
        `);
        check(preview3 === '報名已截止', `取消「開放報名中」→ 預覽顯示「報名已截止」（實際 ${preview3}）`);

        // ---------- 5. 儲存後狀態真的存進資料庫 ----------
        await browser.evaluate(`
            document.getElementById('is_registration_open').checked = true;
            document.getElementById('is_registration_open').dispatchEvent(new Event('change', { bubbles: true }));
            window.__ALERTS__ = [];
            document.getElementById('competitionForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`window.__ALERTS__.length > 0`, { timeout: 15000 });
        const saved = state.tables.competitions.find((c) => c.name === '預覽測試');
        check(!!saved, `新增的賽事有寫入資料庫（${saved ? 'id=' + saved.id : '找不到'}）`);
        check(!!saved && !!saved.registration_start_at && !!saved.registration_end_at, '報名開始／截止時間有寫入資料庫');
        check(!!saved && saved.registration_deadline === day(5), `舊欄位 registration_deadline 同步為 ${day(5)}（實際 ${saved && saved.registration_deadline}）`);

        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 賽事狀態機介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err);
    process.exit(1);
});
