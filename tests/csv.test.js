const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CMCSV = require(path.join(__dirname, '..', 'public', 'js', 'csv.js'));

const CATEGORIES = [
    { id: 'ball', label: '球類運動', emoji: '🏀', color: 'blue' },
    { id: 'racket', label: '球拍運動', emoji: '🏸', color: 'indigo' }
];

test('parse：基本、引號、跳脫引號、引號內逗號與換行、CRLF、BOM', () => {
    assert.deepStrictEqual(CMCSV.parse('a,b\n1,2\n').rows, [['a', 'b'], ['1', '2']]);
    assert.deepStrictEqual(CMCSV.parse('a,b\r\n1,2\r\n').rows, [['a', 'b'], ['1', '2']], 'CRLF');
    assert.deepStrictEqual(CMCSV.parse('\uFEFFa,b\n1,2').rows, [['a', 'b'], ['1', '2']], 'BOM 應被去除');
    assert.deepStrictEqual(CMCSV.parse('a,b\n"x,y",2').rows, [['a', 'b'], ['x,y', '2']], '引號內逗號');
    assert.deepStrictEqual(CMCSV.parse('a\n"he said ""hi"""').rows, [['a'], ['he said "hi"']], '"" 跳脫');
    assert.deepStrictEqual(CMCSV.parse('a,b\n"line1\nline2",2').rows, [['a', 'b'], ['line1\nline2', '2']], '引號內換行');
    assert.deepStrictEqual(CMCSV.parse('a,b\n\n1,2\n').rows, [['a', 'b'], ['1', '2']], '空行應被忽略');
    assert.deepStrictEqual(CMCSV.parse('').rows, []);
});

test('parse：自動偵測分隔符（逗號 / 分號 / Tab，Excel 貼上常見）', () => {
    assert.strictEqual(CMCSV.detectDelimiter('a,b,c'), ',');
    assert.strictEqual(CMCSV.detectDelimiter('a;b;c'), ';');
    assert.strictEqual(CMCSV.detectDelimiter('a\tb\tc'), '\t');
    assert.deepStrictEqual(CMCSV.parse('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
    assert.deepStrictEqual(CMCSV.parse('a;b\n1;2').rows, [['a', 'b'], ['1', '2']]);
    // 引號內的逗號不應影響偵測
    assert.strictEqual(CMCSV.detectDelimiter('"a,b";c;d'), ';');
});

test('stringify：跳脫與 BOM、Excel 相容的 CRLF', () => {
    assert.strictEqual(CMCSV.stringify([['a', 'b'], ['1', '2']]), 'a,b\r\n1,2\r\n');
    assert.strictEqual(CMCSV.stringify([['x,y', 'he said "hi"']]), '"x,y","he said ""hi"""\r\n');
    assert.strictEqual(CMCSV.stringify([['a']], { bom: true }).charCodeAt(0), 0xFEFF, '應帶 UTF-8 BOM');
    assert.strictEqual(CMCSV.stringify([], { bom: false }), '\r\n');
});

test('recordsFromParsed：表頭可用中文或英文，未知欄位忽略、缺欄位不報錯', () => {
    const zh = CMCSV.recordsFromParsed(CMCSV.parse('名稱,分類,標籤,地點\n甲賽,球類運動,"a, b",台北'));
    assert.strictEqual(zh.headerMap.name, 0);
    assert.strictEqual(zh.headerMap.category, 1);
    assert.deepStrictEqual(zh.records[0], { name: '甲賽', category: '球類運動', tags: 'a, b', location: '台北' });

    const en = CMCSV.recordsFromParsed(CMCSV.parse('Name,start_date,End Date,開放報名\nX,2026-01-02,2026-01-03,是'));
    assert.strictEqual(en.records[0].name, 'X');
    assert.strictEqual(en.records[0].date, '2026-01-02');
    assert.strictEqual(en.records[0].end_date, '2026-01-03');
    assert.strictEqual(en.records[0].is_registration_open, '是');

    const unknown = CMCSV.recordsFromParsed(CMCSV.parse('名稱,亂七八糟\n甲,zzz'));
    assert.strictEqual(unknown.records[0].name, '甲');
    assert.strictEqual(unknown.records[0]['亂七八糟'], undefined, '未知欄位不應進入記錄');
});

test('normalizeDate：接受常見格式並擋掉不存在的日期', () => {
    assert.strictEqual(CMCSV.normalizeDate('2026-09-25').value, '2026-09-25');
    assert.strictEqual(CMCSV.normalizeDate('2026/9/25').value, '2026-09-25', '斜線與補零');
    assert.strictEqual(CMCSV.normalizeDate('2026年9月25日').value, '2026-09-25', '中文格式');
    assert.strictEqual(CMCSV.normalizeDate('2026.9.25').value, '2026-09-25', '點分隔');
    assert.strictEqual(CMCSV.normalizeDate(''), null, '空值 → null');
    assert.strictEqual(CMCSV.normalizeDate(null), null);
    assert.ok(CMCSV.normalizeDate('2026-02-30').error, '2/30 不存在應報錯');
    assert.ok(CMCSV.normalizeDate('2026-13-01').error);
    assert.ok(CMCSV.normalizeDate('下週三').error);
});

test('normalizeTime：接受 9:00 / 09:00:00 / 9時5分 / 全形冒號', () => {
    assert.strictEqual(CMCSV.normalizeTime('9:00').value, '09:00');
    assert.strictEqual(CMCSV.normalizeTime('09:00:00').value, '09:00');
    assert.strictEqual(CMCSV.normalizeTime('9時5分').value, '09:05');
    assert.strictEqual(CMCSV.normalizeTime('9：30').value, '09:30', '全形冒號');
    assert.strictEqual(CMCSV.normalizeTime(''), null, undefined);
    assert.ok(CMCSV.normalizeTime('25:00').error);
});

test('splitTags：與後端同一套規則（去除 #、去重忽略大小寫、限量）', () => {
    assert.deepStrictEqual(CMCSV.splitTags('國中組, 團體賽、免費; 決賽'), ['國中組', '團體賽', '免費', '決賽']);
    assert.deepStrictEqual(CMCSV.splitTags('#A, a, b'), ['A', 'b']);
    assert.deepStrictEqual(CMCSV.splitTags(''), []);
    assert.strictEqual(CMCSV.splitTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 10);
    assert.strictEqual(CMCSV.splitTags(['x'.repeat(50)])[0].length, 24);
});

test('normalizeRecord：完整一列（分類可用中文標籤、報名狀態各種寫法）', () => {
    const r = CMCSV.normalizeRecord({
        name: '  2026 全國羽球公開賽 ', category: '球拍運動', tags: '國中組, 團體賽', location: ' 台北體育館 ',
        date: '2026/9/25', time: '9:00', end_date: '2026-09-25', end_time: '17:00',
        is_registration_open: '是', description: ' 報名請洽主辦 '
    }, { categories: CATEGORIES });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.name, '2026 全國羽球公開賽', '名稱應去除前後空白');
    assert.strictEqual(r.value.category, 'racket', '中文標籤應轉為 id');
    assert.deepStrictEqual(r.value.tags, ['國中組', '團體賽']);
    assert.strictEqual(r.value.date, '2026-09-25');
    assert.strictEqual(r.value.time, '09:00');
    assert.strictEqual(r.value.is_registration_open, true);
    assert.strictEqual(r.value.description, '報名請洽主辦');
});

test('normalizeRecord：缺名稱與格式錯誤要擋下，無法辨識的分類只警告', () => {
    const noName = CMCSV.normalizeRecord({ date: '2026-09-25' }, { categories: CATEGORIES });
    assert.strictEqual(noName.ok, false);
    assert.ok(noName.errors.some((e) => e.includes('缺少比賽名稱')));

    const badDate = CMCSV.normalizeRecord({ name: '甲', date: '2026-02-30' }, { categories: CATEGORIES });
    assert.strictEqual(badDate.ok, false);
    assert.ok(badDate.errors.some((e) => e.includes('日期不存在')));

    const badCategory = CMCSV.normalizeRecord({ name: '甲', category: '亂打的分類' }, { categories: CATEGORIES });
    assert.strictEqual(badCategory.ok, true, '無法辨識的分類不應讓整筆失敗');
    assert.strictEqual(badCategory.value.category, null);
    assert.ok(badCategory.warnings.some((w) => w.includes('無法辨識的分類')));

    assert.strictEqual(CMCSV.normalizeRecord({ name: '甲', is_registration_open: '否' }, {}).value.is_registration_open, false);
    assert.strictEqual(CMCSV.normalizeRecord({ name: '甲', is_registration_open: '報名中' }, {}).value.is_registration_open, true);
    assert.strictEqual(CMCSV.normalizeRecord({ name: '甲' }, {}).value.is_registration_open, false, '未填視為已截止');
});

test('toExportRows / templateRows：匯出格式與範本', () => {
    const { header, rows } = CMCSV.toExportRows([
        { name: '甲賽', category: 'ball', tags: ['公開組', '免費'], location: '台北', date: '2026-09-25', time: '09:00', end_date: null, end_time: null, is_registration_open: true, description: '說明' }
    ], CATEGORIES);

    assert.deepStrictEqual(header, ['名稱', '分類', '標籤', '地點', '開始日期', '開始時間', '結束日期', '結束時間', '開放報名', '簡介']);
    assert.deepStrictEqual(rows[1], ['甲賽', '球類運動', '公開組, 免費', '台北', '2026-09-25', '09:00', '', '', '是', '說明']);

    const tpl = CMCSV.templateRows();
    assert.strictEqual(tpl.rows.length, 2, '範本應含表頭與一列示範');
    assert.strictEqual(tpl.rows[0].length, tpl.rows[1].length, '示範列的欄位數要與表頭一致');
});

test('匯出後再匯入可還原（round-trip）', () => {
    const source = [{
        name: '測試賽 A', category: 'racket', tags: ['國中組'], location: '高雄', date: '2026-10-05',
        time: '13:30', end_date: '2026-10-06', end_time: '17:00', is_registration_open: true, description: '含,逗號與"引號"'
    }];

    const csv = CMCSV.stringify(CMCSV.toExportRows(source, CATEGORIES).rows);
    const { records } = CMCSV.recordsFromParsed(CMCSV.parse(csv));
    const result = CMCSV.normalizeRecord(records[0], { categories: CATEGORIES });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
        name: '測試賽 A', category: 'racket', tags: ['國中組'], location: '高雄', date: '2026-10-05',
        time: '13:30', end_date: '2026-10-06', end_time: '17:00', description: '含,逗號與"引號"', is_registration_open: true
    });
});

test('v2.12.0 安全性：CSV 公式注入防護（Excel / Google Sheets 不會把內容當公式執行）', () => {
    const csv = CMCSV.stringify([
        ['名稱', '備註'],
        ['=1+1', '=HYPERLINK("http://evil.example")'],
        ['+SUM(A1:A9)', '@cmd'],
        ['-2+3', '-12.5'],
        ['正常賽事名稱', '說明文字']
    ]);

    const lines = csv.split('\r\n').filter((l) => l !== '');
    // 危險前綴一律加上單引號 → 試算表視為文字
    assert.ok(lines[1].startsWith("'=1+1,"), `= 開頭應被消歧：${lines[1]}`);
    assert.ok(lines[2].startsWith("'+SUM"), `+ 開頭應被消歧：${lines[2]}`);
    assert.ok(lines[3].startsWith("'-2+3"), `-算式應被消歧：${lines[3]}`);
    assert.ok(lines[2].includes("'@cmd"), `@ 開頭應被消歧：${lines[2]}`);

    // 純負數維持原樣（避免破壞數字資料）
    assert.ok(lines[3].includes('-12.5'), '純負數不應被加上單引號');
    assert.ok(lines[3].includes("'-12.5") === false);

    // 一般資料不受影響
    assert.ok(lines[4].includes('正常賽事名稱'));
});

test('v2.12.0 安全性：正常資料匯出→匯入仍可往返', () => {
    const source = [{
        name: '2026 全國羽球公開賽', category: 'racket', tags: ['國中組', '團體賽'],
        location: '台北體育館', date: '2026-09-25', time: '09:00',
        end_date: '2026-09-25', end_time: '17:00', description: '報名請洽主辦單位', is_registration_open: true
    }];

    const csv = CMCSV.stringify(CMCSV.toExportRows(source, CATEGORIES).rows);
    const { records } = CMCSV.recordsFromParsed(CMCSV.parse(csv));
    const result = CMCSV.normalizeRecord(records[0], { categories: CATEGORIES });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.name, '2026 全國羽球公開賽');
    assert.strictEqual(result.value.date, '2026-09-25');
    assert.strictEqual(result.value.time, '09:00');
    assert.deepStrictEqual(result.value.tags, ['國中組', '團體賽']);
});

/* v2.22.0：物件列要自動變「表頭 + 資料」（以前會安靜地產生空行 CSV） */
test('stringify：物件列會自動加上表頭（欄位順序照物件）', () => {
    const csv = CMCSV.stringify([
        { 姓名: '王小明', 隊伍: 'A 隊', 狀態: '已核准' },
        { 姓名: '陳大文', 隊伍: 'B 隊', 狀態: '候補' }
    ], { bom: true });
    assert.strictEqual(csv, '\uFEFF姓名,隊伍,狀態\r\n王小明,A 隊,已核准\r\n陳大文,B 隊,候補\r\n');
});

test('stringify：物件列缺欄位留空、多欄位會補進表頭', () => {
    const csv = CMCSV.stringify([
        { 姓名: '甲', 備註: '' },
        { 姓名: '乙', 備註: '=1+1', 候補順位: 2 }
    ]);
    assert.strictEqual(csv, '姓名,備註,候補順位\r\n甲,,\r\n乙,\'=1+1,2\r\n');
});

test('stringify：物件列裡的換行與逗號一樣會被跳脫', () => {
    const csv = CMCSV.stringify([{ a: 'x,y', b: '第一行\n第二行' }]);
    assert.strictEqual(csv, 'a,b\r\n"x,y","第一行\n第二行"\r\n');
});
