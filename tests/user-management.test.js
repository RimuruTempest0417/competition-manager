/* v2.12.0：角色階梯、帳號管理與錯誤日誌的單元測試（不碰資料庫） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const app = require(path.join(__dirname, '..', 'server.js'));
const {
    ROLE_LEVELS,
    MANAGED_ROLES,
    roleLevel,
    canCreateRole,
    canManageUser,
    assertRoleAssignable,
    loginLockRemaining,
    recordLoginFailure,
    clearLoginFailures,
    shouldLogAuthFailure,
    LOGIN_MAX_FAILURES
} = app.__test__;

test('v2.12.0 角色階梯：等級與角色清單一致', () => {
    assert.strictEqual(roleLevel('user'), 1);
    assert.strictEqual(roleLevel('test'), 1);
    assert.strictEqual(roleLevel('admin'), 2);
    assert.strictEqual(roleLevel('super_admin'), 3);
    assert.strictEqual(roleLevel('web_owner'), 4);
    assert.strictEqual(roleLevel('不存在的角色'), 0);
    assert.deepStrictEqual(MANAGED_ROLES, ['user', 'test', 'admin', 'super_admin', 'web_owner']);
    assert.strictEqual(Object.keys(ROLE_LEVELS).length, 5);
});

test('v2.12.0 可建立的角色：管理員只能建立普通用戶／測試帳號', () => {
    // 管理員（等級 2）→ 只能建立等級 1
    assert.strictEqual(canCreateRole('admin', 'user'), true);
    assert.strictEqual(canCreateRole('admin', 'test'), true);
    assert.strictEqual(canCreateRole('admin', 'admin'), false);
    assert.strictEqual(canCreateRole('admin', 'super_admin'), false);
    assert.strictEqual(canCreateRole('admin', 'web_owner'), false);

    // 超級管理員（等級 3）→ 可再建立管理員
    assert.strictEqual(canCreateRole('super_admin', 'user'), true);
    assert.strictEqual(canCreateRole('super_admin', 'admin'), true);
    assert.strictEqual(canCreateRole('super_admin', 'super_admin'), false);
    assert.strictEqual(canCreateRole('super_admin', 'web_owner'), false);

    // 網站擁有者（等級 4）→ 可建立任何角色（含共同擁有者）
    assert.strictEqual(canCreateRole('web_owner', 'admin'), true);
    assert.strictEqual(canCreateRole('web_owner', 'super_admin'), true);
    assert.strictEqual(canCreateRole('web_owner', 'web_owner'), true);

    // 普通用戶與訪客都不能建立任何帳號
    assert.strictEqual(canCreateRole('user', 'user'), false);
    assert.strictEqual(canCreateRole('test', 'user'), false);
    assert.strictEqual(canCreateRole('guest', 'user'), false);
    assert.strictEqual(canCreateRole('admin', 'unknown_role'), false);
});

test('v2.12.0 可管理的對象：必須嚴格低於自己且不能是自己', () => {
    const actor = { id: 10, role: 'admin' };

    assert.strictEqual(canManageUser(actor, { id: 4, role: 'user' }), true);
    assert.strictEqual(canManageUser(actor, { id: 5, role: 'test' }), true);
    assert.strictEqual(canManageUser(actor, { id: 6, role: 'admin' }), false);
    assert.strictEqual(canManageUser(actor, { id: 7, role: 'super_admin' }), false);
    assert.strictEqual(canManageUser(actor, { id: 8, role: 'web_owner' }), false);
    assert.strictEqual(canManageUser(actor, { id: 10, role: 'user' }), false, '不能管理自己（即使角色較低）');
    assert.strictEqual(canManageUser(null, { id: 4, role: 'user' }), false);
    assert.strictEqual(canManageUser(actor, null), false);
});

test('v2.12.0 角色指派訊息：被拒絕時給出可理解的說明', () => {
    assert.strictEqual(assertRoleAssignable('admin', 'user'), null);
    assert.strictEqual(assertRoleAssignable('web_owner', 'super_admin'), null);

    const err1 = assertRoleAssignable('admin', 'admin');
    assert.match(err1, /權限不足/);
    assert.match(err1, /管理員/);

    assert.match(assertRoleAssignable('admin', '不存在'), /未知的角色/);
});

test('v2.12.0 登入失敗鎖定：達門檻後鎖定，成功登入或逾時後解除', () => {
    const user = 'lock-target';
    const t0 = Date.now();
    clearLoginFailures(user);

    assert.strictEqual(loginLockRemaining(user, t0), 0);

    for (let i = 1; i <= LOGIN_MAX_FAILURES; i += 1) {
        assert.strictEqual(recordLoginFailure(user, t0 + i), i);
    }
    assert.ok(loginLockRemaining(user, t0 + 10) > 0, '連續失敗達門檻後應處於鎖定狀態');

    // 鎖定時間過後自動解除
    assert.strictEqual(loginLockRemaining(user, t0 + 16 * 60 * 1000), 0);

    // 成功登入會清空紀錄
    recordLoginFailure(user, t0 + 20);
    clearLoginFailures(user);
    assert.strictEqual(loginLockRemaining(user, t0 + 21), 0);
});

test('v2.12.0 無效權杖日誌節流：同一 IP 每分鐘最多一筆', () => {
    const ip = '203.0.113.7';
    const t0 = Date.now();

    assert.strictEqual(shouldLogAuthFailure(ip, t0), true);
    assert.strictEqual(shouldLogAuthFailure(ip, t0 + 1000), false, '同一分鐘內不應重複記錄');
    assert.strictEqual(shouldLogAuthFailure(ip, t0 + 61000), true, '超過一分鐘後可再記錄');
    assert.strictEqual(shouldLogAuthFailure('198.51.100.9', t0), true, '不同 IP 各自計算');
});
