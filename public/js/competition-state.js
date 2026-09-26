/* 賽事狀態機（v2.19.0）—— UMD，前後端共用同一份規則
 *
 * 為什麼要共用：狀態（報名中／尚未開放／報名已截止／進行中／已結束）如果前後端各寫一套，
 * 遲早會出現「畫面說可以報名、送出卻被拒絕」的矛盾。這個檔案是**唯一真實來源**：
 *   - 後端 `require('./public/js/competition-state')`（server.js）
 *   - 前端 `<script src="/js/competition-state.js">`（表單即時預覽、舊回應的降級推算）
 * 規則改一次，兩邊同時生效（同 `csv.js` 的作法）。
 *
 * 設計原則：
 *   1. **狀態不存資料庫、不需要排程**：每次讀取用「當下時間」即時推導 →
 *      時間一到就自動切換，不會有「排程沒跑到、狀態卡在舊值」的問題，也不需要 migration。
 *   2. 全部是純函式 → 傳入 `now` 就能在單元測試裡驗任何邊界（報名開始那一秒、賽事結束那一刻…）。
 *
 * 狀態優先序（後面的條件優先）：報名相關 → 進行中 → 已結束（最優先）。
 *   missing / deleted / unscheduled / registration_upcoming / registration_open
 *   / registration_closed / ongoing / finished
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMCompetitionState = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const LABELS = {
        missing: '找不到該賽事',
        deleted: '已下架',
        unscheduled: '日期未定',
        registration_upcoming: '尚未開放報名',
        registration_open: '報名中',
        registration_closed: '報名已截止',
        ongoing: '進行中',
        finished: '已結束'
    };

    // 前端 badge 用的色調（green/amber/blue/slate 都已在 custom.css 有對應 class）
    const TONES = {
        missing: 'slate', deleted: 'slate', unscheduled: 'slate',
        registration_upcoming: 'amber', registration_open: 'green',
        registration_closed: 'slate', ongoing: 'blue', finished: 'slate'
    };

    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const fmtDate = (d) => (d ? dateStr(d) : '');
    const fmtDateTime = (d) => (d ? `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '');

    /* 'YYYY-MM-DD' + 'HH:MM' → 本地時間的 Date（無法解析回 null） */
    function parseLocalDateTime(date, time, fallbackTime) {
        if (!date) return null;
        const d = String(date).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
        const t = /^\d{1,2}:\d{2}/.test(String(time || '')) ? String(time).slice(0, 5) : fallbackTime;
        const dt = new Date(`${d}T${t}:00`);
        return isNaN(dt.getTime()) ? null : dt;
    }

    /* 解析「日期」或「完整時間戳」兩種寫法：
       - 'YYYY-MM-DD'（舊欄位 registration_deadline）→ 當天 23:59（與改版前行為一致：截止日當天仍可報名）
       - ISO 時間戳（registration_start_at / registration_end_at）→ 原樣解析（無時區者視為本地時間） */
    function parseTimestamp(value) {
        if (!value) return null;
        const s = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseLocalDateTime(s, null, '23:59');
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
    }

    /* 某一天的最後一刻（23:59:59.999）——用來表示「當天結束」 */
    function endOfDay(dateStr) {
        const base = parseLocalDateTime(dateStr, null, '00:00');
        if (!base) return null;
        return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
    }

    /* 把賽事的日期欄位整理成一條時間軸 */
    function timeline(comp) {
        const c = comp || {};
        const start = parseLocalDateTime(c.date, c.time, '00:00');
        let end = null;
        if (c.end_date) {
            end = parseLocalDateTime(c.end_date, c.end_time, '23:59');
        } else if (start) {
            // 單日賽事：沒有 end_date 就是「當天結束」（23:59:59.999）。
            // 不能拿「開始時間」當結束時間，否則 09:00 開始的賽事在 09:01 就被判成已結束；
            // 也不能只到 23:59:00，否則 23:59:30 這種當天稍晚的時間會提早被判成已結束。
            end = endOfDay(c.date);
        }
        const regStart = parseTimestamp(c.registration_start_at);
        // 截止時間：優先新的 registration_end_at，其次舊的 registration_deadline（相容既有資料）
        const regEnd = parseTimestamp(c.registration_end_at) || parseTimestamp(c.registration_deadline);
        return { start, end, regStart, regEnd };
    }

    /* 賽事狀態（純函式）：回傳完整狀態物件，前端直接顯示，不要在前端重算 */
    function evaluate(comp, now, options) {
        const opts = options || {};
        const at = now instanceof Date ? now : (now ? new Date(now) : new Date());
        const t = timeline(comp);
        const registeredCount = parseInt(opts.registeredCount, 10) || 0;
        const max = parseInt(comp && comp.max_registrations, 10) || 0;
        const full = max > 0 && registeredCount >= max;
        // v2.20.0：名額滿了但有開放候補 → 報名還是送得出去（會排進候補），不是「不能報名」
        const waitlistOnFull = full && reviewFlags(comp).waitlistEnabled;
        const needsApproval = reviewFlags(comp).requiresApproval;
        const waitlistCount = parseInt(opts.waitlistCount, 10) || 0;
        // 額滿但可候補時，把「會排到第幾位」講清楚（前端按鈕與說明都用同一段文字）
        const waitlistReason = `名額已滿（${max} 人），報名將排入候補（第 ${waitlistCount + 1} 位）`;

        const build = (state, canRegister, reason, detail) => ({
            state,
            label: LABELS[state],
            tone: TONES[state],
            can_register: canRegister,
            reason: reason || '',
            detail: detail || '',
            full: state === 'registration_open' ? full : false,
            // 「額滿但會排候補」在報名中與日期未定兩種狀態下都成立（都不會擋下報名）
            waitlist: waitlistOnFull,
            waitlist_position: waitlistOnFull ? waitlistCount + 1 : null,
            needs_approval: needsApproval,
            registered_count: registeredCount,
            max_registrations: max,
            timeline: {
                start: t.start ? t.start.toISOString() : null,
                end: t.end ? t.end.toISOString() : null,
                registration_start: t.regStart ? t.regStart.toISOString() : null,
                registration_end: t.regEnd ? t.regEnd.toISOString() : null
            }
        });

        if (!comp) return build('missing', false, '找不到該賽事');
        if (comp.is_deleted) return build('deleted', false, '此賽事已下架');

        // 日期未定：只依「開放報名中」與報名窗判斷，不猜時間
        if (!t.start) {
            if (!comp.is_registration_open) return build('unscheduled', false, '此賽事目前未開放報名', '尚未設定賽事日期');
            if (t.regStart && at < t.regStart) return build('unscheduled', false, `報名將於 ${fmtDate(t.regStart)} 開始`, '日期未定');
            if (t.regEnd && at > t.regEnd) return build('unscheduled', false, `報名已於 ${fmtDate(t.regEnd)} 截止`, '日期未定');
            if (full && !waitlistOnFull) return build('unscheduled', false, `報名人數已達上限（${max} 人）`, '日期未定');
            if (waitlistOnFull) return build('unscheduled', true, waitlistReason, '日期未定');
            return build('unscheduled', true, '', '日期未定（仍開放報名）');
        }

        if (t.end && at >= t.end) return build('finished', false, '此賽事已結束', `已於 ${fmtDateTime(t.end)} 結束`);
        if (at >= t.start) return build('ongoing', false, '此賽事已開始，報名已截止', `${fmtDateTime(t.start)} 開始`);

        // 以下都是「還沒開始」的情況
        if (!comp.is_registration_open) return build('registration_closed', false, '此賽事目前未開放報名', `${fmtDateTime(t.start)} 開始`);
        if (t.regStart && at < t.regStart) {
            return build('registration_upcoming', false, `報名將於 ${fmtDateTime(t.regStart)} 開始`, `${fmtDateTime(t.start)} 開始`);
        }
        if (t.regEnd && at > t.regEnd) {
            return build('registration_closed', false, `報名已於 ${fmtDate(t.regEnd)} 截止`, `${fmtDateTime(t.start)} 開始`);
        }
        if (full && !waitlistOnFull) return build('registration_open', false, `報名人數已達上限（${max} 人）`, `報名至 ${fmtDateTime(t.regEnd) || '賽事開始'}`);
        if (waitlistOnFull) return build('registration_open', true, waitlistReason, `報名至 ${fmtDateTime(t.regEnd) || '賽事開始'}`);
        return build('registration_open', true, '', `報名至 ${fmtDateTime(t.regEnd) || '賽事開始'}`);
    }

    /* ---------- v2.20.0：報名審核與候補（同一份規則，前後端共用） ----------
       報名結果只有四種狀態，而且**名額的定義只有一個**：
         佔名額 = 已核准（confirmed）＋ 待審核（pending）
         候補（waitlisted）不佔名額，未錄取（rejected）也不佔。
       既有資料的 status 都是 'confirmed'，所以舊資料不必搬移。
    ------------------------------------------------------------------ */
    const REG_STATUS_LABELS = {
        pending: '待審核',
        confirmed: '已核准',
        waitlisted: '候補',
        rejected: '未錄取'
    };

    const REG_STATUS_TONES = {
        pending: 'amber',
        confirmed: 'green',
        waitlisted: 'blue',
        rejected: 'rose'
    };

    const OCCUPIES_SLOT = { pending: true, confirmed: true, waitlisted: false, rejected: false };

    const normalizeRegStatus = (s) => {
        const v = String(s || '').trim().toLowerCase();
        return REG_STATUS_LABELS[v] ? v : 'confirmed';   // 未知／空值一律視為已核准（v2.9.0 的舊資料）
    };

    /* 依狀態統計（伺服器與前端都用它算「佔幾個名額、幾人候補」） */
    function countByStatus(rows) {
        const out = { confirmed: 0, pending: 0, waitlisted: 0, rejected: 0, slots: 0, total: 0 };
        for (const r of rows || []) {
            if (!r || r.is_deleted) continue;
            const s = normalizeRegStatus(r.status);
            out[s] += 1;
            out.total += 1;
            if (OCCUPIES_SLOT[s]) out.slots += 1;
        }
        return out;
    }

    /* 這個賽事「需不需要審核」「有沒有開放候補」（欄位不存在時一律視為沒有 → 功能自動停用） */
    function reviewFlags(comp) {
        const c = comp || {};
        return {
            requiresApproval: c.requires_approval === true,
            waitlistEnabled: c.waitlist_enabled === true
        };
    }

    /* 送出一筆報名之後，這筆報名應該是哪種狀態？
       回 { status, waitlist_position, reason }；status 為 null 代表「不該收這筆報名」（reason 說明原因）。 */
    function decideRegistration(comp, counts) {
        const cur = counts || {};
        const slots = Number(cur.slots) || 0;
        const max = parseInt(comp && comp.max_registrations, 10) || 0;   // 0 = 不限
        const full = max > 0 && slots >= max;
        const flags = reviewFlags(comp);
        const waitlistLen = Number(cur.waitlisted) || 0;

        if (!full) {
            return flags.requiresApproval
                ? { status: 'pending', waitlist_position: null, reason: '' }
                : { status: 'confirmed', waitlist_position: null, reason: '' };
        }
        if (flags.waitlistEnabled) {
            return { status: 'waitlisted', waitlist_position: waitlistLen + 1, reason: '' };
        }
        return {
            status: null,
            waitlist_position: null,
            reason: flags.requiresApproval
                ? `報名人數已達上限（${max} 人），且此賽事未開放候補，請聯絡主辦單位`
                : `報名人數已達上限（${max} 人）`
        };
    }

    /* v2.21.0：管理員可以手動調整候補順位（waitlist_order，從 1 開始）。
       規則刻意單純好預測：
         - 兩筆都手動排過 → 照手動數字（小的在前）
         - 只有一筆手動排過 → 手動那筆在前（新報名的人一律排到最後，不會插隊）
         - 兩筆都沒排過 → 先報名先排（created_at，其次 id）
       waitlist_order 欄位不存在（未執行 migration）時，全部走「先報名先排」→ 功能自動退回舊行為。 */
    const waitlistOrderNum = (row) => {
        const v = Number(row && row.waitlist_order);
        return Number.isFinite(v) && v > 0 ? v : null;
    };

    function waitlistQueue(rows) {
        return (rows || [])
            .filter((r) => r && !r.is_deleted && normalizeRegStatus(r.status) === 'waitlisted')
            .slice()
            .sort((a, b) => {
                const oa = waitlistOrderNum(a);
                const ob = waitlistOrderNum(b);
                if (oa !== null && ob !== null && oa !== ob) return oa - ob;
                if (oa !== null && ob === null) return -1;
                if (oa === null && ob !== null) return 1;
                const ta = String(a.created_at || '');
                const tb = String(b.created_at || '');
                if (ta !== tb) return ta < tb ? -1 : 1;
                return (Number(a.id) || 0) - (Number(b.id) || 0);
            });
    }

    /* 某筆報名在候補名單裡是第幾位（不在名單裡回 null） */
    function waitlistPosition(rows, id) {
        const queue = waitlistQueue(rows);
        const i = queue.findIndex((r) => String(r.id) === String(id));
        return i < 0 ? null : i + 1;
    }

    /* 調整候補順位：管理員給一組「完整的 id 順序」，回傳每一筆要寫入的 waitlist_order。
       只認目前真的在候補名單裡的 id；數量或成員對不上就整批拒絕（回 ok:false）——
       寧可叫管理員重新整理，也不要寫出「少數人被擠到後面」的半套結果。 */
    function planWaitlistOrder(rows, orderIds) {
        const queue = waitlistQueue(rows);
        const current = queue.map((r) => String(r.id));
        const wanted = (orderIds || []).map((id) => String(id));
        const missing = current.filter((id) => !wanted.includes(id));
        const unknown = wanted.filter((id) => !current.includes(id));
        const duplicated = wanted.length !== new Set(wanted).size;
        if (missing.length || unknown.length || duplicated) {
            const bits = [];
            if (duplicated) bits.push('有重複的項目');
            if (missing.length) bits.push(`漏掉 ${missing.length} 筆`);
            if (unknown.length) bits.push(`${unknown.length} 筆不在候補名單裡`);
            return { ok: false, reason: `候補名單已變動（${bits.join('、')}），請重新整理後再調整`, updates: [] };
        }
        return { ok: true, reason: '', updates: wanted.map((id, i) => ({ id, waitlist_order: i + 1 })) };
    }

    /* 指定遞補（不照順位）：回 { ok, reason, status, position }。
       「名額已滿時不能遞補」的守門寫在這裡，端點與測試共用同一份判斷。 */
    function planPromotion(comp, rows, targetId) {
        const queue = waitlistQueue(rows);
        const index = queue.findIndex((r) => String(r.id) === String(targetId));
        if (index < 0) {
            return { ok: false, reason: '這筆報名不在候補名單裡（可能已被遞補、取消或改成未錄取）', status: null, position: null };
        }
        const counts = countByStatus(rows);
        const max = parseInt(comp && comp.max_registrations, 10) || 0;
        if (max > 0 && counts.slots >= max) {
            return { ok: false, reason: `名額已滿（${max} 人）：請先取消或拒絕其他報名，再遞補候補`, status: null, position: index + 1 };
        }
        return { ok: true, reason: '', status: promotionStatus(comp), position: index + 1 };
    }

    /* 把某一位搬到指定位置（0 開始的索引），回傳新的完整順序（純函式，不動原陣列）。
       拖拉排序與「移到第 N 位」都用這一個：位置超出範圍就夾到頭或尾，
       認不出 id（例如名單剛被別人改過）就回傳 null，呼叫端不送 API。 */
    function moveInQueue(ids, id, toIndex) {
        const list = (ids || []).map((x) => String(x));
        const from = list.indexOf(String(id));
        if (from < 0) return null;
        const to = Math.max(0, Math.min(list.length - 1, Number(toIndex)));
        if (!Number.isFinite(to) || to === from) return list;
        const next = list.slice();
        next.splice(from, 1);
        next.splice(to, 0, String(id));
        return next;
    }

    /* 把一整批人搬到指定位置（多選後「移到第 N 位」用；挑選的人保持原本的相對順序）。
       位置是「這批人的第一位」要放的地方；超出範圍夾到頭或尾。
       有任何一個 id 不在名單裡就回 null（呼叫端不送 API，讓管理員重新整理）。 */
    function moveGroup(ids, selectedIds, toIndex) {
        const list = (ids || []).map((x) => String(x));
        const wanted = new Set((selectedIds || []).map((x) => String(x)));
        // 一律照「名單上目前的順序」搬（不是照勾選的先後），這樣結果才可預期
        const picked = list.filter((id) => wanted.has(id));
        if (!picked.length) return null;
        if ((selectedIds || []).some((id) => !list.includes(String(id)))) return null;

        const rest = list.filter((id) => !picked.includes(id));
        // 「移到第 N 位」是指搬完之後這批人的第一位在第 N 位 → 換算成在 rest 裡的插入點
        const target = Math.max(1, Math.min(list.length - picked.length + 1, Number(toIndex) || 1));
        const at = Math.max(0, Math.min(rest.length, target - 1));
        return rest.slice(0, at).concat(picked, rest.slice(at));
    }

    /* ── v2.24.0：週期性賽事（複製與自動建立下一場） ── */

    const RECURRENCE_RULES = { weekly: '每週', biweekly: '每兩週', monthly: '每月' };
    const RECURRENCE_LEAD_DAYS = 30;   // 提前幾天把下一場開好

    /* 依週期算出下一個日期（'YYYY-MM-DD'）。認不得的規則或日期回 null。
       每月：日期不存在就夾到當月最後一天（1/31 → 2/28），不會跳到下個月。 */
    function nextOccurrenceDate(dateStr, rule) {
        const raw = String(dateStr || '').slice(0, 10);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
        if (!m || !RECURRENCE_RULES[rule]) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

        if (rule === 'weekly' || rule === 'biweekly') {
            const days = rule === 'weekly' ? 7 : 14;
            const dt = new Date(Date.UTC(y, mo - 1, d));
            dt.setUTCDate(dt.getUTCDate() + days);
            return fmt(dt);
        }
        // 每月：先算下個月的目標日，月份天數不足時夾到月底
        const targetMonth = mo === 12 ? 0 : mo;
        const targetYear = mo === 12 ? y + 1 : y;
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        return fmt(new Date(Date.UTC(targetYear, targetMonth, Math.min(d, lastDay))));
    }

    const dateNum = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').slice(0, 10));
        return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    };

    /* 該不該幫這個系列建立下一場？
       回 { create, date, reason, overdue }；純函式，cron 與「立即建立下一場」共用同一份判斷。 */
    function planRecurringCreation(latest, existingDates, today, options) {
        const opts = options || {};
        const leadDays = Number.isFinite(opts.leadDays) ? opts.leadDays : RECURRENCE_LEAD_DAYS;
        const rule = latest && latest.recurrence;
        if (!rule || !RECURRENCE_RULES[rule]) {
            return { create: false, date: null, reason: '這場賽事沒有設定週期', overdue: false };
        }
        const next = nextOccurrenceDate(latest.date, rule);
        if (!next) return { create: false, date: null, reason: '賽事日期不完整，無法推算下一場', overdue: false };

        const until = latest.recurrence_until ? String(latest.recurrence_until).slice(0, 10) : null;
        if (until && dateNum(next) > dateNum(until)) {
            return { create: false, date: next, reason: `已超過週期結束日（${until}）`, overdue: false };
        }
        const existing = (existingDates || []).map((d) => String(d || '').slice(0, 10));
        if (existing.includes(next)) {
            return { create: false, date: next, reason: `下一場（${next}）已經存在`, overdue: false };
        }
        const todayNum = dateNum(fmtLocalDate(today));
        // 判斷順序：① 沒有週期 ② 日期壞掉 ③ 結束日已過 ④ 下一場存在 ⑤ 系列已排定 ⑥ 落後 ⑦ 還太早
        // （結束日放前面：系列已經結束時，「已經有排定的場次」這種說法會讓人誤會）
        // 一次只排一場：系列裡只要還有「今天以後」的場次，就先不開新的
        // （否則每天跑一次 cron 會一路把 30 天內每一場都開出來）
        const future = existing.filter((d) => todayNum !== null && dateNum(d) !== null && dateNum(d) > todayNum);
        if (future.length) {
            const last = future.sort().slice(-1)[0];
            return { create: false, date: next, reason: `系列已經有排定的場次（${last}），等它結束後才會再往後排`, overdue: false };
        }
        if (todayNum !== null && dateNum(next) < todayNum) {
            return { create: false, date: next, reason: `週期已落後：推算出的下一場（${next}）已經過期，請手動調整日期或關閉週期`, overdue: true };
        }
        if (todayNum !== null && dateNum(next) - todayNum > leadDays * 86400000) {
            return { create: false, date: next, reason: `還沒到建立時間（提前 ${leadDays} 天建立，下一場是 ${next}）`, overdue: false };
        }
        return { create: true, date: next, reason: '', overdue: false };
    }

    /* 今天的本地日期字串（cron 在伺服器端用 Date；測試可以自己傳日期） */
    function fmtLocalDate(d) {
        const dt = d instanceof Date ? d : new Date(d);
        if (Number.isNaN(dt.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }

    /* 有人讓出名額時，該遞補誰？（第一個候補，可排除剛取消的那筆） */
    function nextWaitlist(rows, excludeId) {
        const queue = waitlistQueue(rows).filter((r) => excludeId === undefined || String(r.id) !== String(excludeId));
        return queue.length ? queue[0] : null;
    }

    /* 遞補後要變成什麼狀態：需要審核的賽事遞補後仍需審核（pending），否則直接核准 */
    function promotionStatus(comp) {
        return reviewFlags(comp).requiresApproval ? 'pending' : 'confirmed';
    }

    /* 舊介面：報名是否可以送出（{ open, reason }） */
    function registrationState(comp, now, registeredCount) {
        const st = evaluate(comp, now, { registeredCount });
        return { open: !!st.can_register, reason: st.can_register ? '' : st.reason };
    }

    return {
        LABELS, TONES, evaluate, registrationState, timeline, parseTimestamp, parseLocalDateTime, fmtDate, fmtDateTime,
        // v2.20.0：報名審核與候補
        REG_STATUS_LABELS, REG_STATUS_TONES, countByStatus, normalizeRegStatus, reviewFlags,
        decideRegistration, waitlistQueue, nextWaitlist, promotionStatus,
        // v2.21.0：指定遞補與候補順位手動調整
        waitlistPosition, planWaitlistOrder, planPromotion, waitlistOrderNum,
        // v2.22.0：一次搬動到指定位置（拖拉排序與下拉共用）
        moveInQueue,
        // v2.23.0：多選一次搬多筆
        moveGroup,
        // v2.24.0：週期性賽事
        RECURRENCE_RULES, RECURRENCE_LEAD_DAYS, nextOccurrenceDate, planRecurringCreation, fmtLocalDate
    };
}));
