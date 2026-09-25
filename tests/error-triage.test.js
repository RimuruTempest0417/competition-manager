/* v2.14.0：錯誤日誌自動巡檢的純函式測試
   - classify：錯誤類型 → 中文說明、建議動作、優先度
   - groupErrorLogs：分組統計（次數、未處理、近 24 小時、首末時間、嚴重程度、範例訊息）
   - renderSection：產生的 Markdown（含「新增 / 已排入 Roadmap」判斷）
   - replaceSection：以標題為界取代整節，且不動到後面的章節 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const triage = require(path.join(__dirname, '..', 'scripts', 'error-log-triage.js'));
const { classify, groupErrorLogs, renderSection, replaceSection, SECTION_HEADING } = triage;

const NOW = new Date('2026-09-26T12:00:00+08:00').getTime();
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();

test('v2.14.0 錯誤分類：已知類型與未知類型', () => {
    assert.strictEqual(classify('unhandled_server_error').priority, '高');
    assert.strictEqual(classify('login_error').label, '帳號流程錯誤');
    assert.match(classify('fetch_error_logs_error').label, /讀取資料失敗/);
    assert.strictEqual(classify('auth_invalid_token').priority, '低');
    assert.match(classify('login_lockout').label, /安全事件/);
    assert.match(classify('push_send_error').label, /推播/);
    assert.match(classify('js_runtime_issue').label, /前端/);
    assert.match(classify('something_new').label, /其他/);
    // 訊息含 migration 關鍵字時，即使類型未知也要判為 migration 問題
    assert.strictEqual(classify('weird_type', "column error_logs.resolved does not exist").priority, '高');
});

test('v2.14.0 分組統計：次數、未處理、時間窗與排序', () => {
    const logs = [
        { error_type: 'unhandled_server_error', message: 'boom', created_at: ago(1), resolved: false, severity: 'error', path: '/api/x' },
        { error_type: 'unhandled_server_error', message: 'boom2', created_at: ago(30), resolved: true, severity: 'error', path: '/api/x' },
        { error_type: 'unhandled_server_error', message: 'boom3', created_at: ago(200), resolved: false, severity: 'warn', path: '/api/y' },
        { error_type: 'auth_invalid_token', message: 'token', created_at: ago(2), resolved: false, severity: 'warn', path: '/api/z' }
    ];
    const groups = groupErrorLogs(logs, NOW);
    assert.strictEqual(groups.length, 2);

    const server = groups.find((g) => g.error_type === 'unhandled_server_error');
    assert.strictEqual(server.count, 3);
    assert.strictEqual(server.unresolved, 2);
    assert.strictEqual(server.last24h, 1, '只有 1 筆在 24 小時內');
    assert.strictEqual(server.last7d, 2, '30 小時內外的差別');
    assert.strictEqual(server.severities.error, 2);
    assert.strictEqual(server.severities.warn, 1);
    assert.strictEqual(server.sample, 'boom', '範例訊息取第一筆');
    assert.strictEqual(server.top_path, '/api/x', '統計最常見路徑');
    assert.ok(server.first_at < server.last_at, '首次發生應早於最後發生');

    // 排序：未處理多的優先
    assert.strictEqual(groups[0].error_type, 'unhandled_server_error');
    // 空輸入不應拋錯
    assert.deepStrictEqual(groupErrorLogs([], NOW), []);
    assert.deepStrictEqual(groupErrorLogs(undefined, NOW), []);
});

test('v2.14.0 產生章節：狀態標示與 Roadmap 比對', () => {
    const logs = [
        { error_type: 'unhandled_server_error', message: 'Bad thing happened', created_at: ago(1), resolved: false, severity: 'error', path: '/api/a' },
        { error_type: 'auth_invalid_token', message: 'expired', created_at: ago(3), resolved: true, severity: 'warn', path: '/api/b' }
    ];
    const groups = groupErrorLogs(logs, NOW);

    // 未提及該類型時 → 標為「新增」
    const fresh = renderSection(groups, '## 八、未來更新方向（Roadmap）\n\n一些內容', NOW);
    assert.ok(fresh.startsWith(SECTION_HEADING));
    assert.match(fresh, /需要處理的問題/);
    assert.match(fresh, /\*\*新增\*\*/);
    assert.match(fresh, /unhandled_server_error/);
    assert.match(fresh, /\*\*統計\*\*：共 2 種錯誤類型、2 筆紀錄，其中未處理 1 筆。/);

    // Roadmap 已提及時 → 標為「已排入 Roadmap」
    const known = renderSection(groups, '已規劃：unhandled_server_error 的處理方式', NOW);
    assert.match(known, /已排入 Roadmap/);
    assert.ok(!/\*\*新增\*\*/.test(known));

    // 低優先且已處理的類型應落到 9.2
    assert.match(known, /9\.2 低優先／僅供觀察/);
    assert.match(known, /auth_invalid_token/);

    // 沒有任何日誌
    const emptySection = renderSection([], '', NOW);
    assert.match(emptySection, /目前沒有任何錯誤日誌紀錄/);
});

test('v2.14.0 取代章節：保留前後章節、可重複執行', () => {
    const md = `# 文件\n\n## 一、前言\n\n內容\n\n## 九、自動偵測到的問題（待修復清單）\n\n舊的內容\n\n## 十、附錄\n\n附錄內容\n`;
    const once = replaceSection(md, `${SECTION_HEADING}\n\n新的內容\n`);
    assert.match(once, /## 一、前言/);
    assert.match(once, /新的內容/);
    assert.ok(!once.includes('舊的內容'), '舊內容應被取代');
    assert.match(once, /## 十、附錄\n\n附錄內容/, '後面的章節必須保留');

    // 再跑一次結果穩定（冪等）
    const twice = replaceSection(once, `${SECTION_HEADING}\n\n新的內容\n`);
    assert.strictEqual(twice, once);

    // 沒有這一節時附加在最後
    const appended = replaceSection('# 文件\n\n## 一、前言\n', `${SECTION_HEADING}\n\n新章節\n`);
    assert.match(appended, /## 一、前言/);
    assert.ok(appended.indexOf(SECTION_HEADING) > appended.indexOf('## 一、前言'));
});
