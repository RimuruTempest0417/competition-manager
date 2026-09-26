/* v3.2.0（P1-7）：名單與成績的列印版規則（UMD）
 *
 * 這是「列印出來那張紙長什麼樣」的唯一真實來源：前端預覽、列印、測試共用同一份，
 * 所以「預覽看到的」與「印出來的」不會不一致。
 *
 * 設計原則：
 *   1. 只放真的需要的欄位——列印的是現場用的紙本，不是資料庫匯出。
 *   2. 名單預設只印「已錄取」；候補預設另成一段並標示候補順位（避免把候補誤當正取點名）。
 *   3. 待審核／未錄取／已取消一律不印（那不是現場要用的名單）。
 *   4. 所有文字都經過 escapeHtml，隊名或備註裡有 < > & 也不會破壞版面。
 *   5. 不產生任何外部資源（CSP 只允許 'self'，列印版也不連外）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMPrintDoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STATUS_LABELS = {
        confirmed: '已錄取',
        pending: '待審核',
        waitlisted: '候補',
        rejected: '未錄取',
        cancelled: '已取消'
    };

    const CATEGORY_LABELS = {
        track: '田徑',
        ball: '球類',
        water: '水上',
        academic: '學科競賽',
        esports: '電子競技',
        other: '其他'
    };

    const RESULT_STATUS_LABELS = {
        finished: '完賽',
        dnf: '未完賽',
        dns: '未出賽',
        dq: '取消資格',
        other: '其他'
    };

    const DEFAULTS = {
        includeWaitlist: true,
        includePending: false,
        signColumn: true,
        orientation: 'portrait',
        note: ''
    };

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function statusLabel(status) {
        return STATUS_LABELS[status] || status || '';
    }

    function resultStatusLabel(status) {
        return RESULT_STATUS_LABELS[status] || status || '';
    }

    function formatDate(date, time) {
        if (!date) return '';
        const d = String(date);
        if (!time) return d;
        return `${d} ${String(time).slice(0, 5)}`;
    }

    function formatPrintedAt(now) {
        const t = now instanceof Date ? now : new Date(now || Date.now());
        const pad = (n) => String(n).padStart(2, '0');
        return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }

    /* 賽事抬頭：紙本最上方那塊（沒填的就不要印空標籤） */
    function competitionHeader(comp) {
        const c = comp || {};
        const when = [formatDate(c.date, c.time), c.end_date ? `～ ${formatDate(c.end_date, c.end_time)}` : '']
            .filter(Boolean).join(' ');
        return {
            name: c.name || '（未命名賽事）',
            when,
            location: c.location || '',
            category: CATEGORY_LABELS[c.category] || c.category || '',
            is_team_event: !!c.is_team_event,
            team_size: c.team_size || null,
            max_registrations: c.max_registrations || null
        };
    }

    /* 名單列：一列一個人（團體賽就是一個隊伍，成員名單在備註欄） */
    function rosterRows(list, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        const rows = Array.isArray(list) ? list.slice() : [];
        const confirmed = rows
            .filter((r) => r.status === 'confirmed')
            .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
        const waitlisted = rows
            .filter((r) => r.status === 'waitlisted')
            .sort((a, b) => {
                const oa = a.waitlist_order === null || a.waitlist_order === undefined ? 1e9 : Number(a.waitlist_order);
                const ob = b.waitlist_order === null || b.waitlist_order === undefined ? 1e9 : Number(b.waitlist_order);
                if (oa !== ob) return oa - ob;
                return Number(a.id || 0) - Number(b.id || 0);
            });
        const pending = rows
            .filter((r) => r.status === 'pending')
            .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));

        const map = (r, index, extra) => Object.assign({
            no: index + 1,
            id: r.id,
            name: r.username || r.team_name || '（無名稱）',
            team: r.team_name || '',
            status: statusLabel(r.status),
            note: r.note || '',
            sign: o.signColumn ? '' : null,
            needs_review: !!r.review_note
        }, extra || {});

        return {
            confirmed: confirmed.map((r, i) => map(r, i)),
            waitlisted: waitlisted.map((r, i) => map(r, i, { wait_number: i + 1 })),
            pending: pending.map((r, i) => map(r, i))
        };
    }

    /* 完整名單模型（預覽與列印都用它） */
    function rosterModel(comp, list, opts, now) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        const rows = rosterRows(list, o);
        const groups = [];
        groups.push({ key: 'confirmed', title: '正取名單', rows: rows.confirmed });
        if (o.includeWaitlist && rows.waitlisted.length) {
            groups.push({ key: 'waitlist', title: '候補名單（依序遞補）', rows: rows.waitlisted });
        }
        if (o.includePending && rows.pending.length) {
            groups.push({ key: 'pending', title: '待審核（尚未錄取）', rows: rows.pending });
        }
        // printed＝這張紙上真正印出來的列數（切換選項會變）；其餘是原始統計（不會變）
        const printed = groups.reduce((sum, g) => sum + g.rows.length, 0);
        return {
            kind: 'roster',
            title: '報名名單',
            header: competitionHeader(comp),
            groups,
            options: o,
            stats: {
                confirmed: rows.confirmed.length,
                waitlisted: rows.waitlisted.length,
                pending: rows.pending.length,
                printed,
                total: printed,
                free_slots: (comp && comp.max_registrations)
                    ? Math.max(0, Number(comp.max_registrations) - rows.confirmed.length)
                    : null
            },
            printed_at: formatPrintedAt(now)
        };
    }

    /* 成績表模型：只印名次表（未公布時呼叫端不該開這個視窗） */
    function resultModel(comp, results, opts, now) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        const rows = (Array.isArray(results) ? results.slice() : [])
            .sort((a, b) => {
                const ra = a.rank === null || a.rank === undefined ? 1e9 : Number(a.rank);
                const rb = b.rank === null || b.rank === undefined ? 1e9 : Number(b.rank);
                if (ra !== rb) return ra - rb;
                return Number(a.id || 0) - Number(b.id || 0);
            })
            .map((r) => ({
                rank: (r.rank === null || r.rank === undefined) ? '—' : r.rank,
                name: r.display_name || r.username || '（無名稱）',
                score: r.score_text || '',
                status: resultStatusLabel(r.status),
                note: r.note || '',
                finished: r.status === 'finished'
            }));
        const finished = rows.filter((r) => r.finished).length;
        return {
            kind: 'results',
            title: '成績表',
            header: competitionHeader(comp),
            groups: [{ key: 'results', title: '名次', rows }],
            options: o,
            stats: { total: rows.length, finished, ranked: rows.filter((r) => r.rank !== '—').length },
            printed_at: formatPrintedAt(now)
        };
    }

    /* 紙本上方的摘要句 */
    function summaryText(model) {
        if (!model) return '';
        if (model.kind === 'roster') {
            const parts = [`共 ${model.stats.printed} 人`];
            parts.push(`正取 ${model.stats.confirmed} 人`);
            // 只有真的印出來的群組才寫進摘要，避免紙上說有候補卻找不到人
            const hasWait = model.groups.some((g) => g.key === 'waitlist');
            const hasPending = model.groups.some((g) => g.key === 'pending');
            if (hasWait) parts.push(`候補 ${model.stats.waitlisted} 人`);
            if (hasPending) parts.push(`待審核 ${model.stats.pending} 人`);
            if (model.stats.free_slots !== null) parts.push(`尚餘 ${model.stats.free_slots} 個名額`);
            return parts.join('．');
        }
        const parts = [`共 ${model.stats.total} 筆`];
        if (model.stats.finished) parts.push(`完賽 ${model.stats.finished} 筆`);
        if (model.stats.ranked) parts.push(`已排名 ${model.stats.ranked} 筆`);
        return parts.join('．');
    }

    function headerCells(model) {
        if (model.kind === 'roster') {
            const cells = ['編號', '姓名 / 隊伍'];
            if (model.header.is_team_event) cells.push('隊伍');
            cells.push('狀態');
            if (model.options.signColumn) cells.push('簽到');
            cells.push('備註');
            return cells;
        }
        return ['名次', '姓名 / 隊伍', '成績', '狀態', '備註'];
    }

    function rowCells(model, row) {
        if (model.kind === 'roster') {
            const cells = [String(row.no), row.name];
            if (model.header.is_team_event) cells.push(row.team || '');
            if (row.status === '候補' && row.wait_number) cells.push(`${row.status} ${row.wait_number}`);
            else cells.push(row.status);
            if (model.options.signColumn) cells.push('');
            cells.push(row.note);
            return cells;
        }
        return [String(row.rank), row.name, row.score, row.status, row.note];
    }

    /* 產生列印用的 HTML（表格；thead 會由瀏覽器在每頁自動重複） */
    function toHtml(model) {
        if (!model) return '';
        const cells = headerCells(model);
        const groups = model.groups.map((g) => {
            if (!g.rows.length) return '';
            const body = g.rows.map((r) => `            <tr>${rowCells(model, r)
                .map((c, i) => `<td${i === 0 ? ' class="num"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n');
            return `        <section class="print-group">
            <h3>${escapeHtml(g.title)}<span class="group-count">（${g.rows.length}）</span></h3>
            <table class="print-table">
                <thead><tr>${cells.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
                <tbody>
${body}
                </tbody>
            </table>
        </section>`;
        }).filter(Boolean).join('\n');

        const meta = [
            model.header.when ? `時間：${escapeHtml(model.header.when)}` : '',
            model.header.location ? `地點：${escapeHtml(model.header.location)}` : '',
            model.header.category ? `類別：${escapeHtml(model.header.category)}` : ''
        ].filter(Boolean).map((t) => `<span class="meta-item">${t}</span>`).join('');

        return `    <div class="print-sheet ${escapeHtml(model.options.orientation)}" id="printSheet">
        <header class="print-head">
            <h1>${escapeHtml(model.header.name)}</h1>
            <div class="meta">${meta}</div>
            <div class="subject"><strong>${escapeHtml(model.title)}</strong><span>${escapeHtml(summaryText(model))}</span></div>
        </header>
${groups}
        <footer class="print-foot">
            <span>列印時間：${escapeHtml(model.printed_at)}</span>
            <span>${escapeHtml(model.options.note || '')}</span>
        </footer>
    </div>
`;
    }

    return {
        STATUS_LABELS,
        CATEGORY_LABELS,
        RESULT_STATUS_LABELS,
        DEFAULTS,
        escapeHtml,
        statusLabel,
        resultStatusLabel,
        formatDate,
        formatPrintedAt,
        competitionHeader,
        rosterRows,
        rosterModel,
        resultModel,
        summaryText,
        headerCells,
        rowCells,
        toHtml
    };
});
