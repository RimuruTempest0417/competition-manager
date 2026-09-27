/* v3.6.7：「不保留任何 screenshot」的守門檢查
 *
 * 使用者 2026-09-26 明定：不要保留任何 screenshot。機制本來就在
 * `tests/browser/lib/cdp.js` 的 `screenshot()`（沒有 CM_KEEP_SCREENSHOTS=1 就回 null），
 * 但沒有人在守它——所以檢查腳本可以「以為自己存了圖」，輸出也會說謊。
 * 這支檢查把三件事變成常駐斷言：
 *   ① 行為：預設不寫檔、檔案真的不存在；要親眼看畫面時（CM_KEEP_SCREENSHOTS=1）仍寫得出來。
 *   ② 靜態：除了 cdp.js，沒有任何地方自己寫圖檔；截圖目錄的建立與「📸 截圖」的輸出
 *      都必須在旗標保護之下（否則會產生空目錄、或在沒存檔時宣稱存了檔）。
 *   ③ 收尾：跑完後 repo 內沒有多出任何圖片檔（git status 乾淨）。
 *
 * 用法：node tests/browser/no-screenshot-check.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Browser } = require('./lib/cdp');

const BROWSER_DIR = __dirname;
const REPO = path.join(__dirname, '..', '..');
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* 掃描對象：所有瀏覽器檢查，但排除這支自己（它裡面必然會出現「📸」與 SHOTS 這些字） */
const SELF = 'no-screenshot-check.js';
const checkFiles = fs.readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.js') && f !== SELF);

(async () => {
    console.log('\n🧪 不保留截圖的守門檢查');

    /* ---------- ① 行為：預設不寫檔 ---------- */
    const probe = path.join(os.tmpdir(), `cm-shot-policy-${Date.now()}.png`);
    let browser;
    try {
        browser = await Browser.launch({ width: 800, height: 600 });
        await browser.goto('about:blank');
        delete process.env.CM_KEEP_SCREENSHOTS;
        const kept = await browser.screenshot(probe);
        check(kept === null, '預設（沒有 CM_KEEP_SCREENSHOTS=1）時 screenshot() 回 null');
        check(!fs.existsSync(probe), '預設時真的沒有寫出任何圖檔');

        /* 逃生口還在：要親眼看畫面時仍然寫得出來（驗完立刻刪掉） */
        process.env.CM_KEEP_SCREENSHOTS = '1';
        const wrote = await browser.screenshot(probe);
        check(wrote === probe && fs.existsSync(probe) && fs.statSync(probe).size > 0,
            'CM_KEEP_SCREENSHOTS=1 時仍然寫得出來（「要看畫面」的逃生口沒有被鎖死）');
        if (fs.existsSync(probe)) fs.unlinkSync(probe);
        delete process.env.CM_KEEP_SCREENSHOTS;
        check(!fs.existsSync(probe), '驗完立刻刪除，沒有留下檔案');
    } catch (err) {
        check(false, '行為檢查執行失敗', err.message);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(probe)) fs.unlinkSync(probe);
    }

    /* ---------- ② 靜態：只有 cdp.js 可以寫圖檔 ---------- */
    const directWriters = [];
    for (const f of checkFiles) {
        const text = fs.readFileSync(path.join(BROWSER_DIR, f), 'utf-8');
        text.split('\n').forEach((line, i) => {
            if (/writeFile|createWriteStream/.test(line) && (IMAGE_RE.test(line) || /\bBuffer\b/.test(line))) {
                directWriters.push(`${f}:${i + 1}`);
            }
        });
    }
    check(directWriters.length === 0,
        '檢查腳本沒有自己寫圖檔（截圖只能走 cdp.js 的 screenshot()）', directWriters.join(', '));

    /* 目錄建立與「📸 截圖」輸出都必須在旗標保護之下 */
    const unguardedMkdir = [];
    const unguardedLog = [];
    for (const f of checkFiles) {
        const text = fs.readFileSync(path.join(BROWSER_DIR, f), 'utf-8');
        text.split('\n').forEach((line, i) => {
            if (/mkdirSync\([^)]*(SHOTS|SHOT_DIR)/.test(line) && !/CM_KEEP_SCREENSHOTS/.test(line)) {
                unguardedMkdir.push(`${f}:${i + 1}`);
            }
            if (line.includes('📸') && !/if \(shot\)|CM_KEEP_SCREENSHOTS/.test(line)) {
                unguardedLog.push(`${f}:${i + 1}`);
            }
        });
    }
    check(unguardedMkdir.length === 0,
        '截圖目錄只在保留模式才建立（不會留下空的截圖資料夾）', unguardedMkdir.join(', '));
    check(unguardedLog.length === 0,
        '★輸出不會在沒存檔時宣稱「📸 截圖：<路徑>」', unguardedLog.join(', '));

    /* ---------- ③ 收尾：repo 內沒有多出圖片檔 ---------- */
    try {
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf-8' });
        const images = status.split('\n').filter((l) => IMAGE_RE.test(l.trim().split(/\s+/).pop() || ''));
        check(images.length === 0, 'repo 內沒有多出任何圖片檔（git status 乾淨）', images.join(' | '));
    } catch (err) {
        check(false, '檢查 git 狀態時失敗', err.message);
    }

    const leftover = fs.readdirSync(os.tmpdir()).filter((f) => IMAGE_RE.test(f) && f.startsWith('cm-'));
    check(leftover.length === 0, '暫存目錄沒有殘留 cm-* 截圖檔', leftover.join(', '));

    console.log(`\n══════ 不保留截圖守門檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
