/* v2.20.0：報名審核與候補的規則測試（`public/js/competition-state.js`，前後端共用）
 *
 * 規則只有一條要記牢：**佔名額 = 已核准（confirmed）＋ 待審核（pending）**，候補不佔名額。
 * 這份測試就是那條規則的規格書，前後端都照它跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CM = require(path.join(__dirname, '..', 'public', 'js', 'competition-state.js'));

const at = (s) => new Date(s);

test('v2.20.0：狀態統計——候補與未錄取都不佔名額，已刪除的不算', () => {
    const rows = [
        { id: 1, status: 'confirmed' },
        { id: 2, status: 'pending' },
        { id: 3, status: 'waitlisted' },
        { id: 4, status: 'waitlisted' },
        { id: 5, status: 'rejected' },
        { id: 6, status: 'confirmed', is_deleted: true }
    ];
    const c = CM.countByStatus(rows);
    assert.strictEqual(c.confirmed, 1);
    assert.strictEqual(c.pending, 1);
    assert.strictEqual(c.waitlisted, 2);
    assert.strictEqual(c.rejected, 1);
    assert.strictEqual(c.slots, 2, '佔名額只有已核准＋待審核');
    assert.strictEqual(c.total, 5, '已刪除的不算');

    assert.strictEqual(CM.normalizeRegStatus(undefined), 'confirmed', 'v2.9.0 的舊資料沒有狀態 → 視為已核准');
    assert.strictEqual(CM.normalizeRegStatus('PENDING'), 'pending', '大小寫不拘');
    assert.strictEqual(CM.normalizeRegStatus('亂七八糟'), 'confirmed', '未知值不可讓報名消失');
});

test('v2.20.0：不需審核、有名額 → 直接核准', () => {
    const comp = { max_registrations: 3 };
    assert.deepStrictEqual(CM.decideRegistration(comp, { slots: 2, waitlisted: 0 }).status, 'confirmed');
});

test('v2.20.0：需審核 → 待審核（不管名額夠不夠）', () => {
    const comp = { max_registrations: 3, requires_approval: true };
    const d = CM.decideRegistration(comp, { slots: 0, waitlisted: 0 });
    assert.strictEqual(d.status, 'pending');
    assert.strictEqual(d.waitlist_position, null);
});

test('v2.20.0：名額已滿且沒開候補 → 不收這筆報名（附原因）', () => {
    const comp = { max_registrations: 2 };
    const d = CM.decideRegistration(comp, { slots: 2, waitlisted: 0 });
    assert.strictEqual(d.status, null);
    assert.match(d.reason, /已達上限（2 人）/);

    const approvalComp = { max_registrations: 2, requires_approval: true };
    assert.match(CM.decideRegistration(approvalComp, { slots: 2, waitlisted: 0 }).reason, /未開放候補/);
});

test('v2.20.0：名額已滿但開放候補 → 排候補（順位＝現有候補數＋1）', () => {
    const comp = { max_registrations: 2, waitlist_enabled: true };
    const d = CM.decideRegistration(comp, { slots: 2, waitlisted: 0 });
    assert.strictEqual(d.status, 'waitlisted');
    assert.strictEqual(d.waitlist_position, 1);

    const d2 = CM.decideRegistration(comp, { slots: 2, waitlisted: 4 });
    assert.strictEqual(d2.waitlist_position, 5, '前面還有 4 人候補 → 第 5 位');
});

test('v2.20.0：max_registrations = 0 → 不限名額，永遠不會候補', () => {
    const comp = { max_registrations: 0, waitlist_enabled: true };
    assert.strictEqual(CM.decideRegistration(comp, { slots: 999, waitlisted: 0 }).status, 'confirmed');
});

test('v2.20.0：候補順位是「先報名先排」（created_at，其次 id）', () => {
    const rows = [
        { id: 9, status: 'waitlisted', created_at: '2026-09-25T10:00:00Z' },
        { id: 3, status: 'waitlisted', created_at: '2026-09-25T09:00:00Z' },
        { id: 7, status: 'confirmed', created_at: '2026-09-25T08:00:00Z' },
        { id: 5, status: 'waitlisted', created_at: '2026-09-25T09:00:00Z' },   // 同時間 → 比 id
        { id: 6, status: 'waitlisted', created_at: '2026-09-25T11:00:00Z', is_deleted: true }
    ];
    const queue = CM.waitlistQueue(rows);
    assert.deepStrictEqual(queue.map((r) => r.id), [3, 5, 9], '已刪除的不在候補隊伍裡');
    assert.strictEqual(CM.nextWaitlist(rows).id, 3, '遞補第一位');
    assert.strictEqual(CM.nextWaitlist(rows, 3).id, 5, '可以排除剛取消的那筆');
    assert.strictEqual(CM.nextWaitlist([{ id: 1, status: 'confirmed' }]), null, '沒有候補就回 null');
});

test('v2.20.0：遞補後要變成「已核准」還是「待審核」——看這賽事需不需要審核', () => {
    assert.strictEqual(CM.promotionStatus({}), 'confirmed');
    assert.strictEqual(CM.promotionStatus({ requires_approval: true }), 'pending', '需審核的賽事遞補進來仍要審核');
});

test('v2.20.0：額滿＋開放候補時，狀態機仍然讓報名送得出去（並說明會排第幾位）', () => {
    const comp = {
        date: '2026-11-01', time: '09:00', is_registration_open: true,
        max_registrations: 2, waitlist_enabled: true
    };
    const st = CM.evaluate(comp, at('2026-10-01T12:00:00'), { registeredCount: 2, waitlistCount: 1 });
    assert.strictEqual(st.state, 'registration_open');
    assert.strictEqual(st.can_register, true, '有候補 → 不是「不能報名」');
    assert.strictEqual(st.full, true);
    assert.strictEqual(st.waitlist, true);
    assert.strictEqual(st.waitlist_position, 2);
    assert.match(st.reason, /報名將排入候補（第 2 位）/);

    // 沒開候補 → 維持舊行為（擋下來並說明）
    const noWait = CM.evaluate(Object.assign({}, comp, { waitlist_enabled: false }), at('2026-10-01T12:00:00'), { registeredCount: 2 });
    assert.strictEqual(noWait.can_register, false);
    assert.match(noWait.reason, /已達上限/);
});

test('v2.20.0：需審核的賽事，狀態機要告訴前端「送出後還要審核」', () => {
    const comp = { date: '2026-11-01', time: '09:00', is_registration_open: true, requires_approval: true };
    const st = CM.evaluate(comp, at('2026-10-01T12:00:00'), { registeredCount: 0 });
    assert.strictEqual(st.can_register, true);
    assert.strictEqual(st.needs_approval, true);
    assert.strictEqual(CM.evaluate({ date: '2026-11-01', is_registration_open: true }, at('2026-10-01T12:00:00'), {}).needs_approval, false);
});

test('v2.20.0：日期未定的賽事一樣適用審核與候補規則', () => {
    const comp = { is_registration_open: true, max_registrations: 1, waitlist_enabled: true };
    const st = CM.evaluate(comp, at('2026-10-01T12:00:00'), { registeredCount: 1, waitlistCount: 0 });
    assert.strictEqual(st.can_register, true);
    assert.strictEqual(st.waitlist, true);
    assert.strictEqual(st.state, 'unscheduled');
});
