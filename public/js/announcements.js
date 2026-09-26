/* 站內公告／訊息中心（v2.26.0）—— UMD，前後端共用同一份規則
 *
 * 為什麼要共用：公告「誰看得到」如果前後端各寫一套，遲早出現「列表看得到、點進去說無權」
 * 或「管理員以為發給路跑組、結果所有人都收到」。這個檔案是**唯一真實來源**：
 *   - 後端 `require('./public/js/announcements')`（server.js；列表、未讀數、發布前驗證）
 *   - 前端 `<script src="/js/announcements.js">`（訊息中心顯示與即時預覽）
 *
 * 設計原則：
 *   1. **可見性不存資料庫**：公告只存「對象」與「時間」，每次讀取用當下時間推導，
 *      所以預約發布／到期自動下架都不需要排程（同 competition-state.js 的作法）。
 *   2. 全部是純函式 → 傳入 `now` 就能在單元測試裡驗任何邊界（預約時間那一秒、到期那一刻）。
 *
 * 對象（audience）：
 *   all       所有登入使用者（含管理員）
 *   admin     管理員以上（admin / super_admin / web_owner）
 *   category  有訂閱公告分類的使用者（與公告的 categories 有交集即可見）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMAnnouncements = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const AUDIENCES = [
        { id: 'all', label: '所有使用者', hint: '所有登入的人都看得到' },
        { id: 'admin', label: '管理員以上', hint: '只有管理員、超級管理員與網站擁有者看得到' },
        { id: 'category', label: '特定分類訂閱者', hint: '只在「我的訂閱分類」勾了其中任一個分類的人看得到' }
    ];
    const AUDIENCE_IDS = AUDIENCES.map((a) => a.id);

    const TITLE_MAX = 80;
    const BODY_MAX = 2000;

    const audienceLabel = (audience) => {
        const found = AUDIENCES.find((a) => a.id === audience);
        return found ? found.label : String(audience || '');
    };

    const toTime = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
        return Number.isFinite(ms) ? ms : null;
    };

    /* 這則公告「現在」是否上架中？（不管對象）
       規則：未下架 → 已到發布時間 → 還沒過期 */
    function isLive(announcement, nowMs) {
        const ann = announcement || {};
        if (ann.is_active === false) return false;
        const now = nowMs === undefined ? Date.now() : Number(nowMs);
        const publish = toTime(ann.publish_at) || toTime(ann.created_at);
        if (publish !== null && publish > now) return false;
        const expires = toTime(ann.expires_at);
        if (expires !== null && expires <= now) return false;
        return true;
    }

    /* 通知對象比對（嚴格）：viewer = { isAdmin, categories }（categories 是「我訂閱的分類」）
       推播就是照這個名單送，所以這裡不看 isAdmin 的特權——管理員沒訂閱該分類就不會收到通知。
       （訊息中心的可見性另外處理，見 isVisibleTo：管理員看得到全部上架中的公告。） */
    function matchesAudience(announcement, viewer) {
        const ann = announcement || {};
        const who = viewer || {};
        const audience = AUDIENCE_IDS.includes(ann.audience) ? ann.audience : 'all';
        if (audience === 'all') return true;
        if (audience === 'admin') return who.isAdmin === true;
        const wanted = Array.isArray(ann.categories) ? ann.categories.filter(Boolean) : [];
        if (!wanted.length) return false;   // 分類公告沒指定分類 → 誰都看不到（發布時已擋，這裡是防呆）
        const mine = Array.isArray(who.categories) ? who.categories.filter(Boolean) : [];
        return wanted.some((c) => mine.includes(c));
    }

    /* 訊息中心的可見性：上架中 +（管理員一律看得到 / 對象符合）
       為什麼管理員要全看得到：管理員剛發布的分類公告如果自己看不到，會以為發布失敗
       （推播對象仍走 matchesAudience，兩件事分開才不會誤送給沒訂閱的管理員）。 */
    function isVisibleTo(announcement, viewer, nowMs) {
        if (!isLive(announcement, nowMs)) return false;
        if (viewer && viewer.isAdmin === true) return true;
        return matchesAudience(announcement, viewer);
    }

    function visibleFor(list, viewer, nowMs) {
        return (Array.isArray(list) ? list : []).filter((a) => isVisibleTo(a, viewer, nowMs));
    }

    /* 顯示排序：置頂在前，其次依發布時間（新的在上面） */
    function sortForDisplay(list) {
        return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
            const pin = (b && b.is_pinned ? 1 : 0) - (a && a.is_pinned ? 1 : 0);
            if (pin !== 0) return pin;
            const ta = toTime(a && (a.publish_at || a.created_at)) || 0;
            const tb = toTime(b && (b.publish_at || b.created_at)) || 0;
            if (tb !== ta) return tb - ta;
            return Number((b && b.id) || 0) - Number((a && a.id) || 0);
        });
    }

    /* 未讀數：reads 可以是 id 陣列、{id:true} 物件、或 Set */
    function readSet(reads) {
        if (!reads) return new Set();
        if (typeof reads.has === 'function') return reads;
        if (Array.isArray(reads)) return new Set(reads.map(String));
        if (typeof reads === 'object') {
            return new Set(Object.keys(reads).filter((k) => reads[k]).map(String));
        }
        return new Set();
    }

    function isRead(announcement, reads) {
        const id = announcement && announcement.id;
        if (id === null || id === undefined) return false;
        return readSet(reads).has(String(id));
    }

    function unreadCount(list, reads) {
        return (Array.isArray(list) ? list : []).filter((a) => !isRead(a, reads)).length;
    }

    /* 後端在寫入前用它驗證（回 { value } 或 { error }）；前端用它做即時預覽 */
    function normalizeInput(input, validCategories, nowMs) {
        const raw = input || {};
        const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim();
        const body = String(raw.body === undefined || raw.body === null ? '' : raw.body).trim();
        if (!title) return { error: '公告標題不能空白' };
        if (title.length > TITLE_MAX) return { error: `公告標題最多 ${TITLE_MAX} 個字` };
        if (!body) return { error: '公告內容不能空白' };
        if (body.length > BODY_MAX) return { error: `公告內容最多 ${BODY_MAX} 個字` };

        // 沒帶對象 → 當成「所有使用者」（表單本來就會帶，這裡是讓 API 呼叫更寬容）；
        // 有帶但值不對 → 明確擋下來，不要偷偷改成 all
        const audienceRaw = (raw.audience === undefined || raw.audience === null || raw.audience === '')
            ? 'all' : raw.audience;
        const audience = AUDIENCE_IDS.includes(audienceRaw) ? audienceRaw : null;
        if (!audience) return { error: `公告對象只能是 ${AUDIENCE_IDS.join('／')}` };

        const allowed = Array.isArray(validCategories) ? validCategories.map(String) : null;
        let categories = Array.isArray(raw.categories) ? raw.categories.map(String).filter(Boolean) : [];
        if (allowed) categories = categories.filter((c) => allowed.includes(c));
        categories = Array.from(new Set(categories));
        if (audience === 'category') {
            if (!categories.length) return { error: '對象選「特定分類訂閱者」時，至少要選一個分類' };
        } else {
            categories = [];   // 非分類公告一律清空，避免留下看不懂的殘值
        }

        const now = nowMs === undefined ? Date.now() : Number(nowMs);
        const publishAt = toTime(raw.publish_at);
        if (raw.publish_at !== undefined && raw.publish_at !== null && raw.publish_at !== '' && publishAt === null) {
            return { error: '發布時間格式不對' };
        }
        const expiresAt = toTime(raw.expires_at);
        if (raw.expires_at !== undefined && raw.expires_at !== null && raw.expires_at !== '' && expiresAt === null) {
            return { error: '結束時間格式不對' };
        }
        if (publishAt !== null && expiresAt !== null && expiresAt <= publishAt) {
            return { error: '結束時間要晚於發布時間' };
        }

        return {
            value: {
                title, body, audience, categories,
                is_pinned: raw.is_pinned === true,
                is_active: raw.is_active === false ? false : true,
                notify_push: raw.notify_push === true,
                publish_at: publishAt === null ? new Date(now).toISOString() : new Date(publishAt).toISOString(),
                expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString()
            }
        };
    }

    return {
        AUDIENCES, AUDIENCE_IDS, TITLE_MAX, BODY_MAX,
        audienceLabel, isLive, matchesAudience, isVisibleTo, visibleFor,
        sortForDisplay, isRead, unreadCount, normalizeInput
    };
}));
