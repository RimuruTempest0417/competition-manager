/* 示範流程（可一步一步手動執行）v3.9.2
 *
 * 為什麼要這支：系列賽總積分／回顧報告要「有兩場同系列＋報名＋成績」才看得出效果，
 * 平常線上沒有這種資料。這支把助理驗證時跑的那條流程，做成**管理員在畫面上按得到的按鈕**：
 *   ① 建立示範第一站 → ② 設定每週週期 → ③ 由週期建立第二站 → ④ 報名
 *   → ⑤ 登錄成績（含未完賽）→ ⑥ 公布成績 → 🗑️ 清掉示範資料
 *
 * 只呼叫**既有**的正式 API（跟手動操作走同一條路），沒有為了示範另開後門端點：
 *   POST /api/competitions、POST /api/competitions/:id/recurrence（/next）、
 *   POST /api/competitions/:id/onsite-registration、PUT /api/competitions/:id/results、
 *   POST /api/competitions/:id/results/publish、DELETE /api/competitions/:id
 * 每一步做了什麼都會留在操作日誌與賽事資料裡，名稱一律有「【示範】」字樣，方便辨識與清除。
 *
 * 注意：CSP 是 script-src 'self'，**不能用行內 onclick**，所以按鈕都用 data-* ＋ 事件委派。
 */
(function (root) {
    'use strict';

    const PREFIX = '【示範】';
    const NAMES = ['示範小明', '示範阿華', '示範小美', '示範阿德'];
    const LATE = '示範阿強';      // 只在第二站出賽且未完賽 → 驗「超表 0 分但仍在榜上」
    const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d; };
    const esc = (v) => String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    async function send(url, method, body) {
        const res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
        return data;
    }
    const get = (u) => send(u, 'GET');
    const post = (u, b) => send(u, 'POST', b === undefined ? {} : b);
    const put = (u, b) => send(u, 'PUT', b);
    const del = (u) => send(u, 'DELETE');

    /* ---------- 讀回目前狀態（示範資料到哪一步了） ---------- */
    async function loadState() {
        const list = await get('/api/competitions');
        const mine = (Array.isArray(list) ? list : []).filter((c) => String(c.name || '').startsWith(PREFIX));
        const root = mine.find((c) => !c.recurrence_parent_id) || null;
        const child = root ? (mine.find((c) => String(c.recurrence_parent_id) === String(root.id)) || null) : null;
        const state = { all: mine, root, child, rootRegs: [], childRegs: [], rootResults: null, childResults: null };

        for (const [key, comp] of [['rootRegs', root], ['childRegs', child]]) {
            if (!comp) continue;
            try {
                const r = await get(`/api/competitions/${comp.id}/registrations`);
                state[key] = (r.registrations || []).filter((x) => !x.is_deleted);
            } catch (err) { state[key] = []; }
        }
        for (const [key, comp] of [['rootResults', root], ['childResults', child]]) {
            if (!comp) continue;
            try { state[key] = await get(`/api/competitions/${comp.id}/results`); } catch (err) { state[key] = null; }
        }
        return state;
    }

    const namesOf = (rows) => (rows || []).map((r) => r.username);
    const resultsOf = (payload) => (payload && (payload.results || payload.items)) || [];

    function statusOf(state) {
        const rootOk = !!state.root;
        const recurOk = !!(state.root && state.root.recurrence);
        const childOk = !!state.child;
        const regOk = rootOk && childOk
            && NAMES.every((n) => namesOf(state.rootRegs).indexOf(n) >= 0)
            && [...NAMES, LATE].every((n) => namesOf(state.childRegs).indexOf(n) >= 0);
        const rows = resultsOf(state.rootResults);
        const childRows = resultsOf(state.childResults);
        const resOk = rows.length >= NAMES.length
            && childRows.filter((r) => String(r.status || '').toLowerCase() === 'dnf').length >= 2;
        const pubOk = !!(state.rootResults && state.rootResults.published) && !!(state.childResults && state.childResults.published);
        return [
            { done: rootOk, note: rootOk ? `已建立（id ${state.root.id}、${state.root.date || ''}）` : '還沒有示範賽事' },
            { done: recurOk, note: recurOk ? `週期：${state.root.recurrence}` : '還沒設定週期（系列賽需要它才會成立）' },
            { done: childOk, note: childOk ? `已建立（id ${state.child.id}、${state.child.date || ''}）` : '還沒有第二站' },
            { done: regOk, note: `${state.root ? state.rootRegs.length : 0} 人（第一站）／${state.child ? state.childRegs.length : 0} 人（第二站）` },
            { done: resOk, note: `${rows.length} 筆成績、第二站 ${childRows.filter((r) => String(r.status || '').toLowerCase() === 'dnf').length} 位未完賽` },
            { done: pubOk, note: pubOk ? '兩場都已公布' : '還沒公布（未公布時訪客看不到成績）' }
        ];
    }

    /* ---------- 每一步 ---------- */
    const STEPS = [
        { key: 'create-root', label: '① 建立示範第一站', hint: '建立「【示範】秋季系列 第一站」（含系列積分 10/8/6/5…）' },
        { key: 'set-recurrence', label: '② 設定每週週期', hint: '把第一站設成每週重複 → 它才成為一個「系列」' },
        { key: 'create-next', label: '③ 由週期建立第二站', hint: '用系統的週期功能產生第二站（不是硬塞資料）' },
        { key: 'register', label: '④ 兩場報名', hint: `第一站 ${NAMES.length} 人、第二站 ${NAMES.length + 1} 人（多一位只出賽第二場）` },
        { key: 'results', label: '⑤ 登錄成績', hint: '依名次給分；第二站有兩位未完賽（超表＝0 分但仍在榜上）' },
        { key: 'publish', label: '⑥ 公布成績', hint: '公布後訪客才看得到成績與系列積分' },
        { key: 'cleanup', label: '🗑️ 清除示範資料', hint: '把所有「【示範】」賽事連同報名與成績移除' }
    ];

    const RUN = {
        async 'create-root'() {
            const date = fmt(shift(-7));
            const created = await post('/api/competitions', {
                name: `${PREFIX}秋季系列 第一站`, date, time: '09:00', end_date: date, end_time: '16:00',
                location: '澳門（示範場地）',
                description: '示範資料：用來驗證系列總積分與回顧報告，看完請用「示範流程」清除。',
                is_registration_open: false,
                series_points: { points: POINTS, count_best: 0, note: '示範：第 1 名 10 分' }
            });
            return `已建立第一站（id ${created.id}、${date}）`;
        },
        async 'set-recurrence'() {
            const st = await loadState();
            if (!st.root) throw new Error('請先執行 ① 建立示範第一站');
            await post(`/api/competitions/${st.root.id}/recurrence`, { recurrence: 'weekly' });
            return `已把 id ${st.root.id} 設成每週週期`;
        },
        async 'create-next'() {
            const st = await loadState();
            if (!st.root) throw new Error('請先執行 ① 建立示範第一站');
            if (st.child) return `第二站已存在（id ${st.child.id}），不用重複建立`;
            const next = await post(`/api/competitions/${st.root.id}/recurrence/next`, {});
            const id = next && next.id ? next.id : null;
            if (!id) throw new Error('週期沒有產生下一場（可能距離太遠或已經有場次）');
            const date = fmt(shift(0));
            await put(`/api/competitions/${id}`, {
                name: `${PREFIX}秋季系列 第二站`, date, time: '09:00', end_date: date, end_time: '16:00',
                location: '澳門（示範場地）', is_registration_open: false
            });
            return `已建立第二站（id ${id}、${date}）並改名為「第二站」`;
        },
        async 'register'() {
            const st = await loadState();
            if (!st.root || !st.child) throw new Error('請先執行 ① 與 ③ 建立兩場賽事');
            const add = async (compId, names, existing) => {
                let added = 0;
                for (const name of names) {
                    if (existing.indexOf(name) >= 0) continue;
                    await post(`/api/competitions/${compId}/onsite-registration`, { username: name });
                    added += 1;
                }
                return added;
            };
            const a = await add(st.root.id, NAMES, namesOf(st.rootRegs));
            const b = await add(st.child.id, [...NAMES, LATE], namesOf(st.childRegs));
            return `第一站新增 ${a} 人、第二站新增 ${b} 人`;
        },
        async 'results'() {
            const st = await loadState();
            if (!st.root || !st.child) throw new Error('請先執行 ① 與 ③ 建立兩場賽事');
            const pick = (regs, names) => names.map((n) => (regs.find((r) => r.username === n) || {})).filter((r) => r.id);
            const raceA = pick(st.rootRegs, NAMES).map((r, i) => ({
                registration_id: r.id, rank: i + 1, status: 'finished', score_text: `1${i + 2}:${30 - i * 7}.0`
            }));
            const raceB = pick(st.childRegs, [...NAMES, LATE]).map((r, i) => (
                (r.username === '示範小美' || r.username === LATE)
                    ? { registration_id: r.id, status: 'dnf', note: r.username === LATE ? '示範：未完賽（只有這一場）' : '示範：未完賽' }
                    : { registration_id: r.id, rank: i + 1, status: 'finished', score_text: `1${i + 3}:1${i}.0` }
            ));
            await put(`/api/competitions/${st.root.id}/results`, { results: raceA });
            await put(`/api/competitions/${st.child.id}/results`, { results: raceB });
            return `已登錄 ${raceA.length}＋${raceB.length} 筆成績（第二站 2 位未完賽）`;
        },
        async 'publish'() {
            const st = await loadState();
            if (!st.root || !st.child) throw new Error('請先執行 ① 與 ③ 建立兩場賽事');
            await post(`/api/competitions/${st.root.id}/results/publish`, { confirm: true });
            await post(`/api/competitions/${st.child.id}/results/publish`, { confirm: true });
            return '兩場成績都已公布';
        },
        async 'cleanup'() {
            const st = await loadState();
            if (!st.all.length) return '目前沒有示範資料';
            for (const c of st.all) await del(`/api/competitions/${c.id}`);
            return `已移除 ${st.all.length} 場示範賽事（可到「回收筒」永久刪除）`;
        }
    };

    const order = STEPS.filter((s) => s.key !== 'cleanup').map((s) => s.key);

    /* ---------- 畫面 ---------- */
    function render(host, state, messages) {
        const status = statusOf(state);
        const rows = STEPS.map((step, i) => {
            const st = status[i] || { done: false, note: '' };
            const msg = messages[step.key];
            const tone = st.done ? 'text-emerald-700' : 'text-slate-400';
            return `<div class="rounded-lg border border-slate-200 p-3 flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <p class="text-sm font-medium text-slate-800"><span class="${tone}">${st.done ? '✅' : '⬜'}</span> ${esc(step.label)}</p>
                    <p class="text-xs text-slate-500 mt-1">${esc(step.hint)}</p>
                    ${st.note ? `<p class="text-xs text-slate-400 mt-1">目前：${esc(st.note)}</p>` : ''}
                    ${msg ? `<p class="text-xs mt-1 ${msg.ok ? 'text-emerald-700' : 'text-red-600'}">${msg.ok ? '✅' : '❌'} ${esc(msg.text)}</p>` : ''}
                </div>
                <button type="button" data-demo-step="${step.key}"
                    class="shrink-0 px-3 py-1.5 text-xs rounded-lg ${step.key === 'cleanup' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-blue-600 text-white hover:bg-blue-700'} font-medium">
                    執行
                </button></div>`;
        }).join('');

        const doneCount = status.slice(0, 6).filter((s) => s.done).length;
        host.innerHTML = `
            <div class="rounded-lg border border-slate-200 p-3 text-xs text-slate-600 space-y-1">
                <p>這條流程會用正式 API 建立一批名稱有「${esc(PREFIX)}」的賽事，讓你可以親自看「系列賽總積分／回顧報告／超表 0 分」實際長什麼樣。</p>
                <p>進度：<span class="font-bold text-slate-800">${doneCount} / 6</span>${state.root ? `｜第一站 id ${state.root.id}${state.child ? `、第二站 id ${state.child.id}` : ''}` : ''}</p>
                <p class="text-slate-400">每一步都可以單獨按；已經做過的不會重複建立。全部驗完按「🗑️ 清除示範資料」即可。</p>
            </div>
            <div class="space-y-2">${rows}</div>
            <div class="flex flex-wrap items-center gap-2 pt-1">
                <button type="button" data-demo-action="run-all"
                    class="px-3 py-2 text-xs rounded-lg bg-slate-700 text-white hover:bg-slate-800 font-medium">▶ 一鍵跑完 ①～⑥</button>
                <button type="button" data-demo-action="refresh"
                    class="px-3 py-2 text-xs rounded-lg text-slate-600 hover:bg-slate-100">🔄 重新讀取狀態</button>
                ${state.root ? `<button type="button" data-demo-action="standings"
                    class="px-3 py-2 text-xs rounded-lg text-blue-700 hover:bg-blue-50">🏆 看系列總積分</button>` : ''}
                ${state.root ? `<button type="button" data-demo-action="review"
                    class="px-3 py-2 text-xs rounded-lg text-blue-700 hover:bg-blue-50">📊 看第一站的回顧報告</button>` : ''}
            </div>`;
    }

    let lastState = null;
    const messages = {};

    function show(id, on) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
    }

    async function refresh() {
        const host = document.getElementById('demoFlowBody');
        if (!host) return;
        try {
            lastState = await loadState();
            render(host, lastState, messages);
        } catch (err) {
            host.innerHTML = `<p class="text-xs text-red-600">讀取狀態失敗：${esc(err.message)}</p>`;
        }
    }

    async function run(key) {
        const host = document.getElementById('demoFlowBody');
        if (!host) return;
        messages[key] = { ok: true, text: '執行中…' };
        await refresh();
        const btn = host.querySelector(`[data-demo-step="${key}"]`);
        if (btn) { btn.disabled = true; btn.textContent = '執行中…'; }
        try {
            const text = await RUN[key]();
            messages[key] = { ok: true, text: text || '完成' };
        } catch (err) {
            messages[key] = { ok: false, text: err.message || '執行失敗' };
        }
        await refresh();
    }

    async function runAll() {
        for (const key of order) {
            await run(key);
            if (messages[key] && !messages[key].ok) return;   // 一步失敗就停，讓人看清楚問題在哪
        }
    }

    function open() {
        show('demoFlowModal', true);
        refresh();
    }

    function close() {
        show('demoFlowModal', false);
    }

    /* 事件委派：CSP 不允許行內 onclick，所以用 data-* ＋ 一個監聽 */
    function bind() {
        const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
        on('demoFlowBtn', () => { open(); if (typeof closeNavDropdown === 'function') closeNavDropdown(); });
        on('demoFlowCloseBtn', close);
        on('demoFlowCloseBtn2', close);

        const host = document.getElementById('demoFlowBody');
        if (host) {
            host.addEventListener('click', (ev) => {
                const target = ev.target && ev.target.closest ? ev.target.closest('[data-demo-step], [data-demo-action]') : null;
                if (!target) return;
                const step = target.getAttribute('data-demo-step');
                if (step) { run(step); return; }
                const action = target.getAttribute('data-demo-action');
                if (action === 'refresh') refresh();
                else if (action === 'run-all') runAll();
                else if (action === 'standings' && lastState && lastState.root) closeAnd('series', lastState.root.id);
                else if (action === 'review' && lastState && lastState.root) closeAnd('review', lastState.root.id);
            });
        }
    }

    /* 開完就把示範彈窗關掉，接著開回顧報告／系列積分，畫面不會疊兩層 */
    function closeAnd(what, id) {
        close();
        if (what === 'series' && root.CMReview) root.CMReview.openSeries(id);
        else if (what === 'review' && root.CMReview) root.CMReview.open(id);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    root.CMDemoFlow = { open, close, refresh, run, runAll, _statusOf: statusOf, _steps: STEPS };
}(typeof self !== 'undefined' ? self : this));
