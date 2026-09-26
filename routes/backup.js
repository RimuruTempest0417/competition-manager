/* 資料備份與還原（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/backup')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerBackupRoutes(app, ctx) {
    const { BACKUP_MAX_ROWS_PER_TABLE, GENERIC_DB_ERROR, RESTORE_CONFLICT_KEYS, backupChecksum, chunkRows, countBackupRows, isMissingTableError, logAudit, logErrorToDb, requireSuperAdmin, resolveBackupTables, supabase, verifyBackupIntegrity } = ctx;
app.get('/api/admin/backup', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    try {
        const includeLogs = req.query.include_logs === 'true';
        const includePosters = req.query.include_posters !== 'false';
        const only = req.query.tables ? String(req.query.tables).split(',').map((s) => s.trim()).filter(Boolean) : null;
        const { tables, unknown } = resolveBackupTables({ includeLogs, includePosters, only });

        const dump = {};
        const tableMeta = {};
        const missing = [];
        const truncated = [];
        for (const name of tables) {
            // eslint-disable-next-line no-await-in-loop
            const { data, error } = await supabase.from(name).select('*').limit(BACKUP_MAX_ROWS_PER_TABLE);
            if (error) {
                if (isMissingTableError(error)) { missing.push(name); continue; }
                throw error;
            }
            dump[name] = data || [];
            tableMeta[name] = { rows: dump[name].length };
            if (dump[name].length >= BACKUP_MAX_ROWS_PER_TABLE) truncated.push(name);
        }

        const meta = {
            app: 'competition-manager',
            version: require('../package.json').version,
            generated_at: new Date().toISOString(),
            generated_by: operator.username,
            tables: tableMeta,
            total_rows: countBackupRows(dump),
            checksum: backupChecksum(dump),
            skipped: includePosters ? [] : ['competition_posters（本次未包含海報圖片）'],
            missing_tables: missing,
            truncated_tables: truncated,
            unknown_tables: unknown
        };

        await logAudit(operator.username, 'EXPORT_BACKUP', null, {
            tables: Object.keys(dump), rows: meta.total_rows, include_logs: includeLogs, include_posters: includePosters
        }, req.userAgent);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cm-backup-${meta.generated_at.replace(/[:.]/g, '-')}.json"`);
        res.json({ meta, tables: dump });
    } catch (err) {
        await logErrorToDb(req, 'export_backup_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 還原（預設只檢查：dry_run=true 不寫任何資料）
app.post('/api/admin/restore', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const body = req.body || {};
    const backup = body.backup;
    const dryRun = body.dry_run === true;
    const force = body.force === true;
    const only = Array.isArray(body.tables) && body.tables.length ? body.tables : null;

    try {
        const integrity = verifyBackupIntegrity(backup);
        if (!integrity.ok && !force) {
            return res.status(400).json({ success: false, error: `備份檔驗證失敗：${integrity.reason}`, integrity });
        }

        if (!dryRun && body.confirm !== 'RESTORE') {
            return res.status(400).json({
                success: false,
                error: '還原需要明確確認：請在請求中帶入 confirm: "RESTORE"（介面會先做一次檢查再讓你確認）'
            });
        }

        const plan = [];
        for (const name of Object.keys(RESTORE_CONFLICT_KEYS)) {
            const rows = backup.tables ? backup.tables[name] : null;
            if (!Array.isArray(rows) || rows.length === 0) continue;
            if (only && !only.includes(name)) continue;
            plan.push({ table: name, rows: rows.length, conflict_key: RESTORE_CONFLICT_KEYS[name] });
        }
        const totalRows = plan.reduce((s, p) => s + p.rows, 0);

        if (plan.length === 0) {
            return res.json({ success: true, restored: 0, plan: [], dry_run: dryRun, message: '備份中沒有可還原的資料' });
        }

        if (dryRun) {
            await logAudit(operator.username, 'RESTORE_BACKUP_DRY_RUN', null, { plan, force }, req.userAgent);
            return res.json({
                success: true, dry_run: true, plan, would_restore: totalRows,
                integrity,
                message: `檢查完成：將還原 ${plan.length} 張表、共 ${totalRows} 筆（未寫入任何資料）`
            });
        }

        const perTable = {};
        const failures = [];
        for (const item of plan) {
            const rows = backup.tables[item.table];
            let done = 0;
            for (const batch of chunkRows(rows)) {
                // eslint-disable-next-line no-await-in-loop
                const { error } = await supabase
                    .from(item.table)
                    // 注意：supabase-js 的選項名是 camelCase 的 onConflict（不是 PostgREST 的 on_conflict 參數名），
                    // 寫錯會靜默退回「以主鍵為衝突目標」，遇到主鍵≠唯一鍵的表（如 push_subscriptions）就會撞 23505。
                    .upsert(batch, { onConflict: RESTORE_CONFLICT_KEYS[item.table] });
                if (error) {
                    failures.push({ table: item.table, error: error.message || String(error) });
                    break;
                }
                done += batch.length;
            }
            perTable[item.table] = done;
        }

        const restored = Object.values(perTable).reduce((s, n) => s + n, 0);
        await logAudit(operator.username, 'RESTORE_BACKUP', null, {
            restored, per_table: perTable, failures, force, backup_meta: {
                generated_at: backup.meta && backup.meta.generated_at,
                version: backup.meta && backup.meta.version,
                total_rows: backup.meta && backup.meta.total_rows
            }
        }, req.userAgent);

        if (failures.length) {
            await logErrorToDb(req, 'restore_backup_partial_failure', new Error(
                `還原未完全成功：${failures.map((f) => f.table).join('、')}`
            ), { severity: 'error', context: { failures, perTable } });
        }

        res.json({
            success: failures.length === 0,
            restored,
            per_table: perTable,
            failures,
            integrity,
            message: failures.length
                ? `已還原 ${restored} 筆，但有 ${failures.length} 張表失敗（詳見 failures）`
                : `已還原 ${restored} 筆（有就更新、沒有就新增；未刪除任何既有資料）`
        });
    } catch (err) {
        await logErrorToDb(req, 'restore_backup_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 管理員帳號維護 API
// ==========================================
};
