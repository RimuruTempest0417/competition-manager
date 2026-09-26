/* 成績與結果（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/results')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMResults = require('../public/js/results');                // v3.1.0：成績、名次與公布檢查的唯一真實來源

module.exports = function registerResultsRoutes(app, ctx) {
    const { ADMIN_ROLES, RESULTS_HINT, authenticateToken, decorateResult, fetchCompetition, isMissingTableError, loadApprovedRegistrations, loadResultRows, logAudit, logErrorToDb, logPushEvent, notifyUser, optionalAuth, requireAdmin, resultSchemaReady, supabase } = ctx;
app.get('/api/competitions/:id/results', optionalAuth, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const isAdmin = !!(req.user && ADMIN_ROLES.has(req.user.role));
        const published = !!comp.result_published_at;
        const payload = {
            competition: { id: comp.id, name: comp.name, date: comp.date, category: comp.category },
            published,
            published_at: comp.result_published_at || null,
            published_by: comp.result_published_by || null,
            summary: comp.result_summary || null,
            results: [],
            stats: null
        };

        if (!published && !isAdmin) {
            payload.message = '成績尚未公布';
            return res.json(payload);
        }

        const rows = await loadResultRows(comp.id);
        payload.results = rows;
        payload.stats = CMResults.summarize(rows);
        payload.draft = !published;

        if (isAdmin) {
            const approved = await loadApprovedRegistrations(comp.id);
            payload.checklist = CMResults.publishChecklist(approved, rows);
            payload.approved_count = approved.length;
        }

        res.json(payload);
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'competition_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 成績登錄用的完整表單（管理員以上）：參賽名單＋已登錄成績＋統計＋公布前檢查 */
app.get('/api/competitions/:id/result-sheet', requireAdmin, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const approved = await loadApprovedRegistrations(comp.id);
        const rows = await loadResultRows(comp.id);
        const byReg = {};
        rows.forEach((r) => { byReg[String(r.registration_id)] = r; });

        // 名單為主體：每個人都有一列（已登錄的填好值），不會因為漏登錄就看不到人
        const entries = approved.map((reg) => {
            const existing = byReg[String(reg.id)];
            return {
                registration_id: reg.id,
                user_id: reg.user_id,
                username: reg.username,
                display_name: reg.display_name,
                status: existing ? existing.status : 'finished',
                score_text: existing ? existing.score_text : null,
                rank: existing ? existing.rank : null,
                note: existing ? existing.note : null,
                result_id: existing ? existing.id : null,
                existing: !!existing
            };
        });

        // 有成績但報名已不在名單裡（例如後來被取消錄取）：單獨列出來，不要默默消失
        const orphan = rows
            .filter((r) => !approved.some((reg) => String(reg.id) === String(r.registration_id)))
            .map((r) => ({
                registration_id: r.registration_id,
                display_name: r.display_name || r.username || '（已移除的報名）',
                rank: r.rank,
                score_text: r.score_text,
                status: r.status,
                result_id: r.id,
                line: r.line
            }));

        res.json({
            competition: { id: comp.id, name: comp.name, date: comp.date, category: comp.category },
            published: !!comp.result_published_at,
            published_at: comp.result_published_at || null,
            published_by: comp.result_published_by || null,
            summary: comp.result_summary || null,
            approved_count: approved.length,
            entries,
            orphan,
            stats: CMResults.summarize(rows),
            checklist: CMResults.publishChecklist(approved, rows),
            max_score_length: CMResults.SCORE_MAX,
            max_note_length: CMResults.NOTE_MAX,
            max_summary_length: CMResults.SUMMARY_MAX
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'result_sheet_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 儲存成績（管理員以上）：整批驗證通過才寫，避免「寫了一半」的成績表 */
app.put('/api/competitions/:id/results', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const incoming = Array.isArray(body.results) ? body.results : null;

    if (!incoming) return res.status(400).json({ error: '要送出的成績要放在 results 陣列裡' });
    if (incoming.length > 500) return res.status(400).json({ error: '一次最多儲存 500 筆成績' });

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const approved = await loadApprovedRegistrations(comp.id);
        const allowed = new Set(approved.map((r) => String(r.id)));

        const errors = [];
        const values = [];
        incoming.forEach((raw, i) => {
            const parsed = CMResults.normalizeResultInput(raw);
            if (parsed.error) { errors.push(`第 ${i + 1} 列：${parsed.error}`); return; }
            if (!allowed.has(String(parsed.value.registration_id))) {
                errors.push(`第 ${i + 1} 列：這筆報名不在本賽事的已核准名單中`);
                return;
            }
            const reg = approved.find((r) => String(r.id) === String(parsed.value.registration_id));
            values.push(Object.assign({}, parsed.value, {
                user_id: parsed.value.user_id || reg.user_id,
                username: parsed.value.username || reg.username,
                display_name: parsed.value.display_name || reg.display_name
            }));
        });

        // 同一個報名送兩次＝使用者填錯，直接說清楚而不是後者覆蓋前者
        const seen = new Set();
        const dup = [];
        values.forEach((v) => {
            const key = String(v.registration_id);
            if (seen.has(key)) dup.push(key);
            seen.add(key);
        });
        if (dup.length) errors.push(`同一筆報名重複送出（報名編號 ${dup.join('、')}）`);

        if (errors.length) {
            return res.status(400).json({ error: errors.join('；'), errors });
        }

        // 一鍵自動排名：規則是共用的，後端算完才寫入（不是存回去讓前端自己算）
        const ranked = body.auto_rank ? CMResults.autoRank(values, { order: body.order === 'desc' ? 'desc' : 'asc' }) : values;

        const now = new Date().toISOString();
        const records = ranked.map((v) => ({
            competition_id: comp.id,
            registration_id: v.registration_id,
            user_id: v.user_id || null,
            username: v.username || null,
            display_name: v.display_name || null,
            status: v.status,
            score_text: v.score_text,
            rank: v.rank,
            note: v.note,
            recorded_by: req.user.username,
            updated_at: now
        }));

        // 明確要求刪除的成績（送 remove_ids；沒送就一筆都不刪）
        const removeIds = (Array.isArray(body.remove_ids) ? body.remove_ids : [])
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v > 0);
        let removed = 0;
        if (removeIds.length) {
            const { error: delErr } = await supabase
                .from('competition_results')
                .delete()
                .eq('competition_id', comp.id)
                .in('id', removeIds);
            if (delErr) throw delErr;
            removed = removeIds.length;
        }

        if (records.length) {
            const { error: upErr } = await supabase
                .from('competition_results')
                .upsert(records, { onConflict: 'competition_id,registration_id' });
            if (upErr) throw upErr;
        }

        await logAudit(req.user.username, 'SAVE_RESULTS', comp.id,
            `登錄成績: ${comp.name}（儲存 ${records.length} 筆${body.auto_rank ? '，自動排名' : ''}${removed ? `，刪除 ${removed} 筆` : ''}）`,
            req.userAgent);

        const rows = await loadResultRows(comp.id);
        const checklist = CMResults.publishChecklist(approved, rows);
        res.json({
            message: removed && !records.length ? '已刪除指定的成績' : `已儲存 ${records.length} 筆成績`,
            saved: records.length,
            removed,
            auto_ranked: !!body.auto_rank,
            stats: CMResults.summarize(rows),
            checklist,
            results: rows
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'save_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 公布成績（管理員以上）：公布是對外動作，要明確帶 confirm 才做 */
app.post('/api/competitions/:id/results/publish', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
        return res.status(400).json({ error: '公布成績會讓所有訪客看到，請帶 confirm: true 再送一次' });
    }

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const rows = await loadResultRows(comp.id);
        if (!rows.length) {
            return res.status(400).json({ error: '這場賽事還沒有任何成績，請先登錄再公布' });
        }

        const summary = CMResults.normalizeSummary(body.summary) || comp.result_summary || null;
        const patch = {
            result_published_at: new Date().toISOString(),
            result_published_by: req.user.username,
            result_summary: summary
        };
        const { error } = await supabase.from('competitions').update(patch).eq('id', comp.id);
        if (error) throw error;

        const stats = CMResults.summarize(rows);
        const podium = stats.podium.map((p) => `${p.medal}${p.name}`).join('、');

        // 名次提示：沒名次的人不算錯誤，但要在稽核裡看得出來有幾位
        await logAudit(req.user.username, 'PUBLISH_RESULTS', comp.id,
            `公布成績: ${comp.name}（${rows.length} 筆，前三名 ${podium || '從缺'}）`,
            req.userAgent);

        // 通知參賽者（站台層事件開關 push_event_result 關掉就不送）
        let push = { sent: 0, failed: 0, total: 0, skipped: null, notified_users: 0 };
        if (body.notify === true) {
            const targets = rows.filter((r) => r.user_id);
            const targetIds = [];
            const errors = [];
            for (const row of targets) {
                const payload = {
                    kind: 'result',
                    title: `成績已公布：${comp.name}`,
                    body: `${comp.name} 的成績已公布${row.rank ? `：你獲得第 ${row.rank} 名` : ''}`,
                    url: '/?view=myregs',
                    tag: `cm-result-${comp.id}`
                };
                const result = await notifyUser(row.user_id, payload, { kind: 'result' });
                push.total += result.total || 0;
                push.sent += result.sent || 0;
                push.failed += result.failed || 0;
                if (result.skipped) push.skipped = result.skipped;
                // 紀錄的是「這次推播的對象」＝嘗試送達的人（與公告的推播紀錄一致）；
                // 送出成功與否看 sent／failed，不要把失敗的人從對象名單裡抹掉。
                targetIds.push(row.user_id);
                if (result.errors && result.errors.length) errors.push(...result.errors);
            }
            push.notified_users = targetIds.length;
            await logPushEvent(comp.id, 'result_published', push.sent, {
                failed: push.failed,
                errors,
                payload: { title: `成績已公布：${comp.name}`, body: '...', url: '/?view=myregs' },
                target_user_ids: targetIds
            });
        }

        res.json({
            message: `已公布 ${rows.length} 筆成績`,
            published: true,
            published_at: patch.result_published_at,
            published_by: patch.result_published_by,
            summary,
            stats,
            notified: push
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'publish_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 取消公布（管理員以上）：成績回到草稿狀態，前台立刻看不到 */
app.post('/api/competitions/:id/results/unpublish', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
        return res.status(400).json({ error: '取消公布會讓前台看不到成績，請帶 confirm: true 再送一次' });
    }

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });
        if (!comp.result_published_at) return res.status(400).json({ error: '這場賽事的成績目前沒有公布' });

        const { error } = await supabase.from('competitions')
            .update({ result_published_at: null, result_published_by: null })
            .eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'UNPUBLISH_RESULTS', comp.id,
            `取消公布成績: ${comp.name}（成績保留為草稿）`, req.userAgent);

        res.json({ message: '已取消公布，成績保留為草稿', published: false });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'unpublish_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 我的成績（已登入者）：只回「已公布」的，草稿不會不小心被看到 */
app.get('/api/my/results', authenticateToken, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.json([]);

        const { data, error } = await supabase
            .from('competition_results')
            .select('*, competitions(id,name,date,category,result_published_at,is_deleted)')
            .eq('user_id', req.user.sub);
        if (error) throw error;

        const rows = (data || [])
            .filter((r) => r.competitions && !r.competitions.is_deleted && r.competitions.result_published_at)
            .map((r) => {
                const decorated = decorateResult(r);
                decorated.competition_name = r.competitions.name;
                decorated.competition_date = r.competitions.date;
                decorated.competition_category = r.competitions.category;
                decorated.medal = CMResults.medalFor(decorated.rank);
                return decorated;
            });

        res.json(rows);
    } catch (err) {
        if (isMissingTableError(err)) return res.json([]);
        await logErrorToDb(req, 'my_results_error', err);
        res.status(500).json({ error: err.message });
    }
});
};
