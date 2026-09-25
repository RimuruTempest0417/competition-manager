/* ============================================================
   CSV 工具模組 (v2.8.0)
   - 同時供瀏覽器與 Node 使用（UMD）：前端負責解析上傳的檔案與預覽，
     後端負責匯出與匯入時的權威驗證，兩邊共用同一份規則。
   - 手寫 RFC4180 解析器（支援引號內逗號/換行、"" 跳脫、CRLF、BOM），
     不引入外部套件（CSP 為 script-src 'self'，也不新增依賴）。
   - 分隔符自動偵測：逗號 / 分號 / Tab（從 Excel 直接複製常見為 Tab）。
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CMCSV = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DELIMITERS = [',', ';', '\t'];

    // 匯入/匯出的標準欄位。alias 同時接受中文與英文表頭（大小寫、空白皆容錯）
    const FIELDS = [
        { key: 'name', label: '名稱', aliases: ['name', '比賽名稱', '賽事名稱', '名稱'] },
        { key: 'category', label: '分類', aliases: ['category', '分類', '賽事分類'] },
        { key: 'tags', label: '標籤', aliases: ['tags', '標籤', 'tag'] },
        { key: 'location', label: '地點', aliases: ['location', '地點', '比賽地點'] },
        { key: 'date', label: '開始日期', aliases: ['date', 'start_date', '開始日期', '日期'] },
        { key: 'time', label: '開始時間', aliases: ['time', 'start_time', '開始時間', '時間'] },
        { key: 'end_date', label: '結束日期', aliases: ['end_date', '結束日期'] },
        { key: 'end_time', label: '結束時間', aliases: ['end_time', '結束時間'] },
        { key: 'is_registration_open', label: '開放報名', aliases: ['is_registration_open', '開放報名', '報名中', '報名狀態'] },
        { key: 'description', label: '簡介', aliases: ['description', '簡介', '備註', '說明'] }
    ];

    const MAX_IMPORT_ROWS = 500;

    function stripBom(text) {
        return String(text || '').replace(/^\uFEFF/, '');
    }

    function detectDelimiter(text) {
        const firstLine = text.split(/\r?\n/)[0] || '';
        let best = ',', bestCount = -1;
        for (const d of DELIMITERS) {
            let count = 0, inQuotes = false;
            for (let i = 0; i < firstLine.length; i++) {
                const ch = firstLine[i];
                if (ch === '"') inQuotes = !inQuotes;
                else if (ch === d && !inQuotes) count++;
            }
            if (count > bestCount) { best = d; bestCount = count; }
        }
        return best;
    }

    // RFC4180 解析：回傳二維陣列（不含表頭處理）
    function parse(text, options) {
        const opts = options || {};
        const clean = stripBom(text);
        const delimiter = opts.delimiter || detectDelimiter(clean);
        const rows = [];

        let row = [];
        let field = '';
        let inQuotes = false;
        let hasContent = false;

        for (let i = 0; i < clean.length; i++) {
            const ch = clean[i];

            if (inQuotes) {
                if (ch === '"') {
                    if (clean[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else {
                    field += ch;
                }
                continue;
            }

            if (ch === '"') { inQuotes = true; hasContent = true; continue; }

            if (ch === delimiter) {
                row.push(field);
                field = '';
                hasContent = true;
                continue;
            }

            if (ch === '\r') {
                if (clean[i + 1] === '\n') i++;
                row.push(field);
                rows.push(row);
                row = []; field = ''; hasContent = false;
                continue;
            }

            if (ch === '\n') {
                row.push(field);
                rows.push(row);
                row = []; field = ''; hasContent = false;
                continue;
            }

            field += ch;
            hasContent = true;
        }

        // 最後一列（沒有結尾換行時）
        if (hasContent || field !== '' || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        const cleaned = rows.filter((r) => r.length > 1 || (r[0] !== undefined && String(r[0]).trim() !== ''));
        return { rows: cleaned, delimiter };
    }

    // v2.12.0 安全性：避免 CSV 公式注入（試算表會把 =、+、-、@ 開頭的內容當成公式執行）
    // 純負數（-12、-3.5）維持原樣，其餘一律加上單引號，讓試算表視為文字。
    const FORMULA_RISK = /^[=+@\t\r]/;
    const PURE_NEGATIVE_NUMBER = /^-\d+(\.\d+)?$/;

    function sanitizeCell(raw) {
        const s = raw === undefined || raw === null ? '' : String(raw);
        if (!s) return s;
        if (PURE_NEGATIVE_NUMBER.test(s)) return s;
        if (FORMULA_RISK.test(s) || s.startsWith('-')) return "'" + s;
        return s;
    }

    function escapeCell(value) {
        const s = sanitizeCell(value);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    /* v2.22.0：物件列（例如 {姓名:'王小明', 隊伍:'A 隊'}）自動轉成「表頭 + 資料列」。
       以前只認陣列，傳物件進去會**安靜地**產生一整份空行的 CSV——檔案下載成功、打開卻是空的，
       很難發現（報名名單匯出就是這樣壞掉的）。欄位順序依物件自己的鍵順序，缺的欄位留空。 */
    function objectRowsToArrays(list) {
        const headers = [];
        list.forEach((r) => Object.keys(r || {}).forEach((k) => { if (!headers.includes(k)) headers.push(k); }));
        return [headers].concat(list.map((r) => headers.map((k) => {
            const v = r ? r[k] : undefined;
            return v === undefined || v === null ? '' : v;
        })));
    }

    function stringify(rows, options) {
        const opts = options || {};
        const list = rows || [];
        const useHeaders = list.length > 0 && !Array.isArray(list[0]) && typeof list[0] === 'object';
        const body = (useHeaders ? objectRowsToArrays(list) : list)
            .map((r) => (Array.isArray(r) ? r : []).map(escapeCell).join(','))
            .join('\r\n');
        return (opts.bom ? '\uFEFF' : '') + body + (opts.trailingNewline === false ? '' : '\r\n');
    }

    // 表頭比對：忽略大小寫、空白與底線（Excel 常見的 "End Date" 與 "end_date" 都應對得上）
    function normalizeHeaderKey(raw) {
        return String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase().replace(/[\s_]+/g, '');
    }

    function buildHeaderMap(headerRow) {
        const aliasToKey = {};
        FIELDS.forEach((f) => {
            f.aliases.forEach((a) => { aliasToKey[normalizeHeaderKey(a)] = f.key; });
            aliasToKey[normalizeHeaderKey(f.label)] = f.key;
        });

        const map = {};
        (headerRow || []).forEach((cell, index) => {
            const key = aliasToKey[normalizeHeaderKey(cell)];
            if (key && map[key] === undefined) map[key] = index;
        });
        return map;
    }

    // 解析後的二維陣列 + 表頭對應 → 物件陣列
    function recordsFromParsed(parsed) {
        const rows = (parsed && parsed.rows) || [];
        if (rows.length === 0) return { headerMap: {}, records: [] };

        const headerMap = buildHeaderMap(rows[0]);
        const records = rows.slice(1).map((r) => {
            const rec = {};
            Object.keys(headerMap).forEach((key) => {
                const idx = headerMap[key];
                rec[key] = r[idx] === undefined ? '' : String(r[idx]).trim();
            });
            return rec;
        });
        return { headerMap, records };
    }

    function normalizeDate(value) {
        const s = String(value === undefined || value === null ? '' : value).trim();
        if (!s) return null;

        // 2026年9月25日 / 2026-09-25 / 2026/9/25 / 2026.9.25
        const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
        if (!m) return { error: `日期格式無法辨識：${s}（請用 2026-09-25 或 2026/9/25）` };

        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return { error: `日期不存在：${s}` };

        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
            return { error: `日期不存在：${s}` };
        }
        return {
            value: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        };
    }

    function normalizeTime(value) {
        const s = String(value === undefined || value === null ? '' : value).trim();
        if (!s) return null;

        // 9:00 / 09:00 / 09:00:00 / 9時0分 / 9：00（全形冒號）
        const m = s.replace(/：/g, ':').match(/^(\d{1,2})\s*[:時]\s*(\d{1,2})/);
        if (!m) return { error: `時間格式無法辨識：${s}（請用 09:00）` };

        const h = Number(m[1]), mi = Number(m[2]);
        if (h > 23 || mi > 59) return { error: `時間不存在：${s}` };
        return { value: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
    }

    function splitTags(value, options) {
        const opts = options || {};
        const maxTags = opts.maxTags || 10;
        const maxLen = opts.maxTagLength || 24;
        const source = Array.isArray(value) ? value : String(value === undefined || value === null ? '' : value).split(/[,，、;；\n\t|/]+/);

        const seen = new Set();
        const out = [];
        for (const raw of source) {
            const t = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^#+/, '').slice(0, maxLen);
            if (!t) continue;
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            if (out.length < maxTags) out.push(t);
        }
        return out;
    }

    const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'v', '是', '有', '開放', '報名中', '✓', '✔', 'o']);
    const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', 'x', '否', '無', '不開放', '已截止', '-', '']);

    /* 單筆資料驗證與正規化。
       meta: { categories: [{id,label,...}], maxTags, maxTagLength }
       回傳 { ok, value, errors: [], warnings: [] } */
    // meta 可傳 { categories, maxTags, maxTagLength }，也可直接傳分類陣列
    // （後端 server.js 與前端呼叫方式不同，兩種都支援以免漏帶分類而靜默失效）
    function metaOf(meta) {
        if (Array.isArray(meta)) return { categories: meta };
        return meta || {};
    }

    function normalizeRecord(record, meta) {
        const m = metaOf(meta);
        const categories = m.categories || [];
        const errors = [];
        const warnings = [];
        const rec = record || {};

        const name = String(rec.name === undefined || rec.name === null ? '' : rec.name).trim();
        if (!name) errors.push('缺少比賽名稱');

        // 分類：接受 id 或中文標籤；無法辨識時只警告，該筆仍會以「未分類」匯入
        let category = null;
        const rawCategory = String(rec.category === undefined || rec.category === null ? '' : rec.category).trim();
        if (rawCategory) {
            const hit = categories.find((c) => c.id === rawCategory) ||
                categories.find((c) => c.label === rawCategory) ||
                categories.find((c) => c.label.replace(/\s/g, '') === rawCategory.replace(/\s/g, '')) ||
                categories.find((c) => String(c.emoji || '').trim() && rawCategory.includes(c.label));
            if (hit) category = hit.id;
            else warnings.push(`無法辨識的分類「${rawCategory}」，將以未分類匯入`);
        }

        const dateRes = normalizeDate(rec.date);
        if (dateRes && dateRes.error) errors.push(dateRes.error);

        const timeRes = normalizeTime(rec.time);
        if (timeRes && timeRes.error) errors.push(timeRes.error);

        const endDateRes = normalizeDate(rec.end_date);
        if (endDateRes && endDateRes.error) errors.push(endDateRes.error);

        const endTimeRes = normalizeTime(rec.end_time);
        if (endTimeRes && endTimeRes.error) errors.push(endTimeRes.error);

        let isOpen = false;
        const rawOpen = String(rec.is_registration_open === undefined || rec.is_registration_open === null ? '' : rec.is_registration_open).trim().toLowerCase();
        if (rawOpen) {
            if (TRUE_WORDS.has(rawOpen)) isOpen = true;
            else if (FALSE_WORDS.has(rawOpen)) isOpen = false;
            else warnings.push(`無法辨識的報名狀態「${rec.is_registration_open}」，將視為已截止`);
        }

        const value = {
            name: name.slice(0, 200),
            category,
            tags: splitTags(rec.tags, { maxTags: m.maxTags, maxTagLength: m.maxTagLength }),
            location: String(rec.location || '').trim().slice(0, 200) || null,
            date: dateRes && dateRes.value ? dateRes.value : null,
            time: timeRes && timeRes.value ? timeRes.value : null,
            end_date: endDateRes && endDateRes.value ? endDateRes.value : null,
            end_time: endTimeRes && endTimeRes.value ? endTimeRes.value : null,
            description: String(rec.description || '').trim().slice(0, 2000) || null,
            is_registration_open: isOpen
        };

        return { ok: errors.length === 0, value, errors, warnings };
    }

    function toExportRows(competitions, meta) {
        const categories = metaOf(meta).categories || [];
        const header = FIELDS.map((f) => f.label);
        const rows = [header];

        (competitions || []).forEach((c) => {
            const cat = categories.find((x) => x.id === c.category);
            rows.push([
                c.name || '',
                cat ? cat.label : '',
                Array.isArray(c.tags) ? c.tags.join(', ') : '',
                c.location || '',
                c.date || '',
                c.time || '',
                c.end_date || '',
                c.end_time || '',
                c.is_registration_open ? '是' : '否',
                c.description || ''
            ]);
        });

        return { header, rows };
    }

    // 空白範本（含表頭與一列示範）
    function templateRows(meta) {
        const header = FIELDS.map((f) => f.label);
        const example = ['2026 全國羽球公開賽', '球拍運動', '國中組, 團體賽', '台北體育館', '2026-09-25', '09:00', '2026-09-25', '17:00', '是', '報名請洽主辦單位'];
        return { header, rows: [header, example] };
    }

    return {
        FIELDS,
        MAX_IMPORT_ROWS,
        parse,
        stringify,
        recordsFromParsed,
        normalizeRecord,
        normalizeDate,
        normalizeTime,
        splitTags,
        toExportRows,
        templateRows,
        detectDelimiter
    };
});
