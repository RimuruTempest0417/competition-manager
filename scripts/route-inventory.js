/* 產生／更新「路線清單」快照（拆模組前的等價基準）
 *
 * 為什麼需要：server.js 拆模組時，最容易無聲弄壞的就是「路由少了、順序變了」。
 * Express 是**依註冊順序**比對的，順序一變就可能被前面的 catch-all 攔走，
 * 而且不會有任何錯誤訊息。
 *
 * 用法：
 *   node scripts/route-inventory.js            # 印出來（不寫檔）
 *   node scripts/route-inventory.js --write    # 更新 tests/fixtures/route-inventory.json
 *
 * ⚠️ 只有在「真的新增／移除路由」時才用 --write 更新快照，
 *    重構（搬檔案、拆模組）時快照必須保持不變——它不變才代表行為等價。
 */
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-inventory-secret';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'route-inventory-key';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1/route-inventory';

const app = require(path.join(__dirname, '..', 'server.js'));

/* 把 Express 的註冊堆疊攤平成有序字串清單。
 * 只支援「掛在根路徑（'/'）」的 router —— 本專案的模組都這樣掛，
 * 有前綴的話會直接拋錯，避免清單默默算錯。 */
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
            if (!rootOnly) throw new Error(`route-inventory 只支援掛在根路徑的 router，實際：${re}`);
            flatten(handle.stack, out);
            continue;
        }
        if (handle.length === 4) {
            out.push(`ERROR ${handle.name || 'anonymous'}`);
            continue;
        }
        out.push(`USE ${handle.name || 'anonymous'}`);
    }
    return out;
}

const router = app.router || app._router;
if (!router || !router.stack) throw new Error('拿不到 Express 路由堆疊（app.router / app._router 都沒有）');

const inventory = flatten(router.stack);
const payload = {
    note: '拆模組的等價基準：路由必須完全相同且順序不變。重構時不要更新這個檔案；只有真的增減路由才更新。',
    count: inventory.length,
    routes: inventory
};

if (process.argv.includes('--write')) {
    const file = path.join(__dirname, '..', 'tests', 'fixtures', 'route-inventory.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`✅ 已寫入 ${path.relative(path.join(__dirname, '..'), file)}（${inventory.length} 條）`);
} else {
    console.log(`路線清單共 ${inventory.length} 條：`);
    inventory.forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${r}`));
}
