/* 營運儀表板與前端設定（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/stats')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMCompetitionState = require('../public/js/competition-state');
const CMPaging = require('../public/js/paging');                  // v3.0.0：分頁規則的唯一真實來源（前後端共用）
const CMStats = require('../public/js/stats');                    // v3.0.0：營運統計與圖表幾何的唯一真實來源
const path = require('path');

module.exports = function registerStatsRoutes(app, ctx) {
    const { COMPETITIONS_PAGE_MAX, COMPETITION_CATEGORIES, MAX_TAGS, MAX_TAG_LENGTH, OPS_INDEXES, OPS_STATS_MAX_TREND_DAYS, OPS_STATS_TREND_DAYS, OPS_STATS_TTL_MS, REGISTRATIONS_PAGE_MAX, columnExists, competitionState, isMissingTableError, registrationReviewSchemaReady, requireAdmin, serverState, supabase, tableExists } = ctx;
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const days = CMPaging.clampInt(req.query.days, 7, OPS_STATS_MAX_TREND_DAYS, OPS_STATS_TREND_DAYS);
    const fresh = String(req.query.fresh || '') === '1';
    const now = Date.now();

    if (!fresh && serverState.opsStatsCache.payload && serverState.opsStatsCache.days === days && (now - serverState.opsStatsCache.at) < OPS_STATS_TTL_MS) {
        return res.json(Object.assign({}, serverState.opsStatsCache.payload, { cached: true, cache_age_ms: now - serverState.opsStatsCache.at }));
    }

    const timings = {};
    const unavailable = [];
    // 小工具：量測每個區塊的耗時，並把失敗原因記下來（不讓單一區塊炸掉整個回應）
    const block = async (name, fn) => {
        const t0 = Date.now();
        try {
            return await fn();
        } catch (err) {
            unavailable.push({ section: name, reason: isMissingTableError(err) ? '資料表尚未建立（migration 未執行）' : (err.message || '查詢失敗') });
            return null;
        } finally {
            timings[name] = Date.now() - t0;
        }
    };

    const hasSeverity = await columnExists('error_logs', 'severity');
    const hasResolved = await columnExists('error_logs', 'resolved');
    const hasLastLogin = await columnExists('admin_users', 'last_login_at');
    const hasPosterThumb = await columnExists('competition_posters', 'thumb_bytes');
    const hasStaff = await tableExists('competition_staff');
    // 選用資料表不存在（migration 還沒跑）時明確列出來，
    // 讓儀表板能說明「哪個區塊沒有、為什麼」，而不是靜靜少一個數字。
    if (!hasStaff) {
        unavailable.push({ section: 'competition_staff', reason: '資料表尚未建立（migration 未執行）' });
    }
    const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ── 賽事 ──
    const comps = await block('competitions', async () => {
        const { data, error } = await supabase.from('competitions')
            .select('*')   // 賽事數量少但要推導狀態，直接取全部欄位（欄位缺失時不會讓整個查詢 400）
            .or('is_deleted.is.null,is_deleted.eq.false');
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 報名（狀態與趨勢）──
    const reviewReady = await registrationReviewSchemaReady();
    const regs = await block('registrations', async () => {
        const { data, error } = await supabase.from('registrations')
            .select(reviewReady ? 'competition_id,user_id,status,created_at' : 'competition_id,user_id,created_at')
            .eq('is_deleted', false);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 使用者（只有角色與時間，不含帳號以外的個資）──
    const users = await block('users', async () => {
        const cols = ['role', 'is_active', 'created_at'];
        if (hasLastLogin) cols.push('last_login_at');
        const { data, error } = await supabase.from('admin_users').select(cols.join(','));
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 錯誤日誌（近 30 天，趨勢與類別）──
    const errorRows = await block('errors', async () => {
        const cols = ['error_type', 'created_at', 'path'];
        if (hasSeverity) cols.push('severity');
        if (hasResolved) cols.push('resolved');
        let q = supabase.from('error_logs').select(cols.join(',')).gt('created_at', since30);
        if (hasResolved) q = q.eq('resolved', false);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(2000);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 推播紀錄 ──
    const pushRows = await block('push', async () => {
        // 這張表的時間欄位是 sent_at（沒有 created_at），而統計只需要計數欄位。
        const { data, error } = await supabase.from('push_log')
            .select('sent_count,failed_count')
            .order('sent_at', { ascending: false }).limit(1000);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 海報與縮圖（縮圖省下多少流量＝最直接的效能數字）──
    const posterCols = hasPosterThumb ? 'bytes,thumb_bytes' : 'bytes';
    const posters = await block('posters', async () => {
        const { data, error } = await supabase.from('competition_posters').select(posterCols);
        if (error) throw error;
        return data || [];
    }) || [];

    const staffCount = hasStaff ? (await block('staff', async () => {
        const { data, error } = await supabase.from('competition_staff').select('id');
        if (error) throw error;
        return data || [];
    })) : null;

    // ── 聚合：賽事 ──
    const regCounts = {};
    const waitlistCounts = {};
    regs.forEach((r) => {
        const key = String(r.competition_id);
        const status = CMCompetitionState.normalizeRegStatus(r.status);
        if (status === 'waitlisted') { waitlistCounts[key] = (waitlistCounts[key] || 0) + 1; return; }
        regCounts[key] = (regCounts[key] || 0) + 1;
    });

    const stateNow = new Date(now);
    const stateCounts = {};
    comps.forEach((c) => {
        const st = competitionState(c, stateNow, {
            registeredCount: regCounts[String(c.id)] || 0,
            waitlistCount: waitlistCounts[String(c.id)] || 0
        });
        stateCounts[st.state] = (stateCounts[st.state] || 0) + 1;
    });

    const categoryTop = CMStats.topN(CMStats.countBy(comps, (c) => c.category || 'other'), 6).map((row) => {
        const def = COMPETITION_CATEGORIES.find((x) => x.id === row.key);
        return { key: row.key, label: (def && (def.label || def.name)) || row.key, count: row.count };
    });

    // ── 聚合：報名 ──
    const regByStatus = CMStats.countBy(regs, (r) => CMCompetitionState.normalizeRegStatus(r.status));
    const regTrend = CMStats.trendByDay(regs, { days, now: stateNow });

    // ── 聚合：使用者 ──
    const activeUsers = users.filter((u) => u.is_active !== false);
    const activeLast30 = hasLastLogin
        ? activeUsers.filter((u) => u.last_login_at && new Date(u.last_login_at).getTime() >= now - 30 * 24 * 60 * 60 * 1000).length
        : null;

    // ── 聚合：錯誤 ──
    const errorTrend = CMStats.trendByDay(errorRows, { days, now: stateNow });
    const errorBySeverity = CMStats.countBy(errorRows, (r) => (hasSeverity ? (r.severity || 'error') : 'error'));
    const errorTopTypes = CMStats.topN(CMStats.countBy(errorRows, (r) => r.error_type || 'unknown'), 5);

    // ── 聚合：推播 ──
    const sent = CMStats.sum(pushRows, (r) => r.sent_count);
    const failed = CMStats.sum(pushRows, (r) => r.failed_count);
    const pushTotal = sent + failed;

    // ── 聚合：海報縮圖省下的量 ──
    const posterBytes = CMStats.sum(posters, (r) => r.bytes);
    const thumbBytes = CMStats.sum(posters, (r) => (hasPosterThumb ? r.thumb_bytes : 0));
    const thumbCount = posters.filter((r) => hasPosterThumb && CMStats.sum([r], (x) => x.thumb_bytes) > 0).length;

    const payload = {
        success: true,
        generated_at: new Date(now).toISOString(),
        cached: false,
        trend_days: days,
        unavailable_sections: unavailable,
        competitions: {
            total: comps.length,
            by_state: stateCounts,
            by_category: categoryTop,
            by_category_other: Math.max(0, comps.length - CMStats.sum(categoryTop, (c) => c.count)),
            created_trend: CMStats.trendByDay(comps, { days, now: stateNow })
        },
        registrations: {
            total: regs.length,
            by_status: regByStatus,
            confirmed: regByStatus.confirmed || 0,
            pending: regByStatus.pending || 0,
            waitlisted: regByStatus.waitlisted || 0,
            trend: regTrend,
            last7d: regTrend.slice(-7).reduce((a, d) => a + d.count, 0)
        },
        users: {
            total: users.length,
            active: activeUsers.length,
            inactive: users.length - activeUsers.length,
            by_role: CMStats.countBy(users, (u) => u.role || 'user'),
            active_last_30d: activeLast30,
            last_login_available: hasLastLogin
        },
        errors: {
            open_recent_30d: errorRows.length,
            by_severity: errorBySeverity,
            top_types: errorTopTypes,
            trend: errorTrend,
            severity_available: hasSeverity
        },
        push: {
            notifications: pushRows.length,
            sent,
            failed,
            success_rate: CMStats.percent(sent, pushTotal),
            success_tone: CMStats.rateTone(CMStats.percent(sent, pushTotal))
        },
        perf: {
            posters: {
                count: posters.length,
                total_bytes: posterBytes,
                total_label: CMStats.formatBytes(posterBytes),
                thumb_count: thumbCount,
                thumb_bytes: thumbBytes,
                thumb_label: CMStats.formatBytes(thumbBytes),
                thumb_saved: Math.max(0, posterBytes - thumbBytes),
                thumb_saved_label: CMStats.formatBytes(Math.max(0, posterBytes - thumbBytes)),
                thumb_available: hasPosterThumb
            },
            staff_count: staffCount === null ? null : staffCount.length,
            paging: {
                competitions_max: COMPETITIONS_PAGE_MAX,
                registrations_max: REGISTRATIONS_PAGE_MAX,
                default_max: CMPaging.DEFAULT_MAX
            },
            indexes: OPS_INDEXES,
            timings,
            total_ms: Date.now() - now
        }
    };

    serverState.opsStatsCache = { at: now, days, payload };
    res.json(payload);
});

// ==========================================
// 前端共用設定 API
// ==========================================
// 分類清單定義在後端（server.js），前端一律由此取得，避免兩邊各寫一份而不同步。
app.get('/api/meta', (req, res) => {
    res.json({
        categories: COMPETITION_CATEGORIES,
        maxTags: MAX_TAGS,
        maxTagLength: MAX_TAG_LENGTH,
        version: require('../package.json').version
    });
});

// ==========================================
// 比賽賽事 API (CRUD)
// ==========================================

// 取得比賽列表 (透過 audit_logs 計算發佈者資訊)
};
