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
    LOGIN_IP_MAX_FAILURES,
    LOGIN_ACCOUNT_MAX_FAILURES,
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

test('v2.14.0 登入失敗鎖定：單一 IP 打錯密碼只擋 IP，不鎖他人帳號', () => {
    const user = 'lock-target';
    const ip = '198.51.100.9';
    const t0 = Date.now();
    clearLoginFailures(user, ip);

    assert.strictEqual(loginLockRemaining(user, ip, t0).remaining, 0);

    // 同一個 IP 連續失敗 5 次（舊門檻）還不該鎖帳號——這正是用來避免「用鎖定阻斷他人帳號」
    let last;
    for (let i = 1; i <= LOGIN_MAX_FAILURES; i += 1) {
        last = recordLoginFailure(user, ip, t0 + i);
    }
    assert.strictEqual(last.count, LOGIN_MAX_FAILURES);
    assert.strictEqual(last.distinctIps, 1);
    assert.strictEqual(loginLockRemaining(user, ip, t0 + 10).remaining, 0,
        '單一來源 IP 打錯 5 次不應鎖住帳號');

    // 繼續失敗到 IP 門檻 → 該 IP 被鎖，但帳號仍可由其他 IP 登入
    for (let i = 6; i <= LOGIN_IP_MAX_FAILURES; i += 1) {
        recordLoginFailure(user, ip, t0 + i);
    }
    const ipLock = loginLockRemaining(user, ip, t0 + 20);
    assert.strictEqual(ipLock.scope, 'ip');
    assert.ok(ipLock.remaining > 0, 'IP 達門檻後應被鎖定');
    assert.strictEqual(loginLockRemaining(user, '203.0.113.77', t0 + 20).remaining, 0,
        '其他 IP 不應被這個 IP 的行為連累');

    // 鎖定時間過後自動解除
    assert.strictEqual(loginLockRemaining(user, ip, t0 + 16 * 60 * 1000).remaining, 0);

    // 成功登入會清空該帳號與該 IP 的紀錄
    recordLoginFailure(user, ip, t0 + 20);
    clearLoginFailures(user, ip);
    assert.strictEqual(loginLockRemaining(user, ip, t0 + 21).remaining, 0);
});

test('v2.14.0 登入失敗鎖定：同一帳號被多個 IP 嘗試才算遭到攻擊', () => {
    const user = 'attacked-account';
    const ips = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
    const t0 = Date.now();
    ips.concat([user]).forEach((k) => clearLoginFailures(k));

    // 每個 IP 各失敗 4 次（都未達單一 IP 門檻 10 次），共 12 次、來自 3 個 IP
    let seenIps = 1;
    for (let round = 0; round < 4; round += 1) {
        for (const ip of ips) {
            const r = recordLoginFailure(user, ip, t0 + round * 100 + ips.indexOf(ip));
            seenIps = r.distinctIps;
        }
    }
    assert.strictEqual(seenIps, 3, '應記錄到 3 個不同來源 IP');

    const lock = loginLockRemaining(user, '198.51.100.1', t0 + 1000);
    assert.strictEqual(lock.scope, 'account', '多來源攻擊應鎖定帳號');
    assert.ok(lock.remaining > 0);

    // 清理（避免影響其他測試）
    ips.forEach((ip) => clearLoginFailures(user, ip));
    assert.strictEqual(loginLockRemaining(user, ips[0], t0 + 2000).remaining, 0);
});

test('v2.12.0 無效權杖日誌節流：同一 IP 每分鐘最多一筆', () => {
    const ip = '203.0.113.7';
    const t0 = Date.now();

    assert.strictEqual(shouldLogAuthFailure(ip, t0), true);
    assert.strictEqual(shouldLogAuthFailure(ip, t0 + 1000), false, '同一分鐘內不應重複記錄');
    assert.strictEqual(shouldLogAuthFailure(ip, t0 + 61000), true, '超過一分鐘後可再記錄');
    assert.strictEqual(shouldLogAuthFailure('198.51.100.9', t0), true, '不同 IP 各自計算');
});
