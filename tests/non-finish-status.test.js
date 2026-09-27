/* v3.9.1：成績狀態「有出賽但沒有名次」的判斷
 *
 * 為什麼要單獨釘住：系列賽積分靠它決定「這筆要算 0 分保留」還是「當作沒這回事」。
 * 分不出來就會出現「有報名、有出賽、卻在系列排行裡完全看不到」——家長會直接來問。
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/js/results');

test('未完賽的三種狀態都算「超表」（不分大小寫、容忍空白）', () => {
    assert.strictEqual(R.isNonFinish('dnf'), true);
    assert.strictEqual(R.isNonFinish('DNF'), true);
    assert.strictEqual(R.isNonFinish(' dns '), true);
    assert.strictEqual(R.isNonFinish('Dsq'), true);
});

test('完賽與空值不是超表（不能把正常成績算成 0 分）', () => {
    assert.strictEqual(R.isNonFinish('finished'), false);
    assert.strictEqual(R.isNonFinish(''), false);
    assert.strictEqual(R.isNonFinish(null), false);
    assert.strictEqual(R.isNonFinish(undefined), false);
    assert.strictEqual(R.isNonFinish('unknown-status'), false);
});

test('狀態清單本身就是成績模組的完整定義（不能各處自己抄一份）', () => {
    assert.deepStrictEqual(R.NON_FINISH_STATUSES, ['dnf', 'dns', 'dsq']);
    R.RESULT_STATUSES.forEach((s) => {
        const nonFinish = R.NON_FINISH_STATUSES.indexOf(s.id) !== -1;
        assert.strictEqual(R.isNonFinish(s.id), nonFinish, `${s.id} 的判斷要與清單一致`);
    });
});
