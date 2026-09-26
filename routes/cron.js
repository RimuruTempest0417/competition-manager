/* 排程提醒（cron）（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/cron')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerCronRoutes(app, ctx) {
    const { AUDIT_MIN_RETENTION_DAYS, SITE_UTC_OFFSET, cronAuthorization, digestKindsFromSettings, getSetting, isMissingTableError, isProduction, logAudit, logErrorToDb, readPushSettings, runPushDigest, runRecurringCompetitions, serverState, setSetting, shouldRunDigest, supabase } = ctx;
app.get('/api/cron/reminders', async (req, res) => {
    const auth = cronAuthorization({
        secret: process.env.CRON_SECRET,
        providedHeader: req.headers.authorization,
        isProductionEnv: isProduction,
        lastRunMs: serverState.lastCronRun,
        nowMs: Date.now()
    });
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    serverState.lastCronRun = Date.now();

    try {
        // v2.25.0：先看「現在該不該發每日摘要」（時間可設定；一天只發一次；時間過了會補送）
        const pushSettings = await readPushSettings();
        const kinds = digestKindsFromSettings(pushSettings.settings);
        let lastDigestDate = null;
        try {
            lastDigestDate = await getSetting('push_last_digest_date');
        } catch (err) {
            lastDigestDate = null;   // 讀不到就當作今天還沒發（最壞情況是多發一次，不會漏發）
        }
        const gate = shouldRunDigest({
            enabled: pushSettings.settings.digest_enabled,
            scheduledTime: pushSettings.settings.digest_time,
            lastDigestDate,
            nowMs: Date.now(),
            offset: SITE_UTC_OFFSET
        });
        const digestInfo = {
            ran: false,
            reason: gate.reason,
            scheduled: pushSettings.settings.digest_time,
            local_date: gate.date,
            local_time: gate.time,
            kinds
        };

        let result;
        if (!gate.run) {
            result = { sent: 0, subscriptions: 0, candidates: 0, details: [] };
        } else if (kinds.length === 0) {
            digestInfo.reason = '摘要的事件都關掉了（新賽事／開賽提醒）';
            result = { sent: 0, subscriptions: 0, candidates: 0, details: [] };
        } else {
            try {
                result = await runPushDigest(new Date(), { kinds });
                digestInfo.ran = true;
            } catch (digestErr) {
                // 推播這一段失敗（例如憑證或資料表問題）不該讓整個排程回 503：
                // 稽核清理與週期性賽事都還要跑，失敗原因照實回報在 digest.reason
                result = { sent: 0, subscriptions: 0, candidates: 0, details: [], reason: digestErr.message };
                digestInfo.reason = `推播暫時無法發送：${digestErr.message}`;
                await logErrorToDb(req, 'cron_push_digest_error', digestErr).catch(() => {});
            }
            // v2.19.0：批次推播「有真的送出」才留紀錄（sent=0 不留，避免每天一筆空紀錄）
            if (result && result.sent > 0) {
                await logAudit('system', 'SEND_PUSH', null, {
                    source: 'cron', sent: result.sent, subscriptions: result.subscriptions, details: result.details
                }, 'cron');
            }
            // 今天發過了（不論送出去幾則）——一天只發一次，不會因為排程多跑幾次就重複發
            // 記錄失敗不該讓整個排程回 503（設定表可能沒建好）：最壞情況是當天再發一次
            try {
                await setSetting('push_last_digest_date', gate.date);
                digestInfo.marked = true;
            } catch (markErr) {
                digestInfo.marked = false;
                console.warn('⚠️ 無法記錄每日摘要日期（app_settings）：', markErr.message);
            }
        }
        result.digest = digestInfo;
        // v2.16.0：稽核日誌保留天數清理（**預設不啟用**：只有設了 AUDIT_RETENTION_DAYS 才會刪東西）
        result.audit_purged = null;   // 欄位固定存在，未啟用時明確回 null
        const retention = Number.parseInt(process.env.AUDIT_RETENTION_DAYS, 10);
        if (Number.isFinite(retention) && retention >= AUDIT_MIN_RETENTION_DAYS) {
            const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000).toISOString();
            const { data: purged, error: purgeError } = await supabase
                .from('audit_logs')
                .delete({ count: 'exact' })
                .lt('created_at', cutoff)
                .select('id');
            if (purgeError) {
                await logErrorToDb(req, 'cron_audit_retention_error', purgeError);
                result.audit_purged = null;
            } else {
                result.audit_purged = Array.isArray(purged) ? purged.length : 0;
                if (result.audit_purged > 0) {
                    await logAudit('system', 'PURGE_AUDIT_LOGS', null, { days: retention, cutoff, deleted: result.audit_purged, source: 'cron' }, 'cron');
                }
            }
        }
        // v2.24.0：每日排程順便看「有沒有哪個系列該開下一場了」（沒設定週期的賽事完全不影響）
        result.recurring = await runRecurringCompetitions();
        res.json(Object.assign({ ok: true, ranAt: new Date().toISOString() }, result));
    } catch (err) {
        if (isMissingTableError(err) || /migration/.test(err.message || '')) {
            return res.status(503).json({ error: err.message });
        }
        await logErrorToDb(req, 'push_cron_error', err);
        res.status(500).json({ error: err.message });
    }
});
};
