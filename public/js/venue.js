/* v2.27.0：場地的地圖連結規則（UMD，前後端共用）
 *
 * 唯一真實來源：後端驗證與前端顯示都走這一份，避免「畫面給了連結、後端存不進去」
 * 或「後端存了、畫面卻打不開」。
 *
 * 規則（刻意保守）：
 *   ① 沒填自訂連結 → 用地址自動產生 Google 地圖搜尋連結（舊資料不用補就有地圖可按）。
 *   ② 自訂連結只接受 http/https；`javascript:`、`data:` 這類一律視為無效（不可以讓使用者
 *      貼進來的字串變成可執行的東西）。
 *   ③ 貼成 `www.google.com/...` 或 `maps.app.goo.gl/...`（沒帶協定、但看起來是網域）
 *      會自動補上 https://（使用者最常這樣貼）。
 *   ④ 其他內容（例如把地址整串貼進地圖欄位）視為無效並回報，不要靜默丟掉——
 *      地址請填在地點欄位，地圖會自動產生。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMVenue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAP_SEARCH_PREFIX = 'https://www.google.com/maps/search/?api=1&query=';
    const MAX_URL_LENGTH = 500;
    // 看起來像網域：至少一段「字元.英數結尾」，且不含空白（地址通常有空白或沒有網域結尾）
    const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i;

    function trim(value) {
        return String(value == null ? '' : value).trim();
    }

    /* 自訂地圖連結是否可用（回傳正規化後的字串，或 '' 表示無效） */
    function normalizeMapUrl(value) {
        const raw = trim(value);
        if (!raw) return '';
        if (raw.length > MAX_URL_LENGTH) return '';
        let candidate = raw;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
            // 沒有協定：只有看起來像網域才補 https://（避免把地址誤判成網址）
            if (!DOMAIN_LIKE.test(candidate) || /\s/.test(candidate)) return '';
            candidate = 'https://' + candidate;
        }
        if (!/^https?:\/\//i.test(candidate)) return '';   // javascript: / data: / mailto: … 一律不接受
        let url;
        try {
            url = new URL(candidate);
        } catch (err) {
            return '';
        }
        if (!url.hostname || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return '';
        return url.toString();
    }

    /* 用地址產生 Google 地圖搜尋連結（地址空白或太長就回 ''） */
    function autoMapUrl(location) {
        const text = trim(location);
        if (!text || text.length > 200) return '';
        return MAP_SEARCH_PREFIX + encodeURIComponent(text);
    }

    /* 這場賽事要用的地圖連結：自訂優先，沒有才用地址自動產生 */
    function mapUrlFor(competition) {
        const comp = competition || {};
        const custom = normalizeMapUrl(comp.map_url);
        if (custom) return custom;
        return autoMapUrl(comp.location);
    }

    /* 是不是用地址自動產生的（前端可以顯示「用地址搜尋」的提示） */
    function isAutoMapUrl(competition) {
        const comp = competition || {};
        return !normalizeMapUrl(comp.map_url) && !!autoMapUrl(comp.location);
    }

    function hasMap(competition) {
        return !!mapUrlFor(competition);
    }

    return {
        MAP_SEARCH_PREFIX,
        MAX_URL_LENGTH,
        normalizeMapUrl,
        autoMapUrl,
        mapUrlFor,
        isAutoMapUrl,
        hasMap
    };
}));
