#!/usr/bin/env node
/* 還原備份（v2.18.0）
 *
 * 做什麼：
 *   1. 讀本機備份檔（scripts/backup-db.js 產生的 JSON）
 *   2. 先呼叫 POST /api/admin/restore 做 **dry-run 檢查**（驗證 checksum、列出將還原的表與筆數，不改資料）
 *   3. 通過後才真的還原（需要帶 confirm: "RESTORE"）
 *
 * 重要語意（刻意的）：
 *   - 還原是 **upsert**：有相同主鍵就更新、沒有就新增。
 *   - **不會刪除**任何備份中沒有的資料。刪除不可逆，不該由「還原」順手做。
 *   - 備份檔被改過（checksum 不符）預設拒絕；真的確定要用 --force。
 *
 * 用法：
 *   npm run restore -- --file backups/cm-backup-2026-09-26T...json --dry-run   # 只檢查
 *   npm run restore -- --file <檔案>                                          # 檢查通過後還原
 *   npm run restore -- --file <檔案> --tables=competitions,registrations      # 只還原部分表
 *   npm run restore -- --file <檔案> --force                                  # 忽略 checksum 不符
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv, ownerToken, resolveSite, apiRequest, parseArgv } = require('./lib/cm-api');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const { flag, opt } = parseArgv(argv);

const SITE = resolveSite(opt('--url', ''));
const FILE = opt('--file', argv.find((a) => !a.startsWith('--')) || '');
const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const ONLY = opt('--tables', '') ? opt('--tables').split(',').map((s) => s.trim()).filter(Boolean) : null;

async function main() {
    if (!FILE) {
        console.error('❌ 請用 --file 指定備份檔（例如 npm run restore -- --file backups/cm-backup-xxx.json --dry-run）');
        process.exit(2);
    }
    const filePath = path.resolve(FILE);
    if (!fs.existsSync(filePath)) {
        console.error(`❌ 找不到檔案：${filePath}`);
        process.exit(2);
    }

    let backup;
    try {
        backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`❌ 備份檔不是有效的 JSON：${err.message}`);
        process.exit(2);
    }

    const env = loadEnv(ROOT);
    const token = ownerToken(env, { token: opt('--token', '') });
    if (!token) {
        console.error('❌ 找不到 JWT_SECRET（請確認 .env），也沒有用 --token 指定權杖');
        process.exit(2);
    }

    const meta = backup.meta || {};
    console.log(`\n♻️  還原備份：${path.relative(ROOT, filePath)}`);
    console.log(`   備份版本 v${meta.version || '?'}｜產生於 ${meta.generated_at || '?'}｜共 ${meta.total_rows ?? '?'} 筆`);
    if (meta.generated_by) console.log(`   由 ${meta.generated_by} 產生`);

    /* ---------- 1. 檢查（dry-run，必要的前置步驟） ---------- */
    const check = await apiRequest(SITE, '/api/admin/restore', {
        token, method: 'POST', body: { backup, dry_run: true, force: FORCE, tables: ONLY }
    });
    if (!check.ok || !check.body || check.body.success !== true) {
        console.error(`❌ 檢查未通過（HTTP ${check.status}）：${(check.body && check.body.error) || check.text.slice(0, 200)}`);
        process.exit(1);
    }
    for (const item of check.body.plan || []) {
        console.log(`   • ${item.table}：${item.rows} 筆（主鍵 ${item.conflict_key}）`);
    }
    console.log(`   將還原 ${check.body.plan.length} 張表、共 ${check.body.would_restore} 筆`);
    if (check.body.integrity && check.body.integrity.checked) console.log('   ✅ checksum 驗證通過');

    if (DRY_RUN) {
        console.log('\n（--dry-run：只檢查，未寫入任何資料）');
        return;
    }

    /* ---------- 2. 實際還原 ---------- */
    const res = await apiRequest(SITE, '/api/admin/restore', {
        token, method: 'POST', body: { backup, confirm: 'RESTORE', force: FORCE, tables: ONLY }
    });
    if (!res.ok || !res.body) {
        console.error(`❌ 還原失敗（HTTP ${res.status}）：${(res.body && res.body.error) || res.text.slice(0, 200)}`);
        process.exit(1);
    }
    const body = res.body;
    for (const [table, count] of Object.entries(body.per_table || {})) {
        console.log(`   • ${table}：還原 ${count} 筆`);
    }
    console.log(`\n${body.success ? '✅' : '⚠️ '} ${body.message}`);
    if (body.failures && body.failures.length) {
        for (const f of body.failures) console.error(`   ✖ ${f.table}：${f.error}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => { console.error('❌ 執行失敗：', err.message); process.exit(1); });
}
