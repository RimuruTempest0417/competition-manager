#!/usr/bin/env node
/* 錯誤日誌自動巡檢（v2.14.0）
 *
 * 做什麼：
 *   1. 讀取線上錯誤日誌（透過自家 /api/admin/error-logs，不直接連資料庫，因此開啟 RLS 後照樣可用）
 *   2. 依 error_type 分組統計：次數、首次／最後發生、未處理數、嚴重程度、範例訊息
 *   3. 自動分類並給出「建議動作」，比對 Roadmap 現有內容，標示「已排入 Roadmap」或「新增（待決定）」
 *   4. 產出 docs/錯誤日誌分析.md（完整報告），並更新 docs/功能總覽與規劃.md 的
 *      「## 九、自動偵測到的問題（待修復清單）」整節
 *   5. **把剛剛讀到的那批（未處理的）紀錄標記為已處理**（v2.17.0）：
 *      呼叫 POST /api/admin/error-logs/resolve，resolved_by 記為巡檢身分，
 *      並在稽核日誌留下 RESOLVE_ERROR_LOGS。這樣清單不會一直累積同一批舊訊息，
 *      首頁提示橫幅也才會回到「沒有未處理錯誤」——下一批新錯誤照樣會再提示。
 *      （想只看不動資料就用 `--no-resolve`。）
 *   6. 加 --upload 時，再把文件推上 Google Doc（呼叫 scripts/doc-sync.py）
 *
 * 用法：
 *   node scripts/error-log-triage.js                 # 讀取 → 分析 → 標記已處理 → 更新檔案
 *   node scripts/error-log-triage.js --no-resolve    # 只讀取／分析，不標記已處理
 *   node scripts/error-log-triage.js --upload        # 同時更新 Google Doc
 *   node scripts/error-log-triage.js --dry-run       # 只印摘要，不寫任何檔案、不標記
 *   node scripts/error-log-triage.js --url http://127.0.0.1:3200
 *   node scripts/error-log-triage.js --token <JWT>   # 不自己簽發權杖時使用
 *
 * 權杖來源：本機 .env 的 JWT_SECRET（簽發短效權杖，只在本機使用，不會外傳）。
 * 可用環境變數覆寫簽發對象：TRIAGE_USER_ID / TRIAGE_USERNAME / TRIAGE_ROLE（預設网站擁有者）。
 *
 * 為什麼是「透過 API」而不是直連資料庫：資料庫即將啟用 RLS，anon key 會被完全擋下；
 * 走自家 API 只需要能簽出管理權杖，且完全不會把金鑰帶進腳本輸出。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
// v2.18.0：讀 .env 與簽權杖改用共用工具（scripts/lib/cm-api.js），避免三支腳本各寫一份
const { loadEnv, ownerToken: signOwnerToken } = require('./lib/cm-api');

const ROOT = path.join(__dirname, '..');
const MD_PATH = path.join(ROOT, 'docs', '功能總覽與規劃.md');
const REPORT_PATH = path.join(ROOT, 'docs', '錯誤日誌分析.md');
const SECTION_HEADING = '## 九、自動偵測到的問題（待修復清單）';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SITE = (opt('--url', process.env.TRIAGE_URL || 'https://competition-manager-hazel.vercel.app')).replace(/\/+$/, '');
const DRY_RUN = flag('--dry-run');
const UPLOAD = flag('--upload');
// v2.17.0：預設「讀取後順手標記已處理」，--no-resolve 可只看不動
const RESOLVE = !flag('--no-resolve');
const RESOLVE_CHUNK = 500;
const NOW = Date.now();

/* ---------- 讀取設定（loadEnv 由 scripts/lib/cm-api.js 提供） ---------- */

/* ---------- 分類規則（純資料，方便測試與調整） ---------- */
const RULES = [
    { match: /^unhandled_server_error$/, label: '未預期的伺服器錯誤', action: '看範例訊息定位來源；若重複出現，加入單元測試防回歸', priority: '高' },
    { match: /^fetch_(error_logs|competitions|registrations|teams|push)/, label: '讀取資料失敗', action: '檢查資料庫查詢與欄位探測邏輯（可能與 migration 狀態有關）', priority: '中' },
    { match: /login_lockout|login_ip_throttled/, label: '登入失敗鎖定（安全事件）', action: '多為有人在猜密碼；確認是否為正常使用者打錯，必要時封鎖來源', priority: '中' },
    { match: /malformed_json_body|request_body_too_large/, label: '用戶端請求錯誤（v2.14.0 已分流為 4xx）', action: '正常不需修；同一來源大量出現代表有人在探測，再考慮封鎖', priority: '低' },
    { match: /^auth_invalid_token/, label: '權杖無效／過期', action: '多半是使用者停留過久，屬正常；若同一來源大量出現再處理', priority: '低' },
    { match: /login_error|register_user_error|change_password_error/, label: '帳號流程錯誤', action: '檢查登入／註冊／改密碼流程的例外處理', priority: '高' },
    { match: /password_hash_upgrade_error/, label: '密碼雜湊升級失敗', action: '檢查資料庫寫入權限與欄位狀態', priority: '高' },
    { match: /^push_/, label: '推播相關', action: '檢查訂閱狀態、VAPID 金鑰與 cron 執行結果', priority: '中' },
    { match: /screenshot|frontend|client|^js_|^ui_/, label: '前端回報', action: '依裝置與訊息判斷前端相容性問題', priority: '中' },
    { match: /migration|missing_column|column/, label: '資料庫結構（migration）', action: '確認對應 migration 是否已執行', priority: '高' }
];

function classify(errorType, sampleMessage = '') {
    const t = String(errorType || 'unknown');
    for (const r of RULES) {
        if (r.match.test(t)) return { label: r.label, action: r.action, priority: r.priority };
    }
    if (/migration|column .* does not exist/i.test(sampleMessage)) {
        return { label: '資料庫結構（migration）', action: '確認對應 migration 是否已執行', priority: '高' };
    }
    return { label: '其他', action: '先看範例訊息判斷影響範圍，再決定是否排入 Roadmap', priority: '中' };
}

/* ---------- 分組統計（純函式，可單元測試） ---------- */
function groupErrorLogs(logs, nowMs = Date.now()) {
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const groups = new Map();

    for (const log of logs || []) {
        const type = String(log.error_type || 'unknown');
        if (!groups.has(type)) {
            groups.set(type, {
                error_type: type, count: 0, unresolved: 0, last24h: 0, last7d: 0,
                first_at: null, last_at: null, severities: {}, sample: '', paths: {}
            });
        }
        const g = groups.get(type);
        g.count++;
        if (log.resolved !== true) g.unresolved++;
        const at = new Date(log.created_at).getTime();
        if (Number.isFinite(at)) {
            if (!g.first_at || at < new Date(g.first_at).getTime()) g.first_at = log.created_at;
            if (!g.last_at || at > new Date(g.last_at).getTime()) g.last_at = log.created_at;
            if (at >= dayAgo) g.last24h++;
            if (at >= weekAgo) g.last7d++;
        }
        const sev = log.severity || 'error';
        g.severities[sev] = (g.severities[sev] || 0) + 1;
        if (!g.sample && log.message) g.sample = String(log.message).slice(0, 160);
        if (log.path) g.paths[log.path] = (g.paths[log.path] || 0) + 1;
    }

    return [...groups.values()]
        .map((g) => {
            const meta = classify(g.error_type, g.sample);
            return Object.assign(g, {
                label: meta.label, action: meta.action, priority: meta.priority,
                top_path: Object.keys(g.paths).sort((a, b) => g.paths[b] - g.paths[a])[0] || ''
            });
        })
        .sort((a, b) => (b.unresolved - a.unresolved) || (b.count - a.count));
}

/* ---------- 標記已處理（v2.17.0） ---------- */
// 只挑「還沒被處理」的紀錄，並去重；已處理的不必再送（也讓重跑變得安全／可重複）
function collectResolvableIds(logs) {
    const ids = [];
    for (const log of logs || []) {
        if (log && log.resolved !== true && log.id !== undefined && log.id !== null) ids.push(log.id);
    }
    return [...new Set(ids)];
}

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

// 分批呼叫 API（單次上限 500，超過就切開）；回傳總共標記了幾筆
async function resolveErrorLogs({ site, token, ids, fetchImpl = fetch, chunkSize = RESOLVE_CHUNK }) {
    let resolved = 0;
    const batches = chunk(ids, chunkSize);
    for (const batch of batches) {
        const res = await fetchImpl(`${site}/api/admin/error-logs/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ids: batch })
        });
        if (!res.ok) {
            throw new Error(`標記已處理失敗（HTTP ${res.status}）`);
        }
        const body = await res.json();
        resolved += Number(body.resolved) || 0;
    }
    return { resolved, batches: batches.length };
}

const PRIORITY_ORDER = { 高: 0, 中: 1, 低: 2 };

/* ---------- 產生 Markdown 章節（純函式） ---------- */
function renderSection(groups, roadmapText = '', nowMs = Date.now(), resolveInfo = null) {
    const stamp = new Date(nowMs).toLocaleString('zh-TW', { timeZone: 'Asia/Macau', hour12: false });
    const lines = [
        SECTION_HEADING,
        '',
        `> 本節由 \`scripts/error-log-triage.js\` 自動產生並覆寫（最後更新：${stamp}）。資料來源：線上錯誤日誌（透過自家 API 讀取）。`,
        '> 狀態欄的「新增」代表我還沒看到你決定優先度；「已排入 Roadmap」代表第八節已有對應項目。',
        ''
    ];
    if (resolveInfo) {
        lines.push(`> 🏷️ 本輪巡檢已把讀到的 ${resolveInfo.resolved} 筆未處理紀錄標記為已處理（${resolveInfo.by}）。首頁提示橫幅只會針對「下一批新錯誤」再提醒。`, '');
    }

    if (!groups.length) {
        lines.push('目前沒有任何錯誤日誌紀錄。✅', '');
        return lines.join('\n');
    }

    const actionable = groups.filter((g) => g.priority !== '低' || g.unresolved > 0);
    lines.push('### 9.1 需要處理的問題');
    lines.push('');
    lines.push('| 狀態 | 優先 | 錯誤類型 | 次數 | 未處理 | 近 24 小時 | 最後發生 | 建議動作 | 範例訊息 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const g of actionable.sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || (b.count - a.count))) {
        const inRoadmap = roadmapText.includes(g.error_type) || roadmapText.includes(g.label);
        const state = inRoadmap ? '已排入 Roadmap' : (g.unresolved > 0 ? '**新增**' : '已處理／觀察中');
        const last = g.last_at ? new Date(g.last_at).toLocaleString('zh-TW', { timeZone: 'Asia/Macau', hour12: false }) : '—';
        const sample = (g.sample || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 90);
        lines.push(`| ${state} | ${g.priority} | \`${g.error_type}\` | ${g.count} | ${g.unresolved} | ${g.last24h} | ${last} | ${g.action} | ${sample || '—'} |`);
    }
    lines.push('');

    const quiet = groups.filter((g) => !actionable.includes(g));
    if (quiet.length) {
        lines.push('### 9.2 低優先／僅供觀察');
        lines.push('');
        lines.push('| 錯誤類型 | 次數 | 最後發生 | 說明 |');
        lines.push('|---|---|---|---|');
        for (const g of quiet) {
            const last = g.last_at ? new Date(g.last_at).toLocaleDateString('zh-TW', { timeZone: 'Asia/Macau' }) : '—';
            lines.push(`| \`${g.error_type}\` | ${g.count} | ${last} | ${g.label}（多為正常現象，累積過多再處理） |`);
        }
        lines.push('');
    }

    const total = groups.reduce((s, g) => s + g.count, 0);
    const unresolved = groups.reduce((s, g) => s + g.unresolved, 0);
    lines.push(`**統計**：共 ${groups.length} 種錯誤類型、${total} 筆紀錄，其中未處理 ${unresolved} 筆。`);
    lines.push('');
    return lines.join('\n');
}

/* ---------- 以標題為界，取代整節（可承受 Google Doc 往返，不需要 HTML 註解標記） ---------- */
function replaceSection(md, sectionText) {
    const idx = md.indexOf(SECTION_HEADING);
    if (idx === -1) {
        return md.replace(/\s*$/, '') + '\n\n' + sectionText;
    }
    const rest = md.slice(idx + SECTION_HEADING.length);
    const nextMatch = rest.match(/\n## /);
    const before = md.slice(0, idx);
    const after = nextMatch ? rest.slice(nextMatch.index) : '';
    return before + sectionText.replace(/\s*$/, '') + '\n' + after;
}

/* ---------- 身分（標記已處理時會記在 resolved_by 與稽核日誌） ---------- */
const resolveIdentity = process.env.TRIAGE_USERNAME || 'rimuru';

/* ---------- 取得權杖（共用工具；仍支援 --token 覆寫） ---------- */
function ownerToken(env) {
    return signOwnerToken(env, { token: opt('--token', '') });
}

async function main() {
    const env = loadEnv(ROOT);
    const token = ownerToken(env);
    if (!token) {
        console.error('❌ 找不到 JWT_SECRET（請確認 .env），也沒有用 --token 指定權杖');
        process.exit(2);
    }

    const res = await fetch(`${SITE}/api/admin/error-logs?limit=500`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        console.error(`❌ 讀取錯誤日誌失敗（HTTP ${res.status}）`);
        process.exit(1);
    }
    const body = await res.json();
    const logs = body.logs || [];
    const groups = groupErrorLogs(logs, NOW);

    console.log(`\n🐞 錯誤日誌巡檢：${SITE}`);
    console.log(`   取得 ${logs.length} 筆紀錄、${groups.length} 種錯誤類型、未處理 ${body.unresolved_in_page ?? '?'} 筆（本頁）`);
    for (const g of groups.slice(0, 10)) {
        console.log(`   ${g.priority === '高' ? '🔴' : g.priority === '中' ? '🟡' : '⚪'} ${g.error_type}：${g.count} 次（未處理 ${g.unresolved}，近 24h ${g.last24h}）→ ${g.label}`);
    }

    if (DRY_RUN) {
        console.log('\n（--dry-run：未寫入任何檔案、也不會標記已處理）');
        return;
    }

    /* ---------- 標記已處理（v2.17.0） ----------
       為什麼放在寫檔案「之前」：分析結果會記錄「本輪標記了幾筆」，
       而且標記失敗時仍要把報告寫出來（報告本身就是那批紀錄的永久存檔）。 */
    let resolveInfo = null;
    const resolvableIds = collectResolvableIds(logs);
    if (!RESOLVE) {
        console.log(`\n🏷️  （--no-resolve：維持 ${resolvableIds.length} 筆未處理，未標記）`);
    } else if (resolvableIds.length === 0) {
        console.log('\n🏷️  沒有未處理的紀錄需要標記（上一輪已清）');
        resolveInfo = { resolved: 0, by: resolveIdentity, batches: 0 };
    } else {
        try {
            const result = await resolveErrorLogs({ site: SITE, token, ids: resolvableIds });
            resolveInfo = { resolved: result.resolved, by: resolveIdentity, batches: result.batches };
            console.log(`\n🏷️  已標記 ${result.resolved} 筆為已處理（resolved_by=${resolveIdentity}，分 ${result.batches} 批）`);
        } catch (err) {
            console.warn(`\n⚠️  標記已處理失敗：${err.message}（報告仍會照常產出；下次巡檢會再試）`);
            resolveInfo = { resolved: 0, by: resolveIdentity, batches: 0, error: err.message };
        }
    }

    // 完整報告
    const report = [
        '# 錯誤日誌分析（自動產生）',
        '',
        `- 產生時間：${new Date(NOW).toLocaleString('zh-TW', { timeZone: 'Asia/Macau', hour12: false })}`,
        `- 來源：${SITE}/api/admin/error-logs`,
        `- 取得筆數：${logs.length}（上限 500）`,
        `- 標記已處理：${resolveInfo ? `${resolveInfo.resolved} 筆（by ${resolveInfo.by}）` : '未執行'}`,
        '',
        renderSection(groups, '', NOW, resolveInfo)
    ].join('\n');
    fs.writeFileSync(REPORT_PATH, report);
    console.log(`\n💾 已寫入 ${path.relative(ROOT, REPORT_PATH)}`);

    // 更新主要規劃文件的第九節
    if (fs.existsSync(MD_PATH)) {
        const md = fs.readFileSync(MD_PATH, 'utf8');
        const updated = replaceSection(md, renderSection(groups, md, NOW, resolveInfo));
        fs.writeFileSync(MD_PATH, updated);
        console.log(`💾 已更新 ${path.relative(ROOT, MD_PATH)} 的「九、自動偵測到的問題」`);
    }

    if (UPLOAD) {
        console.log('☁️  上傳 Google Doc…');
        try {
            execFileSync('python3', [path.join(__dirname, 'md-to-docs-html.py')], { cwd: ROOT, stdio: 'inherit' });
            execFileSync('python3', [path.join(__dirname, 'doc-sync.py'), '--upload', 'docs/功能總覽與規劃.html'], { cwd: ROOT, stdio: 'inherit' });
        } catch (err) {
            console.error('❌ 上傳失敗：', err.message);
            process.exit(1);
        }
    }
}

module.exports = { groupErrorLogs, classify, renderSection, replaceSection, SECTION_HEADING, collectResolvableIds, chunk, resolveErrorLogs };

if (require.main === module) {
    main().catch((err) => { console.error('❌ 執行失敗：', err.message); process.exit(1); });
}
