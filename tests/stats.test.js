/* v3.0.0 營運統計（public/js/stats.js）規格書 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const CM = require(path.join(__dirname, '..', 'public', 'js', 'stats.js'));

const NOW = new Date('2026-09-26T12:00:00+08:00');
const daysAgo = (n) => new Date(NOW.getTime() - n * CM.DAY_MS).toISOString();

test('dayKey：轉成 YYYY-MM-DD；壞資料回 null（不要靜默變成 1970 年）', () => {
    assert.strictEqual(CM.dayKey('2026-09-26T10:00:00+08:00'), '2026-09-26');
    assert.strictEqual(CM.dayKey(new Date('2026-01-05T00:00:00+08:00')), '2026-01-05');
    assert.strictEqual(CM.dayKey(''), null);
    assert.strictEqual(CM.dayKey(null), null);
    assert.strictEqual(CM.dayKey(undefined), null);
    assert.strictEqual(CM.dayKey('不是時間'), null);
});

test('lastNDays：含今天、由舊到新、長度固定', () => {
    const days = CM.lastNDays(5, NOW);
    assert.strictEqual(days.length, 5);
    assert.strictEqual(days[4], '2026-09-26', '最後一個是今天');
    assert.strictEqual(days[0], '2026-09-22');
    assert.deepStrictEqual(CM.lastNDays(1, NOW), ['2026-09-26']);
    assert.strictEqual(CM.lastNDays(0, NOW).length, 1, '0 天也要回一天，不要回空陣列');
});

test('trendByDay：沒有資料的日子補 0，長度固定', () => {
    const rows = [
        { created_at: daysAgo(0) }, { created_at: daysAgo(0) },
        { created_at: daysAgo(2) },
        { created_at: '壞時間' },
        { created_at: null }
    ];
    const trend = CM.trendByDay(rows, { days: 4, now: NOW });
    assert.strictEqual(trend.length, 4);
    assert.deepStrictEqual(trend.map((t) => t.count), [0, 1, 0, 2]);
    assert.strictEqual(trend[3].date, '2026-09-26');
    assert.deepStrictEqual(CM.trendByDay([], { days: 3, now: NOW }).map((t) => t.count), [0, 0, 0]);
    assert.deepStrictEqual(CM.trendByDay(null, { days: 2, now: NOW }).length, 2);
});

test('trendByDay：可以指定日期欄位（例如錯誤日誌也是用 created_at）', () => {
    const trend = CM.trendByDay([{ at: daysAgo(1) }, { at: daysAgo(1) }], { days: 3, now: NOW, dateField: 'at' });
    assert.deepStrictEqual(trend.map((t) => t.count), [0, 2, 0]);
});

test('countBy：分組計數、忽略空 key、容忍壞輸入', () => {
    const counts = CM.countBy([{ t: 'a' }, { t: 'a' }, { t: 'b' }, { t: null }, {}], (r) => r && r.t);
    assert.deepStrictEqual(counts, { a: 2, b: 1 });
    assert.deepStrictEqual(CM.countBy(null, (r) => r), {});
});

test('topN：次數多的在前、同分依名稱排序（結果穩定才測得住）', () => {
    const top = CM.topN({ b: 3, a: 3, c: 9, d: 0 }, 3);
    assert.deepStrictEqual(top, [{ key: 'c', count: 9 }, { key: 'a', count: 3 }, { key: 'b', count: 3 }]);
    assert.strictEqual(CM.topN({ a: 1 }, 5).length, 1, '不足 n 筆就回全部');
    assert.deepStrictEqual(CM.topN(null, 3), []);
});

test('percent：除以 0 是 0%（不是 NaN 或 Infinity）', () => {
    assert.strictEqual(CM.percent(3, 10), 30);
    assert.strictEqual(CM.percent(0, 0), 0);
    assert.strictEqual(CM.percent(5, 0), 0);
    assert.strictEqual(CM.percent('abc', 10), 0);
    assert.strictEqual(CM.percent(1, 3), 33);
});

test('rateTone：95 以上 good、80 以上 warn、其餘 bad', () => {
    assert.strictEqual(CM.rateTone(100), 'good');
    assert.strictEqual(CM.rateTone(95), 'good');
    assert.strictEqual(CM.rateTone(94), 'warn');
    assert.strictEqual(CM.rateTone(80), 'warn');
    assert.strictEqual(CM.rateTone(79), 'bad');
    assert.strictEqual(CM.rateTone(0), 'bad');
});

test('barGeometry：比例、位置與空資料的行為', () => {
    const geo = CM.barGeometry([10, 5, 0], { width: 100, height: 50, gap: 5 });
    assert.strictEqual(geo.length, 3);
    assert.strictEqual(geo[0].y, 0, '最大值佔滿高度');
    assert.strictEqual(geo[0].height, 50);
    assert.strictEqual(geo[1].height, 25, '一半就一半高');
    assert.strictEqual(geo[2].height, 0, '0 就是 0 高');
    assert.strictEqual(geo[1].x - (geo[0].x + geo[0].width), 5, '間距正確');

    assert.deepStrictEqual(CM.barGeometry([], { width: 100, height: 50 }), []);
    const flat = CM.barGeometry([0, 0], { width: 100, height: 50 });
    assert.strictEqual(flat.every((b) => b.height === 0), true, '全部 0 也不會爆（不會除以 0）');
    assert.strictEqual(flat.every((b) => b.y === 50), true);
});

test('linePath／linePoints：路徑字串與資料點一致', () => {
    const d = CM.linePath([0, 10, 5], { width: 100, height: 100 });
    assert.strictEqual(d, 'M 0,100 L 50,0 L 100,50');
    const pts = CM.linePoints([0, 10, 5], { width: 100, height: 100 });
    assert.deepStrictEqual(pts.map((p) => [p.x, p.y]), [[0, 100], [50, 0], [100, 50]]);
    assert.strictEqual(CM.linePath([], { width: 100, height: 100 }), '');
    assert.strictEqual(CM.linePath([7], { width: 100, height: 100 }).startsWith('M 0,0'), true, '單點也要畫得出來');
    assert.strictEqual(CM.linePath([0, 0], { width: 100, height: 100 }), 'M 0,100 L 100,100', '全 0 貼底線');
});

test('formatBytes：B／KB／MB', () => {
    assert.strictEqual(CM.formatBytes(0), '0 B');
    assert.strictEqual(CM.formatBytes(512), '512 B');
    assert.strictEqual(CM.formatBytes(2048), '2 KB');
    assert.strictEqual(CM.formatBytes(3 * 1024 * 1024), '3 MB');
    assert.strictEqual(CM.formatBytes(null), '0 B');
});
