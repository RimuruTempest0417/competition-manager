/* 正式站「訪客視角」檢查（v2.14.0 建立，RLS 開啟後的必要驗證）
 *
 * 為什麼需要它：`prod-smoke.js` 只打 HTTP／API，看不到前端是否真的跑起來。
 * 開啟 RLS 後如果伺服器讀不到資料，前台會「有畫面但沒有賽事」——只有真實瀏覽器才看得出來。
 *
 * 檢查內容（全部只讀，不修改任何資料）：
 *   1. 訪客開啟首頁，賽事卡片真的渲染出來（公開讀取正常）
 *   2. 沒有未捕捉的前端例外、沒有非預期的 console 錯誤
 *   3. 線上版本字串與 package.json 一致
 *
 * 用法：node tests/browser/prod-visitor-check.js [https://其他網址]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Browser } = require('./lib/cdp');

const ROOT = path.join(__dirname, '..', '..');
const SITE = (process.argv[2] || process.env.SITE || 'https://competition-manager-hazel.vercel.app').replace(/\/+$/, '');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-visitor-check');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

(async () => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    console.log(`\n🧪 正式站訪客視角檢查：${SITE}（預期版本 v${EXPECTED}）`);
    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(SITE, { waitMs: 2000 });

        let rendered = false;
        try {
            await browser.waitFor(`document.querySelectorAll('[data-action="register-comp"]').length > 0`, { timeout: 15000 });
            rendered = true;
        } catch (err) {
            rendered = false;
        }
        const cards = await browser.evaluate(`return document.querySelectorAll('[data-action="register-comp"]').length;`);
        check(rendered, '訪客看得到賽事卡片（公開讀取正常、沒有因為資料庫權限而空白）', `卡片數 ${cards}`);
        check(cards > 0, `賽事卡片數量正常（${cards} 張）`);

        const title = await browser.evaluate(`return document.title;`);
        check(new RegExp(`v${EXPECTED.replace(/\./g, '\\.')}`).test(title), `線上版本為 v${EXPECTED}`, title);

        check(browser.pageErrors.length === 0, '沒有未捕捉的前端例外', browser.pageErrors.join(' | '));
        const noise = browser.consoleErrors.filter((m) => !/favicon|Failed to load resource|401|403/.test(m));
        check(noise.length === 0, '沒有非預期的 console 錯誤', noise.join(' | '));

        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check(overflow <= 1, `手機寬度沒有橫向溢出（${overflow}px）`, `${overflow}px`);

        // v2.27.0：地圖連結真的渲染在卡片上（有地點就該有地圖可按）
        const mapLinks = JSON.parse(await browser.evaluate(`
            const links = Array.from(document.querySelectorAll('[data-comp-id] a[href*="maps"]'));
            return JSON.stringify({
                count: links.length,
                allHttps: links.every((a) => /^https:\\/\\//i.test(a.getAttribute('href') || '')),
                allBlankSafe: links.every((a) => a.getAttribute('target') === '_blank' && (a.getAttribute('rel') || '').includes('noopener'))
            });
        `));
        check(mapLinks.count > 0, `卡片上有地圖連結（${mapLinks.count} 個）`);
        check(mapLinks.allHttps && mapLinks.allBlankSafe, '地圖連結都是 https 且另開新頁帶 rel=noopener');

        const shot = path.join(SHOT_DIR, `visitor-${Date.now()}.png`);
        await browser.screenshot(shot);
        console.log(`\n   📸 截圖：${shot}`);
        console.log(`\n══════ 訪客視角檢查：${pass} 通過 / ${fail} 失敗 ══════`);
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
    }
    // 一定要等 finally 把 Chrome 收掉再結束行程：在 try 裡直接 process.exit()
    // 會讓 finally 的 await 來不及跑，留下一隻沒人管的 headless Chrome（v2.16.0 修）。
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查執行失敗：', err.message);
    process.exit(1);
});
