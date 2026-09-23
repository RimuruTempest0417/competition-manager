const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.SUPABASE_KEY = 'stub-key';

const app = require('../server.js');
const { parseImageDataUrl, competitionStartMs, pushCandidates, pushPayloadFor, POSTER_MAX_BYTES } = app.__test__;

// 1x1 透明 PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('parseImageDataUrl：只接受 JPG／PNG／WebP 的 data URL', () => {
    const png = parseImageDataUrl(`data:image/png;base64,${PNG_1PX}`);
    assert.strictEqual(png.mime, 'image/png');
    assert.ok(png.buffer.length > 10, '應解出實際位元組');

    const jpeg = parseImageDataUrl(`data:image/jpeg;base64,${PNG_1PX}`);
    assert.strictEqual(jpeg.mime, 'image/jpeg');

    const webp = parseImageDataUrl(`data:image/webp;base64,${PNG_1PX}`);
    assert.strictEqual(webp.mime, 'image/webp');

    // 不允許的類型（避免 SVG 腳本、GIF 等）
    assert.strictEqual(parseImageDataUrl(`data:image/svg+xml;base64,${PNG_1PX}`), null, 'SVG 必須被拒絕');
    assert.strictEqual(parseImageDataUrl(`data:image/gif;base64,${PNG_1PX}`), null);

    // 格式錯誤
    assert.strictEqual(parseImageDataUrl('https://example.com/a.png'), null);
    assert.strictEqual(parseImageDataUrl('data:image/png,notbase64'), null);
    assert.strictEqual(parseImageDataUrl('data:image/png;base64,'), null);
    assert.strictEqual(parseImageDataUrl(undefined), null);
    assert.strictEqual(parseImageDataUrl(12345), null);

    // 上限常數存在且合理（前端縮圖後通常遠低於此）
    assert.strictEqual(POSTER_MAX_BYTES, 3 * 1024 * 1024);
});

test('competitionStartMs：以站台時區換算開賽時間', () => {
    const ms = competitionStartMs({ date: '2026-10-01', time: '09:30' }, '+08:00');
    assert.strictEqual(new Date(ms).toISOString(), '2026-10-01T01:30:00.000Z', '應為澳門時間 09:30');

    // 沒填時間 → 當日 00:00（站台時區）
    const noTime = competitionStartMs({ date: '2026-10-01' }, '+08:00');
    assert.strictEqual(new Date(noTime).toISOString(), '2026-09-30T16:00:00.000Z');

    // 時間格式怪異 → 視為 00:00
    const weird = competitionStartMs({ date: '2026-10-01', time: '上午' }, '+08:00');
    assert.strictEqual(weird, noTime);

    // 日期缺漏／無法解析 → null
    assert.strictEqual(competitionStartMs({ time: '09:00' }), null);
    assert.strictEqual(competitionStartMs({ date: 'not-a-date' }), null);
    assert.strictEqual(competitionStartMs(null), null);

    // 含時間戳的 date（Supabase 可能回傳 ISO）也能處理
    const iso = competitionStartMs({ date: '2026-10-01T00:00:00.000Z', time: '09:30' }, '+08:00');
    assert.strictEqual(iso, ms, '只取日期部分');
});

test('pushCandidates：只挑出「24 小時內開賽」與「上次執行後新發布」', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');   // 澳門時間 08:00
    const competitions = [
        { id: 1, name: '12 小時後開賽', date: '2026-10-01', time: '20:00' },          // 12h 後 ✓
        { id: 2, name: '36 小時後開賽', date: '2026-10-02', time: '20:00' },          // 36h 後 ✗
        { id: 3, name: '已開始', date: '2026-09-30', time: '09:00' },                 // 已過 ✗
        { id: 4, name: '已刪除', date: '2026-10-01', time: '10:00', is_deleted: true },
        { id: 5, name: '新發布且明天開賽', date: '2026-10-02', time: '20:00', created_at: '2026-09-30T12:00:00.000Z' },
        { id: 6, name: '舊賽事', date: '2026-12-01', time: '09:00', created_at: '2026-09-01T12:00:00.000Z' }
    ];

    const all = pushCandidates(competitions, {
        now,
        lastRunMs: Date.parse('2026-09-29T00:00:00.000Z'),
        done: new Set(),
        offset: '+08:00'
    });

    const keys = all.map((c) => `${c.competition.id}:${c.kind}`).sort();
    assert.deepStrictEqual(keys, ['1:reminder', '5:new'], JSON.stringify(keys));

    // 已通知過的不再重複
    const deduped = pushCandidates(competitions, {
        now,
        lastRunMs: Date.parse('2026-09-29T00:00:00.000Z'),
        done: new Set(['1:reminder', '5:new']),
        offset: '+08:00'
    });
    assert.strictEqual(deduped.length, 0, '已記錄過的不得重複推播');

    // 沒有 lastRun（第一次執行）→ 不判斷新賽事，只判斷即將開賽
    const firstRun = pushCandidates(competitions, { now, lastRunMs: 0, offset: '+08:00' });
    assert.deepStrictEqual(firstRun.map((c) => `${c.competition.id}:${c.kind}`), ['1:reminder'], '第一次執行不灌「新賽事」通知');

    // 可調整視窗（例如改成 48 小時）
    const wider = pushCandidates(competitions, { now, lastRunMs: 0, windowMs: 48 * 3600 * 1000, offset: '+08:00' });
    const widerIds = wider.map((c) => c.competition.id).sort();
    assert.ok(widerIds.includes(2), '48 小時視窗應含 36 小時後開賽者');
    assert.ok(!widerIds.includes(3), '已開賽的不得入列');

    assert.deepStrictEqual(pushCandidates(null, { now }), []);
});

test('pushPayloadFor：通知文字包含賽事名稱、時間與地點', () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    const startMs = competitionStartMs({ date: '2026-10-01', time: '20:00' }, '+08:00');

    const reminder = pushPayloadFor({ kind: 'reminder', competition: { id: 7, name: '城市盃籃球賽', date: '2026-10-01', time: '20:00', location: '台北體育館' }, startMs }, now);
    assert.match(reminder.title, /即將開賽/);
    assert.match(reminder.title, /城市盃籃球賽/);
    assert.match(reminder.body, /2026-10-01 20:00/);
    assert.match(reminder.body, /台北體育館/);
    assert.match(reminder.body, /12 小時後開始/);
    assert.strictEqual(reminder.url, '/?comp=7');
    assert.strictEqual(reminder.tag, 'cm-reminder-7');

    const fresh = pushPayloadFor({ kind: 'new', competition: { id: 8, name: '春季路跑', date: '2026-11-01', time: '07:00', is_team_event: true } }, now);
    assert.match(fresh.title, /新賽事/);
    assert.match(fresh.title, /春季路跑/);
    assert.match(fresh.body, /組隊比賽/);
    assert.strictEqual(fresh.tag, 'cm-new-8');
});
