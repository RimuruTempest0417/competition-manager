/* v3.0.0 分頁規則（public/js/paging.js）規格書 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const CM = require(path.join(__dirname, '..', 'public', 'js', 'paging.js'));

test('沒有帶 limit＝不分頁（既有請求行為不變）', () => {
    assert.strictEqual(CM.parsePaging({}).paged, false);
    assert.strictEqual(CM.parsePaging({}).limit, null);
    assert.strictEqual(CM.parsePaging({ offset: '20' }).paged, false, '只帶 offset 不算分頁');
    assert.strictEqual(CM.parsePaging({ limit: '' }).paged, false, '空字串視為沒帶');
    assert.strictEqual(CM.parsePaging(undefined).paged, false, 'query 不存在也不能爆');
});

test('帶 limit＝分頁，offset 預設 0', () => {
    const p = CM.parsePaging({ limit: '10' });
    assert.deepStrictEqual(p, { paged: true, limit: 10, offset: 0, capped: false });
    assert.strictEqual(CM.parsePaging({ limit: '10', offset: '30' }).offset, 30);
});

test('壞參數退回安全值，不報錯（列表端點回 400 會讓外部整合更難用）', () => {
    assert.strictEqual(CM.parsePaging({ limit: 'abc' }).limit, CM.DEFAULT_MAX);
    assert.strictEqual(CM.parsePaging({ limit: '-5' }).limit, 1, '負數或 0 收斂到 1');
    assert.strictEqual(CM.parsePaging({ limit: '0' }).limit, 1);
    assert.strictEqual(CM.parsePaging({ limit: '10', offset: '-3' }).offset, 0);
    assert.strictEqual(CM.parsePaging({ limit: '10', offset: 'xyz' }).offset, 0);
    assert.strictEqual(CM.parsePaging({ limit: '10.7' }).limit, 10, '小數取整數');
});

test('單次上限：超過會被截掉並標示 capped', () => {
    const p = CM.parsePaging({ limit: '99999' });
    assert.strictEqual(p.limit, CM.DEFAULT_MAX);
    assert.strictEqual(p.capped, true);
    assert.strictEqual(CM.parsePaging({ limit: '50' }).capped, false);
    assert.strictEqual(CM.parsePaging({ limit: '99999' }, { max: 500 }).limit, 500, '上限可以調整');
});

test('記憶體切片：邊界正確、不亂改原陣列', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    assert.deepStrictEqual(CM.pageSlice(items, CM.parsePaging({})), items, '不分頁＝全部');
    assert.deepStrictEqual(CM.pageSlice(items, CM.parsePaging({ limit: '3' })), [1, 2, 3]);
    assert.deepStrictEqual(CM.pageSlice(items, CM.parsePaging({ limit: '3', offset: '3' })), [4, 5, 6]);
    assert.deepStrictEqual(CM.pageSlice(items, CM.parsePaging({ limit: '3', offset: '6' })), [7]);
    assert.deepStrictEqual(CM.pageSlice(items, CM.parsePaging({ limit: '3', offset: '99' })), []);
    assert.deepStrictEqual(CM.pageSlice(undefined, CM.parsePaging({ limit: '3' })), []);
    assert.strictEqual(items.length, 7, '原陣列不能被動到');
});

test('統一的分頁回應形狀：items／total／has_more／paged_by', () => {
    const r = CM.pagedResponse([1, 2, 3], { limit: 3, offset: 0, total: 10 });
    assert.deepStrictEqual(r, { items: [1, 2, 3], total: 10, limit: 3, offset: 0, has_more: true, returned: 3, paged_by: 'db' });

    const last = CM.pagedResponse([9, 10], { limit: 3, offset: 9, total: 10 });
    assert.strictEqual(last.has_more, false);

    const empty = CM.pagedResponse([], { limit: 5, offset: 500, total: 10 });
    assert.strictEqual(empty.has_more, false, '超出範圍＝沒有更多');

    assert.strictEqual(CM.pagedResponse([1], { limit: 1, offset: 0, total: 1, pagedBy: 'memory' }).paged_by, 'memory');
    assert.strictEqual(CM.pagedResponse([1, 2], {}).paged_by, 'db', '預設由資料庫切片');
    assert.strictEqual(CM.pagedResponse([1, 2], {}).total, 2, '沒給 total 時以本頁筆數為準');
});

test('rangeLabel：給畫面顯示「第 X–Y 筆，共 N 筆」', () => {
    assert.strictEqual(CM.rangeLabel({ offset: 0 }, 10, 100), '第 1–10 筆，共 100 筆');
    assert.strictEqual(CM.rangeLabel({ offset: 90 }, 10, 100), '第 91–100 筆，共 100 筆');
    assert.strictEqual(CM.rangeLabel({ offset: 0 }, 0, 0), '共 0 筆');
    assert.strictEqual(CM.rangeLabel({ offset: 500 }, 0, 100), '共 100 筆');
});

test('clampInt 本身的行為', () => {
    assert.strictEqual(CM.clampInt('7', 1, 10, 3), 7);
    assert.strictEqual(CM.clampInt('70', 1, 10, 3), 10);
    assert.strictEqual(CM.clampInt('-70', 1, 10, 3), 1);
    assert.strictEqual(CM.clampInt('x', 1, 10, 3), 3);
    assert.strictEqual(CM.clampInt('', 1, 10, 3), 3);
    assert.strictEqual(CM.clampInt(null, 1, 10, 3), 3);
    assert.strictEqual(CM.clampInt(undefined, 0, 10, 0), 0);
    assert.strictEqual(CM.clampInt('Infinity', 0, 10, 4), 4, 'Infinity 不是有限數 → 退回 fallback');
});
