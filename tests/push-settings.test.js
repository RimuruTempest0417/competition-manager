/* v2.25.0：推播設定（時間與事件）的純函式規格書
 *
 * 這裡驗的是「設定怎麼解讀、現在該不該發摘要、要發哪幾種事件」。
 * 一律傳入明確時間，不依賴當下時刻。
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'push-settings-unit-secret';
process.env.SUPABASE_KEY = 'stub-key';

const app = require('../server.js');
const {
    pushSettingsFromRows,
    normalizePushSettingsInput,
    shouldRunDigest,
    pushLocalParts,
    digestKindsFromSettings,
    pushSettingBool,
    pushCandidates
} = app.__test__;

/* ── 設定解讀 ── */

test('沒設定過任何值時，全部回到預設（每日摘要 09:00、事件全開）', () => {
    const s = pushSettingsFromRows({});
    assert.strictEqual(s.digest_enabled, true);
    assert.strictEqual(s.digest_time, '09:00');
    assert.strictEqual(s.digest_kind_new, true);
    assert.strictEqual(s.digest_kind_reminder, true);
    assert.strictEqual(s.event_review, true);
    assert.strictEqual(s.event_promote, true);
});

test('設定表存的是字串，要正確轉成布林（只有明確 false 才算關）', () => {
    assert.strictEqual(pushSettingBool('true', false), true);
    assert.strictEqual(pushSettingBool('false', true), false);
    assert.strictEqual(pushSettingBool('亂七八糟', true), true, '看不懂的值一律用預設');
    assert.strictEqual(pushSettingBool(null, false), false);
    assert.strictEqual(pushSettingBool('', true), true);
});

test('壞掉的時間字串會被換回預設，不會讓摘要永遠不發', () => {
    assert.strictEqual(pushSettingsFromRows({ push_digest_time: '25:99' }).digest_time, '09:00');
    assert.strictEqual(pushSettingsFromRows({ push_digest_time: '9:00' }).digest_time, '09:00', '個位數要補零');
    assert.strictEqual(pushSettingsFromRows({ push_digest_time: '21:30' }).digest_time, '21:30');
});

test('更新設定：只帶部分欄位時，其他欄位維持原值', () => {
    const current = pushSettingsFromRows({ push_digest_time: '20:00', push_event_review: 'false' });
    const result = normalizePushSettingsInput({ digest_enabled: false }, current);
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.settings.digest_enabled, false);
    assert.strictEqual(result.settings.digest_time, '20:00', '沒帶到的欄位不該被重設');
    assert.strictEqual(result.settings.event_review, false);
});

test('更新設定：時間格式錯要擋下來（不是偷偷改成預設）', () => {
    assert.match(normalizePushSettingsInput({ digest_time: '25:00' }, {}).error, /09:00|格式/);
    assert.match(normalizePushSettingsInput({ digest_time: '9:00' }, {}).error, /格式/);
    assert.match(normalizePushSettingsInput({ digest_time: '21:5' }, {}).error, /格式/);
    assert.strictEqual(normalizePushSettingsInput({ digest_time: '00:00' }, {}).error, undefined);
    assert.strictEqual(normalizePushSettingsInput({ digest_time: '23:59' }, {}).error, undefined);
});

test('更新設定：布林欄位收到字串要擋下來（避免 "false" 被當成 true）', () => {
    assert.match(normalizePushSettingsInput({ digest_enabled: 'false' }, {}).error, /true|false/);
});

/* ── 現在幾點（網站時區）── */

test('時區換算：+08:00 的 01:00 UTC 是當地 09:00、同一天', () => {
    const parts = pushLocalParts(Date.parse('2026-09-26T01:00:00Z'), '+08:00');
    assert.deepStrictEqual(parts, { date: '2026-09-26', time: '09:00' });
});

test('時區換算：+08:00 的 16:30 UTC 是當地隔天 00:30（日期要跟著跳）', () => {
    const parts = pushLocalParts(Date.parse('2026-09-26T16:30:00Z'), '+08:00');
    assert.deepStrictEqual(parts, { date: '2026-09-27', time: '00:30' });
});

test('時區換算：負時區（-05:00）也要對', () => {
    const parts = pushLocalParts(Date.parse('2026-09-26T02:00:00Z'), '-05:00');
    assert.deepStrictEqual(parts, { date: '2026-09-25', time: '21:00' });
});

test('時區字串壞掉時退回 +08:00（網站固定時區）', () => {
    const parts = pushLocalParts(Date.parse('2026-09-26T01:00:00Z'), 'garbage');
    assert.strictEqual(parts.time, '09:00');
});

/* ── 該不該發摘要 ── */

const at = (iso) => Date.parse(iso);
const base = { enabled: true, scheduledTime: '09:00', lastDigestDate: null, offset: '+08:00' };

test('還沒到發送時間 → 不發，並說明設定的時間與現在時間', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { nowMs: at('2026-09-26T00:30:00Z') }));  // 當地 08:30
    assert.strictEqual(gate.run, false);
    assert.match(gate.reason, /還沒到發送時間（設定 09:00，現在 08:30）/);
});

test('時間到了 → 發', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { nowMs: at('2026-09-26T01:00:00Z') }));
    assert.strictEqual(gate.run, true);
    assert.strictEqual(gate.date, '2026-09-26');
});

test('補送：排程晚了一點（當地 21:00 才跑、設定 09:00）→ 還是發', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { nowMs: at('2026-09-26T13:00:00Z') }));
    assert.strictEqual(gate.run, true);
});

test('一天只發一次：今天已發過 → 不發（就算時間已經過了）', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { lastDigestDate: '2026-09-26', nowMs: at('2026-09-26T13:00:00Z') }));
    assert.strictEqual(gate.run, false);
    assert.match(gate.reason, /今天已經發送過/);
});

test('跨一天：昨天發過、今天時間到了 → 要發', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { lastDigestDate: '2026-09-25', nowMs: at('2026-09-26T01:00:00Z') }));
    assert.strictEqual(gate.run, true);
});

test('總開關關掉 → 不發（不論時間）', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { enabled: false, nowMs: at('2026-09-26T13:00:00Z') }));
    assert.strictEqual(gate.run, false);
    assert.match(gate.reason, /每日摘要已關閉/);
});

test('設定的時間壞掉時用預設 09:00 判斷', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { scheduledTime: '亂寫', nowMs: at('2026-09-26T00:30:00Z') }));
    assert.strictEqual(gate.run, false, '當地 08:30 還沒到預設的 09:00');
});

test('半夜 00:00 設定：當地一過午夜就可以發（新的一天）', () => {
    const gate = shouldRunDigest(Object.assign({}, base, { scheduledTime: '00:00', nowMs: at('2026-09-25T16:05:00Z') }));
    assert.strictEqual(gate.date, '2026-09-26');
    assert.strictEqual(gate.run, true);
});

/* ── 要發哪幾種事件 ── */

test('摘要事件種類：兩個都開＝提醒＋新賽事', () => {
    assert.deepStrictEqual(digestKindsFromSettings(pushSettingsFromRows({})), ['reminder', 'new']);
});

test('摘要事件種類：只開新賽事／只開提醒／都關掉', () => {
    assert.deepStrictEqual(
        digestKindsFromSettings(pushSettingsFromRows({ push_digest_kind_reminder: 'false' })),
        ['new']
    );
    assert.deepStrictEqual(
        digestKindsFromSettings(pushSettingsFromRows({ push_digest_kind_new: 'false' })),
        ['reminder']
    );
    assert.deepStrictEqual(
        digestKindsFromSettings(pushSettingsFromRows({ push_digest_kind_new: 'false', push_digest_kind_reminder: 'false' })),
        []
    );
});

test('pushCandidates 會依 kinds 篩選（關掉提醒時不會產生提醒項目）', () => {
    const now = new Date('2026-09-26T01:00:00Z');
    const comps = [
        // 開賽在 12 小時後（當地 21:00）→ 會產生 reminder；上次執行後才發布 → 也會產生 new
        { id: 1, name: '今晚的賽事', date: '2026-09-26', time: '21:00', is_deleted: false, created_at: '2026-09-26T00:30:00Z' }
    ];
    const options = { now, lastRunMs: at('2026-09-25T12:00:00Z'), offset: '+08:00' };
    const both = pushCandidates(comps, Object.assign({ kinds: ['reminder', 'new'] }, options));
    assert.deepStrictEqual(both.map((c) => c.kind).sort(), ['new', 'reminder']);
    const onlyNew = pushCandidates(comps, Object.assign({ kinds: ['new'] }, options));
    assert.deepStrictEqual(onlyNew.map((c) => c.kind), ['new']);
    const none = pushCandidates(comps, Object.assign({ kinds: [] }, options));
    assert.deepStrictEqual(none, []);
});
