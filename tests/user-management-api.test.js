/* v2.12.0：帳號管理 API 端到端測試。
   使用 tests/support/fake-supabase.js 模擬 PostgREST，完全不碰真實資料庫。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v212-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

function baseState(extra = {}) {
    return {
        tables: Object.assign({
            admin_users: [
                { id: 1, username: 'owner', password: 'plain-owner', role: 'web_owner', is_active: true },
                { id: 2, username: 'boss', password: 'plain-boss', role: 'super_admin', is_active: true },
                { id: 3, username: 'mgr', password: 'plain-mgr', role: 'admin', is_active: true },
                { id: 4, username: 'kid', password: 'plain-kid', role: 'user', is_active: true },
                { id: 5, username: 'ghost', password: 'plain-ghost', role: 'user', is_active: false },
                { id: 6, username: 'locky', password: 'plain-locky', role: 'user', is_active: true },
                { id: 7, username: 'helper', password: 'plain-helper', role: 'user', is_active: true },
                { id: 8, username: 'co', password: 'plain-co', role: 'web_owner', is_active: true }
            ],
            error_logs: [
                { id: 1, error_type: 'backend_error', message: '測試錯誤', severity: 'error', resolved: false, created_at: '2026-09-24T00:00:00.000Z', path: '/api/x' },
                { id: 2, error_type: 'auth_invalid_token', message: '權杖無效', severity: 'warn', resolved: false, created_at: '2026-09-24T01:00:00.000Z', path: '/api/y' },
                { id: 3, error_type: 'old_error', message: '很久以前的錯誤', severity: 'error', resolved: true, created_at: '2020-01-01T00:00:00.000Z', path: '/api/z' }
            ],
            push_log: [
                { id: 1, competition_id: 100, kind: 'reminder', sent_count: 7, sent_at: '2026-09-24T02:00:00.000Z' }
            ],
            audit_logs: [],
            competitions: [],
            registrations: []
        }, extra.tables || {}),
        missingColumns: extra.missingColumns || {},
        nextId: { admin_users: 90, error_logs: 500 }
    };
}

async function bootApp(state) {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return { stub, server, base, app };
}

const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
const auth = (sub, username, role) => ({ Authorization: `Bearer ${sign(sub, username, role)}` });

const req = (base, method) => (url, body, headers = {}) => fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body)
});

test('v2.12.0 帳號管理 API：階梯權限、角色調整、停用與軟性保護', async (t) => {
    const state = baseState();
    const { stub, server, base, app } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const get = req(base, 'GET');
    const post = req(base, 'POST');
    const patch = req(base, 'PATCH');
    const del = req(base, 'DELETE');

    const asOwner = auth(1, 'owner', 'web_owner');
    const asBoss = auth(2, 'boss', 'super_admin');
    const asMgr = auth(3, 'mgr', 'admin');
    const asKid = auth(4, 'kid', 'user');

    // ---------- 讀取清單 ----------
    const listRes = await fetch(`${base}/api/admin/users`, { headers: asMgr });
    assert.strictEqual(listRes.status, 200);
    const list = await listRes.json();
    assert.strictEqual(list.success, true);
    assert.strictEqual(list.users.length, 8);
    assert.deepStrictEqual(list.can_create, ['user', 'test'], '管理員只能建立普通用戶與測試帳號');
    assert.strictEqual(list.can_edit_roles, false, '管理員不能調整角色');
    assert.strictEqual(list.schema_ready, true);
    const kidRow = list.users.find((u) => u.username === 'kid');
    assert.strictEqual(kidRow.can_manage, true, '管理員可管理普通用戶');
    assert.strictEqual(kidRow.can_change_role, false);
    const bossRow = list.users.find((u) => u.username === 'boss');
    assert.strictEqual(bossRow.can_manage, false, '管理員不能管理超級管理員');
    const selfRow = list.users.find((u) => u.username === 'mgr');
    assert.strictEqual(selfRow.is_self, true);

    // 普通用戶不能讀取帳號清單（原本只有 super_admin 能讀，v2.12.0 開放給 admin 但不得再往下）
    const denied = await fetch(`${base}/api/admin/users`, { headers: asKid });
    assert.strictEqual(denied.status, 403);

    // 訪客（無權杖）也不能讀
    const anon = await fetch(`${base}/api/admin/users`);
    assert.strictEqual(anon.status, 401);

    // ---------- 建立帳號 ----------
    const createUser = await post('/api/admin/users', { username: 'newbie', password: 'abc123', role: 'user' }, asMgr);
    assert.strictEqual(createUser.status, 200, '管理員可以建立普通用戶');
    const createdUser = await createUser.json();
    assert.strictEqual(createdUser.role, 'user');

    const createAdminByMgr = await post('/api/admin/users', { username: 'newadmin', password: 'abc123', role: 'admin' }, asMgr);
    assert.strictEqual(createAdminByMgr.status, 403, '管理員不能建立管理員');
    assert.match((await createAdminByMgr.json()).error, /權限不足/);

    const createAdminByBoss = await post('/api/admin/users', { username: 'newadmin', password: 'abc123', role: 'admin' }, asBoss);
    assert.strictEqual(createAdminByBoss.status, 200, '超級管理員可以建立管理員');

    const createSuperByBoss = await post('/api/admin/users', { username: 'newsuper', password: 'abc123', role: 'super_admin' }, asBoss);
    assert.strictEqual(createSuperByBoss.status, 403, '超級管理員不能建立同級帳號');

    const createSuperByOwner = await post('/api/admin/users', { username: 'newsuper', password: 'abc123', role: 'super_admin' }, asOwner);
    assert.strictEqual(createSuperByOwner.status, 200, '網站擁有者可以建立超級管理員');

    // 格式檢查
    const badName = await post('/api/admin/users', { username: 'ab', password: 'abc123', role: 'user' }, asMgr);
    assert.strictEqual(badName.status, 400);
    const badPass = await post('/api/admin/users', { username: 'okok', password: '123', role: 'user' }, asMgr);
    assert.strictEqual(badPass.status, 400);

    // 預設角色是普通用戶（不是管理員）
    const defaultRole = await post('/api/admin/users', { username: 'defuser', password: 'abc123' }, asMgr);
    assert.strictEqual(defaultRole.status, 200);
    assert.strictEqual((await defaultRole.json()).role, 'user');

    // 重複帳號
    const dup = await post('/api/admin/users', { username: 'kid', password: 'abc123', role: 'user' }, asMgr);
    assert.strictEqual(dup.status, 400);

    // ---------- 角色調整（僅網站擁有者） ----------
    const roleByMgr = await patch('/api/admin/users/4', { role: 'admin' }, asMgr);
    assert.strictEqual(roleByMgr.status, 403);
    assert.match((await roleByMgr.json()).error, /只有網站擁有者/);

    const roleByBoss = await patch('/api/admin/users/4', { role: 'admin' }, asBoss);
    assert.strictEqual(roleByBoss.status, 403, '超級管理員也不能調整角色');

    const roleByOwner = await patch('/api/admin/users/4', { role: 'admin' }, asOwner);
    assert.strictEqual(roleByOwner.status, 200);
    assert.deepStrictEqual((await roleByOwner.json()).changes, ['角色 普通用戶 → 管理員']);

    const selfRole = await patch('/api/admin/users/1', { role: 'user' }, asOwner);
    assert.strictEqual(selfRole.status, 400, '不能修改自己的角色');
    assert.match((await selfRole.json()).error, /自己的角色/);

    const badRole = await patch('/api/admin/users/4', { role: '宇宙皇帝' }, asOwner);
    assert.strictEqual(badRole.status, 400);

    // 角色調整要留下稽核紀錄
    const audit = state.tables.audit_logs;
    // v2.19.0：帳號管理動作改名為 *_USER（*_ADMIN 只留給歷史紀錄）
    assert.ok(audit.some((a) => a.action === 'UPDATE_USER' && /角色/.test(String(a.details))), '角色調整須寫入稽核日誌');

    // ---------- 重設密碼 / 改帳號名 ----------
    const pwByMgrOnBoss = await patch('/api/admin/users/2', { password: 'newpass1' }, asMgr);
    assert.strictEqual(pwByMgrOnBoss.status, 403, '不能重設更高權限帳號的密碼');

    const pwByMgrOnUser = await patch('/api/admin/users/7', { password: 'newpass1' }, asMgr);
    assert.strictEqual(pwByMgrOnUser.status, 200);
    const { verifyPassword } = (await bootAppNote());
    assert.ok(verifyPassword(state.tables.admin_users.find((u) => u.id === 7).password, 'newpass1'), '密碼應已更新為雜湊值');

    const badPw = await patch('/api/admin/users/7', { password: 'x' }, asMgr);
    assert.strictEqual(badPw.status, 400);

    const renameByMgr = await patch('/api/admin/users/7', { username: 'helper2' }, asMgr);
    assert.strictEqual(renameByMgr.status, 200);
    assert.strictEqual(state.tables.admin_users.find((u) => u.id === 7).username, 'helper2');

    const renameDup = await patch('/api/admin/users/7', { username: 'kid' }, asMgr);
    assert.strictEqual(renameDup.status, 400, '帳號名稱不可重複');

    const noChange = await patch('/api/admin/users/7', {}, asMgr);
    assert.strictEqual(noChange.status, 400, '沒有任何變更時應明確回應');

    // ---------- 停用／啟用 ----------
    const deactivateSelf = await patch('/api/admin/users/3', { is_active: false }, asMgr);
    assert.strictEqual(deactivateSelf.status, 400, '不能停用自己');

    const deactivateHigher = await patch('/api/admin/users/2', { is_active: false }, asMgr);
    assert.strictEqual(deactivateHigher.status, 403);

    const deactivate = await patch('/api/admin/users/7', { is_active: false }, asMgr);
    assert.strictEqual(deactivate.status, 200);
    assert.strictEqual(state.tables.admin_users.find((u) => u.id === 7).is_active, false);

    // ---------- 刪除 ----------
    const delSelf = await del('/api/admin/users/3', undefined, asMgr);
    assert.strictEqual(delSelf.status, 400);

    const delHigher = await del('/api/admin/users/2', undefined, asMgr);
    assert.strictEqual(delHigher.status, 403);

    const delLower = await del('/api/admin/users/7', undefined, asMgr);
    assert.strictEqual(delLower.status, 200, '管理員可以刪除普通用戶');

    const delSelfOwner = await del('/api/admin/users/1', undefined, asOwner);
    assert.strictEqual(delSelfOwner.status, 400, '不能刪除目前正在使用的帳號');
    assert.match((await delSelfOwner.json()).error, /目前正在使用的帳號/);

    const delOtherOwner = await del('/api/admin/users/8', undefined, asOwner);
    assert.strictEqual(delOtherOwner.status, 403, '保護機制：網站擁有者帳號不可被刪除');
    assert.match((await delOtherOwner.json()).error, /網站擁有者/);

    const delSuperByOwner = await del('/api/admin/users/2', undefined, asOwner);
    assert.strictEqual(delSuperByOwner.status, 200, '網站擁有者可以刪除超級管理員');

    // ---------- 登入：停用帳號與鎖定 ----------
    const loginDisabled = await post('/api/auth/login', { username: 'ghost', password: 'plain-ghost' });
    assert.strictEqual(loginDisabled.status, 403);
    assert.match((await loginDisabled.json()).error, /已停用/);

    // v2.14.0：單一來源 IP 打錯 5 次不該鎖住別人的帳號（避免用鎖定機制阻斷他人）
    for (let i = 0; i < 5; i += 1) {
        const bad = await post('/api/auth/login', { username: 'locky', password: 'wrong' });
        assert.strictEqual(bad.status, 401);
    }
    const stillOk = await post('/api/auth/login', { username: 'locky', password: 'plain-locky' });
    assert.strictEqual(stillOk.status, 200, '同一 IP 失敗 5 次不應鎖住帳號（原本可以登入的人仍可登入）');

    // 繼續失敗到 IP 門檻（連續 10 次、期間沒有成功登入）→ 該來源 IP 會被擋下
    for (let i = 0; i < 10; i += 1) {
        await post('/api/auth/login', { username: 'locky', password: 'wrong' });
    }
    const ipLocked = await post('/api/auth/login', { username: 'locky', password: 'plain-locky' });
    assert.strictEqual(ipLocked.status, 429, '來源 IP 失敗達 10 次後應被暫時阻擋');
    assert.match((await ipLocked.json()).error, /嘗試次數過多/);

    // 成功登入會清掉該帳號與該 IP 的計數（由伺服器內部 clearLoginFailures 處理）
    const clearLock = app.__test__.clearLoginFailures;
    clearLock('locky', '127.0.0.1');
    const afterClear = await post('/api/auth/login', { username: 'locky', password: 'plain-locky' });
    assert.strictEqual(afterClear.status, 200, '清除計數後應可正常登入');

    // ---------- 錯誤日誌 API ----------
    const logsRes = await fetch(`${base}/api/admin/error-logs`, { headers: asOwner });
    assert.strictEqual(logsRes.status, 200);
    const logs = await logsRes.json();
    assert.ok(logs.logs.length >= 3, `至少要有 3 筆種子日誌，實際 ${logs.logs.length}`);
    // v2.14.0：單一 IP 灌失敗次數記錄為 login_ip_throttled；多來源攻擊同一帳號才記 login_lockout。
    // 兩者都是「鎖定事件」，都必須自動寫入錯誤日誌（v2.12.0 修復的自動寫入）。
    assert.ok(
        logs.logs.some((l) => ['login_ip_throttled', 'login_lockout'].includes(l.error_type)),
        `登入失敗達門檻時應自動寫入錯誤日誌，實際類型：${logs.logs.map((l) => l.error_type).join(', ')}`
    );
    assert.ok(
        logs.logs.some((l) => l.error_type === 'auth_invalid_token'),
        '無效權杖應留下警告級日誌'
    );
    assert.deepStrictEqual(logs.schema, { severity: true, resolved: true });
    assert.strictEqual(logs.logs.find((l) => l.id === 1).severity, 'error');
    assert.strictEqual(typeof logs.logs.find((l) => l.id === 1).resolved, 'boolean');

    // 依等級篩選
    const warnOnly = await (await fetch(`${base}/api/admin/error-logs?severity=warn`, { headers: asOwner })).json();
    assert.ok(warnOnly.logs.length >= 1);
    assert.ok(warnOnly.logs.every((l) => l.severity === 'warn'), '等級篩選只應回傳警告級');

    // 只看未處理
    const unresolvedOnly = await (await fetch(`${base}/api/admin/error-logs?resolved=false`, { headers: asOwner })).json();
    assert.ok(unresolvedOnly.logs.length >= 2);
    assert.ok(unresolvedOnly.logs.every((l) => !l.resolved), '未處理篩選只應回傳未處理');

    // 關鍵字搜尋（含 PostgREST 語法字元的輸入不會造成查詢錯誤）
    const searchRes = await fetch(`${base}/api/admin/error-logs?q=%E6%B8%AC%E8%A9%A6,()*`, { headers: asOwner });
    assert.strictEqual(searchRes.status, 200);

    // 管理員不能讀錯誤日誌（僅超級管理員以上）
    const logsByMgr = await fetch(`${base}/api/admin/error-logs`, { headers: asMgr });
    assert.strictEqual(logsByMgr.status, 403);

    // 標記已處理
    const resolveRes = await patch('/api/admin/error-logs/1', { resolved: true }, asOwner);
    assert.strictEqual(resolveRes.status, 200);
    assert.strictEqual(state.tables.error_logs.find((l) => l.id === 1).resolved, true);

    // 清理舊日誌（只刪除早於 cutoff 的）
    const cleanup = await post('/api/admin/error-logs/cleanup', { days: 30 }, asOwner);
    assert.strictEqual(cleanup.status, 200);
    const cleanupBody = await cleanup.json();
    assert.strictEqual(cleanupBody.removed, 1, '只應刪除 2020 年那筆');
    assert.strictEqual(state.tables.error_logs.some((l) => l.id === 3), false, '舊日誌應被刪除');
    assert.strictEqual(state.tables.error_logs.some((l) => l.id === 1), true, '近期日誌應保留');

    // 日誌系統自我監控端點
    const health = await (await fetch(`${base}/api/admin/error-logs/health`, { headers: asOwner })).json();
    assert.strictEqual(health.supabase_configured, true);
    assert.deepStrictEqual(health.schema, { severity: true, resolved: true });
    assert.strictEqual(health.failure_count, 0);

    // 推播紀錄
    const pushLogs = await fetch(`${base}/api/admin/push-logs`, { headers: asMgr });
    assert.strictEqual(pushLogs.status, 200);
    assert.strictEqual((await pushLogs.json()).logs.length, 1);
});

test('v2.12.0 未執行 migration 時：帳號管理自動降級，舊功能不受影響', async (t) => {
    const state = baseState({
        missingColumns: {
            admin_users: ['is_active', 'last_login_at', 'updated_at'],
            error_logs: ['severity', 'resolved', 'resolved_at', 'resolved_by']
        }
    });
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const asOwner = auth(1, 'owner', 'web_owner');
    const asMgr = auth(3, 'mgr', 'admin');
    const patch = req(base, 'PATCH');

    // 讀取清單仍可用，但標記為 schema 未就緒
    const list = await (await fetch(`${base}/api/admin/users`, { headers: asMgr })).json();
    assert.strictEqual(list.users.length, 8);
    assert.strictEqual(list.schema_ready, false);
    assert.strictEqual(list.users[0].is_active, true, '沒有 is_active 欄位時視為啟用');

    // 建立帳號仍可用（不會帶上不存在的欄位）
    const created = await req(base, 'POST')('/api/admin/users', { username: 'nomig', password: 'abc123', role: 'user' }, asMgr);
    assert.strictEqual(created.status, 200);
    const inserted = state.tables.admin_users.find((u) => u.username === 'nomig');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(inserted, 'is_active'), false, '未執行 migration 時不應寫入不存在的欄位');

    // 停用帳號會被明確拒絕並提示需要 migration（此時 id 4 仍是一般用戶，管理員才動得了）
    const deactivate = await patch('/api/admin/users/4', { is_active: false }, asMgr);
    assert.strictEqual(deactivate.status, 503);
    assert.match((await deactivate.json()).error, /v2\.12\.0 migration/);

    // 角色調整仍可用（不需要新欄位）
    const roleChange = await patch('/api/admin/users/4', { role: 'admin' }, asOwner);
    assert.strictEqual(roleChange.status, 200);

    // 日誌仍可讀，只是沒有等級／處理狀態
    const logs = await (await fetch(`${base}/api/admin/error-logs`, { headers: asOwner })).json();
    assert.strictEqual(logs.schema.resolved, false);
    assert.strictEqual(logs.logs.find((l) => l.id === 1).severity, 'error');

    const resolve = await patch('/api/admin/error-logs/1', { resolved: true }, asOwner);
    assert.strictEqual(resolve.status, 503);
});

// 需要解密碼雜湊時用（server.js 的 verifyPassword）
test('v2.14.0 未處理錯誤提示：登入回應附帶 alerts 與摘要端點', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    const post = req(base, 'POST');
    const asOwner = auth(1, 'owner', 'web_owner');

    // 種子資料：1 筆未處理的 error 級 + 1 筆未處理的 warn 級 + 1 筆已處理
    const ownerLogin = await (await post('/api/auth/login', { username: 'owner', password: 'plain-owner' })).json();
    assert.ok(ownerLogin.alerts, '可看日誌的角色，登入回應應附帶錯誤統計');
    assert.strictEqual(ownerLogin.alerts.unresolved_errors, 1, '未處理的 error 級應為 1 筆');
    assert.strictEqual(ownerLogin.alerts.unresolved_total, 2, '未處理（含警告）應為 2 筆');
    assert.strictEqual(ownerLogin.alerts.may_need_attention, true);
    assert.ok(ownerLogin.alerts.latest_at, '應附上最新一筆時間');

    // 一般管理員看不到錯誤日誌，不該收到會顯示卻點不動的提示
    const mgrLogin = await (await post('/api/auth/login', { username: 'mgr', password: 'plain-mgr' })).json();
    assert.strictEqual(mgrLogin.alerts, null);

    // 摘要端點：未帶權杖 → 401；一般管理員 → 403；擁有者 → 200
    assert.strictEqual((await fetch(`${base}/api/admin/error-logs/summary`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/admin/error-logs/summary`, { headers: auth(3, 'mgr', 'admin') })).status, 403);
    const summary = await (await fetch(`${base}/api/admin/error-logs/summary`, { headers: asOwner })).json();
    assert.strictEqual(summary.success, true);
    assert.strictEqual(summary.unresolved_errors, 1);
    assert.strictEqual(summary.unresolved_total, 2);
    assert.strictEqual(summary.may_need_attention, true);

    // 全部標記為已處理後 → 不再提示
    state.tables.error_logs.forEach((row) => { row.resolved = true; });
    const cleared = await (await fetch(`${base}/api/admin/error-logs/summary`, { headers: asOwner })).json();
    assert.strictEqual(cleared.unresolved_errors, 0);
    assert.strictEqual(cleared.unresolved_total, 0);
    assert.strictEqual(cleared.may_need_attention, false);
});

test('v2.14.0 用戶端請求錯誤不該記成伺服器錯誤（JSON 格式錯誤 / body 過大）', async (t) => {
    const state = baseState();
    const { stub, server, base } = await bootApp(state);
    t.after(() => { server.close(); stub.close(); });

    // 送出壞掉的 JSON（模擬掃描器探測或前端 bug）
    const broken = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username": broken'
    });
    assert.strictEqual(broken.status, 400, '格式錯誤應回 400（而不是 500 伺服器錯誤）');
    const brokenBody = await broken.json();
    assert.match(brokenBody.error, /格式錯誤/);

    // 超過 10mb 的 body → 413
    const huge = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y', pad: 'z'.repeat(11 * 1024 * 1024) })
    });
    assert.strictEqual(huge.status, 413, '超過大小限制應回 413');

    // 等日誌寫入（logErrorToDb 為非阻塞）
    await new Promise((r) => setTimeout(r, 300));
    const written = state.tables.error_logs.map((l) => l.error_type);
    assert.ok(written.includes('malformed_json_body'), `應記錄 malformed_json_body，實際：${written.join(', ')}`);
    assert.ok(written.includes('request_body_too_large'), `應記錄 request_body_too_large，實際：${written.join(', ')}`);
    assert.ok(!written.includes('unhandled_server_error'), '不該再被記成 unhandled_server_error');
    const malformed = state.tables.error_logs.find((l) => l.error_type === 'malformed_json_body');
    assert.strictEqual(malformed.severity, 'warn', '用戶端錯誤應為警告級');
    assert.strictEqual(malformed.path, '/api/auth/login');
});

async function bootAppNote() {
    const app = require(path.join(__dirname, '..', 'server.js'));
    return app.__test__;
}
