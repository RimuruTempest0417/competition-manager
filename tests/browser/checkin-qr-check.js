/* v3.6.5：掃碼報到與報到碼的介面檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 這一版有兩個「容易做出來但現場不能用」的陷阱，所以檢查就針對它們：
 *   ① 掃碼只有 Android Chrome 有（BarcodeDetector）；在沒有這個 API 的裝置上，
 *      按鈕必須**老實告訴使用者改用輸入報到碼**，而不是開一個永遠掃不到東西的畫面。
 *   ② 報到碼本身要是能掃的 QR——這由 tests/qr.test.js 用 macOS Vision 解碼驗證；
 *      這裡驗的是「畫面上真的畫出那張 QR、尺寸與格子數對得上」。
 *
 * 另外驗：手打 8 碼能簽到（含小寫與空白）、錯的碼要擋、重複掃要說「已經簽到過」、
 * 選手端只看得到自己的碼、手機寬度不橫向溢出、過程中沒有前端例外。
 *
 * 依使用者指示：這一支**不寫任何截圖檔**。
 * 用法：node tests/browser/checkin-qr-check.js
 */
const path = require('node:path');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3324);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'owner-qr';
const PASS = 'checkpass123';
const PLAYER = 'player-qr';
const PLAYER_PASS = 'playerpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const CODE_A = 'PLAY2K47';
const CODE_WAIT = 'WAIT5K39';

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true },
                { id: 40, username: PLAYER, password: PLAYER_PASS, role: 'user', is_active: true },
                { id: 41, username: '阿明', password: 'x', role: 'user', is_active: true }
            ],
            competitions: [
                { id: 831, name: '掃碼盃', date: '2026-12-20', time: '09:00', end_date: '2026-12-20', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 20, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-01T00:00:00.000Z' }
            ],
            registrations: [
                { id: 931, competition_id: 831, user_id: 40, username: PLAYER, status: 'confirmed', is_deleted: false, checkin_code: CODE_A, attended_at: null, attended_by: null, created_at: '2026-01-05T00:00:00.000Z' },
                { id: 932, competition_id: 831, user_id: 41, username: '阿明', status: 'confirmed', is_deleted: false, checkin_code: null, attended_at: null, attended_by: null, created_at: '2026-01-06T00:00:00.000Z' },
                { id: 933, competition_id: 831, user_id: 41, username: '阿華', status: 'waitlisted', is_deleted: false, checkin_code: CODE_WAIT, attended_at: null, attended_by: null, created_at: '2026-01-07T00:00:00.000Z' }
            ],
            audit_logs: [],
            push_subscriptions: [],
            app_settings: []
        },
        nextId: { registrations: 940, audit_logs: 940 }
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

const logout = async (browser) => {
    await browser.evaluate(`localStorage.removeItem('competition_user'); return true;`);
    await browser.goto(BASE);
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
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
    console.log(`\n🧪 掃碼報到與報到碼介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        const reg = (id) => state.tables.registrations.find((r) => r.id === id);
        const teamMsg = () => browser.evaluate(`return (document.getElementById('teamMsg') || {}).textContent || '';`);
        const scanHint = () => browser.evaluate(`return (document.getElementById('attendanceScanHint') || {}).textContent || '';`);

        await browser.evaluate(`
            document.querySelector('[data-comp-id="831"] [data-action="manage-teams"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('attendanceSection').classList.contains('hidden')`, { timeout: 12000 });

        /* ---------- 1. 掃碼與手動輸入的介面都在，而且預設不佔高度 ---------- */
        check(await browser.evaluate(`return document.getElementById('attendanceScanToggleBtn') !== null;`),
            '現場報到區塊有「📷 掃碼／輸入」按鈕');
        check(await browser.evaluate(`return document.getElementById('attendanceScanWrap').classList.contains('hidden');`),
            '★收合面板預設是關的（不佔高度，候補／名單不會被擠出可視範圍）');
        await browser.evaluate(`document.getElementById('attendanceScanToggleBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('attendanceScanWrap').classList.contains('hidden')`, { timeout: 5000 });
        check(true, '按一下會展開掃碼／輸入面板');
        check(await browser.evaluate(`return document.getElementById('attendanceScanBtn') !== null;`),
            '面板裡有「📷 掃碼報到」按鈕');
        check(await browser.evaluate(`return document.getElementById('attendanceCodeInput') !== null;`),
            '面板裡有輸入報到碼的欄位（iPhone 等沒有掃碼功能的裝置靠這條路）');

        /* ---------- 2. 沒有掃碼能力的裝置 → 老實說明，不開一個沒用的畫面 ---------- */
        const hasDetector = await browser.evaluate(`return typeof window.BarcodeDetector === 'function';`);
        await browser.evaluate(`document.getElementById('attendanceScanBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 600));
        if (!hasDetector) {
            const hint = await scanHint();
            check(/沒有掃碼功能/.test(hint) && /輸入 8 碼/.test(hint),
                `這台裝置沒有 BarcodeDetector → 明確告知改用輸入報到碼（${hint.slice(0, 40)}…）`);
            check(await browser.evaluate(`return document.getElementById('attendanceScanBox').classList.contains('hidden');`),
                '沒有掃碼能力時不會打開一個空的相機畫面');
        } else {
            check(true, `這台裝置有 BarcodeDetector（${await browser.evaluate('return navigator.userAgent.slice(0, 40);')}…）`);
        }

        // 這台 Mac 的 Chrome 有 BarcodeDetector，所以「沒有這個 API」的那條路不會被走到；
        // 這裡直接把它拿掉，模擬 iPhone（iOS 的 Safari／Chrome 都用 WebKit，沒有這個 API）。
        await browser.evaluate(`
            window.BarcodeDetector = undefined;
            document.getElementById('attendanceScanBtn').click();
            return true;
        `);
        await new Promise((r) => setTimeout(r, 500));
        const hintIos = await scanHint();
        check(/沒有掃碼功能/.test(hintIos) && /輸入 8 碼/.test(hintIos),
            `★模擬 iPhone（沒有 BarcodeDetector）時明確告知改用輸入報到碼（${hintIos.slice(0, 34)}…）`);
        check(await browser.evaluate(`return document.getElementById('attendanceScanBox').classList.contains('hidden');`),
            '模擬 iPhone 時不會打開一個空的相機畫面（不給按了沒反應的介面）');

        /* ---------- 3. 手打 8 碼簽到（含小寫與空白，模擬現場手打）---------- */
        await browser.evaluate(`
            const input = document.getElementById('attendanceCodeInput');
            input.value = '  play 2k47 ';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await browser.evaluate(`document.getElementById('attendanceCodeBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('attendanceList').textContent.includes('✅')`, { timeout: 12000 });
        check(!!reg(931).attended_at, '★輸入（小寫＋空白）也能簽到，時間寫進資料庫');
        check(reg(931).attended_by === ADMIN, `記下是誰簽到的（${reg(931).attended_by}）`);
        const msg1 = await teamMsg();
        check(new RegExp(PLAYER).test(msg1) && /簽到/.test(msg1), `畫面回報簽到的是誰（${msg1.slice(0, 40)}）`);
        check(await browser.evaluate(`return document.getElementById('attendanceList').textContent.includes('09:00') || document.getElementById('attendanceList').textContent.includes(':');`),
            '名單上該列變成已簽到並顯示時間');
        check(JSON.stringify(state.tables.audit_logs).includes('REGISTER_ATTENDED'), '簽到留了稽核紀錄');
        check(await browser.evaluate(`return document.getElementById('attendanceCodeInput').value === '';`),
            '簽到成功後輸入欄清空（方便連續掃／打下一筆）');

        /* ---------- 4. 重複掃同一張碼 → 要說「已經簽到過」 ---------- */
        await browser.evaluate(`
            const input = document.getElementById('attendanceCodeInput');
            input.value = ${JSON.stringify(CODE_A)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('attendanceCodeBtn').click();
            return true;
        `);
        await browser.waitFor(`/已經簽到過/.test((document.getElementById('teamMsg') || {}).textContent || '')`, { timeout: 10000 });
        check(true, '重複掃同一張碼會提示「已經簽到過」（現場排隊最常見的情況）');

        /* ---------- 5. 錯的碼與候補的碼都要擋 ---------- */
        await browser.evaluate(`
            const input = document.getElementById('attendanceCodeInput');
            input.value = 'ZZZZ9999';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('attendanceCodeBtn').click();
            return true;
        `);
        await browser.waitFor(`/找不到/.test((document.getElementById('teamMsg') || {}).textContent || '')`, { timeout: 10000 });
        check(true, '不存在的報到碼會說找不到（不會靜默失敗）');

        await browser.evaluate(`
            const input = document.getElementById('attendanceCodeInput');
            input.value = ${JSON.stringify(CODE_WAIT)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('attendanceCodeBtn').click();
            return true;
        `);
        await browser.waitFor(`/候補/.test((document.getElementById('teamMsg') || {}).textContent || '')`, { timeout: 10000 });
        check(!reg(933).attended_at, '候補的碼刷不過（名額會對不上帳）');
        check(/只有「正取」可以簽到/.test(await teamMsg()), '並說明要先遞補成正取再簽到');

        /* ---------- 6. 選手端：只看得到自己的報到碼，而且要畫出 QR ---------- */
        await logout(browser);
        await login(browser, PLAYER, PLAYER_PASS);
        await browser.evaluate(`document.getElementById('myRegsBtn')?.click(); return true;`);
        await browser.waitFor(`!document.getElementById('myRegsModal').classList.contains('hidden')`, { timeout: 10000 });
        await browser.waitFor(`document.querySelector('[data-action="show-checkin-qr"]') !== null`, { timeout: 12000 });
        check(true, '選手在自己的「我的報名」看得到「📷 報到碼 / QR」按鈕');

        await browser.evaluate(`document.querySelector('[data-action="show-checkin-qr"]').click(); return true;`);
        await browser.waitFor(`!document.getElementById('checkinQrModal').classList.contains('hidden')`, { timeout: 8000 });
        const shownCode = await browser.evaluate(`return document.getElementById('checkinQrCode').textContent.trim();`);
        check(shownCode === CODE_A, `彈窗顯示自己的 8 碼報到碼（${shownCode}）`);
        const qrInfo = await browser.evaluate(`
            const svg = document.querySelector('#checkinQrBox svg');
            if (!svg) return JSON.stringify({ svg: false });
            return JSON.stringify({
                svg: true,
                crisp: svg.getAttribute('shape-rendering'),
                w: svg.getAttribute('width'),
                rects: svg.querySelectorAll('rect').length,
                title: (svg.querySelector('title') || {}).textContent || ''
            });
        `);
        const qr = JSON.parse(qrInfo);
        check(qr.svg === true, '彈窗裡真的畫出一張 QR（SVG）');
        check(qr.crisp === 'crispEdges', 'QR 用 crispEdges 畫（否則格子被糊掉就掃不到）');
        check(Number(qr.rects) > 100, `QR 的深色格子數合理（${qr.rects}）`);
        check(/報到碼/.test(qr.title) && qr.title.includes(CODE_A), `QR 有無障礙標題且不含機密外洩（${qr.title}）`);
        check(Number(qr.w) > 100, `QR 尺寸足夠（${qr.w}px 寬，現場手機螢幕才掃得到）`);
        await browser.evaluate(`document.getElementById('closeCheckinQrBtn').click(); return true;`);
        check(await browser.evaluate(`return document.getElementById('checkinQrModal').classList.contains('hidden');`),
            'QR 彈窗可以關閉');

        /* ---------- 7. 手機寬度不橫向溢出、沒有前端例外 ---------- */
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
        check(overflow <= 1, `手機寬度（414px）沒有橫向溢出（${overflow}px）`);
        const errors = browser.errors || [];
        check(errors.length === 0, '過程中沒有前端例外', errors.slice(0, 2).join(' | '));

        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`   ❌ 檢查過程發生例外：${err.message}`);
        exitCode = 1;
    } finally {
        try { await browser.close(); } catch (err) { /* 忽略 */ }
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    }
    console.log(`\n══════ 掃碼報到與報到碼介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
