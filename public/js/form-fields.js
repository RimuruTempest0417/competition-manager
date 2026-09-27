/* 報名表自訂欄位（v3.9.0）—— UMD，前後端共用同一份規則
 *
 * 為什麼要共用：主辦在後台定義欄位（必填／型別／選項），報名的人在前面填。
 * 如果前端只管畫、後端只管存，遲早出現「畫面說可以送出、後端卻拒絕」或更糟的
 * 「前端沒驗、後端也沒驗 → 什麼都存進去」。這個檔案是**唯一真實來源**：
 *   - 後端 require('../public/js/form-fields')（驗證送進來的答案）
 *   - 前端 <script src="/js/form-fields.js">（畫欄位、即時提示）
 *
 * 設計原則：
 *   1. 純函式：不碰 DOM、不碰網路 → 任何規則都能在單元測試裡驗。
 *   2. 一律**正規化再驗證**：多餘的欄位、超長的字、牛鬼蛇神的 key 全部先清掉。
 *   3. 沒設定的欄位（form_fields 為空）＝ 傳統報名表（姓名／備註），行為完全不變。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMFormFields = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date'];
    const TYPE_LABELS = {
        text: '單行文字', textarea: '多行文字', number: '數字',
        select: '下拉選單', checkbox: '勾選（是／否）', date: '日期'
    };
    const LIMITS = {
        maxFields: 10, maxOptions: 20,
        label: 40, optionText: 40, key: 24,
        text: 200, textarea: 500, number: 1000000
    };

    const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

    /* 由標籤產生穩定的 key（中文標籤也給得出 key）：f1、f2…，確保唯一 */
    function makeKey(label, used) {
        const base = clean(label, LIMITS.label).toLowerCase()
            .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, LIMITS.key);
        let key = /^[a-z][a-z0-9_]*$/.test(base) ? base : 'f';
        if (!/^[a-z]/.test(key)) key = 'f' + key;
        let candidate = key;
        let n = 2;
        while (used.indexOf(candidate) >= 0) { candidate = (key + '_' + n).slice(0, LIMITS.key); n += 1; }
        return candidate;
    }

    /* 把後台送來的欄位定義正規化成可以信任的版本（最多 10 個、key 唯一、選項去重） */
    function normalizeFields(raw) {
        const list = Array.isArray(raw) ? raw : [];
        const used = [];
        const out = [];
        for (const item of list) {
            if (out.length >= LIMITS.maxFields) break;
            if (!isPlainObject(item)) continue;
            const label = clean(item.label, LIMITS.label);
            if (!label) continue;                                   // 沒有標籤的欄位沒有意義
            const type = FIELD_TYPES.indexOf(String(item.type)) >= 0 ? String(item.type) : 'text';
            let key = String(item.key || '').toLowerCase();
            if (!/^[a-z][a-z0-9_]{0,23}$/.test(key) || used.indexOf(key) >= 0) key = makeKey(label, used);
            used.push(key);
            const field = { key, label, type, required: !!item.required };
            if (type === 'select') {
                const seen = [];
                (Array.isArray(item.options) ? item.options : []).forEach((opt) => {
                    const text = clean(opt, LIMITS.optionText);
                    if (!text || seen.indexOf(text) >= 0 || seen.length >= LIMITS.maxOptions) return;
                    seen.push(text);
                });
                field.options = seen;
                if (!seen.length) field.type = 'text';              // 下拉沒有選項 → 退化成文字，不要做一個沒得選的欄位
            }
            out.push(field);
        }
        return out;
    }

    function hasAnswers(value) {
        return isPlainObject(value) && Object.keys(value).length > 0;
    }

    /* 畫面用：這個瀏覽器／這個環境能不能用（純函式，測試用得到） */
    function fieldPlaceholder(field) {
        if (field.type === 'date') return '年/月/日';
        if (field.type === 'number') return '例如 18';
        if (field.type === 'textarea') return '請輸入' + field.label;
        return '請輸入' + field.label;
    }

    /* 驗證單一答案 → { ok:true, value } 或 { ok:false, error }
       空值（未填）不算錯誤，交給 required 判斷。 */
    function validateAnswer(field, raw) {
        const type = FIELD_TYPES.indexOf(field.type) >= 0 ? field.type : 'text';
        if (type === 'checkbox') {
            return { ok: true, value: !!(raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1') };
        }
        const text = clean(raw, type === 'textarea' ? LIMITS.textarea : LIMITS.text);
        if (!text) return { ok: true, value: '' };
        if (type === 'number') {
            const num = Number(text);
            if (!Number.isFinite(num) || Math.abs(num) > LIMITS.number) {
                return { ok: false, error: `${field.label}要填數字` };
            }
            return { ok: true, value: num };
        }
        if (type === 'date') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, error: `${field.label}要用日期格式（年-月-日）` };
            const parts = text.split('-').map(Number);
            const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
            if (dt.getUTCFullYear() !== parts[0] || dt.getUTCMonth() !== parts[1] - 1 || dt.getUTCDate() !== parts[2]) {
                return { ok: false, error: `${field.label}不是有效日期` };
            }
            return { ok: true, value: text };
        }
        if (type === 'select') {
            const options = Array.isArray(field.options) ? field.options : [];
            if (options.indexOf(text) < 0) return { ok: false, error: `${field.label}請從選項中挑一個` };
            return { ok: true, value: text };
        }
        return { ok: true, value: text };
    }

    /* 驗整份答案 → { ok, errors:{key:msg}, clean:{key:value} }
       ★clean 只包含「這張表真的有定義」的欄位（多送的一律丟掉）。 */
    function validateAnswers(fields, rawAnswers) {
        const list = normalizeFields(fields);
        const answers = isPlainObject(rawAnswers) ? rawAnswers : {};
        const errors = {};
        const result = {};
        list.forEach((field) => {
            const outcome = validateAnswer(field, answers[field.key]);
            if (!outcome.ok) {
                errors[field.key] = outcome.error;
                return;
            }
            const empty = outcome.value === '' || outcome.value === null;
            if (field.required && empty && field.type !== 'checkbox') {
                errors[field.key] = `請填寫${field.label}`;
                return;
            }
            if (field.required && field.type === 'checkbox' && outcome.value !== true) {
                errors[field.key] = `請勾選${field.label}`;
                return;
            }
            if (!empty || field.type === 'checkbox') result[field.key] = outcome.value;
        });
        return { ok: Object.keys(errors).length === 0, errors, clean: result };
    }

    /* 顯示用（名單、CSV、回顧報告）：把答案轉成一句話 */
    function answerText(field, value) {
        const type = FIELD_TYPES.indexOf(field.type) >= 0 ? field.type : 'text';
        if (value === undefined || value === null || value === '') {
            return type === 'checkbox' ? '否' : '';
        }
        if (type === 'checkbox') return value === true || value === 'true' ? '是' : '否';
        if (type === 'number' && typeof value === 'number') return String(value);
        return String(value);
    }

    /* 名單／CSV 用：把一位報名的答案排成「欄位標籤=值」的字串（沒填的略過） */
    function answersSummary(fields, rawAnswers) {
        const list = normalizeFields(fields);
        const answers = isPlainObject(rawAnswers) ? rawAnswers : {};
        return list
            .map((field) => {
                const value = answers[field.key];
                // 勾選框沒勾＝沒提供資訊，不要硬顯示「否」（那是「填了但選否」才該出現）
                if (field.type === 'checkbox' && value !== true && value !== 'true') return '';
                const text = answerText(field, value);
                return text ? `${field.label}：${text}` : '';
            })
            .filter(Boolean)
            .join('｜');
    }

    return {
        FIELD_TYPES, TYPE_LABELS, LIMITS,
        makeKey, normalizeFields, hasAnswers, fieldPlaceholder,
        validateAnswer, validateAnswers, answerText, answersSummary
    };
}));
