/* 報名表自訂欄位：畫面渲染與收集（v3.9.0）
 *
 * 規則（必填／型別／選項白名單）全部在 form-fields.js —— 這裡只負責「畫出來」和「收回來」，
 * 不重複寫一份驗證邏輯（那樣遲早前後端不一致）。
 */
(function (root) {
    'use strict';

    const F = root.CMFormFields;

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm';

    function fieldHtml(field) {
        const id = `cf_${field.key}`;
        const label = `<label for="${id}" class="block text-xs font-semibold text-slate-600 mb-1">`
            + escapeHtml(field.label)
            + (field.required ? ' <span class="text-red-500">*</span>' : '')
            + '</label>';
        const err = `<p id="${id}_err" class="hidden text-xs text-red-600 mt-1"></p>`;
        let control = '';
        switch (field.type) {
            case 'textarea':
                control = `<textarea id="${id}" rows="2" maxlength="${F.LIMITS.textarea}" class="${inputClass}" data-field-key="${field.key}" placeholder="${escapeHtml(F.fieldPlaceholder(field))}"></textarea>`;
                break;
            case 'number':
                control = `<input type="number" id="${id}" class="${inputClass}" data-field-key="${field.key}" placeholder="${escapeHtml(F.fieldPlaceholder(field))}">`;
                break;
            case 'date':
                control = `<input type="date" id="${id}" class="${inputClass}" data-field-key="${field.key}">`;
                break;
            case 'select': {
                const opts = ['<option value="">請選擇</option>']
                    .concat((field.options || []).map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`));
                control = `<select id="${id}" class="${inputClass}" data-field-key="${field.key}">${opts.join('')}</select>`;
                break;
            }
            case 'checkbox':
                control = `<label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input type="checkbox" id="${id}" class="h-4 w-4" data-field-key="${field.key}">
                    <span>${escapeHtml(field.label)}</span></label>`;
                return `<div data-field-wrap="${field.key}">${control}${err}</div>`;   // 勾選框自己帶標籤
            default:
                control = `<input type="text" id="${id}" maxlength="${F.LIMITS.text}" class="${inputClass}" data-field-key="${field.key}" placeholder="${escapeHtml(F.fieldPlaceholder(field))}">`;
        }
        return `<div data-field-wrap="${field.key}">${label}${control}${err}</div>`;
    }

    /* 把欄位畫進容器；沒有欄位就整區隱藏（主辦沒設定＝跟以前完全一樣） */
    function render(container, rawFields) {
        if (!container) return [];
        const fields = F.normalizeFields(rawFields);
        if (!fields.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
            container.dataset.fields = '[]';
            return [];
        }
        container.classList.remove('hidden');
        container.innerHTML = fields.map(fieldHtml).join('');
        container.dataset.fields = JSON.stringify(fields);
        return fields;
    }

    function fieldsOf(container) {
        try {
            return JSON.parse(container.dataset.fields || '[]');
        } catch (err) {
            return [];
        }
    }

    /* 收集使用者填的答案（原始值；驗證交給 form-fields） */
    function collect(container) {
        const answers = {};
        if (!container) return answers;
        fieldsOf(container).forEach((field) => {
            const el = container.querySelector(`[data-field-key="${field.key}"]`);
            if (!el) return;
            answers[field.key] = field.type === 'checkbox' ? !!el.checked : el.value;
        });
        return answers;
    }

    /* 逐欄顯示錯誤（伺服器回的 errors 也吃同一套格式） */
    function showErrors(container, errors) {
        const list = errors || {};
        clearErrors(container);
        let firstKey = null;
        Object.keys(list).forEach((key) => {
            const err = container.querySelector(`#cf_${key}_err`);
            if (!err) return;
            err.textContent = list[key];
            err.classList.remove('hidden');
            if (!firstKey) firstKey = key;
        });
        const target = firstKey ? container.querySelector(`#cf_${firstKey}`) : null;
        if (target && target.focus) target.focus();
        return Object.keys(list).length;
    }

    function clearErrors(container) {
        if (!container) return;
        container.querySelectorAll('[id$="_err"]').forEach((el) => {
            el.classList.add('hidden');
            el.textContent = '';
        });
    }

    /* 使用者按送出前的本機檢查 → { ok, errors, clean } */
    function validate(container) {
        return F.validateAnswers(fieldsOf(container), collect(container));
    }

    root.CMRegistrationForm = { render, collect, validate, showErrors, clearErrors, fieldHtml, escapeHtml };
}(typeof self !== 'undefined' ? self : this));
