/* v2.19.0：賽事狀態機的 API 端到端測試
 *
 * 驗的是「後端真的照狀態機辦事」：
 *   ① /api/competitions 每一筆都帶 state／can_register／reason（前端只負責顯示）
 *   ② ?state= 可以只取某種狀態
 *   ③ 報名端點真的擋：已結束／進行中／尚未開放／已截止／額滿 → 400 且說明原因
 *   ④ 報名視窗（registration_start_at／registration_end_at）存得進去、清得掉
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v219-state-api-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const day = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        // 五種狀態各一筆：報名中 / 尚未開放 / 報名已截止 / 進行中 / 已結束
        competitions: [
            { id: 401, name: '報名中賽事', date: day(30), time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 0 },
            { id: 402, name: '還沒開放報名', date: day(30), time: '09:00', is_registration_open: true, is_deleted: false, registration_start_at: iso(3 * DAY) },
            { id: 403, name: '報名已截止', date: day(30), time: '09:00', is_registration_open: true, is_deleted: false, registration_end_at: iso(-1 * DAY) },
            { id: 404, name: '正在進行', date: day(-1), time: '00:00', end_date: day(1), end_time: '23:59', is_registration_open: true, is_deleted: false },
            { id: 405, name: '已經結束', date: day(-5), time: '09:00', is_registration_open: true, is_deleted: false },
            { id: 406, name: '名額已滿', date: day(30), time: '09:00', is_registration_open: true, is_deleted: false, max_registrations: 1 }
        ],
        registrations: [{ id: 900, competition_id: 406, user_id: 99, is_deleted: false }],
        audit_logs: [],
        error_logs: []
    },
    nextId: { competitions: 500, registrations: 1000, audit_logs: 900, error_logs: 900 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const userToken = () => jwt.sign({ sub: 42, username: 'player', role: 'user' }, SECRET);
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    if (server) server.close();
    if (stub) stub.close();
});

const api = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});

test('v2.19.0：賽事列表每一筆都帶狀態（後端即時判定，前端只顯示）', async () => {
    const res = await api('/api/competitions');
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));

    assert.strictEqual(byId[401].state, 'registration_open');
    assert.strictEqual(byId[401].can_register, true);
    assert.strictEqual(byId[402].state, 'registration_upcoming');
    assert.strictEqual(byId[403].state, 'registration_closed');
    assert.strictEqual(byId[404].state, 'ongoing');
    assert.strictEqual(byId[405].state, 'finished', '日期已過且沒有結束時間 → 已結束');
    assert.strictEqual(byId[406].state, 'registration_open');
    assert.strictEqual(byId[406].can_register, false, '名額已滿不可報名');
    assert.strictEqual(byId[406].is_full, true);

    // 每一筆都要有可顯示的中文標籤與說明
    for (const c of list) {
        assert.ok(c.state_label, `${c.id} 缺少 state_label`);
        assert.strictEqual(typeof c.can_register, 'boolean');
        assert.strictEqual(typeof c.registration_reason, 'string');
        assert.ok(c.state_detail !== undefined);
    }
});

test('v2.19.0：?state= 只回指定狀態（可逗號分隔）', async () => {
    const ongoing = await (await api('/api/competitions?state=ongoing')).json();
    assert.deepStrictEqual(ongoing.map((c) => c.id), [404]);

    const two = await (await api('/api/competitions?state=ongoing,finished')).json();
    assert.deepStrictEqual(two.map((c) => c.id).sort(), [404, 405]);

    const none = await (await api('/api/competitions?state=不存在的狀態')).json();
    assert.deepStrictEqual(none, []);
});

test('v2.19.0：報名端點照狀態機擋人（已結束／進行中／尚未開放／已截止／額滿）', async () => {
    const cases = [
        [405, /已結束/],
        [404, /已開始/],
        [402, /報名將於/],
        [403, /報名已於/],
        [406, /已達上限/]
    ];
    for (const [id, pattern] of cases) {
        const res = await api(`/api/competitions/${id}/register`, { method: 'POST', token: userToken(), body: {} });
        assert.strictEqual(res.status, 400, `賽事 ${id} 應該擋下報名`);
        assert.match((await res.json()).error, pattern, `賽事 ${id} 的說明文字`);
    }
    // 真的沒有任何一筆被寫進去
    assert.strictEqual(state.tables.registrations.length, 1, '被擋下的報名不可留下任何資料');
});

test('v2.19.0：報名中的賽事仍可正常報名', async () => {
    const res = await api('/api/competitions/401/register', { method: 'POST', token: userToken(), body: { note: '測試' } });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.ok(state.tables.registrations.some((r) => r.competition_id === 401 && r.user_id === 42));
});

test('v2.19.0：報名開始／截止時間存得進去、也可以清掉', async () => {
    const start = iso(1 * DAY);
    const end = iso(10 * DAY);

    const created = await api('/api/competitions', {
        method: 'POST',
        token: ownerToken(),
        body: { name: '視窗測試賽事', date: day(40), time: '10:00', is_registration_open: true, registration_start_at: start, registration_end_at: end }
    });
    assert.strictEqual(created.status, 200);
    const row = await created.json();
    assert.ok(row.id);
    const saved = state.tables.competitions.find((c) => c.id === row.id);
    assert.ok(saved.registration_start_at, '報名開始時間要存進資料庫');
    assert.ok(saved.registration_end_at, '報名截止時間要存進資料庫');
    // 舊欄位也要同步（舊前端與既有查詢相容）
    assert.strictEqual(saved.registration_deadline, end.slice(0, 10));

    // 清空 → 資料庫欄位變 null（不是保留舊值）
    const cleared = await api(`/api/competitions/${row.id}`, {
        method: 'PUT',
        token: ownerToken(),
        body: { name: '視窗測試賽事', date: day(40), time: '10:00', is_registration_open: true, registration_start_at: null, registration_end_at: null }
    });
    assert.strictEqual(cleared.status, 200);
    const after = state.tables.competitions.find((c) => c.id === row.id);
    assert.strictEqual(after.registration_start_at, null);
    assert.strictEqual(after.registration_end_at, null);
});

test('v2.19.0：不正當的報名時間字串會被丟棄（不寫進資料庫）', async () => {
    const res = await api('/api/competitions', {
        method: 'POST',
        token: ownerToken(),
        body: { name: '壞時間測試', date: day(40), registration_start_at: '明天', registration_end_at: '2026-13-45T99:99' }
    });
    assert.strictEqual(res.status, 200);
    const row = await res.json();
    const saved = state.tables.competitions.find((c) => c.id === row.id);
    assert.ok(!saved.registration_start_at, '不合法字串不該寫入（null／未設定皆可）');
    assert.ok(!saved.registration_end_at, '不合法字串不該寫入（null／未設定皆可）');
});
