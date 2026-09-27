/* 守門測試：前端不得使用行內事件處理（onclick／onchange／…）與行內 style 屬性
 *
 * 為什麼要有這條：CSP 是 `script-src 'self'`（沒有 'unsafe-inline'），瀏覽器會用
 * `script-src-attr` 把**行內事件屬性**直接擋掉 —— 按鈕看起來正常、按下去完全沒反應，
 * 而且**單元測試與既有瀏覽器檢查都不會發現**（v3.9.0 的回顧報告／系列總積分就是這樣壞的：
 * 關閉鈕、複製摘要、看系列積分共 6 個按鈕全部沒反應）。
 *
 * 規則：一律用 addEventListener／事件委派；動態產生的按鈕用 data 屬性 ＋ 委派監聽。
 * 用法：npm test（或 node --test tests/no-inline-handlers.test.js）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

/* 事件屬性：on + 小寫字母，後面接 = 與引號（含 onclick="…"、onerror='…'） */
const INLINE_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keydown|keyup|keypress|mouseover|mouseout|mousedown|mouseup|touchstart|touchend|dblclick|contextmenu|scroll|reset|select)\s*=\s*["']/gi;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(html|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

test('前端檔案沒有行內事件處理（CSP script-src 會擋掉，按了沒反應）', () => {
    const files = walk(PUBLIC);
    assert.ok(files.length > 5, `應該要掃到前端檔案（實際 ${files.length} 個）`);
    const hits = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
            INLINE_RE.lastIndex = 0;
            if (INLINE_RE.test(line)) {
                hits.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1} ${line.trim().slice(0, 100)}`);
            }
        });
    }
    assert.deepStrictEqual(hits, [],
        '以下地方用了行內事件處理，CSP 會直接擋掉、按鈕會變啞的（改成 addEventListener 或事件委派）：\n' + hits.join('\n'));
});

test('前端沒有行內 style 屬性（CSP style-src 會擋掉，樣式會安靜失效）', () => {
    const hits = [];
    for (const file of walk(PUBLIC)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (/\sstyle\s*=\s*["']/.test(line)) {
                hits.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1} ${line.trim().slice(0, 100)}`);
            }
        });
    }
    assert.deepStrictEqual(hits, [],
        '以下地方用了行內 style，CSP 會擋掉、樣式不會生效（改成 .css 裡的類別）：\n' + hits.join('\n'));
});

test('回顧報告／系列總積分的按鈕都用 id ＋ 綁定（不是行內 onclick）', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(PUBLIC, 'js', 'review.js'), 'utf8');
    for (const id of ['reviewCloseBtn', 'reviewCloseBtn2', 'seriesCloseBtn', 'seriesCloseBtn2', 'reviewCopyBtn']) {
        assert.ok(html.indexOf(`id="${id}"`) >= 0, `index.html 應該要有 #${id}（彈窗按鈕）`);
        assert.ok(js.indexOf(`'${id}'`) >= 0, `review.js 應該要綁定 #${id}（否則按鈕沒有作用）`);
    }
    assert.ok(js.indexOf('data-series-root') >= 0, '動態產生的「看這個系列的總積分」要用 data-series-root ＋ 委派');
});
