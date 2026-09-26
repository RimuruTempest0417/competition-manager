/* 拆模組的等價守門測試（v3.4.0，P4）
 *
 * 把「路由清單與順序」凍結成快照比對：
 *   - Express 依註冊順序比對路徑，順序一變就可能被前面的 catch-all 攔走，而且**不會報錯**
 *   - 拆模組時最怕的就是「搬一搬少了一條」「順序跑了」「中間件不見了」
 * 快照不變 = 對外行為等價；真的增減路由時才用
 *   node scripts/route-inventory.js --write 更新（並在 commit 訊息說明原因）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-inventory-secret';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'route-inventory-key';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1/route-inventory';

const ROOT = path.join(__dirname, '..');
const app = require(path.join(ROOT, 'server.js'));
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'route-inventory.json'), 'utf8'));

function flatten(stack, out = []) {
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods || {})
                .filter((m) => layer.route.methods[m])
                .map((m) => m.toUpperCase())
                .sort();
            for (const m of methods) out.push(`${m} ${layer.route.path}`);
            continue;
        }
        const handle = layer.handle || {};
        if (handle.stack && typeof handle.stack !== 'undefined') {
            const re = String(layer.regexp || '');
            const rootOnly = /^\/\^\\\/\?\(\?=\\\/\|\$\)/.test(re) || /^\/\^\\\/\?/.test(re);
            assert.ok(rootOnly, `模組 router 只能掛在根路徑，實際：${re}`);
            flatten(handle.stack, out);
            continue;
        }
        out.push(handle.length === 4 ? `ERROR ${handle.name || 'anonymous'}` : `USE ${handle.name || 'anonymous'}`);
    }
    return out;
}

const router = app.router || app._router;
const actual = flatten(router.stack);

test('路由清單與順序必須與快照完全一致（拆模組不可改變對外行為）', () => {
    const missing = snapshot.routes.filter((r) => !actual.includes(r));
    const added = actual.filter((r) => !snapshot.routes.includes(r));
    assert.deepStrictEqual(missing, [], `這些路由不見了：${missing.join(', ')}`);
    assert.deepStrictEqual(added, [], `這些路由是新的（若是有意新增，請跑 node scripts/route-inventory.js --write）：${added.join(', ')}`);

    // 順序也要一樣：先比長度，再逐項比對（只比前 N 項會漏掉尾端互換）
    assert.strictEqual(actual.length, snapshot.routes.length, '路由數量不同');
    const firstDiff = actual.findIndex((r, i) => r !== snapshot.routes[i]);
    assert.strictEqual(firstDiff, -1,
        `路由順序在第 ${firstDiff + 1} 項不同：快照「${snapshot.routes[firstDiff]}」實際「${actual[firstDiff]}」`);
});

test('中間件層沒有在拆模組時消失（順序也要對）', () => {
    const middleware = (list) => list.filter((r) => r.startsWith('USE ') || r.startsWith('ERROR '));
    assert.deepStrictEqual(middleware(actual), middleware(snapshot.routes),
        '中間件（含錯誤處理）的清單或順序變了');
    assert.ok(middleware(actual).length >= 5, `中間件數量不合理（${middleware(actual).length}）`);
});

test('路由數量與形狀合理（避免解析器壞掉卻假通過）', () => {
    const routes = actual.filter((r) => /^(GET|POST|PUT|PATCH|DELETE) /.test(r));
    assert.ok(routes.length >= 90, `路由數量不合理（${routes.length}）`);
    const dupes = routes.filter((r, i) => routes.indexOf(r) !== i);
    assert.deepStrictEqual([...new Set(dupes)], [], `同一條路徑重複註冊（前面的會先攔走）：${[...new Set(dupes)].join(', ')}`);
    assert.ok(actual.includes('POST /api/auth/login'), '登入端點必須存在');
    assert.ok(actual.includes('GET /api/competitions'), '賽事列表端點必須存在');
});

test('app.__test__ 的匯出沒有在拆模組時漏掉', () => {
    const keys = Object.keys(app.__test__ || {}).sort();
    assert.ok(keys.length >= 40, `app.__test__ 匯出數量不合理（${keys.length}）`);
    for (const must of ['roleLevel', 'canManageUser', 'cronAuthorization', 'resolveSupabaseKey', 'twoFactorSchemaReady']) {
        assert.ok(keys.includes(must), `app.__test__ 少了 ${must}`);
    }
});
