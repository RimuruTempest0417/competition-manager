/* 賽事海報（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/posters')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerPostersRoutes(app, ctx) {
    const { POSTER_HINT, POSTER_MAX_BYTES, POSTER_THUMB_MAX_BYTES, columnExists, fetchCompetition, isMissingColumnError, isMissingTableError, logAudit, logErrorToDb, parseImageDataUrl, requireAdmin, supabase } = ctx;
app.post('/api/competitions/:id/poster', requireAdmin, async (req, res) => {
    const parsed = parseImageDataUrl(req.body && req.body.dataUrl);
    if (!parsed) return res.status(400).json({ error: '海報格式錯誤：請上傳 JPG、PNG 或 WebP 圖片' });
    if (parsed.buffer.length > POSTER_MAX_BYTES) {
        const mb = Math.round((parsed.buffer.length / 1024 / 1024) * 10) / 10;
        return res.status(413).json({ error: `海報檔案過大（${mb}MB），上限 3MB` });
    }

    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        // v3.0.0：縮圖（可選）。前端上傳時用 canvas 產生，列表與預覽改載縮圖；
        // 讀不到 thumb_* 欄位（尚未跑 migration）就照舊只存原圖，功能不受影響。
        const thumbParsed = parseImageDataUrl(req.body && req.body.thumbDataUrl);
        // 不論這次有沒有帶縮圖都要知道欄位在不在：沒帶的時候要能「清掉舊縮圖」，
        // 否則換了海報會留著上一張的縮圖（列表就會顯示錯的圖）。
        const thumbReady = await columnExists('competition_posters', 'thumb_data');
        const thumbTooBig = !!(thumbParsed && thumbParsed.buffer.length > POSTER_THUMB_MAX_BYTES);
        const useThumb = !!(thumbParsed && thumbReady && !thumbTooBig);

        const now = new Date().toISOString();
        const posterRow = {
            competition_id: comp.id,
            mime: parsed.mime,
            bytes: parsed.buffer.length,
            data: parsed.buffer.toString('base64'),
            uploaded_by: req.currentUser ? req.currentUser.username : null,
            updated_at: now
        };
        if (useThumb) {
            posterRow.thumb_mime = thumbParsed.mime;
            posterRow.thumb_bytes = thumbParsed.buffer.length;
            posterRow.thumb_data = thumbParsed.buffer.toString('base64');
        } else if (thumbReady) {
            // 這次沒帶縮圖（或超過上限）→ 明確清掉舊縮圖，避免「新海報配舊縮圖」
            posterRow.thumb_mime = null;
            posterRow.thumb_bytes = null;
            posterRow.thumb_data = null;
        }

        const { error: upErr } = await supabase.from('competition_posters').upsert([posterRow], { onConflict: 'competition_id' });
        if (upErr) throw upErr;

        const { error: colErr } = await supabase.from('competitions').update({ poster_updated_at: now }).eq('id', comp.id);
        if (colErr) throw colErr;

        await logAudit(req.user.username, 'UPLOAD_POSTER', comp.id,
            `上傳自訂海報（${Math.round(parsed.buffer.length / 1024)}KB${useThumb ? `，縮圖 ${Math.round(thumbParsed.buffer.length / 1024)}KB` : ''}）`, req.userAgent);
        res.json({
            message: '海報已更新，分享與卡片都會改用手動上傳的海報',
            posterUrl: `/api/competitions/${comp.id}/poster?v=${Date.parse(now)}`,
            thumbUrl: useThumb ? `/api/competitions/${comp.id}/poster?variant=thumb&v=${Date.parse(now)}` : null,
            bytes: parsed.buffer.length,
            thumb_bytes: useThumb ? thumbParsed.buffer.length : null,
            thumb_saved: useThumb ? (parsed.buffer.length - thumbParsed.buffer.length) : null,
            thumb_note: (thumbParsed && thumbTooBig) ? `縮圖超過 ${Math.round(POSTER_THUMB_MAX_BYTES / 1024)}KB，已改存原圖` : null
        });
    } catch (err) {
        if (isMissingTableError(err) || isMissingColumnError(err, ['poster_updated_at'])) {
            return res.status(503).json({ error: POSTER_HINT });
        }
        await logErrorToDb(req, 'poster_upload_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 移除海報（管理員以上）→ 回到自動生成海報
app.delete('/api/competitions/:id/poster', requireAdmin, async (req, res) => {
    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { error: delErr } = await supabase.from('competition_posters').delete().eq('competition_id', comp.id);
        if (delErr) throw delErr;
        const { error: colErr } = await supabase.from('competitions').update({ poster_updated_at: null }).eq('id', comp.id);
        if (colErr) throw colErr;

        await logAudit(req.user.username, 'DELETE_POSTER', comp.id, '移除自訂海報（改回自動生成）', req.userAgent);
        res.json({ message: '已移除自訂海報，分享將改回自動生成的海報' });
    } catch (err) {
        if (isMissingTableError(err) || isMissingColumnError(err, ['poster_updated_at'])) {
            return res.status(503).json({ error: POSTER_HINT });
        }
        await logErrorToDb(req, 'poster_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 取得海報（公開）：同源提供，維持 CSP img-src 'self'，完全不需外部網域
app.get('/api/competitions/:id/poster', async (req, res) => {
    try {
        // v3.0.0：?variant=thumb 只回縮圖。沒有縮圖（舊海報，或還沒跑 migration）就退回原圖，
        // 呼叫端不必自己判斷有沒有縮圖（回應會用 X-Poster-Variant 標示實際回的是哪一種）。
        const wantsThumb = String(req.query.variant || '') === 'thumb';
        const thumbColsReady = wantsThumb ? await columnExists('competition_posters', 'thumb_data') : false;

        const { data, error } = await supabase
            .from('competition_posters')
            .select(thumbColsReady ? 'mime,data,thumb_mime,thumb_data' : 'mime,data')
            .eq('competition_id', req.params.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.data) return res.status(404).json({ error: '此賽事沒有自訂海報' });

        if (wantsThumb) {
            const thumbBase64 = thumbColsReady ? data.thumb_data : null;
            if (thumbBase64) {
                const thumbBuffer = Buffer.from(thumbBase64, 'base64');
                res.set('Content-Type', data.thumb_mime || 'image/jpeg');
                res.set('Content-Length', String(thumbBuffer.length));
                res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
                res.set('X-Content-Type-Options', 'nosniff');
                res.set('X-Poster-Variant', 'thumb');
                return res.send(thumbBuffer);
            }
            res.set('X-Poster-Variant', 'full-fallback');
        }

        const buffer = Buffer.from(data.data, 'base64');
        res.set('Content-Type', data.mime || 'image/jpeg');
        res.set('Content-Length', String(buffer.length));
        res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(buffer);
    } catch (err) {
        res.status(404).json({ error: '此賽事沒有自訂海報' });
    }
});

// ---------- v3.3.0（P1-6）：賽事規程 PDF 附件 ----------
// 規程是公開資訊（參賽者、家長、現場人員都該看得到），所以 GET 不驗身分；
// 上傳／移除限管理員以上。存法與海報一致（base64 存 DB、同源提供），
// 不需要外部物件儲存，CSP 也不用放寬。
//
// 為什麼上限是 3MB：Vercel 函式的請求上限是 4.5MB，而 base64 會膨脹約 4/3，
// 3MB 的 PDF 上傳後約 4MB，還在安全範圍內。
};
