/* 賽事 CRUD、複製與週期性（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/competitions')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const CMCompetitionState = require('../public/js/competition-state');
const CMPaging = require('../public/js/paging');                  // v3.0.0：分頁規則的唯一真實來源（前後端共用）
const CMVenue = require('../public/js/venue');                    // v2.27.0：地圖連結規則的唯一真實來源

module.exports = function registerCompetitionsRoutes(app, ctx) {
    const { COMPETITIONS_PAGE_MAX, MIGRATION_HINT, SCHEDULE_HINT, cleanText, fetchCompetition, logPushEvent, notifyUser, scheduleSchemaReady, RECURRENCE_HINT, RECURRENCE_RULE_LABELS, TEAM_HINT, buildDuplicatePayload, columnExists, competitionState, copySchemaReady, createNextOccurrence, getTrashCompetitionsHandler, hasRegistrationWindowContent, hasReviewFlagsContent, hasTaxonomyContent, hasTeamFieldsContent, isMissingColumnError, logAudit, logErrorToDb, mapUrlSchemaReady, normalizeCategory, normalizeRecurrenceRule, normalizeRegistrationWindow, normalizeReviewFlags, normalizeTags, normalizeTeamFields, recurrenceSchemaReady, registrationReviewSchemaReady, registrationWindowSchemaReady, requireAdmin, requireSuperAdmin, sanitizeInput, serverState, shouldIncludeRegistrationWindow, shouldIncludeTaxonomy, shouldIncludeTeamFields, supabase, taxonomySchemaReady, teamSchemaReady } = ctx;
app.get('/api/competitions', async (req, res) => {
    try {
        // v3.0.0：分頁是 opt-in（沒帶 limit 就維持原本「一次回全部」）。
        // ?state= 是「即時推導」的狀態，資料庫無法過濾 → 有 state 篩選時只能在記憶體切片，
        // 回應會用 paged_by 標示是 db 還是 memory，讓呼叫端知道這個差別。
        const paging = CMPaging.parsePaging(req.query, { max: COMPETITIONS_PAGE_MAX });
        const wanted = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
        const pageInDb = paging.paged && wanted.length === 0;

        let compQuery = supabase
            .from('competitions')
            .select('*', pageInDb ? { count: 'exact' } : {})
            .or('is_deleted.is.null,is_deleted.eq.false')
            .order('id', { ascending: false });
        if (pageInDb) compQuery = compQuery.range(paging.offset, paging.offset + paging.limit - 1);

        const { data: competitions, error: compErr, count: compTotal } = await compQuery;

        if (compErr) throw compErr;
        if (!competitions || competitions.length === 0) {
            if (!paging.paged) return res.json([]);
            return res.json(CMPaging.pagedResponse([], {
                limit: paging.limit, offset: paging.offset,
                total: (typeof compTotal === 'number' ? compTotal : 0),
                pagedBy: pageInDb ? 'db' : 'memory'
            }));
        }

        const compIds = competitions.map(c => String(c.id));

        const { data: createLogs } = await supabase
            .from('audit_logs')
            .select('target_id, user_id')
            .eq('action', 'CREATE_COMPETITION')
            .in('target_id', compIds);

        const publisherMap = {};
        const usernames = new Set();
        if (createLogs) {
            createLogs.forEach(log => {
                publisherMap[log.target_id] = log.user_id;
                if (log.user_id) usernames.add(log.user_id);
            });
        }

        const userRoleMap = {};
        if (usernames.size > 0) {
            const { data: adminUsers } = await supabase
                .from('admin_users')
                .select('username, role')
                .in('username', Array.from(usernames));

            if (adminUsers) {
                adminUsers.forEach(u => {
                    userRoleMap[u.username] = u.role;
                });
            }
        }

        // v2.19.0：賽事狀態由後端即時推導（報名中／尚未開始／報名已截止／進行中／已結束），前端只負責顯示。
        // 人數上限需要實際報名數 → 一次查回來自己累加（與 /api/registration-counts 同一套規則）。
        // v2.20.0：「佔名額」＝已核准＋待審核（候補不算），所以這裡要一起讀 status
        const reviewReady = await registrationReviewSchemaReady();
        // v3.0.0：分頁時只撈「這一頁賽事」的報名（原本會把整張 registrations 掃回來），
        // 這是列表端點最貴的一步，成本因此從 O(全部報名) 變成 O(本頁賽事)。
        let regQuery = supabase
            .from('registrations')
            .select(reviewReady ? 'competition_id,status' : 'competition_id')
            .eq('is_deleted', false);
        if (pageInDb) regQuery = regQuery.in('competition_id', compIds);
        const { data: activeRegs } = await regQuery;

        const regCounts = {};
        const waitlistCounts = {};
        (activeRegs || []).forEach((r) => {
            const key = String(r.competition_id);
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            if (status === 'waitlisted') {
                waitlistCounts[key] = (waitlistCounts[key] || 0) + 1;
                return;   // 候補不佔名額
            }
            regCounts[key] = (regCounts[key] || 0) + 1;
        });

        // v3.3.0（P1-6）：規程附件。只取中介資料（標籤、大小、時間），不取檔案內容，
        // 所以列表不會被 PDF 拖慢；沒有附件就是 null，前端據此決定要不要顯示「規程」按鈕。
        const docReady = await columnExists('competition_docs', 'uploaded_at');
        const docMap = {};
        if (docReady) {
            let docQuery = supabase.from('competition_docs').select('competition_id,label,bytes,uploaded_at');
            if (pageInDb) docQuery = docQuery.in('competition_id', compIds);
            const { data: docs, error: docErr } = await docQuery;
            if (!docErr) (docs || []).forEach((d) => { docMap[String(d.competition_id)] = d; });
        }

        const now = new Date();
        const withState = competitions.map(c => {
            const pubName = publisherMap[String(c.id)] || null;
            const st = competitionState(c, now, {
                registeredCount: regCounts[String(c.id)] || 0,
                waitlistCount: waitlistCounts[String(c.id)] || 0
            });
            return {
                ...c,
                // v2.27.0：地圖連結（自訂優先；沒填就用地址自動產生，所以舊賽事也馬上有地圖可按）
                map_url: CMVenue.mapUrlFor(c),
                map_url_custom: CMVenue.normalizeMapUrl(c.map_url) || '',
                // v3.0.0：列表用縮圖（沒有縮圖時前端會自動退回原圖，舊海報不用回填）
                poster_thumb_url: c.poster_updated_at
                    ? `/api/competitions/${c.id}/poster?variant=thumb&v=${Date.parse(c.poster_updated_at) || 0}`
                    : null,
                // v3.3.0（P1-6）：規程附件（沒有就是 null）
                doc_url: docMap[String(c.id)] ? `/api/competitions/${c.id}/doc?v=${Date.parse(docMap[String(c.id)].uploaded_at) || 0}` : null,
                doc_label: docMap[String(c.id)] ? docMap[String(c.id)].label : null,
                doc_bytes: docMap[String(c.id)] ? docMap[String(c.id)].bytes : null,
                doc_uploaded_at: docMap[String(c.id)] ? docMap[String(c.id)].uploaded_at : null,
                map_url_auto: CMVenue.isAutoMapUrl(c),
                publisher_name: pubName,
                publisher_role: pubName ? (userRoleMap[pubName] || 'admin') : null,
                state: st.state,
                state_label: st.label,
                state_tone: st.tone,
                can_register: st.can_register,
                registration_reason: st.reason,
                state_detail: st.detail,
                is_full: st.full,
                registered_count: st.registered_count,
                waitlist_count: waitlistCounts[String(c.id)] || 0,
                is_waitlist: !!st.waitlist,
                needs_approval: !!st.needs_approval
            };
        });

        // ?state=registration_open,ongoing 只回這些狀態（前端分頁籤與外部整合都用這個）
        const filtered = wanted.length ? withState.filter(c => wanted.includes(c.state)) : withState;

        if (!paging.paged) return res.json(filtered);

        // pageInDb 時資料庫已經切好這一頁（filtered 就是本頁），不能再切一次
        const sliced = pageInDb ? filtered : CMPaging.pageSlice(filtered, paging);
        const total = pageInDb ? (typeof compTotal === 'number' ? compTotal : filtered.length) : filtered.length;
        res.json(CMPaging.pagedResponse(sliced, {
            limit: paging.limit, offset: paging.offset, total,
            pagedBy: pageInDb ? 'db' : 'memory'
        }));
    } catch (err) {
        await logErrorToDb(req, 'get_competitions_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 讀取回收桶 Handler (改用 'id' 排序，避免 deleted_at 欄位不存在報錯)
app.get('/api/competitions/trash', requireAdmin, getTrashCompetitionsHandler);
app.get('/api/competitions/deleted', requireAdmin, getTrashCompetitionsHandler);

// 新增比賽
app.post('/api/competitions', requireAdmin, async (req, res) => {
    const { name, location, date, time, end_date, end_time, description, is_registration_open, category, tags } = req.body;
    const operator = req.currentUser;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    const taxonomy = { category: normalizeCategory(category), tags: normalizeTags(tags) };
    const wantsTaxonomy = hasTaxonomyContent(taxonomy);

    if (wantsTaxonomy && !(await taxonomySchemaReady())) {
        return res.status(503).json({ error: MIGRATION_HINT });
    }
    const includeTaxonomy = shouldIncludeTaxonomy(taxonomy, serverState.taxonomy);

    const teamFields = normalizeTeamFields(req.body);
    if (hasTeamFieldsContent(teamFields) && !(await teamSchemaReady())) {
        return res.status(503).json({ error: TEAM_HINT });
    }
    const includeTeamFields = shouldIncludeTeamFields(teamFields, serverState.teamFields);

    // v2.19.0：報名開始／截止時間（時間到會自動切換狀態）
    const windowFields = normalizeRegistrationWindow(req.body);
    const includeWindow = shouldIncludeRegistrationWindow(windowFields, serverState.registrationWindow);
    const schemaWindowReady = await registrationWindowSchemaReady();

    // v2.20.0：報名需審核／額滿可候補（尚未 migration 時不帶，功能自動停用）
    const reviewFields = normalizeReviewFlags(req.body);
    const schemaReviewReady = await registrationReviewSchemaReady();
    const includeReviewFields = schemaReviewReady && hasReviewFlagsContent(req.body);

    // v2.27.0：場地地圖連結。沒填＝用地址自動產生（前端 CMVenue 負責），所以舊資料不用補；
    // 填了但格式不對要明確回報，不要靜默丟掉——使用者會以為存進去了。
    const mapProvided = !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'map_url'));
    const mapRaw = (mapProvided && req.body.map_url !== undefined && req.body.map_url !== null)
        ? String(req.body.map_url).trim() : '';
    const mapUrl = CMVenue.normalizeMapUrl(mapRaw);
    if (mapRaw && !mapUrl) {
        return res.status(400).json({ error: '地圖連結格式不對：要 http／https 開頭的網址（想讓地圖指向某個地址，填在「地點」欄位就會自動產生連結）' });
    }
    const includeMap = await mapUrlSchemaReady();

    try {
        const payload = {
            name: name.trim(),
            location: sanitizeInput(location),
            date: sanitizeInput(date),
            time: sanitizeInput(time),
            end_date: sanitizeInput(end_date),
            end_time: sanitizeInput(end_time),
            description: sanitizeInput(description),
            is_registration_open: !!is_registration_open,
            ...(includeTaxonomy ? taxonomy : {}),
            ...(includeTeamFields ? teamFields : {}),
            // 欄位不存在時不帶（回傳 window_saved:false 讓前端誠實告知），時間欄位不該拖垮整筆儲存
            ...(includeWindow && schemaWindowReady ? windowFields : {}),
            ...(includeReviewFields ? reviewFields : {}),
            // 有帶欄位就照帶的值存（空＝沒有自訂連結，前端改用地址自動產生）；沒帶＝不碰
            ...(includeMap && mapProvided ? { map_url: mapUrl || null } : {}),
            is_deleted: false,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('competitions')
            .insert([payload])
            .select();

        if (error) throw error;

        const newComp = data[0];
        await logAudit(operator.username, 'CREATE_COMPETITION', newComp.id, `發佈賽事: ${newComp.name}`, req.userAgent);

        // 有填報名時間或地圖連結、但資料庫沒有欄位時要誠實告知（不要讓使用者以為存進去了）
        const saveWarnings = [];
        const windowLost = hasRegistrationWindowContent(windowFields) && !schemaWindowReady;
        const mapLost = !!mapRaw && !includeMap;
        if (windowLost) saveWarnings.push('資料庫缺少報名開始／截止欄位，時間未儲存（請執行 migrations/ 內的 SQL）');
        if (mapLost) saveWarnings.push('資料庫缺少地圖連結欄位，地圖連結未儲存（請執行 migrations/2026-09-26-v2.27.0-venue-staff.sql）');
        res.json(saveWarnings.length
            ? Object.assign({}, newComp, {
                ...(windowLost ? { registration_window_saved: false } : {}),
                ...(mapLost ? { map_url_saved: false } : {}),
                warning: saveWarnings.join('；')
            })
            : newComp);
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags'])) {
            serverState.taxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
        }
        if (isMissingColumnError(err, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations'])) {
            serverState.teamFields = false;
            return res.status(503).json({ error: TEAM_HINT });
        }
        await logErrorToDb(req, 'create_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// v2.24.0：複製賽事（設定照抄；報名、隊伍、海報都不搬）
app.post('/api/competitions/:id/duplicate', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const src = rows && rows[0];
        if (!src) return res.status(404).json({ error: '找不到這筆賽事' });

        const schema = await copySchemaReady();
        const baseName = String(src.name || '').trim() || '未命名賽事';
        // 名稱一律加「（複製）」；原本就已經是複製品的話不會變成「（複製）（複製）」
        const copyName = (baseName.replace(/（複製）$/, '') + '（複製）').slice(0, 190);
        const payload = buildDuplicatePayload(src, copyName, schema, { series: false });

        const { data: created, error: insErr } = await supabase.from('competitions').insert([payload]).select();
        if (insErr) throw insErr;
        const row = created[0];
        await logAudit(
            operator.username,
            'DUPLICATE_COMPETITION',
            row.id,
            `複製賽事：${baseName} → ${copyName}（日期 ${row.date || '未填'}；報名與隊伍不搬）`,
            req.userAgent
        );
        res.status(201).json(Object.assign({}, row, {
            copied_from: src.id,
            copied_from_name: baseName,
            copied_fields: Object.keys(schema).filter((k) => schema[k])
        }));
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags', 'is_team_event', 'team_size', 'max_registrations', 'registration_deadline'])) {
            return res.status(503).json({ error: '資料庫欄位不足，請先執行 migrations/ 內的 SQL' });
        }
        await logErrorToDb(req, 'duplicate_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// v2.24.0：設定／取消賽事週期（自動建立下一場的開關）
app.post('/api/competitions/:id/recurrence', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    if (!(await recurrenceSchemaReady())) return res.status(503).json({ error: RECURRENCE_HINT });

    const body = req.body || {};
    const rule = body.recurrence ? normalizeRecurrenceRule(body.recurrence) : null;
    if (body.recurrence && !rule) {
        return res.status(400).json({ error: '週期只能是每週（weekly）、每兩週（biweekly）或每月（monthly）' });
    }
    const untilRaw = body.recurrence_until ? String(body.recurrence_until).trim().slice(0, 10) : null;
    if (untilRaw && !/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) {
        return res.status(400).json({ error: '週期結束日格式要像 2026-12-31' });
    }

    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const comp = rows && rows[0];
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const compDate = String(comp.date || '').slice(0, 10);
        if (rule && untilRaw && /^\d{4}-\d{2}-\d{2}$/.test(compDate) && untilRaw < compDate) {
            return res.status(400).json({ error: '週期結束日不能早於賽事日期' });
        }

        const { data: updated, error: upErr } = await supabase
            .from('competitions')
            .update({ recurrence: rule, recurrence_until: rule ? untilRaw : null })
            .eq('id', id)
            .select();
        if (upErr) throw upErr;
        const row = (updated && updated[0]) || comp;

        // 週期是「整個系列」的設定：同一系列的其他場次一起同步，
        // 否則每一場各記一份週期，之後改其中一場會出現兩種說法。
        const rootId = String(comp.recurrence_parent_id || comp.id);
        let synced = 0;
        const { data: allRows } = await supabase.from('competitions').select('*');
        const members = (allRows || []).filter((c) => !c.is_deleted && (
            String(c.id) === rootId || String(c.recurrence_parent_id || '') === rootId
        ));
        for (const member of members) {
            if (String(member.id) === String(id)) continue;
            const { error: memberErr } = await supabase
                .from('competitions')
                .update({ recurrence: rule, recurrence_until: rule ? untilRaw : null })
                .eq('id', member.id);
            if (!memberErr) synced++;
        }

        await logAudit(
            operator.username,
            'SET_RECURRENCE',
            id,
            (rule
                ? `設定週期：${RECURRENCE_RULE_LABELS[rule]}${untilRaw ? `（到 ${untilRaw} 為止）` : '（一直重複）'}`
                : '取消週期設定') + (members.length > 1 ? `（系列共 ${members.length} 場同步）` : ''),
            req.userAgent
        );
        res.json(Object.assign({}, row, {
            recurrence_label: rule ? RECURRENCE_RULE_LABELS[rule] : null,
            series_synced: synced
        }));
    } catch (err) {
        if (isMissingColumnError(err, ['recurrence', 'recurrence_until'])) {
            serverState.recurrence = false;
            return res.status(503).json({ error: RECURRENCE_HINT });
        }
        await logErrorToDb(req, 'set_recurrence_error', err);
        res.status(500).json({ error: err.message });
    }
});

// v2.24.0：立刻建立下一場（與每日 cron 共用同一份判斷；不需要等排程）
app.post('/api/competitions/:id/recurrence/next', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (!(await recurrenceSchemaReady())) return res.status(503).json({ error: RECURRENCE_HINT });
    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const comp = rows && rows[0];
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const result = await createNextOccurrence(comp, req.currentUser, req.userAgent);
        if (!result.created) {
            // 409：不是錯誤，是「現在還不需要建立」——把原因照實回給介面顯示
            return res.status(409).json({ error: result.reason || '現在還不需要建立下一場', date: result.date, overdue: !!result.overdue });
        }
        res.status(201).json(Object.assign({}, result.competition, { created_from: id, next_date: result.date }));
    } catch (err) {
        if (isMissingColumnError(err, ['recurrence', 'recurrence_until', 'recurrence_parent_id'])) {
            serverState.recurrence = false;
            return res.status(503).json({ error: RECURRENCE_HINT });
        }
        await logErrorToDb(req, 'create_recurring_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 編輯比賽
app.put('/api/competitions/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, location, date, time, end_date, end_time, description, is_registration_open, category, tags } = req.body;
    const operator = req.currentUser;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    const taxonomy = { category: normalizeCategory(category), tags: normalizeTags(tags) };
    const wantsTaxonomy = hasTaxonomyContent(taxonomy);

    if (wantsTaxonomy && !(await taxonomySchemaReady())) {
        return res.status(503).json({ error: MIGRATION_HINT });
    }
    const includeTaxonomy = shouldIncludeTaxonomy(taxonomy, serverState.taxonomy);

    const teamFields = normalizeTeamFields(req.body);
    if (hasTeamFieldsContent(teamFields) && !(await teamSchemaReady())) {
        return res.status(503).json({ error: TEAM_HINT });
    }
    const includeTeamFields = shouldIncludeTeamFields(teamFields, serverState.teamFields);

    // v2.19.0：報名開始／截止時間（時間到會自動切換狀態）
    const windowFields = normalizeRegistrationWindow(req.body);
    const includeWindow = shouldIncludeRegistrationWindow(windowFields, serverState.registrationWindow);
    const schemaWindowReady = await registrationWindowSchemaReady();

    // v2.20.0：報名需審核／額滿可候補（尚未 migration 時不帶，功能自動停用）
    const reviewFields = normalizeReviewFlags(req.body);
    const schemaReviewReady = await registrationReviewSchemaReady();
    const includeReviewFields = schemaReviewReady && hasReviewFlagsContent(req.body);

    // v2.27.0：場地地圖連結。沒填＝用地址自動產生（前端 CMVenue 負責），所以舊資料不用補；
    // 填了但格式不對要明確回報，不要靜默丟掉——使用者會以為存進去了。
    const mapProvided = !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'map_url'));
    const mapRaw = (mapProvided && req.body.map_url !== undefined && req.body.map_url !== null)
        ? String(req.body.map_url).trim() : '';
    const mapUrl = CMVenue.normalizeMapUrl(mapRaw);
    if (mapRaw && !mapUrl) {
        return res.status(400).json({ error: '地圖連結格式不對：要 http／https 開頭的網址（想讓地圖指向某個地址，填在「地點」欄位就會自動產生連結）' });
    }
    const includeMap = await mapUrlSchemaReady();

    try {
        const payload = {
            name: name.trim(),
            location: sanitizeInput(location),
            date: sanitizeInput(date),
            time: sanitizeInput(time),
            end_date: sanitizeInput(end_date),
            end_time: sanitizeInput(end_time),
            description: sanitizeInput(description),
            is_registration_open: !!is_registration_open,
            ...(includeTaxonomy ? taxonomy : {}),
            ...(includeTeamFields ? teamFields : {}),
            ...(includeWindow && schemaWindowReady ? windowFields : {}),
            ...(includeReviewFields ? reviewFields : {}),
            ...(includeMap && mapProvided ? { map_url: mapUrl || null } : {})
        };

        const { data, error } = await supabase
            .from('competitions')
            .update(payload)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到該賽事' });

        await logAudit(operator.username, 'UPDATE_COMPETITION', id,
            `更新賽事內容: ${name}${mapRaw ? `（地圖連結：${mapUrl}）` : ''}`, req.userAgent);

        const updateWarnings = [];
        const windowLost = hasRegistrationWindowContent(windowFields) && !schemaWindowReady;
        const mapLost = !!mapRaw && !includeMap;
        if (windowLost) updateWarnings.push('資料庫缺少報名開始／截止欄位，時間未儲存（請執行 migrations/ 內的 SQL）');
        if (mapLost) updateWarnings.push('資料庫缺少地圖連結欄位，地圖連結未儲存（請執行 migrations/2026-09-26-v2.27.0-venue-staff.sql）');
        res.json(updateWarnings.length
            ? Object.assign({}, data[0], {
                ...(windowLost ? { registration_window_saved: false } : {}),
                ...(mapLost ? { map_url_saved: false } : {}),
                warning: updateWarnings.join('；')
            })
            : data[0]);
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags'])) {
            serverState.taxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
        }
        if (isMissingColumnError(err, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations'])) {
            serverState.teamFields = false;
            return res.status(503).json({ error: TEAM_HINT });
        }
        await logErrorToDb(req, 'update_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 軟刪除比賽
app.delete('/api/competitions/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .update({ is_deleted: true })
            .eq('id', id)
            .select();

        if (error) throw error;

        await logAudit(operator.username, 'DELETE_COMPETITION', id, `移至回收桶: ${data[0]?.name || id}`, req.userAgent);

        res.json({ message: '已移至回收桶' });
    } catch (err) {
        await logErrorToDb(req, 'soft_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 還原比賽
app.put('/api/competitions/:id/restore', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .update({ is_deleted: false })
            .eq('id', id)
            .select();

        if (error) throw error;

        await logAudit(operator.username, 'RESTORE_COMPETITION', id, `還原賽事: ${data[0]?.name || id}`, req.userAgent);

        res.json({ message: '賽事已成功還原' });
    } catch (err) {
        await logErrorToDb(req, 'restore_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 硬刪除比賽
app.delete('/api/competitions/:id/hard-delete', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { error } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await logAudit(operator.username, 'PERMANENT_DELETE_COMPETITION', id, `永久刪除賽事 ID: ${id}`, req.userAgent);

        res.json({ message: '賽事已永久刪除' });
    } catch (err) {
        await logErrorToDb(req, 'hard_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 📥 CSV 匯入 / 匯出 API (v2.8.0)
// 前端負責解析使用者上傳的檔案，這裡做權威驗證後才寫入資料庫。
// ==========================================

// ==========================================
// v2.9.0：普通用戶報名與隊伍編排 API
// ==========================================


/* ---------- v3.6.3：取消／延期／最新消息（Roadmap 8.8⑥）----------
 *
 * 為什麼需要人工標記：賽事狀態原本完全由日期推導，「延期過」「取消」算不出來；
 * 而澳門颱風延期是常態，事後查「原本訂幾號、後來延到幾號」很重要 → 原訂時間**不覆蓋**，
 * 延期的新時間另存 postponed_date／postponed_time。
 *
 * 為什麼公告要直接顯示在卡片：推播要訂閱，沒訂閱的人什麼都看不到；
 * 臨時變更（延期、集合時間、場地）最需要人人看得到 → news 直接畫在卡片與詳情。
 */

/* v3.6.4：把公告推播給「真的有報名的人」（Roadmap 8.8⑥ 的加分項）
 *
 * 為什麼只推給有報名的人：賽事公告的對象就是報名者，亂槍打鳥會讓推播變成噪音；
 * 站台層另有「賽事公告通知」開關（push_event_notice），關掉後這裡會回報 skipped 而不送。
 * 推播失敗不影響主要動作（取消／延期本身一定要成功），所以只記錄、不拋錯。 */
async function notifyRegistrants(comp, payload) {
    const { data, error } = await supabase.from('registrations')
        .select('user_id,status,is_deleted')
        .eq('competition_id', comp.id);
    if (error) throw error;
    const ids = Array.from(new Set((data || [])
        .filter((r) => r.is_deleted !== true)
        .map((r) => r.user_id)
        .filter((v) => v !== null && v !== undefined)));
    if (!ids.length) {
        await logPushEvent(comp.id, 'notice', 0, { targets: 0, reason: '沒有已報名的帳號可通知' });
        return { sent: 0, total: 0, targets: 0, skipped: '沒有已報名的帳號可通知' };
    }
    let sent = 0;
    let total = 0;
    let skipped = '';
    const errors = [];
    for (const userId of ids) {
        const result = await notifyUser(userId, Object.assign({ kind: 'notice' }, payload), { kind: 'notice' });
        sent += result.sent || 0;
        total += result.total || 0;
        if (!skipped && result.skipped) skipped = result.skipped;
        if (!skipped && result.error) skipped = result.error;
        if (Array.isArray(result.errors)) errors.push(...result.errors);
    }
    await logPushEvent(comp.id, 'notice', sent, { targets: ids.length, title: payload.title, errors });
    return { sent, total, targets: ids.length, skipped: skipped || undefined };
}

/* 把推播結果寫成人看得懂的一句話（放在回覆訊息後面，讓管理員知道到底送給誰了） */
function pushSummary(push) {
    if (!push) return '';
    if (push.skipped && !push.sent) return `；未推播（${push.skipped}）`;
    const who = push.targets ? `，已推播給 ${push.targets} 位已報名者` : '';
    const ok = push.sent ? `（實際送到 ${push.sent} 個裝置）` : '（對方尚未訂閱推播）';
    return `${who}${push.targets ? ok : ''}`;
}

/* 取消賽事（或帶 cancelled:false 復原）。取消＝狀態立即變「已取消」、不可再報名。 */
app.post('/api/competitions/:id/cancel', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const cancelled = body.cancelled !== false;      // 預設＝取消；明確傳 false 才是復原
    const reason = cleanText(body.reason, 200);

    try {
        if (!(await scheduleSchemaReady())) return res.status(503).json({ error: SCHEDULE_HINT });
        const comp = await fetchCompetition(id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });
        if (cancelled && !reason) return res.status(400).json({ error: '取消賽事請填寫原因（會顯示在卡片上讓大家看到）' });

        const { error } = await supabase.from('competitions')
            .update({ cancelled_at: cancelled ? new Date().toISOString() : null, cancel_reason: cancelled ? reason : null })
            .eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'CANCEL_COMPETITION', comp.id,
            cancelled ? `取消賽事：${comp.name}（原因：${reason}）` : `復原被取消的賽事：${comp.name}`, req.userAgent);

        // v3.6.4：勾選「同時推播」才送，取消時預設送（現場大家要知道不用來了）
        let push = null;
        if (body.notify === true) {
            push = await notifyRegistrants(comp, cancelled
                ? { title: `⛔ 賽事取消：${comp.name}`, body: `原訂 ${String(comp.date || '').slice(0, 10)}${comp.time ? ' ' + comp.time : ''}｜原因：${reason}` }
                : { title: `✅ 賽事恢復：${comp.name}`, body: `原訂 ${String(comp.date || '').slice(0, 10)}${comp.time ? ' ' + comp.time : ''}，取消標記已移除` });
        }

        const updated = await fetchCompetition(comp.id);
        res.json({
            message: (cancelled ? `已取消「${comp.name}」` : `已復原「${comp.name}」`) + pushSummary(push),
            competition: updated,
            state: competitionState(updated, new Date()).state,
            state_label: competitionState(updated, new Date()).label,
            push
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: MIGRATION_HINT });
        await logErrorToDb(req, 'cancel_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 延期：記下新日期（與可選的新時間），原訂時間保留；帶 postponed_date:null 表示取消延期。 */
app.post('/api/competitions/:id/postpone', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const newDate = body.postponed_date ? String(body.postponed_date).slice(0, 10) : null;
    const newTime = body.postponed_time ? String(body.postponed_time).slice(0, 5) : null;
    const reason = cleanText(body.reason, 200);

    try {
        if (!(await scheduleSchemaReady())) return res.status(503).json({ error: SCHEDULE_HINT });
        const comp = await fetchCompetition(id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });
        // 日期要「真的存在」：2026-10-99 這種通過格式檢查但算不出來的日期要擋下來
        // （用往返轉換比對，2026-02-30 會被規範化成 3/2，因此不相等 → 擋下）
        if (newDate) {
            const d = new Date(`${newDate}T00:00:00`);
            const roundTrip = isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (roundTrip !== newDate) return res.status(400).json({ error: '延期日期不是有效日期（格式 YYYY-MM-DD）' });
        }
        if (newTime && !/^\d{1,2}:\d{2}$/.test(newTime)) return res.status(400).json({ error: '延期時間格式要是 HH:MM' });
        if (newDate && newDate === String(comp.date || '').slice(0, 10)) {
            return res.status(400).json({ error: '延期後的新日期和原本日期一樣：若只是要公告變更，請用「更新最新消息」' });
        }

        const { error } = await supabase.from('competitions')
            .update({ postponed_date: newDate, postponed_time: newDate ? newTime : null })
            .eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'POSTPONE_COMPETITION', comp.id,
            newDate
                ? `賽事延期：${comp.name}（原訂 ${String(comp.date || '').slice(0, 10)} → ${newDate}${newTime ? ' ' + newTime : ''}${reason ? '｜' + reason : ''}）`
                : `取消延期標記：${comp.name}`, req.userAgent);

        let push = null;
        if (body.notify === true) {
            push = await notifyRegistrants(comp, newDate
                ? { title: `🕒 賽事延期：${comp.name}`, body: `延至 ${newDate}${newTime ? ' ' + newTime : ''}（原訂 ${String(comp.date || '').slice(0, 10)}${comp.time ? ' ' + comp.time : ''}）${reason ? '｜' + reason : ''}` }
                : { title: `🕒 賽事恢復原訂時間：${comp.name}`, body: `${String(comp.date || '').slice(0, 10)}${comp.time ? ' ' + comp.time : ''}，延期標記已移除` });
        }

        const updated = await fetchCompetition(comp.id);
        const st = competitionState(updated, new Date());
        res.json({
            message: (newDate ? `已將「${comp.name}」延期至 ${newDate}${newTime ? ' ' + newTime : ''}（原訂時間保留）` : `已取消「${comp.name}」的延期標記`) + pushSummary(push),
            competition: updated,
            state: st.state,
            state_label: st.label,
            push
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: MIGRATION_HINT });
        await logErrorToDb(req, 'postpone_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 最新消息：臨時集合時間、場地更換等，直接顯示在卡片與詳情（不需要訂閱推播）。 */
app.post('/api/competitions/:id/news', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const news = cleanText(body.news, 300);

    try {
        if (!(await scheduleSchemaReady())) return res.status(503).json({ error: SCHEDULE_HINT });
        const comp = await fetchCompetition(id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { error } = await supabase.from('competitions')
            .update({ news: news || null, news_updated_at: news ? new Date().toISOString() : null })
            .eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'UPDATE_COMPETITION_NEWS', comp.id,
            news ? `更新賽事最新消息：${comp.name}（${news}）` : `清空賽事最新消息：${comp.name}`, req.userAgent);

        let push = null;
        if (body.notify === true && news) {
            push = await notifyRegistrants(comp, { title: `📣 ${comp.name} 公告`, body: news });
        }

        const updated = await fetchCompetition(comp.id);
        res.json({
            message: (news ? '已更新最新消息（卡片上會直接顯示）' : '已清空最新消息') + pushSummary(push),
            competition: updated,
            push
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: MIGRATION_HINT });
        await logErrorToDb(req, 'competition_news_error', err);
        res.status(500).json({ error: err.message });
    }
});

};