/**
 * v3.7.2：日期欄「年/月/日」提示只可以在 iOS 注入。
 *
 * 背景：v3.6.8 為了 iOS 空日期欄完全不顯示文字而加了提示，卻在桌機 Chrome 上
 * 與原生控制項自己的「年/月/日」疊成兩層（使用者回報桌機文字重疊）。
 * 這裡直接從 app.js 抽出純函式跑矩陣，另加結構斷言確認提示真的被閘門包住。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const src = APP.match(/function isIOSUserAgent\(ua, maxTouchPoints\)[\s\S]*?\n\}/);
assert.ok(src, 'app.js 必須有 isIOSUserAgent（純函式，方便測試）');
const isIOS = vm.runInNewContext(`${src[0]}\nisIOSUserAgent`, {});

const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
    ipadosAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
};

test('iPhone／iPad 的 UA 判定為 iOS', () => {
    assert.equal(isIOS(UA.iphone, 5), true);
    assert.equal(isIOS(UA.ipad, 5), true);
});

test('iPadOS 假裝成 Mac（MacIntel＋多點觸控）也判定為 iOS', () => {
    assert.equal(isIOS(UA.ipadosAsMac, 5), true);
});

test('桌機（Mac／Windows）與 Android 一律不是 iOS', () => {
    assert.equal(isIOS(UA.macChrome, 0), false, '桌機 Mac 沒有觸控點');
    assert.equal(isIOS(UA.windows, 0), false);
    assert.equal(isIOS(UA.android, 5), false, 'Android 不是 iOS');
});

test('空的／奇怪的 UA 不判定為 iOS（寧可不加提示，也不要重疊）', () => {
    assert.equal(isIOS('', 0), false);
    assert.equal(isIOS(undefined, undefined), false);
    assert.equal(isIOS('curl/8.4.0', 0), false);
});

test('結構斷言：提示的建立被 wantsHint 閘門包住（桌機不會產生那個元素）', () => {
    assert.match(APP, /const wantsHint = isIOSUserAgent\(navigator\.userAgent/, '必須先算 wantsHint');
    const hintAt = APP.indexOf("hint.textContent = '年/月/日'");
    const gateAt = APP.indexOf('if (wantsHint) {');
    assert.ok(gateAt > 0 && hintAt > gateAt, '建立提示的程式碼必須在 if (wantsHint) 之內');
});
