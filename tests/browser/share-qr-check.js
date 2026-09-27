/* v3.7.0：賽事分享連結與 QR 的介面檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 這一版要解決的是「使用者太少」：讓既有分享工具（複製文字、分享海報）之外，
 * 多一個「掃了就去報名」的入口。所以檢查就針對它最容易壞的地方：
 *   ① 分享按鈕必須**訪客也看得到**（要分享的人常常還沒登入）。
 *   ② QR 一定要真的畫出來、而且格子數與 CMQr 對同一條連結的編碼一致
 *      （畫錯格子不會報錯，只會掃不到——由 tests/qr.test.js 的 macOS Vision 解碼把關內容）。
 *   ③ 深連結 `#c<編號>` 要能捲到那張卡片並直接開報名；**未登入時要先要求登入**，
 *      不可以什麼都不做（掃碼進來的人多半是第一次用）。
 *
 * 依使用者指示：這一支**不寫任何截圖檔**，也不下載任何檔案。
 * 用法：node tests/browser/share-qr-check.js
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3326);
const BASE = `http://127.0.0.1:${PORT}`;
const COMP_ID = 851;
const COMP_NAME = '分享盃';
const PLAYER = 'player-share';
const PLAYER_PASS = 'playerpass123';

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
                { id: 60, username: PLAYER, password: PLAYER_PASS, role: 'user', is_active: true }
            ],
            competitions: [
                { id: COMP_ID, name: COMP_NAME, date: '2026-12-24', time: '10:00', end_date: '2026-12-24', end_time: '17:00',
                  location: '分享體育館', is_registration_open: true, is_deleted: false, max_registrations: 30,
                  requires_approval: false, waitlist_enabled: true, tags: [], created_at: '2026-01-01T00:00:00.000Z' }
            ],
            registrations: [],
            audit_logs: [],
            push_subscriptions: [],
            app_settings: []
        },
        nextId: { registrations: 960, audit_logs: 960 }
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
    await browser.evaluate(`
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
    await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
};

(async () => {
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.NODE_ENV = 'production';
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-share-secret';
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-service-key';
    process.env.SITE_URL = BASE;

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 賽事分享連結與 QR 介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);
        await browser.waitFor(`document.querySelector('button[data-action="share-link"]') !== null`, { timeout: 10000 });

        /* ---------- 1. 訪客也看得到分享按鈕 ---------- */
        check(await browser.evaluate(`return document.querySelector('button[data-action="share-link"]') !== null;`),
            '訪客（未登入）就看得到「🔗 分享連結／QR」按鈕');

        /* ---------- 2. 分享彈窗內容 ---------- */
        await browser.evaluate(`document.querySelector('button[data-action="share-link"][data-id="${COMP_ID}"]').click(); return true;`);
        await browser.waitFor(`!document.getElementById('shareModal').classList.contains('hidden')`, { timeout: 8000 });

        const info = JSON.parse(await browser.evaluate(`
            const modal = document.getElementById('shareModal');
            const svg = document.querySelector('#shareQrBox svg');
            const input = document.getElementById('shareLinkInput');
            const expect = CMQr.encode(input.value, { level: 'L' });
            const expectedRects = expect.matrix.flat().filter(Boolean).length;
            return JSON.stringify({
                label: (document.getElementById('shareComp') || {}).innerText || '',
                link: input.value,
                readOnly: input.hasAttribute('readonly'),
                svg: !!svg,
                crisp: svg ? svg.getAttribute('shape-rendering') : null,
                rects: svg ? svg.querySelectorAll('rect').length : 0,
                expectedRects: expectedRects,
                qrVersion: expect.version,
                title: svg ? ((svg.querySelector('title') || {}).textContent || '') : '',
                width: svg ? Math.round(svg.getBoundingClientRect().width) : 0
            });
        `));

        check(info.link === `${BASE}/#c${COMP_ID}`, `連結是賽事的深連結（${info.link}）`);
        check(info.readOnly, '連結欄位是唯讀的（避免誤改後複製到錯的連結）');
        check(/分享盃/.test(info.label), `彈窗標題帶出賽事名稱（${info.label}）`);
        check(info.svg === true, '彈窗裡真的畫出一張 QR（SVG）');
        check(info.crisp === 'crispEdges', 'QR 用 crispEdges 畫（否則格子被糊掉就掃不到）');
        check(info.rects === info.expectedRects + 1,
            `QR 的格子數與同一條連結的編碼一致（${info.rects} vs ${info.expectedRects} + 底色）`);
        check(info.qrVersion <= 3, `QR 版本在產生器支援範圍內（v${info.qrVersion}）`);
        check(/分享盃/.test(info.title), `QR 有無障礙標題且帶賽事名稱（${info.title}）`);
        check(info.width > 100, `QR 尺寸足夠（${info.width}px 寬）`);

        /* ---------- 3. 複製連結要有回饋 ---------- */
        await browser.evaluate(`document.getElementById('shareCopyLinkBtn').click(); return true;`);
        await new Promise((r) => setTimeout(r, 600));
        const copied = await browser.evaluate(`
            const el = document.getElementById('shareMsg');
            return el && !el.classList.contains('hidden') ? el.textContent.trim() : '';
        `);
        check(copied.length > 0, `按下「複製連結」有明確回饋（${copied}）`);

        /* ---------- 4. 關閉 ---------- */
        await browser.evaluate(`document.getElementById('closeShareModalBtn2').click(); return true;`);
        check(await browser.evaluate(`return document.getElementById('shareModal').classList.contains('hidden');`),
            '分享彈窗可以關閉');

        /* ---------- 5. 深連結：未登入要先要求登入 ---------- */
        await browser.goto('about:blank'); // 只改 hash 不會重新載入；掃碼是全新載入，這裡照樣模擬
        await browser.goto(`${BASE}/#c${COMP_ID}`);
        await browser.waitFor(`document.querySelector('button[data-action="share-link"]') !== null`, { timeout: 10000 });
        await browser.evaluate(STUB_DIALOGS);
        await new Promise((r) => setTimeout(r, 2500));
        const guestDeep = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                highlighted: !!document.querySelector('.cm-card-highlight'),
                loginOpen: !document.getElementById('loginModal').classList.contains('hidden'),
                registerOpen: !!document.getElementById('registerModal') && !document.getElementById('registerModal').classList.contains('hidden'),
                notice: (document.getElementById('loginNotice') || {}).innerText || ''
            });
        `));
        check(guestDeep.highlighted || guestDeep.loginOpen,
            `深連結進來會指出那場賽事（高亮 ${guestDeep.highlighted}／登入視窗 ${guestDeep.loginOpen}）`);
        check(guestDeep.loginOpen && !guestDeep.registerOpen,
            `未登入時深連結要求先登入、不直接開報名（登入提示：${guestDeep.notice}）`);

        /* ---------- 6. 深連結：登入後直接開報名 ---------- */
        await login(browser, PLAYER, PLAYER_PASS);
        await browser.goto('about:blank'); // 只改 hash 不會重新載入；掃碼是全新載入，這裡照樣模擬
        await browser.goto(`${BASE}/#c${COMP_ID}`);
        await browser.waitFor(`document.querySelector('button[data-action="register-comp"]') !== null`, { timeout: 10000 });
        await browser.evaluate(STUB_DIALOGS);
        await browser.waitFor(`!document.getElementById('registerModal').classList.contains('hidden')`, { timeout: 8000 })
            .then(() => check(true, '登入後用深連結進來會直接開該賽事的報名視窗'))
            .catch(() => check(false, '登入後用深連結進來會直接開該賽事的報名視窗（等不到報名視窗）'));

        /* ---------- 7. 沒有前端例外、手機不橫向溢出 ---------- */
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
        check(overflow <= 1, `手機寬度（414px）沒有橫向溢出（${overflow}px）`);
        const errors = browser.errors || [];
        check(errors.length === 0, '過程中沒有前端例外', errors.slice(0, 2).join(' | '));

        /* ── v3.8.0：卡片上的「📋 複製文字」要產生可直接貼群組的完整文案（含報名連結）──
           把剪貼簿換成攔截器，直接看它實際寫入了什麼。 */
        {
            await browser.evaluate(`
                window.__copied = null;
                const stub = { writeText: (t) => { window.__copied = String(t); return Promise.resolve(); } };
                try { Object.defineProperty(navigator, 'clipboard', { value: stub, configurable: true }); }
                catch (err) { navigator.clipboard.writeText = stub.writeText; }
                const btn = document.querySelector('button[data-action="copy-text"][data-id="${COMP_ID}"]');
                if (btn) btn.click();
                return true;
            `);
            await browser.waitFor(`!!window.__copied`, { timeout: 5000 });
            const copied = String(await browser.evaluate(`return window.__copied;`));
            check(copied.includes(COMP_NAME),
                `複製的文案含賽事名稱（檢查「${COMP_NAME}」）— 開頭「${copied.slice(0, 30).replace(/\n/g, '⏎')}」`);
            check(copied.includes(`/#c${COMP_ID}`), `★複製的文案含可直接點的報名連結（#c${COMP_ID}）`);
            check(/報名：/.test(copied) || /名額：/.test(copied),
                '複製的文案帶到報名期間或名額等實用資訊（不是只有名稱與地點）');
            check(!copied.includes('undefined') && !copied.includes('null'),
                '複製的文案沒有 undefined／null 這種漏欄位的痕跡');
        }

        /* ── v3.8.0：海報必須自動帶一張「掃得到報名頁」的 QR ──
           驗法是拿 canvas 產生的 PNG 交給 macOS Vision 這支獨立解碼器解，
           解出來的內容必須正好是分享連結。畫錯格子不會報錯，只會掃不到。 */
        {
            await browser.evaluate(`
                const modal = document.getElementById('posterModal');
                if (modal) modal.classList.add('hidden');
                const btn = document.querySelector('button[data-action="share-poster"]');
                if (btn) btn.click();
                return true;
            `);
            await browser.waitFor(`!document.getElementById('posterModal').classList.contains('hidden')`, { timeout: 8000 });
            const dataUrl = String(await browser.evaluate(
                `return document.getElementById('posterCanvas').toDataURL('image/png');`));
            check(/^data:image\/png;base64,/.test(dataUrl), '海報 canvas 有畫出內容（產生了 PNG）');

            try {
                // 檢查腳本一律不得自己寫圖檔（no-screenshot-check 守門），
                // 所以把 base64 用管線餵給解碼器，完全不落地。
                const decoded = execFileSync('swift',
                    [path.join(__dirname, '..', '..', 'scripts', 'qr-decode.swift'), '-'],
                    { encoding: 'utf8', input: dataUrl }).trim();
                const expected = `http://127.0.0.1:${PORT}/#c${COMP_ID}`;
                check(decoded === expected,
                    `★海報右下角的 QR 掃出來就是分享連結（獨立解碼器解到「${decoded}」）`);
            } catch (err) {
                check(false, '★海報 QR 必須能被獨立解碼器解出', String(err.message).slice(0, 140));
            }
        }

        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`   ❌ 檢查過程發生例外：${err.message}`);
        exitCode = 1;
    } finally {
        try { await browser.close(); } catch (err) { /* 忽略 */ }
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    }
    console.log(`\n══════ 賽事分享連結與 QR 介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
