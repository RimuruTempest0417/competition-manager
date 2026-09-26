/* 場地與工作人員（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/venue-staff')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMStaff = require('../public/js/staff');                    // v2.27.0：工作人員角色規則的唯一真實來源

module.exports = function registerVenueStaffRoutes(app, ctx) {
    const { AUDIT_SEARCH_WINDOW, GENERIC_DB_ERROR, VENUE_STAFF_HINT, isMissingTableError, loadCompetitionStaff, logAudit, logErrorToDb, requireAdmin, staffSchemaReady, supabase } = ctx;
app.get('/api/competitions/:id/staff', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '賽事編號不對' });

        if (!(await staffSchemaReady())) {
            return res.json({
                success: true, staff: [], summary: CMStaff.staffSummary([]),
                roles: CMStaff.STAFF_ROLES, schema_ready: false, hint: VENUE_STAFF_HINT
            });
        }

        const staff = await loadCompetitionStaff(id);
        res.json({
            success: true, staff, summary: CMStaff.staffSummary(staff),
            roles: CMStaff.STAFF_ROLES, schema_ready: true
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'get_competition_staff_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 指派／調整工作人員（管理員以上）。同一場同一人只有一個角色：已存在就改角色。
app.post('/api/competitions/:id/staff', requireAdmin, async (req, res) => {
    try {
        if (!(await staffSchemaReady())) return res.status(503).json({ error: VENUE_STAFF_HINT });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '賽事編號不對' });

        const parsed = CMStaff.normalizeStaffInput(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        // 沒帶 note 欄位＝不要動既有備註；帶了就照帶的值（含清空）
        const noteProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'note');

        const { data: comp, error: compError } = await supabase
            .from('competitions').select('id,name').eq('id', id).maybeSingle();
        if (compError) throw compError;
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const { data: user, error: userError } = await supabase
            .from('admin_users').select('id,username,is_active').eq('id', parsed.value.user_id).maybeSingle();
        if (userError) throw userError;
        if (!user) return res.status(404).json({ error: '找不到這個帳號' });
        if (user.is_active === false) {
            return res.status(400).json({ error: `${user.username} 是停用中的帳號，不能指派為工作人員` });
        }

        const { data: existing, error: existError } = await supabase
            .from('competition_staff')
            .select('id,role,note')
            .eq('competition_id', id)
            .eq('user_id', parsed.value.user_id)
            .maybeSingle();
        if (existError) throw existError;

        const roleLabel = CMStaff.roleLabel(parsed.value.role);
        const noteText = (noteProvided ? parsed.value.note : (existing && existing.note)) || '';
        let changed = 'created';

        if (existing) {
            changed = 'updated';
            const beforeLabel = CMStaff.roleLabel(existing.role);
            const { error } = await supabase.from('competition_staff').update({
                role: parsed.value.role,
                note: noteProvided ? parsed.value.note : existing.note,
                assigned_by: req.user.username,
                updated_at: new Date().toISOString()
            }).eq('id', existing.id);
            if (error) throw error;
            await logAudit(req.user.username, 'ASSIGN_STAFF', id,
                beforeLabel === roleLabel
                    ? `更新工作人員 ${user.username}（${roleLabel}）${noteText ? `，備註：${noteText}` : ''}｜賽事：${comp.name}`
                    : `調整工作人員 ${user.username} 的角色：${beforeLabel} → ${roleLabel}｜賽事：${comp.name}`,
                req.userAgent);
        } else {
            const { error } = await supabase.from('competition_staff').insert([{
                competition_id: id,
                user_id: parsed.value.user_id,
                role: parsed.value.role,
                note: parsed.value.note,
                assigned_by: req.user.username,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
            if (error) throw error;
            await logAudit(req.user.username, 'ASSIGN_STAFF', id,
                `指派工作人員：${user.username} 為「${roleLabel}」${noteText ? `（${noteText}）` : ''}｜賽事：${comp.name}`,
                req.userAgent);
        }

        const staff = await loadCompetitionStaff(id);
        res.json({
            success: true, changed, staff,
            summary: CMStaff.staffSummary(staff), roles: CMStaff.STAFF_ROLES,
            assigned: { user_id: parsed.value.user_id, username: user.username, role: parsed.value.role, role_label: roleLabel }
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'assign_competition_staff_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 移除工作人員（管理員以上）
app.delete('/api/staff/:id', requireAdmin, async (req, res) => {
    try {
        if (!(await staffSchemaReady())) return res.status(503).json({ error: VENUE_STAFF_HINT });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '工作人員指派編號不對' });

        const { data: row, error } = await supabase
            .from('competition_staff').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ error: '找不到這筆工作人員指派' });

        // 稽核要寫「誰被移除」，所以先問一次帳號名稱（問不到就用編號）
        const { data: user } = await supabase
            .from('admin_users').select('username').eq('id', row.user_id).maybeSingle();
        const who = (user && user.username) || `帳號 #${row.user_id}`;

        const { error: delError } = await supabase.from('competition_staff').delete().eq('id', id);
        if (delError) throw delError;

        await logAudit(req.user.username, 'REMOVE_STAFF', row.competition_id,
            `移除工作人員：${who}（${CMStaff.roleLabel(row.role)}）`, req.userAgent);

        const staff = await loadCompetitionStaff(row.competition_id);
        res.json({ success: true, removed: { id, user_id: row.user_id, username: who }, staff, summary: CMStaff.staffSummary(staff), roles: CMStaff.STAFF_ROLES });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'remove_competition_staff_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 審計日誌 API
// ==========================================
// ==========================================
// 稽核日誌（v2.16.0：篩選、分頁、CSV 匯出、保留天數清理）
// ------------------------------------------
// 為什麼要強化：稽核紀錄一直有在寫，但以前只能看最近 100 筆、不能篩選也不能匯出，
// 出事後要追「某個人某段時間做了什麼」幾乎不可能。
//
// 設計取捨：
//   - 時間區間用 `gt.created_at` / `lt.created_at`（字串比較對 ISO 時間正確），
//     這樣假 Supabase 也能完整測到，不必依賴 gte/lte。
//   - 關鍵字搜尋（q）在伺服器端以「最近 AUDIT_SEARCH_WINDOW 筆」為範圍做 JS 篩選：
//     PostgREST 的 or() 在測試替身不支援，且稽核量不大，用固定視窗確定性最好（畫面上會標示範圍）。
//   - 總數用 count: 'exact'（正式站拿得到）；拿不到時退回「至少 N 筆、可能還有更多」的誠實說法。
// ==========================================
};
