/* v2.26.0：站內公告的規則（純函式規格書）
 *
 * 這裡驗的是「誰看得到、什麼時候看得到、標題內容怎麼驗」。
 * 一律傳入明確時間與 viewer，不依賴當下時刻。
 */
const test = require('node:test');
const assert = require('node:assert');
const CMAnnouncements = require('../public/js/announcements');

const A = CMAnnouncements;
const T = (iso) => Date.parse(iso);
const NOW = T('2026-09-26T12:00:00Z');

const ann = (over = {}) => Object.assign({
    id: 1, title: '公告', body: '內容', audience: 'all', categories: [],
    is_pinned: false, is_active: true,
    publish_at: '2026-09-26T00:00:00Z', expires_at: null,
    created_at: '2026-09-20T00:00:00Z'
}, over);

const admin = { isAdmin: true, categories: [] };
const runner = { isAdmin: false, categories: ['track'] };
const other = { isAdmin: false, categories: ['esports'] };

/* ── 上下架時間 ── */

test('未下架、已到發布時間、未過期 → 上架中', () => {
    assert.strictEqual(A.isLive(ann(), NOW), true);
});

test('下架（is_active=false）→ 不上架，即使時間都對', () => {
    assert.strictEqual(A.isLive(ann({ is_active: false }), NOW), false);
});

test('預約發布：發布時間那一秒之前看不到、那一秒起看得到', () => {
    const future = ann({ publish_at: '2026-09-26T12:00:01Z' });
    assert.strictEqual(A.isLive(future, NOW), false, '發布前 1 秒不該看到');
    assert.strictEqual(A.isLive(future, T('2026-09-26T12:00:01Z')), true, '發布那一秒起應該看到');
});

test('到期：到期那一刻即下架（含邊界）', () => {
    const expiring = ann({ expires_at: '2026-09-26T12:00:00Z' });
    assert.strictEqual(A.isLive(expiring, NOW - 1), true, '到期前 1 毫秒仍看得到');
    assert.strictEqual(A.isLive(expiring, NOW), false, '到期那一刻就下架');
});

test('沒有 publish_at 時用 created_at 判斷（舊資料也能用）', () => {
    const legacy = ann({ publish_at: null, created_at: '2026-09-25T00:00:00Z' });
    assert.strictEqual(A.isLive(legacy, NOW), true);
    const notYet = ann({ publish_at: null, created_at: '2026-09-27T00:00:00Z' });
    assert.strictEqual(A.isLive(notYet, NOW), false);
});

/* ── 對象 ── */

test('對象 all：所有人（含管理員）都看得到', () => {
    assert.strictEqual(A.matchesAudience(ann(), admin), true);
    assert.strictEqual(A.matchesAudience(ann(), runner), true);
    assert.strictEqual(A.matchesAudience(ann(), {}), true);
});

test('對象 admin：只有管理員以上看得到', () => {
    const adminOnly = ann({ audience: 'admin' });
    assert.strictEqual(A.matchesAudience(adminOnly, admin), true);
    assert.strictEqual(A.matchesAudience(adminOnly, runner), false);
});

test('對象 category：訂閱的分類有交集才看得到（通知對象是嚴格的）', () => {
    const road = ann({ audience: 'category', categories: ['track'] });
    assert.strictEqual(A.matchesAudience(road, runner), true, '訂閱田徑路跑的人看得到');
    assert.strictEqual(A.matchesAudience(road, other), false, '訂閱電競的人看不到');
    assert.strictEqual(A.matchesAudience(road, { isAdmin: true, categories: [] }), false,
        '管理員沒訂閱該分類就不會收到「通知」（推播要送對人）');
});

test('但管理員在訊息中心看得到全部上架中的公告（含分類公告）', () => {
    const road = ann({ audience: 'category', categories: ['track'] });
    assert.strictEqual(A.isVisibleTo(road, admin, NOW), true, '管理員剛發布的公告不該自己看不到');
    assert.strictEqual(A.isVisibleTo(road, runner, NOW), true);
    assert.strictEqual(A.isVisibleTo(road, other, NOW), false);
    assert.strictEqual(A.isVisibleTo(ann({ is_active: false }), admin, NOW), false, '下架的連管理員也看不到');
    assert.strictEqual(A.isVisibleTo(ann({ publish_at: '2026-09-27T00:00:00Z' }), admin, NOW), false, '預約中的也一樣');
});

test('對象 category：多個分類只要中一個就算', () => {
    const multi = ann({ audience: 'category', categories: ['track', 'esports'] });
    assert.strictEqual(A.matchesAudience(multi, runner), true);
    assert.strictEqual(A.matchesAudience(multi, other), true);
    assert.strictEqual(A.matchesAudience(multi, { isAdmin: false, categories: ['mind'] }), false);
});

test('對象 category 但沒指定分類 → 誰都看不到（防呆）', () => {
    const broken = ann({ audience: 'category', categories: [] });
    assert.strictEqual(A.matchesAudience(broken, runner), false);
    assert.strictEqual(A.matchesAudience(broken, admin), false);
});

test('對象值壞掉時保守當成 all（不會因為一個壞值讓公告消失）', () => {
    assert.strictEqual(A.matchesAudience(ann({ audience: 'everyone' }), runner), true);
});

test('viewer 沒有 categories 欄位不會爆', () => {
    const road = ann({ audience: 'category', categories: ['track'] });
    assert.strictEqual(A.matchesAudience(road, undefined), false);
    assert.strictEqual(A.matchesAudience(road, { isAdmin: true }), false);
});

/* ── 列表／排序／未讀 ── */

test('visibleFor：時間與對象都要成立', () => {
    const list = [
        ann({ id: 1, audience: 'all' }),
        ann({ id: 2, audience: 'admin' }),
        ann({ id: 3, audience: 'category', categories: ['track'] }),
        ann({ id: 4, audience: 'all', is_active: false }),
        ann({ id: 5, audience: 'all', publish_at: '2026-09-27T00:00:00Z' })
    ];
    assert.deepStrictEqual(A.visibleFor(list, runner, NOW).map((a) => a.id), [1, 3]);
    assert.deepStrictEqual(A.visibleFor(list, admin, NOW).map((a) => a.id), [1, 2, 3],
        '管理員看得到全部上架中的（下架與預約中的仍然看不到）');
});

test('排序：置頂在前，其次發布時間新的在前，最後用 id 穩定排序', () => {
    const list = [
        ann({ id: 1, publish_at: '2026-09-25T00:00:00Z' }),
        ann({ id: 2, publish_at: '2026-09-26T00:00:00Z', is_pinned: true }),
        ann({ id: 3, publish_at: '2026-09-26T06:00:00Z' }),
        ann({ id: 4, publish_at: '2026-09-26T06:00:00Z' })
    ];
    assert.deepStrictEqual(A.sortForDisplay(list).map((a) => a.id), [2, 4, 3, 1]);
});

test('未讀數：reads 支援陣列、物件與 Set；沒有 id 的一律算未讀', () => {
    const list = [ann({ id: 1 }), ann({ id: 2 }), ann({ id: 3 })];
    assert.strictEqual(A.unreadCount(list, [1, 2]), 1);
    assert.strictEqual(A.unreadCount(list, { 1: true, 2: false }), 2);
    assert.strictEqual(A.unreadCount(list, new Set(['1', '2', '3'])), 0);
    assert.strictEqual(A.unreadCount([{ title: '沒有 id' }], []), 1);
});

test('isRead 用字串比對（資料庫回字串、前端有時是數字）', () => {
    assert.strictEqual(A.isRead(ann({ id: 7 }), ['7']), true);
    assert.strictEqual(A.isRead(ann({ id: '7' }), [7]), true);
});

/* ── 發布前驗證 ── */

test('標題與內容必填、長度上限', () => {
    assert.ok(A.normalizeInput({ title: '  ', body: '內容' }).error);
    assert.ok(A.normalizeInput({ title: '標題', body: '   ' }).error);
    assert.ok(A.normalizeInput({ title: 'x'.repeat(A.TITLE_MAX + 1), body: '內容' }).error);
    assert.ok(A.normalizeInput({ title: '標題', body: 'x'.repeat(A.BODY_MAX + 1) }).error);
});

test('對象只能是三種；分類公告必須選分類', () => {
    assert.ok(A.normalizeInput({ title: 't', body: 'b', audience: 'nobody' }).error);
    assert.strictEqual(A.normalizeInput({ title: 't', body: 'b' }).value.audience, 'all',
        '沒帶對象時當成所有使用者（不是錯誤，也不要偷偷變成別的值）');
    const missing = A.normalizeInput({ title: 't', body: 'b', audience: 'category', categories: [] });
    assert.ok(missing.error, '分類公告沒選分類要擋下來');
});

test('分類會過濾掉不存在的值並去重；非分類公告一律清空分類', () => {
    const ok = A.normalizeInput({
        title: 't', body: 'b', audience: 'category',
        categories: ['track', 'track', '不存在的', 'esports']
    }, ['track', 'esports', 'mind']);
    assert.deepStrictEqual(ok.value.categories, ['track', 'esports']);

    const all = A.normalizeInput({ title: 't', body: 'b', audience: 'all', categories: ['track'] }, ['track']);
    assert.deepStrictEqual(all.value.categories, [], '非分類公告不該留下分類殘值');
});

test('時間驗證：格式錯要擋、結束時間必須晚於發布時間', () => {
    assert.ok(A.normalizeInput({ title: 't', body: 'b', publish_at: '下週三' }).error);
    assert.ok(A.normalizeInput({ title: 't', body: 'b', expires_at: '不是時間' }).error);
    const bad = A.normalizeInput({
        title: 't', body: 'b', publish_at: '2026-09-26T12:00:00Z', expires_at: '2026-09-26T12:00:00Z'
    });
    assert.ok(bad.error, '結束時間等於發布時間要擋下來');
});

test('沒帶發布時間 → 立即發布；布林值只有明確 true 才算', () => {
    const out = A.normalizeInput({ title: ' 標題 ', body: ' 內容 ' }, [], NOW);
    assert.strictEqual(out.value.title, '標題', '前後空白要修掉');
    assert.strictEqual(out.value.publish_at, new Date(NOW).toISOString());
    assert.strictEqual(out.value.is_pinned, false);
    assert.strictEqual(out.value.notify_push, false);
    assert.strictEqual(out.value.is_active, true);

    const flagged = A.normalizeInput({ title: 't', body: 'b', is_pinned: 'true', notify_push: 1 }, [], NOW);
    assert.strictEqual(flagged.value.is_pinned, false, '字串 "true" 不算（前端一律送布林）');
    assert.strictEqual(flagged.value.notify_push, false);
});

test('可以發布成「先下架」狀態（先寫好、之後再上架）', () => {
    const out = A.normalizeInput({ title: 't', body: 'b', is_active: false }, [], NOW);
    assert.strictEqual(out.value.is_active, false);
});

test('物件標籤：三種對象都有中文說明', () => {
    assert.strictEqual(A.audienceLabel('all'), '所有使用者');
    assert.strictEqual(A.audienceLabel('admin'), '管理員以上');
    assert.strictEqual(A.audienceLabel('category'), '特定分類訂閱者');
});
