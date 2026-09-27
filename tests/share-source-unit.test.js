/* v3.8.2：分享來源的共用純函式（前後端同一份規則，所以測試也直接測那一份）
 *
 * 這幾個函式決定「什麼算合法來源」「深連結怎麼拆」「後台怎麼彙總」，
 * 前端與後端都呼叫同一份 → 這裡測到什麼，兩邊就是什麼。
 */
const test = require('node:test');
const assert = require('node:assert');
const CM = require('../public/js/competition-state');

test('來源白名單：只認四種，其他一律當成沒有來源', () => {
    ['poster', 'qr', 'link', 'text'].forEach((key) => {
        assert.strictEqual(CM.parseShareSource(key), key, `${key} 應該要合法`);
    });
    ['POSTER', ' poster ', 'Poster'].forEach((raw) => {
        assert.strictEqual(CM.parseShareSource(raw), 'poster', '大小寫與空白要容忍（貼連結的人可能手動改）');
    });
    ['', null, undefined, 'direct', 'evil', 'poster;drop', '<script>', 'poster~x'].forEach((raw) => {
        assert.strictEqual(CM.parseShareSource(raw), '', `${String(raw)} 不該通過白名單`);
    });
    assert.ok(CM.SHARE_SOURCES.indexOf('direct') < 0, 'direct 是「沒有來源」的歸類，不是可傳的來源');
});

test('來源標籤：看得懂的中文，未知的一律「其他來源」', () => {
    assert.strictEqual(CM.shareSourceLabel('poster'), '列印海報的 QR');
    assert.strictEqual(CM.shareSourceLabel('qr'), '分享視窗的 QR');
    assert.strictEqual(CM.shareSourceLabel('link'), '複製的連結');
    assert.strictEqual(CM.shareSourceLabel('text'), '群組文案');
    assert.strictEqual(CM.shareSourceLabel('direct'), '直接進入（沒有來源標記）');
    assert.strictEqual(CM.shareSourceLabel('who-knows'), '其他來源');
});

test('深連結：舊的 #c50 照樣有效，新的 #c50~poster 要拆得出來', () => {
    assert.deepStrictEqual(CM.parseDeepLink('#c50'), { id: 50, source: '' }, '★舊連結（海報已經印出去的那批）絕對不能壞');
    assert.deepStrictEqual(CM.parseDeepLink('#c50~poster'), { id: 50, source: 'poster' });
    assert.deepStrictEqual(CM.parseDeepLink('#c50~TEXT'), { id: 50, source: 'text' });
    assert.deepStrictEqual(CM.parseDeepLink('#c1122~link'), { id: 1122, source: 'link' });
    assert.deepStrictEqual(CM.parseDeepLink('#c50~evil'), { id: 50, source: '' },
        '來源不在白名單＝當成沒有來源，但**還是要帶到那場賽事**（不能因為亂改網址就什麼都不做）');
    ['', '#', '#c', '#cabc', '#x50', '#c50~', '#c50~a~b', null, undefined].forEach((bad) => {
        assert.strictEqual(CM.parseDeepLink(bad), null, `${String(bad)} 不該被當成賽事深連結`);
    });
    assert.deepStrictEqual(CM.parseDeepLink('#c50~poster~'), null, '格式不對就整條不認（寧可當成一般網址）');
});

test('後台彙總：依「帶來報名」排序，沒有來源的算直接進入', () => {
    const rows = CM.shareStatsSummary(
        [{ source: 'poster' }, { source: 'poster' }, { source: 'text' }, { source: null }, { source: 'bogus' }],
        [{ source: 'text' }, { source: 'poster' }, { source: null }]
    );
    assert.deepStrictEqual(rows.map((r) => r.source), ['poster', 'direct', 'text'],
        '先比報名數、再比開啟數（poster 與 direct 同為 1 筆報名、2 次開啟 → 維持原本順序）');
    const byKey = {};
    rows.forEach((r) => { byKey[r.source] = r; });
    assert.strictEqual(byKey.poster.visits, 2);
    assert.strictEqual(byKey.poster.signups, 1);
    assert.strictEqual(byKey.text.signups, 1);
    assert.strictEqual(byKey.direct.visits, 2, 'null 與不合法的來源都歸到「直接進入」');
    assert.strictEqual(byKey.direct.signups, 1);
    assert.deepStrictEqual(CM.shareStatsSummary([], []), [], '沒有資料回空陣列（後台顯示「還沒有人透過分享連結進來」）');
    assert.deepStrictEqual(CM.shareStatsSummary(null, undefined), [], '傳 null 也不可以炸');
});
