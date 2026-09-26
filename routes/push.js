/* 推播訂閱（Web Push）（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/push')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerPushRoutes(app, ctx) {
    const { PUSH_HINT, allowPublicWrite, getVapidKeys, isMissingTableError, logAudit, logErrorToDb, optionalAuth, sendPushTo, serverState, supabase } = ctx;
app.get('/api/push/public-key', async (req, res) => {
    if (!serverState.webpush) return res.status(503).json({ error: '伺服器未啟用推播（缺少 web-push 套件）' });
    const keys = await getVapidKeys();
    if (!keys) return res.status(503).json({ error: PUSH_HINT });
    res.json({ publicKey: keys.publicKey });
});
app.post('/api/push/subscribe', optionalAuth, async (req, res) => {
    const sub = (req.body && req.body.subscription) || {};
    const keys = sub.keys || {};
    if (!sub.endpoint || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ error: '訂閱資料不完整' });
    }
    try {
        const { error } = await supabase.from('push_subscriptions').upsert([{
            endpoint: sub.endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            user_id: req.user ? req.user.sub : null,
            username: req.user ? req.user.username : null,
            user_agent: (req.headers['user-agent'] || '').slice(0, 300),
            is_active: true,
            last_seen_at: new Date().toISOString()
        }], { onConflict: 'endpoint' });
        if (error) throw error;
        res.json({ message: '已開啟瀏覽器推播訂閱' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_subscribe_error', err);
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/push/unsubscribe', async (req, res) => {
    if (!allowPublicWrite(req.ip, 'push-unsub', 30, 60000)) {
        return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: '缺少訂閱識別（endpoint）' });
    try {
        const { error } = await supabase.from('push_subscriptions').update({ is_active: false }).eq('endpoint', endpoint);
        if (error) throw error;
        res.json({ message: '已關閉此裝置的推播訂閱' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_unsubscribe_error', err);
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/push/test', async (req, res) => {
    // v2.12.0：送出推播的端點較敏感，限制每分鐘 10 次
    if (!allowPublicWrite(req.ip, 'push-test', 10, 60000)) {
        return res.status(429).json({ error: '測試推播過於頻繁，請稍後再試' });
    }

    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: '缺少訂閱識別（endpoint）' });
    if (!serverState.webpush) return res.status(503).json({ error: '伺服器未啟用推播（缺少 web-push 套件）' });
    try {
        const { data, error } = await supabase.from('push_subscriptions').select('*').eq('endpoint', endpoint).maybeSingle();
        if (error) throw error;
        if (!data || !data.is_active) return res.status(404).json({ error: '找不到有效的訂閱紀錄' });

        const result = await sendPushTo(data, {
            title: '🔔 測試通知',
            body: '推播訂閱成功！之後即使關閉網頁，也能收到新賽事與開賽提醒。',
            url: '/',
            tag: 'cm-push-test'
        });
        if (result.gone) {
            await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', data.id);
        }
        // v2.19.0：實際有送出（或嘗試送出）就要留稽核紀錄——只記訂閱 id 與結果，不記 endpoint（隱私）
        await logAudit((req.user && req.user.username) || 'guest', 'SEND_PUSH', data.id, {
            source: 'test', ok: !!result.ok, error: result.ok ? null : String(result.error || '').slice(0, 120)
        }, req.userAgent);
        res.json({ ok: result.ok, message: result.ok ? '測試通知已送出（請看系統通知）' : `送出失敗：${result.error}` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_test_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 定時推播核心：找出「即將開賽（24 小時內）」與「上次執行後新發布」的賽事，
// 對所有有效訂閱發送，並以 push_log 去重（同一賽事同一類型只送一次）。
};
