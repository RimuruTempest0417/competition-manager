/* v3.1.0：賽事成績規則的規格書（純函式） */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/js/results');

test('狀態固定五種，順序是「完賽→未完賽→未出賽→取消資格→其他」', () => {
    assert.deepStrictEqual(R.RESULT_STATUSES.map((s) => s.id), ['finished', 'dnf', 'dns', 'dsq', 'other']);
    assert.deepStrictEqual(R.RESULT_STATUSES.map((s) => s.label), ['完賽', '未完賽', '未出賽', '取消資格', '其他']);
    assert.ok(R.RESULT_STATUSES.every((s) => s.emoji), '每個狀態都要有圖示');
    assert.strictEqual(R.DEFAULT_STATUS, 'other');
    assert.strictEqual(R.RANKED_STATUS, 'finished');
});

test('狀態驗證：看不懂的狀態一律落在「其他」，不會被當成完賽', () => {
    assert.strictEqual(R.isValidStatus('finished'), true);
    assert.strictEqual(R.isValidStatus('DSQ'), false, '驗證用大寫不算有效');
    assert.strictEqual(R.normalizeStatus('DSQ'), 'dsq', '正規化才會轉小寫');
    assert.strictEqual(R.normalizeStatus('完成'), 'other');
    assert.strictEqual(R.normalizeStatus(undefined), 'other');
    assert.strictEqual(R.normalizeStatus(''), 'other');
    assert.strictEqual(R.statusLabel('dnf'), '🚫 未完賽');
});

test('成績文字整理：去空白、壓縮、上限 60 字；空字串＝null', () => {
    assert.strictEqual(R.normalizeScoreText('  12:34.56  '), '12:34.56');
    assert.strictEqual(R.normalizeScoreText('  85   分  '), '85 分');
    assert.strictEqual(R.normalizeScoreText('   '), null);
    assert.strictEqual(R.normalizeScoreText(null), null);
    assert.strictEqual(R.normalizeScoreText('x'.repeat(80)).length, 60);
    assert.strictEqual(R.displayScore(null), '—');
});

test('parseScoreValue：時間換算成秒（含時、含小數）', () => {
    assert.deepStrictEqual(R.parseScoreValue('12:34'), { kind: 'time', value: 754, text: '12:34' });
    assert.deepStrictEqual(R.parseScoreValue('12:34.5'), { kind: 'time', value: 754.5, text: '12:34.5' });
    assert.deepStrictEqual(R.parseScoreValue('1:02:03'), { kind: 'time', value: 3723, text: '1:02:03' });
    assert.strictEqual(R.parseScoreValue('2:03:04.25').value, 7384.25);
    assert.strictEqual(R.parseScoreValue('59.9').kind, 'number', '59.9 沒有冒號，是數字');
    assert.strictEqual(R.parseScoreValue('59.9').value, 59.9);
});

test('parseScoreValue：純數字與負數', () => {
    assert.deepStrictEqual(R.parseScoreValue('85'), { kind: 'number', value: 85, text: '85' });
    assert.strictEqual(R.parseScoreValue('85.5').value, 85.5);
    assert.strictEqual(R.parseScoreValue('-3').value, -3);
});

test('parseScoreValue：看不懂的一律 null，不會被當成 0 排第一名', () => {
    ['', '   ', '未完成', '3–2', '85 分', '12:99', 'abc', '1.2.3'].forEach((bad) => {
        assert.strictEqual(R.parseScoreValue(bad), null, `「${bad}」不該被解析成數值`);
    });
    assert.strictEqual(R.parseScoreValue(null), null);
});

test('isRankable：只有完賽且有看得懂的成績才進名次', () => {
    assert.strictEqual(R.isRankable({ status: 'finished', score_text: '12:34' }), true);
    assert.strictEqual(R.isRankable({ status: 'dnf', score_text: '12:34' }), false);
    assert.strictEqual(R.isRankable({ status: 'finished', score_text: '未完成' }), false);
    assert.strictEqual(R.isRankable({ status: 'finished', score_text: '' }), false);
});

test('autoRank：時間越小越好，並列同名次（1, 1, 3）', () => {
    const rows = [
        { registration_id: 1, name: 'A', status: 'finished', score_text: '13:00' },
        { registration_id: 2, name: 'B', status: 'finished', score_text: '12:00' },
        { registration_id: 3, name: 'C', status: 'finished', score_text: '12:00' },
        { registration_id: 4, name: 'D', status: 'finished', score_text: '14:00' }
    ];
    const out = R.autoRank(rows);
    const rankOf = (id) => out.find((r) => r.registration_id === id).rank;
    assert.strictEqual(rankOf(2), 1);
    assert.strictEqual(rankOf(3), 1, '同分並列第一');
    assert.strictEqual(rankOf(1), 3, '並列之後跳號（1, 1, 3），不是 1, 1, 2');
    assert.strictEqual(rankOf(4), 4);
    assert.strictEqual(rows[0].rank, undefined, '不可以改動傳進來的陣列');
});

test('autoRank：分數類可以切「越大越好」；不可排名者名次為 null', () => {
    const rows = [
        { id: 1, status: 'finished', score_text: '85' },
        { id: 2, status: 'finished', score_text: '92' },
        { id: 3, status: 'dnf', score_text: '88' },
        { id: 4, status: 'finished', score_text: '未完成' }
    ];
    const out = R.autoRank(rows, { order: 'desc' });
    const rankOf = (id) => out.find((r) => r.id === id).rank;
    assert.strictEqual(rankOf(2), 1);
    assert.strictEqual(rankOf(1), 2);
    assert.strictEqual(rankOf(3), null, '未完賽不排名');
    assert.strictEqual(rankOf(4), null, '成績看不懂不排名（不會被當 0）');
});

test('autoRank：空清單、非陣列都不炸', () => {
    assert.deepStrictEqual(R.autoRank([]), []);
    assert.deepStrictEqual(R.autoRank(null), []);
    assert.deepStrictEqual(R.autoRank(undefined), []);
});

test('autoRank：純秒數與 mm:ss 混用時仍能正確比較（兩者都是秒）', () => {
    const out = R.autoRank([
        { id: 1, status: 'finished', score_text: '1:02.5' },
        { id: 2, status: 'finished', score_text: '59.9' },
        { id: 3, status: 'finished', score_text: '1:05' }
    ]);
    const rankOf = (id) => out.find((r) => r.id === id).rank;
    assert.strictEqual(rankOf(2), 1, '59.9 秒快於 1:02.5');
    assert.strictEqual(rankOf(1), 2);
    assert.strictEqual(rankOf(3), 3);
});

test('名次與獎牌顯示', () => {
    assert.strictEqual(R.medalFor(1), '🥇');
    assert.strictEqual(R.medalFor(2), '🥈');
    assert.strictEqual(R.medalFor(3), '🥉');
    assert.strictEqual(R.medalFor(4), '');
    assert.strictEqual(R.medalFor(null), '');
    assert.strictEqual(R.formatRank(1), '第 1 名');
    assert.strictEqual(R.formatRank(0), '—');
    assert.strictEqual(R.formatRank(null), '—');
    assert.strictEqual(R.formatRank('abc'), '—');
});

test('resultLine：有名次顯示名次＋成績；沒名次只顯示狀態', () => {
    assert.strictEqual(R.resultLine({ rank: 1, status: 'finished', score_text: '12:34' }), '第 1 名 · 12:34');
    assert.strictEqual(R.resultLine({ rank: null, status: 'dnf', score_text: '12:34' }), '🚫 未完賽');
    assert.strictEqual(R.resultLine({ rank: null, status: 'finished', score_text: '' }), '—');
});

test('排序：名次前面，沒名次的按狀態；並列同名次仍為穩定輸出', () => {
    const rows = [
        { id: 1, rank: null, status: 'dnf', username: 'z' },
        { id: 2, rank: 3, status: 'finished', username: 'c' },
        { id: 3, rank: 1, status: 'finished', username: 'a' },
        { id: 4, rank: 1, status: 'finished', username: 'b' }
    ];
    const out = R.sortResults(rows);
    assert.deepStrictEqual(out.map((r) => r.id), [3, 4, 2, 1]);
    assert.strictEqual(rows[0].id, 1, '不可以改動傳進來的陣列');
});

test('summarize：統計各狀態人數、完賽率與前三名', () => {
    const rows = [
        { rank: 1, status: 'finished', score_text: '10:00', username: 'a' },
        { rank: 2, status: 'finished', score_text: '11:00', username: 'b' },
        { rank: 3, status: 'finished', score_text: '12:00', username: 'c' },
        { rank: 4, status: 'finished', score_text: '13:00', username: 'd' },
        { rank: null, status: 'dnf', score_text: '', username: 'e' }
    ];
    const s = R.summarize(rows);
    assert.strictEqual(s.total, 5);
    assert.strictEqual(s.finished, 4);
    assert.strictEqual(s.ranked, 4);
    assert.strictEqual(s.unranked, 1);
    assert.strictEqual(s.finish_rate, 80);
    assert.deepStrictEqual(s.podium.map((p) => p.rank), [1, 2, 3]);
    assert.strictEqual(s.podium[0].medal, '🥇');
    assert.strictEqual(s.podium[0].score, '10:00');
    assert.strictEqual(s.by_status.dnf, 1);
});

test('summarize：沒有成績時完賽率是 0，不是 100', () => {
    assert.strictEqual(R.summarize([]).finish_rate, 0);
    assert.strictEqual(R.summarize([]).total, 0);
    assert.deepStrictEqual(R.summarize(null).podium, []);
});

test('公布前檢查：缺成績的人會被列出來，ready 只在「全都登錄」時為 true', () => {
    const approved = [
        { id: 11, username: 'a' },
        { id: 12, username: 'b' },
        { id: 13, username: 'c' }
    ];
    const results = [
        { registration_id: 11, rank: 1, status: 'finished' },
        { registration_id: 12, rank: 2, status: 'finished' }
    ];
    const check = R.publishChecklist(approved, results);
    assert.strictEqual(check.approved, 3);
    assert.strictEqual(check.recorded, 2);
    assert.strictEqual(check.missing_count, 1);
    assert.deepStrictEqual(check.missing.map((m) => m.username), ['c']);
    assert.strictEqual(check.ready, false);

    const complete = R.publishChecklist(approved, results.concat([{ registration_id: 13, rank: 3, status: 'finished' }]));
    assert.strictEqual(complete.ready, true);
    assert.strictEqual(complete.missing_count, 0);
});

test('公布前檢查：重複名次與跳號只是提示（並列 1,1,3 的跳號不算異常）', () => {
    const dup = R.publishChecklist([], [
        { registration_id: 1, rank: 1 }, { registration_id: 2, rank: 1 }, { registration_id: 3, rank: 1 }
    ]);
    assert.deepStrictEqual(dup.duplicate_ranks, [{ rank: 1, count: 3 }]);

    const tieGap = R.publishChecklist([], [
        { registration_id: 1, rank: 1 }, { registration_id: 2, rank: 1 }, { registration_id: 3, rank: 3 }
    ]);
    assert.deepStrictEqual(tieGap.rank_gaps, [], '並列後的跳號是正常的');

    const realGap = R.publishChecklist([], [
        { registration_id: 1, rank: 1 }, { registration_id: 2, rank: 4 }
    ]);
    assert.deepStrictEqual(realGap.rank_gaps, [4], '沒有並列卻跳號才是要注意的');

    const none = R.publishChecklist([], []);
    assert.strictEqual(none.ready, false, '一個人都沒有時不該說可以公布');
});

test('輸入驗證：正常情況', () => {
    const r = R.normalizeResultInput({
        registration_id: 21, user_id: 5, username: 'gary', display_name: '  Gary  ', rank: 1,
        status: 'finished', score_text: '  12:34.5  ', note: '  場地溼滑  '
    });
    assert.strictEqual(r.error, undefined);
    assert.deepStrictEqual(r.value, {
        registration_id: 21, user_id: 5, username: 'gary', display_name: 'Gary',
        status: 'finished', score_text: '12:34.5', rank: 1, note: '場地溼滑'
    });
});

test('輸入驗證：缺報名紀錄、名次不是正整數、備註太長都要明講', () => {
    assert.match(R.normalizeResultInput({}).error, /registration_id/);
    assert.match(R.normalizeResultInput({ registration_id: 0 }).error, /registration_id/);
    assert.match(R.normalizeResultInput({ registration_id: 5, rank: 'abc' }).error, /名次/);
    assert.match(R.normalizeResultInput({ registration_id: 5, rank: -1 }).error, /名次/);
    assert.match(R.normalizeResultInput({ registration_id: 5, note: 'x'.repeat(201) }).error, /200/);
});

test('輸入驗證：沒帶的名次／成績／備註收斂成 null，狀態看不懂變「其他」', () => {
    const r = R.normalizeResultInput({ registration_id: 7, status: '完成', score_text: '   ', rank: '', note: '' });
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.value.rank, null);
    assert.strictEqual(r.value.score_text, null);
    assert.strictEqual(r.value.note, null);
    assert.strictEqual(r.value.status, 'other');
    assert.strictEqual(r.value.user_id, null);
});

test('公布摘要文字：壓縮空白、空字串＝null、上限 500 字', () => {
    assert.strictEqual(R.normalizeSummary('  計時賽，取最佳成績  '), '計時賽，取最佳成績');
    assert.strictEqual(R.normalizeSummary('   '), null);
    assert.strictEqual(R.normalizeSummary('x'.repeat(600)).length, 500);
    assert.strictEqual(R.SUMMARY_MAX, 500);
});

test('CSV 匯出：欄位固定、名次空白不寫 0、狀態是中文', () => {
    const rows = R.csvRows([
        { rank: null, status: 'dnf', score_text: '', username: 'e', display_name: 'E' },
        { rank: 1, status: 'finished', score_text: '10:00', username: 'a', display_name: '甲' }
    ]);
    assert.deepStrictEqual(rows[0], ['名次', '成績', '狀態', '姓名', '備註']);
    assert.deepStrictEqual(rows[1], [1, '10:00', '🏁 完賽', '甲', '']);
    assert.deepStrictEqual(rows[2], ['', '', '🚫 未完賽', 'E', '']);
});
