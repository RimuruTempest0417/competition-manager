/* v3.9.0：系列賽總積分與賽事回顧報告的算法
 *
 * 這些數字會直接印在排行榜與回顧報告上，算錯比不做還糟 → 每一條規則都釘住。
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/js/competition-state');
const F = require('../public/js/form-fields');

const ROWS = [
    { competition_id: 1, user_id: 1, username: '阿明', rank: 1, date: '2026-09-01' },
    { competition_id: 1, user_id: 2, username: '阿華', rank: 2, date: '2026-09-01' },
    { competition_id: 2, user_id: 1, username: '阿明', rank: 3, date: '2026-09-08' },
    { competition_id: 2, user_id: 2, username: '阿華', rank: 1, date: '2026-09-08' },
    { competition_id: 2, user_id: 3, username: '小美', rank: 9, date: '2026-09-08' }
];

test('積分表：名次超出表外給 0 分（不要給安慰分數，那會讓排行榜看起來人人有分）', () => {
    const cfg = { points: [10, 8, 6, 5] };
    assert.strictEqual(S.pointsForRank(cfg, 1), 10);
    assert.strictEqual(S.pointsForRank(cfg, 4), 5);
    assert.strictEqual(S.pointsForRank(cfg, 5), 0);
    assert.strictEqual(S.pointsForRank(cfg, 0), 0);
    assert.strictEqual(S.pointsForRank(cfg, null), 0);
});

test('預設積分表：第 1～8 名 10/8/6/5/4/3/2/1', () => {
    assert.deepStrictEqual(S.DEFAULT_SERIES_POINTS, [10, 8, 6, 5, 4, 3, 2, 1]);
    assert.deepStrictEqual(S.normalizeSeriesPoints(null).points, S.DEFAULT_SERIES_POINTS);
});

test('排行：總分高的在前，同分比最佳名次，再同比名字（結果必須穩定）', () => {
    const st = S.seriesStandings(ROWS, { config: { points: [10, 8, 6, 5] }, raceCount: 2 });
    assert.deepStrictEqual(st.rows.map((r) => r.username), ['阿華', '阿明', '小美']);
    assert.strictEqual(st.rows[0].total, 18, '阿華＝第1名10＋第2名8');
    assert.strictEqual(st.rows[1].total, 16, '阿明＝第1名10＋第3名6');
    assert.strictEqual(st.rows[2].total, 0, '小美第9名超出積分表');
    assert.strictEqual(st.rows[0].best_rank, 1);
    assert.strictEqual(st.rows[0].podiums, 2);
});

test('count_best：只取最好的 N 場計分，但每一場還是都要列出來', () => {
    const st = S.seriesStandings(ROWS, { config: { points: [10, 8, 6, 5], count_best: 1 }, raceCount: 2 });
    const ming = st.rows.find((r) => r.username === '阿明');
    assert.strictEqual(ming.total, 10, '只算最好的那場');
    assert.strictEqual(ming.counted, 1);
    assert.strictEqual(ming.races.length, 2, '兩場的出賽紀錄都要留著');
});

test('沒有成績的系列回得出空排行（不是錯誤）', () => {
    const st = S.seriesStandings([], { config: null, raceCount: 3 });
    assert.deepStrictEqual(st.rows, []);
    assert.strictEqual(st.race_count, 3);
    assert.deepStrictEqual(st.config.points, S.DEFAULT_SERIES_POINTS);
});

test('回顧報告：人數、到場率、頒獎台、文字摘要', () => {
    const review = S.competitionReview({
        competition: { name: '秋季盃', date: '2026-09-01', location: '澳門' },
        registrations: [
            { status: 'confirmed', attended_at: '2026-09-01T01:00:00Z' },
            { status: 'confirmed', attended_at: null },
            { status: 'waitlisted' },
            { status: 'pending' },
            { status: 'rejected' },
            { status: 'confirmed', is_deleted: true }
        ],
        results: [
            { status: 'finished', rank: 1, username: '阿明', score_text: '12.5' },
            { status: 'finished', rank: 2, username: '阿華', score_text: '11.0' },
            { status: 'hidden', rank: 3, username: '不該出現' }
        ]
    });
    assert.deepStrictEqual(review.signups, { total: 5, confirmed: 2, waitlisted: 1, pending: 1, rejected: 1 });
    assert.strictEqual(review.attendance.attended, 1);
    assert.strictEqual(review.attendance.base, 2);
    assert.strictEqual(review.attendance.rate, 50);
    assert.deepStrictEqual(review.results.podium.map((r) => r.username), ['阿明', '阿華']);
    assert.match(review.headline, /秋季盃/);
    assert.match(review.headline, /50%/);
});

test('回顧報告：有正取但沒人簽到＝0%（真的沒人來）；沒人正取才算不出來（null）', () => {
    const noneCame = S.competitionReview({
        competition: { name: '測試賽' },
        registrations: [{ status: 'confirmed' }],
        results: []
    });
    assert.strictEqual(noneCame.attendance.rate, 0, '有 1 人正取、0 人到場＝0%');
    assert.strictEqual(noneCame.attendance.attended, 0);

    const nobody = S.competitionReview({
        competition: { name: '還沒有人報名' },
        registrations: [{ status: 'waitlisted' }],
        results: []
    });
    assert.strictEqual(nobody.attendance.rate, null, '沒有正取就沒有分母，不要瞎掰一個 0%');
});

test('顯示：選填的勾選框沒勾，不該在名單摘要裡顯示成「否」', () => {
    const fields = F.normalizeFields([{ label: '素食', type: 'checkbox' }, { label: '已繳費', type: 'checkbox' }]);
    assert.strictEqual(F.answersSummary(fields, {}), '', '沒提供資訊 ≠ 回答否');
    assert.strictEqual(F.answersSummary(fields, { [fields[1].key]: true }), '已繳費：是');
    assert.strictEqual(F.answerText(fields[0], false), '否', '但 CSV 逐欄輸出時仍要有值');
});
