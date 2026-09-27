/**
 * v3.8.0：可以直接貼進群組的賽事文案（buildShareText）。
 *
 * 這一版的目的是「讓人願意分享、而且分享了對方就會報名」，
 * 所以文案必須**一定帶得到報名連結**，而且缺欄位時要優雅退化（不能出現 undefined）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
function grab(name, re) {
    const m = APP.match(re);
    assert.ok(m, `app.js 必須有 ${name}`);
    return m[0];
}
const FN_RE = (n) => new RegExp(`function ${n}\\([^)]*\\)[\\s\\S]*?\\n\\}`);
const ctx = vm.runInNewContext(
    `${grab('shareDateLabel', FN_RE('shareDateLabel'))}\n${grab('buildShareText', FN_RE('buildShareText'))}\n({ shareDateLabel, buildShareText })`,
    {});
const { buildShareText, shareDateLabel } = ctx;

const FULL = {
    name: '2026 全澳青少年三人籃球賽',
    date: '2026-10-15T14:00',
    endDate: '2026-10-15T17:00',
    time: '14:00',
    location: '澳門塔石體育館',
    registrationStart: '2026-09-20T10:00',
    registrationEnd: '2026-10-01T23:59',
    quota: 24,
    requiresApproval: true,
    waitlist: true,
    url: 'https://example.test/#c51'
};

test('完整資訊：名稱、時間、地點、報名期間、名額與連結都在裡面', () => {
    const text = buildShareText(FULL);
    assert.match(text, /2026 全澳青少年三人籃球賽/);
    assert.match(text, /2026-10-15 14:00 ~ 2026-10-15 17:00/);
    assert.match(text, /澳門塔石體育館/);
    assert.match(text, /報名：2026-09-20 10:00 ~ 2026-10-01 23:59/);
    assert.match(text, /名額：24 人（需審核），額滿可候補/);
    assert.ok(text.includes('https://example.test/#c51'), '一定要帶報名連結');
    assert.ok(!text.includes('undefined'), '不可以出現 undefined');
});

test('時間只給開始日時：不會硬加上一段不存在的結束時間', () => {
    const text = buildShareText({ name: '單日賽', date: '2026-11-01T09:30', url: 'https://example.test/#c1' });
    assert.match(text, /時間：2026-11-01 09:30/);
    assert.ok(!text.includes('~'), '沒有結束時間就不該出現 ~');
});

test('缺欄位時優雅退化（未定／未命名比賽／不出現 undefined）', () => {
    const text = buildShareText({});
    assert.match(text, /未命名比賽/);
    assert.match(text, /時間：未定/);
    assert.match(text, /地點：未定/);
    assert.ok(!text.includes('undefined'));
    assert.ok(!text.includes('null'));
});

test('沒有連結時不提報名連結（也不要留一個空行看起來像壞掉）', () => {
    const text = buildShareText({ name: '無連結賽', date: '2026-12-01' });
    assert.ok(!text.includes('線上報名'));
    assert.ok(!text.includes('https://'));
});

test('名額 0 或未填時不顯示「👥 名額」那一行', () => {
    // 注意：結尾那句「名額有限、額滿為止…」本身含「名額」二字，所以要認標頭
    assert.ok(!buildShareText({ name: 'A', quota: 0 }).includes('👥 名額'));
    assert.ok(!buildShareText({ name: 'B', quota: '' }).includes('👥 名額'));
    assert.ok(buildShareText({ name: 'C', quota: '30' }).includes('👥 名額：30 人'));
});

test('ISO 時間字串會被整理成人看得懂的樣子', () => {
    assert.equal(shareDateLabel('2026-10-15T14:00:00.000Z'), '2026-10-15 14:00');
    assert.equal(shareDateLabel(''), '');
    assert.equal(shareDateLabel(null), '');
});
