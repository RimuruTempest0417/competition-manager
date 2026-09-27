/* v3.6.6：手機版位檢查（真實 Chrome ＋ 本機 server ＋ 假 Supabase）
 *
 * 為什麼要單獨一支：既有的 layout-check.js 最小只測到 414px，而且要嘛看卡片、要嘛看彈窗，
 * 沒有量「表單區塊」。使用者的手機是 402px（截圖 804 寬），問題就在那個寬度才出現：
 *   ① 「發佈比賽」按鈕被擠成細長直條（中文直排）——它和上傳海報區塊同一個 flex 列，
 *      手機上被壓到 min-content 寬度（一個字寬）。
 *   ② 「報名開始 / 報名截止」是沒有響應式前綴的 grid-cols-2，
 *      datetime-local 欄位的最小寬度比半個卡片還寬 → 溢出卡片右緣。
 *   ③ 篩選列的日期欄位沒有任何標籤，手機上是「一個空白框」。
 *
 * 依使用者指示：這一支**不寫任何截圖檔**。
 * 用法：node tests/browser/mobile-layout-check.js
 */
const path = require('node:path');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3331);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'owner-mobile';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* 使用者的手機（截圖 804px 寬 ÷ 2）與 iPhone 14/15 級距 */
const SIZES = [
    { label: '手機 402（使用者回報的寬度）', width: 402, height: 874 },
    { label: '手機 390（iPhone 14/15）', width: 390, height: 844 },
    { label: '手機 360（Android 小機）', width: 360, height: 800 },
    { label: '平板 834', width: 834, height: 1112 },
    { label: '桌機 1440', width: 1440, height: 900 }
];

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true }
            ],
            competitions: [
                { id: 851, name: '手機版位測試盃', date: '2026-12-20', time: '09:00', end_date: '2026-12-20', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 20, requires_approval: false, waitlist_enabled: true, created_at: '2026-01-01T00:00:00.000Z' }
            ],
            registrations: [],
            audit_logs: [],
            push_subscriptions: [],
            app_settings: []
        },
        nextId: { audit_logs: 900 }
    };
}

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

/* 量測：頁面溢出、指定元素、可見按鈕、沒有名字的表單欄位 */
const MEASURE = `
    const vw = document.documentElement.clientWidth;
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
        return r;
    };
    const label = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);

    // 頁面本身有沒有橫向溢出
    const pageScroll = document.documentElement.scrollWidth;
    const overflowers = [];
    document.querySelectorAll('body *').forEach((el) => {
        const r = visible(el);
        if (!r) return;
        if (r.right > vw + 1) {
            // 排除「本來就設計成可橫向捲動」的容器內部元件
            let p = el.parentElement, inScroller = false;
            while (p && p !== document.body) {
                const o = getComputedStyle(p).overflowX;
                if (o === 'auto' || o === 'scroll') { inScroller = true; break; }
                p = p.parentElement;
            }
            if (!inScroller) overflowers.push(label(el) + '@' + Math.round(r.right));
        }
    });

    const rect = (id) => {
        const el = document.getElementById(id);
        const r = el ? el.getBoundingClientRect() : null;
        return r ? { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), left: Math.round(r.left) } : null;
    };

    // 卡片右緣（表單與列表各一張）當作「不該超出的界線」
    const cardRight = (el) => el ? Math.round(el.getBoundingClientRect().right) : null;
    const form = document.getElementById('competitionForm');
    const regStart = document.getElementById('registration_start_at');
    const regEnd = document.getElementById('registration_end_at');

    // 文字按鈕被壓成細條（寬 < 44px 但裡面有 2 個字以上）
    const crushed = [];
    document.querySelectorAll('button, a.button-like').forEach((el) => {
        const r = visible(el);
        if (!r) return;
        const text = String(el.innerText || '').trim();
        if (text.length >= 2 && r.width < 44 && r.height > 30) crushed.push(label(el) + '(' + r.width.toFixed(0) + 'px:' + text.slice(0, 8) + ')');
    });

    // 沒有可辨識名稱的表單欄位（date/datetime-local 不能有 placeholder，所以一定要有 label 或 aria-label）
    const nameless = [];
    document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea').forEach((el) => {
        const r = visible(el);
        if (!r) return;
        let named = !!(el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder);
        if (!named && el.id) {
            if (document.querySelector('label[for="' + el.id + '"]')) named = true;
            const closest = el.closest('label');
            if (closest) named = true;
        }
        if (!named) nameless.push(label(el) + '(' + el.type + ')');
    });

    return JSON.stringify({
        vw: vw,
        pageScroll: pageScroll,
        overflow: pageScroll > vw + 1,
        overflowers: overflowers.slice(0, 6),
        submitBtn: rect('submitBtn'),
        regStart: regStart ? { w: Math.round(regStart.getBoundingClientRect().width), right: Math.round(regStart.getBoundingClientRect().right) } : null,
        regEnd: regEnd ? { w: Math.round(regEnd.getBoundingClientRect().width), right: Math.round(regEnd.getBoundingClientRect().right) } : null,
        formRight: cardRight(form),
        filterDate: rect('filterDateInput'),
        posterBlock: rect('posterBlock'),
        dateFields: (() => {
            const ids = ['date', 'end_date', 'registration_start_at', 'registration_end_at'];
            const base = document.getElementById('name');
            const baseRight = base ? Math.round(base.getBoundingClientRect().right) : null;
            return ids.map((id) => {
                const el = document.getElementById(id);
                if (!el) return { id: id, missing: true };
                const wrap = el.closest('.cm-date-wrap');
                const hint = wrap ? wrap.querySelector('.cm-date-hint') : null;
                const cs = getComputedStyle(el);
                return {
                    id: id,
                    w: Math.round(el.getBoundingClientRect().width),
                    right: Math.round(el.getBoundingClientRect().right),
                    overflow: baseRight !== null ? Math.round(el.getBoundingClientRect().right) - baseRight : null,
                    wrap: !!wrap,
                    hintVisible: !!hint && getComputedStyle(hint).display !== 'none',
                    minW: cs.minWidth, maxW: cs.maxWidth,
                    val: String(el.value || '')
                };
            });
        })(),
        filterDateRow: (() => {
            const wrap = document.querySelector('.cm-filter-date');
            if (!wrap) return null;
            const r = wrap.getBoundingClientRect();
            const lab = wrap.querySelector('label');
            const inp = wrap.querySelector('input');
            if (!lab || !inp) return null;
            const lb = lab.getBoundingClientRect(), ib = inp.getBoundingClientRect();
            return {
                w: Math.round(r.width),
                sameRow: Math.abs((lb.top + lb.height / 2) - (ib.top + ib.height / 2)) <= 6,
                labelAlone: Math.abs(lb.width - r.width) < 8   // 標籤自己佔滿整格 = 壞掉
            };
        })(),
        headerParts: (() => {
            const h = document.querySelector('.cm-header-inner');
            if (!h) return null;
            const kids = Array.from(h.children).map((el) => Math.round(el.getBoundingClientRect().width));
            return { total: Math.round(h.getBoundingClientRect().width), kids: kids };
        })(),
        authPill: (() => {
            const el = document.getElementById('authStatus');
            if (!el) return null;
            const cs = getComputedStyle(el);
            return {
                h: Math.round(el.getBoundingClientRect().height), lh: Math.round(parseFloat(cs.lineHeight) || 0),
                fs: cs.fontSize, sw: el.scrollWidth, cw: el.clientWidth,
                maxW: cs.maxWidth, text: String(el.innerText || '').replace(/\s+/g, ' ').trim()
            };
        })(),
        filterDateNamed: (() => {
            const el = document.getElementById('filterDateInput');
            if (!el) return false;
            return !!(el.getAttribute('aria-label') || el.getAttribute('title') ||
                (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label'));
        })(),
        title: (() => {
            const h = document.querySelector('.cm-app-title');
            if (!h) return null;
            const r = h.getBoundingClientRect();
            const cs = getComputedStyle(h);
            return { h: Math.round(r.height), lh: Math.round(parseFloat(cs.lineHeight) || 0), overflow: h.scrollWidth > h.clientWidth + 1 };
        })(),
        crushed: crushed.slice(0, 6),
        nameless: nameless.slice(0, 8)
    });
`;

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
    console.log(`\n🧪 手機版位檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    let exitCode = 1;
    try {
        for (const size of SIZES) {
            const browser = await Browser.launch({ width: size.width, height: size.height, mobile: true });
            const step = size.label;
            console.log(`\n── ${step} ──`);
            try {
                await browser.goto(BASE);
                await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 15000 });
                await login(browser, ADMIN, PASS);
                await browser.waitFor(`document.getElementById('competitionForm') !== null`, { timeout: 15000 });
                await new Promise((r) => setTimeout(r, 400));

                const m = JSON.parse(await browser.evaluate(`return (() => { ${MEASURE} })();`));
                console.log(`   ℹ️ 視窗 ${m.vw}px｜頁面 scrollWidth ${m.pageScroll}｜發佈比賽按鈕 ${m.submitBtn.w}×${m.submitBtn.h}px｜報名欄位 ${JSON.stringify(m.regStart)}／${JSON.stringify(m.regEnd)}｜卡片右緣 ${m.formRight}｜篩選日期 ${JSON.stringify(m.filterDate)}｜海報區塊 ${JSON.stringify(m.posterBlock)}｜日期欄 ${(m.dateFields || []).map((f) => `${f.id}:${f.w}px/超出${f.overflow}px/提示${f.hintVisible ? '有' : '無'}`).join('、')}｜header ${JSON.stringify(m.headerParts)}｜pill ${JSON.stringify(m.authPill)}`);

                check(m.submitBtn.w >= 88, `${step}｜「發佈比賽」按鈕沒有被壓成細條（寬 ${m.submitBtn.w}px ≥ 88px）`);
                check(!m.overflow, `${step}｜沒有橫向溢出`, m.overflowers.length ? '超出者：' + m.overflowers.join(', ') : '');

                if (size.width < 640) {
                    /* ① 「發佈比賽」按鈕必須是「一整條好按的」——不能被壓成直排細條 */
                    check(m.submitBtn.w >= Math.round(size.width * 0.6), `${step}｜「發佈比賽」按鈕是好按的整條（寬 ${m.submitBtn.w}px ≥ ${Math.round(size.width * 0.6)}px）`);
                    check(m.submitBtn.h >= 32 && m.submitBtn.h <= 80, `${step}｜「發佈比賽」按鈕高度正常（${m.submitBtn.h}px，介於 32～80px）`);

                    /* ② 報名時間欄位不能溢出卡片，也不能被壓扁到看不清楚 */
                    check(!!m.regStart && !!m.regEnd && m.regStart.right <= m.formRight + 1 && m.regEnd.right <= m.formRight + 1,
                        `${step}｜「報名開始／截止」欄位都在卡片內（右緣 ${m.regStart && m.regStart.right}／${m.regEnd && m.regEnd.right} ≤ ${m.formRight}）`);
                    check(!!m.regStart && m.regStart.w >= Math.round(size.width * 0.6),
                        `${step}｜「報名開始」欄位是整條、沒有被壓扁（寬 ${m.regStart && m.regStart.w}px ≥ ${Math.round(size.width * 0.6)}px）`);
                    check(!!m.title && m.title.h <= m.title.lh * 1.6 && !m.title.overflow,
                        `${step}｜頁面標題沒有被折成兩行（高 ${m.title && m.title.h}px、行高 ${m.title && m.title.lh}px）`);

                    /* ③ 篩選列的日期欄位要有名字（手機上 date 欄位沒有 placeholder → 會變成空白框） */
                    check(m.filterDateNamed, `${step}｜篩選列的日期欄位有標籤可辨識（不是一個空白框）`);
                    m.dateFields.forEach((f) => {
                        if (f.missing) { check(false, `${step}｜找不到日期欄位 ${f.id}`); return; }
                        check(f.wrap && f.hintVisible,
                            `${step}｜${f.id} 空值時有看得見的提示（iOS 上空日期欄完全不顯示文字）`);
                        check(f.overflow !== null && f.overflow <= 1,
                            `${step}｜${f.id} 沒有凸出卡片（右緣超出 ${f.overflow}px）`);
                        check(f.minW === '0px' && f.maxW === '100%',
                            `${step}｜${f.id} 已可被壓縮（min-width ${f.minW}／max-width ${f.maxW}）— iOS 原生日期欄的內在寬度會把方框頂出去`);
                    });
                    check(!!m.filterDateRow && m.filterDateRow.sameRow && !m.filterDateRow.labelAlone && m.filterDateRow.w >= Math.round(size.width * 0.6),
                        `${step}｜篩選列「📅 日期」與欄位同一列且佔滿寬度（寬 ${m.filterDateRow && m.filterDateRow.w}px）`);
                    check(!!m.authPill && m.authPill.h <= m.authPill.lh * 1.8,
                        `${step}｜右上身份標籤沒有被折成多行（高 ${m.authPill && m.authPill.h}px、行高 ${m.authPill && m.authPill.lh}px）`);

                    /* ④ 沒有文字按鈕被壓成比 44px 還窄（手機點不到） */
                    check(m.crushed.length === 0, `${step}｜沒有文字按鈕被壓成細條`, m.crushed.join(', '));

                    /* ⑤ 每個表單欄位都有可辨識名稱 */
                    check(m.nameless.length === 0, `${step}｜每個表單欄位都有標籤或說明`, m.nameless.join(', '));
                }

                if (size.width >= 1024) {
                    /* 桌機：送出按鈕是一般高度、上傳海報區塊不佔位（v3.6.7） */
                    check(m.submitBtn.h <= 60, `${step}｜「發佈比賽」按鈕是一般高度（${m.submitBtn.h}px ≤ 60px）`);
                    check(!!m.posterBlock && m.posterBlock.h <= 90,
                        `${step}｜「手動上傳海報」區塊不佔位（高 ${m.posterBlock && m.posterBlock.h}px ≤ 90px）`);
                }

                const errors = (browser.errors || []).filter((e) => !/favicon|ResizeObserver/.test(String(e)));
                check(errors.length === 0, `${step}｜過程中沒有前端例外`, errors.slice(0, 2).join(' | '));
            } finally {
                await browser.close();
            }
        }
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.error(`   ❌ 檢查腳本執行失敗： ${err.message}`);
        exitCode = 1;
    } finally {
        server.close();
        await stub.close();
        console.log(`\n══════ 手機版位檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
        process.exit(exitCode);
    }
})();
