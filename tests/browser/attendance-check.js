/* v3.6.2：現場報到與現場代報名的介面檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 使用者定的方式：現場報到先由管理員在名單上勾選（方案 C）。這一支驗的就是
 * 「比賽當天，管理員拿著手機真的做得到」：
 *   - 現場報到區塊出現在「報名／隊伍」彈窗最上方，統計寫得清楚（已簽到 X／應到 Y／未到 Z）
 *   - 名單**只有正取**（候補不會出現——還沒拿到資格，就不該能被點名）
 *   - 點「簽到」→ 該列變 ✅ 並顯示時間與誰勾的；資料庫真的有 attended_at／attended_by
 *   - 點「取消簽到」→ 回到 ⬜ 且資料庫清空（勾錯是常態）
 *   - 搜尋姓名（現場人多時不用捲）
 *   - 「➕ 現場代報名」：沒線上報名的人當場加進來，標記「現場」；名額滿會擋、同名會叫你去簽到
 *   - 手機寬度不橫向溢出、過程中沒有前端例外
 *
 * 依使用者指示：這一支**不寫任何截圖檔**。
 * 用法：node tests/browser/attendance-check.js
 */
const path = require('node:path');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3322);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'owner-attend';
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
                { id: 30, username: '阿明', password: 'x', role: 'user', is_active: true },
                { id: 31, username: 'player-attend', password: 'x', role: 'user', is_active: true }
            ],
            competitions: [
                { id: 811, name: '秋季盃', date: '2026-12-01', time: '09:00', end_date: '2026-12-01', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 3, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-01T00:00:00.000Z' },
                { id: 812, name: '小場地盃', date: '2026-12-02', time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-02T00:00:00.000Z' }
            ],
            registrations: [
                { id: 911, competition_id: 811, user_id: 30, username: '阿明', team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-01T01:00:00Z', attended_at: null, attended_by: null, onsite: false },
                { id: 912, competition_id: 811, user_id: 32, username: '阿華', team_name: null, note: null, status: 'waitlisted', is_deleted: false, created_at: '2026-09-01T02:00:00Z', attended_at: null, attended_by: null, onsite: false },
                { id: 913, competition_id: 811, user_id: 33, username: '阿強', team_name: '閃電隊', note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-01T03:00:00Z', attended_at: null, attended_by: null, onsite: false },
                { id: 914, competition_id: 812, user_id: 34, username: '小美', team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-02T01:00:00Z', attended_at: null, attended_by: null, onsite: false }
            ],
            competition_teams: [],
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
    console.log(`\n🧪 現場報到與代報名介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });

        const openTeam = async (id, expectText) => {
            await browser.evaluate(`
                document.querySelector('[data-comp-id="${id}"] [data-action="manage-teams"]').click();
                return true;
            `);
            await browser.waitFor(`!document.getElementById('teamModal').classList.contains('hidden')`, { timeout: 8000 });
            await browser.waitFor(`!document.getElementById('attendanceSection').classList.contains('hidden')`, { timeout: 10000 });
            await browser.waitFor(`document.getElementById('attendanceList').textContent.includes(${JSON.stringify(expectText)})`, { timeout: 12000 });
        };
        const attendanceText = () => browser.evaluate(`return document.getElementById('attendanceList').textContent.replace(/\\s+/g, ' ');`);
        const summaryText = () => browser.evaluate(`return document.getElementById('attendanceSummary').textContent;`);
        const reg = (id) => state.tables.registrations.find((r) => r.id === id);

        /* ---------- 1. 現場報到區塊與名單 ---------- */
        await openTeam(811, '阿明');
        check(true, '管理員在賽事卡片上找得到「報名／隊伍」並開啟現場報到區塊');

        const summary0 = await summaryText();
        check(/已簽到 0／應到 2/.test(summary0), `統計顯示「已簽到 0／應到 2」（${summary0}）`);
        check(/未到 2/.test(summary0), '統計顯示尚未簽到人數');

        const list0 = await attendanceText();
        check(/阿明/.test(list0) && /阿強/.test(list0), '名單列出兩位正取');
        check(!/阿華/.test(list0), '候補者**不**出現在現場名單（還沒拿到資格，不該能被點名）');
        check(/閃電隊/.test(list0), '已編隊的人顯示隊伍名稱');
        const buttons = await browser.evaluate(`return document.querySelectorAll('#attendanceList [data-action="check-in"]').length;`);
        check(buttons === 2, `每位正取都有「簽到」按鈕（${buttons} 顆）`);

        /* ---------- 2. 簽到 → 資料庫真的有記錄 ---------- */
        await browser.evaluate(`document.querySelector('#attendanceList [data-id="911"][data-action="check-in"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('attendanceList').textContent.includes('✅')`, { timeout: 12000 });
        check(!!reg(911).attended_at, '簽到時間寫進資料庫');
        check(reg(911).attended_by === ADMIN, `記下是誰勾的（${reg(911).attended_by}）`);
        const summary1 = await summaryText();
        check(/已簽到 1／應到 2/.test(summary1), `統計跟著更新（${summary1}）`);
        const list1 = await attendanceText();
        check(/✅ 阿明/.test(list1), '該列變成已簽到（✅）');
        check(/取消簽到/.test(list1), '已簽到的列改成「取消簽到」按鈕');
        check(/還有 1 位正取尚未簽到/.test(await browser.evaluate(`return document.getElementById('attendanceHint').textContent;`)),
            '提示還有幾位尚未簽到');
        check(JSON.stringify(state.tables.audit_logs).includes('REGISTER_ATTENDED'), '簽到留下稽核紀錄');

        /* ---------- 3. 取消簽到（勾錯是常態） ---------- */
        await browser.evaluate(`document.querySelector('#attendanceList [data-id="911"][data-action="undo-check-in"]').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#attendanceList [data-action="check-in"]').length === 2`, { timeout: 12000 });
        check(reg(911).attended_at === null, '取消簽到後資料庫的簽到時間清空');
        check(reg(911).attended_by === null, '取消簽到後操作者也清空');
        check(JSON.stringify(state.tables.audit_logs).includes('REGISTER_ATTENDANCE_UNDONE'), '取消簽到也留稽核紀錄');

        /* ---------- 4. 搜尋（現場人多時不用捲） ---------- */
        await browser.evaluate(`
            const el = document.getElementById('attendanceSearch');
            el.value = '阿強';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        const searched = await attendanceText();
        check(/阿強/.test(searched) && !/阿明/.test(searched), '搜尋只留下符合的人');
        await browser.evaluate(`
            const el = document.getElementById('attendanceSearch');
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        check((await attendanceText()).includes('阿明'), '清空搜尋後名單回復');

        /* ---------- 5. 現場代報名 ---------- */
        await browser.evaluate(`document.getElementById('onsiteToggleBtn').click(); return true;`);
        check(!(await browser.evaluate(`return document.getElementById('onsiteForm').classList.contains('hidden');`)),
            '按「➕ 現場代報名」會展開表單');
        await browser.evaluate(`
            const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
            set('onsiteName', '路人甲');
            set('onsiteNote', '現場臨時參加');
            document.getElementById('onsiteSubmitBtn').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('attendanceList').textContent.includes('路人甲')`, { timeout: 15000 });
        const onsiteRow = state.tables.registrations.find((r) => r.username === '路人甲');
        check(!!onsiteRow, '代報名真的建立一筆紀錄');
        check(onsiteRow && onsiteRow.onsite === true, '標記為現場代報名');
        check(onsiteRow && onsiteRow.status === 'confirmed', '現場代報名直接是正取（管理員在場）');
        check(onsiteRow && onsiteRow.note === '現場臨時參加', '備註保留管理員填的內容');
        const listAfter = await attendanceText();
        check(/路人甲/.test(listAfter) && /現場/.test(listAfter), '新人出現在名單上並標示「現場」');
        const summary2 = await summaryText();
        check(/應到 3/.test(summary2) && /現場代報名 1/.test(summary2), `統計納入現場代報名（${summary2}）`);
        check(JSON.stringify(state.tables.audit_logs).includes('REGISTER_ONSITE'), '現場代報名留下稽核紀錄');
        check((await browser.evaluate(`return document.getElementById('onsiteForm').classList.contains('hidden');`)) === true,
            '送出後表單自動收起');

        // 同名 → 不要重複建立，直接叫管理員去簽到
        await browser.evaluate(`
            document.getElementById('onsiteToggleBtn').click();
            const el = document.getElementById('onsiteName');
            el.value = '路人甲';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('onsiteSubmitBtn').click();
            return true;
        `);
        await browser.waitFor(`/已經有報名紀錄/.test(document.getElementById('teamMsg').textContent)`, { timeout: 12000 });
        const msgDup = await browser.evaluate(`return document.getElementById('teamMsg').textContent;`);
        check(/簽到/.test(msgDup), `同名時提示去名單上簽到（${msgDup.slice(0, 60)}）`);
        check(state.tables.registrations.filter((r) => r.username === '路人甲').length === 1, '沒有建立重複紀錄');
        await browser.evaluate(`document.getElementById('onsiteCancelBtn').click(); return true;`);

        /* ---------- 6. 額滿時擋下來（812 名額 1，已有小美） ---------- */
        await browser.evaluate(`document.getElementById('closeTeamModalBtn').click(); return true;`);
        await openTeam(812, '小美');
        await browser.evaluate(`
            document.getElementById('onsiteToggleBtn').click();
            const el = document.getElementById('onsiteName');
            el.value = '路人乙';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('onsiteSubmitBtn').click();
            return true;
        `);
        await browser.waitFor(`/名額已滿/.test(document.getElementById('teamMsg').textContent)`, { timeout: 12000 });
        const msgFull = await browser.evaluate(`return document.getElementById('teamMsg').textContent;`);
        check(/名額已滿/.test(msgFull), `額滿時明確說明（${msgFull.slice(0, 70)}）`);
        check(state.tables.registrations.filter((r) => r.username === '路人乙').length === 0, '額滿時不會偷偷建檔');

        /* ---------- 7. 手機版不橫向溢出、沒有前端例外 ---------- */
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
        check(overflow <= 0, `手機上沒有橫向溢出（${overflow}px）`);
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        check(browser.dialogs.length === 0, '過程中沒有卡住的原生對話框', JSON.stringify(browser.dialogs).slice(0, 120));

        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 現場報到與代報名介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err, err.message);
    process.exit(1);
});
