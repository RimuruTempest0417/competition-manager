/* 稽核動作清單 ↔ 實際記錄位置的守門測試（v2.19.0）
 *
 * 為什麼需要：稽核日誌的動作下拉選單是從 `AUDIT_ACTION_LABELS`（伺服器端宣告）產生的。
 * 只要「宣告」與「程式真的會寫」兩邊走鐘，就會出現兩種爛狀況，而且都不會報錯：
 *   ① 選單有這個動作，但程式從來沒寫過 → 使用者選了永遠查到 0 筆（以為系統沒在記）
 *   ② 程式寫了某個動作，但沒宣告 → 使用者看到一排沒有中文的英文代碼（不知道是什麼事）
 * 這支測試把兩邊釘在一起：新增動作忘了宣告、或宣告了卻沒實作，都會讓測試紅燈。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const app = require(path.join(__dirname, '..', 'server.js'));
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const LABELS = app.__test__.AUDIT_ACTION_LABELS;

/* 抓出所有 logAudit(...) 呼叫點裡「第二個參數」出現的動作名稱（全大寫字面值）。
   - 只看第一個逗號之後的部分：避免把 `username || 'UNKNOWN'` 這種身分備援當成動作。
   - 一到下一個分號為止（logAudit 的參數裡不會有分號）。
   - 支援三元運算式（例如 resolved ? 'RESOLVE_ERROR_LOG' : 'REOPEN_ERROR_LOG'）→ 兩個都會被算到。 */
function emittedActions(source) {
    const found = new Set();
    const callStarts = [];
    let idx = source.indexOf('logAudit(');
    while (idx >= 0) {
        callStarts.push(idx);
        idx = source.indexOf('logAudit(', idx + 1);
    }

    for (const start of callStarts) {
        const end = source.indexOf(';', start);
        const call = source.slice(start, end < 0 ? source.length : end);
        const afterFirstArg = call.slice(call.indexOf(',') + 1);
        if (afterFirstArg.indexOf(',') === 0) continue;   // logAudit( 的定義：第一個逗號屬於參數串
        for (const m of afterFirstArg.matchAll(/['"]([0-9A-Z][A-Z0-9_]{2,})['"]/g)) {
            found.add(m[1]);
        }
    }
    return found;
}

/* 只為了讀「歷史紀錄」而保留、新程式碼不會再寫入的動作名稱。
   保留原因：舊紀錄的 action 值就是這幾個，沒有標籤的話稽核日誌會顯示英文代碼。
   這裡是白名單，**只能放真的已經不寫入的舊名稱**（測試會確保新程式碼沒有再用）。 */
const LEGACY_ONLY_ACTIONS = ['CREATE_ADMIN', 'UPDATE_ADMIN', 'DELETE_ADMIN'];

test('稽核動作：宣告清單與實際寫入必須一致（新增／改名動作時要同步）', () => {
    const declared = new Set(Object.keys(LABELS));
    const emitted = emittedActions(SERVER_SOURCE);

    assert.ok(declared.size > 20, `宣告的動作數量不合理（${declared.size}）`);
    assert.ok(emitted.size > 20, `抽到的動作數量不合理（${emitted.size}）——解析器可能壞了`);

    // ① 不可以「宣告了但程式從沒寫」：那會是永遠查到 0 筆的空選項
    const deadOptions = [...declared].filter((a) => !emitted.has(a) && !LEGACY_ONLY_ACTIONS.includes(a));
    assert.deepStrictEqual(deadOptions, [],
        `這些動作在清單裡但程式從來沒寫入（使用者會查到 0 筆）：${deadOptions.join(', ')}`);

    // ② 不可以「寫了但沒宣告」：選單會顯示沒有中文的英文代碼，而且無法用動作篩選
    const unlabeled = [...emitted].filter((a) => !declared.has(a));
    assert.deepStrictEqual(unlabeled, [],
        `這些動作有寫入但沒宣告中文標籤：${unlabeled.join(', ')}`);

    // ③ 每個宣告的動作都要有中文標籤
    const missingLabels = Object.entries(LABELS).filter(([, v]) => !v || typeof v !== 'string').map(([k]) => k);
    assert.deepStrictEqual(missingLabels, [], `這些動作沒有中文標籤：${missingLabels.join(', ')}`);
});

test('稽核動作：動作名稱必須是字面值（不可用變數拼出來）', () => {
    // 若是 `logAudit(u, someVariable, ...)`，上面的守門測試就抓不到，選單與紀錄會再次走鐘。
    const pattern = /logAudit\(\s*[^,;]+,\s*([^,;]+)/g;
    const offenders = [];
    for (const m of SERVER_SOURCE.matchAll(pattern)) {
        const arg = m[1].trim();
        // 允許：字面值、三元（兩個分支都是字面值）、或函式定義的第一個參數（logAudit 的宣告本身）
        const ok = /^'[0-9A-Z][A-Z0-9_]*'$/.test(arg) ||
            /^'.+'\s*:\s*'[0-9A-Z][A-Z0-9_]+'\s*$/.test(arg.replace(/^\S+\s*\?\s*/, '')) ||
            /^action$/.test(arg);
        if (!ok) offenders.push(arg.slice(0, 60));
    }
    // logAudit 定義本身的參數名叫做 action
    const real = offenders.filter((a) => a !== 'action');
    assert.deepStrictEqual(real, [], `這些呼叫的動作不是字面值，會讓稽核篩選漏掉：${real.join(' | ')}`);
});

test('稽核動作：舊名稱只留給歷史紀錄，新程式碼不得再寫入', () => {
    const emitted = emittedActions(SERVER_SOURCE);
    const reused = LEGACY_ONLY_ACTIONS.filter((a) => emitted.has(a));
    assert.deepStrictEqual(reused, [],
        `這些舊動作名稱仍有程式在寫入（應該改用 *_USER 等新名稱）：${reused.join(', ')}`);
});
