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
    const { stub, server, base } = await bootApp(state);
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
    assert.ok(audit.some((a) => a.action === 'UPDATE_ADMIN' && /角色/.test(String(a.details))), '角色調整須寫入稽核日誌');

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

    for (let i = 0; i < 5; i += 1) {
        const bad = await post('/api/auth/login', { username: 'locky', password: 'wrong' });
        assert.strictEqual(bad.status, 401);
    }
    const locked = await post('/api/auth/login', { username: 'locky', password: 'plain-locky' });
    assert.strictEqual(locked.status, 429, '連續失敗 5 次後應暫時鎖定（即使密碼正確）');
    assert.match((await locked.json()).error, /分鐘後再試/);

    // ---------- 錯誤日誌 API ----------
    const logsRes = await fetch(`${base}/api/admin/error-logs`, { headers: asOwner });
    assert.strictEqual(logsRes.status, 200);
    const logs = await logsRes.json();
    assert.ok(logs.logs.length >= 3, `至少要有 3 筆種子日誌，實際 ${logs.logs.length}`);
    assert.ok(
        logs.logs.some((l) => l.error_type === 'login_lockout'),
        '登入連續失敗鎖定時應自動寫入錯誤日誌（v2.12.0 修復的自動寫入）'
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
async function bootAppNote() {
    const app = require(path.join(__dirname, '..', 'server.js'));
    return app.__test__;
}
