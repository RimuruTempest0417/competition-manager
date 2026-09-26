/* 隊伍與隊員編排（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/teams')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMCompetitionState = require('../public/js/competition-state');

module.exports = function registerTeamsRoutes(app, ctx) {
    const { ADMIN_ROLES, REGISTRATION_HINT, SUPER_ADMIN_ROLES, attendanceSchemaReady, authenticateToken, cleanText, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, notifyOnPromote, registrationReviewSchemaReady, requireAdmin, requireSuperAdmin, supabase, waitlistNotifySchemaReady, waitlistOrderSchemaReady } = ctx;
app.get('/api/competitions/:id/teams', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    try {
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const notifyReady = reviewReady ? await waitlistNotifySchemaReady() : false;
        const attendanceReady = await attendanceSchemaReady();     // v3.6.2：現場報到欄位
        // 只有欄位存在時才多查一次（未執行 migration 時不多打一次資料庫）
        const notifyRow = notifyReady ? await fetchCompetition(competitionId) : null;
        const attendanceCols = attendanceReady ? ',attended_at,attended_by,onsite' : '';
        const [teamsRes, regsRes] = await Promise.all([
            supabase.from('competition_teams').select('*').eq('competition_id', competitionId).eq('is_deleted', false).order('id', { ascending: true }),
            supabase.from('registrations')
                .select(reviewReady
                    ? `id,username,user_id,team_id,team_name,status,created_at${orderReady ? ',waitlist_order' : ''}${attendanceCols}`
                    : `id,username,user_id,team_id,team_name${attendanceCols}`)
                .eq('competition_id', competitionId)
                .eq('is_deleted', false)
                .order('id', { ascending: true })
        ]);
        if (teamsRes.error) throw teamsRes.error;
        if (regsRes.error) throw regsRes.error;

        const regs = (regsRes.data || []).map((r) => {
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            return Object.assign({}, r, {
                status,
                status_label: CMCompetitionState.REG_STATUS_LABELS[status]
            });
        });
        // 只有「已核准」的人算在隊伍名單裡（待審核／候補還不確定能不能參賽，不該先編隊）
        const approved = regs.filter((r) => r.status === 'confirmed');
        const teams = (teamsRes.data || []).map((t) => Object.assign({}, t, {
            members: approved.filter((r) => String(r.team_id) === String(t.id))
        }));

        const queue = CMCompetitionState.waitlistQueue(regs);
        const pending = regs.filter((r) => r.status === 'pending');
        const waitlisted = queue.map((r, i) => Object.assign({}, r, { waitlist_position: i + 1 }));

        // v3.6.2：現場名單＝所有正取（含已編隊的），現場報到要一次看到全部
        const attendance = attendanceReady ? {
            expected: approved.length,
            attended: approved.filter((r) => r.attended_at).length,
            onsite: approved.filter((r) => r.onsite === true).length
        } : undefined;

        res.json({
            teams,
            unassigned: approved.filter((r) => !r.team_id),
            // v3.6.2：現場報到用（正取完整名單＋統計；前端據 attended_at 畫勾選狀態）
            approved,
            attendance,
            attendance_schema_ready: attendanceReady,
            // v2.20.0：審核／候補用的清單（管理員才看得到內容，但一般用戶本來就打不到這個端點）
            pending,
            waitlisted,
            counts: CMCompetitionState.countByStatus(regs),
            schema_ready: reviewReady,
            // v2.21.0：候補順位可不可以手動調整（有欄位才行；沒欄位時前端不顯示上下移按鈕）
            canReorderWaitlist: orderReady,
            // v2.22.0：遞補通知開關（未執行 migration 時 notify_schema_ready=false、一律視為開啟）
            notify_schema_ready: notifyReady,
            notify_on_promote: notifyOnPromote(notifyRow),
            totalRegistrations: regs.length,
            canArrange: ADMIN_ROLES.has(req.user.role),
            canDelete: SUPER_ADMIN_ROLES.has(req.user.role)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'list_teams_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 建立隊伍（管理員以上）
app.post('/api/competitions/:id/teams', requireAdmin, async (req, res) => {
    const competitionId = req.params.id;
    const body = req.body || {};
    const name = cleanText(body.name, 40);
    const operator = req.currentUser;

    if (!name) return res.status(400).json({ error: '請輸入隊伍名稱' });

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { data: dup, error: dupErr } = await supabase
            .from('competition_teams')
            .select('id')
            .eq('competition_id', competitionId)
            .eq('name', name)
            .eq('is_deleted', false)
            .maybeSingle();
        if (dupErr) throw dupErr;
        if (dup) return res.status(409).json({ error: '此賽事已有同名隊伍' });

        const { data, error } = await supabase
            .from('competition_teams')
            .insert([{
                competition_id: comp.id,
                name,
                note: cleanText(body.note, 200) || null,
                created_by: operator.username,
                is_deleted: false,
                created_at: new Date().toISOString()
            }])
            .select();
        if (error) throw error;

        await logAudit(operator.username, 'CREATE_TEAM', comp.id, `建立隊伍: ${name}`, req.userAgent);
        res.json({ message: '隊伍已建立', team: data[0] });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'create_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 修改隊伍名稱／備註（管理員以上）
app.put('/api/teams/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const operator = req.currentUser;

    try {
        const payload = {};
        if (body.name !== undefined) {
            const name = cleanText(body.name, 40);
            if (!name) return res.status(400).json({ error: '隊伍名稱不可為空' });
            payload.name = name;
        }
        if (body.note !== undefined) payload.note = cleanText(body.note, 200) || null;
        if (Object.keys(payload).length === 0) return res.status(400).json({ error: '沒有要更新的欄位' });

        const { data, error } = await supabase.from('competition_teams').update(payload).eq('id', id).select();
        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到該隊伍' });

        await logAudit(operator.username, 'UPDATE_TEAM', id, `更新隊伍: ${data[0].name}`, req.userAgent);
        res.json({ message: '隊伍已更新', team: data[0] });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'update_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 刪除隊伍（超級管理員以上）：隊員會自動移出隊伍、報名紀錄保留
app.delete('/api/teams/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data: team, error } = await supabase.from('competition_teams').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!team || team.is_deleted) return res.status(404).json({ error: '找不到該隊伍' });

        const { error: detachErr } = await supabase.from('registrations').update({ team_id: null }).eq('team_id', id);
        if (detachErr) throw detachErr;

        const { error: delErr } = await supabase.from('competition_teams').update({ is_deleted: true }).eq('id', id);
        if (delErr) throw delErr;

        await logAudit(operator.username, 'DELETE_TEAM', team.competition_id, `刪除隊伍: ${team.name}`, req.userAgent);
        res.json({ message: '隊伍已刪除' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'delete_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 編排：把報名者加入隊伍（管理員以上）
app.post('/api/teams/:id/members', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const registrationId = req.body && req.body.registrationId;
    const operator = req.currentUser;

    if (!registrationId) return res.status(400).json({ error: '缺少 registrationId' });

    try {
        const [teamRes, regRes] = await Promise.all([
            supabase.from('competition_teams').select('*').eq('id', id).maybeSingle(),
            supabase.from('registrations').select('*').eq('id', registrationId).maybeSingle()
        ]);
        if (teamRes.error) throw teamRes.error;
        if (regRes.error) throw regRes.error;

        const team = teamRes.data;
        const reg = regRes.data;
        if (!team || team.is_deleted) return res.status(404).json({ error: '找不到該隊伍' });
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到該報名紀錄' });
        if (String(reg.competition_id) !== String(team.competition_id)) {
            return res.status(400).json({ error: '報名紀錄與隊伍不屬於同一場賽事' });
        }

        // v2.20.0：只有「已核准」的報名可以編進隊伍（待審核／候補還沒確定能不能參賽）
        const regStatus = CMCompetitionState.normalizeRegStatus(reg.status);
        if (regStatus !== 'confirmed') {
            return res.status(400).json({
                error: `只能編排「已核准」的報名（${reg.username} 目前是「${CMCompetitionState.REG_STATUS_LABELS[regStatus]}」）`
            });
        }

        const comp = await fetchCompetition(team.competition_id);
        const teamSize = parseInt(comp && comp.team_size, 10) || 0;
        if (teamSize > 0) {
            const { data: current, error: cntErr } = await supabase
                .from('registrations')
                .select('id')
                .eq('team_id', team.id)
                .eq('is_deleted', false);
            if (cntErr) throw cntErr;
            const others = (current || []).filter((r) => String(r.id) !== String(reg.id)).length;
            if (others >= teamSize) return res.status(400).json({ error: `此隊伍已達人數上限（${teamSize} 人）` });
        }

        const { error: updErr } = await supabase.from('registrations').update({ team_id: team.id }).eq('id', reg.id);
        if (updErr) throw updErr;

        await logAudit(operator.username, 'ASSIGN_TEAM_MEMBER', team.competition_id,
            `編排 ${reg.username} 至隊伍「${team.name}」`, req.userAgent);

        res.json({ message: `已將 ${reg.username} 編入「${team.name}」` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'assign_team_member_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 移除隊員（超級管理員以上）
app.delete('/api/teams/:id/members/:registrationId', requireSuperAdmin, async (req, res) => {
    const { id, registrationId } = req.params;
    const operator = req.currentUser;

    try {
        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', registrationId).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到該報名紀錄' });
        if (String(reg.team_id) !== String(id)) return res.status(400).json({ error: '此報名者不在該隊伍中' });

        const { error: updErr } = await supabase.from('registrations').update({ team_id: null }).eq('id', registrationId);
        if (updErr) throw updErr;

        await logAudit(operator.username, 'REMOVE_TEAM_MEMBER', reg.competition_id,
            `將 ${reg.username} 移出隊伍`, req.userAgent);

        res.json({ message: `已將 ${reg.username} 移出隊伍` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'remove_team_member_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// v2.10.0：賽事海報（手動上傳，取代自動生成）與 Web Push 推播訂閱
// ==========================================
// v3.0.0：列表單次上限（存在＝避免一次要求太多筆把資料庫打爆；預設請求不切片）
};
