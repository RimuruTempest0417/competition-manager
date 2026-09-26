/* v3.6.3：賽事取消／延期與卡片「最新消息」（Roadmap 8.8⑥）
 *
 * 為什麼要驗這些：
 *   ① 取消／延期是「人工決定」，優先於日期推導——不能因為日期還沒到就說「報名中」
 *   ② 取消後**真的不能報名**（不是只顯示一個標籤），而且錯誤訊息要說出取消原因
 *   ③ 延期**不覆蓋原訂時間**（事後要看得出「原本訂幾號、延到幾號」）
 *   ④ 公告（news）不需訂閱就看得到，且清空後要真的清掉
 *   ⑤ 沒跑 migration 時要明確回 503 並指出要跑哪一支，不能假裝成功
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v363-notice-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const makeState = () => ({
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 3, username: 'staff', password: 'x', role: 'admin', is_active: true },
            { id: 4, username: 'player', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 951, name: '颱風盃', date: '2026-10-05', time: '09:00', end_date: '2026-10-05', end_time: '18:00', is_registration_open: true, is_deleted: false, max_registrations: 10, created_at: '2026-09-01T00:00:00.000Z', cancelled_at: null, cancel_reason: null, postponed_date: null, postponed_time: null, news: null, news_updated_at: null }
        ],
        registrations: [],
        audit_logs: [],
        push_subscriptions: []
    },
    nextId: { registrations: 900, audit_logs: 950 }
});

test('v3.6.3 賽事取消／延期與最新消息', async (t) => {
    const state = makeState();
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    });

    const token = (username, role, sub) => jwt.sign({ sub, username, role }, SECRET, { expiresIn: '10m' });
    const ownerAuth = { Authorization: 'Bearer ' + token('owner', 'web_owner', 1) };
    const staffAuth = { Authorization: 'Bearer ' + token('staff', 'admin', 3) };
    const playerAuth = { Authorization: 'Bearer ' + token('player', 'user', 4) };
    const post = (url, body, headers = staffAuth) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body || {})
    });
    const comp = () => state.tables.competitions.find((c) => c.id === 951);
    // 狀態與公告都由 public/js/competition-state.js（前後端共用的唯一來源）決定；
    // 列表 API 只負責把欄位送出來，所以這裡兩邊都驗：API 有沒有送欄位、規則算出來對不對。
    const CMState = require(path.join(__dirname, '..', 'public', 'js', 'competition-state.js'));
    const rowOf = async (id = 951) => {
        const res = await fetch(base + '/api/competitions');
        const list = await res.json();
        const rows = Array.isArray(list) ? list : (list.competitions || []);
        return rows.find((c) => String(c.id) === String(id)) || {};
    };
    const noticeOf = async (id = 951) => {
        const row = await rowOf(id);
        const st = CMState.evaluate(row, new Date());
        return Object.assign({}, st, { can_register: st.can_register, reason: st.reason, notice: st.notice, row });
    };

    /* ── ① 權限：未登入 401、一般使用者 403（取消賽事是重大操作）── */
    assert.strictEqual((await post('/api/competitions/951/cancel', { reason: 'x' }, {})).status, 401);
    assert.strictEqual((await post('/api/competitions/951/cancel', { reason: 'x' }, playerAuth)).status, 403);
    assert.strictEqual((await post('/api/competitions/951/postpone', { postponed_date: '2026-11-01' }, playerAuth)).status, 403);
    assert.strictEqual((await post('/api/competitions/951/news', { news: 'x' }, playerAuth)).status, 403);
    assert.strictEqual(comp().cancelled_at, null, '被擋下的請求不可以改到資料');

    /* ── ② 取消一定要填原因（原因會顯示在卡片上給大家看）── */
    const noReason = await post('/api/competitions/951/cancel', {});
    assert.strictEqual(noReason.status, 400, '取消沒填原因要擋下來');
    assert.ok((await noReason.json()).error.includes('原因'));

    /* ── ③ 取消成功：資料庫有時間與原因、狀態變已取消、不能報名 ── */
    const cancelled = await post('/api/competitions/951/cancel', { reason: '颱風來襲，場地封閉' });
    assert.strictEqual(cancelled.status, 200, '管理員可以取消賽事（' + (await cancelled.clone().text()) + '）');
    assert.ok(comp().cancelled_at, '取消時間要寫進資料庫');
    assert.strictEqual(comp().cancel_reason, '颱風來襲，場地封閉', '取消原因要存下來');
    const afterCancel = await noticeOf();
    assert.strictEqual(afterCancel.state, 'cancelled', '狀態推導要變成已取消（不是還在報名中）');
    assert.strictEqual(afterCancel.label, '已取消', '狀態文字要是「已取消」');
    assert.strictEqual(afterCancel.can_register, false, '取消後不可再報名');
    assert.ok(afterCancel.reason.includes('颱風'), '不能報名的原因要說出取消原因');
    assert.strictEqual(afterCancel.notice.cancelled, true, '公告物件要標明已取消');
    assert.strictEqual(afterCancel.notice.cancel_reason, '颱風來襲，場地封閉');
    assert.strictEqual(afterCancel.notice.has_notice, true);
    assert.strictEqual(comp().date, '2026-10-05', '取消不覆蓋原訂日期');
    assert.ok(JSON.stringify(state.tables.audit_logs).includes('CANCEL_COMPETITION'), '取消要留稽核');

    /* ── ④ 取消後真的報不了名（不是只換一個標籤）── */
    const regBlocked = await post('/api/competitions/951/register', {}, playerAuth);
    assert.strictEqual(regBlocked.status, 400, '取消的賽事不能報名');
    assert.ok((await regBlocked.json()).error.includes('颱風'), '報名被擋時要告訴使用者取消原因');
    assert.strictEqual(state.tables.registrations.length, 0, '沒有任何報名紀錄被建立');

    /* ── ⑤ 復原（cancelled:false）── */
    const revived = await post('/api/competitions/951/cancel', { cancelled: false });
    assert.strictEqual(revived.status, 200);
    assert.strictEqual(comp().cancelled_at, null, '復原要把取消時間清掉');
    assert.strictEqual(comp().cancel_reason, null);
    const afterRevive = await noticeOf();
    assert.strictEqual(afterRevive.can_register, true, '復原後又可以報名');

    /* ── ⑥ 延期：保留原訂時間、記下新時間、報名暫停 ── */
    assert.strictEqual((await post('/api/competitions/951/postpone', { postponed_date: '2026-10-99' })).status, 400, '日期格式錯要擋');
    assert.strictEqual((await post('/api/competitions/951/postpone', { postponed_date: '2026-10-05' })).status, 400, '新日期和原訂一樣要擋（請改用最新消息）');
    const postponed = await post('/api/competitions/951/postpone', { postponed_date: '2026-11-15', postponed_time: '08:30', reason: '颱風改期' });
    assert.strictEqual(postponed.status, 200, '管理員可以延期（' + (await postponed.clone().text()) + '）');
    assert.strictEqual(comp().postponed_date, '2026-11-15', '延期後的新日期要存下來');
    assert.strictEqual(comp().postponed_time, '08:30');
    assert.strictEqual(comp().date, '2026-10-05', '★原訂日期不可以被覆蓋（事後要追查得到）');
    const afterPostpone = await noticeOf();
    assert.strictEqual(afterPostpone.state, 'postponed', '狀態推導要變成已延期');
    assert.strictEqual(afterPostpone.can_register, false, '延期期間暫停報名');
    assert.ok(afterPostpone.reason.includes('2026-11-15'), '要講清楚延到哪一天');
    assert.strictEqual(afterPostpone.notice.postponed_label, '2026-11-15 08:30');
    assert.ok(JSON.stringify(state.tables.audit_logs).includes('POSTPONE_COMPETITION'), '延期要留稽核');

    /* ── ⑦ 取消延期標記 ── */
    const cleared = await post('/api/competitions/951/postpone', { postponed_date: null });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(comp().postponed_date, null);
    assert.strictEqual((await noticeOf()).can_register, true, '取消延期後恢復正常');

    /* ── ⑧ 最新消息：直接顯示、可清空 ── */
    const newsRes = await post('/api/competitions/951/news', { news: '集合時間改為 08:30，請提早 20 分鐘到場' });
    assert.strictEqual(newsRes.status, 200, '管理員可以更新最新消息（' + (await newsRes.clone().text()) + '）');
    assert.strictEqual(comp().news, '集合時間改為 08:30，請提早 20 分鐘到場');
    assert.ok(comp().news_updated_at, '要有更新時間（卡片顯示用）');
    const withNews = await noticeOf();
    assert.strictEqual(withNews.notice.news, '集合時間改為 08:30，請提早 20 分鐘到場');
    assert.strictEqual(withNews.notice.has_notice, true);
    assert.strictEqual(withNews.can_register, true, '只有最新消息不影響報名');
    assert.ok(JSON.stringify(state.tables.audit_logs).includes('UPDATE_COMPETITION_NEWS'), '更新消息要留稽核');

    const clearedNews = await post('/api/competitions/951/news', { news: '' });
    assert.strictEqual(clearedNews.status, 200);
    assert.strictEqual(comp().news, null, '清空要真的清掉（不是留空字串）');
    assert.strictEqual(comp().news_updated_at, null);
    assert.strictEqual((await noticeOf()).notice.has_notice, false, '沒有公告時 has_notice 要是 false');

    /* ── ⑨ 列表也帶著公告欄位（卡片直接畫，不用再打一次 API）── */
    await post('/api/competitions/951/news', { news: '請注意颱風動向' });
    const row = await rowOf();
    assert.ok(row && row.id, '列表要有這筆賽事');
    assert.strictEqual(row.news, '請注意颱風動向', '列表要帶最新消息');
    assert.strictEqual(typeof row.cancelled_at, 'object', '列表要帶 cancelled_at（null 也算有這個欄位）');
    assert.ok('postponed_date' in row && 'cancel_reason' in row, '列表要帶所有公告欄位');

    /* ── ⑩ 沒跑 migration：明確 503 並指出要跑哪一支 ── */
    const noMigration = makeState();
    noMigration.missingColumns = { competitions: ['cancelled_at'] };
    const stub2 = await startFakeSupabase(noMigration);
    const prevUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub2.address().port}`;
    const appPath = require.resolve(path.join(__dirname, '..', 'server.js'));
    delete require.cache[appPath];
    const app2 = require(appPath);
    const server2 = app2.listen(0, '127.0.0.1');
    await once(server2, 'listening');
    try {
        const res2 = await fetch(`http://127.0.0.1:${server2.address().port}/api/competitions/951/cancel`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, ownerAuth),
            body: JSON.stringify({ reason: '測試' })
        });
        const payload = await res2.json();
        assert.strictEqual(res2.status, 503, '沒跑 migration 要回 503，不能假裝取消成功');
        assert.ok(payload.error.includes('v3.6.3'), '要指出要跑哪一支 migration');
    } finally {
        try { server2.close(); } catch (err) { /* 忽略 */ }
        try { stub2.close(); } catch (err) { /* 忽略 */ }
        process.env.SUPABASE_URL = prevUrl;
    }

    assert.ok(ownerAuth, 'owner 權杖沒用到也不會壞（保留給後續檢查）');
});
