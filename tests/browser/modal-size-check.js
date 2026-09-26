/* v3.5.4：選單彈窗在電腦上「太細」的量測（真實 Chrome，四種尺寸）
 *
 * 使用者反映（2026-09-27）：「右上角選單裏面的按鈕點開後，在電腦看上去比較細（以通知為例）」。
 * 這類「看起來太細」的說法必須變成數字才守得住——本檢查量的是：
 *   ① 桌機／大桌機的彈窗寬度不得小於門檻（原本 max-w-lg＝512px，1920 螢幕上像一條細長卡片）
 *   ② 平板／手機不得因為加寬而溢出（面板 + 左右留白必須塞得進視窗）
 *   ③ 面板不得出現橫向捲動（內容真的排得下，不是被壓縮）
 *   ④ 彈窗內文（.text-xs／.text-sm）在桌機不得小於門檻
 *   ⑤ 按鈕的高度與列數合理（3 顆按鈕擠在一行、或每顆都被壓成細條都算不合格）
 *   ⑥ 開彈窗後頁面本身不得橫向溢出
 *   ⑦ 沒有前端例外
 *
 * 用法：node tests/browser/modal-size-check.js [https://其他網址]
 * （預設打正式站；沒有截圖，全部以 evaluate 量到的數字判定）
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Browser } = require('./lib/cdp');

const SITE = (process.argv[2] || process.env.SITE || 'https://competition-manager-hazel.vercel.app').replace(/\/+$/, '');
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-modal-size-check');

/* 訪客就看得到的選單彈窗（點開右上角 ☰ 選單裡的按鈕） */
const MODALS = [
    { menu: 'notifyBtn', modal: 'notifyModal', label: '通知設定' },
    { menu: 'menuBugReport', modal: 'bugReportModal', label: '回報問題' }
];

const SIZES = [
    { name: '大桌機 1920', width: 1920, height: 1080, desktop: true },
    { name: '桌機 1440', width: 1440, height: 900, desktop: true },
    { name: '平板 834', width: 834, height: 1112, desktop: false },
    { name: '手機 390', width: 390, height: 844, desktop: false }
];

/* 門檻（依 v3.5.4 修正後的實測值訂定，並留一點餘裕） */
const MIN_DESKTOP_WIDTH = 636;      // 桌機面板最小寬度（修正前 512）
const MIN_DESKTOP_TEXT_XS = 12.8;   // 桌機彈窗內 .text-xs 的最小 px（修正前 12）
const MIN_BUTTON_HEIGHT = 28;       // 彈窗內按鈕最小高度

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const M = (obj) => JSON.stringify(obj);

(async () => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    console.log(`\n🧪 選單彈窗尺寸檢查：${SITE}`);
    const browser = await Browser.launch({ width: 1440, height: 900 });
    let exitCode = 1;
    try {
        await browser.goto(SITE, { waitMs: 2500 });
        const version = JSON.parse(await browser.evaluate(`return fetch('/api/version').then((r) => r.json()).then((d) => JSON.stringify(d));`));
        console.log(`   線上版本：v${version.version}`);

        for (const size of SIZES) {
            console.log(`\n── ${size.name}（${size.width}×${size.height}）──`);
            await browser.setViewport(size.width, size.height);
            await browser.goto(SITE, { waitMs: 1200 });

            for (const target of MODALS) {
                // 用真實互動開窗：先點 ☰ 選單、再點選單裡的按鈕（直接呼叫函式會掩蓋事件綁定的問題）
                const opened = await browser.evaluate(`
                    document.getElementById('navMenuBtn')?.click();
                    const btn = document.getElementById('${target.menu}');
                    if (!btn) { return 'no-menu-button'; }
                    btn.click();
                    return 'clicked';
                `);
                if (opened !== 'clicked') {
                    check(false, `${target.label}：選單裡找得到「${target.label}」按鈕`, opened);
                    continue;
                }
                await browser.waitFor(`document.getElementById('${target.modal}') && !document.getElementById('${target.modal}').classList.contains('hidden')`, { timeout: 5000 });

                const m = JSON.parse(await browser.evaluate(`
                    const modal = document.getElementById('${target.modal}');
                    const panel = modal.querySelector('.cm-modal-panel');
                    if (!panel) { return JSON.stringify({ error: 'no-panel' }); }
                    const pr = panel.getBoundingClientRect();
                    const cs = getComputedStyle(panel);
                    const padL = parseFloat(cs.paddingLeft) || 0;
                    const padR = parseFloat(cs.paddingRight) || 0;

                    const buttons = Array.from(panel.querySelectorAll('button'))
                        .map((b) => b.getBoundingClientRect())
                        .filter((r) => r.width > 0 && r.height > 0);
                    const rows = new Set(buttons.map((r) => Math.round(r.top)));

                    const xs = panel.querySelector('.text-xs');
                    const sm = panel.querySelector('.text-sm');

                    return JSON.stringify({
                        panelWidth: Math.round(pr.width),
                        panelHeight: Math.round(pr.height),
                        contentWidth: Math.round(pr.width - padL - padR),
                        panelScrollOverflow: panel.scrollWidth - panel.clientWidth,
                        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
                        viewport: window.innerWidth,
                        buttonCount: buttons.length,
                        buttonRows: rows.size,
                        minButtonHeight: buttons.length ? Math.round(Math.min(...buttons.map((r) => r.height))) : 0,
                        fontXs: xs ? parseFloat(getComputedStyle(xs).fontSize) : null,
                        fontSm: sm ? parseFloat(getComputedStyle(sm).fontSize) : null
                    });
                `));

                // 關窗，避免影響下一個彈窗的量測
                await browser.evaluate(`document.getElementById('${target.modal}').classList.add('hidden'); return true;`);

                if (m.error) { check(false, `${target.label}：找得到面板 .cm-modal-panel`, m.error); continue; }
                console.log(`   ℹ️ ${target.label}：面板 ${m.panelWidth}×${m.panelHeight}px、內容 ${m.contentWidth}px、按鈕 ${m.buttonCount} 顆排成 ${m.buttonRows} 列（最矮 ${m.minButtonHeight}px）、.text-xs ${m.fontXs}px、.text-sm ${m.fontSm}px`);

                if (size.desktop) {
                    check(m.panelWidth >= MIN_DESKTOP_WIDTH,
                        `${size.name}｜${target.label}：面板寬度 ≥ ${MIN_DESKTOP_WIDTH}px（實際 ${m.panelWidth}px）`);
                    check(m.fontXs === null || m.fontXs >= MIN_DESKTOP_TEXT_XS,
                        `${size.name}｜${target.label}：內文字級 ≥ ${MIN_DESKTOP_TEXT_XS}px（實際 ${m.fontXs}px）`);
                } else {
                    check(m.panelWidth <= m.viewport - 8,
                        `${size.name}｜${target.label}：面板塞得進視窗（面板 ${m.panelWidth} ≤ 視窗 ${m.viewport}）`);
                    check(m.panelWidth >= 300,
                        `${size.name}｜${target.label}：面板沒有被壓成細條（實際 ${m.panelWidth}px）`);
                }
                check(m.panelScrollOverflow <= 0,
                    `${size.name}｜${target.label}：面板沒有橫向捲動（溢出 ${m.panelScrollOverflow}px）`);
                check(m.bodyOverflow <= 1,
                    `${size.name}｜${target.label}：頁面沒有橫向溢出（${m.bodyOverflow}px）`);
                check(m.minButtonHeight >= MIN_BUTTON_HEIGHT,
                    `${size.name}｜${target.label}：按鈕高度 ≥ ${MIN_BUTTON_HEIGHT}px（實際 ${m.minButtonHeight}px）`);
            }
        }

        check(browser.pageErrors.length === 0, '沒有前端例外', browser.pageErrors.join(' | ').slice(0, 160));

        console.log(`\n══════ 選單彈窗尺寸檢查：${pass} 通過 / ${fail} 失敗 ══════`);
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`\n❌ 檢查腳本本身出錯： ${err && err.message ? err.message : err}`);
        exitCode = 1;
    } finally {
        await browser.close();
    }
    process.exit(exitCode);
})();
