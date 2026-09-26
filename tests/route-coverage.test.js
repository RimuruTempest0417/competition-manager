/* v3.6.0：路由覆蓋率守門
 *
 * 把「每條路由至少被一個測試提到」變成 `npm test` 的一部分——
 * v3.5.4 的 8 條無測試端點是靠人工掃出來的，這支測試讓它以後自動被發現。
 * 掃描邏輯本身在 scripts/test-coverage.js（同一份，不做第二套規則）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

test('每一條路由都至少被一個測試或瀏覽器檢查提到', async () => {
    let report = null;
    try {
        const { stdout } = await execFileAsync('node', ['scripts/test-coverage.js', '--json'], { cwd: ROOT });
        report = JSON.parse(stdout);
    } catch (err) {
        // 有未覆蓋的路由時腳本會非零退出，但 JSON 仍然會印在 stdout
        report = JSON.parse(err.stdout || '{}');
    }

    assert.ok(report && typeof report.total === 'number',
        '掃描腳本要能產出 JSON 報告（scripts/test-coverage.js --json）');
    assert.ok(report.total >= 90, `路由快照應該有 90 條以上（實際 ${report.total}）`);

    assert.deepStrictEqual(report.untested, [],
        `以下路由完全沒有被任何測試或瀏覽器檢查提到，請補測試（或在 scripts/test-coverage.js --allow 允許清單寫明理由）：\n` +
        (report.untested || []).map((r) => `  • ${r}`).join('\n'));
});
