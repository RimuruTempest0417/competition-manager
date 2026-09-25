#!/usr/bin/env node
/* 一次性驗證：線上稽核日誌的「動作下拉選單」是不是每個動作都有中文名稱。
 *
 * 背景：使用者 2026-09-25 附了一張稽核日誌動作下拉選單的截圖，裡面有些動作只有英文
 * （CLEANUP_ERROR_LOGS、DELETE_ADMIN、EXPORT_BACKUP…），看起來像「這些動作沒有被記錄」。
 * 實際上是 AUDIT_ACTION_LABELS 當時還沒有那些動作的中文標籤。這支腳本確認修好之後，
 * 線上每個動作都有中文（＝ v2.19.0「宣告 ↔ 實寫一致」的守門在真實環境也成立）。
 *
 * 用法：node scripts/check-audit-action-labels.js
 */
const path = require('node:path');
const { loadEnv, ownerToken, resolveSite, apiRequest } = require(path.join(__dirname, 'lib', 'cm-api.js'));

(async () => {
    const root = path.join(__dirname, '..');
    const env = loadEnv(root);
    const site = resolveSite();
    const token = ownerToken(env);
    if (!token) {
        console.error('❌ .env 沒有 JWT_SECRET，無法簽發管理權杖');
        process.exit(1);
    }

    const res = await apiRequest(site, '/api/audit-logs?limit=1', { token });
    if (res.status !== 200) {
        console.error(`❌ 讀取稽核日誌失敗（HTTP ${res.status}）：${String(res.text).slice(0, 200)}`);
        process.exit(1);
    }

    const options = (res.body && (res.body.actions || res.body.action_options)) || [];
    const bare = options.filter((o) => !o.label || o.label === o.value);
    console.log(`🌐 ${site}`);
    console.log(`   動作選項 ${options.length} 個，其中有中文標籤 ${options.length - bare.length} 個`);
    if (!options.length) {
        console.error('❌ 沒有取得任何動作選項（端點或權限有問題）');
        process.exit(1);
    }
    if (bare.length) {
        console.log(`   ❌ 只有英文（沒有中文標籤）：${bare.map((o) => o.value).join(', ')}`);
        process.exit(1);
    }
    console.log('   ✅ 每個動作都有中文標籤（下拉選單不會出現只有英文的孤兒動作）');

    const sample = options.filter((o) => /LOGOUT|SEND_PUSH|EXPORT_BACKUP|CLEANUP_ERROR_LOGS|DELETE_ADMIN/.test(o.value));
    for (const o of sample) console.log(`      ${o.value} → ${o.label}`);

    console.log(`   稽核紀錄總數：${res.body.total !== undefined ? res.body.total : '（未提供）'}`);
})().catch((err) => {
    console.error('❌ 檢查失敗：', err.message);
    process.exit(1);
});
