/* 顏色 class 覆蓋率守門測試（v2.27.0 起納入 npm test）
 *
 * 為什麼要有這個：Tailwind 靜態檔缺少某個 class 時「不會報錯，只會默默失效」——
 * v2.25.0 的「儲存設定」按鈕就是這樣變成隱形的（bg-sky-600 整個色系都不存在，
 * 白字配透明底＝使用者看不到按鈕）。檢查腳本以前只放在開發機、也不在 npm test 裡，
 * 所以能靜默上線；現在腳本進 repo 且每次跑測試都會檢查。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('顏色 class 覆蓋率：每個用到的顏色 class 都有規則、兩份深色票同步', () => {
    const result = spawnSync('python3', ['scripts/class-coverage.py'], { cwd: ROOT, encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
        assert.fail('找不到 python3 —— 這個檢查需要 python3（文件管線 scripts/doc-sync.py 也是）');
    }
    assert.strictEqual(result.status, 0,
        '顏色 class 覆蓋率檢查失敗：\n' + (result.stdout || '') + (result.stderr || ''));
    assert.match(result.stdout, /✅ 全部通過/, '檢查腳本沒有回報通過');
    // 檢查本身要真的有掃到東西，不能因為檔案路徑寫錯而「空跑過關」
    const counts = /使用中的顏色 class：(\d+)｜custom.css 定義：(\d+)/.exec(result.stdout);
    assert.ok(counts, '檢查輸出格式不對，請確認腳本版本：\n' + result.stdout);
    assert.ok(Number(counts[1]) > 80, `掃到的顏色 class 只有 ${counts[1]} 個，疑似漏掃檔案`);
});
