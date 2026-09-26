/* v3.2.0（P1-7）：列印版規則的單元測試
 *
 * 這些規則是「印出來那張紙」的唯一真實來源（前端預覽、列印共用），
 * 所以規則要能被測試釘住：印什麼、不印什麼、怎麼排序、怎麼編號、怎麼避免版面被破壞。
 * 跑法：node --test tests/printdoc.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/js/printdoc');

const COMP = {
    id: 900, name: '澳門盃田徑賽', date: '2026-12-01', time: '09:00:00',
    end_date: '2026-12-02', end_time: '17:00:00', location: '澳門運動場',
    category: 'track', is_team_event: false, max_registrations: 12
};

const REGS = [
    { id: 11, username: '陳大文', status: 'confirmed', note: '', team_name: '' },
    { id: 12, username: '林小明', status: 'confirmed', note: '需要輪椅通道', team_name: '' },
    { id: 13, username: '黃小美', status: 'waitlisted', waitlist_order: 2, note: '', team_name: '' },
    { id: 14, username: '李大同', status: 'waitlisted', waitlist_order: 1, note: '', team_name: '' },
    { id: 15, username: '吳小強', status: 'pending', note: '', team_name: '' },
    { id: 16, username: '周小華', status: 'rejected', note: '', team_name: '' },
    { id: 17, username: '鄭小安', status: 'cancelled', note: '', team_name: '' }
];

test('escapeHtml：使用者輸入不會破壞版面', () => {
    assert.strictEqual(P.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.strictEqual(P.escapeHtml('A & B "C" \'D\''), 'A &amp; B &quot;C&quot; &#39;D&#39;');
    assert.strictEqual(P.escapeHtml(null), '');
    assert.strictEqual(P.escapeHtml(0), '0');
});

test('狀態中文標籤', () => {
    assert.strictEqual(P.statusLabel('confirmed'), '已錄取');
    assert.strictEqual(P.statusLabel('waitlisted'), '候補');
    assert.strictEqual(P.statusLabel('pending'), '待審核');
    assert.strictEqual(P.statusLabel('自訂狀態'), '自訂狀態');
    assert.strictEqual(P.resultStatusLabel('dnf'), '未完賽');
    assert.strictEqual(P.resultStatusLabel('dq'), '取消資格');
});

test('賽事抬頭：沒填的欄位不留空標籤', () => {
    const h = P.competitionHeader(COMP);
    assert.strictEqual(h.name, '澳門盃田徑賽');
    assert.strictEqual(h.when, '2026-12-01 09:00 ～ 2026-12-02 17:00');
    assert.strictEqual(h.location, '澳門運動場');
    assert.strictEqual(h.category, '田徑');
    const bare = P.competitionHeader({ name: 'X' });
    assert.strictEqual(bare.when, '');
    assert.strictEqual(bare.location, '');
    const nameless = P.competitionHeader({});
    assert.strictEqual(nameless.name, '（未命名賽事）');
});

test('rosterRows：只把「已錄取」放進正取，其他狀態不會混進去', () => {
    const rows = P.rosterRows(REGS, {});
    assert.deepStrictEqual(rows.confirmed.map((r) => r.name), ['陳大文', '林小明']);
    assert.deepStrictEqual(rows.waitlisted.map((r) => r.name), ['李大同', '黃小美'], '候補依 waitlist_order 排序');
    assert.deepStrictEqual(rows.pending.map((r) => r.name), ['吳小強']);
    // 未錄取與已取消不該出現在任何一段
    const all = [...rows.confirmed, ...rows.waitlisted, ...rows.pending].map((r) => r.name);
    assert.ok(!all.includes('周小華') && !all.includes('鄭小安'));
});

test('rosterRows：候補有自己的順位編號，正取從 1 開始', () => {
    const rows = P.rosterRows(REGS, {});
    assert.deepStrictEqual(rows.confirmed.map((r) => r.no), [1, 2]);
    assert.deepStrictEqual(rows.waitlisted.map((r) => r.wait_number), [1, 2]);
});

test('rosterModel：預設不含待審核，含候補', () => {
    const m = P.rosterModel(COMP, REGS, {}, new Date('2026-09-26T19:05:00'));
    const keys = m.groups.map((g) => g.key);
    assert.deepStrictEqual(keys, ['confirmed', 'waitlist']);
    assert.strictEqual(m.stats.confirmed, 2);
    assert.strictEqual(m.stats.waitlisted, 2);
    assert.strictEqual(m.stats.printed, 4);
    assert.strictEqual(m.stats.free_slots, 10);
    assert.strictEqual(m.printed_at, '2026-09-26 19:05');
});

test('rosterModel：可以排除候補，摘要句不會提到沒印出來的候補', () => {
    const withWait = P.rosterModel(COMP, REGS, { includeWaitlist: true });
    assert.match(P.summaryText(withWait), /候補 2 人/);
    const without = P.rosterModel(COMP, REGS, { includeWaitlist: false });
    assert.deepStrictEqual(without.groups.map((g) => g.key), ['confirmed']);
    assert.strictEqual(without.stats.printed, 2, '紙上只有 2 人');
    assert.ok(!/候補/.test(P.summaryText(without)), '沒印候補就不該說有候補');
});

test('rosterModel：可以選擇印待審核（給需要現場補位的場合）', () => {
    const m = P.rosterModel(COMP, REGS, { includePending: true });
    assert.deepStrictEqual(m.groups.map((g) => g.key), ['confirmed', 'waitlist', 'pending']);
    assert.match(P.summaryText(m), /待審核 1 人/);
});

test('column：簽到欄可以關掉（例如只要一張核對清單）', () => {
    const on = P.rosterModel(COMP, REGS, { signColumn: true });
    const off = P.rosterModel(COMP, REGS, { signColumn: false });
    assert.ok(P.headerCells(on).includes('簽到'));
    assert.ok(!P.headerCells(off).includes('簽到'));
});

test('團體賽：多印一欄隊伍', () => {
    const comp = Object.assign({}, COMP, { is_team_event: true });
    const regs = [{ id: 1, username: '隊長', team_name: '紅隊', status: 'confirmed' }];
    const m = P.rosterModel(comp, regs, {});
    assert.ok(P.headerCells(m).includes('隊伍'));
    assert.ok(P.toHtml(m).includes('紅隊'));
});

test('resultModel：名次排序（沒名次的排最後，顯示 —）', () => {
    const results = [
        { id: 3, username: 'C', rank: 3, score_text: '13:00', status: 'finished' },
        { id: 1, username: 'A', rank: 1, score_text: '12:00', status: 'finished' },
        { id: 4, username: 'D', rank: null, score_text: '', status: 'dnf' },
        { id: 2, username: 'B', rank: 1, score_text: '12:00', status: 'finished' }
    ];
    const m = P.resultModel(COMP, results, {});
    assert.deepStrictEqual(m.groups[0].rows.map((r) => r.name), ['A', 'B', 'C', 'D']);
    // 名次照資料庫存的值印（並列時是 1, 1, 3 這種競賽排名，不重算）
    assert.deepStrictEqual(m.groups[0].rows.map((r) => r.rank), [1, 1, 3, '—']);
    assert.strictEqual(m.stats.total, 4);
    assert.strictEqual(m.stats.finished, 3);
    assert.strictEqual(m.stats.ranked, 3);
});

test('toHtml：表格有表頭、有列印時間、沒有外部資源（CSP 只允許 self）', () => {
    const m = P.rosterModel(COMP, REGS, {}, new Date('2026-09-26T19:05:00'));
    const html = P.toHtml(m);
    assert.ok(html.includes('<thead>') && html.includes('<tbody>'), '要有表頭（每頁重複）與內容');
    assert.ok(html.includes('列印時間：2026-09-26 19:05'));
    assert.ok(html.includes('澳門盃田徑賽') && html.includes('澳門運動場'));
    assert.ok(html.includes('正取名單') && html.includes('候補名單'));
    assert.ok(!/https?:\/\//.test(html), '列印版不連外');
    assert.ok(!/<img|<iframe|<link/i.test(html), '不引入任何外部資源');
});

test('toHtml：惡意名字被轉義（不會在列印頁上執行）', () => {
    const regs = [{ id: 1, username: '<img src=x onerror=alert(1)>', status: 'confirmed' }];
    const html = P.toHtml(P.rosterModel(COMP, regs, {}));
    assert.ok(!html.includes('<img'), '不能有真正的標籤');
    assert.ok(html.includes('&lt;img'));
});

test('toHtml：橫向選項會反映在紙張樣式上', () => {
    const portrait = P.toHtml(P.rosterModel(COMP, REGS, { orientation: 'portrait' }));
    const landscape = P.toHtml(P.rosterModel(COMP, REGS, { orientation: 'landscape' }));
    assert.ok(portrait.includes('print-sheet portrait'));
    assert.ok(landscape.includes('print-sheet landscape'));
});

test('人名與隊名同時存在時，姓名欄以報名者為主', () => {
    const regs = [{ id: 1, username: '王小明', team_name: '藍隊', status: 'confirmed' }];
    const m = P.rosterModel(Object.assign({}, COMP, { is_team_event: true }), regs, {});
    const row = m.groups[0].rows[0];
    assert.strictEqual(row.name, '王小明');
    assert.strictEqual(row.team, '藍隊');
});

test('沒有報名資料時：模型仍然可用（不會爆），只是沒有列', () => {
    const m = P.rosterModel(COMP, [], {});
    assert.strictEqual(m.stats.printed, 0);
    assert.ok(P.toHtml(m).includes('共 0 人'));
    const r = P.resultModel(COMP, null, {});
    assert.strictEqual(r.stats.total, 0);
});
