/* v2.19.0：賽事狀態機的純函式測試（`public/js/competition-state.js`，前後端共用）
 *
 * 這支測試是狀態機的規格書：每個狀態、每個邊界（報名開始那一秒、賽事結束那一刻）都在這裡寫清楚。
 * 傳入固定的 `now` → 不會因為測試跑的時間不同而時好時壞。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CM = require(path.join(__dirname, '..', 'public', 'js', 'competition-state.js'));

const at = (s) => new Date(s);   // '2026-09-24T12:00:00' 視為本地時間

// 一場 10/24 開賽、報名開放到 10/20 的賽事
const COMP = {
    date: '2026-10-24',
    time: '09:00',
    end_date: '2026-10-24',
    end_time: '18:00',
    is_registration_open: true,
    registration_end_at: '2026-10-20T23:59:00+08:00',
    max_registrations: 10
};

test('狀態機：八種狀態與標籤', () => {
    assert.strictEqual(CM.evaluate(null, at('2026-09-24T12:00:00')).state, 'missing');
    assert.strictEqual(CM.evaluate({ is_deleted: true, date: '2026-10-24' }, at('2026-09-24T12:00:00')).state, 'deleted');
    assert.strictEqual(CM.evaluate({ is_registration_open: true }, at('2026-09-24T12:00:00')).state, 'unscheduled');
    assert.strictEqual(CM.evaluate(COMP, at('2026-09-24T12:00:00')).state, 'registration_open');
    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T10:00:00')).state, 'ongoing');
    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T18:00:00')).state, 'finished');

    assert.strictEqual(CM.LABELS.registration_open, '報名中');
    assert.strictEqual(CM.LABELS.ongoing, '進行中');
    assert.strictEqual(CM.LABELS.finished, '已結束');
    assert.strictEqual(CM.LABELS.registration_closed, '報名已截止');
    assert.strictEqual(CM.LABELS.registration_upcoming, '尚未開放報名');
});

test('狀態機：報名視窗的邊界（開始前、開始當下、截止當下、截止之後）', () => {
    const comp = Object.assign({}, COMP, {
        registration_start_at: '2026-10-01T09:00:00+08:00',
        registration_end_at: '2026-10-20T23:59:00+08:00'
    });

    // 開始前 → 尚未開放報名（不可報名）
    const before = CM.evaluate(comp, at('2026-10-01T08:59:59'));
    assert.strictEqual(before.state, 'registration_upcoming');
    assert.strictEqual(before.can_register, false);
    assert.match(before.reason, /報名將於 2026-10-01 09:00 開始/);

    // 開始那一秒 → 報名中
    assert.strictEqual(CM.evaluate(comp, at('2026-10-01T09:00:00')).state, 'registration_open');
    assert.strictEqual(CM.evaluate(comp, at('2026-10-01T09:00:00')).can_register, true);

    // 截止那一秒仍可報名（含當下），過後就不可
    assert.strictEqual(CM.evaluate(comp, at('2026-10-20T23:59:00')).can_register, true);
    const after = CM.evaluate(comp, at('2026-10-20T23:59:01'));
    assert.strictEqual(after.state, 'registration_closed');
    assert.strictEqual(after.can_register, false);
    assert.match(after.reason, /報名已於 2026-10-20 截止/);
});

test('狀態機：賽事時間的邊界（開賽那一秒起算進行中、結束時間那一刻起算已結束）', () => {
    // 報名已在 10/20 截止、賽事 10/24 才開始 → 開賽前是「報名已截止」（不是報名中）
    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T08:59:59')).state, 'registration_closed');
    // 沒有報名截止限制時，賽事開始前都還能報名
    const noWindow = Object.assign({}, COMP, { registration_end_at: null });
    assert.strictEqual(CM.evaluate(noWindow, at('2026-10-24T08:59:59')).state, 'registration_open');
    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T09:00:00')).state, 'ongoing');

    const ongoing = CM.evaluate(COMP, at('2026-10-24T12:00:00'));
    assert.strictEqual(ongoing.can_register, false, '賽事開始後不能再報名');
    assert.match(ongoing.reason, /已開始/);

    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T17:59:59')).state, 'ongoing');
    assert.strictEqual(CM.evaluate(COMP, at('2026-10-24T18:00:00')).state, 'finished');
});

test('狀態機：沒有結束時間的單日賽事，當天 23:59 結束（不能拿開始時間當結束）', () => {
    const oneDay = { date: '2026-10-24', time: '09:00', is_registration_open: true };
    assert.strictEqual(CM.evaluate(oneDay, at('2026-10-24T09:01:00')).state, 'ongoing',
        '09:00 開始的賽事在 09:01 應該還在進行中');
    assert.strictEqual(CM.evaluate(oneDay, at('2026-10-24T23:59:59')).state, 'ongoing');
    assert.strictEqual(CM.evaluate(oneDay, at('2026-10-25T00:00:00')).state, 'finished');
});

test('狀態機：手動關閉報名優先於時間判定', () => {
    const closed = Object.assign({}, COMP, { is_registration_open: false });
    const st = CM.evaluate(closed, at('2026-09-24T12:00:00'));
    assert.strictEqual(st.state, 'registration_closed');
    assert.strictEqual(st.can_register, false);
    assert.match(st.reason, /未開放報名/);
});

test('狀態機：名額額滿 → 狀態仍是「報名中」但不可報名，且標示 full', () => {
    const full = CM.evaluate(COMP, at('2026-09-24T12:00:00'), { registeredCount: 10 });
    assert.strictEqual(full.state, 'registration_open');
    assert.strictEqual(full.can_register, false);
    assert.strictEqual(full.full, true);
    assert.match(full.reason, /已達上限（10 人）/);

    const notFull = CM.evaluate(COMP, at('2026-09-24T12:00:00'), { registeredCount: 9 });
    assert.strictEqual(notFull.can_register, true);
    assert.strictEqual(notFull.full, false);

    // 0 = 不限
    const unlimited = CM.evaluate(Object.assign({}, COMP, { max_registrations: 0 }), at('2026-09-24T12:00:00'), { registeredCount: 999 });
    assert.strictEqual(unlimited.can_register, true);
});

test('狀態機：舊欄位 registration_deadline（只有日期）→ 當天 23:59 截止', () => {
    const legacy = { date: '2026-10-24', is_registration_open: true, registration_deadline: '2026-09-23' };
    assert.strictEqual(CM.evaluate(legacy, at('2026-09-23T23:59:00')).can_register, true, '截止日當天仍可報名');
    assert.strictEqual(CM.evaluate(legacy, at('2026-09-24T00:00:01')).state, 'registration_closed');
    // 新的 registration_end_at 優先於舊的
    const both = Object.assign({}, legacy, { registration_end_at: '2026-09-30T12:00:00+08:00' });
    assert.strictEqual(CM.evaluate(both, at('2026-09-24T00:00:01')).state, 'registration_open');
});

test('狀態機：報名是否可以送出的舊介面（registrationState）與狀態一致', () => {
    assert.deepStrictEqual(CM.registrationState(COMP, at('2026-09-24T12:00:00'), 0), { open: true, reason: '' });
    assert.deepStrictEqual(CM.registrationState(null, at('2026-09-24T12:00:00'), 0).open, false);

    const finished = CM.registrationState(COMP, at('2026-10-25T00:00:00'), 0);
    assert.strictEqual(finished.open, false);
    assert.match(finished.reason, /已結束/);

    const ongoing = CM.registrationState(COMP, at('2026-10-24T12:00:00'), 0);
    assert.strictEqual(ongoing.open, false);
    assert.match(ongoing.reason, /已開始/);

    const full = CM.registrationState(COMP, at('2026-09-24T12:00:00'), 5);
    assert.strictEqual(full.open, true, '名額 10 人、已 5 人 → 仍可報名');
});

test('狀態機：時間軸的解析（含時區位移與無法解析的值）', () => {
    const t = CM.timeline(COMP);
    assert.strictEqual(t.start.getHours(), 9);
    assert.strictEqual(t.end.getHours(), 18);
    assert.strictEqual(t.regEnd.getDate(), 20);

    // 帶 +08:00 的時間戳：11:59 UTC = 19:59 台北
    const tz = CM.parseTimestamp('2026-10-20T11:59:00Z');
    assert.strictEqual(tz.getTime(), Date.parse('2026-10-20T11:59:00Z'));

    assert.strictEqual(CM.parseTimestamp('壞掉的值'), null);
    assert.strictEqual(CM.parseTimestamp(''), null);
    assert.strictEqual(CM.parseTimestamp(null), null);
    assert.strictEqual(CM.timeline({}).start, null);
});

test('狀態機：狀態說明文字（detail）要能看出關鍵時間', () => {
    const open = CM.evaluate(COMP, at('2026-09-24T12:00:00'));
    assert.match(open.detail, /報名至 2026-10-20/);

    const finished = CM.evaluate(COMP, at('2026-10-25T00:00:00'));
    assert.match(finished.detail, /2026-10-24 18:00 結束/);

    const unscheduled = CM.evaluate({ is_registration_open: true }, at('2026-09-24T12:00:00'));
    assert.strictEqual(unscheduled.can_register, true);
    assert.match(unscheduled.detail, /日期未定/);
});
