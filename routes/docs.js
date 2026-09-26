/* 賽事規程 PDF 附件（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/docs')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerDocsRoutes(app, ctx) {
    const { DOC_HINT, DOC_LABEL_MAX, DOC_MAX_BYTES, docFileName, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, parsePdfDataUrl, requireAdmin, supabase } = ctx;
app.get('/api/competitions/:id/doc', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competition_docs')
            .select('label,mime,bytes,data,uploaded_at')
            .eq('competition_id', req.params.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.data) return res.status(404).json({ error: '此賽事沒有上傳規程附件' });

        const buffer = Buffer.from(data.data, 'base64');
        const name = docFileName(data.label, req.params.id);
        const wantsDownload = String(req.query.download || '') === '1';
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Length', String(buffer.length));
        res.set('Cache-Control', 'public, max-age=600');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Doc-Label', encodeURIComponent(name.label));
        res.set('Content-Disposition',
            `${wantsDownload ? 'attachment' : 'inline'}; filename="${name.plain}"; filename*=UTF-8''${name.utf8}`);
        res.send(buffer);
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: DOC_HINT });
        res.status(404).json({ error: '此賽事沒有上傳規程附件' });
    }
});

// 上傳／更新規程（管理員以上）：一場賽事一份，上傳即覆蓋
app.post('/api/competitions/:id/doc', requireAdmin, async (req, res) => {
    const parsed = parsePdfDataUrl(req.body && (req.body.dataUrl || req.body.data));
    if (!parsed) return res.status(400).json({ error: '規程附件格式錯誤：請上傳 PDF 檔' });
    if (parsed.buffer.length > DOC_MAX_BYTES) {
        const mb = Math.round((parsed.buffer.length / 1024 / 1024) * 10) / 10;
        return res.status(413).json({ error: `規程檔案過大（${mb}MB），上限 3MB` });
    }

    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const label = String((req.body && req.body.label) || '').trim().slice(0, DOC_LABEL_MAX) || '賽事規程';
        const now = new Date().toISOString();
        const row = {
            competition_id: comp.id,
            label,
            mime: 'application/pdf',
            bytes: parsed.buffer.length,
            data: parsed.buffer.toString('base64'),
            uploaded_by: req.currentUser ? req.currentUser.username : null,
            uploaded_at: now
        };
        const { error: upErr } = await supabase.from('competition_docs').upsert([row], { onConflict: 'competition_id' });
        if (upErr) throw upErr;

        await logAudit(req.user.username, 'UPLOAD_DOC', comp.id,
            `上傳賽事規程「${label}」（${Math.round(parsed.buffer.length / 1024)}KB）`, req.userAgent);
        res.json({
            message: `已上傳規程附件「${label}」，所有人都能在賽事卡片上打開`,
            label,
            bytes: parsed.buffer.length,
            uploaded_at: now,
            doc_url: `/api/competitions/${comp.id}/doc?v=${Date.parse(now)}`
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: DOC_HINT });
        await logErrorToDb(req, 'doc_upload_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 移除規程（管理員以上）
app.delete('/api/competitions/:id/doc', requireAdmin, async (req, res) => {
    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { data: existing } = await supabase.from('competition_docs').select('label').eq('competition_id', comp.id).maybeSingle();
        const { error: delErr } = await supabase.from('competition_docs').delete().eq('competition_id', comp.id);
        if (delErr) throw delErr;

        await logAudit(req.user.username, 'DELETE_DOC', comp.id,
            `移除賽事規程附件${existing && existing.label ? `「${existing.label}」` : ''}`, req.userAgent);
        res.json({ message: '已移除規程附件' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: DOC_HINT });
        await logErrorToDb(req, 'doc_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Web Push（推播訂閱服務）----------
// 伺服器端使用 web-push 套件（僅後端，不影響 CSP script-src 'self'）。
// VAPID 金鑰：優先讀環境變數；否則首次使用時自動產生並存進 app_settings，
// 因此私鑰不會出現在程式碼或對話中，也不需要手動設定環境變數。
};
