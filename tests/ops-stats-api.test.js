/* v3.0.0 營運儀表板 API（/api/admin/stats）
 *
 * 驗的重點不只是「數字對」，還有：
 *   1. 權限（一般使用者一律 403、未登入 401）
 *   2. 不含個資（回應裡不該出現任何帳號名稱）
 *   3. 降級（migration 沒跑的選用區塊只標 unavailable，不是 500）
 *   4. 快取（60 秒內第二次呼叫標 cached:true；?fresh=1 強制重算）
 *   5. 趨勢長度固定（前端圖表才不會忽寬忽窄）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v300-stats-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function buildState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: 'owner-secret', password: 'x', role: 'web_owner', is_active: true, created_at: daysAgo(60), last_login_at: daysAgo(1) },
                { id: 2, username: 'admin-secret', password: 'x', role: 'admin', is_active: true, created_at: daysAgo(40), last_login_at: daysAgo(20) },
                { id: 3, username: 'user-secret', password: 'x', role: 'user', is_active: true, created_at: daysAgo(10), last_login_at: daysAgo(400) },
                { id: 4, username: 'sleepy-secret', password: 'x', role: 'user', is_active: false, created_at: daysAgo(10) }
            ],
            competitions: [
                { id: 1, name: 'A', category: 'track', date: '2026-12-01', time: '09:00', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: daysAgo(3) },
                { id: 2, name: 'B', category: 'track', date: '2026-12-02', time: '09:00', is_registration_open: true, max_registrations: 20, is_deleted: false, created_at: daysAgo(2) },
                { id: 3, name: 'C', category: 'ball', date: '2026-01-02', time: '09:00', is_registration_open: false, max_registrations: 4, is_deleted: false, created_at: daysAgo(1) },
                { id: 99, name: '已刪除', category: 'ball', date: '2026-01-02', time: '09:00', is_deleted: true, created_at: daysAgo(1) }
            ],
            registrations: [
                { id: 1, competition_id: 1, user_id: 3, username: 'u', status: 'confirmed', is_deleted: false, created_at: daysAgo(0) },
                { id: 2, competition_id: 1, user_id: 3, username: 'u', status: 'confirmed', is_deleted: false, created_at: daysAgo(1) },
                { id: 3, competition_id: 2, user_id: 3, username: 'u', status: 'pending', is_deleted: false, created_at: daysAgo(2) },
                { id: 4, competition_id: 2, user_id: 3, username: 'u', status: 'waitlisted', is_deleted: false, created_at: daysAgo(20) },
                { id: 5, competition_id: 1, user_id: 3, username: 'u', status: 'confirmed', is_deleted: true, created_at: daysAgo(1) }
            ],
            error_logs: [
                { id: 1, error_type: 'unhandled_server_error', severity: 'error', resolved: false, path: '/api/x', created_at: daysAgo(1) },
                { id: 2, error_type: 'auth_invalid_token', severity: 'warn', resolved: false, path: '/api/y', created_at: daysAgo(2) },
                { id: 3, error_type: 'unhandled_server_error', severity: 'error', resolved: false, path: '/api/x', created_at: daysAgo(50) }
            ],
            // push_log 的真實欄位是 sent_at（沒有 created_at）——替身必須跟真的一樣，
            // 否則「查了不存在的欄位」會被測試放過，上線後才在儀表板上變成讀不到的區塊。
            push_log: [
                { id: 1, sent_count: 90, failed_count: 10, sent_at: daysAgo(1) },
                { id: 2, sent_count: 10, failed_count: 0, sent_at: daysAgo(2) }
            ],
            competition_posters: [
                { competition_id: 1, bytes: 300000, thumb_mime: 'image/jpeg', thumb_bytes: 20000, thumb_data: 'x' },
                { competition_id: 2, bytes: 500000 }
            ],
            competition_staff: [{ id: 1, competition_id: 1, username: 'judge', role: 'referee' }],
            audit_logs: [],
            app_settings: []
        },
        nextId: { audit_logs: 1, error_logs: 1 },
        missingTables: [],
        log: []
    };
}

let base = '';
let state = null;
let stub = null;
let server = null;

test.before(async () => {
    state = buildState();
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

const tokenFor = (id, username, role) => jwt.sign({ sub: id, username, role }, SECRET);
const getStats = (token, query = '') => fetch(`${base}/api/admin/stats${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
});

test('權限：未登入 401、一般使用者 403（儀表板是管理員以上）', async () => {
    assert.strictEqual((await getStats(null)).status, 401);
    assert.strictEqual((await getStats(tokenFor(3, 'user-secret', 'user'))).status, 403);
    assert.strictEqual((await getStats(tokenFor(2, 'admin-secret', 'admin'))).status, 200);
    assert.strictEqual((await getStats(tokenFor(1, 'owner-secret', 'web_owner'))).status, 200);
});

test('賽事統計：只算未刪除的、狀態與分類分佈正確', async () => {
    const body = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1')).json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.competitions.total, 3, '已刪除的賽事不算在內');
    const byCat = Object.fromEntries(body.competitions.by_category.map((c) => [c.key, c.count]));
    assert.strictEqual(byCat.track, 2);
    assert.strictEqual(byCat.ball, 1);
    assert.strictEqual(body.competitions.by_category[0].key, 'track', '次數多的排前面');
    assert.strictEqual(body.competitions.by_category[0].label, '田徑路跑', '分類要有人看得懂的名稱');
    const stateSum = Object.values(body.competitions.by_state).reduce((a, b) => a + b, 0);
    assert.strictEqual(stateSum, 3, '狀態分佈加起來要等於總數');
});

test('報名統計：狀態分佈、候補不佔名額、趨勢長度固定', async () => {
    const body = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=14')).json();
    assert.strictEqual(body.registrations.total, 4, '已刪除的報名不算');
    assert.strictEqual(body.registrations.confirmed, 2);
    assert.strictEqual(body.registrations.pending, 1);
    assert.strictEqual(body.registrations.waitlisted, 1);
    assert.strictEqual(body.registrations.trend.length, 14, '趨勢固定回 14 天');
    assert.strictEqual(body.registrations.trend.reduce((a, d) => a + d.count, 0), 3,
        '趨勢只算得進 14 天內的 3 筆（第 20 天那筆在窗外）');
    assert.strictEqual(body.registrations.last7d, 3, '近 7 天：3 筆（第 20 天那筆不算）');
    assert.ok(body.registrations.trend[13].date <= new Date().toISOString().slice(0, 10));
});

test('天數可以調整，但一定夾在 7–30 天之間', async () => {
    const seven = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=7')).json();
    assert.strictEqual(seven.trend_days, 7);
    assert.strictEqual(seven.registrations.trend.length, 7);

    const tooMuch = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=999')).json();
    assert.strictEqual(tooMuch.trend_days, 30, '上限 30 天');

    const tooLittle = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=1')).json();
    assert.strictEqual(tooLittle.trend_days, 7, '下限 7 天');

    const junk = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=abc')).json();
    assert.strictEqual(junk.trend_days, 14, '壞參數回預設 14 天');
});

test('使用者統計：角色分佈與近 30 天活躍（不含任何帳號名稱）', async () => {
    const res = await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1');
    const raw = await res.text();
    assert.ok(!raw.includes('owner-secret'), '回應不可以帶帳號名稱');
    assert.ok(!raw.includes('user-secret'), '回應不可以帶帳號名稱');
    assert.ok(!raw.includes('@'), '回應不可以帶 email');

    const body = JSON.parse(raw);
    assert.strictEqual(body.users.total, 4);
    assert.strictEqual(body.users.active, 3, '停用的帳號不算活躍');
    assert.strictEqual(body.users.inactive, 1);
    assert.strictEqual(body.users.by_role.admin, 1);
    assert.strictEqual(body.users.by_role.web_owner, 1);
    assert.strictEqual(body.users.active_last_30d, 2, '近 30 天登入過的有 2 個');
});

test('錯誤統計：只算近 30 天未處理的，趨勢與嚴重度分佈正確', async () => {
    const body = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=14')).json();
    assert.strictEqual(body.errors.open_recent_30d, 2, '50 天前那筆不列入 30 天視窗');
    assert.strictEqual(body.errors.by_severity.error, 1);
    assert.strictEqual(body.errors.by_severity.warn, 1);
    // 兩種類型各 1 筆（50 天前那筆不在 30 天視窗內）→ 同分時依名稱排序，順序必須穩定
    assert.deepStrictEqual(body.errors.top_types.map((t) => [t.key, t.count]),
        [['auth_invalid_token', 1], ['unhandled_server_error', 1]]);
    assert.strictEqual(body.errors.trend.length, 14);
});

test('推播統計：成功率與色調', async () => {
    const body = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1')).json();
    assert.strictEqual(body.push.sent, 100);
    assert.strictEqual(body.push.failed, 10);
    assert.strictEqual(body.push.success_rate, 91);
    assert.strictEqual(body.push.success_tone, 'warn', '91% → 注意');
});

test('效能區塊：海報縮圖省下的量、分頁上限、索引清單與耗時', async () => {
    const body = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1')).json();
    assert.strictEqual(body.perf.posters.count, 2);
    assert.strictEqual(body.perf.posters.total_bytes, 800000);
    assert.strictEqual(body.perf.posters.thumb_count, 1);
    assert.strictEqual(body.perf.posters.thumb_bytes, 20000);
    assert.strictEqual(body.perf.posters.thumb_saved, 780000);
    assert.strictEqual(body.perf.posters.total_label, '781 KB');
    assert.strictEqual(body.perf.paging.competitions_max, 100);
    assert.strictEqual(body.perf.paging.registrations_max, 200);
    assert.ok(body.perf.indexes.length >= 5, '要有索引清單');
    assert.ok(body.perf.indexes.every((i) => i.name && i.reason), '每個索引都要說明用途');
    assert.strictEqual(typeof body.perf.timings.competitions, 'number', '耗時是量出來的');
    // 迴歸：曾經因為查了 push_log.created_at（不存在的欄位）而讓「推播」區塊整塊讀不到，
    // 儀表板上出現黃色警告。任何一個區塊讀不到都要在這裡擋下來。
    assert.deepStrictEqual(body.unavailable_sections || [], [], '不應該有任何讀不到的區塊');
    assert.strictEqual(typeof body.perf.total_ms, 'number');
    assert.strictEqual(body.perf.staff_count, 1);
});

test('快取：60 秒內第二次回 cached:true，?fresh=1 強制重算', async () => {
    const first = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=14')).json();
    assert.strictEqual(first.cached, false);

    const second = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?days=14')).json();
    assert.strictEqual(second.cached, true, '第二次應該命中快取');
    assert.strictEqual(typeof second.cache_age_ms, 'number');
    assert.strictEqual(second.registrations.total, first.registrations.total, '快取的內容要一致');

    const fresh = await (await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1&days=14')).json();
    assert.strictEqual(fresh.cached, false, '?fresh=1 要強制重算');
});

test('降級：選用資料表不存在時只標記 unavailable，不是 500', async () => {
    const saved = state.tables.competition_staff;
    delete state.tables.competition_staff;
    // 注意：假服務在啟動時就抓了 state.missingTables 的參考，所以要就地 push，不能整個換掉
    state.missingTables.push('competition_staff');
    try {
        const res = await getStats(tokenFor(2, 'admin-secret', 'admin'), '?fresh=1');
        assert.strictEqual(res.status, 200, '不該整個儀表板壞掉');
        const body = await res.json();
        assert.strictEqual(body.perf.staff_count, null);
        assert.ok(body.unavailable_sections.some((s) => s.section === 'staff'), '要標示哪個區塊不可用');
        assert.ok(body.competitions.total > 0, '其他區塊照常有資料');
    } finally {
        state.tables.competition_staff = saved;
        state.missingTables.length = 0;
    }
});
