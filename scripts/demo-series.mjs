/* 示範系列賽的一鍵建立與移除（v3.9.1）
 *
 * 為什麼需要這支：系列賽總積分要「兩場以上同一個系列」才驗得出來，
 * 而線上平常沒有這種資料。這支腳本用**自家 API**（不是直連資料庫）建立一個
 * 明確標示「【示範】」的兩場系列賽、報名、成績與公布，
 * 讓使用者可以自己點進去看排行長什麼樣子；驗完用 `--remove` 一次清掉。
 *
 * 建立後會直接讀回 `GET /api/series/:id/standings` 印出排行（自己驗自己，不靠宣稱）。
 *
 * 用法：
 *   node scripts/demo-series.mjs                # 建立（已存在會拒絕，除非 --force）
 *   node scripts/demo-series.mjs --remove       # 移除所有「【示範】…」的賽事與其資料
 *   node scripts/demo-series.mjs --site http://127.0.0.1:3000
 *
 * 原則：只讀 .env 的 JWT_SECRET 簽短效權杖；不印出任何機密；不寫任何本機檔案。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const { loadEnv, ownerToken, resolveSite, apiRequest, parseArgv } = require('./lib/cm-api.js');

const ROOT = path.join(import.meta.dirname, '..');
const PREFIX = '【示範】';
const NAMES = ['示範小明', '示範阿華', '示範小美', '示範阿德'];
const LATE = '示範阿強';   // 只在第二站出賽且未完賽 → 舊版（v3.9.0）會在系列排行裡整筆消失

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d; };

async function main() {
    const { flag, opt } = parseArgv(process.argv.slice(2));
    const env = loadEnv(ROOT);
    const token = ownerToken(env);
    const site = resolveSite(opt('--site'));
    if (!token) {
        console.error('❌ .env 裡沒有 JWT_SECRET，無法簽發管理權杖（不會直接連資料庫）');
        process.exit(1);
    }
    const api = (p, opts = {}) => apiRequest(site, p, { token, ...opts });
    console.log(`🌐 ${site}`);

    const list = await api('/api/competitions');
    if (!list.ok || !Array.isArray(list.body)) {
        console.error(`❌ 讀不到賽事清單（HTTP ${list.status}）`);
        process.exit(1);
    }
    const mine = list.body.filter((c) => String(c.name || '').startsWith(PREFIX));
    const dateA = fmt(shift(-7));      // 上一週：成績已登錄，用來驗「跨場次累加」
    const dateB = fmt(shift(0));       // 今天：由週期自動建立的第二場

    if (flag('--remove')) {
        if (!mine.length) { console.log('ℹ️  沒有「' + PREFIX + '」開頭的賽事，不需移除'); return; }
        for (const c of mine) {
            const res = await api(`/api/competitions/${c.id}`, { method: 'DELETE' });
            console.log(`${res.ok ? '🗑️ ' : '❌'} ${c.id} ${c.name}（HTTP ${res.status}）`);
        }
        const after = await api('/api/competitions');
        const left = (after.body || []).filter((c) => String(c.name || '').startsWith(PREFIX));
        console.log(left.length ? `❌ 還有 ${left.length} 筆沒刪掉` : '✅ 示範賽事已全部移除（可在後台「回收筒」永久刪除）');
        return;
    }

    if (mine.length && !flag('--force')) {
        console.log(`ℹ️  已經有 ${mine.length} 筆示範賽事（${mine.map((c) => c.id).join('、')}），要重建請加 --force`);
        const id = mine.find((c) => !c.recurrence_parent_id) || mine[0];
        await printStandings(api, id.id);
        return;
    }
    if (mine.length && flag('--force')) {
        for (const c of mine) await api(`/api/competitions/${c.id}`, { method: 'DELETE' });
        console.log(`🗑️  已先移除舊的 ${mine.length} 筆示範賽事`);
    }

    /* ① 建立第一站（系列的根本）＋ 設定週期 → 讓它成為一個「系列」 */
    const createPayload = {
        name: `${PREFIX}秋季系列 第一站`,
        date: dateA, time: '09:00', end_date: dateA, end_time: '16:00',
        location: '澳門（示範場地）',
        description: '這一場是系統自動建立的示範資料，用來驗證「系列賽總積分」。看完可以請助理一鍵移除。',
        is_registration_open: false,
        series_points: { points: [10, 8, 6, 5, 4, 3, 2, 1], count_best: 0, note: '示範：第 1 名 10 分' }
    };
    const created = await api('/api/competitions', { method: 'POST', body: createPayload });
    if (!created.ok) { console.error('❌ 建立第一站失敗：', created.text?.slice(0, 300)); process.exit(1); }
    const rootId = created.body.id;
    console.log(`① 第一站已建立：id ${rootId}（${dateA}）`);

    // 系列積分設定（用「更新賽事」這條真實路徑再寫一次，確認 PUT 也吃這個欄位）
    const cfg = await api(`/api/competitions/${rootId}`, {
        method: 'PUT',
        body: {
            name: createPayload.name, date: dateA, time: '09:00', end_date: dateA, end_time: '16:00',
            location: createPayload.location, is_registration_open: false,
            series_points: { points: [10, 8, 6, 5, 4, 3, 2, 1], count_best: 0, note: '示範：第 1 名 10 分' }
        }
    });
    console.log(`   ${cfg.ok ? '✅' : '❌'} 系列積分設定寫入（HTTP ${cfg.status}${cfg.ok ? '' : '：' + String(cfg.text || '').slice(0, 120)}）`);

    const recur = await api(`/api/competitions/${rootId}/recurrence`, { method: 'POST', body: { recurrence: 'weekly' } });
    console.log(`   ${recur.ok ? '✅' : '❌'} 設定每週週期（HTTP ${recur.status}）`);

    /* ② 由週期建立第二站（真實路徑：週期建立下一場，不是硬塞資料庫欄位） */
    const next = await api(`/api/competitions/${rootId}/recurrence/next`, { method: 'POST', body: {} });
    // 201 直接回新賽事本身（created_from／next_date 是附加欄位）
    const childId = next.ok && next.body && next.body.id ? next.body.id : null;
    if (!childId) {
        console.error(`❌ 建立第二站失敗（HTTP ${next.status}）：`, (next.body && (next.body.error || next.body.reason)) || next.text?.slice(0, 200));
        process.exit(1);
    }
    console.log(`② 第二站已由週期建立：id ${childId}（${dateB}）`);
    // 週期建立時會沿用第一站的名稱 → 改成「第二站」，系列裡才看得出兩場的差別
    const renamed = await api(`/api/competitions/${childId}`, {
        method: 'PUT',
        body: {
            name: `${PREFIX}秋季系列 第二站`, date: dateB, time: '09:00', end_date: dateB, end_time: '16:00',
            location: '澳門（示範場地）', is_registration_open: false
        }
    });
    console.log(`   ${renamed.ok ? '✅' : '❌'} 第二站改名為「${PREFIX}秋季系列 第二站」（HTTP ${renamed.status}）`);

    /* ③ 兩場各報名 4 人（現場代報名，不需要真的有帳號） */
    const regs = { [rootId]: [], [childId]: [] };
    for (const compId of [rootId, childId]) {
        const names = compId === childId ? [...NAMES, LATE] : NAMES;
        for (const name of names) {
            const r = await api(`/api/competitions/${compId}/onsite-registration`, { method: 'POST', body: { username: name } });
            if (!r.ok) { console.error(`   ❌ ${compId} 代報名 ${name}：${r.status} ${r.text?.slice(0, 120)}`); continue; }
            regs[compId].push({ id: r.body.registration ? r.body.registration.id : r.body.id, name });
        }
        console.log(`③ ${compId} 已報名 ${regs[compId].length} 人`);
    }

    /* ④ 成績：第一站 1~4 名；第二站「示範小美」「示範阿強」未完賽（超表 0 分，驗證不會整筆消失） */
    const raceA = regs[rootId].map((r, i) => ({
        registration_id: r.id, rank: i + 1, status: 'finished', score_text: `1${i + 2}:${30 - i * 7}.0`
    }));
    const raceB = regs[childId].map((r, i) => (
        r.name === '示範小美'
            ? { registration_id: r.id, status: 'dnf', note: '示範：未完賽（同系列另一場有名次）' }
            : r.name === LATE
                ? { registration_id: r.id, status: 'dnf', note: '示範：未完賽（只有這一場→ 舊版會整筆消失）' }
            : { registration_id: r.id, rank: i + 1, status: 'finished', score_text: `1${i + 3}:1${i}.0` }
    ));
    for (const [compId, rows] of [[rootId, raceA], [childId, raceB]]) {
        const put = await api(`/api/competitions/${compId}/results`, { method: 'PUT', body: { results: rows } });
        if (!put.ok) { console.error(`   ❌ 登錄成績 ${compId}：${put.status} ${put.text?.slice(0, 200)}`); continue; }
        const pub = await api(`/api/competitions/${compId}/results/publish`, { method: 'POST', body: { confirm: true } });
        console.log(`④ ${compId} 成績已登錄並${pub.ok ? '公布' : '（公布失敗 ' + pub.status + '）'}`);
    }

    /* ⑤ 讀回排行：自己驗自己 */
    await printStandings(api, rootId);
    console.log(`\n🔗 在系統裡看：${site}/#c${rootId}（第一站）、${site}/#c${childId}（第二站）`);
    console.log('   移除：node scripts/demo-series.mjs --remove');
}

async function printStandings(api, seriesId) {
    const res = await api(`/api/series/${seriesId}/standings`);
    if (!res.ok) { console.log(`❌ 讀排行失敗（HTTP ${res.status}）`); return; }
    const b = res.body;
    console.log(`\n📊 系列「${b.series.name}」共 ${b.race_count} 場｜計分 ${JSON.stringify(b.config.points)}${b.config.count_best ? `｜只取最好 ${b.config.count_best} 場` : ''}`);
    b.standings.forEach((r) => {
        const detail = (r.races || []).map((x) => (x.rank ? `第${x.rank}名(+${x.points})` : `${x.status || '未完成'}(+0)`)).join(' ');
        console.log(`   ${r.position}. ${r.username}｜總分 ${r.total}｜出賽 ${r.race_count} 場｜${detail}`);
    });
    if (!b.standings.length) console.log('   （還沒有名次）');
}

main().catch((err) => { console.error('❌ 執行失敗：', err.message); process.exit(1); });
