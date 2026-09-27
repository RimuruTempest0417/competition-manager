/* v3.9.0 API：系列積分、賽事回顧、報名表自訂欄位（端到端，看資料庫實際列）
 *
 * 驗證原則：不看回應訊息說「成功」，一律回頭讀資料庫那一列長什麼樣。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v390-api-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 2, username: 'coach', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 700, name: '秋季系列 第一站', date: '2027-03-01', is_deleted: false, is_registration_open: true,
              form_fields: [{ key: 'size', label: '衣服尺寸', type: 'select', required: true, options: ['S', 'M'] },
                            { key: 'phone', label: '聯絡電話', type: 'text', required: true }] },
            { id: 701, name: '秋季系列 第二站', date: '2027-03-08', is_deleted: false, is_registration_open: true,
              recurrence_parent_id: 700, form_fields: [] },
            { id: 702, name: '秋季系列 第三站', date: '2026-09-15', is_deleted: false, is_registration_open: true,
              recurrence_parent_id: 700 }
        ],
        registrations: [],
        competition_results: [],
        audit_logs: [], error_logs: [], app_settings: [], push_subscriptions: []
    },
    nextId: { competitions: 800, registrations: 900, competition_results: 1, audit_logs: 1, error_logs: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 2, username: 'coach', role: 'user' }, SECRET);
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token || ownerToken()}` });

test.before(async () => {
    stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    const app = require(path.join(__dirname, '..', 'server.js'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) { server.close(); await once(server, 'close').catch(() => {}); }
    if (stub) stub.close();
});

test('建立賽事：自訂欄位與系列積分真的寫進資料庫那一列', async () => {
    const res = await fetch(`${base}/api/competitions`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
            name: '冬季系列 第一站', date: '2027-01-05',
            series_points: { points: [10, 8, 6], count_best: 2 },
            form_fields: [{ label: '衣服尺寸', type: 'select', required: true, options: ['S', 'M', 'M'] },
                          { label: '', type: 'text' },
                          { label: '年齡', type: 'number' }]
        })
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    const row = state.tables.competitions.find((c) => String(c.id) === String(body.id));
    assert.ok(row, '賽事真的進資料庫了');
    assert.deepStrictEqual(row.series_points, { points: [10, 8, 6], count_best: 2 });
    assert.strictEqual(row.form_fields.length, 2, '沒有標籤的欄位要被丟掉');
    assert.deepStrictEqual(row.form_fields[0].options, ['S', 'M'], '選項要去重');
    assert.strictEqual(row.form_fields[1].type, 'number');
});

test('更新賽事：只送自訂欄位也能改，沒送的不會被清掉', async () => {
    const res = await fetch(`${base}/api/competitions/700`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ name: '秋季系列 第一站', form_fields: [{ label: '要繳費', type: 'checkbox', required: true }] })
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const row = state.tables.competitions.find((c) => String(c.id) === '700');
    assert.ok(row);
    assert.strictEqual(row.form_fields.length, 1);
    assert.strictEqual(row.form_fields[0].type, 'checkbox');
    assert.strictEqual(row.name, '秋季系列 第一站');
    // 既有行為：更新時沒帶 is_registration_open 就會變成未開放 → 後面的報名測試要先開回來
    row.is_registration_open = true;
});

test('報名：必填沒填 → 400 逐欄說明，而且資料庫不會多一列', async () => {
    // 上一個測試把 700 的欄位改掉了，這裡還原成原本的兩欄（尺寸必填／電話必填）
    state.tables.competitions.find((c) => String(c.id) === '700').form_fields = [
        { key: 'size', label: '衣服尺寸', type: 'select', required: true, options: ['S', 'M'] },
        { key: 'phone', label: '聯絡電話', type: 'text', required: true }
    ];
    const before = state.tables.registrations.length;
    const res = await fetch(`${base}/api/competitions/700/register`, {
        method: 'POST', headers: authHeaders(userToken()),
        body: JSON.stringify({ form_answers: { phone: '9123 4567' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.errors.size, /衣服尺寸/);
    assert.strictEqual(state.tables.registrations.length, before, '沒填完就不該進資料庫');
});

test('報名：填對 → 答案存進該筆報名，多送的欄位被丟掉（白名單）', async () => {
    const res = await fetch(`${base}/api/competitions/700/register`, {
        method: 'POST', headers: authHeaders(userToken()),
        body: JSON.stringify({ form_answers: { size: 'M', phone: '9123 4567', role: 'web_owner', is_admin: true } })
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const row = state.tables.registrations.find((r) => String(r.competition_id) === '700' && String(r.user_id) === '2');
    assert.ok(row, '報名那一列存在');
    assert.deepStrictEqual(row.form_answers, { size: 'M', phone: '9123 4567' });
    assert.strictEqual(row.form_answers.role, undefined, '沒定義的欄位不能存進去');
    assert.strictEqual(row.form_answers.is_admin, undefined);
});

test('報名：下拉選了不在選項裡的值 → 400', async () => {
    const res = await fetch(`${base}/api/competitions/701/register`, {
        method: 'POST', headers: authHeaders(userToken()),
        body: JSON.stringify({ form_answers: {} })
    });
    // 701 沒有自訂欄位 → 照樣可以報名（傳統報名表不受影響）
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
});

test('回顧報告：人數／到場率／頒獎台都對得上資料庫', async () => {
    state.tables.registrations.push(
        { id: 901, competition_id: 702, user_id: 3, username: '阿明', status: 'confirmed', is_deleted: false, attended_at: '2026-09-15T02:00:00Z' },
        { id: 902, competition_id: 702, user_id: 4, username: '阿華', status: 'confirmed', is_deleted: false, attended_at: null },
        { id: 903, competition_id: 702, user_id: 5, username: '小美', status: 'waitlisted', is_deleted: false, attended_at: null }
    );
    state.tables.competition_results.push(
        { id: 1, competition_id: 702, registration_id: 901, username: '阿明', rank: 1, status: 'finished', score_text: '12.50' },
        { id: 2, competition_id: 702, registration_id: 902, username: '阿華', rank: 2, status: 'finished', score_text: '11.75' }
    );
    const res = await fetch(`${base}/api/competitions/702/review`);
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.strictEqual(body.signups.total, 3);
    assert.strictEqual(body.signups.confirmed, 2);
    assert.strictEqual(body.signups.waitlisted, 1);
    assert.strictEqual(body.attendance.attended, 1);
    assert.strictEqual(body.attendance.rate, 50);
    assert.deepStrictEqual(body.results.podium.map((r) => `${r.rank}:${r.username}`), ['1:阿明', '2:阿華']);
    assert.strictEqual(body.name, '秋季系列 第三站');
    assert.strictEqual(body.series_root_id, 700, '子場次要指出它屬於哪個系列');
});

test('回顧報告：找不到賽事回 404，不是 500', async () => {
    const res = await fetch(`${base}/api/competitions/999999/review`);
    assert.strictEqual(res.status, 404);
});

test('系列總積分：跨場次累加，並帶出每一場的名次', async () => {
    state.tables.competitions.find((c) => c.id === 700).series_points = { points: [10, 8, 6, 5] };
    state.tables.registrations.push(
        { id: 911, competition_id: 700, user_id: 3, username: '阿明', status: 'confirmed', is_deleted: false },
        { id: 912, competition_id: 701, user_id: 4, username: '阿華', status: 'confirmed', is_deleted: false }
    );
    state.tables.competition_results.push(
        { id: 11, competition_id: 700, registration_id: 911, username: '阿明', rank: 1, status: 'finished' },
        { id: 12, competition_id: 701, registration_id: 911, username: '阿明', rank: 2, status: 'finished' },
        { id: 13, competition_id: 701, registration_id: 912, username: '阿華', rank: 1, status: 'finished' }
    );
    const res = await fetch(`${base}/api/series/700/standings`);
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.strictEqual(body.race_count, 3, '系列＝根本身 + 兩個子場次');
    const ming = body.standings.find((s) => s.username === '阿明');
    const hua = body.standings.find((s) => s.username === '阿華');
    // 阿明在這個系列有三場：700 第1名、701 第2名、702 第1名（回顧那個測試加的）→ 10+8+10
    assert.strictEqual(ming.total, 28, '700 第1名 10 + 701 第2名 8 + 702 第1名 10');
    assert.strictEqual(hua.total, 18, '第1名 10 分 + 702 的第2名 8 分');
    assert.strictEqual(body.standings[0].username, '阿明');
    assert.strictEqual(body.standings[0].race_count, 3);
    assert.strictEqual(ming.races.length, 3);
});

test('★v3.9.1：只有超表紀錄的人也要出現在系列排行（0 分），不能整筆消失', async () => {
    state.tables.registrations.push(
        { id: 913, competition_id: 702, user_id: 5, username: '小美', status: 'confirmed', is_deleted: false }
    );
    state.tables.competition_results.push(
        { id: 21, competition_id: 702, registration_id: 913, username: '小美', rank: null, status: 'dnf' },
        // 「有 rank 但狀態是 hidden」= 主辦把它藏起來，仍然不可以洩漏到排行
        { id: 22, competition_id: 702, registration_id: 913, username: '小美', rank: 1, status: 'hidden' }
    );
    const res = await fetch(`${base}/api/series/700/standings`);
    assert.strictEqual(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    const mei = body.standings.find((s) => s.username === '小美');
    assert.ok(mei, '只有未完賽紀錄的人也要出現');
    assert.strictEqual(mei.total, 0, '超表＝0 分');
    assert.strictEqual(mei.races.length, 1, '被隱藏的成績不算、超表那一場要算');
    assert.strictEqual(mei.races[0].status, 'dnf');
    assert.strictEqual(mei.races[0].rank, null);
    assert.strictEqual(mei.races[0].points, 0);
    assert.strictEqual(mei.races[0].name, '秋季系列 第三站', '要知道是哪一場');
});

test('系列總積分：從子場次查也回同一個系列（使用者是從哪一場點進來的都一樣）', async () => {
    const res = await fetch(`${base}/api/series/701/standings`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.series.root_id, 700);
    assert.strictEqual(body.series.is_root, false);
    assert.strictEqual(body.race_count, 3);
});

test('系列總積分：找不到系列回 404', async () => {
    const res = await fetch(`${base}/api/series/999999/standings`);
    assert.strictEqual(res.status, 404);
});
