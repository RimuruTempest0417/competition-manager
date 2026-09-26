/* v2.27.0：工作人員角色與指派規則的規格書（純函式） */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/js/staff');

test('角色固定五種，順序是「裁判→記錄→攝影→醫護→其他」', () => {
    assert.deepStrictEqual(S.STAFF_ROLES.map((r) => r.id), ['referee', 'recorder', 'photographer', 'medical', 'other']);
    assert.deepStrictEqual(S.STAFF_ROLES.map((r) => r.label), ['裁判', '記錄', '攝影', '醫護', '其他']);
    assert.ok(S.STAFF_ROLES.every((r) => r.emoji && r.emoji.length > 0), '每個角色都要有圖示');
    assert.strictEqual(S.DEFAULT_ROLE, 'other');
    assert.strictEqual(S.NOTE_MAX, 200);
});

test('角色驗證與正規化：無效角色一律落在預設角色', () => {
    assert.strictEqual(S.isValidRole('referee'), true);
    assert.strictEqual(S.isValidRole('photographer'), true);
    assert.strictEqual(S.isValidRole('評審'), false);
    assert.strictEqual(S.isValidRole(''), false);
    assert.strictEqual(S.normalizeRole('recorder'), 'recorder');
    assert.strictEqual(S.normalizeRole('評審'), 'other');
    assert.strictEqual(S.normalizeRole(undefined), 'other');
    assert.strictEqual(S.roleLabel('medical'), '醫護');
    assert.strictEqual(S.roleLabel('評審'), '評審', '不認識的角色照原字串顯示，不要顯示空白');
    assert.strictEqual(S.roleEmoji('referee'), '⚖️');
});

test('指派輸入：正常情況', () => {
    const result = S.normalizeStaffInput({ user_id: 91, role: 'referee', note: '  第三場地  ' });
    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.value, { user_id: 91, role: 'referee', note: '第三場地' });
});

test('指派輸入：沒帶角色 → 預設角色；沒帶備註 → null', () => {
    const a = S.normalizeStaffInput({ user_id: 7 });
    assert.strictEqual(a.value.role, 'other');
    assert.strictEqual(a.value.note, null);
    const b = S.normalizeStaffInput({ user_id: 7, role: '', note: '   ' });
    assert.strictEqual(b.value.role, 'other');
    assert.strictEqual(b.value.note, null);
});

test('指派輸入：字串數字（表單下拉最常送出的樣子）要接受', () => {
    const result = S.normalizeStaffInput({ user_id: '91', role: 'recorder' });
    assert.strictEqual(result.value.user_id, 91);
});

test('指派輸入：帳號編號不對要擋下', () => {
    ['沒有', 0, -3, 1.5, '', null, undefined].forEach((bad) => {
        const result = S.normalizeStaffInput({ user_id: bad });
        assert.ok(result.error, `user_id=${JSON.stringify(bad)} 應該被擋`);
        assert.match(result.error, /帳號編號不對/);
    });
});

test('指派輸入：不認識的角色要擋下並列出可用的角色', () => {
    const result = S.normalizeStaffInput({ user_id: 91, role: '評審' });
    assert.ok(result.error);
    assert.match(result.error, /角色不對/);
    assert.match(result.error, /referee（裁判）/);
});

test('指派輸入：備註上限 200 字（含訊息內寫出目前字數）', () => {
    assert.strictEqual(S.normalizeStaffInput({ user_id: 1, note: '甲'.repeat(200) }).error, undefined);
    const tooLong = S.normalizeStaffInput({ user_id: 1, note: '甲'.repeat(201) });
    assert.match(tooLong.error, /備註最多 200 字（目前 201 字）/);
});

test('統計：空清單回 0，且每種角色都在', () => {
    const summary = S.staffSummary([]);
    assert.strictEqual(summary.total, 0);
    assert.deepStrictEqual(summary.roles.map((r) => r.count), [0, 0, 0, 0, 0]);
    assert.strictEqual(summary.roles.length, 5);
});

test('統計：各角色人數與總數（不認識的角色算進「其他」）', () => {
    const summary = S.staffSummary([
        { role: 'referee' }, { role: 'referee' }, { role: 'photographer' }, { role: '評審' }
    ]);
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.by_role.referee, 2);
    assert.strictEqual(summary.by_role.photographer, 1);
    assert.strictEqual(summary.by_role.other, 1, '不認識的角色歸到「其他」，不要消失');
    assert.strictEqual(S.staffSummary(null).total, 0);
});

test('排序：先依角色順序，再依帳號名稱；不改動原陣列', () => {
    const rows = [
        { id: 3, role: 'other', username: 'zoe' },
        { id: 2, role: 'referee', username: 'bo' },
        { id: 1, role: 'referee', username: 'ann' },
        { id: 4, role: 'photographer', username: 'cam' }
    ];
    const sorted = S.staffSort(rows);
    assert.deepStrictEqual(sorted.map((r) => r.username), ['ann', 'bo', 'cam', 'zoe']);
    assert.strictEqual(rows[0].username, 'zoe', '原陣列順序不该被改動');
});

test('排序：同名時用 id 決定，結果固定', () => {
    const sorted = S.staffSort([{ id: 9, role: 'referee', username: 'sam' }, { id: 2, role: 'referee', username: 'sam' }]);
    assert.deepStrictEqual(sorted.map((r) => r.id), [2, 9]);
});

test('一行顯示文字：含角色、名稱與備註；沒有名稱時用帳號編號', () => {
    assert.strictEqual(S.staffLine({ role: 'referee', username: 'ann', note: '第三場地' }), '⚖️ 裁判 ann（第三場地）');
    assert.strictEqual(S.staffLine({ role: 'photographer', username: 'cam' }), '📷 攝影 cam');
    assert.strictEqual(S.staffLine({ role: 'referee', user_id: 55 }), '⚖️ 裁判 帳號 #55');
    assert.strictEqual(S.staffLine({}), '🙋 其他 帳號 #undefined');
});
