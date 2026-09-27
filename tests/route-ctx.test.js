/* 守門：routes/*.js 從 ctx 解構出來的每一個名字，server.js 都必須真的提供
 *
 * 為什麼需要這條：模組化的路由檔是「解構 ctx → 用裡面的函式」，如果某個名字
 * 只在 routes/ 裡解構、server.js 卻忘了傳，語法檢查不會有錯、單元測試也可能照過，
 * 只有真的打到那條端點才會炸成 500（v3.9.0 連續踩了兩次：hasSeriesPointsContent、
 * formFieldsSchemaReady）。這條測試把那種錯在提交前就擋掉。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* 從 `require('./routes/xxx')(app, { a, b, c })` 取出提供給該模組的 key */
function providedKeys(moduleName) {
    const call = serverSrc.split(`require('./${moduleName}')`)[1];
    if (!call) return null;
    const open = call.indexOf('{');
    const close = call.indexOf('}', open);
    if (open < 0 || close < 0) return new Set();
    return new Set(call.slice(open + 1, close)
        .split(',')
        .map((s) => s.trim().split(':')[0].trim())
        .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)));
}

/* 從路由檔取出 `const { a, b } = ctx;` 解構的名字 */
function destructuredKeys(fileSrc) {
    const names = [];
    const re = /const\s*\{([^}]+)\}\s*=\s*ctx\s*;/g;
    let match;
    while ((match = re.exec(fileSrc))) {
        match[1].split(',').forEach((raw) => {
            const name = raw.trim().split(':').pop().trim().split('=')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
        });
    }
    return names;
}

/* 路由檔自己在檔案裡定義的名字（函式或常數）不算 ctx 依賴 */
function locallyDefinedNames(fileSrc) {
    const names = new Set();
    const patterns = [
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /const\s+([A-Za-z_$][\w$]*)\s*=/g,
        /let\s+([A-Za-z_$][\w$]*)\s*=/g
    ];
    patterns.forEach((re) => {
        let match;
        while ((match = re.exec(fileSrc))) names.add(match[1]);
    });
    return names;
}

const routeFiles = fs.readdirSync(path.join(ROOT, 'routes')).filter((f) => f.endsWith('.js'));

/* 有些名字是 Node 內建或模組層級 require 進來的（例如 jwt、supabase），一律放行 */
const KNOWN_GLOBALS = new Set(['jwt', 'supabase', 'path', 'fs', 'crypto', 'process', 'console', 'require', 'module', 'exports']);

test('每個路由模組解構的 ctx 欄位，server.js 都必須提供', () => {
    const problems = [];
    routeFiles.forEach((file) => {
        const moduleName = `routes/${file.replace(/\.js$/, '')}`;   // server.js 是用 require('./routes/xxx')（沒有 .js）
        const provided = providedKeys(moduleName);
        if (!provided) return;                                  // 不是用 (app, ctx) 形式註冊的（例如獨立掛載）就跳過
        const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
        const local = locallyDefinedNames(src);
        destructuredKeys(src).forEach((name) => {
            if (provided.has(name) || local.has(name) || KNOWN_GLOBALS.has(name)) return;
            problems.push(`${moduleName} 解構了 ${name}，但 server.js 傳入的 ctx 沒有它`);
        });
    });
    assert.deepStrictEqual(problems, [], '路由需要的東西一定要傳進去，否則只有真的打到那條端點才會 500');
});

test('反向檢查：server.js 傳進去的名字，路由檔真的有解構（打錯字會是 undefined 不會報錯）', () => {
    const problems = [];
    routeFiles.forEach((file) => {
        const moduleName = `routes/${file.replace(/\.js$/, '')}`;   // server.js 是用 require('./routes/xxx')（沒有 .js）
        const provided = providedKeys(moduleName);
        if (!provided) return;
        const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
        const used = new Set(destructuredKeys(src));
        provided.forEach((name) => {
            // 允許傳了但該模組還沒用到（例如共用 HINT 字串），只要不是明顯打錯字就好：
            // 判斷方式＝server.js 裡真的定義了這個名字
            const defined = new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(serverSrc)
                || new RegExp(`${name}\\s*[,}]`).test(serverSrc.split('const {')[1] || '')
                || serverSrc.indexOf(`const ${name}`) >= 0;
            if (!defined && !used.has(name)) {
                problems.push(`server.js 傳了 ${name} 給 ${moduleName}，但 server.js 裡找不到它的定義`);
            }
        });
    });
    assert.deepStrictEqual(problems, []);
});
