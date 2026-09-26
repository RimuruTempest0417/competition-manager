#!/usr/bin/env node
/* 路由快照 × 測試覆蓋率掃描（v3.6.0）
 *
 * 為什麼要有這支：v3.5.4 補的「8 條沒有測試的端點」是**手動掃出來**的——
 * 靠人記得去比對「路由快照」與「測試原始碼」，下一版就會忘。
 * 這支腳本把那件事變成常駐檢查：每條路由都要在 `tests/**` 裡被提到過，
 * 否則非零退出（發版前跑 `npm run check:coverage`，也由 `npm test` 的守門測試呼叫）。
 *
 * 判定方式（刻意的取捨）：
 *   - 只看**路徑**有沒有出現在測試原始碼裡，不看方法。理由是測試裡的請求多半長這樣：
 *       fetch(base + '/api/competitions/802/restore', { method: 'PUT' })
 *     方法是物件屬性、路徑是字串，抓路徑最穩；方法寫成變數或常數時抓方法反而會誤判成「沒測」。
 *     所以要抓的是「完全沒有人提到過」的端點（那才是真正的覆蓋率漏洞）。
 *   - 路徑參數（:id）在測試裡可能是 `${id}` 或實際數字（802），兩種都算命中。
 *   - 單元／整合測試與瀏覽器檢查分開統計，讓你知道「是 API 層測到還是只有畫面測到」。
 *
 * 用法：
 *   node scripts/test-coverage.js            掃描並印出表格（未覆蓋的路由會標紅）
 *   node scripts/test-coverage.js --all      連已覆蓋的也列出來
 *   node scripts/test-coverage.js --json     給程式讀的輸出（自動化用）
 *   node scripts/test-coverage.js --allow    把目前未覆蓋的路由寫進允許清單檔
 *   npm run check:coverage                   等同上面第一種（發版檢查用；有未覆蓋就非零退出）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INVENTORY = path.join(ROOT, 'tests', 'fixtures', 'route-inventory.json');
const ALLOWLIST = path.join(ROOT, 'tests', 'fixtures', 'untested-routes.json');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const asJson = args.includes('--json');
const writeAllow = args.includes('--allow');

/* ---------- 讀路由快照 ---------- */
if (!fs.existsSync(INVENTORY)) {
    console.error(`❌ 找不到路由快照：${INVENTORY}\n   先跑 node scripts/route-inventory.js --write`);
    process.exit(2);
}
const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
const routes = (inventory.routes || []).filter((r) => /^[A-Z]+ \//.test(r));

/* ---------- 收集測試原始碼 ---------- */
function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
            walk(full, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

const unitFiles = walk(path.join(ROOT, 'tests')).filter((f) => !f.includes(`${path.sep}browser${path.sep}`));
const browserFiles = walk(path.join(ROOT, 'tests', 'browser'));

const readAll = (files) => files.map((f) => ({
    file: path.relative(ROOT, f),
    text: fs.readFileSync(f, 'utf8')
}));

const unitSources = readAll(unitFiles);
const browserSources = readAll(browserFiles);

/* ---------- 產生路徑樣式 ---------- */
/* 參數段在測試裡可能是 ${...} 也可能是實際數字；用一個樣式涵蓋兩種。
   尾端要排除「後面還接著路徑或英文數字」的情況，否則 /api/competitions
   會被 /api/competitions/802/restore 誤判成命中了。 */
function pathPattern(route) {
    const p = route.split(' ').slice(1).join(' ');
    const body = String(p).split('?')[0].split('/').filter(Boolean).map((seg) => {
        if (seg.startsWith(':')) return '(?:\\$\\{[^}]*\\}|[^/\'"`\\s]+)';
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return new RegExp(`/${body}(?![A-Za-z0-9_/-])`);
}

/* ---------- 逐條比對 ---------- */
const results = routes.map((route) => {
    const re = pathPattern(route);
    const hitsUnit = unitSources.filter((s) => re.test(s.text)).map((s) => s.file);
    const hitsBrowser = browserSources.filter((s) => re.test(s.text)).map((s) => s.file);
    return { route, unit: hitsUnit, browser: hitsBrowser, covered: hitsUnit.length + hitsBrowser.length > 0 };
});

let allowlist = [];
if (fs.existsSync(ALLOWLIST)) {
    allowlist = (JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')).routes) || [];
}

const untested = results.filter((r) => !r.covered && !allowlist.includes(r.route));
const covered = results.filter((r) => r.covered);

if (writeAllow) {
    fs.writeFileSync(ALLOWLIST, JSON.stringify({
        note: '已知且刻意未測的路由（每新增一條都要有理由）。由 scripts/test-coverage.js --allow 產生。',
        routes: results.filter((r) => !r.covered).map((r) => r.route)
    }, null, 2) + '\n');
    console.log(`✅ 已寫入 ${path.relative(ROOT, ALLOWLIST)}（${results.filter((r) => !r.covered).length} 條）`);
    process.exit(0);
}

if (asJson) {
    console.log(JSON.stringify({
        total: results.length,
        covered: covered.length,
        untested: untested.map((r) => r.route),
        allowlisted: allowlist,
        details: results
    }, null, 2));
    process.exit(untested.length === 0 ? 0 : 1);
}

console.log(`\n🔎 路由覆蓋率掃描：${INVENTORY.replace(ROOT + '/', '')}`);
console.log(`   路由 ${results.length} 條｜已被測試提到 ${covered.length} 條｜完全沒被提到 ${results.length - covered.length} 條` +
    (allowlist.length ? `（其中 ${allowlist.length} 條在允許清單）` : ''));

if (showAll) {
    console.log('\n方法  路徑                                        單元  瀏覽器');
    for (const r of results) {
        const [method, ...rest] = r.route.split(' ');
        console.log(`${method.padEnd(6)}${rest.join(' ').padEnd(44)}${String(r.unit.length).padStart(4)}${String(r.browser.length).padStart(7)}`);
    }
}

if (untested.length === 0) {
    console.log('\n✅ 每一條路由都至少被一個測試或瀏覽器檢查提到。\n');
    process.exit(0);
}

console.log('\n❌ 以下路由完全沒有被任何測試或瀏覽器檢查提到：');
for (const r of untested) {
    console.log(`   • ${r.route}`);
}
console.log('\n   補測試，或（真的有理由不測時）跑 `node scripts/test-coverage.js --allow` 寫進允許清單。\n');
process.exit(1);
