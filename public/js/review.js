/* 賽事回顧報告 + 系列賽總積分（v3.9.0）
 *
 * 兩個都是「賽事結束之後」才會想看的東西，所以放同一支：
 *   📊 回顧報告：這場辦得怎樣（報名、到場、成績、分享成效）
 *   🏆 系列總積分：同一個系列好幾場累積下來誰領先
 *
 * 圖表一律手寫 SVG（專案不引入任何前端套件，CSP 也維持嚴格）。
 */
(function (root) {
    'use strict';

    const S = root.CMCompetitionState;
    const REVIEW_URL = (id) => `/api/competitions/${encodeURIComponent(id)}/review`;
    const SERIES_URL = (id) => `/api/series/${encodeURIComponent(id)}/standings`;

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function getJson(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取失敗');
        return data;
    }

    function show(id, on) {
        document.getElementById(id)?.classList.toggle('hidden', !on);
    }

    /* 到場率圓環（手寫 SVG，不靠任何圖表套件） */
    function donut(rate, label) {
        const pct = Math.max(0, Math.min(100, Number(rate) || 0));
        const r = 42;
        const circ = 2 * Math.PI * r;
        const dash = (circ * pct) / 100;
        return `<svg viewBox="0 0 110 110" class="w-28 h-28" role="img" aria-label="${escapeHtml(label)} ${pct}%">
            <circle cx="55" cy="55" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="12"></circle>
            <circle cx="55" cy="55" r="${r}" fill="none" stroke="#0d9488" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}"
                transform="rotate(-90 55 55)"></circle>
            <text x="55" y="52" text-anchor="middle" font-size="22" font-weight="700" fill="#0f172a">${pct}%</text>
            <text x="55" y="70" text-anchor="middle" font-size="11" fill="#64748b">到場率</text>
        </svg>`;
    }

    function statCard(label, value, tone) {
        const color = tone === 'warn' ? 'text-amber-700' : (tone === 'good' ? 'text-emerald-700' : 'text-slate-800');
        return `<div class="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
            <p class="text-xs text-slate-500">${escapeHtml(label)}</p>
            <p class="text-xl font-bold ${color}">${escapeHtml(value)}</p></div>`;
    }

    const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

    function renderReview(host, data) {
        const s = data.signups || {};
        const att = data.attendance || {};
        const res = data.results || {};
        const bits = [];

        bits.push(`<div class="rounded-lg border border-slate-200 p-3">
            <p class="font-bold text-slate-800 text-base">${escapeHtml(data.name)}</p>
            <p class="text-xs text-slate-500 mt-1">${escapeHtml(data.date || '')}${data.location ? ' ・ ' + escapeHtml(data.location) : ''}</p>
            <p class="mt-2 text-sm">${escapeHtml(data.headline || '')}</p></div>`);

        bits.push(`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${statCard('報名總數', s.total || 0)}
            ${statCard('正取', s.confirmed || 0, 'good')}
            ${statCard('候補', s.waitlisted || 0, s.waitlisted ? 'warn' : '')}
            ${statCard('待審核', s.pending || 0, s.pending ? 'warn' : '')}
        </div>`);

        bits.push(`<div class="flex items-center gap-4 rounded-lg border border-slate-200 p-3">
            ${donut(att.rate === null || att.rate === undefined ? 0 : att.rate)}
            <div class="text-xs text-slate-600 space-y-1">
                <p>✅ 實際到場：<span class="font-bold text-slate-800">${att.attended || 0}</span> 人</p>
                <p>👥 正取人數：<span class="font-bold text-slate-800">${att.base || 0}</span> 人</p>
                ${att.rate === null || att.rate === undefined ? '<p class="text-slate-400">（還沒有人簽到，所以算不出到場率）</p>' : ''}
                ${(s.rejected ? `<p>🚫 未錄取：${s.rejected} 人</p>` : '')}
            </div></div>`);

        if ((res.podium || []).length) {
            bits.push(`<div class="rounded-lg border border-slate-200 p-3">
                <p class="font-semibold text-slate-700 mb-2">🏁 成績（共 ${res.count || 0} 筆，${res.finished || 0} 筆完成）</p>
                <table class="w-full text-xs"><tbody>
                ${res.podium.map((row) => `<tr class="border-b last:border-0">
                    <td class="py-1.5 w-10 text-center font-bold">${MEDALS[row.rank] || row.rank}</td>
                    <td class="py-1.5 font-medium text-slate-800">${escapeHtml(row.username)}</td>
                    <td class="py-1.5 text-slate-600">${escapeHtml(row.score_text || '')}</td>
                    <td class="py-1.5 text-slate-400 text-right">${escapeHtml(row.note || '')}</td>
                </tr>`).join('')}
                </tbody></table></div>`);
        } else {
            bits.push('<p class="text-xs text-slate-500 rounded-lg border border-dashed border-slate-300 p-3">這場還沒有登錄成績。</p>');
        }

        if (data.can_see_share && (data.share || []).length) {
            bits.push(`<div class="rounded-lg border border-slate-200 p-3">
                <p class="font-semibold text-slate-700 mb-2">📈 分享成效（只有管理員看得到）</p>
                <table class="w-full text-xs">
                    <thead><tr class="text-slate-500"><th class="text-left py-1">來源</th><th class="text-right py-1">開啟</th><th class="text-right py-1">帶來報名</th></tr></thead>
                    <tbody>${data.share.map((row) => `<tr class="border-t">
                        <td class="py-1.5">${escapeHtml(row.label || row.source)}</td>
                        <td class="py-1.5 text-right">${row.visits || 0}</td>
                        <td class="py-1.5 text-right font-medium">${row.signups || 0}</td>
                    </tr>`).join('')}</tbody></table></div>`);
        }

        if (data.series_root_id) {
            // v3.9.2：CSP 是 script-src 'self'，行內 onclick 會被瀏覽器直接擋掉（按了沒反應）
            // → 改用 data 屬性 ＋ 由下方委派監聽處理
            bits.push(`<button type="button" data-series-root="${Number(data.series_root_id)}"
                class="text-xs text-blue-700 underline">🏆 看這個系列的總積分</button>`);
        }

        host.innerHTML = bits.join('');
    }

    let currentReview = null;

    async function open(compId) {
        const host = document.getElementById('reviewBody');
        if (!host) return;
        show('reviewModal', true);
        host.innerHTML = '<p class="text-xs text-slate-500">載入中…</p>';
        try {
            const data = await getJson(REVIEW_URL(compId));
            currentReview = data;
            renderReview(host, data);
        } catch (err) {
            currentReview = null;
            host.innerHTML = `<p class="text-xs text-red-600">${escapeHtml(err.message)}</p>`;
        }
    }

    function close() {
        show('reviewModal', false);
    }

    /* 文字摘要：主辦可以直接貼到群組 */
    function summaryText(data) {
        if (!data) return '';
        const s = data.signups || {};
        const att = data.attendance || {};
        const lines = [`📊 ${data.name} 回顧報告`];
        if (data.date) lines.push(`日期：${data.date}`);
        if (data.location) lines.push(`地點：${data.location}`);
        lines.push(`報名 ${s.total || 0} 人（正取 ${s.confirmed || 0}${s.waitlisted ? `、候補 ${s.waitlisted}` : ''}）`);
        if (att.rate !== null && att.rate !== undefined) lines.push(`實到 ${att.attended} 人（到場率 ${att.rate}%）`);
        (data.results && data.results.podium ? data.results.podium.slice(0, 3) : []).forEach((row) => {
            lines.push(`第 ${row.rank} 名：${row.username}${row.score_text ? '（' + row.score_text + '）' : ''}`);
        });
        return lines.join('\n');
    }

    async function copySummary() {
        const text = summaryText(currentReview);
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            const btn = document.getElementById('reviewCopyBtn');
            if (btn) {
                btn.textContent = '✅ 已複製';
                setTimeout(() => { btn.textContent = '📋 複製文字摘要'; }, 1500);
            }
        } catch (err) {
            window.prompt('複製這段文字：', text);
        }
    }

    /* ---------- 系列賽總積分 ---------- */
    function bar(points, max) {
        // 寬度用類別（CSP 的 style-src 'self' 會擋掉行內 style 屬性，行內 % 不會生效）
        const step = max > 0 ? Math.max(1, Math.min(10, Math.round((points / max) * 10))) : 0;
        return `<div class="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-2 bg-blue-500 cm-bar-${step}"></div></div>`;
    }

    function renderSeries(host, data) {
        const rows = data.standings || [];
        const cfg = data.config || {};
        const max = rows.length ? Math.max.apply(null, rows.map((r) => r.total)) : 0;
        const bits = [];

        bits.push(`<div class="rounded-lg border border-slate-200 p-3">
            <p class="font-bold text-slate-800">${escapeHtml(data.series && data.series.name)}</p>
            <p class="text-xs text-slate-500 mt-1">共 ${data.race_count || 0} 場・計分方式：第 1 名 ${(cfg.points || [])[0] || 0} 分
                ${cfg.count_best ? `・只取最好的 ${cfg.count_best} 場` : ''}</p></div>`);

        if (!rows.length || !rows.some((r) => r.total > 0)) {
            bits.push('<p class="text-xs text-slate-500 rounded-lg border border-dashed border-slate-300 p-3">這個系列還沒有登錄名次，所以還沒有積分。</p>');
        } else {
            bits.push(`<table class="w-full text-xs">
                <thead><tr class="text-slate-500 border-b">
                    <th class="text-left py-2 w-8">#</th><th class="text-left py-2">選手</th>
                    <th class="text-left py-2 w-32">積分</th><th class="text-right py-2">總分</th></tr></thead>
                <tbody>${rows.map((row) => `<tr class="border-b last:border-0 align-middle">
                    <td class="py-2 font-bold">${row.position}</td>
                    <td class="py-2"><span class="font-medium text-slate-800">${MEDALS[row.position] || ''}${escapeHtml(row.username)}</span>
                        <span class="text-slate-400">（出賽 ${row.race_count} 場${row.best_rank ? `・最佳第 ${row.best_rank}` : ''}${row.counted && row.counted !== row.race_count ? `・計分 ${row.counted} 場` : ''}）</span></td>
                    <td class="py-2">${bar(row.total, max)}</td>
                    <td class="py-2 text-right font-bold">${row.total}</td></tr>`).join('')}</tbody></table>`);

            bits.push(`<details class="text-xs"><summary class="cursor-pointer text-slate-500">看每一場的名次與得分</summary>
                <div class="mt-2 overflow-x-auto"><table class="text-xs border-collapse">
                <thead><tr class="text-slate-500"><th class="text-left py-1 pr-3">選手</th>
                ${(data.races || []).map((race) => `<th class="text-left py-1 pr-3">${escapeHtml(race.name || String(race.id))}<br><span class="text-slate-400">${escapeHtml(race.date || '')}</span></th>`).join('')}
                <th class="text-right py-1">總分</th></tr></thead>
                <tbody>${rows.map((row) => {
                    const byRace = {};
                    (row.races || []).forEach((race) => { byRace[String(race.competition_id)] = race; });
                    return `<tr class="border-t"><td class="py-1 pr-3 font-medium">${escapeHtml(row.username)}</td>
                        ${(data.races || []).map((race) => {
                            const hit = byRace[String(race.id)];
                            if (!hit) return '<td class="py-1 pr-3"><span class="text-slate-300">—</span></td>';
                            if (hit.rank) return `<td class="py-1 pr-3">第 ${hit.rank} 名 <span class="text-slate-400">+${hit.points}</span></td>`;
                            // v3.9.1：有出賽但沒有名次（未完賽／未出賽／取消資格）→ 明講狀態並標 0 分，
                            // 不要顯示成「—」（那會讓人以為他沒報名這場）
                            const label = (typeof CMResults !== 'undefined' && CMResults.statusLabel)
                                ? CMResults.statusLabel(hit.status) : (hit.status || '未完成');
                            return `<td class="py-1 pr-3">${escapeHtml(label)} <span class="text-slate-400">+0</span></td>`;
                        }).join('')}
                        <td class="py-1 text-right font-bold">${row.total}</td></tr>`;
                }).join('')}</tbody></table></div></details>`);
        }

        host.innerHTML = bits.join('');
    }

    async function openSeries(rootId) {
        const host = document.getElementById('seriesBody');
        if (!host) return;
        show('reviewModal', false);
        show('seriesModal', true);
        host.innerHTML = '<p class="text-xs text-slate-500">載入中…</p>';
        try {
            const data = await getJson(SERIES_URL(rootId));
            renderSeries(host, data);
        } catch (err) {
            host.innerHTML = `<p class="text-xs text-red-600">${escapeHtml(err.message)}</p>`;
        }
    }

    function closeSeries() {
        show('seriesModal', false);
    }

    /* 綁定按鈕：一律用 addEventListener（CSP 的 script-src 'self' 會擋掉行內 onclick） */
    function bind() {
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };
        on('reviewCloseBtn', close);
        on('reviewCloseBtn2', close);
        on('seriesCloseBtn', closeSeries);
        on('seriesCloseBtn2', closeSeries);
        on('reviewCopyBtn', copySummary);

        // 動態產生的按鈕用委派（回顧報告內文每次都會重畫）
        const body = document.getElementById('reviewBody');
        if (body) {
            body.addEventListener('click', (ev) => {
                const hit = ev.target && ev.target.closest ? ev.target.closest('[data-series-root]') : null;
                if (hit) openSeries(hit.getAttribute('data-series-root'));
            });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    root.CMReview = {
        open, close, openSeries, closeSeries, copySummary, summaryText, _bind: bind,
        _renderReview: renderReview, _renderSeries: renderSeries, _donut: donut
    };
}(typeof self !== 'undefined' ? self : this));
