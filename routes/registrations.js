/* 報名、審核、候補與帳號（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/registrations')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMCompetitionState = require('../public/js/competition-state');
const CMPaging = require('../public/js/paging');                  // v3.0.0：分頁規則的唯一真實來源（前後端共用）
const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('../lib/passwords');
// v2.15.0：兩步驟驗證（TOTP）—— 純手寫實作，只用 Node 內建 crypto，無外部套件

module.exports = function registerRegistrationsRoutes(app, ctx) {
    const { ADMIN_ROLES, setAuthCookie, clearAuthCookie, GENERIC_DB_ERROR, JWT_SECRET, PASSWORD_RE, REGISTRATIONS_PAGE_MAX, REGISTRATION_HINT, REGISTRATION_REVIEW_HINT, USERNAME_RE, WAITLIST_HISTORY_MAX_WINDOW, WAITLIST_NOTIFY_HINT, WAITLIST_ORDER_HINT, allowRegisterAttempt, auditActionLabel, authenticateToken, cleanText, competitionState, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, logPushEvent, notifyOnPromote, notifyUser, registrationReviewSchemaReady, registrationSummary, requireAdmin, requireSuperAdmin, staffSchemaReady, supabase, waitlistNotifySchemaReady, waitlistOrderSchemaReady } = ctx;
app.get('/api/registration-counts', async (req, res) => {
    try {
        // v2.20.0：公開端點只回「佔名額的人數」與「候補人數」這種聚合數字，不含任何個人資訊
        const reviewReady = await registrationReviewSchemaReady();
        const { data, error } = await supabase
            .from('registrations')
            .select(reviewReady ? 'competition_id,status' : 'competition_id')
            .eq('is_deleted', false);
        if (error) throw error;

        const counts = {};
        const waitlist = {};
        (data || []).forEach((r) => {
            const key = String(r.competition_id);
            if (reviewReady && CMCompetitionState.normalizeRegStatus(r.status) === 'waitlisted') {
                waitlist[key] = (waitlist[key] || 0) + 1;
                return;
            }
            counts[key] = (counts[key] || 0) + 1;
        });

        // v2.27.0：工作人員人數（卡片徽章用）。同樣只有聚合數字，不含誰是誰。
        let staffCounts = {};
        try {
            if (await staffSchemaReady()) {
                const { data: staffRows, error: staffErr } = await supabase
                    .from('competition_staff')
                    .select('competition_id');
                if (staffErr) throw staffErr;
                (staffRows || []).forEach((r) => {
                    const key = String(r.competition_id);
                    staffCounts[key] = (staffCounts[key] || 0) + 1;
                });
            }
        } catch (staffErr) {
            // 工作人員人數拿不到不該讓報名人數整包失敗（前端只是少一個徽章）
            staffCounts = {};
        }

        res.json({ counts, waitlist, staff: staffCounts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
    } catch (err) {
        // 前端仍可優雅降級，但後台要看得到（原本完全靜默）
        await logErrorToDb(req, 'registration_counts_error', err, { severity: 'warn' });
        res.json({ counts: {}, total: 0, unavailable: true });
    }
});

// 公開設定（前端據此決定是否顯示註冊邀請碼欄位）
app.get('/api/public-config', (req, res) => {
    res.json({ requireRegistrationCode: !!process.env.REGISTRATION_CODE });
});

// 註冊普通用戶（註冊後直接登入）
app.post('/api/auth/register', async (req, res) => {
    const { username, password, registration_code } = req.body || {};
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!USERNAME_RE.test(String(username || ''))) {
        return res.status(400).json({ error: '帳號格式錯誤：請用 3~20 個英文字母、數字或底線' });
    }
    if (!PASSWORD_RE.test(String(password || ''))) {
        return res.status(400).json({ error: '密碼格式錯誤：請用 6~64 個英文字母或數字' });
    }
    if (process.env.REGISTRATION_CODE && String(registration_code || '') !== process.env.REGISTRATION_CODE) {
        return res.status(400).json({ error: '註冊邀請碼錯誤' });
    }
    if (!allowRegisterAttempt(clientIp)) {
        return res.status(429).json({ error: '註冊嘗試過於頻繁，請稍後再試（同一網路每小時最多 5 次）' });
    }

    try {
        const { data: existed, error: findErr } = await supabase
            .from('admin_users')
            .select('id')
            .eq('username', username)
            .maybeSingle();
        if (findErr) throw findErr;
        if (existed) return res.status(409).json({ error: '此帳號已被使用' });

        const { data, error } = await supabase
            .from('admin_users')
            .insert([{ username, password: hashPassword(password), role: 'user' }])
            .select();
        if (error) throw error;

        const user = data[0];
        const token = jwt.sign({ sub: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '12h' });

        await logAudit(user.username, 'REGISTER_USER', user.id, '註冊普通用戶帳號', req.userAgent);

        // v3.5.0：註冊完成直接以 cookie 登入（回應不含 token）
        setAuthCookie(res, token);
        res.json({ message: '註冊成功', user: { id: user.id, username: user.username, role: 'user' } });
    } catch (err) {
        if ((err && err.code) === '23514') {
            return res.status(503).json({ error: '資料庫尚未允許「普通用戶」角色，請先執行 migrations/2026-09-24-v2.9.0-users-registration-teams.sql' });
        }
        await logErrorToDb(req, 'register_user_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 目前登入者
/* 登出（v2.19.0）：前端本來只清掉本機權杖，所以稽核日誌裡「登出」永遠是空的。
   現在前端會先打這個端點留一筆紀錄再清權杖（失敗也不影響登出）。 */
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        // 注意：`authenticateToken` 只設定 `req.user`（權杖內容）；`req.currentUser` 是
        // requireAdmin／requireSuperAdmin 另外查資料庫才補上的，這條路由沒有那些中介層。
        await logAudit(req.user.username, 'LOGOUT', req.user.sub, {
            role: req.user.role
        }, req.userAgent);
        clearAuthCookie(res);   // v3.5.0：清掉 HttpOnly cookie（真正的登出）
        res.json({ success: true });
    } catch (err) {
        // 稽核寫不進去不該讓使用者登不掉：仍然清掉 cookie
        await logErrorToDb(req, 'logout_audit_error', err, { severity: 'warn' });
        clearAuthCookie(res);
        res.json({ success: true, audit_logged: false });
    }
});
app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({ user: { id: req.user.sub, username: req.user.username, role: req.user.role } });
});

// 我的報名（含賽事資訊）
app.get('/api/my/registrations', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('registrations')
            .select('*, competitions(id,name,date,time,location,category,is_team_event,is_deleted)')
            .eq('user_id', req.user.sub)
            .eq('is_deleted', false)
            .order('id', { ascending: false });
        if (error) throw error;

        const rows = (data || []).filter((r) => r.competitions && !r.competitions.is_deleted);

        // v2.20.0：附上狀態中文與「候補第幾位」（同一場賽事的候補一起排順位）
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const queues = {};
        if (reviewReady) {
            const compIds = Array.from(new Set(rows.map((r) => String(r.competition_id))));
            for (const cid of compIds) {
                const { data: all } = await supabase
                    .from('registrations')
                    .select(`id,user_id,status,created_at,is_deleted${orderReady ? ',waitlist_order' : ''}`)
                    .eq('competition_id', cid)
                    .eq('is_deleted', false);
                queues[cid] = CMCompetitionState.waitlistQueue(all || []).map((r) => String(r.id));
            }
        }

        res.json(rows.map((r) => {
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            const idx = (queues[String(r.competition_id)] || []).indexOf(String(r.id));
            return Object.assign({}, r, {
                status,
                status_label: CMCompetitionState.REG_STATUS_LABELS[status],
                waitlist_position: idx >= 0 ? idx + 1 : null,
                can_cancel: status !== 'rejected'
            });
        }));
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'my_registrations_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 報名參加比賽（任何已登入帳號，包含普通用戶）
app.post('/api/competitions/:id/register', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    const body = req.body || {};
    const operator = req.user;

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { counts } = await registrationSummary(competitionId);
        const state = competitionState(comp, new Date(), { registeredCount: counts.slots, waitlistCount: counts.waitlisted });
        if (!state.can_register) return res.status(400).json({ error: state.reason });

        const { data: existing, error: exErr } = await supabase
            .from('registrations')
            .select('id')
            .eq('competition_id', competitionId)
            .eq('user_id', operator.sub)
            .eq('is_deleted', false)
            .maybeSingle();
        if (exErr) throw exErr;
        if (existing) return res.status(409).json({ error: '你已經報名過此賽事了' });

        const teamName = cleanText(body.team_name, 40);
        if (comp.is_team_event && !teamName) {
            return res.status(400).json({ error: '此為組隊比賽，請填寫隊伍名稱' });
        }

        // v2.20.0：需審核 → 待審核；額滿且開放候補 → 候補；否則直接核准
        // （尚未執行 migration 時退回 v2.9.0 行為：一律直接核准，網站照常運作）
        const reviewReady = await registrationReviewSchemaReady();
        const decision = reviewReady
            ? CMCompetitionState.decideRegistration(comp, counts)
            : { status: 'confirmed', waitlist_position: null, reason: '' };
        if (!decision.status) return res.status(400).json({ error: decision.reason });

        const { data, error } = await supabase
            .from('registrations')
            .insert([{
                competition_id: comp.id,
                user_id: operator.sub,
                username: operator.username,
                team_name: teamName || null,
                note: cleanText(body.note, 200) || null,
                status: decision.status,
                is_deleted: false,
                created_at: new Date().toISOString()
            }])
            .select();
        if (error) throw error;

        const statusNote = decision.status === 'pending' ? '（待審核）'
            : decision.status === 'waitlisted' ? `（候補第 ${decision.waitlist_position} 位）` : '';
        await logAudit(operator.username, 'REGISTER_COMPETITION', comp.id,
            `報名賽事: ${comp.name}${teamName ? '（隊伍：' + teamName + '）' : ''}${statusNote}`, req.userAgent);

        const message = decision.status === 'pending' ? '已送出報名，等待主辦單位審核'
            : decision.status === 'waitlisted' ? `已排入候補（第 ${decision.waitlist_position} 位）`
                : '報名成功';

        res.json({
            message,
            status: decision.status,
            status_label: CMCompetitionState.REG_STATUS_LABELS[decision.status],
            waitlist_position: decision.waitlist_position,
            needs_approval: decision.status === 'pending',
            registration: data[0],
            registrations: counts.slots + (decision.status === 'waitlisted' ? 0 : 1)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        if ((err && err.code) === '23505') return res.status(409).json({ error: '你已經報名過此賽事了' });
        await logErrorToDb(req, 'register_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 審核一筆報名（管理員以上）：approve → 已核准；reject → 未錄取（附拒絕原因） */
app.post('/api/registrations/:id/review', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const action = String((req.body && req.body.action) || '').toLowerCase();
    const note = cleanText((req.body && req.body.note) || '', 200);

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以審核報名' });
    }
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action 只接受 approve（核准）或 reject（拒絕）' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到此報名紀錄' });

        const comp = await fetchCompetition(reg.competition_id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { counts } = await registrationSummary(reg.competition_id);
        const current = CMCompetitionState.normalizeRegStatus(reg.status);

        if (action === 'approve') {
            const max = parseInt(comp.max_registrations, 10) || 0;
            // 自己目前佔的名額要扣掉，否則「核准最後一個名額」會被誤判成名額已滿
            const others = counts.slots - (current === 'pending' || current === 'confirmed' ? 1 : 0);
            if (max > 0 && others >= max) {
                return res.status(400).json({ error: `名額已滿（${max} 人）：請先處理候補或拒絕其他報名，再核准這一筆` });
            }
        }

        const nextStatus = action === 'approve' ? 'confirmed' : 'rejected';
        const patchFields = {
            status: nextStatus,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: note || null
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', id);
        if (updErr) throw updErr;

        // 稽核動作一律寫字面值（tests/audit-actions.test.js 會擋「用變數拼出來的動作」，否則篩選會漏掉）
        if (action === 'approve') {
            await logAudit(req.user.username, 'REGISTER_APPROVED', comp.id,
                `核准報名: ${reg.username}（原狀態 ${CMCompetitionState.REG_STATUS_LABELS[current]}）${note ? '｜備註：' + note : ''}`,
                req.userAgent);
        } else {
            await logAudit(req.user.username, 'REGISTER_REJECTED', comp.id,
                `拒絕報名: ${reg.username}（原狀態 ${CMCompetitionState.REG_STATUS_LABELS[current]}）${note ? '｜備註：' + note : ''}`,
                req.userAgent);
        }

        const reviewPayload = {
            kind: 'review',
            title: action === 'approve' ? '報名已核准' : '報名結果通知',
            body: action === 'approve'
                ? `${comp.name}：你的報名已通過審核`
                : `${comp.name}：很抱歉，你的報名未錄取${note ? `（${note}）` : ''}`,
            url: '/?view=myregs',
            tag: `cm-reg-review-${reg.id}`
        };
        const push = await notifyUser(reg.user_id, reviewPayload, { kind: 'review' });
        await logPushEvent(comp.id, 'review_result', push.sent, {
            failed: push.failed, errors: push.errors, payload: reviewPayload, target_user_id: reg.user_id
        });

        res.json({
            message: action === 'approve' ? '已核准這筆報名' : '已拒絕這筆報名',
            registration: Object.assign({}, reg, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
            notified: push.sent
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'review_registration_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 手動遞補下一位候補（管理員以上）：自動遞補失效時（例如當下沒名額、後來才空出來）的補救手段 */
app.post('/api/competitions/:id/registrations/promote', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以遞補候補' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { rows, counts } = await registrationSummary(competitionId);
        const next = CMCompetitionState.nextWaitlist(rows);
        if (!next) return res.status(400).json({ error: '目前沒有候補名單' });

        // v2.21.0：名額守門改用共用純函式（與「指定遞補」同一份判斷，兩邊不可能走鐘）
        const plan = CMCompetitionState.planPromotion(comp, rows, next.id);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        const nextStatus = plan.status;
        const patchFields = {
            status: nextStatus,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: '候補遞補'
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', next.id);
        if (updErr) throw updErr;

        // v2.22.0：賽事可關閉「遞補就通知」（關掉時遞補照常成立，只是不推播，稽核寫明原因）
        const notify = notifyOnPromote(comp);
        await logAudit(req.user.username, 'PROMOTE_WAITLIST', comp.id,
            `手動遞補候補: ${next.username}（第 ${plan.position} 順位 → ${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}）${notify ? '' : '｜未通知（依賽事設定）'}`, req.userAgent);

        const promotePayload = {
            kind: 'promote',
            title: '候補遞補通知',
            body: `${comp.name}：你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}`,
            url: '/?view=myregs',
            tag: `cm-reg-promote-${next.id}`
        };
        const push = notify ? await notifyUser(next.user_id, promotePayload, { kind: 'promote' }) : { sent: 0 };
        if (notify) {
            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                failed: push.failed, errors: push.errors, payload: promotePayload, target_user_id: next.user_id
            });
        }

        res.json({
            message: notify ? `已遞補 ${next.username}` : `已遞補 ${next.username}（依賽事設定未通知）`,
            registration: Object.assign({}, next, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
            notified: push.sent,
            notify_disabled: !notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'promote_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});


/* v2.21.0：指定遞補（不照順位）——管理員可以挑候補名單裡的任何一位先遞補。
   為什麼要有：實務上候補第一名可能聯絡不到、或根本不是需要的組別，硬要「照順位」反而卡住。
   「名額已滿不能遞補」的判斷走共用純函式 planPromotion()，與「遞補下一位」同一份規則。 */
app.post('/api/registrations/:id/promote', authenticateToken, async (req, res) => {
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以遞補候補' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const { data: reg, error: findErr } = await supabase
            .from('registrations')
            .select('id,competition_id,user_id,username,status,is_deleted')
            .eq('id', req.params.id)
            .maybeSingle();
        if (findErr) throw findErr;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到這筆報名' });

        const comp = await fetchCompetition(reg.competition_id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { rows } = await registrationSummary(reg.competition_id);
        const plan = CMCompetitionState.planPromotion(comp, rows, reg.id);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        const patchFields = {
            status: plan.status,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: `指定遞補（原第 ${plan.position} 順位）`
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', reg.id);
        if (updErr) throw updErr;

        const notify = notifyOnPromote(comp);
        await logAudit(req.user.username, 'PROMOTE_WAITLIST', comp.id,
            `指定遞補候補: ${reg.username}（第 ${plan.position} 順位 → ${CMCompetitionState.REG_STATUS_LABELS[plan.status]}，未照順位）${notify ? '' : '｜未通知（依賽事設定）'}`,
            req.userAgent);

        const promotePayload = {
            kind: 'promote',
            title: '候補遞補通知',
            body: `${comp.name}：你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[plan.status]}`,
            url: '/?view=myregs',
            tag: `cm-reg-promote-${reg.id}`
        };
        const push = notify ? await notifyUser(reg.user_id, promotePayload, { kind: 'promote' }) : { sent: 0 };
        if (notify) {
            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                failed: push.failed, errors: push.errors, payload: promotePayload, target_user_id: reg.user_id
            });
        }

        res.json({
            message: notify
                ? `已遞補 ${reg.username}（原第 ${plan.position} 順位）`
                : `已遞補 ${reg.username}（原第 ${plan.position} 順位，依賽事設定未通知）`,
            registration: Object.assign({}, reg, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[plan.status],
            notified: push.sent,
            notify_disabled: !notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'promote_specific_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* v2.21.0：調整候補順位（管理員手動排序）。
   前端送「完整的 id 順序」；少一筆、多一筆或重複都會整批拒絕（planWaitlistOrder），
   避免有人剛好同時被遞補／取消時，寫出「少數人被默默擠到後面」的半套結果。 */
app.post('/api/competitions/:id/waitlist/reorder', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以調整候補順位' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });
        if (!(await waitlistOrderSchemaReady())) return res.status(503).json({ error: WAITLIST_ORDER_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
        if (!order || !order.length) return res.status(400).json({ error: '請提供完整的候補順序（order 陣列）' });

        const { rows } = await registrationSummary(competitionId);
        const plan = CMCompetitionState.planWaitlistOrder(rows, order);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        for (const update of plan.updates) {
            const { error } = await supabase.from('registrations').update({ waitlist_order: update.waitlist_order }).eq('id', update.id);
            if (error) throw error;
        }

        const label = (id) => (rows.find((r) => String(r.id) === String(id)) || {}).username || `#${id}`;
        const names = plan.updates.map((u, i) => `${i + 1}.${label(u.id)}`);
        const shown = names.length > 8 ? `${names.slice(0, 8).join('、')}…等 ${names.length} 人` : names.join('、');

        await logAudit(req.user.username, 'REORDER_WAITLIST', comp.id,
            `調整候補順位（${plan.updates.length} 人）: ${shown}`, req.userAgent);

        // 回傳更新後的候補名單（前端不必再查一次，也順便讓它看到後端算出來的順位）
        const { rows: after } = await registrationSummary(competitionId);
        const queue = CMCompetitionState.waitlistQueue(after);
        res.json({
            message: `已更新候補順位（${plan.updates.length} 人）`,
            waitlist: queue.map((r, i) => Object.assign({}, r, { waitlist_position: i + 1 }))
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'reorder_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 調整「遞補時要不要通知」（v2.22.0，管理員以上）
app.post('/api/competitions/:id/waitlist/notify', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以調整遞補通知設定' });
    }

    try {
        if (!(await waitlistNotifySchemaReady())) return res.status(503).json({ error: WAITLIST_NOTIFY_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        if (typeof (req.body && req.body.notify) !== 'boolean') {
            return res.status(400).json({ error: '請提供 notify（true＝遞補時通知，false＝不通知）' });
        }
        const notify = req.body.notify;
        const before = notifyOnPromote(comp);
        if (before === notify) {
            return res.json({ message: notify ? '遞補通知已是開啟' : '遞補通知已是關閉', notify });
        }

        const { error } = await supabase.from('competitions').update({ waitlist_notify: notify }).eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'WAITLIST_NOTIFY', comp.id,
            `遞補通知設定：${before ? '開啟' : '關閉'} → ${notify ? '開啟' : '關閉'}${notify ? '' : '（遞補仍會生效，只是不推播）'}`,
            req.userAgent);

        res.json({
            message: notify ? '已開啟：之後遞補候補會推播通知對方' : '已關閉：之後遞補候補不會推播通知（遞補仍然生效）',
            notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'update_waitlist_notify_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 候補相關的異動紀錄（v2.22.0，管理員以上）：從稽核日誌撈這場合適的紀錄，組成時間軸
app.get('/api/competitions/:id/waitlist/history', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以查看候補異動紀錄' });
    }

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        // 只認「跟候補有關」的動作：調整順位、手動遞補、自動遞補、審核、通知設定、取消報名
        const actions = ['REORDER_WAITLIST', 'PROMOTE_WAITLIST', 'AUTO_PROMOTE_WAITLIST', 'WAITLIST_NOTIFY',
            'REGISTER_APPROVED', 'REGISTER_REJECTED', 'CANCEL_REGISTRATION'];

        // v2.23.0：可以往回翻（offset）。一律從最新抓到「這一頁結尾 + 1」再自己切頁：
        // 正式站 PostgREST 會依 range 回傳、測試替身則回全部，這樣寫兩種環境行為一致
        // （與 /api/audit-logs 同一個理由）。抓超過上限就請管理員去稽核日誌頁篩選。
        const windowSize = Math.min(offset + limit + 1, WAITLIST_HISTORY_MAX_WINDOW);
        const { data, error } = await supabase
            .from('audit_logs')
            .select('*')
            .eq('target_id', comp.id)
            .in('action', actions)
            .order('created_at', { ascending: false })
            .range(0, windowSize - 1);
        if (error) throw error;

        const win = (data || []).slice(0, windowSize);
        const logs = win.slice(offset, offset + limit).map((l) => ({
            id: l.id,
            at: l.created_at,
            action: l.action,
            action_label: auditActionLabel(l.action),
            user: l.user_id,
            details: l.details || ''
        }));
        // 還有更早的嗎？抓滿整個窗口還多出下一筆才算有
        const more = win.length > offset + limit;
        const capped = windowSize >= WAITLIST_HISTORY_MAX_WINDOW && win.length >= windowSize;

        res.json({
            competition_id: comp.id,
            name: comp.name,
            returned: logs.length,
            limit,
            offset,
            has_more: more && !capped,
            capped,
            window_size: windowSize,
            actions: actions.map((a) => ({ value: a, label: auditActionLabel(a) })),
            logs
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'fetch_waitlist_history_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 取消報名（本人或管理員以上）
app.delete('/api/registrations/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到此報名紀錄' });

        const isOwner = String(reg.user_id) === String(req.user.sub) || reg.username === req.user.username;
        if (!isOwner && !ADMIN_ROLES.has(req.user.role)) {
            return res.status(403).json({ error: '權限不足：只能取消自己的報名' });
        }

        const { error: updErr } = await supabase
            .from('registrations')
            .update({ is_deleted: true, team_id: null })
            .eq('id', id);
        if (updErr) throw updErr;

        await logAudit(req.user.username, 'CANCEL_REGISTRATION', reg.competition_id,
            `取消報名: ${reg.username}（${isOwner ? '本人' : '管理員代為取消'}）`, req.userAgent);

        // v2.20.0：讓出名額時自動遞補第一位候補（僅限「原本佔名額」的報名，且此賽事開放候補）
        let promoted = null;
        try {
            const reviewReady = await registrationReviewSchemaReady();
            const cancelledStatus = CMCompetitionState.normalizeRegStatus(reg.status);
            if (reviewReady && cancelledStatus !== 'waitlisted' && cancelledStatus !== 'rejected') {
                const comp = await fetchCompetition(reg.competition_id);
                if (comp && CMCompetitionState.reviewFlags(comp).waitlistEnabled) {
                    const { rows, counts } = await registrationSummary(reg.competition_id);
                    const next = CMCompetitionState.nextWaitlist(rows, reg.id);
                    const max = parseInt(comp.max_registrations, 10) || 0;
                    if (next && (max === 0 || counts.slots < max)) {
                        const nextStatus = CMCompetitionState.promotionStatus(comp);
                        const patchFields = {
                            status: nextStatus,
                            reviewed_at: new Date().toISOString(),
                            reviewed_by: req.user.username,
                            review_note: '候補自動遞補'
                        };
                        const { error: pErr } = await supabase.from('registrations').update(patchFields).eq('id', next.id);
                        if (pErr) throw pErr;

                        // v2.22.0：自動遞補也遵守賽事的「遞補通知」設定
                        const autoNotify = notifyOnPromote(comp);
                        await logAudit(req.user.username, 'AUTO_PROMOTE_WAITLIST', reg.competition_id,
                            `自動遞補候補: ${next.username}（第 1 順位 → ${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}，因 ${reg.username} 取消報名）${autoNotify ? '' : '｜未通知（依賽事設定）'}`,
                            req.userAgent);

                        const autoPayload = {
                            kind: 'promote',
                            title: '候補遞補通知',
                            body: `${comp.name}：有人取消報名，你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}`,
                            url: '/?view=myregs',
                            tag: `cm-reg-promote-${next.id}`
                        };
                        const push = autoNotify ? await notifyUser(next.user_id, autoPayload, { kind: 'promote' }) : { sent: 0 };
                        if (autoNotify) {
                            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                                failed: push.failed, errors: push.errors, payload: autoPayload, target_user_id: next.user_id
                            });
                        }

                        promoted = {
                            id: next.id,
                            username: next.username,
                            status: nextStatus,
                            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
                            notified: push.sent,
                            notify_disabled: !autoNotify
                        };
                    }
                }
            }
        } catch (promoteErr) {
            // 遞補失敗不可以讓「取消報名」跟著失敗（取消已經生效了）
            await logErrorToDb(req, 'auto_promote_waitlist_error', promoteErr);
        }

        res.json({ message: '已取消報名', promoted });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'cancel_registration_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 報名名單：管理員以上看全部（含隊伍），一般用戶只看自己的
app.get('/api/competitions/:id/registrations', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    try {
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const isAdmin = ADMIN_ROLES.has(req.user.role);
        const baseCols = 'id,competition_id,user_id,username,team_id,team_name,note,status,created_at';

        // v3.0.0：分頁（opt-in，沒帶 limit 就維持原本行為）。
        // 有 ?status= 時，狀態是「正規化之後」才比對（舊資料可能不合標準值），資料庫層無法可靠過濾，
        // 所以那種情況改用記憶體切片，並用 page.paged_by 標示（讓呼叫端知道差別）。
        const paging = CMPaging.parsePaging(req.query, { max: REGISTRATIONS_PAGE_MAX });
        const wantedStatus = String(req.query.status || '').split(',').map((s) => s.trim()).filter(Boolean);
        const pageInDb = paging.paged && isAdmin && wantedStatus.length === 0;

        let regQuery = supabase
            .from('registrations')
            .select(reviewReady ? `${baseCols},reviewed_at,reviewed_by,review_note${orderReady ? ',waitlist_order' : ''}` : baseCols)
            .eq('competition_id', competitionId)
            .eq('is_deleted', false)
            .order('id', { ascending: true });
        if (pageInDb) regQuery = regQuery.range(paging.offset, paging.offset + paging.limit - 1);

        const { data, error } = await regQuery;
        if (error) throw error;

        const withLabels = (list) => list.map((r) => Object.assign({}, r, {
            status: CMCompetitionState.normalizeRegStatus(r.status),
            status_label: CMCompetitionState.REG_STATUS_LABELS[CMCompetitionState.normalizeRegStatus(r.status)]
        }));

        let rows = data || [];
        if (!isAdmin) rows = rows.filter((r) => String(r.user_id) === String(req.user.sub));
        rows = withLabels(rows);

        // 候補順位與各狀態統計都需要「整場名單」。分頁時另外用輕量查詢取回
        // （只選計算需要的欄位，不把整份名單的內容撈回來）。
        let roster = rows;
        let queueIds = null;
        if (paging.paged && isAdmin) {
            const { data: rosterRows } = await supabase
                .from('registrations')
                .select(orderReady ? 'id,created_at,status,waitlist_order' : 'id,created_at,status')
                .eq('competition_id', competitionId)
                .eq('is_deleted', false)
                .order('id', { ascending: true });
            roster = withLabels(rosterRows || []);
        }

        // 候補順位（先報名先排；只有管理員需要看到整份名單的順位）
        if (isAdmin) {
            const queue = CMCompetitionState.waitlistQueue(roster);
            queueIds = queue.map((r) => r.id);
            const position = {};
            queue.forEach((r, i) => { position[String(r.id)] = i + 1; });
            rows = rows.map((r) => Object.assign({}, r, {
                waitlist_position: position[String(r.id)] || null
            }));
        }

        const counts = CMCompetitionState.countByStatus(roster);

        if (!paging.paged) {
            const result = wantedStatus.length ? rows.filter((r) => wantedStatus.includes(r.status)) : rows;
            return res.json({
                registrations: result,
                total: result.length,
                counts,
                waitlist_queue: isAdmin ? queueIds : undefined,
                schema_ready: reviewReady
            });
        }

        // 分頁：total 是「符合篩選條件的全部筆數」，registrations 只回這一頁
        const fullList = wantedStatus.length ? roster.filter((r) => wantedStatus.includes(r.status)) : roster;
        const sliced = pageInDb ? rows : CMPaging.pageSlice(fullList, paging);
        res.json({
            registrations: sliced,
            total: fullList.length,
            counts,
            waitlist_queue: isAdmin ? queueIds : undefined,
            schema_ready: reviewReady,
            page: CMPaging.pagedResponse(sliced, {
                limit: paging.limit, offset: paging.offset, total: fullList.length,
                pagedBy: pageInDb ? 'db' : 'memory'
            })
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'list_registrations_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 隊伍一覽（登入即可檢視，方便參賽者確認自己的隊伍）
};
