/* v2.25.0：版本字串一致性（防止「頁面上某處忘了改版本」再發生）
 *
 * 背景：頁面副標曾經寫死「發佈與管理各類賽事資訊 (v2.18.0)」，
 * 之後好幾版都只改了 `<title>` 與 package.json，畫面上的版本就停在 v2.18.0。
 * 這個測試把「版本只能有一個來源」變成可驗證的規則：
 *   ① package.json 的 version 必須等於 <title> 裡的版本
 *   ② 頁面上不可以再出現寫死的 (vX.Y.Z) 副標
 *   ③ 副標必須有 id，且由 /api/version 帶入
 *   ④ /api/version 回的版本必須等於 package.json
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'version-test-secret';
process.env.SUPABASE_KEY = 'stub-key';

const REPO = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');

test('package.json 的版本等於頁面 <title> 裡的版本', () => {
    const match = html.match(/<title>[^<]*?v(\d+\.\d+\.\d+)<\/title>/);
    assert.ok(match, '<title> 應該要帶版本號（例：比賽管理系統 v2.25.0）');
    assert.strictEqual(match[1], pkg.version, `package.json 是 ${pkg.version}，<title> 卻是 ${match[1]}`);
});

test('頁面上不可以再出現寫死的版本副標（(vX.Y.Z) 這種）', () => {
    const hardcoded = html.match(/\(v\d+\.\d+\.\d+\)/g) || [];
    assert.deepStrictEqual(hardcoded, [], `index.html 還有寫死的版本字串：${hardcoded.join('、')}（請改成由 /api/version 帶入）`);
});

test('副標有 id 且由前端向 /api/version 取版本', () => {
    assert.match(html, /id="appSubtitle"/, '頁面副標要有 id="appSubtitle" 才能被程式更新');
    assert.match(appJs, /\/api\/version/, 'app.js 應該要向 /api/version 取版本');
    assert.match(appJs, /getElementById\('appSubtitle'\)/, 'app.js 應該要更新副標');
});

test('/api/version 回的版本等於 package.json', async () => {
    const app = require(path.join(REPO, 'server.js'));
    assert.ok(app.__test__, 'server 需要暴露 __test__ 才能取版本');
    const res = await new Promise((resolve) => {
        const req = {};
        const out = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body }); return this; }
        };
        app.__test__.versionHandler(req, out);
    });
    assert.strictEqual(res.body.version, pkg.version);
});
