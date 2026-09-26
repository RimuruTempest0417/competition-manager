/* 公告中心與推播紀錄（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/announcements')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMAnnouncements = require('../public/js/announcements');   // v2.26.0：公告可見性的唯一真實來源

module.exports = function registerAnnouncementsRoutes(app, ctx) {
    const { ANNOUNCEMENTS_HINT, ANNOUNCEMENT_LIST_MAX, CATEGORY_IDS, COMPETITION_CATEGORIES, GENERIC_DB_ERROR, PUSH_HINT, PUSH_LOG_DETAIL_HINT, announceCategoriesReady, announcementsSchemaReady, authenticateToken, categoryChips, countActiveUsers, isAdminRoleName, isMissingColumnError, isMissingTableError, logAudit, logErrorToDb, myAnnounceCategories, myAnnouncementReadIds, pushAnnouncement, pushLogDetailSchemaReady, requireAdmin, sendPushTo, supabase } = ctx;
app.get('/api/my/announcements', authenticateToken, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) {
            return res.json({
                success: true, announcements: [], unread_count: 0, my_categories: [],
                all_categories: COMPETITION_CATEGORIES, schema_ready: false, hint: ANNOUNCEMENTS_HINT
            });
        }
        const myCategories = await myAnnounceCategories(req.user.sub);
        const { data, error } = await supabase
            .from('announcements')
            .select('id,title,body,audience,categories,is_pinned,is_active,publish_at,expires_at,created_at,created_by')
            .eq('is_active', true)
            .order('publish_at', { ascending: false })
            .limit(ANNOUNCEMENT_LIST_MAX);
        if (error) throw error;

        const viewer = { isAdmin: isAdminRoleName(req.user.role), categories: myCategories };
        const visible = CMAnnouncements.sortForDisplay(
            CMAnnouncements.visibleFor(data || [], viewer, Date.now())
        );
        const reads = await myAnnouncementReadIds(req.user.sub);
        const items = visible.map((a) => Object.assign({}, a, {
            read: reads.has(String(a.id)),
            audience_label: CMAnnouncements.audienceLabel(a.audience)
        }));

        res.json({
            success: true,
            announcements: items,
            unread_count: CMAnnouncements.unreadCount(items, reads),
            my_categories: myCategories,
            all_categories: COMPETITION_CATEGORIES,
            schema_ready: true
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_announcements_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 標記已讀／全部已讀（冪等：重複標記不會長出重複列） */
app.post('/api/my/announcements/read-all', authenticateToken, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        if (!ids.length) return res.status(400).json({ error: '沒有要標記的公告' });
        if (ids.length > ANNOUNCEMENT_LIST_MAX) return res.status(400).json({ error: `一次最多標記 ${ANNOUNCEMENT_LIST_MAX} 則` });

        const now = new Date().toISOString();
        const rows = ids.map((announcementId) => ({ announcement_id: announcementId, user_id: req.user.sub, read_at: now }));
        const { error } = await supabase
            .from('announcement_reads')
            .upsert(rows, { onConflict: 'announcement_id,user_id' });
        if (error) throw error;
        res.json({ success: true, marked: ids.length });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'mark_announcements_read_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 我訂閱的公告分類（audience = 'category' 的公告靠這個比對） */
app.post('/api/my/announce-categories', authenticateToken, async (req, res) => {
    try {
        if (!(await announceCategoriesReady())) {
            return res.status(503).json({ error: '公告分類訂閱需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-announcements.sql' });
        }
        const raw = (req.body && req.body.categories) || [];
        if (!Array.isArray(raw)) return res.status(400).json({ error: 'categories 必須是陣列' });
        const categories = Array.from(new Set(raw.map(String).filter((c) => CATEGORY_IDS.has(c))));
        const { error } = await supabase.from('admin_users').update({ announce_categories: categories }).eq('id', req.user.sub);
        if (error) throw error;
        res.json({
            success: true, categories,
            message: categories.length
                ? `已訂閱 ${categoryChips(categories)} 的公告`
                : '已取消所有公告分類訂閱'
        });
    } catch (err) {
        if (isMissingColumnError(err, ['announce_categories'])) {
            return res.status(503).json({ error: '公告分類訂閱需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-announcements.sql' });
        }
        await logErrorToDb(req, 'save_announce_categories_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：列出全部公告（含未上架與已過期）＋每則的已讀人數 */
app.get('/api/admin/announcements', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) {
            return res.json({ success: true, announcements: [], schema_ready: false, hint: ANNOUNCEMENTS_HINT });
        }
        const { data, error } = await supabase
            .from('announcements')
            .select('*')
            .order('publish_at', { ascending: false })
            .limit(ANNOUNCEMENT_LIST_MAX);
        if (error) throw error;

        let readCounts = new Map();
        try {
            const { data: reads, error: readErr } = await supabase.from('announcement_reads').select('announcement_id');
            if (readErr) throw readErr;
            (reads || []).forEach((r) => {
                const key = String(r.announcement_id);
                readCounts.set(key, (readCounts.get(key) || 0) + 1);
            });
        } catch (readErr) {
            if (!isMissingTableError(readErr)) throw readErr;
            readCounts = new Map();
        }

        const totalUsers = await countActiveUsers().catch(() => null);
        const items = (data || []).map((a) => Object.assign({}, a, {
            audience_label: CMAnnouncements.audienceLabel(a.audience),
            read_count: readCounts.get(String(a.id)) || 0,
            is_live: CMAnnouncements.isLive(a, Date.now())
        }));
        res.json({ success: true, announcements: items, total_users: totalUsers, schema_ready: true });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'fetch_admin_announcements_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：發布公告（可同時推播） */
app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const normalized = CMAnnouncements.normalizeInput(req.body, COMPETITION_CATEGORIES.map((c) => c.id));
        if (normalized.error) return res.status(400).json({ error: normalized.error });

        const now = new Date().toISOString();
        const row = Object.assign({}, normalized.value, {
            created_by: req.currentUser.username,
            created_at: now,
            updated_at: now
        });
        const { data, error } = await supabase.from('announcements').insert([row]).select();
        if (error) throw error;
        const created = (data && data[0]) || row;

        let push = { sent: 0, skipped: '沒有勾選「同時發送推播」' };
        if (normalized.value.notify_push) {
            try {
                push = await pushAnnouncement(created);
            } catch (pushErr) {
                push = { sent: 0, error: pushErr.message };
                await logErrorToDb(req, 'announcement_push_error', pushErr);
            }
        }

        const audienceText = CMAnnouncements.audienceLabel(normalized.value.audience)
            + (normalized.value.categories.length ? `：${categoryChips(normalized.value.categories)}` : '');
        await logAudit(req.currentUser.username, 'CREATE_ANNOUNCEMENT', created.id || null,
            `發布公告「${normalized.value.title}」（對象 ${audienceText}）${normalized.value.notify_push ? `，推播成功 ${push.sent} 則` : ''}`,
            req.userAgent);

        res.json({ success: true, announcement: created, push });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'create_announcement_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：修改公告（只覆蓋有帶的欄位；下架用 is_active:false，資料留著） */
app.patch('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '公告編號不對' });

        const { data: existing, error } = await supabase.from('announcements').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!existing) return res.status(404).json({ error: '找不到這則公告' });

        // 用「現有值＋這次帶的欄位」再跑一次同一份驗證，避免改一半變成壞資料
        const merged = Object.assign({}, existing, req.body || {});
        const normalized = CMAnnouncements.normalizeInput(merged, COMPETITION_CATEGORIES.map((c) => c.id));
        if (normalized.error) return res.status(400).json({ error: normalized.error });

        const patch = Object.assign({}, normalized.value, { updated_at: new Date().toISOString() });
        const changes = [];
        const fieldLabels = {
            title: '標題', body: '內容', audience: '對象', categories: '分類',
            is_pinned: '置頂', is_active: '上架', notify_push: '發布時推播',
            publish_at: '發布時間', expires_at: '結束時間'
        };
        Object.keys(fieldLabels).forEach((field) => {
            const before = existing[field];
            const after = patch[field];
            const same = Array.isArray(before) || Array.isArray(after)
                ? JSON.stringify(before || []) === JSON.stringify(after || [])
                : String(before === undefined ? '' : before) === String(after === undefined ? '' : after);
            if (same) return;
            if (field === 'audience') {
                changes.push(`${fieldLabels[field]}：${CMAnnouncements.audienceLabel(before)} → ${CMAnnouncements.audienceLabel(after)}`);
            } else if (field === 'categories') {
                changes.push(`${fieldLabels[field]}：${categoryChips(before) || '（無）'} → ${categoryChips(after) || '（無）'}`);
            } else if (field === 'is_pinned' || field === 'is_active' || field === 'notify_push') {
                changes.push(`${fieldLabels[field]}：${before ? '是' : '否'} → ${after ? '是' : '否'}`);
            } else if (field === 'body') {
                changes.push('內容已更新');
            } else {
                changes.push(`${fieldLabels[field]}：${before === null || before === undefined ? '（無）' : before} → ${after === null || after === undefined ? '（無）' : after}`);
            }
        });

        const { error: updErr } = await supabase.from('announcements').update(patch).eq('id', id);
        if (updErr) throw updErr;

        await logAudit(req.currentUser.username, 'UPDATE_ANNOUNCEMENT', id,
            changes.length ? `修改公告「${patch.title}」：${changes.join('；')}` : `修改公告「${patch.title}」（內容沒有變動）`,
            req.userAgent);

        res.json({ success: true, announcement: Object.assign({}, existing, patch), changes });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'update_announcement_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// v2.26.0：重送某一筆推播（管理員以上）
// 語意：把「當時送出去的內容」再送一次給同一批對象（單一使用者的通知只送給那個人）。
// 這是**手動**動作，因此不受「自動通知開關」影響（開關管的是系統自動發的那些）；
// 但每一筆重送都會留稽核，失敗原因也會回報。
app.post('/api/admin/push-logs/:id/resend', requireAdmin, async (req, res) => {
    try {
        if (!(await pushLogDetailSchemaReady())) return res.status(503).json({ error: PUSH_LOG_DETAIL_HINT });
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '推播紀錄編號不對' });

        const { data: row, error } = await supabase.from('push_log').select('*').eq('id', id).maybeSingle();
        if (error) {
            if (isMissingTableError(error)) return res.status(503).json({ error: PUSH_HINT });
            throw error;
        }
        if (!row) return res.status(404).json({ error: '找不到這筆推播紀錄' });
        if (!row.payload || !row.payload.title) {
            return res.status(400).json({ error: '這筆紀錄沒有可重送的內容（v2.26.0 之前的紀錄只記了筆數）' });
        }

        // 找要送的訂閱：有指定使用者就只送給他，否則送給所有有效訂閱
        const { data: allSubs, error: subErr } = await supabase
            .from('push_subscriptions')
            .select('id,user_id,endpoint,p256dh,auth,is_active')
            .eq('is_active', true);
        if (subErr) throw subErr;
        // 重送的對象：單一使用者 → 只給他；一組使用者（例如公告）→ 只給那組；都沒有 → 所有有效訂閱
        const targetIds = (Array.isArray(row.target_user_ids) && row.target_user_ids.length)
            ? new Set(row.target_user_ids.map(String))
            : ((row.target_user_id === null || row.target_user_id === undefined)
                ? null
                : new Set([String(row.target_user_id)]));
        const subs = (allSubs || []).filter((s) => !targetIds || targetIds.has(String(s.user_id)));

        let sent = 0;
        let failed = 0;
        let deactivated = 0;
        const errors = [];
        for (const sub of subs) {
            const result = await sendPushTo(sub, row.payload);
            if (result.ok) sent += 1;
            else if (result.gone) {
                deactivated += 1;
                await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', sub.id);
            } else {
                failed += 1;
                if (result.error) errors.push(result.error);
            }
        }

        const resendCount = Number(row.resend_count || 0) + 1;
        const { error: updError } = await supabase.from('push_log').update({
            resend_count: resendCount,
            resend_at: new Date().toISOString(),
            resend_sent_count: sent
        }).eq('id', id);
        if (updError) throw updError;

        const scopeText = targetIds
            ? (targetIds.size === 1 && row.target_user_id ? `限使用者 #${row.target_user_id}` : `限 ${targetIds.size} 位使用者`)
            : '所有有效訂閱';
        await logAudit(req.user.username, 'RESEND_PUSH', row.competition_id || null,
            `重送推播紀錄 #${id}（${row.kind}，${scopeText}）：成功 ${sent}、失敗 ${failed}${deactivated ? `、失效訂閱 ${deactivated}` : ''}`,
            req.userAgent);

        res.json({
            success: true,
            sent, failed, deactivated,
            total: subs.length,
            resend_count: resendCount,
            errors: Array.from(new Set(errors)).slice(0, 5)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'resend_push_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// v2.27.0：場地地圖連結＋工作人員指派（Roadmap P1-5）
// ==========================================
//
// ① 地圖連結：賽事多一個 map_url。**沒填不擋**——前端用地址自動產生 Google 地圖搜尋連結
//    （規則唯一真實來源 public/js/venue.js），所以舊資料不用補、也不會出現「有地點卻沒有地圖」。
// ② 工作人員：哪個帳號在這場賽事擔任裁判／記錄／攝影（同一場同一人一個角色，
//    改角色＝更新同一列）。角色與驗證規則走 public/js/staff.js。
// 未執行 migration 時：地圖改用地址自動產生（功能照常）、工作人員清單回 schema_ready:false＋檔名、
// 指派／移除回 503，其他功能完全不受影響。
//
// 隱私界線：GET 是公開端點（賽事工作人員本來就是公開資訊），但只回帳號名稱與角色；
// 不帶 email、不帶權限、不帶任何 token。寫入一律 requireAdmin 並留稽核。
};
