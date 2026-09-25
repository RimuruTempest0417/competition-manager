#!/usr/bin/env node
/* 資料備份（v2.18.0）
 *
 * 做什麼：
 *   1. 用 .env 的 JWT_SECRET 簽一張 10 分鐘的管理權杖（不碰資料庫金鑰）
 *   2. 呼叫自家 GET /api/admin/backup 取得完整 JSON（含 meta：版本、時間、每表筆數、checksum）
 *   3. 寫成本機檔案 `backups/cm-backup-<時間>.json`，並自動清理過舊的備份檔（預設保留 20 份）
 *
 * 為什麼走自家 API：RLS 開啟後 anon 完全被擋、本機也沒有 service_role 金鑰；
 * 走 API 只需要能簽權杖，而且「誰在什麼時候備份了」會自動進稽核日誌。
 *
 * 用法：
 *   npm run backup                        # 存到 ./backups（保留最近 20 份）
 *   npm run backup -- --out ~/cm-backups  # 指定目錄
 *   npm run backup -- --keep 50           # 保留 50 份
 *   npm run backup -- --include-logs --no-posters   # 連日誌一起備份／跳過海報圖片
 *   npm run backup -- --dry-run           # 只抓來檢查（不寫檔；仍會呼叫 API）
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv, ownerToken, resolveSite, apiRequest, parseArgv } = require('./lib/cm-api');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const { flag, opt } = parseArgv(argv);

const SITE = resolveSite(opt('--url', ''));
const OUT_DIR = path.resolve(opt('--out', process.env.BACKUP_DIR || path.join(ROOT, 'backups')));
const KEEP = Math.max(1, Number.parseInt(opt('--keep', '20'), 10) || 20);
const DRY_RUN = flag('--dry-run');
const INCLUDE_LOGS = flag('--include-logs');
const NO_POSTERS = flag('--no-posters') || flag('--exclude-images');

function pruneOldBackups(dir, keep) {
    const files = fs.readdirSync(dir)
        .filter((f) => /^cm-backup-.*\.json$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    const removed = [];
    for (const item of files.slice(keep)) {
        fs.unlinkSync(path.join(dir, item.f));
        removed.push(item.f);
    }
    return { total: files.length, removed };
}

async function main() {
    const env = loadEnv(ROOT);
    const token = ownerToken(env, { token: opt('--token', '') });
    if (!token) {
        console.error('❌ 找不到 JWT_SECRET（請確認 .env），也沒有用 --token 指定權杖');
        process.exit(2);
    }

    const params = new URLSearchParams();
    if (INCLUDE_LOGS) params.set('include_logs', 'true');
    if (NO_POSTERS) params.set('include_posters', 'false');
    const query = params.toString() ? `?${params}` : '';

    const res = await apiRequest(SITE, `/api/admin/backup${query}`, { token });
    if (!res.ok) {
        console.error(`❌ 備份失敗（HTTP ${res.status}）：${(res.body && res.body.error) || res.text.slice(0, 200)}`);
        process.exit(1);
    }

    const backup = res.body;
    const meta = backup.meta || {};
    console.log(`\n💾 資料備份：${SITE}`);
    console.log(`   版本 v${meta.version}｜產生於 ${meta.generated_at}｜共 ${meta.total_rows} 筆`);
    for (const [name, info] of Object.entries(meta.tables || {})) {
        console.log(`   • ${name}：${info.rows} 筆`);
    }
    if (meta.skipped && meta.skipped.length) console.log(`   ⏭️  略過：${meta.skipped.join('、')}`);
    if (meta.missing_tables && meta.missing_tables.length) console.log(`   ⚠️  資料表不存在（略過）：${meta.missing_tables.join('、')}`);
    if (meta.truncated_tables && meta.truncated_tables.length) {
        console.log(`   ⚠️  已達單表上限被截斷：${meta.truncated_tables.join('、')}`);
    }

    if (DRY_RUN) {
        console.log('\n（--dry-run：未寫入任何檔案）');
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = String(meta.generated_at || new Date().toISOString()).replace(/[:.]/g, '-');
    const target = path.join(OUT_DIR, `cm-backup-${stamp}.json`);
    fs.writeFileSync(target, JSON.stringify(backup, null, 2));
    const sizeKb = (fs.statSync(target).size / 1024).toFixed(1);
    console.log(`\n✅ 已寫入 ${target}（${sizeKb} KB）`);
    console.log(`   checksum：${meta.checksum}`);

    const pruned = pruneOldBackups(OUT_DIR, KEEP);
    if (pruned.removed.length) {
        console.log(`🧹 清理較舊的備份：刪除 ${pruned.removed.length} 份（保留最近 ${KEEP} 份）`);
    }
    console.log(`📁 目錄內現有 ${Math.min(pruned.total, KEEP)} 份備份`);
}

module.exports = { pruneOldBackups };

if (require.main === module) {
    main().catch((err) => { console.error('❌ 執行失敗：', err.message); process.exit(1); });
}
