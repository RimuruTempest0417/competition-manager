/* v2.24.0：週期性賽事的規則規格書（純函式）
 *
 * 這裡驗的是「下一場該排哪一天、該不該建」的判斷——cron 與介面上的「立即建立下一場」
 * 共用同一份純函式，所以測這裡等於同時測兩條路。
 * 一律傳入明確日期，不依賴當下時間。
 */
const test = require('node:test');
const assert = require('node:assert');
const CS = require('../public/js/competition-state.js');

/* ── nextOccurrenceDate：算下一個日期 ── */

test('每週：日期 +7 天（跨月、跨年都要對）', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-02', 'weekly'), '2026-09-09');
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-28', 'weekly'), '2026-10-05');
    assert.strictEqual(CS.nextOccurrenceDate('2026-12-29', 'weekly'), '2027-01-05');
});

test('每兩週：日期 +14 天', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-02', 'biweekly'), '2026-09-16');
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-20', 'biweekly'), '2026-10-04');
});

test('每月：日期不變、只換月份', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-15', 'monthly'), '2026-10-15');
    assert.strictEqual(CS.nextOccurrenceDate('2026-12-15', 'monthly'), '2027-01-15');
});

test('每月：該月沒有那一天時夾到月底（不會跳過那個月）', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-01-31', 'monthly'), '2026-02-28');
    assert.strictEqual(CS.nextOccurrenceDate('2026-03-31', 'monthly'), '2026-04-30');
    assert.strictEqual(CS.nextOccurrenceDate('2026-05-31', 'monthly'), '2026-06-30');
});

test('閏年：1/31 的下一個月是 2/29', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2028-01-31', 'monthly'), '2028-02-29');
});

test('認不得的規則或壞掉的日期回 null', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-01', 'daily'), null);
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-01', null), null);
    assert.strictEqual(CS.nextOccurrenceDate('', 'weekly'), null);
    assert.strictEqual(CS.nextOccurrenceDate('2026/09/01', 'weekly'), null);
    assert.strictEqual(CS.nextOccurrenceDate('2026-13-01', 'weekly'), null);
});

test('有時間戳的日期字串也只取日期部分', () => {
    assert.strictEqual(CS.nextOccurrenceDate('2026-09-02T09:00:00Z', 'weekly'), '2026-09-09');
});

/* ── planRecurringCreation：該不該建立下一場 ── */

const TODAY = new Date('2026-09-10T10:00:00');

test('還沒到建立時間（離下一場還很久）→ 不建立，並說明原因', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-20', recurrence: 'monthly', recurrence_until: null },
        [], TODAY
    );
    assert.strictEqual(plan.create, false);
    assert.strictEqual(plan.date, '2026-10-20');
    assert.match(plan.reason, /還沒到建立時間/);
});

test('下一場在提前 30 天以內 → 建立', () => {
    // 9/10 執行：下一場是 10/10（30 天內）
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'monthly', recurrence_until: null },
        [], TODAY
    );
    assert.strictEqual(plan.create, true);
    assert.strictEqual(plan.date, '2026-10-10');
});

test('每週：下一場 9/17（7 天內）→ 建立', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'weekly', recurrence_until: null },
        [], TODAY
    );
    assert.strictEqual(plan.create, true);
    assert.strictEqual(plan.date, '2026-09-17');
});

test('下一場已經存在（例如手動先建了）→ 不重複建立', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'weekly', recurrence_until: null },
        ['2026-09-17'], TODAY
    );
    assert.strictEqual(plan.create, false);
    assert.match(plan.reason, /已經存在/);
});

test('超過週期結束日 → 不建立', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'weekly', recurrence_until: '2026-09-12' },
        [], TODAY
    );
    assert.strictEqual(plan.create, false);
    assert.match(plan.reason, /已超過週期結束日/);
});

test('結束日剛好是下一場那天 → 還是建立（含頭含尾）', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'weekly', recurrence_until: '2026-09-17' },
        [], TODAY
    );
    assert.strictEqual(plan.create, true);
    assert.strictEqual(plan.date, '2026-09-17');
});

test('系列已經有排定的場次（還沒到）→ 一次只排一場，不往後疊', () => {
    // 每週系列：今天這場（9/10）之外，已經有人先排了 9/20
    const plan = CS.planRecurringCreation(
        { date: '2026-09-10', recurrence: 'weekly', recurrence_until: null },
        ['2026-09-10', '2026-09-20'], TODAY
    );
    assert.strictEqual(plan.create, false);
    assert.match(plan.reason, /已經有排定的場次（2026-09-20）/);
});

test('系列只有過去的場次、今天之後空著 → 會排下一場', () => {
    const plan = CS.planRecurringCreation(
        { date: '2026-09-03', recurrence: 'weekly', recurrence_until: null },
        ['2026-09-03'], TODAY
    );
    assert.strictEqual(plan.create, true);
    assert.strictEqual(plan.date, '2026-09-10', '9/3 的下一場就是今天');
});

test('沒有設定週期 → 不建立', () => {
    const plan = CS.planRecurringCreation({ date: '2026-09-10' }, [], TODAY);
    assert.strictEqual(plan.create, false);
    assert.match(plan.reason, /沒有設定週期/);
});

test('日期不完整 → 不建立（不會算出亂七八糟的日期）', () => {
    const plan = CS.planRecurringCreation({ date: '', recurrence: 'weekly' }, [], TODAY);
    assert.strictEqual(plan.create, false);
    assert.strictEqual(plan.date, null);
    assert.match(plan.reason, /日期不完整/);
});

test('週期落後（下一場已經過期）→ 不自動建立，但要標記 overdue 讓介面提醒', () => {
    // 今天是 9/10，上一場是 8/01 每週 → 下一場 8/08 早已過去
    const plan = CS.planRecurringCreation(
        { date: '2026-08-01', recurrence: 'weekly', recurrence_until: null },
        [], TODAY
    );
    assert.strictEqual(plan.create, false);
    assert.strictEqual(plan.overdue, true);
    assert.match(plan.reason, /已落後/);
});

test('提前天數可以調整（leadDays 參數）', () => {
    const comp = { date: '2026-09-10', recurrence: 'monthly', recurrence_until: null };
    assert.strictEqual(CS.planRecurringCreation(comp, [], TODAY, { leadDays: 0 }).create, false);
    assert.strictEqual(CS.planRecurringCreation(comp, [], TODAY, { leadDays: 60 }).create, true);
});

test('回傳的日期一律是 YYYY-MM-DD（資料庫 date 欄位要的格式）', () => {
    const plan = CS.planRecurringCreation({ date: '2026-09-10', recurrence: 'weekly' }, [], TODAY);
    assert.match(plan.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('規則標籤：三種週期都有中文名稱', () => {
    assert.strictEqual(CS.RECURRENCE_RULES.weekly, '每週');
    assert.strictEqual(CS.RECURRENCE_RULES.biweekly, '每兩週');
    assert.strictEqual(CS.RECURRENCE_RULES.monthly, '每月');
});
