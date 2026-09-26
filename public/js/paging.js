/* 分頁規則（v3.0.0）— 前後端共用的唯一真實來源（UMD）
 *
 * 為什麼要有這個模組：分頁的「邊界行為」是最容易前後端不一致的地方——
 * 前端算的 has_more 跟後端不一樣、第一頁多一筆少一筆、壞參數讓 API 500。
 * 所以把規則集中成純函式，伺服器與瀏覽器都 require／讀同一份。
 *
 * 設計取捨（重要）：
 *   1. **分頁是 opt-in**：沒有帶 limit 的請求維持原本「一次回全部」的行為，
 *      既有前端與外部整合完全不受影響（伺服器端不做任何預設切片）。
 *   2. 參數不合法（負數、NaN、超大值）一律「退回安全的預設值」而不是報錯：
 *      列表端點回 400 會讓外部整合更難用，回合理的資料比較實際。
 *   3. 單次上限預設 100：上限存在＝避免有人一次要求 10 萬筆把資料庫打爆。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;      // Node（server.js／測試）
    else root.CMPaging = api;                                                     // 瀏覽器
}(typeof self !== 'undefined' ? self : this, function () {
    const DEFAULT_MAX = 100;

    /* 把任意輸入收斂成整數；不合法就回 fallback，並夾在 [min, max] 之間 */
    function clampInt(value, min, max, fallback) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const n = Number(String(value).trim());
        if (!Number.isFinite(n)) return fallback;
        const i = Math.trunc(n);
        if (i < min) return min;
        if (i > max) return max;
        return i;
    }

    /* request.query（或 URLSearchParams 轉出的物件）→ 分頁參數
     * 回傳 { paged, limit, offset, capped }
     *   paged  : 這次請求有沒有要求分頁（有沒有帶 limit）
     *   limit  : 要幾筆（paged=false 時為 null＝不切片）
     *   offset : 從第幾筆開始
     *   capped : 原本要求的 limit 被上限截掉了（畫面可以提示） */
    function parsePaging(query, options) {
        const opts = options || {};
        const max = clampInt(opts.max, 1, 10000, DEFAULT_MAX);
        const raw = query ? query.limit : undefined;
        const has = !(raw === undefined || raw === null || String(raw).trim() === '');
        if (!has) {
            return { paged: false, limit: null, offset: clampInt(query && query.offset, 0, Number.MAX_SAFE_INTEGER, 0), capped: false };
        }
        const wanted = clampInt(raw, 1, Number.MAX_SAFE_INTEGER, max);
        const limit = Math.min(wanted, max);
        const offset = clampInt(query && query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
        return { paged: true, limit, offset, capped: wanted > max };
    }

    /* 記憶體切片（給「必須先篩選才能分頁」的端點用，例如狀態是推導出來的） */
    function pageSlice(items, paging) {
        const list = Array.isArray(items) ? items : [];
        if (!paging || !paging.paged) return list.slice();
        const offset = paging.offset || 0;
        return list.slice(offset, offset + paging.limit);
    }

    /* 統一的分頁回應形狀。前端只要認 items／total／has_more 三個欄位。 */
    function pagedResponse(items, opts) {
        const list = Array.isArray(items) ? items : [];
        const offset = (opts && opts.offset) || 0;
        const limit = (opts && opts.limit) === undefined || (opts && opts.limit) === null ? null : opts.limit;
        const total = (opts && typeof opts.total === 'number') ? opts.total : list.length;
        return {
            items: list,
            total: total,
            limit: limit,
            offset: offset,
            has_more: offset + list.length < total,
            returned: list.length,
            // db   = 由資料庫切片（查詢成本與頁面大小成正比）
            // memory = 先在伺服器記憶體篩選後切片（例如狀態是推導出來的）
            paged_by: (opts && opts.pagedBy) || 'db'
        };
    }

    /* 給畫面用的「第 X–Y 筆，共 N 筆」 */
    function rangeLabel(paging, returned, total) {
        const offset = (paging && paging.offset) || 0;
        const shown = Math.max(0, returned || 0);
        if (!shown) return `共 ${total || 0} 筆`;
        return `第 ${offset + 1}–${offset + shown} 筆，共 ${total || 0} 筆`;
    }

    return { DEFAULT_MAX, clampInt, parsePaging, pageSlice, pagedResponse, rangeLabel };
}));
