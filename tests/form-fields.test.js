/* v3.9.0：報名表自訂欄位的規則（前後端共用同一份，所以這裡測的就是真實行為）
 *
 * 為什麼要測得這麼細：這份規則同時決定「報名時後端收不收」和「畫面上畫什麼」，
 * 一旦前後端理解不同，就會出現「畫面說可以、送出被退」或更糟的「什麼都收」。
 */
const test = require('node:test');
const assert = require('node:assert');
const F = require('../public/js/form-fields');

test('正規化：中文標籤也給得出唯一 key、選項去重、沒有標籤的欄位直接丟掉', () => {
    const fields = F.normalizeFields([
        { label: '衣服尺寸', type: 'select', options: ['S', 'M', 'M', 'L'] },
        { label: '聯絡電話', type: 'text' },
        { label: '   ', type: 'text' },
        { label: '尺寸', type: 'select', options: [] }
    ]);
    assert.strictEqual(fields.length, 3);
    assert.deepStrictEqual(fields[0].options, ['S', 'M', 'L']);
    assert.notStrictEqual(fields[0].key, fields[1].key);
    assert.strictEqual(fields[2].type, 'text', '下拉沒有選項要退化成文字，不要做一個沒得選的欄位');
});

test('正規化：最多 10 個欄位，第 11 個以後不列', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `欄位${i + 1}`, type: 'text' }));
    assert.strictEqual(F.normalizeFields(many).length, 10);
});

test('必填：沒填要逐欄回報，不是只回一句「資料有誤」', () => {
    const fields = F.normalizeFields([
        { label: '衣服尺寸', type: 'select', required: true, options: ['S', 'M'] },
        { label: '同意肖像', type: 'checkbox', required: true }
    ]);
    const result = F.validateAnswers(fields, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(Object.keys(result.errors).length, 2);
    assert.match(result.errors[fields[0].key], /衣服尺寸/);
    assert.match(result.errors[fields[1].key], /勾選/);
});

test('型別：數字要真的是數字、日期要是真的日期、下拉只能挑選項裡的', () => {
    const fields = F.normalizeFields([
        { label: '年齡', type: 'number' }, { label: '生日', type: 'date' },
        { label: '尺寸', type: 'select', options: ['S', 'M'] }
    ]);
    assert.strictEqual(F.validateAnswers(fields, { [fields[0].key]: '18' }).clean[fields[0].key], 18);
    assert.match(F.validateAnswers(fields, { [fields[0].key]: 'abc' }).errors[fields[0].key], /數字/);
    assert.strictEqual(F.validateAnswers(fields, { [fields[1].key]: '2026-02-30' }).ok, false, '2 月 30 日不是有效日期');
    assert.strictEqual(F.validateAnswers(fields, { [fields[1].key]: '2026-02-28' }).ok, true);
    assert.strictEqual(F.validateAnswers(fields, { [fields[2].key]: 'XXL' }).ok, false);
});

test('安全：沒定義的欄位就算送進來也不會被存（白名單）', () => {
    const fields = F.normalizeFields([{ label: '尺寸', type: 'text' }]);
    const result = F.validateAnswers(fields, { [fields[0].key]: 'M', is_admin: true, role: 'web_owner' });
    assert.deepStrictEqual(Object.keys(result.clean), [fields[0].key]);
});

test('安全：超長內容會被截斷（不會有人用 10 萬字把資料庫塞爆）', () => {
    const fields = F.normalizeFields([{ label: '備註', type: 'textarea' }]);
    const long = 'x'.repeat(5000);
    assert.strictEqual(F.validateAnswers(fields, { [fields[0].key]: long }).clean[fields[0].key].length, F.LIMITS.textarea);
});

test('顯示：摘要與單值轉文字（名單／CSV／我的報名都用這兩個）', () => {
    const fields = F.normalizeFields([
        { label: '尺寸', type: 'select', options: ['M'] },
        { label: '素食', type: 'checkbox' }
    ]);
    const answers = { [fields[0].key]: 'M', [fields[1].key]: true };
    assert.strictEqual(F.answerText(fields[1], false), '否');
    assert.strictEqual(F.answersSummary(fields, answers), '尺寸：M｜素食：是');
    assert.strictEqual(F.answersSummary(fields, {}), '', '什麼都沒填就不要產出空字串欄位');
});

test('沒設定自訂欄位＝傳統報名表（行為完全不變）', () => {
    assert.deepStrictEqual(F.normalizeFields(null), []);
    assert.deepStrictEqual(F.validateAnswers(null, { anything: 1 }).clean, {});
    assert.strictEqual(F.hasAnswers({}), false);
    assert.strictEqual(F.hasAnswers({ a: 1 }), true);
});
