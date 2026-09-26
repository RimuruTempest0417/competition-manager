/* v3.1.0：賽事成績的規則（UMD，前後端共用）
 *
 * 唯一真實來源：後端驗證、前端下拉選單、自動排名、名次顯示都走這一份，
 * 避免「前端畫得出來但後端不收」或「後端存得進去但前台顯示成空白」。
 *
 * 規則：
 *   ① 狀態固定五種：完賽／未完賽／未出賽／取消資格／其他。
 *   ② 只有「完賽」且成績看得懂（時間或數字）的人會進名次；
 *      未完賽／未出賽／取消資格一律不排名（名次顯示為 —）。
 *   ③ 自動排名預設「越小越好」（時間、秒數）；分數類可切「越大越好」。
 *   ④ 同分並列同名次（1, 1, 3）：不是 1, 2, 3，第二名從缺。
 *   ⑤ 名次不是唯一鍵——並列是常態，重複名次只提示不擋。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMResults = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const RESULT_STATUSES = [
        { id: 'finished', label: '完賽', emoji: '🏁' },
        { id: 'dnf', label: '未完賽', emoji: '🚫' },
        { id: 'dns', label: '未出賽', emoji: '⛔' },
        { id: 'dsq', label: '取消資格', emoji: '❌' },
        { id: 'other', label: '其他', emoji: '❔' }
    ];
    const DEFAULT_STATUS = 'other';
    const RANKED_STATUS = 'finished';
    const SCORE_MAX = 60;
    const NOTE_MAX = 200;
    const SUMMARY_MAX = 500;

    const statusById = (id) => RESULT_STATUSES.find((s) => s.id === id) || null;

    /* 狀態碼是否有效（前後端都先問這個） */
    function isValidStatus(status) {
        return typeof status === 'string' && !!statusById(status);
    }

    /* 把任何輸入收斂成有效的狀態碼；看不懂的一律當「其他」，不猜成完賽 */
    function normalizeStatus(status) {
        const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
        return isValidStatus(s) ? s : DEFAULT_STATUS;
    }

    function statusLabel(status) {
        const s = statusById(normalizeStatus(status));
        return `${s.emoji} ${s.label}`;
    }

    /* 整理成績文字：去掉前後空白、壓縮中間多餘空白、過長就截斷（回 null 代表空） */
    function normalizeScoreText(text) {
        if (text === null || text === undefined) return null;
        const s = String(text).replace(/\s+/g, ' ').trim();
        if (!s) return null;
        return s.length > SCORE_MAX ? s.slice(0, SCORE_MAX) : s;
    }

    /* 成績文字的資料庫表示 → 顯示用（空字串就是「—」） */
    function displayScore(text) {
        const s = normalizeScoreText(text);
        return s === null ? '—' : s;
    }

    /* 成績文字的資料庫表示 → 顯示用（未完賽等狀態直接顯示狀態） */
    function displayScoreOrStatus(row) {
        const r = row || {};
        const status = normalizeStatus(r.status);
        if (status !== RANKED_STATUS) return statusLabel(status);
        return displayScore(r.score_text);
    }

    /* ---------- 成績文字 → 可比較的數值 ----------
     * 支援：
     *   時間  12:34.56 ／ 1:02:03 ／ 1:02:03.4 ／ 59.9（純秒數） → 換算成秒
     *   分數  85 ／ 85.5 ／ -3（高爾夫那種低於標準桿）              → 原數值
     * 看不懂就回 null——不猜、不當 0，避免「看不懂的成績」被排成第一名。
     */
    function parseScoreValue(text) {
        const s = normalizeScoreText(text);
        if (s === null) return null;

        // 時間：可選的「時:」＋「分:秒」＋可選的小數
        const time = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
        if (time) {
            const hours = time[1] ? Number(time[1]) : 0;
            const mins = Number(time[2]);
            const secs = Number(time[3]);
            if (mins > 59 || secs > 59) return null;       // 12:99 不是時間
            const frac = time[4] ? Number(`0.${time[4]}`) : 0;
            return { kind: 'time', value: hours * 3600 + mins * 60 + secs + frac, text: s };
        }

        // 數字（可帶小數、可負）
        const num = /^-?\d+(?:\.\d+)?$/.exec(s);
        if (num) return { kind: 'number', value: Number(s), text: s };

        return null;
    }

    /* 這個狀態能不能有名次 */
    function isRankable(row) {
        const r = row || {};
        if (normalizeStatus(r.status) !== RANKED_STATUS) return false;
        return parseScoreValue(r.score_text) !== null;
    }

    /* ---------- 自動排名 ----------
     * rows：可含 score_text／status 的陣列（不改動原陣列）
     * options.order：'asc'（越小越好，預設，時間類）或 'desc'（越大越好，分數類）
     * 回傳新陣列，每列多一個 rank（不可排名者 rank 為 null）。
     */
    function autoRank(rows, options) {
        const opts = options || {};
        const desc = opts.order === 'desc';
        const list = (Array.isArray(rows) ? rows : []).map((r) => Object.assign({}, r));
        const rankable = [];
        list.forEach((r) => {
            if (!isRankable(r)) { r.rank = null; return; }
            r._value = parseScoreValue(r.score_text).value;
            rankable.push(r);
        });

        rankable.sort((a, b) => (desc ? b._value - a._value : a._value - b._value));

        let lastValue = null;
        let lastRank = 0;
        rankable.forEach((r, i) => {
            // 同分並列：名次沿用前一個，但位置照樣往前走（1, 1, 3）
            if (i > 0 && r._value === lastValue) r.rank = lastRank;
            else r.rank = i + 1;
            lastValue = r._value;
            lastRank = r.rank;
        });

        list.forEach((r) => { delete r._value; });
        return list;
    }

    /* ---------- 名次與獎牌 ---------- */
    function medalFor(rank) {
        if (rank === 1) return '🥇';
        if (rank === 2) return '🥈';
        if (rank === 3) return '🥉';
        return '';
    }

    function formatRank(rank) {
        const n = Number(rank);
        if (!Number.isFinite(n) || n <= 0) return '—';
        return `第 ${n} 名`;
    }

    /* 成績那一行的完整顯示（名次＋成績或狀態） */
    function resultLine(row) {
        const r = row || {};
        const rank = formatRank(r.rank);
        const value = displayScoreOrStatus(r);
        if (rank === '—') return value;
        return `${rank} · ${value}`;
    }

    /* 顯示排序：能排名的先、名次前面；沒名次的按狀態與帳號排（穩定輸出） */
    const STATUS_ORDER = { finished: 0, dnf: 1, dns: 2, dsq: 3, other: 4 };
    function compareResults(a, b) {
        const ra = a || {};
        const rb = b || {};
        const va = Number.isFinite(Number(ra.rank)) && Number(ra.rank) > 0 ? Number(ra.rank) : Infinity;
        const vb = Number.isFinite(Number(rb.rank)) && Number(rb.rank) > 0 ? Number(rb.rank) : Infinity;
        if (va !== vb) return va - vb;
        const sa = STATUS_ORDER[normalizeStatus(ra.status)] || 0;
        const sb = STATUS_ORDER[normalizeStatus(rb.status)] || 0;
        if (sa !== sb) return sa - sb;
        const na = String(ra.display_name || ra.username || '');
        const nb = String(rb.display_name || rb.username || '');
        if (na !== nb) return na.localeCompare(nb);
        return Number(ra.id || 0) - Number(rb.id || 0);
    }

    function sortResults(rows) {
        return (Array.isArray(rows) ? rows : []).slice().sort(compareResults);
    }

    /* ---------- 統計摘要 ---------- */
    function summarize(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const byStatus = {};
        RESULT_STATUSES.forEach((s) => { byStatus[s.id] = 0; });
        let ranked = 0;
        list.forEach((r) => {
            byStatus[normalizeStatus(r.status)] += 1;
            if (Number.isFinite(Number(r.rank)) && Number(r.rank) > 0) ranked += 1;
        });
        const podium = sortResults(list.filter((r) => Number.isFinite(Number(r.rank)) && Number(r.rank) > 0))
            .slice(0, 3)
            .map((r) => ({
                rank: Number(r.rank),
                medal: medalFor(Number(r.rank)),
                name: r.display_name || r.username || '（未具名）',
                score: displayScoreOrStatus(r)
            }));
        const finished = byStatus.finished || 0;
        return {
            total: list.length,
            finished,
            ranked,
            unranked: list.length - ranked,
            by_status: byStatus,
            // 完賽率＝完賽人數／已登錄成績人數（沒有成績時不假裝 100%）
            finish_rate: list.length ? Math.round((finished / list.length) * 100) : 0,
            podium
        };
    }

    /* ---------- 公布前檢查 ----------
     * approved：已核准的報名陣列（{id,user_id,username}）
     * results：目前登錄的成績陣列
     * 回傳提示清單：缺成績的人、重複名次、名次跳號——都只是提示，不擋公布。
     */
    function publishChecklist(approved, results) {
        const regs = Array.isArray(approved) ? approved : [];
        const rows = Array.isArray(results) ? results : [];
        const recordedRegIds = new Set(rows.map((r) => Number(r.registration_id)).filter((v) => Number.isFinite(v) && v > 0));

        const missing = regs
            .filter((reg) => !recordedRegIds.has(Number(reg.id)))
            .map((reg) => ({ registration_id: reg.id, username: reg.username, display_name: reg.display_name || reg.username }));

        const counts = {};
        rows.forEach((r) => {
            const rank = Number(r.rank);
            if (!Number.isFinite(rank) || rank <= 0) return;
            counts[rank] = (counts[rank] || 0) + 1;
        });
        const duplicateRanks = Object.keys(counts)
            .filter((k) => counts[k] > 1)
            .map((k) => ({ rank: Number(k), count: counts[k] }));

        const ranks = Object.keys(counts).map(Number).sort((a, b) => a - b);
        const gaps = [];
        ranks.forEach((rank, i) => {
            // 並列名次之後跳號是正常的（1,1,3），只有在「上一個名次沒並列」時才算跳號
            if (i === 0) return;
            const prev = ranks[i - 1];
            const prevCount = counts[prev];
            if (rank !== prev + 1 && prevCount === 1) gaps.push(rank);
        });

        const unranked = rows.filter((r) => !Number.isFinite(Number(r.rank)) || Number(r.rank) <= 0).length;

        return {
            approved: regs.length,
            recorded: rows.length,
            missing,
            missing_count: missing.length,
            duplicate_ranks: duplicateRanks,
            rank_gaps: gaps,
            unranked,
            ready: regs.length > 0 && missing.length === 0
        };
    }

    /* ---------- 輸入驗證（後端與前端都先問這個）----------
     * 回 { error } 或 { value }：不偷偷修正使用者送來的東西，有問題就明講。
     */
    function normalizeResultInput(raw) {
        const input = raw || {};
        const regId = Number(input.registration_id);
        if (!Number.isInteger(regId) || regId <= 0) {
            return { error: '缺少報名紀錄（registration_id 必須是正整數）' };
        }

        let rank = null;
        if (input.rank !== null && input.rank !== undefined && String(input.rank).trim() !== '') {
            const n = Number(input.rank);
            if (!Number.isInteger(n) || n <= 0) return { error: `名次必須是正整數（收到「${input.rank}」）` };
            rank = n;
        }

        const status = normalizeStatus(input.status);

        let note = null;
        if (input.note !== null && input.note !== undefined) {
            const s = String(input.note).replace(/\s+/g, ' ').trim();
            if (s.length > NOTE_MAX) return { error: `備註最多 ${NOTE_MAX} 字（目前 ${s.length} 字）` };
            note = s || null;
        }

        let displayName = null;
        if (input.display_name !== null && input.display_name !== undefined) {
            const s = String(input.display_name).replace(/\s+/g, ' ').trim();
            displayName = s.slice(0, 120) || null;
        }

        return {
            value: {
                registration_id: regId,
                user_id: Number.isInteger(Number(input.user_id)) && Number(input.user_id) > 0 ? Number(input.user_id) : null,
                username: input.username ? String(input.username).slice(0, 120) : null,
                display_name: displayName,
                status,
                score_text: normalizeScoreText(input.score_text),
                rank,
                note
            }
        };
    }

    /* 公布摘要文字的整理（null＝沒有摘要） */
    function normalizeSummary(text) {
        if (text === null || text === undefined) return null;
        const s = String(text).replace(/\s+/g, ' ').trim();
        if (!s) return null;
        return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s;
    }

    /* CSV 的列（給 CMCSV 用；欄位順序固定，方便對照與列印） */
    const CSV_HEADER = ['名次', '成績', '狀態', '姓名', '備註'];
    function csvRows(rows) {
        const list = sortResults(rows);
        return [CSV_HEADER].concat(list.map((r) => [
            Number.isFinite(Number(r.rank)) && Number(r.rank) > 0 ? Number(r.rank) : '',
            normalizeScoreText(r.score_text) || '',
            statusLabel(r.status),
            r.display_name || r.username || '',
            normalizeScoreText(r.note) || ''
        ]));
    }

    return {
        RESULT_STATUSES, DEFAULT_STATUS, RANKED_STATUS,
        SCORE_MAX, NOTE_MAX, SUMMARY_MAX,
        isValidStatus, normalizeStatus, statusLabel,
        normalizeScoreText, displayScore, displayScoreOrStatus,
        parseScoreValue, isRankable, autoRank,
        medalFor, formatRank, resultLine, compareResults, sortResults,
        summarize, publishChecklist, normalizeResultInput, normalizeSummary, csvRows
    };
}));
