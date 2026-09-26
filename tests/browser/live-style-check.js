/* v2.27.0 修復驗證：檢查線上（或指定網址）所有「曾經用 sky-* 導致隱形」的按鈕，
 * 以及做一次「文字顏色＝底色」的隱形文字掃描。
 *
 * 為什麼要這樣驗：這類 bug 在 API／HTML 層看不出來（class 有寫、元素也在），
 * 只有真的算過 CSS 才看得到「白字配透明底」。訪客身分也驗得到——
 * 元素被隱藏的容器包著時，getComputedStyle 依然會回傳規則算出的顏色。
 *
 * 用法：node tests/browser/live-style-check.js [https://其他網址]
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Browser } = require('./lib/cdp');

const SITE = (process.argv[2] || process.env.SITE || 'https://competition-manager-hazel.vercel.app').replace(/\/+$/, '');
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-live-style-check');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* 曾經用 bg-sky-600 text-white 的送出按鈕（v2.25.0／v2.26.0 引入，v2.27.0 修為 blue） */
const PRIMARY_BUTTONS = [
    ['savePushSettingsBtn', '推播設定的「儲存設定」'],
    ['saveAnnounceCatsBtn', '公告中心的「儲存訂閱」'],
    ['submitAnnounceBtn', '公告中心的「發布公告」'],
    ['staffAssignBtn', '工作人員的「指派／更新」']
];

/* 曾經用 text-sky-600 的連結式按鈕（顏色算得出來就寫進檢查結果） */
const LINK_BUTTONS = [
    ['markAllAnnounceReadBtn', '「全部標記已讀」'],
    ['toggleAnnounceFormBtn', '「＋ 發布新公告」']
];

(async () => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    console.log(`\n🧪 線上樣式檢查（隱形按鈕／隱形文字）：${SITE}`);
    const browser = await Browser.launch({ width: 1280, height: 900 });
    let exitCode = 1;
    try {
        await browser.goto(SITE, { waitMs: 2500 });

        const version = JSON.parse(await browser.evaluate(`return fetch('/api/version').then((r) => r.json()).then((d) => JSON.stringify(d));`));
        console.log(`   線上版本：v${version.version}`);

        const styles = JSON.parse(await browser.evaluate(`
            const ids = ${JSON.stringify(PRIMARY_BUTTONS.map((b) => b[0]).concat(LINK_BUTTONS.map((b) => b[0])))};
            const out = {};
            ids.forEach((id) => {
                const el = document.getElementById(id);
                if (!el) { out[id] = null; return; }
                const cs = getComputedStyle(el);
                out[id] = { bg: cs.backgroundColor, color: cs.color, display: cs.display, tag: el.tagName };
            });
            return JSON.stringify(out);
        `));

        for (const [id, label] of PRIMARY_BUTTONS) {
            const st = styles[id];
            if (!st) { check(false, `${label}（#${id}）存在於頁面上`); continue; }
            const hasBg = st.bg !== 'rgba(0, 0, 0, 0)' && st.bg !== 'transparent';
            check(hasBg && st.color !== st.bg,
                `${label}有底色且文字看得見（底 ${st.bg}／字 ${st.color}）`,
                '底色透明或字色與底色相同＝按鈕隱形');
        }

        for (const [id, label] of LINK_BUTTONS) {
            const st = styles[id];
            if (!st) { check(false, `${label}（#${id}）存在於頁面上`); continue; }
            check(st.color !== 'rgba(0, 0, 0, 0)' && st.color !== 'rgb(255, 255, 255)',
                `${label}的文字顏色不是白色（${st.color}）`, '白字在淺色底上等於看不到');
        }

        // 全頁掃描：文字顏色與（不透明的）底色完全相同＝看不見的文字
        const invisible = JSON.parse(await browser.evaluate(`
            const out = [];
            document.querySelectorAll('button, a, span, p, label, h1, h2, h3, td, th, div').forEach((el) => {
                if (!el.textContent || !el.textContent.trim()) return;
                if (el.children.length > 0) return;                 // 只看葉節點，避免誤判容器
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
                const bg = cs.backgroundColor;
                const opaque = bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg);
                if (opaque && bg === cs.color) {
                    out.push({ tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 60), text: el.textContent.trim().slice(0, 30), color: cs.color });
                }
            });
            return JSON.stringify(out.slice(0, 10));
        `));
        check(invisible.length === 0, `頁面上沒有「字色＝底色」的隱形文字（${invisible.length} 個）`,
            JSON.stringify(invisible).slice(0, 300));

        check(browser.pageErrors.length === 0, '沒有未捕捉的前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        const shot = path.join(SHOT_DIR, `live-style-${Date.now()}.png`);
        await browser.screenshot(shot);
        console.log(`\n   📸 截圖：${shot}`);
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`   ❌ 檢查腳本執行失敗：${err.message}`);
        exitCode = 1;
    } finally {
        await browser.close();
    }
    console.log(`\n══════ 線上樣式檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
