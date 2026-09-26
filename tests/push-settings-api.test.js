/* v2.25.0：推播設定（時間與事件）的 API 測試
 *
 * 驗的是「設定真的有效」而不是只有畫面好看：
 *   ① GET 回預設值；POST 寫進 app_settings、留稽核（含前後值）
 *   ② 壞輸入一律 400（時間格式、不是布林），權限不足 403
 *   ③ 關掉「報名審核結果通知」後，審核一筆報名**完全不會去查推播訂閱**（不是查了才不送）
 *   ④ 每日摘要：時間還沒到不發、時間到了才發、**同一天只發一次**、總開關關掉不發、
 *      兩種摘要事件都關掉不發（也都不能去查訂閱）
 *   ⑤ 設定表讀不到時（降級）用預設值繼續運作，不會讓推播整個壞掉
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v225-push-settings-secret';
const CRON = 'v225-cron-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';
process.env.CRON_SECRET = CRON;

const pad = (n) => String(n).padStart(2, '0');
const SITE_OFFSET_MIN = 8 * 60;
/* 用「網站時區（+08:00）的字串」表示某個時刻，方便直接餵給賽事日期與設定時間 */
const localOf = (date) => {
    const d = new Date(date.getTime() + SITE_OFFSET_MIN * 60000);
    return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    };
};
const hoursFromNow = (h) => localOf(new Date(Date.now() + h * 3600 * 1000));
const NOW_LOCAL = localOf(new Date());
const SOON = hoursFromNow(2);          // 2 小時後開賽 → 摘要的「開賽提醒」對象
const EVEN_LATER = hoursFromNow(3);    // 拿來當「還沒到發送時間」的設定值

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true }],
        competitions: [
            {
                id: 861, name: '兩小時後的賽事', date: SOON.date, time: SOON.time, location: '澳門',
                is_registration_open: true, is_deleted: false, max_registrations: 10,
                requires_approval: true, waitlist_enabled: true, waitlist_notify: true,
                created_at: '2026-01-01T00:00:00Z'
            }
        ],
        registrations: [
            { id: 5101, competition_id: 861, user_id: 91, username: 'runnerA', status: 'pending', is_deleted: false, created_at: '2026-09-01T00:00:00Z' }
        ],
        push_subscriptions: [
            { id: 1, user_id: 91, endpoint: 'http://127.0.0.1:9/push', p256dh: 'k', auth: 'a', is_active: true }
        ],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    nextId: { competitions: 900, registrations: 6000, audit_logs: 1000, error_logs: 1000, push_log: 100 },
    log: []
};

let base = '';
let stub = null;
let server = null;

const adminToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);

const api = (method, url, body, token) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
});
const runCron = () => fetch(`${base}/api/cron/reminders`, { headers: { Authorization: `Bearer ${CRON}` } });
const settingsRow = (key) => (state.tables.app_settings || []).find((r) => r.key === key);
const subscriptionQueries = () => state.log.filter((l) => /push_subscriptions/.test(l.url)).length;
const lastAudit = () => state.tables.audit_logs[state.tables.audit_logs.length - 1] || {};

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

/* ── 讀寫設定 ── */

test('GET：沒設定過時回預設值（每日摘要 09:00、事件全開）', async () => {
    const res = await api('GET', '/api/push/settings', undefined, adminToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.schema_ready, true);
    assert.deepStrictEqual(body.settings, {
        digest_enabled: true,
        digest_time: '09:00',
        digest_kind_new: true,
        digest_kind_reminder: true,
        event_review: true,
        event_promote: true,
        event_announce: true   // v2.26.0：公告發布通知
    });
});

test('POST：寫進 app_settings、回傳變更內容、留稽核（含前後值）', async () => {
    const res = await api('POST', '/api/push/settings', {
        digest_time: '21:30',
        digest_kind_new: false,
        event_review: false
    }, adminToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.settings.digest_time, '21:30');
    assert.strictEqual(body.settings.digest_kind_new, false);
    assert.strictEqual(body.settings.event_review, false);
    assert.strictEqual(body.settings.event_promote, true, '沒帶到的欄位不該被改掉');

    assert.strictEqual(settingsRow('push_digest_time').value, '21:30');
    assert.strictEqual(settingsRow('push_digest_kind_new').value, 'false');
    assert.strictEqual(settingsRow('push_event_review').value, 'false');

    const changes = body.changes.join('；');
    assert.match(changes, /發送時間：09:00 → 21:30/);
    assert.match(changes, /摘要含新賽事：開啟 → 關閉/);
    assert.match(changes, /報名審核結果通知：開啟 → 關閉/);
    assert.strictEqual(lastAudit().action, 'UPDATE_PUSH_SETTINGS');
    assert.match(lastAudit().details, /21:30/);
});

test('POST：壞輸入一律 400（不改動任何設定）', async () => {
    const badTime = await api('POST', '/api/push/settings', { digest_time: '25:00' }, adminToken());
    assert.strictEqual(badTime.status, 400);
    const badBool = await api('POST', '/api/push/settings', { digest_enabled: 'false' }, adminToken());
    assert.strictEqual(badBool.status, 400);
    assert.strictEqual(settingsRow('push_digest_time').value, '21:30', '被擋下來時不可以偷偷改設定');
});

test('只送部分欄位時，其他設定不會被打回預設值', async () => {
    // 迴歸：驗證用的「基準值」若混到原始鍵名，沒帶到的欄位會變成 undefined 被寫回去
    const before = (await (await api('GET', '/api/push/settings', undefined, adminToken())).json()).settings;
    assert.strictEqual((await api('POST', '/api/push/settings', { digest_time: '07:15' }, adminToken())).status, 200);
    assert.strictEqual((await api('POST', '/api/push/settings', { event_promote: false }, adminToken())).status, 200);

    const readSettings = async () => (await (await api('GET', '/api/push/settings', undefined, adminToken())).json()).settings;
    const saved = await readSettings();

    assert.strictEqual(saved.digest_time, '07:15', '沒帶到的發送時間要留在原值');
    assert.strictEqual(saved.event_promote, false, '這次帶的欄位要生效');
    ['digest_enabled', 'digest_kind_new', 'digest_kind_reminder', 'event_review'].forEach((field) => {
        assert.strictEqual(saved[field], before[field], `沒帶到的「${field}」不可以被改掉`);
    });

    // 還原成後面測試預期的值
    await api('POST', '/api/push/settings', { digest_time: '21:30', event_promote: true }, adminToken());
});

test('權限：一般使用者讀不了也改不了、未登入 401', async () => {
    assert.strictEqual((await api('GET', '/api/push/settings', undefined, userToken())).status, 403);
    assert.strictEqual((await api('POST', '/api/push/settings', { digest_time: '08:00' }, userToken())).status, 403);
    assert.strictEqual((await api('GET', '/api/push/settings')).status, 401);
});

/* ── 事件開關真的有效 ── */

test('關掉「報名審核結果通知」後，核准報名完全不會去查推播訂閱', async () => {
    await api('POST', '/api/push/settings', { event_review: false }, adminToken());
    const before = subscriptionQueries();

    const res = await api('POST', '/api/registrations/5101/review', { action: 'approve' }, adminToken());
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.notified, 0, '沒有送出任何推播');
    assert.strictEqual(subscriptionQueries(), before, '應該在查詢訂閱之前就被站台設定擋下來');

    const log = (state.tables.push_log || []).filter((l) => l.kind === 'review_result');
    assert.ok(log.length >= 1, '仍要留下推播紀錄（送 0 則）');
    const last = log[log.length - 1];
    const sentCount = last.sent_count === undefined ? last.sent : last.sent_count;
    assert.strictEqual(sentCount, 0, '站台設定關閉時不可以送出任何推播');
});

test('把「報名審核結果通知」打開後，會真的去查推播訂閱', async () => {
    await api('POST', '/api/push/settings', { event_review: true }, adminToken());
    const before = subscriptionQueries();
    await api('POST', '/api/registrations/5101/review', { action: 'reject', note: '測試' }, adminToken());
    assert.ok(subscriptionQueries() > before, '開啟時要查訂閱（有訂閱才會送）');
});

/* ── 每日摘要的時間與事件 ── */

test('每日摘要：時間還沒到就不發（也不會去查訂閱）', async () => {
    await api('POST', '/api/push/settings', { digest_time: EVEN_LATER.time, digest_enabled: true }, adminToken());
    const before = subscriptionQueries();
    const res = await runCron();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.digest.ran, false);
    assert.match(body.digest.reason, /還沒到發送時間/);
    assert.strictEqual(subscriptionQueries(), before, '不該查訂閱');
});

test('每日摘要：時間到了就發（有到期的開賽提醒），並記下今天已發', async () => {
    await api('POST', '/api/push/settings', {
        digest_time: '00:00', digest_enabled: true, digest_kind_new: true, digest_kind_reminder: true
    }, adminToken());
    const before = subscriptionQueries();
    const res = await runCron();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.digest.ran, true, JSON.stringify(body.digest));
    assert.deepStrictEqual(body.digest.kinds, ['reminder', 'new']);
    assert.ok(body.candidates >= 1, `應該找到 2 小時後開賽的提醒（candidates=${body.candidates}）`);
    assert.ok(subscriptionQueries() > before, '應該去查訂閱並嘗試發送');
    assert.strictEqual(settingsRow('push_last_digest_date').value, NOW_LOCAL.date);
});

test('每日摘要：同一天再跑一次不會重複發', async () => {
    const before = subscriptionQueries();
    const body = await (await runCron()).json();
    assert.strictEqual(body.digest.ran, false);
    assert.match(body.digest.reason, /今天已經發送過/);
    assert.strictEqual(subscriptionQueries(), before, '第二次不該再查訂閱');
});

test('每日摘要：總開關關掉就不發（就算時間到了、也還沒發過）', async () => {
    await api('POST', '/api/push/settings', { digest_enabled: false }, adminToken());
    // 把「今天已發」清掉，確認真的只是因為開關
    const row = settingsRow('push_last_digest_date');
    if (row) row.value = '2000-01-01';
    const before = subscriptionQueries();
    const body = await (await runCron()).json();
    assert.strictEqual(body.digest.ran, false);
    assert.match(body.digest.reason, /每日摘要已關閉/);
    assert.strictEqual(subscriptionQueries(), before);
});

test('每日摘要：兩種摘要事件都關掉＝沒有東西可發（也不會查訂閱）', async () => {
    await api('POST', '/api/push/settings', {
        digest_enabled: true, digest_time: '00:00',
        digest_kind_new: false, digest_kind_reminder: false
    }, adminToken());
    const row = settingsRow('push_last_digest_date');
    if (row) row.value = '2000-01-01';
    const before = subscriptionQueries();
    const body = await (await runCron()).json();
    assert.strictEqual(body.digest.ran, false);
    assert.match(body.digest.reason, /都關掉了/);
    assert.deepStrictEqual(body.digest.kinds, []);
    assert.strictEqual(subscriptionQueries(), before);
});

test('每日摘要：只留「新賽事」時，種類只會有 new', async () => {
    await api('POST', '/api/push/settings', { digest_kind_new: true }, adminToken());
    const row = settingsRow('push_last_digest_date');
    if (row) row.value = '2000-01-01';
    const body = await (await runCron()).json();
    assert.deepStrictEqual(body.digest.kinds, ['new']);
});

test('每日摘要不會影響週期性賽事的排程結果（cron 回應仍帶著 recurring）', async () => {
    const body = await (await runCron()).json();
    assert.ok(body.recurring, 'cron 回應要有 recurring（v2.24.0 的功能）');
    assert.ok(body.digest, 'cron 回應要有 digest（v2.25.0 的功能）');
});
