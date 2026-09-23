/* ============================================================
   日曆檢視模組 (Calendar View) — v2.7.0
   - 純手寫月曆，未使用任何外部套件（CSP 為 script-src 'self'，
     不可載入 CDN，也不可使用 inline 事件屬性）。
   - 只負責「月曆格子 + 選取日期」；當天賽事清單由 app.js 以
     既有的卡片樣板渲染（透過 init 的 renderDayList 回呼），
     因此日曆與列表的操作按鈕行為完全一致。
   - 跨日賽事會展開到涵蓋的每一天（最多 400 天，防呆）。
   ============================================================ */
(function (root) {
    'use strict';

    const DAY_MS_CAP = 400;          // 單一賽事最多展開天數（防止異常資料造成迴圈）
    const MAX_CHIPS = 3;             // 每格最多顯示幾個賽事名稱（其餘以 +N 表示）
    const MAX_DOTS = 6;              // 手機版最多顯示幾個顏色圓點

    let opts = { renderDayList: null };
    let competitions = [];
    let catMap = {};
    let viewYear = 0;
    let viewMonth = 0;
    let selectedDate = null;
    let dom = {};

    function pad(n) { return String(n).padStart(2, '0'); }
    function ymd(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

    function esc(s) {
        if (typeof root.escapeHtml === 'function') return root.escapeHtml(s);
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function attr(s) { return esc(s).replace(/\n/g, ' '); }

    function catColorOf(item) {
        const c = item && item.category ? catMap[item.category] : null;
        return c ? c.color : 'slate';
    }

    // 逐日展開 [start, end]（含頭含尾），支援跨日賽事
    function eachDay(startStr, endStr, fn) {
        const s = String(startStr || '').slice(0, 10).split('-').map(Number);
        const e = String(endStr || startStr || '').slice(0, 10).split('-').map(Number);
        if (!s[0] || !s[1] || !s[2]) return;

        let cur = new Date(s[0], s[1] - 1, s[2]);
        const end = (e[0] && e[1] && e[2]) ? new Date(e[0], e[1] - 1, e[2]) : cur;
        if (end < cur) { fn(ymd(cur.getFullYear(), cur.getMonth(), cur.getDate())); return; }

        for (let i = 0; i < DAY_MS_CAP && cur <= end; i++) {
            fn(ymd(cur.getFullYear(), cur.getMonth(), cur.getDate()));
            cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
        }
    }

    function buildIndex() {
        const map = new Map();
        for (const item of competitions) {
            eachDay(item.date, item.end_date, (day) => {
                if (!map.has(day)) map.set(day, []);
                map.get(day).push(item);
            });
        }
        // 同一天內：跨日賽事先排、再依開始時間
        for (const list of map.values()) {
            list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) ||
                String(a.time || '').localeCompare(String(b.time || '')));
        }
        return map;
    }

    function render() {
        if (!dom.grid) return;
        dom.monthLabel.textContent = `${viewYear} 年 ${viewMonth + 1} 月`;

        const byDay = buildIndex();
        const today = new Date();
        const todayStr = ymd(today.getFullYear(), today.getMonth(), today.getDate());

        const firstDow = new Date(viewYear, viewMonth, 1).getDay();
        let html = '';

        for (let i = 0; i < 42; i++) {
            const d = new Date(viewYear, viewMonth, 1 - firstDow + i);
            const dayStr = ymd(d.getFullYear(), d.getMonth(), d.getDate());
            const items = byDay.get(dayStr) || [];

            const cls = ['cal-cell'];
            if (d.getMonth() !== viewMonth) cls.push('is-other');
            if (dayStr === todayStr) cls.push('is-today');
            if (dayStr === selectedDate) cls.push('is-selected');
            if (items.length) cls.push('is-clickable');

            const chips = items.slice(0, MAX_CHIPS).map((it) =>
                `<span class="cal-chip cat-chip-${catColorOf(it)}" title="${attr(it.name)}">${esc(it.name)}</span>`
            ).join('');

            const more = items.length > MAX_CHIPS
                ? `<span class="cal-more">+${items.length - MAX_CHIPS} 更多</span>` : '';

            const dots = items.length
                ? `<span class="cal-dots">${items.slice(0, MAX_DOTS).map((it) =>
                    `<span class="cal-dot cal-dot-${catColorOf(it)}"></span>`).join('')}</span>`
                : '';

            html += `<div class="${cls.join(' ')}" data-action="cal-day" data-date="${dayStr}"
                        role="button" tabindex="0" aria-label="${dayStr}，${items.length} 場賽事">
                        <span class="cal-day-num">${d.getDate()}</span>${chips}${more}${dots}
                     </div>`;
        }

        dom.grid.innerHTML = html;
        renderDayPanel(byDay);
    }

    function renderDayPanel(byDay) {
        const panel = dom.dayPanel;
        if (!panel) return;

        if (!selectedDate) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
            return;
        }

        const items = byDay ? (byDay.get(selectedDate) || []) : [];
        const [y, m, d] = selectedDate.split('-').map(Number);
        const dow = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];

        panel.classList.remove('hidden');
        panel.innerHTML = `
            <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <h3 class="text-sm font-bold text-slate-700">
                    📅 ${y} 年 ${m} 月 ${d} 日（週${dow}）
                    <span class="text-xs font-normal text-slate-500">共 ${items.length} 場</span>
                </h3>
                <button id="calClearSelection"
                    class="text-xs text-slate-500 hover:text-slate-800 px-2 py-1 bg-slate-100 rounded border">清除選取</button>
            </div>
            <div id="calDayList" class="space-y-3"></div>
        `;

        const listEl = panel.querySelector('#calDayList');
        if (items.length === 0) {
            listEl.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">這天沒有賽事</p>';
        } else if (typeof opts.renderDayList === 'function') {
            opts.renderDayList(listEl, items);
        }

        const clearBtn = panel.querySelector('#calClearSelection');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => selectDate(null));
        }
    }

    function selectDate(dayStr) {
        selectedDate = dayStr || null;
        render();
        if (selectedDate && dom.dayPanel) {
            dom.dayPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function setMonth(delta) {
        const d = new Date(viewYear, viewMonth + delta, 1);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        render();
    }

    function gotoToday() {
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        render();
    }

    function init(options) {
        opts = Object.assign({ renderDayList: null }, options || {});

        dom = {
            container: document.getElementById('calendarView'),
            grid: document.getElementById('calGrid'),
            monthLabel: document.getElementById('calMonthLabel'),
            dayPanel: document.getElementById('calDayPanel'),
            prevBtn: document.getElementById('calPrevBtn'),
            nextBtn: document.getElementById('calNextBtn'),
            todayBtn: document.getElementById('calTodayBtn')
        };

        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();

        dom.prevBtn?.addEventListener('click', () => setMonth(-1));
        dom.nextBtn?.addEventListener('click', () => setMonth(1));
        dom.todayBtn?.addEventListener('click', gotoToday);

        dom.grid?.addEventListener('click', (e) => {
            const cell = e.target.closest('[data-action="cal-day"]');
            if (cell) selectDate(cell.dataset.date);
        });

        dom.grid?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const cell = e.target.closest('[data-action="cal-day"]');
            if (cell) { e.preventDefault(); selectDate(cell.dataset.date); }
        });

        render();
    }

    // 由 app.js 傳入目前篩選後的資料與分類清單
    function setData(list, categories) {
        competitions = Array.isArray(list) ? list : [];
        catMap = {};
        (categories || []).forEach((c) => { catMap[c.id] = c; });
        render();
    }

    root.CMCalendar = {
        init: init,
        setData: setData,
        setMonth: setMonth,
        gotoToday: gotoToday,
        selectDate: selectDate,
        refresh: render,
        _state: () => ({ viewYear, viewMonth, selectedDate, count: competitions.length })
    };
})(typeof window !== 'undefined' ? window : globalThis);
