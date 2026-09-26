/* v3.1.0：成績與結果的 API 測試
 *
 * 驗的是「成績登錄對人、草稿不外洩、公布才算數」：
 *   ① 未公布時：訪客與一般使用者只拿到「成績尚未公布」，管理員看得到草稿
 *   ② 儲存成績：一般使用者 403、未登入 401、整批驗證失敗時一筆都不寫
 *   ③ 自動排名：後端算好才寫入（與前端同一套規則）
 *   ④ 公布：要 confirm、沒有成績不能公布、公布後訪客看得到名次與獎牌
 *   ⑤ 通知：只推給參賽者；站台把 event_result 關掉就不推
 *   ⑥ 取消公布：前台立刻看不到，成績保留為草稿
 *   ⑦ 我的成績：只看得到「已公布」的、只看得到自己的
 *   ⑧ 每個寫入動作都留稽核
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v310-results-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const DEAD_ENDPOINT = 'http://127.0.0.1:9/push-stub';

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true, email: 'owner@example.com' },
            { id: 5, username: 'judgeLin', password: 'x', role: 'admin', is_active: true },
            { id: 91, username: 'runnerA', password: 'x', role: 'user', is_active: true, email: 'a@example.com' },
            { id: 92, username: 'runnerB', password: 'x', role: 'user', is_active: true },
            { id: 93, username: '晚到的人', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            { id: 861, name: '秋季盃', location: '澳門氹仔運動場', date: '2026-12-01', time: '09:00', category: '田徑路跑', is_deleted: false, max_registrations: 10, result_published_at: null, result_published_by: null, result_summary: null },
            { id: 862, name: '春季盃', location: '', date: '2026-03-01', time: '08:00', category: '田徑路跑', is_deleted: false, max_registrations: 10, result_published_at: null, result_published_by: null, result_summary: null }
        ],
        registrations: [
            { id: 11, competition_id: 861, user_id: 91, username: 'runnerA', team_name: null, status: 'confirmed', is_deleted: false },
            { id: 12, competition_id: 861, user_id: 92, username: 'runnerB', team_name: '雙人組', status: 'confirmed', is_deleted: false },
            { id: 13, competition_id: 861, user_id: 93, username: '晚到的人', team_name: null, status: 'pending', is_deleted: false },
            { id: 14, competition_id: 861, user_id: null, username: '被拒絕的人', team_name: null, status: 'rejected', is_deleted: false },
            { id: 15, competition_id: 861, user_id: 94, username: '已取消的人', team_name: null, status: 'confirmed', is_deleted: true },
            { id: 21, competition_id: 862, user_id: 91, username: 'runnerA', team_name: null, status: 'confirmed', is_deleted: false }
        ],
        competition_results: [],
        push_subscriptions: [
            { id: 9001, user_id: 91, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true },
            { id: 9002, user_id: 92, endpoint: DEAD_ENDPOINT, p256dh: 'k', auth: 'a', is_active: true }
        ],
        push_log: [],
        audit_logs: [],
        error_logs: [],
        app_settings: []
    },
    nextId: { competition_results: 1000, audit_logs: 1, error_logs: 1, push_log: 1, app_settings: 1 },
    log: []
};

let base = '';
let stub = null;
let server = null;
const ownerToken = () => jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
const judgeToken = () => jwt.sign({ sub: 5, username: 'judgeLin', role: 'admin' }, SECRET);
const userToken = () => jwt.sign({ sub: 91, username: 'runnerA', role: 'user' }, SECRET);
const authHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

const resultsOf = (id) => state.tables.competition_results.filter((r) => String(r.competition_id) === String(id));
const auditsOf = (action) => state.tables.audit_logs.filter((a) => a.action === action);
const comp = (id) => state.tables.competitions.find((c) => String(c.id) === String(id));

const api = async (method, url, body, token) => {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: token ? authHeaders(token) : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

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

/* ── ① 草稿不外洩 ── */

test('未公布時：訪客只拿到「成績尚未公布」，看不到任何草稿數字', async () => {
    state.tables.competition_results.push(
        { id: 501, competition_id: 861, registration_id: 11, user_id: 91, username: 'runnerA', display_name: 'runnerA', status: 'finished', score_text: '12:00', rank: 1, note: null }
    );
    const res = await api('GET', '/api/competitions/861/results');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.published, false);
    assert.strictEqual(res.body.message, '成績尚未公布');
    assert.deepStrictEqual(res.body.results, []);
    assert.strictEqual(res.body.stats, null, '草稿統計也不能給訪客');
    assert.strictEqual(JSON.stringify(res.body).includes('12:00'), false, '草稿成績不能出現在回應裡');
});

test('未公布時：一般登入使用者跟訪客看到的一樣（草稿只有管理員看得到）', async () => {
    const res = await api('GET', '/api/competitions/861/results', undefined, userToken());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, []);
    assert.strictEqual(res.body.message, '成績尚未公布');
});

test('未公布時：管理員看得到草稿、附公布前檢查', async () => {
    const res = await api('GET', '/api/competitions/861/results?x=1', undefined, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.published, false);
    assert.strictEqual(res.body.draft, true);
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(res.body.results[0].rank_label, '第 1 名');
    assert.strictEqual(res.body.results[0].medal, '🥇');
    assert.strictEqual(res.body.approved_count, 2, '已核准的是 runnerA 與 runnerB（pending／rejected／已刪除都不算）');
    assert.strictEqual(res.body.checklist.missing_count, 1, 'runnerB 還沒有成績');
});

/* ── ② 儲存成績 ── */

test('儲存成績：一般使用者 403、未登入 401', async () => {
    const payload = { results: [{ registration_id: 12, score_text: '13:00', status: 'finished' }] };
    assert.strictEqual((await api('PUT', '/api/competitions/861/results', payload, userToken())).status, 403);
    assert.strictEqual((await api('PUT', '/api/competitions/861/results', payload)).status, 401);
});

test('儲存成績：管理員可以存、回統計、留稽核', async () => {
    const res = await api('PUT', '/api/competitions/861/results', {
        results: [
            { registration_id: 11, score_text: '12:00', rank: 1, status: 'finished' },
            { registration_id: 12, score_text: '13:30', rank: 2, status: 'finished' }
        ]
    }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.saved, 2);
    assert.strictEqual(res.body.stats.total, 2);
    assert.strictEqual(res.body.checklist.missing_count, 0);
    assert.strictEqual(resultsOf(861).length, 2);

    const audit = auditsOf('SAVE_RESULTS');
    assert.strictEqual(audit.length, 1);
    assert.match(String(audit[0].details), /登錄成績: 秋季盃（儲存 2 筆）/);
    assert.strictEqual(audit[0].user_id, 'judgeLin');
});

test('儲存成績：再一次儲存同一筆＝更新，不會多一列', async () => {
    const res = await api('PUT', '/api/competitions/861/results', {
        results: [{ registration_id: 12, score_text: '13:10', rank: 2, status: 'finished' }]
    }, judgeToken());
    assert.strictEqual(res.status, 200);
    const row = resultsOf(861).find((r) => String(r.registration_id) === '12');
    assert.strictEqual(row.score_text, '13:10');
    assert.strictEqual(resultsOf(861).length, 2, '還是兩筆');
});

test('儲存成績：整批驗證失敗時一筆都不寫入', async () => {
    const before = resultsOf(862).length;
    const res = await api('PUT', '/api/competitions/861/results', {
        results: [
            { registration_id: 12, score_text: '13:20', rank: 2, status: 'finished' },              // 合法
            { registration_id: 12, score_text: '13:21', rank: 3, status: 'finished' },              // 同一筆重複
            { registration_id: 21, score_text: '10:00', status: 'finished' },                        // 別場賽事的報名
            { registration_id: 13, score_text: '11:00', status: 'finished' },                        // 未核准（pending）
            { registration_id: 11, rank: 'abc', status: 'finished' }                                 // 名次不是數字
        ]
    }, judgeToken());
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /重複送出/);
    assert.match(res.body.error, /不在本賽事的已核准名單/);
    assert.match(res.body.error, /名次必須是正整數/);
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length >= 3);
    assert.strictEqual(resultsOf(862).length, before, '別場賽事不能被寫入');
    assert.strictEqual(resultsOf(861).find((r) => String(r.registration_id) === '12').score_text, '13:10', '失敗時連合法的那筆也不能寫進去');
});

test('儲存成績：可以明確指定要刪除的成績', async () => {
    await api('PUT', '/api/competitions/861/results', {
        results: [{ registration_id: 12, score_text: '13:30', rank: 2 }]
    }, judgeToken());
    const target = resultsOf(861).find((r) => String(r.registration_id) === '12');
    const res = await api('PUT', '/api/competitions/861/results', {
        results: [], remove_ids: [target.id]
    }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.removed, 1);
    assert.strictEqual(resultsOf(861).length, 1);
    assert.match(String(auditsOf('SAVE_RESULTS').pop().details), /刪除 1 筆/);
});

/* ── ③ 自動排名（後端算） ── */

test('儲存成績：帶 auto_rank 由後端排名寫入（越小越好，並列同名次）', async () => {
    await api('PUT', '/api/competitions/862/results', {
        results: [{ registration_id: 21, score_text: '10:00', rank: null, status: 'finished' }]
    }, judgeToken());

    // 春季盃再加一位參賽者，讓名次有變化
    state.tables.registrations.push({ id: 22, competition_id: 862, user_id: 92, username: 'runnerB', team_name: null, status: 'confirmed', is_deleted: false });
    const res = await api('PUT', '/api/competitions/862/results', {
        results: [
            { registration_id: 21, score_text: '10:30', status: 'finished' },
            { registration_id: 22, score_text: '10:00', status: 'finished' }
        ],
        auto_rank: true
    }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.auto_ranked, true);
    const rows = resultsOf(862);
    assert.strictEqual(rows.find((r) => String(r.registration_id) === '22').rank, 1);
    assert.strictEqual(rows.find((r) => String(r.registration_id) === '21').rank, 2);
    assert.match(String(auditsOf('SAVE_RESULTS').pop().details), /自動排名/);
});

test('儲存成績：auto_rank + order=desc 給分數類用（越大越好）', async () => {
    const res = await api('PUT', '/api/competitions/862/results', {
        results: [
            { registration_id: 21, score_text: '85', status: 'finished' },
            { registration_id: 22, score_text: '92', status: 'finished' }
        ],
        auto_rank: true, order: 'desc'
    }, judgeToken());
    assert.strictEqual(res.status, 200);
    const rows = resultsOf(862);
    assert.strictEqual(rows.find((r) => String(r.registration_id) === '22').rank, 1, '92 分第一名');
    assert.strictEqual(rows.find((r) => String(r.registration_id) === '21').rank, 2);
});

/* ── ④ 公布 ── */

test('公布：沒帶 confirm 會被擋、沒有成績的賽事也不能公布', async () => {
    const noConfirm = await api('POST', '/api/competitions/861/results/publish', {}, judgeToken());
    assert.strictEqual(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /confirm/);

    state.tables.competitions.push({ id: 863, name: '空賽事', is_deleted: false, max_registrations: 5, result_published_at: null, result_summary: null });
    const empty = await api('POST', '/api/competitions/863/results/publish', { confirm: true }, judgeToken());
    assert.strictEqual(empty.status, 400);
    assert.match(empty.body.error, /還沒有任何成績/);
});

test('公布：管理員可以公布、回統計與前三名、留稽核；訪客立刻看得到', async () => {
    const res = await api('POST', '/api/competitions/861/results/publish', { confirm: true, summary: '計時賽，取最佳成績' }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.published, true);
    assert.strictEqual(res.body.summary, '計時賽，取最佳成績');
    assert.strictEqual(res.body.stats.podium.length, 1, '只剩 runnerA 有成績');
    assert.ok(comp(861).result_published_at, '公布時間要寫進賽事');

    const audit = auditsOf('PUBLISH_RESULTS');
    assert.match(String(audit[0].details), /公布成績: 秋季盃（1 筆/);
    assert.match(String(audit[0].details), /前三名 🥇runnerA/);

    const guest = await api('GET', '/api/competitions/861/results');
    assert.strictEqual(guest.body.published, true);
    assert.strictEqual(guest.body.results[0].rank_label, '第 1 名');
    assert.strictEqual(guest.body.stats.podium[0].medal, '🥇');
    assert.strictEqual(guest.body.draft, false, '公布後就不是草稿狀態');
});

test('公布：開放式成績不會被誤認為時間（未排名者名次是 —）', async () => {
    state.tables.registrations.push({ id: 23, competition_id: 862, user_id: 93, username: '晚到的人', team_name: null, status: 'confirmed', is_deleted: false });
    await api('PUT', '/api/competitions/862/results', {
        results: [{ registration_id: 23, score_text: '未完成', status: 'finished' }]
    }, judgeToken());
    await api('POST', '/api/competitions/862/results/publish', { confirm: true }, judgeToken());
    const res = await api('GET', '/api/competitions/862/results');
    const row = res.body.results.find((r) => String(r.registration_id) === '23');
    assert.strictEqual(row.rank, null);
    assert.strictEqual(row.rank_label, '—');
    assert.strictEqual(row.line, '未完成', '名次是「—」，成績文字照實顯示');
});

/* ── ⑤ 通知 ── */

test('公布＋notify：只推給參賽者，並在推播紀錄留下對象與失敗原因', async () => {
    state.tables.competition_results.length = 0;
    state.tables.competition_results.push(
        { id: 901, competition_id: 862, registration_id: 21, user_id: 91, username: 'runnerA', display_name: 'runnerA', status: 'finished', score_text: '10:30', rank: 2, note: null },
        { id: 902, competition_id: 862, registration_id: 22, user_id: 92, username: 'runnerB', display_name: 'runnerB', status: 'finished', score_text: '10:00', rank: 1, note: null }
    );
    const res = await api('POST', '/api/competitions/862/results/publish', { confirm: true, notify: true }, ownerToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.notified.total, 2, '兩位都有訂閱');
    assert.strictEqual(res.body.notified.sent, 0, '端點是壞的');
    assert.strictEqual(res.body.notified.failed, 2);

    const pushRow = state.tables.push_log[state.tables.push_log.length - 1];
    assert.strictEqual(pushRow.kind, 'result_published');
    assert.strictEqual(pushRow.competition_id, 862);
    assert.deepStrictEqual(pushRow.target_user_ids.slice().sort(), [91, 92], '只推給有報名的人');
    assert.strictEqual(Number(pushRow.failed_count), 2);
    assert.match(String(pushRow.payload_title || pushRow.payload && pushRow.payload.title || ''), /成績已公布/);
});

test('公布＋notify：站台把「成績公布通知」關掉就不推（成績照樣公布）', async () => {
    // 前面的測試把秋季盃的成績刪掉了，這裡自己先把成績登錄好，不依賴測試順序
    await api('PUT', '/api/competitions/861/results', {
        results: [{ registration_id: 11, score_text: '12:00', rank: 1, status: 'finished' }]
    }, judgeToken());
    await api('POST', '/api/push/settings', { event_result: false }, ownerToken());
    const pushBefore = state.tables.push_log.length;
    const res = await api('POST', '/api/competitions/861/results/publish', { confirm: true, notify: true }, ownerToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.notified.sent, 0);
    assert.ok(res.body.notified.skipped, '要說明是站台設定關掉了');
    assert.strictEqual(res.body.notified.failed, 0, '關掉時不該去嘗試推播');
    assert.strictEqual(state.tables.push_log.length, pushBefore + 1, '仍然留一筆推播紀錄（sent 0），不會靜悄悄');
    assert.strictEqual(comp(861).result_published_at !== null, true, '成績照樣公布');

    await api('POST', '/api/push/settings', { event_result: true }, ownerToken());
});

/* ── ⑥ 取消公布 ── */

test('取消公布：要 confirm、沒公布時是 400、取消後前台立刻看不到', async () => {
    await api('PUT', '/api/competitions/861/results', {
        results: [{ registration_id: 11, score_text: '12:00', rank: 1, status: 'finished' }]
    }, judgeToken());
    await api('POST', '/api/competitions/861/results/publish', { confirm: true }, judgeToken());

    assert.strictEqual((await api('POST', '/api/competitions/861/results/unpublish', {}, judgeToken())).status, 400);
    const res = await api('POST', '/api/competitions/861/results/unpublish', { confirm: true }, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.published, false);
    assert.strictEqual(comp(861).result_published_at, null);
    assert.strictEqual(resultsOf(861).length, 1, '成績本身要留著（只是變草稿）');

    const guest = await api('GET', '/api/competitions/861/results');
    assert.deepStrictEqual(guest.body.results, []);
    assert.match(String(auditsOf('UNPUBLISH_RESULTS')[0].details), /取消公布成績: 秋季盃/);

    const again = await api('POST', '/api/competitions/861/results/unpublish', { confirm: true }, judgeToken());
    assert.strictEqual(again.status, 400);
    assert.match(again.body.error, /目前沒有公布/);
});

/* ── ⑦ 我的成績 ── */

test('我的成績：只看得到自己的、且只有已公布的', async () => {
    const res = await api('GET', '/api/my/results', undefined, userToken());
    assert.strictEqual(res.status, 200);
    const mine = res.body;
    assert.deepStrictEqual(mine.map((r) => r.competition_id).sort(), [861, 862].filter((id) => comp(id).result_published_at).sort(),
        '未公布的賽事不能出現在我的成績');

    // 春季盃有 runnerA 的一筆（已公布）
    const spring = mine.find((r) => String(r.competition_id) === '862');
    assert.strictEqual(spring.competition_name, '春季盃');
    assert.strictEqual(spring.rank_label, '第 2 名');
    assert.strictEqual(spring.medal, '🥈');

    assert.strictEqual(mine.some((r) => r.username === 'runnerB'), false, '不該看到別人的成績');
    assert.strictEqual(JSON.stringify(mine).includes('@example.com'), false, '不該帶出 email');
    assert.strictEqual((await api('GET', '/api/my/results')).status, 401);
});

/* ── ⑧ 登錄表單 ── */

test('登錄表單：每位已核准者一列（含未登錄者）、孤兒成績單獨列、非管理員看不到', async () => {
    const res = await api('GET', '/api/competitions/861/result-sheet', undefined, judgeToken());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.entries.map((e) => e.registration_id).sort(), [11, 12]);
    const pending = res.body.entries.find((e) => e.registration_id === 11);
    assert.strictEqual(pending.existing, true);
    assert.strictEqual(pending.score_text, '12:00');
    const notEntered = res.body.entries.find((e) => e.registration_id === 12);
    assert.strictEqual(notEntered.existing, false, '還沒登錄的人也要出現在名單裡');
    assert.strictEqual(notEntered.display_name, '雙人組', '組隊比賽顯示隊名');
    assert.strictEqual(res.body.max_score_length, 60);
    assert.strictEqual(res.body.checklist.missing_count, 1);

    // 已經不在已核准名單裡的成績（例如後來被取消錄取）不能默默消失
    state.tables.competition_results.push({ id: 950, competition_id: 861, registration_id: 13, user_id: 93, username: '晚到的人', display_name: null, status: 'finished', score_text: '11:00', rank: 1, note: null });
    const again = await api('GET', '/api/competitions/861/result-sheet', undefined, judgeToken());
    assert.strictEqual(again.body.orphan.length, 1);
    assert.strictEqual(again.body.orphan[0].registration_id, 13);
    assert.strictEqual(again.body.orphan[0].line, '第 1 名 · 11:00');

    assert.strictEqual((await api('GET', '/api/competitions/861/result-sheet', undefined, userToken())).status, 403);
    assert.strictEqual((await api('GET', '/api/competitions/861/result-sheet')).status, 401);
});

test('不存在的賽事：一律 404，不會硬寫一筆孤兒成績', async () => {
    assert.strictEqual((await api('GET', '/api/competitions/9999/results')).status, 404);
    assert.strictEqual((await api('GET', '/api/competitions/9999/result-sheet', undefined, judgeToken())).status, 404);
    assert.strictEqual((await api('PUT', '/api/competitions/9999/results', { results: [] }, judgeToken())).status, 404);
    assert.strictEqual((await api('POST', '/api/competitions/9999/results/publish', { confirm: true }, judgeToken())).status, 404);
});
