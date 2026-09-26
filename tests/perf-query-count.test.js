/* v3.0.0：查詢次數守門測試（先量、再優化、再守門）
 *
 * 為什麼要有這個：列表端點的查詢次數是「效能」最具體、可驗證的指標。
 * 每次請求打了幾次資料庫，用假 Supabase 的請求記錄數得出來（state.log ✓）。
 * 這個數字一旦變多（例如新功能不小心在迴圈裡查資料），測試就會失敗。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v300-perf-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const comps = [];
for (let i = 1; i <= 12; i += 1) {
    comps.push({
        id: 800 + i, name: `賽事 ${i}`, location: '澳門運動場', date: '2026-12-01', time: '09:00',
        end_date: null, end_time: null, description: '', is_registration_open: true, category: 'track',
        tags: [], is_team_event: false, max_registrations: 20, requires_approval: false, waitlist_enabled: false,
        registration_deadline: null, is_deleted: false, created_at: '2026-01-01T00:00:00.000Z', created_by: 'owner'
    });
}
const regs = [];
for (let i = 1; i <= 30; i += 1) {
    regs.push({ id: 5000 + i, competition_id: 801, user_id: 90 + (i % 5), username: `u${i % 5}`, is_deleted: false, status: 'confirmed', created_at: '2026-09-01T00:00:00.000Z' });
}

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 90, username: 'u0', password: 'x', role: 'user', is_active: true },
            { id: 91, username: 'u1', password: 'x', role: 'user', is_active: true }
        ],
        competitions: comps,
        registrations: regs,
        competition_posters: [],
        competition_staff: [],
        push_log: [],
        error_logs: [],
        audit_logs: [],
        app_settings: [],
        teams: []
    },
    nextId: { audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) server.close();
    if (stub) stub.close();
});

const dbCalls = () => state.log.filter((e) => String(e.url || '').startsWith('/rest/v1/')).length;
const urlsOf = (from) => state.log.slice(from).map((e) => String(e.url || '').replace(/^\/rest\/v1\//, '').replace(/\?.*$/, ''));

test('賽事列表：12 場賽事的請求次數要有上限（不是每場都查一次）', async () => {
    // 暖機（schema 探測只做一次，之後有快取）
    await fetch(`${base}/api/competitions`);

    const from = state.log.length;
    const res = await fetch(`${base}/api/competitions`);
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    assert.strictEqual(list.length, 12);

    const calls = state.log.length - from;
    const tables = urlsOf(from);
    console.log(`     賽事列表查詢次數：${calls}（${tables.join('、')}）`);

    // 目前每次請求會碰：competitions、admin_users（發佈者）、registrations（人數）、
    // competition_staff（工作人員人數）——固定 4 次，與賽事數量無關。
    assert.ok(calls <= 6, `賽事列表查詢次數應與賽事數量無關且 <= 6，實際 ${calls} 次：${tables.join('、')}`);
    assert.strictEqual(tables.length, new Set(tables).size, `不該對同一張表重複查詢：${tables.join('、')}`);
});

test('賽事列表：資料庫查詢次數不隨賽事數量成長（100 場也一樣）', async () => {
    for (let i = 13; i <= 100; i += 1) {
        comps.push(Object.assign({}, comps[0], { id: 800 + i, name: `賽事 ${i}` }));
    }
    const from = state.log.length;
    const res = await fetch(`${base}/api/competitions`);
    const list = await res.json();
    assert.strictEqual(list.length, 100);
    const calls = state.log.length - from;
    console.log(`     100 場賽事時查詢次數：${calls}`);
    assert.ok(calls <= 6, `查詢次數不該隨資料量成長，實際 ${calls} 次`);
});

test('分頁：帶 limit/offset 時只回那一頁，並附 total 與 has_more', async () => {
    const first = await fetch(`${base}/api/competitions?limit=10`);
    assert.strictEqual(first.status, 200);
    const page1 = await first.json();
    assert.ok(!Array.isArray(page1), '帶 limit 時要回物件（items/total/has_more），不是陣列');
    assert.strictEqual(page1.items.length, 10);
    assert.strictEqual(page1.total, 100);
    assert.strictEqual(page1.has_more, true);
    assert.strictEqual(page1.offset, 0);

    const second = await (await fetch(`${base}/api/competitions?limit=10&offset=95`)).json();
    assert.strictEqual(second.items.length, 5);
    assert.strictEqual(second.has_more, false);
    assert.strictEqual(second.offset, 95);

    // 不帶 limit 仍然是原本的陣列（既有前端與外部整合不受影響）
    const plain = await (await fetch(`${base}/api/competitions`)).json();
    assert.ok(Array.isArray(plain), '沒帶 limit 時維持原本的陣列回應');
    assert.strictEqual(plain.length, 100);
});

test('分頁：limit 有上限、壞參數不會 500', async () => {
    const tooBig = await (await fetch(`${base}/api/competitions?limit=99999`)).json();
    assert.ok(tooBig.items.length <= 500, `單次上限 500，實際 ${tooBig.items.length}`);

    const bad = await fetch(`${base}/api/competitions?limit=abc&offset=-5`);
    assert.strictEqual(bad.status, 200, '壞參數要退回預設，不是 500');
    const body = await bad.json();
    assert.ok(body.items.length > 0);
    assert.strictEqual(body.offset, 0);
});

test('報名名單：管理員可用 limit/offset 分頁（狀態篩選仍正確）', async () => {
    const auth = { Authorization: `Bearer ${ownerToken()}` };
    const all = await (await fetch(`${base}/api/competitions/801/registrations`, { headers: auth })).json();
    assert.strictEqual(all.registrations.length, 30, '不帶 limit 時維持原本的完整清單');
    assert.strictEqual(all.total, 30);

    const paged = await (await fetch(`${base}/api/competitions/801/registrations?limit=10&offset=10`, { headers: auth })).json();
    assert.strictEqual(paged.registrations.length, 10);
    assert.strictEqual(paged.total, 30, 'total 是全部筆數，不是本頁筆數');
    assert.strictEqual(paged.page.has_more, true);
    assert.strictEqual(paged.page.offset, 10);
    assert.strictEqual(paged.page.paged_by, 'db', '管理員且沒有狀態篩選 → 直接在資料庫分頁');
    assert.strictEqual(paged.counts.total, 30, '統計數字不受分頁影響');

    // 最後一頁
    const last = await (await fetch(`${base}/api/competitions/801/registrations?limit=10&offset=25`, { headers: auth })).json();
    assert.strictEqual(last.registrations.length, 5);
    assert.strictEqual(last.page.has_more, false);
});

test('報名名單：有 ?status= 篩選時退回記憶體分頁（狀態是正規化後才比對）', async () => {
    const auth = { Authorization: `Bearer ${ownerToken()}` };
    const paged = await (await fetch(`${base}/api/competitions/801/registrations?limit=5&status=confirmed`, { headers: auth })).json();
    assert.strictEqual(paged.page.paged_by, 'memory');
    assert.strictEqual(paged.registrations.length, 5);
    assert.strictEqual(paged.total, 30, '全部都是 confirmed');
    assert.ok(paged.registrations.every((r) => r.status === 'confirmed'));
});

test('報名名單：一般使用者分頁時只算自己的筆數，不會洩漏全場總數', async () => {
    const userAuth = { Authorization: `Bearer ${jwt.sign({ sub: 90, username: 'u0', role: 'user' }, SECRET)}` };
    const mine = await (await fetch(`${base}/api/competitions/801/registrations`, { headers: userAuth })).json();
    assert.ok(mine.registrations.every((r) => String(r.user_id) === '90'), '一般使用者只看得到自己的報名');

    const paged = await (await fetch(`${base}/api/competitions/801/registrations?limit=2`, { headers: userAuth })).json();
    assert.strictEqual(paged.total, mine.registrations.length, 'total 要是「我自己看得到的筆數」，不是全場筆數');
    assert.ok(paged.total < 30, '不該等於全場 30 筆');
    assert.ok(paged.registrations.every((r) => String(r.user_id) === '90'));
    assert.strictEqual(paged.page.paged_by, 'memory');
    assert.strictEqual(paged.page.limit, 2);
});
