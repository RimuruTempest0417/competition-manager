/**
 * v3.8.1：QR／海報旁的說明要跟著賽事狀態走。
 *
 * 為什麼重要：海報印出去就改不了。如果一場已經額滿、但有候補的賽事，
 * 海報上還印「掃碼直接報名」，掃進去的人會覺得被騙；反過來，
 * 已經截止（不是額滿）的賽事也不該被說成「已額滿，可候補」。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const src = APP.match(/function shareStateGuide\(item\)[\s\S]*?\n\}/);
assert.ok(src, 'app.js 必須有 shareStateGuide（純函式，方便測試）');
const guideOf = vm.runInNewContext(`${src[0]}\nshareStateGuide`, {});

test('開放報名中：說明就是「掃碼直接報名」', () => {
    const g = guideOf({ state: 'registration_open', can_register: true });
    assert.equal(g.key, 'open');
    assert.match(g.caption, /掃碼直接報名/);
});

test('已取消：說明要說已取消（不要叫人報名）', () => {
    const g = guideOf({ state: 'cancelled', can_register: false });
    assert.equal(g.key, 'cancelled');
    assert.match(g.caption, /已取消/);
    assert.ok(!/直接報名/.test(g.caption));
});

test('★額滿＋有候補：要引導去登記候補（不是叫人家報名）', () => {
    const g = guideOf({ state: 'registration_closed', can_register: false, is_waitlist: true,
        state_detail: '名額已滿', registration_reason: '名額已滿，可候補' });
    assert.equal(g.key, 'waitlist');
    assert.match(g.caption, /已額滿，掃碼登記候補/);
    assert.match(g.short, /可登記候補/);
});

test('★已截止但不是額滿：不可以被說成額滿（這是最容易搞錯的一種）', () => {
    const g = guideOf({ state: 'registration_closed', can_register: false, is_waitlist: true,
        state_detail: '報名已截止', registration_reason: '報名已截止' });
    assert.equal(g.key, 'closed');
    assert.match(g.caption, /報名已截止/);
    assert.ok(!/額滿/.test(g.caption), '名額還有剩的賽事不該被說成額滿');
    assert.ok(!/候補/.test(g.caption), '沒額滿就不該引導候補');
});

test('報名尚未開放：說清楚還沒開放', () => {
    const g = guideOf({ state: 'registration_upcoming', can_register: false });
    assert.equal(g.key, 'upcoming');
    assert.match(g.caption, /尚未開放/);
});

test('賽事進行中／已結束：只提供資訊，不引導報名', () => {
    assert.match(guideOf({ state: 'ongoing', can_register: false }).caption, /進行中/);
    assert.match(guideOf({ state: 'finished', can_register: false }).caption, /已結束/);
    assert.ok(!/直接報名/.test(guideOf({ state: 'finished', can_register: false }).caption));
});

test('資料不完整時走「已截止」這條安全路徑（不會亂說可以報名）', () => {
    require('node:assert').equal(guideOf({}).key, 'closed');
    require('node:assert').equal(guideOf(null).key, 'closed');
    assert.ok(!/直接報名/.test(guideOf({}).caption));
});

test('相容舊欄位：沒有 can_register 時看 is_registration_open', () => {
    assert.equal(guideOf({ is_registration_open: true }).key, 'open');
    assert.equal(guideOf({ is_registration_open: false }).key, 'closed');
});

test('waitlist_enabled（舊欄位名）也認得', () => {
    const g = guideOf({ can_register: false, waitlist_enabled: true, state_detail: '名額已滿' });
    assert.equal(g.key, 'waitlist');
});
