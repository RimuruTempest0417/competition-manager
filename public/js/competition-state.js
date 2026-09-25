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

        const build = (state, canRegister, reason, detail) => ({
            state,
            label: LABELS[state],
            tone: TONES[state],
            can_register: canRegister,
            reason: reason || '',
            detail: detail || '',
            full: state === 'registration_open' ? full : false,
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
            if (full) return build('unscheduled', false, `報名人數已達上限（${max} 人）`, '日期未定');
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
        if (full) return build('registration_open', false, `報名人數已達上限（${max} 人）`, `報名至 ${fmtDateTime(t.regEnd) || '賽事開始'}`);
        return build('registration_open', true, '', `報名至 ${fmtDateTime(t.regEnd) || '賽事開始'}`);
    }

    /* 舊介面：報名是否可以送出（{ open, reason }） */
    function registrationState(comp, now, registeredCount) {
        const st = evaluate(comp, now, { registeredCount });
        return { open: !!st.can_register, reason: st.can_register ? '' : st.reason };
    }

    return { LABELS, TONES, evaluate, registrationState, timeline, parseTimestamp, parseLocalDateTime, fmtDate, fmtDateTime };
}));
