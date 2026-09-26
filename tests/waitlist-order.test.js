/* v2.21.0：候補順位（手動調整）與指定遞補的規則規格書
 *
 * 這些規則是前後端共用的（public/js/competition-state.js），所以用純函式測試就等於
 * 同時驗證「介面顯示的順位」與「後端遞補的人」是同一套答案。
 * 一律傳入明確資料（不依賴當下時間），測試不會時好時壞。
 */
const test = require('node:test');
const assert = require('node:assert');
const CS = require('../public/js/competition-state.js');

let seq = 0;
const row = (id, status, createdAt, order) => ({
    id,
    status,
    created_at: createdAt || `2026-09-01T0${(seq = (seq % 8) + 1)}:00:00Z`,
    waitlist_order: order === undefined ? null : order,
    is_deleted: false
});

const users = (rows) => rows.map((r) => r.id);

test('候補順位：沒有手動排過時，先報名先排', () => {
    const rows = [
        row(3, 'waitlisted', '2026-09-01T03:00:00Z'),
        row(1, 'waitlisted', '2026-09-01T01:00:00Z'),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z')
    ];
    assert.deepStrictEqual(users(CS.waitlistQueue(rows)), [1, 2, 3]);
});

test('候補順位：手動排定的數字優先於報名時間', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z', 3),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z', 1),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z', 2)
    ];
    assert.deepStrictEqual(users(CS.waitlistQueue(rows)), [2, 3, 1]);
});

test('候補順位：只有部分人排過時，排過的在前面、其他人照報名時間', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z', null),   // 最早報名，但沒被排過
        row(2, 'waitlisted', '2026-09-01T05:00:00Z', 1),      // 管理員排到第一位
        row(3, 'waitlisted', '2026-09-01T02:00:00Z', null)
    ];
    assert.deepStrictEqual(users(CS.waitlistQueue(rows)), [2, 1, 3]);
});

test('候補順位：0／負數／非數字一律視為「沒排過」（不會插到最前面）', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z', 0),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z', -5),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z', 'abc'),
        row(4, 'waitlisted', '2026-09-01T04:00:00Z', 2)
    ];
    assert.deepStrictEqual(users(CS.waitlistQueue(rows)), [4, 1, 2, 3]);
});

test('候補順位：只有候補的人算在名單裡（已核准／待審核／未錄取都不算）', () => {
    const rows = [
        row(1, 'confirmed', '2026-09-01T01:00:00Z', 1),
        row(2, 'pending', '2026-09-01T02:00:00Z', 2),
        row(3, 'rejected', '2026-09-01T03:00:00Z', 3),
        row(4, 'waitlisted', '2026-09-01T04:00:00Z', null)
    ];
    assert.deepStrictEqual(users(CS.waitlistQueue(rows)), [4]);
    assert.strictEqual(CS.waitlistPosition(rows, 1), null);
    assert.strictEqual(CS.waitlistPosition(rows, 4), 1);
});

test('候補順位：waitlistPosition 算的是「畫面顯示的第幾位」', () => {
    const rows = [
        row(10, 'waitlisted', '2026-09-01T01:00:00Z', 2),
        row(11, 'waitlisted', '2026-09-01T02:00:00Z', 1),
        row(12, 'waitlisted', '2026-09-01T03:00:00Z', 3)
    ];
    assert.strictEqual(CS.waitlistPosition(rows, 11), 1);
    assert.strictEqual(CS.waitlistPosition(rows, 10), 2);
    assert.strictEqual(CS.waitlistPosition(rows, 12), 3);
    assert.strictEqual(CS.waitlistPosition(rows, 999), null);
});

test('調整順位：給完整順序就回每個人該寫入的 waitlist_order（1 開始）', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z'),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z'),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z')
    ];
    const plan = CS.planWaitlistOrder(rows, [3, 1, 2]);
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(plan.updates, [
        { id: '3', waitlist_order: 1 },
        { id: '1', waitlist_order: 2 },
        { id: '2', waitlist_order: 3 }
    ]);
});

test('調整順位：漏掉名單裡的人就整批拒絕（不寫半套結果）', () => {
    const rows = [row(1, 'waitlisted'), row(2, 'waitlisted'), row(3, 'waitlisted')];
    const plan = CS.planWaitlistOrder(rows, [3, 1]);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /漏掉 1 筆/);
    assert.deepStrictEqual(plan.updates, []);
});

test('調整順位：夾帶不在候補名單裡的 id 也整批拒絕', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z'),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z'),
        row(9, 'confirmed', '2026-09-01T03:00:00Z')   // 已核准的人
    ];
    const plan = CS.planWaitlistOrder(rows, [2, 1, 9]);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /不在候補名單/);
});

test('調整順位：重複的 id 也整批拒絕', () => {
    const rows = [row(1, 'waitlisted'), row(2, 'waitlisted')];
    const plan = CS.planWaitlistOrder(rows, [1, 1]);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /重複/);
});

test('指定遞補：名額還有就照賽事設定（不需審核→已核准、需審核→待審核）', () => {
    const rows = [
        row(1, 'confirmed', '2026-09-01T01:00:00Z'),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z'),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z')
    ];
    const plain = CS.planPromotion({ max_registrations: 3 }, rows, 3);
    assert.strictEqual(plain.ok, true);
    assert.strictEqual(plain.status, 'confirmed');
    assert.strictEqual(plain.position, 2);

    const reviewed = CS.planPromotion({ max_registrations: 3, requires_approval: true }, rows, 3);
    assert.strictEqual(reviewed.ok, true);
    assert.strictEqual(reviewed.status, 'pending');
});

test('指定遞補：名額已滿時拒絕（不能靠指定遞補超收）', () => {
    const rows = [
        row(1, 'confirmed', '2026-09-01T01:00:00Z'),
        row(2, 'pending', '2026-09-01T02:00:00Z'),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z')
    ];
    const plan = CS.planPromotion({ max_registrations: 2 }, rows, 3);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /名額已滿（2 人）/);
    assert.strictEqual(plan.status, null);
});

test('指定遞補：不在候補名單裡的人不能遞補（已核准、未錄取、不存在都一樣）', () => {
    const rows = [
        row(1, 'confirmed', '2026-09-01T01:00:00Z'),
        row(2, 'rejected', '2026-09-01T02:00:00Z'),
        row(3, 'waitlisted', '2026-09-01T03:00:00Z')
    ];
    for (const id of [1, 2, 999]) {
        const plan = CS.planPromotion({ max_registrations: 5 }, rows, id);
        assert.strictEqual(plan.ok, false, `id=${id} 應該被拒絕`);
        assert.match(plan.reason, /不在候補名單/);
    }
});

test('指定遞補：不限名額（max=0）也可以遞補', () => {
    const rows = [row(1, 'confirmed', '2026-09-01T01:00:00Z'), row(2, 'waitlisted', '2026-09-01T02:00:00Z')];
    const plan = CS.planPromotion({ max_registrations: 0 }, rows, 2);
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.status, 'confirmed');
});

test('指定遞補：手動排定的順位會反映在「原第幾順位」', () => {
    const rows = [
        row(1, 'waitlisted', '2026-09-01T01:00:00Z', 2),
        row(2, 'waitlisted', '2026-09-01T02:00:00Z', 1)
    ];
    const plan = CS.planPromotion({ max_registrations: 5 }, rows, 1);
    assert.strictEqual(plan.position, 2);   // 被管理員排到第二位
});

/* ── v2.22.0：一次搬動到指定位置（拖拉排序與「移到第 N 位」共用） ── */

test('搬到指定位置：往後搬（把第一位搬到第三位）', () => {
    assert.deepStrictEqual(CS.moveInQueue([1, 2, 3, 4], 1, 2), ['2', '3', '1', '4']);
});

test('搬到指定位置：往前搬（把最後一位搬到第一位）', () => {
    assert.deepStrictEqual(CS.moveInQueue([1, 2, 3, 4], 4, 0), ['4', '1', '2', '3']);
});

test('搬到指定位置：搬到原本的位置＝完全不動', () => {
    assert.deepStrictEqual(CS.moveInQueue([1, 2, 3], 2, 1), ['1', '2', '3']);
});

test('搬到指定位置：超出範圍會夾到頭或尾（不會產生空位）', () => {
    assert.deepStrictEqual(CS.moveInQueue([1, 2, 3], 3, 99), ['1', '2', '3']);
    assert.deepStrictEqual(CS.moveInQueue([1, 2, 3], 1, -5), ['1', '2', '3']);
    assert.deepStrictEqual(CS.moveInQueue(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
});

test('搬到指定位置：找不到這個 id 就回 null（呼叫端不送 API）', () => {
    assert.strictEqual(CS.moveInQueue([1, 2, 3], 99, 1), null);
    assert.strictEqual(CS.moveInQueue([], 1, 0), null);
});

test('搬到指定位置：回傳的一定是同一批人（不會多也不會少）', () => {
    const next = CS.moveInQueue([7, 8, 9, 10], 9, 0);
    assert.strictEqual(next.length, 4);
    assert.deepStrictEqual(next.slice().sort(), ['10', '7', '8', '9']);
});

test('搬到指定位置：拖到某列上面＝插到那一列的位置（前端 elementFromPoint 的用法）', () => {
    // 前端拖曳時是「把被拖的那列插到指標下那列之前／之後」，這裡驗證索引換算的結果一致
    const ids = [11, 12, 13, 14];
    assert.deepStrictEqual(CS.moveInQueue(ids, 14, ids.indexOf(11)), ['14', '11', '12', '13']);
    assert.deepStrictEqual(CS.moveInQueue(ids, 11, ids.indexOf(13)), ['12', '13', '11', '14']);
});

/* ── v2.23.0：多選一次搬多筆（moveGroup） ── */

test('批次搬移：把挑選的幾筆一起搬到最前面（保持原本相對順序）', () => {
    // 挑第 3、4 位搬到最前面 → 這兩筆的相對順序不變，其他人往後推
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4, 5], [4, 3], 1), ['3', '4', '1', '2', '5']);
});

test('批次搬移：搬到中間（第 3 位＝這批人的第一位排在第 3 位）', () => {
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4, 5], [5, 1], 3), ['2', '3', '1', '5', '4']);
});

test('批次搬移：目標位置超出範圍會夾到頭或尾', () => {
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4], [3, 4], 99), ['1', '2', '3', '4']);
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4], [3, 4], -5), ['3', '4', '1', '2']);
});

test('批次搬移：挑選的順序不影響結果（一律照名單原本的相對順序）', () => {
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4], [4, 2], 1), CS.moveGroup([1, 2, 3, 4], [2, 4], 1));
});

test('批次搬移：有 id 不在名單裡或沒挑到人就回 null（呼叫端不送 API）', () => {
    assert.strictEqual(CS.moveGroup([1, 2, 3], [2, 99], 1), null);
    assert.strictEqual(CS.moveGroup([1, 2, 3], [], 1), null);
    assert.strictEqual(CS.moveGroup([], [1], 1), null);
});

test('批次搬移：全部挑選＝完全不動；回傳一定還是同一批人', () => {
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3], [1, 2, 3], 2), ['1', '2', '3']);
    const next = CS.moveGroup([7, 8, 9, 10], [10, 7], 2);
    assert.strictEqual(next.length, 4);
    assert.deepStrictEqual(next.slice().sort(), ['10', '7', '8', '9']);
});

test('批次搬移：重複挑同一筆只算一次', () => {
    assert.deepStrictEqual(CS.moveGroup([1, 2, 3, 4], [4, 4, 4], 1), ['4', '1', '2', '3']);
});
