const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 以 production 模式載入，避免 server.js 真的 app.listen 佔用 port
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const app = require(path.join(__dirname, '..', 'server.js'));
const { COMPETITION_CATEGORIES, normalizeCategory, normalizeTags, isMissingColumnError } = app.__test__;

test('分類清單：id 唯一、欄位齊全、顏色在允許清單內', () => {
    const allowedColors = new Set(['blue', 'indigo', 'emerald', 'red', 'purple', 'rose', 'amber', 'slate']);
    const ids = COMPETITION_CATEGORIES.map((c) => c.id);

    assert.strictEqual(new Set(ids).size, ids.length, '分類 id 不應重複');
    assert.ok(ids.length >= 5, '分類應有合理數量');
    for (const c of COMPETITION_CATEGORIES) {
        assert.ok(c.id && c.label && c.emoji, `分類 ${c.id} 欄位不齊全`);
        assert.ok(allowedColors.has(c.color), `分類 ${c.id} 的顏色 ${c.color} 不在 custom.css 支援清單內`);
    }
});

test('normalizeCategory：只接受清單內的值，其餘視為未分類', () => {
    assert.strictEqual(normalizeCategory('ball'), 'ball');
    assert.strictEqual(normalizeCategory(' ball '), 'ball');
    assert.strictEqual(normalizeCategory('BALL'), null, 'id 應為大小寫敏感');
    assert.strictEqual(normalizeCategory('not-a-category'), null);
    assert.strictEqual(normalizeCategory(''), null);
    assert.strictEqual(normalizeCategory(null), null);
    assert.strictEqual(normalizeCategory(undefined), null);
    assert.strictEqual(normalizeCategory({}), null, '物件不應被當成分類 id');
});

test('normalizeTags：支援字串與陣列、去 #、去重（忽略大小寫）、限量', () => {
    assert.deepStrictEqual(normalizeTags('國中組, 團體賽，免費; 決賽'), ['國中組', '團體賽', '免費', '決賽']);
    assert.deepStrictEqual(normalizeTags(['#A', 'a', 'b']), ['A', 'b'], '應去重且保留第一個的原始大小寫');
    assert.deepStrictEqual(normalizeTags('   '), []);
    assert.deepStrictEqual(normalizeTags(null), []);
    assert.deepStrictEqual(normalizeTags(undefined), []);
    assert.deepStrictEqual(normalizeTags([]), []);

    const many = normalizeTags(Array.from({ length: 25 }, (_, i) => `t${i}`));
    assert.strictEqual(many.length, 10, '標籤上限為 10 個');

    const long = normalizeTags(['x'.repeat(100)]);
    assert.strictEqual(long[0].length, 24, '單一標籤上限 24 字元');

    assert.deepStrictEqual(normalizeTags([null, 'ok', '', 123]), ['ok', '123'], '非字串應轉為字串或忽略');
});

test('shouldIncludeTaxonomy：migration 前不得讓編輯既有賽事失敗', () => {
    const { hasTaxonomyContent, shouldIncludeTaxonomy } = app.__test__;
    const empty = { category: null, tags: [] };
    const withCategory = { category: 'ball', tags: [] };
    const withTags = { category: null, tags: ['公開組'] };

    // 有內容才送（且呼叫端已先確認欄位存在）
    assert.strictEqual(hasTaxonomyContent(empty), false);
    assert.strictEqual(hasTaxonomyContent(withCategory), true);
    assert.strictEqual(hasTaxonomyContent(withTags), true);

    // 尚未 migration（false）：無內容時不要帶欄位 → 與 v2.6.0 行為相同
    assert.strictEqual(shouldIncludeTaxonomy(empty, false), false);
    assert.strictEqual(shouldIncludeTaxonomy(empty, null), false);
    // migration 後（true）：即使是空值也要帶，使用者才能清空分類/標籤
    assert.strictEqual(shouldIncludeTaxonomy(empty, true), true);
    // 有內容時一律要帶
    assert.strictEqual(shouldIncludeTaxonomy(withCategory, true), true);
    assert.strictEqual(shouldIncludeTaxonomy(withTags, null), true);
});

test('isMissingColumnError：辨識尚未執行 migration 的資料庫錯誤', () => {
    assert.strictEqual(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'category' column" }), true);
    assert.strictEqual(isMissingColumnError({ code: '42703', message: 'column "tags" does not exist' }), true);
    assert.strictEqual(isMissingColumnError({ message: 'column competitions.category does not exist' }), true);
    assert.strictEqual(isMissingColumnError({ code: '23505', message: 'duplicate key value' }), false);
    assert.strictEqual(isMissingColumnError(new Error('network timeout')), false);
    assert.strictEqual(isMissingColumnError(null), false);
});
