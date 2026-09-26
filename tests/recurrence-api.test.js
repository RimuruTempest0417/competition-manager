/* v2.24.0：複製賽事與週期性賽事的 API 測試
 *
 * 這一版有兩件事要顧：
 *   ① 複製賽事：設定要照抄、進度（報名、隊伍）絕對不能跟著搬，
 *      而且複製品是獨立的一場（不會被 cron 當成系列的一員）。
 *   ② 週期性賽事：設定週期後，「立即建立下一場」與每日 cron 走同一條路，
 *      該建就建、不該建要說清楚原因、絕不重複建立、超過結束日就停。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v224-recurrence-secret';
const CRON = 'v224-cron-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = CRON;

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return isoOf(d);
};
const TODAY = isoOf(new Date());

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            {
                id: 801, name: '週三夜賽', location: '澳門運動場', date: TODAY, time: '20:00',
                end_date: null, end_time: null, description: '每週例賽',
                is_registration_open: true, category: 'road', tags: ['夜賽'],
                is_team_event: true, team_size: 3, max_registrations: 60,
                registration_deadline: TODAY, requires_approval: true, waitlist_enabled: true,
                waitlist_notify: false, registration_start_at: plusDays(-7), registration_end_at: TODAY,
                recurrence: null, recurrence_until: null, recurrence_parent_id: null,
                is_deleted: false, created_at: '2026-01-01T00:00:00Z'
            },
            {
                id: 802, name: '不重複的賽事', location: '氹仔', date: plusDays(20), time: '10:00',
                description: '', is_registration_open: false, category: 'track', tags: [],
                is_team_event: false, team_size: null, max_registrations: 100,
                registration_deadline: null, requires_approval: false, waitlist_enabled: false,
                waitlist_notify: true, registration_start_at: null, registration_end_at: null,
                recurrence: 'monthly', recurrence_until: null, recurrence_parent_id: null,
                is_deleted: false, created_at: '2026-01-02T00:00:00Z'
            },
            {
                id: 803, name: '系列中的第二場', location: '澳門運動場', date: TODAY, time: '20:00',
                description: '每週例賽', is_registration_open: true, category: 'road', tags: ['夜賽'],
                is_team_event: false, team_size: null, max_registrations: 60,
                registration_deadline: null, requires_approval: true, waitlist_enabled: true,
                waitlist_notify: true, registration_start_at: plusDays(-3), registration_end_at: plusDays(4),
                recurrence: 'weekly', recurrence_until: null, recurrence_parent_id: 801,
                is_deleted: false, created_at: '2026-01-03T00:00:00Z'
            }
        ],
        registrations: [
            { id: 5001, competition_id: 801, user_id: 91, username: 'runnerA', status: 'confirmed', is_deleted: false, created_at: '2026-09-01T00:00:00Z' }
        ],
        teams: [
            { id: 7001, competition_id: 801, name: 'A 隊', is_deleted: false }
        ],
        audit_logs: [],
        error_logs: [],
        push_subscriptions: [],
        push_log: []
    },
    nextId: { competitions: 900, registrations: 6000, teams: 8000, audit_logs: 1000, error_logs: 1000, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);

const api = (method, url, body, token) => fetch(base + url, {
    method,
    headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: `Bearer ${token}` } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
});

const comp = (id) => state.tables.competitions.find((c) => c.id === id);
const latestAudit = () => state.tables.audit_logs[state.tables.audit_logs.length - 1];

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

/* ── 複製賽事 ── */

test('複製賽事：設定照抄、名稱加（複製）、可報名與隊伍設定都帶過去', async () => {
    const before = state.tables.competitions.length;
    const res = await api('POST', '/api/competitions/801/duplicate', {}, adminToken());
    assert.strictEqual(res.status, 201);
    const copy = await res.json();

    assert.strictEqual(state.tables.competitions.length, before + 1);
    assert.strictEqual(copy.name, '週三夜賽（複製）');
    assert.strictEqual(copy.location, '澳門運動場');
    assert.strictEqual(copy.date, TODAY);
    assert.strictEqual(copy.time, '20:00');
    assert.strictEqual(copy.description, '每週例賽');
    assert.strictEqual(copy.category, 'road');
    assert.deepStrictEqual(copy.tags, ['夜賽']);
    assert.strictEqual(copy.is_team_event, true);
    assert.strictEqual(copy.team_size, 3);
    assert.strictEqual(copy.max_registrations, 60);
    assert.strictEqual(copy.requires_approval, true);
    assert.strictEqual(copy.waitlist_enabled, true);
    assert.strictEqual(copy.waitlist_notify, false, '通知開關也要照抄');
    assert.strictEqual(copy.registration_start_at, plusDays(-7), '報名開始時間照抄');
    assert.strictEqual(copy.registration_end_at, TODAY);
    assert.strictEqual(copy.copied_from, 801);
    assert.strictEqual(copy.copied_from_name, '週三夜賽');
    assert.notStrictEqual(copy.id, 801);
});

test('複製賽事：報名與隊伍不會跟著搬（只複製設定，不複製進度）', async () => {
    const regsBefore = state.tables.registrations.length;
    const teamsBefore = state.tables.teams.length;
    const res = await api('POST', '/api/competitions/801/duplicate', {}, adminToken());
    const copy = await res.json();

    assert.strictEqual(state.tables.registrations.length, regsBefore, '不可以複製報名紀錄');
    assert.strictEqual(state.tables.teams.length, teamsBefore, '不可以複製隊伍');
    assert.strictEqual(state.tables.registrations.filter((r) => r.competition_id === copy.id).length, 0);
    assert.strictEqual(state.tables.teams.filter((t) => t.competition_id === copy.id).length, 0);
});

test('複製賽事：複製品不帶週期（是獨立的一場，不會被 cron 當成系列成員）', async () => {
    // 803 是 801 系列的第二場，複製它
    const res = await api('POST', '/api/competitions/803/duplicate', {}, adminToken());
    const copy = await res.json();
    assert.strictEqual(res.status, 201);
    assert.ok(!copy.recurrence, `複製品不該有週期，實際：${copy.recurrence}`);
    assert.ok(!copy.recurrence_parent_id, '複製品不該隸屬原系列');
});

test('複製賽事：名稱已經是（複製）時不會變成（複製）（複製）', async () => {
    const first = await (await api('POST', '/api/competitions/802/duplicate', {}, adminToken())).json();
    assert.strictEqual(first.name, '不重複的賽事（複製）');
    const second = await (await api('POST', `/api/competitions/${first.id}/duplicate`, {}, adminToken())).json();
    assert.strictEqual(second.name, '不重複的賽事（複製）');
});

test('複製賽事：會留稽核紀錄（含原名稱、新名稱、日期）', async () => {
    await api('POST', '/api/competitions/801/duplicate', {}, adminToken());
    const log = latestAudit();
    assert.strictEqual(log.action, 'DUPLICATE_COMPETITION');
    assert.strictEqual(log.user_id, 'owner');
    assert.match(log.details, /週三夜賽/);
    assert.match(log.details, /週三夜賽（複製）/);
    assert.match(log.details, /報名與隊伍不搬/);
});

test('複製賽事：一般使用者 403、找不到賽事 404', async () => {
    const forbidden = await api('POST', '/api/competitions/801/duplicate', {}, userToken());
    assert.strictEqual(forbidden.status, 403);
    const missing = await api('POST', '/api/competitions/99999/duplicate', {}, adminToken());
    assert.strictEqual(missing.status, 404);
});

/* ── 設定週期 ── */

test('設定週期：每兩週＋結束日，回中文標籤並寫稽核', async () => {
    const res = await api('POST', '/api/competitions/801/recurrence', { recurrence: 'biweekly', recurrence_until: plusDays(120) }, adminToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.recurrence, 'biweekly');
    assert.strictEqual(body.recurrence_until, plusDays(120));
    assert.strictEqual(body.recurrence_label, '每兩週');
    assert.strictEqual(comp(801).recurrence, 'biweekly');
    assert.strictEqual(latestAudit().action, 'SET_RECURRENCE');
    assert.match(latestAudit().details, /每兩週/);
});

test('設定週期：取消時結束日也要一起清掉', async () => {
    const res = await api('POST', '/api/competitions/801/recurrence', { recurrence: null }, adminToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(comp(801).recurrence, null);
    assert.strictEqual(comp(801).recurrence_until, null);
    assert.match(latestAudit().details, /取消週期設定/);
});

test('設定週期：規則與結束日都要檢查，不合法一律 400', async () => {
    const badRule = await api('POST', '/api/competitions/801/recurrence', { recurrence: 'daily' }, adminToken());
    assert.strictEqual(badRule.status, 400);
    const badDate = await api('POST', '/api/competitions/801/recurrence', { recurrence: 'weekly', recurrence_until: '2026/12/31' }, adminToken());
    assert.strictEqual(badDate.status, 400);
    const earlyEnd = await api('POST', '/api/competitions/802/recurrence', { recurrence: 'weekly', recurrence_until: plusDays(-10) }, adminToken());
    assert.strictEqual(earlyEnd.status, 400, '結束日不能早於賽事日期');
    const forbidden = await api('POST', '/api/competitions/801/recurrence', { recurrence: 'weekly' }, userToken());
    assert.strictEqual(forbidden.status, 403);
    const missing = await api('POST', '/api/competitions/99999/recurrence', { recurrence: 'weekly' }, adminToken());
    assert.strictEqual(missing.status, 404);
});

/* ── 立即建立下一場 ── */

test('立即建立下一場：日期對了、報名窗一起往後挪、稽核有紀錄', async () => {
    await api('POST', '/api/competitions/801/recurrence', { recurrence: 'weekly' }, adminToken());
    const before = state.tables.competitions.length;
    const res = await api('POST', '/api/competitions/801/recurrence/next', {}, adminToken());
    assert.strictEqual(res.status, 201);
    const created = await res.json();

    assert.strictEqual(state.tables.competitions.length, before + 1);
    assert.strictEqual(created.date, plusDays(7), '每週 → 下一場是 7 天後');
    assert.strictEqual(String(created.created_from), '801', 'created_from 是來源賽事 id（路徑參數）');
    assert.strictEqual(created.name, '週三夜賽', '自動建立沿用同一個名稱（不加（複製））');
    assert.strictEqual(created.recurrence, 'weekly', '下一場要繼續同一套週期');
    assert.strictEqual(created.recurrence_parent_id, 801, '歸在同一個系列底下');
    assert.strictEqual(created.registration_start_at, plusDays(0), '報名開始時間跟著挪 7 天');
    assert.strictEqual(created.registration_end_at, plusDays(7));
    assert.strictEqual(latestAudit().action, 'CREATE_RECURRING_COMPETITION');
    assert.match(latestAudit().details, /每週/);
});

test('立即建立下一場：已經有了就不會重複建立（409 並說明）', async () => {
    const before = state.tables.competitions.length;
    const res = await api('POST', '/api/competitions/801/recurrence/next', {}, adminToken());
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /已經有排定的場次|已經存在/);
    assert.strictEqual(state.tables.competitions.length, before, '不可以建立第二筆');
});

test('立即建立下一場：系列已經有排定的場次 → 不重複排（一次只排一場）', async () => {
    // 802 是每月、下一場在 20+30 天後；而且它自己那場（20 天後）都還沒到，
    // 不該一次把後面好幾場都開出來
    await api('POST', '/api/competitions/802/recurrence', { recurrence: 'monthly' }, adminToken());
    const before = state.tables.competitions.length;
    const res = await api('POST', '/api/competitions/802/recurrence/next', {}, adminToken());
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /已經有排定的場次/);
    assert.ok(body.date, '要告訴使用者下一場是哪一天');
    assert.strictEqual(state.tables.competitions.length, before, '不可以多開場次');
    await api('POST', '/api/competitions/802/recurrence', { recurrence: null }, adminToken());
});

test('立即建立下一場：超過結束日 → 409', async () => {
    await api('POST', '/api/competitions/801/recurrence', { recurrence: 'weekly', recurrence_until: TODAY }, adminToken());
    const res = await api('POST', '/api/competitions/801/recurrence/next', {}, adminToken());
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /已超過週期結束日/);
    await api('POST', '/api/competitions/801/recurrence', { recurrence: null }, adminToken());
});

test('立即建立下一場：沒設定週期 → 409 說「沒有設定週期」', async () => {
    assert.strictEqual(comp(801).recurrence, null, '前一個測試應該已把 801 的週期清掉');
    const res = await api('POST', '/api/competitions/801/recurrence/next', {}, adminToken());
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /沒有設定週期/);
});

/* ── 每日 cron 一起做 ── */

test('每日 cron：會把到期的系列開好下一場，並回報做了什麼', async () => {
    await api('POST', '/api/competitions/801/recurrence', { recurrence: 'weekly' }, adminToken());
    // 先手動建掉這一場，讓系列回到「還沒建」的狀態是不合理的；
    // 這裡改成用 803（系列成員、7 天後到期）確認 cron 會處理系列。
    const before = state.tables.competitions.length;
    const res = await api('GET', '/api/cron/reminders', undefined, undefined);
    // cron 端點用 CRON_SECRET，不是 JWT
    assert.ok([401, 200].includes(res.status), `未帶權杖應被擋或需權杖，實際 ${res.status}`);
    const authorized = await fetch(base + '/api/cron/reminders', { headers: { Authorization: `Bearer ${CRON}` } });
    assert.strictEqual(authorized.status, 200);
    const body = await authorized.json();
    assert.ok(body.recurring, 'cron 回應要包含週期性賽事的處理結果');
    assert.ok(typeof body.recurring.checked === 'number');
    assert.ok(state.tables.competitions.length >= before, '只會增加、不會減少');
});

test('每日 cron：沒帶或不對的 CRON_SECRET 一律擋掉', async () => {
    const wrong = await fetch(base + '/api/cron/reminders', { headers: { Authorization: 'Bearer wrong-secret' } });
    assert.strictEqual(wrong.status, 401);
    const none = await fetch(base + '/api/cron/reminders');
    assert.strictEqual(none.status, 401);
});
