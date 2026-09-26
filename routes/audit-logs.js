/* 稽核日誌（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/audit-logs')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMCSV = require('../public/js/csv.js');

// 純函式：以「名稱 + 開始日期」判斷重複，回傳要新增與要跳過的清單（方便單元測試）

module.exports = function registerAuditLogsRoutes(app, ctx) {
    const { AUDIT_ACTION_LABELS, AUDIT_EXPORT_MAX, AUDIT_MIN_RETENTION_DAYS, AUDIT_SEARCH_WINDOW, GENERIC_DB_ERROR, auditActionLabel, auditLogsToCsvRows, auditMatchesQuery, logAudit, logErrorToDb, parseAuditFilters, requireSuperAdmin, supabase } = ctx;
app.get('/api/audit-logs', requireSuperAdmin, async (req, res) => {
    try {
        const f = parseAuditFilters(req.query);

        let query = supabase.from('audit_logs').select('*', { count: 'exact' });
        if (f.username) query = query.eq('user_id', f.username);
        if (f.action) query = query.eq('action', f.action);
        if (f.from) query = query.gt('created_at', f.from);
        if (f.to) query = query.lt('created_at', f.to);

        // 一律從第 0 筆取到「本頁結尾 + 1」再自己在 JS 切頁：
        // 正式站 PostgREST 會依 range 回傳、測試替身則回全部，這樣寫兩種環境行為完全一致，
        // has_more 與分頁才不會因為環境不同而算錯（有人問過為什麼不直接用 range(offset, …)——就是這個原因）。
        const useSearch = Boolean(f.q);
        const windowSize = useSearch
            ? AUDIT_SEARCH_WINDOW
            : Math.min(f.offset + f.limit + 1, AUDIT_EXPORT_MAX);

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(0, windowSize - 1);

        if (error) throw error;

        const window = (data || []).slice(0, windowSize);
        const filtered = useSearch ? window.filter((log) => auditMatchesQuery(log, f.q)) : window;
        const page = filtered.slice(f.offset, f.offset + f.limit);
        const hasMore = filtered.length > f.offset + f.limit;

        // 下拉選單用的動作清單：已知動作 + 這次結果中出現的未知動作
        const seen = new Set(window.map((l) => l.action).filter(Boolean));
        const actions = Object.keys(AUDIT_ACTION_LABELS)
            .concat([...seen].filter((a) => !AUDIT_ACTION_LABELS[a]))
            .sort()
            .map((value) => ({ value, label: auditActionLabel(value) }));

        res.json({
            success: true,
            logs: page,
            returned: page.length,
            limit: f.limit,
            offset: f.offset,
            has_more: hasMore,
            total: count === null || count === undefined ? null : count,
            search_window: useSearch ? AUDIT_SEARCH_WINDOW : null,
            search_matches: useSearch ? filtered.length : null,
            filters: f,
            actions
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// CSV 匯出（套用同一組篩選；表格公式注入防護由 CMCSV.stringify 負責）
app.get('/api/audit-logs/export', requireSuperAdmin, async (req, res) => {
    try {
        const f = parseAuditFilters(Object.assign({}, req.query, { limit: AUDIT_EXPORT_MAX, offset: 0 }));

        let query = supabase.from('audit_logs').select('*');
        if (f.username) query = query.eq('user_id', f.username);
        if (f.action) query = query.eq('action', f.action);
        if (f.from) query = query.gt('created_at', f.from);
        if (f.to) query = query.lt('created_at', f.to);

        const fetchLimit = f.q ? AUDIT_SEARCH_WINDOW : AUDIT_EXPORT_MAX;
        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(0, fetchLimit - 1);
        if (error) throw error;

        const filtered = (data || []).filter((log) => auditMatchesQuery(log, f.q)).slice(0, AUDIT_EXPORT_MAX);
        const csv = CMCSV.stringify(auditLogsToCsvRows(filtered), { bom: true });

        await logAudit(req.currentUser.username, 'EXPORT_AUDIT_LOGS', null, {
            count: filtered.length,
            filters: { q: f.q || null, username: f.username || null, action: f.action || null, from: f.from, to: f.to }
        }, req.userAgent);

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.csv"`);
        res.send(csv);
    } catch (err) {
        await logErrorToDb(req, 'export_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 保留天數清理（需要 super_admin／web_owner；dry_run 可先預覽筆數）
app.post('/api/audit-logs/cleanup', requireSuperAdmin, async (req, res) => {
    try {
        const requested = Number.parseInt(req.body?.days, 10);
        const days = Number.isFinite(requested) ? requested : 365;
        if (days < AUDIT_MIN_RETENTION_DAYS) {
            return res.status(400).json({
                error: `為了安全，保留天數不得少於 ${AUDIT_MIN_RETENTION_DAYS} 天（避免一時手誤刪掉所有稽核紀錄）`
            });
        }

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        if (req.body?.dry_run === true) {
            const { data, error } = await supabase.from('audit_logs').select('id').lt('created_at', cutoff);
            if (error) throw error;
            return res.json({ success: true, dry_run: true, would_delete: (data || []).length, cutoff, days });
        }

        const { data, error } = await supabase
            .from('audit_logs')
            .delete({ count: 'exact' })
            .lt('created_at', cutoff)
            .select('id');   // 要 select 才會回傳被刪除的列，才知道刪了幾筆
        if (error) throw error;

        const deleted = Array.isArray(data) ? data.length : 0;
        await logAudit(req.currentUser.username, 'PURGE_AUDIT_LOGS', null, { days, cutoff, deleted }, req.userAgent);
        // 要 await：不然回應送出時這筆警告可能還沒落地，事後就查不到了
        await logErrorToDb(req, 'audit_logs_purged', new Error(
            `稽核日誌清理：刪除 ${deleted} 筆早於 ${cutoff} 的紀錄（保留 ${days} 天）`), {
            severity: 'warn', context: { days, deleted }
        });

        res.json({ success: true, deleted, cutoff, days });
    } catch (err) {
        await logErrorToDb(req, 'cleanup_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 資料備份與還原（v2.18.0）
// ------------------------------------------
// 為什麼要做：這個系統唯一的資料安全網是 Supabase 自己。誤刪大量資料（例如手滑按了清理、
// 或匯入覆蓋）沒有回頭路。備份與還原就是把「回頭路」補上。
//
// 設計取捨：
//   1. 走自家 API（service_role 只在伺服器上）：本機不需要資料庫金鑰，開 RLS 後照樣可用，
//      也順便讓「誰做了備份／還原」自動進稽核日誌。
//   2. **匯出順序 = 還原順序**，且以外部鍵相依性排序（competitions 先於 registrations／posters／teams）。
//   3. 還原採「upsert（有就更新、沒有就新增）」，**不刪除任何備份中沒有的資料**：
//      刪除是不可逆的，這種事不該由「還原」順手做（要刪有資源回收桶與清理端點）。
//   4. 備份帶 checksum（tables 內容的 sha256）與每表筆數；還原時會驗證，
//      檔案被改過就拒絕（除非 --force），避免「以為還原了其實還原了半份壞資料」。
//   5. 稽核日誌與錯誤日誌**預設不備份**（量大、且已有 CSV 匯出），要用再開。
// ==========================================
};
