/* v2.24.0：用手機尺寸的真實 Chrome 驗證「賽事複製與週期性」
 *
 * 驗的是管理員真的操作得到的東西：
 *   ① 每張卡片都有「📄 複製賽事」與「🔁 週期」按鈕
 *   ② 複製賽事：名稱加（複製）、設定照抄、**報名與隊伍不跟著搬**、複製品不帶週期
 *   ③ 週期面板：可以設定每週／每兩週／每月與結束日，卡片按鈕會顯示目前的週期
 *   ④ 「立即建立下一場」：日期往後一個週期、報名時間一起挪、繼續同一個系列
 *   ⑤ 已經排定下一場時再按一次：不會多開，而是說明「系列已經有排定的場次」
 *   ⑥ 取消週期：卡片回到「🔁 週期」、不會再自動建立
 *   ⑦ 過程中沒有前端例外、也不會下載任何檔案到使用者的電腦
 *
 * 用法：node tests/browser/recurrence-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3315);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-recurrence-check');
const ADMIN = 'owner-recurrence';
const PASS = 'checkpass123';

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return isoOf(d);
};
const TODAY = isoOf(new Date());

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
                {
                    id: 821, name: '週三夜賽', location: '澳門運動場', date: TODAY, time: '20:00',
                    end_date: null, end_time: null, description: '每週例賽',
                    is_registration_open: true, category: 'road', tags: ['夜賽'],
                    is_team_event: true, team_size: 3, max_registrations: 60,
                    registration_deadline: TODAY, requires_approval: true, waitlist_enabled: true,
                    waitlist_notify: true, registration_start_at: plusDays(-7), registration_end_at: TODAY,
                    recurrence: null, recurrence_until: null, recurrence_parent_id: null,
                    is_deleted: false, created_at: '2026-01-01T00:00:00.000Z'
                },
                {
                    id: 822, name: '單場盃賽', location: '氹仔運動場', date: plusDays(40), time: '09:00',
                    end_date: null, end_time: null, description: '一年一次',
                    is_registration_open: true, category: 'track', tags: [],
                    is_team_event: false, team_size: null, max_registrations: 120,
                    registration_deadline: null, requires_approval: false, waitlist_enabled: false,
                    waitlist_notify: true, registration_start_at: null, registration_end_at: null,
                    recurrence: null, recurrence_until: null, recurrence_parent_id: null,
                    is_deleted: false, created_at: '2026-01-02T00:00:00.000Z'
                }
            ],
            registrations: [
                { id: 3101, competition_id: 821, user_id: 91, username: 'runnerA', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' }
            ],
            teams: [
                { id: 4101, competition_id: 821, name: 'A 隊', is_deleted: false }
            ],
            audit_logs: [],
            error_logs: [],
            push_subscriptions: [],
            push_log: []
        },
        nextId: { competitions: 900, registrations: 3200, teams: 4200, audit_logs: 900, error_logs: 900, push_log: 10 },
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
    console.log(`\n🧪 賽事複製與週期性介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        // 這個檢查不該下載任何檔案（防護裝上後，真的觸發下載會被抓到並記錄）
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });

        const alerts = () => browser.evaluate(`return JSON.stringify(window.__ALERTS__ || []);`);
        const cardText = (id) => browser.evaluate(`return (document.querySelector('[data-comp-id="${id}"]') || {}).innerText || '';`);
        const compIn = (id) => state.tables.competitions.find((c) => String(c.id) === String(id));
        const countComps = () => state.tables.competitions.filter((c) => !c.is_deleted).length;
        const click = (id, action) => browser.evaluate(`
            const card = document.querySelector('[data-comp-id="${id}"]');
            if (!card) return false;
            const btn = card.querySelector('[data-action="${action}"]');
            if (!btn) return false;
            btn.click();
            return true;
        `);

        // ---------- ① 卡片按鈕 ----------
        const btnLabels = await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="821"]');
            return JSON.stringify(Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim()));
        `);
        check(/複製賽事/.test(btnLabels), `卡片有「📄 複製賽事」按鈕（${btnLabels}）`);
        check(/🔁 週期/.test(btnLabels), `卡片有「🔁 週期」按鈕（${btnLabels}）`);

        // ---------- ② 複製賽事 ----------
        const before = countComps();
        await click(822, 'duplicate-comp');
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 3`, { timeout: 15000 });
        await browser.waitFor(`JSON.stringify(window.__ALERTS__).includes('複製')`, { timeout: 8000 });

        const copy = state.tables.competitions.find((c) => String(c.name) === '單場盃賽（複製）');
        check(!!copy, '複製出「單場盃賽（複製）」');
        check(countComps() === before + 1, `賽事數量只多一筆（${before} → ${countComps()}）`);
        check(!!copy && copy.location === '氹仔運動場' && copy.date === plusDays(40) && copy.time === '09:00',
            '複製品沿用原賽事的地點與日期時間');
        check(!!copy && copy.max_registrations === 120 && !copy.requires_approval,
            '複製品沿用報名名額與審核設定');
        check(!!copy && !copy.recurrence, '複製品不帶週期（是獨立的一場）');
        check(!!copy && !String(copy.registration_start_at || '').length, '複製品沒有硬搬報名時間（原賽事本來就沒填）');

        const copyRegs = state.tables.registrations.filter((r) => String(r.competition_id) === String(copy && copy.id)).length;
        const copyTeams = state.tables.teams.filter((t) => String(t.competition_id) === String(copy && copy.id)).length;
        check(copyRegs === 0, `複製品沒有搬報名紀錄（${copyRegs} 筆）`);
        check(copyTeams === 0, `複製品沒有搬隊伍（${copyTeams} 隊）`);
        check(state.tables.registrations.filter((r) => String(r.competition_id) === '821').length === 1,
            '原賽事的報名紀錄還在（沒有被搬走）');

        const copyAlerts = JSON.parse(await alerts());
        check(copyAlerts.some((m) => /已複製成「單場盃賽（複製）」/.test(m)),
            `複製後有提示訊息（${copyAlerts.filter((m) => /複製/.test(m)).slice(-1)[0] || ''}）`);

        await browser.screenshot(path.join(SHOTS, '01-複製後清單.png'));

        // ---------- ③ 週期面板 ----------
        await click(821, 'recurrence-comp');
        await browser.waitFor(`!document.getElementById('recurrenceModal').classList.contains('hidden')`, { timeout: 8000 });
        const modalInfo = await browser.evaluate(`
            return JSON.stringify({
                name: document.getElementById('recurrenceCompName').textContent,
                rule: document.getElementById('recurrenceRule').value,
                hint: document.getElementById('recurrenceHint').textContent,
                options: Array.from(document.getElementById('recurrenceRule').options).map((o) => o.value)
            });
        `);
        const modal = JSON.parse(modalInfo);
        check(/週三夜賽/.test(modal.name), `面板顯示賽事名稱與日期（${modal.name}）`);
        check(modal.rule === '', '還沒設定週期時下拉是「不重複」');
        check(JSON.stringify(modal.options) === JSON.stringify(['', 'weekly', 'biweekly', 'monthly']),
            `下拉有四種選項（${modal.options.join('/')}）`);
        check(/沒有設定週期就不會自動建立/.test(modal.hint), `面板有白話說明（${modal.hint.slice(0, 24)}…）`);

        await browser.screenshot(path.join(SHOTS, '02-週期面板.png'));

        // ---------- ④ 設定每週 ----------
        await browser.evaluate(`
            const rule = document.getElementById('recurrenceRule');
            rule.value = 'weekly';
            rule.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        const hintAfter = await browser.evaluate(`return document.getElementById('recurrenceHint').textContent;`);
        check(/每週/.test(hintAfter) && /30 天/.test(hintAfter), '選每週後說明文字跟著換（含提前 30 天與一次只排一場）');

        await browser.evaluate(`document.getElementById('recurrenceSaveBtn').click(); return true;`);
        await browser.waitFor(`JSON.stringify(window.__ALERTS__).includes('已設定週期')`, { timeout: 8000 });
        await browser.waitFor(`document.getElementById('recurrenceModal').classList.contains('hidden')`, { timeout: 8000 });
        check(compIn(821).recurrence === 'weekly', '資料庫存了每週（recurrence=weekly）');

        const btnAfter = await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="821"]');
            return JSON.stringify(Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim()));
        `);
        check(/🔁 每週/.test(btnAfter), `卡片按鈕顯示目前週期（${btnAfter}）`);

        // ---------- ⑤ 立即建立下一場 ----------
        const beforeCreate = countComps();
        await click(821, 'recurrence-comp');
        await browser.waitFor(`!document.getElementById('recurrenceModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.evaluate(`document.getElementById('recurrenceNextBtn').click(); return true;`);
        await browser.waitFor(`JSON.stringify(window.__ALERTS__).includes('已建立下一場')`, { timeout: 12000 });

        const child = state.tables.competitions.find((c) => String(c.recurrence_parent_id) === '821');
        check(!!child, '建立了系列的第二場');
        check(countComps() === beforeCreate + 1, `只多一筆賽事（${beforeCreate} → ${countComps()}）`);
        check(!!child && child.date === plusDays(7), `下一場日期＝7 天後（${child && child.date}）`);
        check(!!child && child.name === '週三夜賽', '自動建立沿用同一個名稱（不加（複製））');
        check(!!child && child.recurrence === 'weekly', '下一場繼續同一個週期');
        check(!!child && String(child.registration_start_at) === TODAY && String(child.registration_end_at) === plusDays(7),
            `報名時間一起往後挪（${child && child.registration_start_at} → ${child && child.registration_end_at}）`);
        check(state.tables.audit_logs.some((l) => l.action === 'CREATE_RECURRING_COMPETITION'),
            '有留稽核紀錄（週期性賽事建立下一場）');

        const createdAlerts = JSON.parse(await alerts());
        check(createdAlerts.some((m) => /已建立下一場：週三夜賽/.test(m)),
            `建立後有提示（${createdAlerts.filter((m) => /已建立下一場/.test(m)).slice(-1)[0] || ''}）`);

        await browser.screenshot(path.join(SHOTS, '03-建立下一場後.png'));

        // ---------- ⑥ 已經排定時不會多開 ----------
        const beforeSecond = countComps();
        await click(821, 'recurrence-comp');
        await browser.waitFor(`!document.getElementById('recurrenceModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.evaluate(`document.getElementById('recurrenceNextBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('recurrenceHint').textContent.includes('目前還不會建立下一場')`, { timeout: 10000 });
        const blockedHint = await browser.evaluate(`return document.getElementById('recurrenceHint').textContent;`);
        check(/已經有排定的場次/.test(blockedHint), `說明「系列已經有排定的場次」（${blockedHint}）`);
        check(countComps() === beforeSecond, `沒有多開場次（仍是 ${countComps()} 筆）`);

        await browser.screenshot(path.join(SHOTS, '04-已排定說明.png'));

        // ---------- ⑦ 取消週期 ----------
        await browser.evaluate(`
            const rule = document.getElementById('recurrenceRule');
            rule.value = '';
            rule.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('recurrenceSaveBtn').click();
            return true;
        `);
        await browser.waitFor(`JSON.stringify(window.__ALERTS__).includes('已取消週期設定')`, { timeout: 8000 });
        check(compIn(821).recurrence === null, '資料庫的週期已清空');
        check(String(compIn(821).recurrence_until || '') === '', '結束日也一起清空');
        const btnCancelled = await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="821"]');
            return JSON.stringify(Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim()));
        `);
        check(/🔁 週期/.test(btnCancelled), `卡片回到「🔁 週期」（${btnCancelled}）`);

        // ---------- ⑧ 沒有例外、沒有下載 ----------
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
    console.log(`\n══════ 賽事複製與週期性介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
