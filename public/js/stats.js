/* 營運統計規則（v3.0.0）— 前後端共用的唯一真實來源（UMD）
 *
 * 為什麼要有這個模組：儀表板上的每個數字都必須只有一種算法。
 * 後端算「近 14 天報名趨勢」、前端畫圖、測試驗證，如果各寫一份，
 * 遲早會出現「畫面上的圖跟 API 的數字對不起來」。所以：
 *   - 伺服器用這裡的函式產生統計（trendByDay／countBy／topN…）
 *   - 前端用這裡的函式把統計轉成圖形座標（barGeometry／linePath）
 *   - 測試直接驗這一組純函式
 *
 * 圖表刻意不用任何前端套件（CSP 是 script-src 'self'，也不裝套件）：
 * 這裡只算幾何（x/y/寬/高/路徑），實際繪製是手寫 SVG。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;      // Node（server.js／測試）
    else root.CMStats = api;                                                      // 瀏覽器
}(typeof self !== 'undefined' ? self : this, function () {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function toNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    /* 把任何時間值轉成 YYYY-MM-DD（以本地時區為準，因為使用者看到的是本地日期）
       無法解析就回 null，呼叫端自己決定要不要算進去（不要靜默算成 1970 年）。 */
    function dayKey(value) {
        if (value === null || value === undefined || value === '') return null;
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return null;
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }

    /* 最近 n 天（含今天），由舊到新 */
    function lastNDays(n, now) {
        const base = now ? new Date(now) : new Date();
        const count = Math.max(1, Math.trunc(toNumber(n) || 1));
        const days = [];
        for (let i = count - 1; i >= 0; i -= 1) {
            days.push(dayKey(new Date(base.getTime() - i * DAY_MS)));
        }
        return days;
    }

    /* 依 keyFn 分組計數 → { key: count } */
    function countBy(list, keyFn) {
        const out = {};
        (Array.isArray(list) ? list : []).forEach((item) => {
            const key = keyFn(item);
            if (key === null || key === undefined) return;
            out[key] = (out[key] || 0) + 1;
        });
        return out;
    }

    /* 每日趨勢：一定回傳正好 n 天（沒有資料的日子補 0），圖表才不會忽寬忽窄 */
    function trendByDay(rows, options) {
        const opts = options || {};
        const days = lastNDays(opts.days || 14, opts.now);
        const field = opts.dateField || 'created_at';
        const counts = countBy(rows, (r) => dayKey(r && r[field]));
        return days.map((date) => ({ date, count: counts[date] || 0 }));
    }

    /* 取前 n 名（次數多的在前；同分依名稱排序，結果才穩定可測） */
    function topN(counts, n) {
        const limit = Math.max(1, Math.trunc(toNumber(n) || 1));
        const source = counts && typeof counts === 'object' ? counts : {};
        return Object.keys(source)
            .map((key) => ({ key, count: toNumber(source[key]) }))
            .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .slice(0, limit);
    }

    function sum(list, fn) {
        return (Array.isArray(list) ? list : []).reduce((acc, item) => acc + toNumber(fn ? fn(item) : item), 0);
    }

    /* 百分比：0 除以 0 是 0%（不是 NaN，也不要顯示 Infinity） */
    function percent(part, total) {
        const t = toNumber(total);
        if (t <= 0) return 0;
        return Math.round((toNumber(part) / t) * 100);
    }

    /* 成功率／失敗率的顏色傾向（前端只認得這三種 tone，顏色定義在 CSS） */
    function rateTone(rate) {
        const r = toNumber(rate);
        if (r >= 95) return 'good';
        if (r >= 80) return 'warn';
        return 'bad';
    }

    /* 長條圖幾何：把數值換成 SVG 的 x/y/寬/高（y 從上緣算，所以是「高 - 比例」）
       沒有任何資料或全部是 0 時回傳等高的空條，圖表不會爆掉。 */
    function barGeometry(values, options) {
        const opts = options || {};
        const list = (Array.isArray(values) ? values : []).map(toNumber);
        const width = Math.max(20, toNumber(opts.width) || 320);
        const height = Math.max(20, toNumber(opts.height) || 120);
        const gap = Math.max(0, toNumber(opts.gap) === 0 ? 0 : (opts.gap === undefined ? 4 : toNumber(opts.gap)));
        const n = list.length;
        if (!n) return [];
        const slot = (width - gap * (n - 1)) / n;
        const barWidth = Math.max(1, Math.floor(slot));
        const max = Math.max(0, ...list);
        return list.map((value, i) => {
            const ratio = max > 0 ? value / max : 0;
            const barHeight = Math.round(ratio * height);
            return {
                x: Math.round(i * (barWidth + gap)),
                y: height - barHeight,
                width: barWidth,
                height: barHeight,
                value,
                ratio: Math.round(ratio * 100)
            };
        });
    }

    /* 折線圖路徑：'M x,y L x,y …'（單點時畫成水平短線，避免只有一個點看不到） */
    function linePath(values, options) {
        const opts = options || {};
        const list = (Array.isArray(values) ? values : []).map(toNumber);
        const width = Math.max(20, toNumber(opts.width) || 320);
        const height = Math.max(20, toNumber(opts.height) || 120);
        const n = list.length;
        if (!n) return '';
        const max = Math.max(0, ...list);
        const step = n > 1 ? width / (n - 1) : width;
        const pointAt = (value, i) => {
            const ratio = max > 0 ? value / max : 0;
            const x = Math.round(i * step);
            const y = Math.round(height - ratio * height);
            return `${x},${y}`;
        };
        if (n === 1) {
            // 只有一個資料點時畫成靠左的短水平線（單點看不出趨勢，但至少要看得到）
            const only = linePoints(list, opts)[0];
            return `M 0,${only.y} L ${Math.max(only.x, 1)},${only.y}`;
        }
        return list.map((value, i) => `${i === 0 ? 'M' : 'L'} ${pointAt(value, i)}`).join(' ');
    }

    /* 折線圖的資料點座標（畫圓點用） */
    function linePoints(values, options) {
        const opts = options || {};
        const list = (Array.isArray(values) ? values : []).map(toNumber);
        const width = Math.max(20, toNumber(opts.width) || 320);
        const height = Math.max(20, toNumber(opts.height) || 120);
        const n = list.length;
        if (!n) return [];
        const max = Math.max(0, ...list);
        const step = n > 1 ? width / (n - 1) : width;
        return list.map((value, i) => {
            const ratio = max > 0 ? value / max : 0;
            return { x: Math.round(i * step), y: Math.round(height - ratio * height), value };
        });
    }

    /* 檔案大小（海報縮圖那一段要用） */
    function formatBytes(bytes) {
        const b = Math.max(0, toNumber(bytes));
        if (b < 1024) return `${Math.round(b)} B`;
        if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
        return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
    }

    return {
        DAY_MS, dayKey, lastNDays, countBy, trendByDay, topN, sum, percent, rateTone,
        barGeometry, linePath, linePoints, formatBytes
    };
}));
