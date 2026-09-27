/* v3.7.0：前端權限表必須跟後端一致——發佈賽事的表單不可以給沒有權限的人看到。
 *
 * 症狀（v3.7.0 修掉）：測試帳號（role: test）看得到整份「➕ 發佈新比賽」表單，
 * 一路填到送出才被後端 403 擋下來——介面在騙人，也浪費使用者的時間。
 * 根因：前端的角色權限表把 test 的 create 寫成 true，而後端 POST /api/competitions 只收管理員。
 *
 * 這支測試直接把前端那張表真的解析出來比對（不是比對原始碼字串），並確認：
 *   ① create 只給 admin／super_admin／web_owner。
 *   ② 那面表單（#createSection）開站時是關著的，而且真的由 perm.create 控制。
 *   ③ 後端的發佈端點確實有角色守門（否則前端藏了也沒用）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const competitionsRoute = fs.readFileSync(path.join(ROOT, 'routes', 'competitions.js'), 'utf8');

// 把 `const CM_MENU_PERMISSIONS = { ... };` 整段抓出來，交給 vm 解析成真正的物件
function readMenuPermissions() {
    const start = appJs.indexOf('const CM_MENU_PERMISSIONS = {');
    assert.notStrictEqual(start, -1, '找不到 CM_MENU_PERMISSIONS');
    let depth = 0;
    let end = -1;
    for (let i = appJs.indexOf('{', start); i < appJs.length; i += 1) {
        if (appJs[i] === '{') depth += 1;
        else if (appJs[i] === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    assert.notStrictEqual(end, -1, 'CM_MENU_PERMISSIONS 的物件沒有收尾');
    const literal = appJs.slice(appJs.indexOf('{', start), end + 1);
    return vm.runInNewContext(`(${literal})`);
}

test('v3.7.0：只有管理員角色能看到「發佈新比賽」', () => {
    const perms = readMenuPermissions();
    const canCreate = Object.keys(perms).filter((role) => perms[role].create === true).sort();
    assert.deepStrictEqual(canCreate, ['admin', 'super_admin', 'web_owner'],
        'create 只給這三個角色（後端也只收管理員）');

    ['guest', 'user', 'test'].forEach((role) => {
        assert.ok(perms[role], `權限表要有 ${role} 這一列`);
        assert.strictEqual(perms[role].create, false,
            `${role} 不可以看到發佈表單（送出必被 403，介面不該騙人）`);
    });
});

test('v3.7.0：發佈表單預設關著，且由 perm.create 控制', () => {
    assert.match(indexHtml, /id="createSection"[^>]*class="[^"]*hidden/,
        '#createSection 開站時必須是 hidden（否則會先閃出來再被藏）');
    assert.match(appJs, /createSection/,
        '要有程式去控制 #createSection 的可見性');
    assert.match(appJs, /createSection[\s\S]{0,200}perm\.create|perm\.create[\s\S]{0,200}createSection/,
        '#createSection 的可見性必須綁在 perm.create 上');
});

test('v3.7.0：後端的發佈端點有角色守門', () => {
    const post = /app\.post\(\s*'\/api\/competitions'/.exec(competitionsRoute);
    assert.ok(post, '找不到 POST /api/competitions');
    const handler = competitionsRoute.slice(post.index, post.index + 400);
    assert.match(handler, /requireRole|requireAdmin|ADMIN_ROLES|role/,
        '發佈賽事的端點必須檢查角色（前端藏起來只是第一層）');
});
