/* v2.27.0：場地地圖連結規則的規格書（純函式，傳入明確值、不依賴環境） */
const test = require('node:test');
const assert = require('node:assert');
const V = require('../public/js/venue');

test('用地址自動產生 Google 地圖搜尋連結（含中文與空白要編碼）', () => {
    const url = V.autoMapUrl('澳門氹仔運動場');
    assert.strictEqual(url, V.MAP_SEARCH_PREFIX + encodeURIComponent('澳門氹仔運動場'));
    assert.ok(!/[^\x00-\x7F]/.test(url), '網址內不該留原始中文字（要編碼）');
    assert.ok(V.autoMapUrl('  奧林匹克體育中心  ') === V.MAP_SEARCH_PREFIX + encodeURIComponent('奧林匹克體育中心'),
        '前後空白要修掉');
});

test('地址空白或過長就不產生連結', () => {
    assert.strictEqual(V.autoMapUrl(''), '');
    assert.strictEqual(V.autoMapUrl(null), '');
    assert.strictEqual(V.autoMapUrl('   '), '');
    assert.strictEqual(V.autoMapUrl('甲'.repeat(201)), '');
});

test('自訂連結：http/https 直接可用', () => {
    assert.strictEqual(V.normalizeMapUrl('https://maps.app.goo.gl/abc123'), 'https://maps.app.goo.gl/abc123');
    assert.strictEqual(V.normalizeMapUrl('http://example.com/venue?x=1'), 'http://example.com/venue?x=1');
    assert.strictEqual(V.normalizeMapUrl('  https://maps.google.com/?q=澳門  '),
        new URL('https://maps.google.com/?q=澳門').toString(), '前後空白修掉、內容保留（含編碼）');
});

test('沒帶協定但看起來是網域：自動補 https://', () => {
    assert.strictEqual(V.normalizeMapUrl('www.google.com/maps/place/x'), 'https://www.google.com/maps/place/x');
    assert.strictEqual(V.normalizeMapUrl('maps.app.goo.gl/abc'), 'https://maps.app.goo.gl/abc');
});

test('不安全或不像網址的一律視為無效（不可以讓貼進來的字串變成可執行的東西）', () => {
    assert.strictEqual(V.normalizeMapUrl('javascript:alert(1)'), '');
    assert.strictEqual(V.normalizeMapUrl('JaVaScRiPt:alert(1)'), '');
    assert.strictEqual(V.normalizeMapUrl('data:text/html,<script>alert(1)</script>'), '');
    assert.strictEqual(V.normalizeMapUrl('mailto:someone@example.com'), '');
    assert.strictEqual(V.normalizeMapUrl('氹仔運動場'), '', '地址整串貼到地圖欄位不算連結（要填在地點欄位）');
    assert.strictEqual(V.normalizeMapUrl('https://'), '');
    assert.strictEqual(V.normalizeMapUrl('https://' + 'a'.repeat(600)), '', '過長不接受');
    assert.strictEqual(V.normalizeMapUrl(''), '');
    assert.strictEqual(V.normalizeMapUrl(null), '');
});

test('mapUrlFor：自訂優先，沒有才用地址自動產生', () => {
    assert.strictEqual(V.mapUrlFor({ location: '澳門運動場', map_url: 'https://maps.app.goo.gl/custom' }),
        'https://maps.app.goo.gl/custom');
    assert.strictEqual(V.mapUrlFor({ location: '澳門運動場', map_url: '' }), V.autoMapUrl('澳門運動場'));
    assert.strictEqual(V.mapUrlFor({ location: '澳門運動場', map_url: 'javascript:alert(1)' }),
        V.autoMapUrl('澳門運動場'), '無效的自訂連結要退回自動產生，不是變成沒有地圖');
    assert.strictEqual(V.mapUrlFor({ location: '', map_url: '' }), '');
    assert.strictEqual(V.mapUrlFor({}), '');
    assert.strictEqual(V.mapUrlFor(null), '');
});

test('isAutoMapUrl／hasMap 判斷「是不是靠地址自動產生」', () => {
    assert.strictEqual(V.isAutoMapUrl({ location: '澳門運動場' }), true);
    assert.strictEqual(V.isAutoMapUrl({ location: '澳門運動場', map_url: 'https://maps.app.goo.gl/x' }), false);
    assert.strictEqual(V.isAutoMapUrl({ location: '' }), false);
    assert.strictEqual(V.hasMap({ location: '澳門運動場' }), true);
    assert.strictEqual(V.hasMap({}), false);
});
