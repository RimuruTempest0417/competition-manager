/* 錯誤日誌與系統日誌 API（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/error-logs')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMAnnouncements = require('../public/js/announcements');   // v2.26.0：公告可見性的唯一真實來源
const path = require('path');
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('../lib/passwords');
// v2.15.0：兩步驟驗證（TOTP）—— 純手寫實作，只用 Node 內建 crypto，無外部套件

/* v3.6.1（Roadmap 8.6 ④）：錯誤日誌的截圖上限與列表瘦身
 *
 * 問題：`/api/logs/error` 未登入就能寫入，而 `screenshot` 是**整包原封不動存進資料庫**的
 * （只有 stack_trace 裡那 100 字是截斷過的），搭配全域 10mb 的 body 上限＝匿名者可以
 * 一次寫進約 10MB、每分鐘 30 次；而且 `GET /api/admin/error-logs` 用 `select('*')`
 * 把整包 base64 拉回來並在畫面 render 成 <img>——列表越大越慢。
 *
 * 現在：① 這個端點單獨用 512kb 的 body 上限（見 server.js，必須在全域之前才有效）
 *       ② 只接受真的 `data:image/...;base64,` 且長度在 cap 內，其餘一律**丟掉圖片但照記錯誤**
 *          （在 stack_trace 留下原因，前端據此決定要不要顯示「檢視截圖」）
 *       ③ 列表只回必要欄位＋`has_screenshot`，要看圖另外跟 `/:id/screenshot` 拿
 */
const ERROR_LOG_SCREENSHOT_MAX_CHARS = 400000;   // base64 長度上限（約 300KB 圖檔；body 上限 512kb）
const ERROR_LOG_SCREENSHOT_MARKER = '[Screenshot Attached';
const ERROR_LOG_SCREENSHOT_DROP_MARKER = '[Screenshot Dropped';

function isImageDataUrl(value) {
    if (typeof value !== 'string') return false;
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value.slice(0, 40))) return false;
    return /^[A-Za-z0-9+/=\s]*$/.test(value.slice(value.indexOf(',') + 1));
}

function hasScreenshotAttached(trace) {
    return typeof trace === 'string' && trace.includes(ERROR_LOG_SCREENSHOT_MARKER);
}

module.exports = function registerErrorLogsRoutes(app, ctx) {
    const { ERROR_LOG_FAILURES, ERROR_LOG_RESOLVE_ALL_MAX, GENERIC_DB_ERROR, PUSH_HINT, PUSH_LOG_DETAIL_HINT, USER_MIGRATION_HINT, allowPublicWrite, columnExists, errorLogAlertSummary, hasSupabaseConfig, isMissingTableError, logAudit, logErrorToDb, parseResolveIds, pushLogDetailSchemaReady, requireAdmin, requireSuperAdmin, selfTestSkippedCount, supabase, supabaseKeyType } = ctx;
app.post('/api/logs/error', async (req, res) => {
    // v2.12.0：未登入就能寫入，必須節流並限制欄位長度（避免匿名灌爆資料庫）
    if (!allowPublicWrite(req.ip, 'logs-error', 30, 60000)) {
        return res.status(429).json({ error: '錯誤回報過於頻繁，請稍後再試' });
    }

    try {
        const { error_type, message, stack_trace, path: errPath, screenshot } = req.body || {};
        const userAgent = req.headers['user-agent'] || '';

        let finalStackTrace = stack_trace || '';
        // v3.6.1：先驗證截圖再決定留或丟；只有合法且不超限時才寫入資料庫
        let storedScreenshot = null;
        if (screenshot) {
            const raw = String(screenshot);
            if (!isImageDataUrl(raw)) {
                finalStackTrace += `\n\n${ERROR_LOG_SCREENSHOT_DROP_MARKER}: 不是合法的 data:image 資料（${raw.length} 字元）]`;
            } else if (raw.length > ERROR_LOG_SCREENSHOT_MAX_CHARS) {
                finalStackTrace += `\n\n${ERROR_LOG_SCREENSHOT_DROP_MARKER}: 圖片過大（${raw.length} 字元，上限 ${ERROR_LOG_SCREENSHOT_MAX_CHARS}）]`;
            } else {
                storedScreenshot = raw;
                finalStackTrace += `\n\n[Screenshot Attached (Base64 Truncated)]: ${raw.substring(0, 100)}...`;
            }
        }

        const trim = (v, n) => (v === undefined || v === null ? '' : String(v).slice(0, n));

        const logPayload = {
            user_id: null,
            error_type: trim(error_type, 60) || 'frontend_error',
            message: trim(message, 1000) || 'Unknown client error',
            stack_trace: finalStackTrace.slice(0, 4000),
            path: trim(errPath, 300),
            user_agent: trim(userAgent, 400)
        };

        if (storedScreenshot) {
            logPayload.screenshot = storedScreenshot;
        }

        const { error } = await supabase.from('error_logs').insert([logPayload]);

        if (error) throw error;
        res.json({ success: true, message: 'Bug report saved successfully' });
    } catch (err) {
        // v2.12.0：連「寫日誌」本身的失敗也要留下痕跡（原本只有 console.error，雲端看不到）
        await logErrorToDb(req, 'client_error_log_failed', err, {
            severity: 'warn',
            context: { reason: '前端錯誤回報寫入失敗' }
        });
        res.status(500).json({ error: 'Failed to record error log' });
    }
});
app.get('/api/admin/error-logs', requireSuperAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const hasSeverity = await columnExists('error_logs', 'severity');
        const hasResolved = await columnExists('error_logs', 'resolved');

        // v3.6.1：明確列出欄位——**不含 screenshot**（base64 會讓列表變成數 MB）
        const listColumns = ['id', 'error_type', 'message', 'stack_trace', 'path', 'user_agent', 'created_at', 'user_id']
            .concat(hasSeverity ? ['severity'] : [])
            .concat(hasResolved ? ['resolved', 'resolved_by', 'resolved_at'] : []);
        let query = supabase.from('error_logs').select(listColumns.join(','), { count: 'exact' });

        if (req.query.type) query = query.eq('error_type', String(req.query.type).slice(0, 60));
        if (req.query.severity && hasSeverity) query = query.eq('severity', String(req.query.severity).slice(0, 20));
        if (req.query.resolved === 'true' && hasResolved) query = query.eq('resolved', true);
        if (req.query.resolved === 'false' && hasResolved) query = query.eq('resolved', false);
        if (req.query.q) {
            // 去掉 PostgREST 的 or() 語法字元，避免查詢字串被注入
            const q = String(req.query.q).replace(/[%,()*]/g, ' ').trim().slice(0, 80);
            if (q) query = query.or(`message.ilike.%${q}%,error_type.ilike.%${q}%,path.ilike.%${q}%`);
        }

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const logs = (data || []).map((l) => ({
            ...l,
            severity: l.severity || 'error',
            resolved: l.resolved === true,
            // 列表不再帶截圖本體，只告訴前端「這筆有沒有圖」（看圖另外跟 /:id/screenshot 拿）
            has_screenshot: hasScreenshotAttached(l.stack_trace)
        }));
        const unresolvedInPage = logs.filter((l) => !l.resolved).length;

        res.json({
            success: true,
            logs,
            total: count === null || count === undefined ? logs.length : count,
            limit,
            offset,
            unresolved_in_page: unresolvedInPage,
            schema: { severity: hasSeverity, resolved: hasResolved }
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_error_logs_error', err);
        console.error('[Fetch Error Logs Failed]:', err.message);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// v3.6.1：列表不再回傳截圖本體，要看圖單獨拿這一筆（只有超級管理員以上）
app.get('/api/admin/error-logs/:id/screenshot', requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '無效的日誌編號' });

        const { data, error } = await supabase.from('error_logs').select('id, screenshot').eq('id', id).limit(1);
        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到這筆錯誤日誌' });

        const shot = data[0].screenshot;
        const isImage = typeof shot === 'string' && shot.startsWith('data:image/');
        res.json({ success: true, id, screenshot: isImage ? shot : null });
    } catch (err) {
        await logErrorToDb(req, 'fetch_error_log_screenshot_error', err);
        res.status(500).json({ error: '讀取截圖失敗' });
    }
});

// 錯誤日誌系統自身的狀態（寫入失敗時可在後台直接看到，不再只有 console）
app.get('/api/admin/error-logs/health', requireSuperAdmin, async (req, res) => {
    // v2.12.1：順便統計還有幾個帳號的密碼是舊的明碼格式（只回數量，絕不回傳任何密碼內容）
    let plaintextPasswords = null;
    try {
        const { data, error } = await supabase.from('admin_users').select('id, password');
        if (!error) plaintextPasswords = (data || []).filter(u => needsPasswordUpgrade(u.password)).length;
    } catch (e) { /* 統計失敗不影響健康檢查 */ }

    res.json({
        success: true,
        supabase_configured: hasSupabaseConfig,
        db_key_type: supabaseKeyType,
        rls_ready: supabaseKeyType === 'service_role',
        recent_write_failures: ERROR_LOG_FAILURES.slice(-10).reverse(),
        failure_count: ERROR_LOG_FAILURES.length,
        schema: {
            severity: await columnExists('error_logs', 'severity'),
            resolved: await columnExists('error_logs', 'resolved')
        },
        plaintext_passwords: plaintextPasswords,
        // v3.5.2：被辨識為「自動化檢查流量」而沒有寫入的筆數（檢查腳本據此證明標記生效）
        self_test_skipped: typeof selfTestSkippedCount === 'function' ? selfTestSkippedCount() : null
    });
});

// v2.14.0：未處理錯誤日誌的統計（前端據此顯示提示橫幅／選單數量）
app.get('/api/admin/error-logs/summary', requireSuperAdmin, async (req, res) => {
    const summary = await errorLogAlertSummary();
    res.json(Object.assign({ success: true }, summary));
});

// 標記錯誤日誌為已處理／未處理
app.patch('/api/admin/error-logs/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    const resolved = req.body && (req.body.resolved === true || req.body.resolved === 'true');

    try {
        if (!(await columnExists('error_logs', 'resolved'))) {
            return res.status(503).json({ error: USER_MIGRATION_HINT });
        }

        const updates = { resolved };
        if (await columnExists('error_logs', 'resolved_at')) updates.resolved_at = resolved ? new Date().toISOString() : null;
        if (await columnExists('error_logs', 'resolved_by')) updates.resolved_by = resolved ? operator.username : null;

        const { error } = await supabase.from('error_logs').update(updates).eq('id', id);
        if (error) throw error;

        await logAudit(operator.username, resolved ? 'RESOLVE_ERROR_LOG' : 'REOPEN_ERROR_LOG', id, `標記錯誤日誌 #${id}`, req.userAgent);
        res.json({ success: true, message: resolved ? '已標記為已處理' : '已標記為未處理', resolved });
    } catch (err) {
        await logErrorToDb(req, 'resolve_error_log_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* v2.17.0：批次標記錯誤日誌為已處理
   ------------------------------------------------------------
   為什麼要批次：每次發版都會跑 `npm run triage`（scripts/error-log-triage.js）讀線上日誌做分析，
   分析完那些紀錄就該「收工」——否則清單會一直累積同一批舊訊息，首頁提示橫幅也永遠亮著，
   新的問題反而被舊雜訊蓋掉。這個端點讓巡檢腳本與介面能一次把「讀過的一批」標記為已處理。

   安全設計：
     - 只接受明確的 id 清單（最多 500 個／次），或 `all_unresolved: true`（內部上限 1000 筆），
       不接受「刪除」語意、也不會動到其他紀錄。
     - 一定留稽核（RESOLVE_ERROR_LOGS，含筆數與前 20 個 id），事後追得到是誰在什麼時候清的。
     - 未執行 v2.12.0 migration（沒有 resolved 欄位）時回 503 並附檔案路徑，不會靜默失敗。
*/
app.post('/api/admin/error-logs/resolve', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const body = req.body || {};

    try {
        if (!(await columnExists('error_logs', 'resolved'))) {
            return res.status(503).json({ error: USER_MIGRATION_HINT });
        }

        let ids = [];
        if (body.all_unresolved === true) {
            const { data, error } = await supabase
                .from('error_logs')
                .select('id')
                .eq('resolved', false)
                .limit(ERROR_LOG_RESOLVE_ALL_MAX);
            if (error) throw error;
            ids = (data || []).map((row) => row.id);
        } else {
            const parsed = parseResolveIds(body.ids);
            if (parsed.error) return res.status(400).json({ error: parsed.error });
            ids = parsed.ids;
        }

        if (ids.length === 0) {
            return res.json({ success: true, resolved: 0, message: '沒有需要標記的紀錄', resolved_by: operator.username });
        }

        const nowIso = new Date().toISOString();
        const updates = { resolved: true };
        if (await columnExists('error_logs', 'resolved_at')) updates.resolved_at = nowIso;
        if (await columnExists('error_logs', 'resolved_by')) updates.resolved_by = operator.username;

        const { data, error } = await supabase
            .from('error_logs')
            .update(updates)
            .in('id', ids)
            .select('id');
        if (error) throw error;

        const changed = (data || []).length;
        await logAudit(operator.username, 'RESOLVE_ERROR_LOGS', null, {
            requested: ids.length,
            resolved: changed,
            all_unresolved: body.all_unresolved === true,
            sample_ids: ids.slice(0, 20)
        }, req.userAgent);

        res.json({
            success: true,
            resolved: changed,
            requested: ids.length,
            resolved_at: nowIso,
            resolved_by: operator.username,
            message: `已標記 ${changed} 筆為已處理`
        });
    } catch (err) {
        await logErrorToDb(req, 'resolve_error_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 清理舊的錯誤日誌（預設 30 天前）
app.post('/api/admin/error-logs/cleanup', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const days = Math.min(Math.max(parseInt(req.body && req.body.days, 10) || 30, 1), 3650);

    try {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const { data, error } = await supabase
            .from('error_logs')
            .delete()
            .lt('created_at', cutoff)
            .select('id');

        if (error) throw error;

        const removed = (data || []).length;
        await logAudit(operator.username, 'CLEANUP_ERROR_LOGS', null, `清理 ${days} 天前的錯誤日誌：刪除 ${removed} 筆`, req.userAgent);
        res.json({ success: true, removed, days, message: `已清理 ${removed} 筆超過 ${days} 天的日誌` });
    } catch (err) {
        await logErrorToDb(req, 'cleanup_error_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 推播發送紀錄（管理員以上可檢視）
app.get('/api/admin/push-logs', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const { data, error } = await supabase
            .from('push_log')
            .select('*')
            .order('sent_at', { ascending: false })
            .limit(limit);

        if (error) {
            if (isMissingTableError(error)) return res.status(503).json({ error: PUSH_HINT });
            throw error;
        }
        // v2.26.0：明細欄位還沒建時，前端要誠實顯示「尚無失敗資訊與重送」
        res.json({
            success: true,
            logs: data || [],
            detail_ready: await pushLogDetailSchemaReady(),
            hint: (await pushLogDetailSchemaReady()) ? null : PUSH_LOG_DETAIL_HINT
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_push_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// v2.26.0：站內公告／訊息中心
// ==========================================
//
// 為什麼「誰看得到」要共用 CMAnnouncements：前後端各寫一套遲早不一致
// （列表看得到、點進去說無權；或管理員以為只發給路跑組、結果所有人都收到）。
// 資料表：announcements（公告本體）、announcement_reads（誰讀過了）、
//         admin_users.announce_categories（使用者訂閱的公告分類）。
// 未執行 migration 時：列表回空並附 schema_ready:false＋檔名提示、發布／修改回 503，其他功能不受影響。
};
