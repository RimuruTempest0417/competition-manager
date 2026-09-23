const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const app = require(path.join(__dirname, '..', 'server.js'));
const {
    registrationState, normalizeTeamFields, hasTeamFieldsContent, shouldIncludeTeamFields,
    isMissingColumnError, isMissingTableError, toDateString,
    hashPassword, verifyPassword, allowRegisterAttempt, USERNAME_RE, PASSWORD_RE
} = app.__test__;

const NOW = new Date(2026, 8, 24, 12, 0, 0);   // 2026-09-24 12:00 本地時間

test('toDateString：本地時區 YYYY-MM-DD', () => {
    assert.strictEqual(toDateString(new Date(2026, 0, 5)), '2026-01-05');
    assert.strictEqual(toDateString(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
    assert.strictEqual(toDateString('壞日期'), '');
});

test('registrationState：未開放／已結束／截止日／額滿', () => {
    const base = { is_registration_open: true, date: '2026-10-01', is_deleted: false };

    assert.deepStrictEqual(registrationState(base, NOW, 0), { open: true, reason: '' });

    assert.strictEqual(registrationState(null, NOW, 0).open, false);
    assert.strictEqual(registrationState({ is_deleted: true, is_registration_open: true }, NOW, 0).open, false);
    assert.match(registrationState(Object.assign({}, base, { is_registration_open: false }), NOW, 0).reason, /未開放報名/);

    // 截止日當天仍可報名，隔天不行
    assert.strictEqual(registrationState(Object.assign({}, base, { registration_deadline: '2026-09-24' }), NOW, 0).open, true);
    const closed = registrationState(Object.assign({}, base, { registration_deadline: '2026-09-23' }), NOW, 0);
    assert.strictEqual(closed.open, false);
    assert.match(closed.reason, /已於 2026-09-23 截止/);

    // 比賽日期在過去 → 已結束
    assert.match(registrationState(Object.assign({}, base, { date: '2026-09-01' }), NOW, 0).reason, /已結束/);

    // 名額上限（0 = 不限）
    assert.strictEqual(registrationState(Object.assign({}, base, { max_registrations: 5 }), NOW, 4).open, true);
    assert.match(registrationState(Object.assign({}, base, { max_registrations: 5 }), NOW, 5).reason, /已達上限/);
    assert.strictEqual(registrationState(Object.assign({}, base, { max_registrations: 0 }), NOW, 100).open, true);
});

test('normalizeTeamFields：整數邊界與日期格式', () => {
    assert.deepStrictEqual(normalizeTeamFields({}), {
        is_team_event: false, team_size: 0, max_registrations: 0, registration_deadline: null
    });

    const filled = normalizeTeamFields({
        is_team_event: true, team_size: '6', max_registrations: '128', registration_deadline: '2026-10-01'
    });
    assert.deepStrictEqual(filled, {
        is_team_event: true, team_size: 6, max_registrations: 128, registration_deadline: '2026-10-01'
    });

    // 負數歸零、超過上限夾住、日期格式錯誤視為 null、日期只取前 10 碼
    const clamped = normalizeTeamFields({
        team_size: '-3', max_registrations: '99999', registration_deadline: '2026/10/01'
    });
    assert.strictEqual(clamped.team_size, 0);
    assert.strictEqual(clamped.max_registrations, 9999);
    assert.strictEqual(clamped.registration_deadline, null);

    assert.strictEqual(normalizeTeamFields({ registration_deadline: '2026-10-01T00:00:00Z' }).registration_deadline, '2026-10-01');
    assert.strictEqual(normalizeTeamFields({ is_team_event: 1 }).is_team_event, true);
});

test('hasTeamFieldsContent / shouldIncludeTeamFields：維持 migration 前的舊行為', () => {
    const empty = normalizeTeamFields({});
    assert.strictEqual(hasTeamFieldsContent(empty), false);
    assert.strictEqual(hasTeamFieldsContent(normalizeTeamFields({ team_size: 3 })), true);

    // 沒有內容且欄位未知（尚未探測）→ 不帶欄位
    assert.strictEqual(shouldIncludeTeamFields(empty, null), false);
    // 沒有內容但已知欄位存在 → 要帶（才能把設定清空）
    assert.strictEqual(shouldIncludeTeamFields(empty, true), true);
    // 有內容 → 一律帶（呼叫端已先確認欄位存在）
    assert.strictEqual(shouldIncludeTeamFields(normalizeTeamFields({ is_team_event: true }), null), true);
});

test('isMissingColumnError / isMissingTableError：認得 migration 未執行的錯誤', () => {
    assert.strictEqual(isMissingColumnError({ code: '42703' }), true);
    assert.strictEqual(isMissingColumnError({ code: 'PGRST204' }), true);
    // 訊息有指出欄位時以欄位為準（可分辨是哪一版 migration 沒跑）
    assert.strictEqual(isMissingColumnError({ message: 'column competitions.category does not exist' }), true);
    assert.strictEqual(isMissingColumnError({ message: 'column competitions.team_size does not exist' }), false, '預設只認 category/tags');
    assert.strictEqual(isMissingColumnError({ message: 'column competitions.team_size does not exist' }, ['is_team_event', 'team_size']), true);
    assert.strictEqual(isMissingColumnError({ message: "Could not find the 'is_team_event' column" }, ['is_team_event', 'team_size']), true);
    assert.strictEqual(isMissingColumnError({ message: "Could not find the 'is_team_event' column" }), false);
    // 沒有訊息（只有錯誤碼）時，任何欄位清單都視為「欄位不存在」
    assert.strictEqual(isMissingColumnError({ code: '42703' }, ['is_team_event']), true);
    assert.strictEqual(isMissingColumnError({ code: '23505' }), false);
    assert.strictEqual(isMissingColumnError(null), false);

    assert.strictEqual(isMissingTableError({ code: '42P01' }), true);
    assert.strictEqual(isMissingTableError({ message: 'relation "public.registrations" does not exist' }), true);
    assert.strictEqual(isMissingTableError({ code: '42703', message: 'column x does not exist' }), false);
});

test('密碼雜湊：scrypt 可驗證、雜訊不同、錯密碼不通過、相容舊明碼', () => {
    const hashed = hashPassword('abc12345');
    assert.match(hashed, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.notStrictEqual(hashPassword('abc12345'), hashed, '每次都應用不同 salt');

    assert.strictEqual(verifyPassword(hashed, 'abc12345'), true);
    assert.strictEqual(verifyPassword(hashed, 'abc1234'), false);
    assert.strictEqual(verifyPassword(hashed, ''), false);

    // 舊資料（明碼）仍可登入，且長度不同不會拋錯
    assert.strictEqual(verifyPassword('oldpass', 'oldpass'), true);
    assert.strictEqual(verifyPassword('oldpass', 'oldpassx'), false);
    assert.strictEqual(verifyPassword('oldpass', ''), false);
    assert.strictEqual(verifyPassword('', ''), false);
    assert.strictEqual(verifyPassword(undefined, 'x'), false);
    assert.strictEqual(verifyPassword('scrypt$壞掉', 'x'), false);
});

test('帳號密碼格式與註冊節流', () => {
    assert.strictEqual(USERNAME_RE.test('player_01'), true);
    assert.strictEqual(USERNAME_RE.test('ab'), false, '太短');
    assert.strictEqual(USERNAME_RE.test('中文帳號'), false);
    assert.strictEqual(USERNAME_RE.test('a'.repeat(21)), false, '太長');

    assert.strictEqual(PASSWORD_RE.test('abcd12'), true);
    assert.strictEqual(PASSWORD_RE.test('abc12'), false, '少於 6 個字元');
    assert.strictEqual(PASSWORD_RE.test('abc 123'), false, '含空白');

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(allowRegisterAttempt('1.2.3.4', now + i, 5, 3600000), true, `第 ${i + 1} 次應允許`);
    }
    assert.strictEqual(allowRegisterAttempt('1.2.3.4', now + 10, 5, 3600000), false, '第 6 次應被擋');
    assert.strictEqual(allowRegisterAttempt('5.6.7.8', now + 10, 5, 3600000), true, '不同 IP 不受影響');
    assert.strictEqual(allowRegisterAttempt('1.2.3.4', now + 3600001, 5, 3600000), true, '超過時間窗後重置');
});
