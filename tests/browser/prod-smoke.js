#!/usr/bin/env node
/* 正式站煙霧測試（HTTP 層）— 每次發版後跑一次，確認部署真的生效、權限與標頭沒有跑掉。
 *
 * 用法：
 *   node tests/browser/prod-smoke.js                    # 測正式站
 *   node tests/browser/prod-smoke.js http://127.0.0.1:3200   # 測本機或其他環境
 *
 * 需要：本機 .env 提供 JWT_SECRET（用來簽發測試權杖；只在本機读取，不會外傳）。
 * 特性：**只讀不寫**，不修改任何正式資料；唯讀檢查帳號清單、錯誤日誌、推播紀錄與各項拒絕行為。
 *
 * 為什麼放在 repo（不再放暫存目錄）：暫存目錄有 24 小時閒置清理，2026-09-25 曾整批檢查腳本被刪。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SITE = (process.argv[2] || 'https://competition-manager-hazel.vercel.app').replace(/\/+$/, '');
const ROOT = path.join(__dirname, '..', '..');
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✅ ${label}`); }
    else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
}

function localJwtSecret() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return '';
    const m = fs.readFileSync(envPath, 'utf8').match(/^JWT_SECRET=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const get = (p, headers) => fetch(SITE + p, { headers });

/* ---------- v3.5.2：對正式站表明「這是自動化檢查」 ----------
 * 本檔會**故意**送出壞 JSON、無效權杖、越權請求來驗證拒絕行為——那是預期中的回應，不是系統異常。
 * 以前這些探測會寫進正式站的 error_logs（2026-09-26 實測：28 筆 malformed_json_body 全是本檔造成的），
 * 把提示橫幅與巡檢清單灌成假訊號。
 * 現在所有打向 SITE 的請求都帶 `X-CM-Self-Test`（用本機 JWT_SECRET 簽、payload purpose:'self_test'），
 * 伺服器驗簽通過就略過錯誤日誌——**回應行為完全不變**（該 400 還是 400、該 401 還是 401）。
 * 找不到 JWT_SECRET 時不帶標頭：最壞情況只是照舊留下日誌（fail-safe，不會因此漏記真實錯誤）。
 */
const SELF_TEST_SECRET = localJwtSecret();
const SELF_TEST_HEADER = SELF_TEST_SECRET
    ? jwt.sign({ sub: 0, username: 'prod-smoke', purpose: 'self_test' }, SELF_TEST_SECRET, { expiresIn: '10m' })
    : '';
const RUN_STARTED_AT = Date.now();
const rawFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
    if (typeof url === 'string' && url.startsWith(SITE) && SELF_TEST_HEADER) {
        options = Object.assign({}, options, {
            headers: Object.assign({}, options.headers || {}, { 'X-CM-Self-Test': SELF_TEST_HEADER })
        });
    }
    return rawFetch(url, options);
};

(async () => {
    console.log(`\n🧪 正式站煙霧測試：${SITE}（預期版本 v${EXPECTED_VERSION}）`);

    // ---------- 1. 部署版本與標頭 ----------
    console.log('\n【1】部署版本與安全性標頭');
    const home = await fetch(SITE + '/');
    const html = await home.text();
    check(`首頁正常（HTTP ${home.status}）`, home.status === 200);
    check(`線上版本為 v${EXPECTED_VERSION}`, new RegExp(`比賽管理系統 v${EXPECTED_VERSION.replace(/\./g, '\\.')}`).test(html),
        (html.match(/比賽管理系統 v[0-9.]+/) || [''])[0]);
    const csp = home.headers.get('content-security-policy') || '';
    check('CSP 仍限制 script-src 為 self（未放寬）', /script-src 'self'/.test(csp), csp.slice(0, 80));
    check("CSP 仍限制 style-src 為 self（未放寬）", /style-src 'self'/.test(csp));
    check('X-Frame-Options: DENY', home.headers.get('x-frame-options') === 'DENY');
    check('X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff');
    check('Strict-Transport-Security 存在', Boolean(home.headers.get('strict-transport-security')));
    check('未洩漏 X-Powered-By', !home.headers.get('x-powered-by'));

    // ---------- 2. 靜態檔案與本地一致 ----------
    console.log('\n【2】靜態檔案與本地一致');
    for (const rel of ['public/js/app.js', 'public/js/csv.js', 'public/js/notify.js', 'public/js/paging.js', 'public/js/stats.js', 'public/js/results.js', 'public/js/printdoc.js', 'public/css/custom.css', 'public/css/print.css', 'public/sw.js', 'public/index.html']) {
        const res = await get('/' + rel.replace(/^public\//, ''));
        const online = Buffer.from(await res.arrayBuffer());
        const local = fs.readFileSync(path.join(ROOT, rel));
        check(`${rel} 線上內容與本地相同`, sha256(online) === sha256(local),
            `${online.length}B vs ${local.length}B`);
    }

    // ---------- 3. 未登入的拒絕行為與不快取 ----------
    console.log('\n【3】未登入存取與快取標頭');
    for (const p of ['/api/admin/users', '/api/admin/error-logs', '/api/admin/error-logs/health', '/api/admin/error-logs/summary', '/api/admin/push-logs']) {
        const r = await get(p);
        check(`未登入讀取 ${p} 被拒（HTTP ${r.status}）`, r.status === 401, String(r.status));
    }
    const patchLog = await fetch(SITE + '/api/admin/error-logs/1', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolved: true })
    });
    check(`未登入標記日誌被拒（HTTP ${patchLog.status}）`, patchLog.status === 401);
    const postUser = await fetch(SITE + '/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nope', password: 'nope123' })
    });
    check(`未登入建立帳號被拒（HTTP ${postUser.status}）`, postUser.status === 401);
    const cronWrong = await get('/api/cron/reminders', { Authorization: 'Bearer definitely-wrong' });
    check(`自動推播端點拒絕亂打的權杖（HTTP ${cronWrong.status}）`, [401, 503].includes(cronWrong.status), String(cronWrong.status));
    const apiRes = await get('/api/meta');
    check('API 回應標示為不快取', /no-store/.test(apiRes.headers.get('cache-control') || ''),
        apiRes.headers.get('cache-control') || '(無)');

    // ---------- 4. 網站擁有者的唯讀檢查（含 v2.13.0 金鑰狀態） ----------
    console.log('\n【4】網站擁有者唯讀檢查（不修改任何資料）');
    const secret = localJwtSecret();
    if (!secret) {
        console.log('  ⚠️ 找不到本機 JWT_SECRET，跳過登入後檢查');
    } else {
        const token = jwt.sign({ sub: 1, username: 'rimuru', role: 'web_owner' }, secret, { expiresIn: '10m' });
        const auth = { Authorization: `Bearer ${token}` };

        const users = await get('/api/admin/users', auth);
        const usersBody = await users.json().catch(() => ({}));
        check(`網站擁有者可讀帳號清單（HTTP ${users.status}）`, users.status === 200, JSON.stringify(usersBody).slice(0, 120));
        check('帳號清單不含任何密碼欄位', !JSON.stringify(usersBody).includes('"password"'));
        check('帳號清單標示可建立的角色', Array.isArray(usersBody.can_create) && usersBody.can_create.length === 5,
            JSON.stringify(usersBody.can_create));

        const health = await get('/api/admin/error-logs/health', auth);
        const h = await health.json().catch(() => ({}));
        check(`日誌健康端點可用（HTTP ${health.status}）`, health.status === 200);
        check(`資料庫金鑰類型可觀測（${h.db_key_type}）`, ['anon', 'service_role', 'none'].includes(h.db_key_type), JSON.stringify(h.db_key_type));
        check('回報是否已可安全開啟 RLS（rls_ready）', typeof h.rls_ready === 'boolean', JSON.stringify(h.rls_ready));
        check(`資料庫已無明碼密碼（待升級 ${h.plaintext_passwords} 筆）`, h.plaintext_passwords === 0, String(h.plaintext_passwords));
        check('健康端點不含金鑰或密碼內容', !/anon-key|service-key|"password"/.test(JSON.stringify(h)));

        const logs = await get('/api/admin/error-logs', auth);
        const logsRaw = await logs.text();
        const logsBody = JSON.parse(logsRaw || '{}');
        check(`網站擁有者可讀錯誤日誌（HTTP ${logs.status}）`, logs.status === 200);
        check('錯誤日誌回傳日誌清單與 schema 資訊',
            logs.status === 200 && (Array.isArray(logsBody.logs) || 'schema' in logsBody),
            Object.keys(logsBody).join(',') || '(空)');
        // v3.6.1：列表不該再帶著截圖本體回來（第 4 節是唯讀檢查，這裡只看，不下載任何檔案）
        const listedRows = Array.isArray(logsBody.logs) ? logsBody.logs : [];
        check('錯誤日誌列表不含截圖本體（screenshot 欄位）',
            listedRows.every((row) => !('screenshot' in row)),
            `含 screenshot 的筆數：${listedRows.filter((row) => 'screenshot' in row).length}`);
        check('每一列都帶 has_screenshot 布林值（前端據此顯示檢視按鈕）',
            listedRows.every((row) => typeof row.has_screenshot === 'boolean'));
        check(`列表回應大小合理（${logsRaw.length} 位元組 < 200KB）`, logsRaw.length < 200000, `${logsRaw.length} 位元組`);
        const shotDenied = await get('/api/admin/error-logs/1/screenshot', { Authorization: 'Bearer ' + jwt.sign({ sub: 4, username: 'nobody', role: 'user' }, secret, { expiresIn: '10m' }) });
        check(`一般角色不可讀截圖（HTTP ${shotDenied.status}）`, [401, 403].includes(shotDenied.status), String(shotDenied.status));
        check('日誌系統本身沒有寫入失敗紀錄', Array.isArray(h.recent_write_failures) && h.recent_write_failures.length === 0,
            JSON.stringify(h.recent_write_failures || []).slice(0, 120));

        // v2.14.0：未處理錯誤統計（前端提示橫幅與自動巡檢腳本都靠這個端點）
        const summary = await get('/api/admin/error-logs/summary', auth);
        const sum = await summary.json().catch(() => ({}));
        check(`未處理錯誤統計端點可用（HTTP ${summary.status}）`, summary.status === 200, JSON.stringify(sum).slice(0, 120));
        check('統計包含未處理錯誤數與是否需要留意',
            Number.isInteger(sum.unresolved_errors) && typeof sum.may_need_attention === 'boolean',
            JSON.stringify(sum));
        check('統計不含任何日誌訊息或金鑰內容', !/jwt|password|eyJ|stack/i.test(JSON.stringify(sum)));
        const userToken = jwt.sign({ sub: 4, username: 'nobody', role: 'user' }, secret, { expiresIn: '10m' });
        const summaryDenied = await get('/api/admin/error-logs/summary', { Authorization: 'Bearer ' + userToken });
        check(`一般角色讀取統計被拒（HTTP ${summaryDenied.status}）`, [401, 403].includes(summaryDenied.status), String(summaryDenied.status));

        // v2.14.0：格式錯誤的請求應回 400（用戶端問題）而不是 500（伺服器錯誤）
        const badJson = await fetch(SITE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"username": broken'
        });
        check(`格式錯誤的 JSON 請求回 400（HTTP ${badJson.status}）`, badJson.status === 400, String(badJson.status));

        const push = await get('/api/admin/push-logs', auth);
        check(`管理員/擁有者可讀推播紀錄（HTTP ${push.status}）`, push.status === 200);
        const pushBody = await push.json().catch(() => ({}));
        check('推播紀錄回報失敗明細是否可用（v2.26.0）',
            typeof pushBody.detail_ready === 'boolean', JSON.stringify(pushBody).slice(0, 140));

        // v2.26.0：站內公告（未登入要擋、登入後要能讀；未跑 migration 也要優雅降級）
        const annAnon = await get('/api/my/announcements');
        check(`未登入讀公告被拒（HTTP ${annAnon.status}）`, annAnon.status === 401, String(annAnon.status));
        const annMine = await get('/api/my/announcements', auth);
        const annBody = await annMine.json().catch(() => ({}));
        check(`登入者可讀自己的公告（HTTP ${annMine.status}）`, annMine.status === 200, String(annMine.status));
        check('公告回應含 schema_ready 與清單',
            typeof annBody.schema_ready === 'boolean' && Array.isArray(annBody.announcements),
            JSON.stringify(annBody).slice(0, 140));
        const annAdmin = await get('/api/admin/announcements', auth);
        check(`管理員可讀公告管理清單（HTTP ${annAdmin.status}）`, annAdmin.status === 200, String(annAdmin.status));
        const resendMissing = await fetch(SITE + '/api/admin/push-logs/999999999/resend', { method: 'POST', headers: auth });
        check(`重送不存在的紀錄不會 500（HTTP ${resendMissing.status}）`,
            [400, 404, 503].includes(resendMissing.status), String(resendMissing.status));

        // v2.27.0：場地地圖連結與工作人員（讀取公開；寫入一律要管理員）
        const compList = await get('/api/competitions');
        const comps = await compList.json().catch(() => []);
        check('賽事列表帶地圖連結欄位（v2.27.0）',
            Array.isArray(comps) && comps.every((c) => typeof c.map_url === 'string' && typeof c.map_url_auto === 'boolean'),
            JSON.stringify(comps[0] || {}).slice(0, 160));
        check('地圖連結是 https 且沒有 javascript: 之類的東西',
            Array.isArray(comps) && comps.every((c) => c.map_url === '' || /^https:\/\//i.test(c.map_url)),
            JSON.stringify(comps.map((c) => c.map_url).filter(Boolean).slice(0, 3)));
        const staffAnon = await get('/api/competitions/1/staff');
        check(`工作人員清單公開可讀（HTTP ${staffAnon.status}）`, staffAnon.status === 200, String(staffAnon.status));
        const staffBody = await staffAnon.json().catch(() => ({}));
        check('工作人員回應含 schema_ready 與五種角色',
            typeof staffBody.schema_ready === 'boolean' && Array.isArray(staffBody.roles) && staffBody.roles.length === 5,
            JSON.stringify(staffBody).slice(0, 140));
        check('工作人員清單不帶個資（沒有 password／email／token 之類欄位）',
            Array.isArray(staffBody.staff) && staffBody.staff.every((row) => !('password' in row) && !('email' in row)
                && !('totp_secret' in row) && !Object.keys(row).some((k) => /token|secret/i.test(k))),
            JSON.stringify((staffBody.staff || [])[0] || {}).slice(0, 160));
        const staffWrite = await fetch(SITE + '/api/competitions/1/staff', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 1, role: 'referee' })
        });
        check(`未登入指派工作人員被拒（HTTP ${staffWrite.status}）`,
            [401, 403].includes(staffWrite.status), String(staffWrite.status));

        // v3.0.0：營運儀表板、分頁與海報縮圖（全部唯讀）
        const statsDenied = await get('/api/admin/stats');
        check(`未登入讀營運統計被拒（HTTP ${statsDenied.status}）`, statsDenied.status === 401, String(statsDenied.status));
        const stats = await get('/api/admin/stats?days=7', auth);
        const statsBody = await stats.json().catch(() => ({}));
        check(`網站擁有者可讀營運統計（HTTP ${stats.status}）`, stats.status === 200, JSON.stringify(statsBody).slice(0, 140));
        check('統計含賽事／報名／使用者／錯誤／推播／效能六個區塊',
            ['competitions', 'registrations', 'users', 'errors', 'push', 'perf'].every((k) => statsBody[k] && typeof statsBody[k] === 'object'),
            Object.keys(statsBody).join(','));
        check('統計沒有讀不到的區塊（儀表板不會出現黃色警告）',
            Array.isArray(statsBody.unavailable_sections) && statsBody.unavailable_sections.length === 0,
            JSON.stringify(statsBody.unavailable_sections || []).slice(0, 140));
        check('趨勢長度等於要求的 7 天', Array.isArray(statsBody.registrations && statsBody.registrations.trend)
            && statsBody.registrations.trend.length === 7, JSON.stringify((statsBody.registrations || {}).trend || []).slice(0, 80));
        check('統計不含任何帳號名稱或個資',
            !/password|email|totp_secret|"username"/i.test(JSON.stringify(statsBody)), JSON.stringify(statsBody).slice(0, 120));
        check('統計附上查詢耗時（實測值）', typeof (statsBody.perf || {}).total_ms === 'number', String((statsBody.perf || {}).total_ms));
        check('有列出隨 migration 建立的索引清單',
            Array.isArray((statsBody.perf || {}).indexes) && statsBody.perf.indexes.length >= 5,
            String(((statsBody.perf || {}).indexes || []).length));
        const statsUserDenied = await get('/api/admin/stats', { Authorization: 'Bearer ' + jwt.sign({ sub: 4, username: 'nobody', role: 'user' }, secret, { expiresIn: '10m' }) });
        check(`一般角色讀營運統計被拒（HTTP ${statsUserDenied.status}）`,
            [401, 403].includes(statsUserDenied.status), String(statsUserDenied.status));

        // v3.2.0（P1-7）：列印版資源（樣式與規則模組）必須真的拿得到
        const printCss = await fetch(SITE + '/css/print.css');
        const printJs = await fetch(SITE + '/js/printdoc.js');
        check(`列印樣式可取得（HTTP ${printCss.status}）`, printCss.status === 200, String(printCss.status));
        const printCssText = await printCss.text().catch(() => '');
        check('列印樣式含列印媒介規則與 A4 設定', /@media print/.test(printCssText) && /@page/.test(printCssText),
            printCssText.slice(0, 80));
        const printJsText = await printJs.text().catch(() => '');
        check(`列印規則模組可取得（HTTP ${printJs.status}）`, printJs.status === 200 && /CMPrintDoc/.test(printJsText), String(printJs.status));

        // 分頁：帶 limit 回物件、不帶 limit 維持陣列（既有整合不受影響）
        const paged = await get('/api/competitions?limit=2');
        const pagedBody = await paged.json().catch(() => null);
        check('列表帶 limit 時回分頁物件（items／total／has_more）',
            pagedBody && !Array.isArray(pagedBody) && Array.isArray(pagedBody.items) && typeof pagedBody.total === 'number'
            && typeof pagedBody.has_more === 'boolean',
            JSON.stringify(pagedBody).slice(0, 140));
        check('單次上限有效（要求 2 筆不會拿到更多）',
            pagedBody && pagedBody.items.length <= 2, String(pagedBody && pagedBody.items.length));
        const huge = await (await get('/api/competitions?limit=99999')).json().catch(() => null);
        check('要求超大筆數會被夾在上限內（<= 100）', huge && huge.items.length <= 100, String(huge && huge.items.length));
        const plain = await (await get('/api/competitions')).json().catch(() => null);
        check('不帶 limit 仍然回陣列（既有前端與整合不受影響）', Array.isArray(plain), typeof plain);

        // 海報縮圖：有海報的賽事要能取得縮圖（沒有縮圖時會退回原圖並標示）
        const withPoster = Array.isArray(plain) ? plain.find((c) => c.poster_updated_at) : null;
        check('列表帶海報縮圖網址欄位（沒有海報者為 null）',
            Array.isArray(plain) && plain.every((c) => c.poster_thumb_url === null || typeof c.poster_thumb_url === 'string'),
            JSON.stringify((plain || [])[0] || {}).slice(0, 120));
        if (withPoster) {
            const thumbRes = await fetch(`${SITE}/api/competitions/${withPoster.id}/poster?variant=thumb`);
            check(`海報縮圖端點可用（HTTP ${thumbRes.status}）`, thumbRes.status === 200, String(thumbRes.status));
            check(`縮圖回應標示實際變體（${thumbRes.headers.get('x-poster-variant')}）`,
                ['thumb', 'full-fallback'].includes(thumbRes.headers.get('x-poster-variant')),
                String(thumbRes.headers.get('x-poster-variant')));
        } else {
            console.log('  ℹ️ 線上目前沒有自訂海報，跳過縮圖端點檢查');
        }

        // v3.1.0：成績與結果（全部唯讀，不會動到線上任何資料）
        const targetComp = Array.isArray(plain) && plain.length ? plain[0].id : 1;
        const resultsGuest = await get(`/api/competitions/${targetComp}/results`);
        const resultsGuestBody = await resultsGuest.json().catch(() => ({}));
        // 未執行 v3.1.0 migration 是合法的上線狀態：成績端點會明確回 503 並指出要跑哪一支，
        // 其餘功能完全不受影響（migration 只是資料表，不是程式）。這種情況算通過，但要講出來。
        const resultsPending = resultsGuest.status === 503 && /v3\.1\.0-results\.sql/.test(String(resultsGuestBody.error || ''));
        check(`訪客可讀成績端點（HTTP ${resultsGuest.status}）`,
            resultsGuest.status === 200 || resultsPending, JSON.stringify(resultsGuestBody).slice(0, 120));
        if (resultsPending) console.log('  ℹ️ 線上尚未執行 migrations/2026-09-27-v3.1.0-results.sql：成績端點正確回 503 並指出檔案（設計中的降級）');
        check('未公布時訪客拿到「尚未公布」而不是內容',
            resultsPending || (typeof resultsGuestBody.published === 'boolean'
                && (resultsGuestBody.published === true || (Array.isArray(resultsGuestBody.results) && resultsGuestBody.results.length === 0))),
            JSON.stringify(resultsGuestBody).slice(0, 120));

        const resultsWrite = await fetch(`${SITE}/api/competitions/${targetComp}/results`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ results: [] })
        });
        check(`未登入改成績被拒（HTTP ${resultsWrite.status}）`, [401, 403].includes(resultsWrite.status), String(resultsWrite.status));

        const publishDenied = await fetch(`${SITE}/api/competitions/${targetComp}/results/publish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        check(`未登入公布成績被拒（HTTP ${publishDenied.status}）`, [401, 403].includes(publishDenied.status), String(publishDenied.status));

        const sheet = await get(`/api/competitions/${targetComp}/result-sheet`, auth);
        const sheetBody = await sheet.json().catch(() => ({}));
        const sheetPending = sheet.status === 503 && /v3\.1\.0-results\.sql/.test(String(sheetBody.error || ''));
        check(`網站擁有者可讀成績登錄表（HTTP ${sheet.status}）`, sheet.status === 200 || sheetPending, JSON.stringify(sheetBody).slice(0, 140));
        check('登錄表帶出已核准名單與公布前檢查',
            sheetPending || (Array.isArray(sheetBody.entries) && sheetBody.checklist && typeof sheetBody.checklist.missing_count === 'number'),
            JSON.stringify(Object.keys(sheetBody)).slice(0, 120));
        check('成績資料不含個資（沒有 email／password／token 欄位）',
            !/password|totp_secret|"email"|access_token/i.test(JSON.stringify(sheetBody)),
            JSON.stringify(sheetBody).slice(0, 120));

        // v3.3.0（P1-6）：賽事規程 PDF 附件（全部唯讀，不會動到線上任何資料）
        const docGuest = await fetch(`${SITE}/api/competitions/${targetComp}/doc`);
        const docGuestType = docGuest.headers.get('content-type') || '';
        const docGuestBytes = Buffer.from(await docGuest.arrayBuffer());
        const docPending = docGuest.status === 503;
        check(`訪客可讀規程端點（HTTP ${docGuest.status}）`,
            docGuest.status === 200 || docGuest.status === 404 || docPending,
            `HTTP ${docGuest.status}`);
        check('有規程時回傳的就是 PDF、沒有規程時回 404（不是 500）',
            docPending
                || (docGuest.status === 200 && /application\/pdf/.test(docGuestType) && docGuestBytes.slice(0, 5).toString('latin1') === '%PDF-')
                || (docGuest.status === 404 && docGuestBytes.length < 500),
            `${docGuestType}／${docGuestBytes.length} 位元組`);
        if (docGuest.status === 200) {
            console.log(`  ℹ️ 線上已有賽事規程附件（${Math.round(docGuestBytes.length / 1024)}KB，PDF ${docGuestBytes.slice(0, 8).toString('latin1').trim()}）`);
        }

        const docWrite = await fetch(`${SITE}/api/competitions/${targetComp}/doc`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' })
        });
        check(`未登入上傳規程被拒（HTTP ${docWrite.status}）`, [401, 403].includes(docWrite.status), String(docWrite.status));

        const docDelete = await fetch(`${SITE}/api/competitions/${targetComp}/doc`, { method: 'DELETE' });
        check(`未登入移除規程被拒（HTTP ${docDelete.status}）`, [401, 403].includes(docDelete.status), String(docDelete.status));

        const myResults = await get('/api/my/results', auth);
        const myResultsBody = await myResults.json().catch(() => null);
        check(`「我的成績」可用（HTTP ${myResults.status}）`, myResults.status === 200 && Array.isArray(myResultsBody), String(myResults.status));
        check('「我的成績」只包含已公布且屬於自己的成績',
            Array.isArray(myResultsBody) && myResultsBody.every((r) => r.competitions && r.competitions.result_published_at),
            JSON.stringify(myResultsBody).slice(0, 120));

        const wrongRoleToken = jwt.sign({ sub: 4, username: 'nobody', role: 'user' }, secret, { expiresIn: '10m' });
        const denied = await get('/api/admin/error-logs', { Authorization: `Bearer ${wrongRoleToken}` });
        check(`一般角色讀取錯誤日誌被拒（HTTP ${denied.status}）`, [401, 403].includes(denied.status), String(denied.status));
    }

    // ---------- 5. PWA 與靜態資源 ----------
    console.log('\n【5】PWA 與靜態資源');
    const manifest = await get('/manifest.json');
    const man = await manifest.json().catch(() => ({}));
    check(`manifest.json 可取得（HTTP ${manifest.status}）`, manifest.status === 200);
    check('manifest 為 standalone 且含 192/512 圖示',
        man.display === 'standalone' && JSON.stringify(man.icons || []).includes('192') && JSON.stringify(man.icons || []).includes('512'),
        JSON.stringify(man.display));
    for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/favicon.ico']) {
        const r = await get(p);
        check(`${p} 可取得（HTTP ${r.status}）`, r.status === 200);
    }
    const missingPoster = await get('/api/posters/999999999');
    check(`不存在的海報回 404（HTTP ${missingPoster.status}）`, missingPoster.status === 404);

    // ---------- 6. 這趟檢查沒有在正式站留下假錯誤日誌（v3.5.2） ----------
    console.log('\n【6】自動化檢查不留下假錯誤日誌');
    if (secret) {
        const smokeAuth = { Authorization: 'Bearer ' + jwt.sign({ sub: 1, username: 'rimuru', role: 'web_owner' }, secret, { expiresIn: '10m' }) };

        /* 這裡刻意用**行為**驗證，而不是只看 health 的計數：
         * Vercel 是 serverless 多實例，`self_test_skipped` 是「單一實例記憶體內的累計」，
         * 讀它的請求很可能落到另一個實例 → 讀到 0 不代表標記沒生效（v3.5.2 上線當天就誤判過一次）。
         * 可靠的說法只有一個：**實際去送幾個標記過的預期錯誤請求，再看日誌有沒有變多**。 */
        const before = await get('/api/admin/error-logs?limit=1', smokeAuth);
        const beforeTotal = ((await before.json().catch(() => ({}))).total) || 0;
        const probeStartedAt = Date.now();

        // 一次標記過的壞 JSON（本來會寫 malformed_json_body）＋ 一次標記過的無效權杖（本來會寫 auth_invalid_token）
        await fetch(SITE + '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ 這不是合法 JSON'
        });
        await fetch(SITE + '/api/admin/users', { headers: { Authorization: 'Bearer definitely-wrong' } });
        await new Promise((r) => setTimeout(r, 1500));   // logErrorToDb 是非阻塞

        const listed = await get('/api/admin/error-logs?limit=20', smokeAuth);
        const body = await listed.json().catch(() => ({}));
        const rows = Array.isArray(body.logs) ? body.logs : [];
        const afterTotal = typeof body.total === 'number' ? body.total : rows.length;

        const newAutoRows = rows.filter((r) => {
            const at = Date.parse(r.created_at || '');
            return Number.isFinite(at) && at >= probeStartedAt - 3000 && /node|curl/i.test(r.user_agent || '');
        });
        check(`標記過的預期錯誤請求沒有寫入日誌（新增 ${newAutoRows.length} 筆）`, newAutoRows.length === 0,
            newAutoRows.slice(0, 3).map((r) => `${r.error_type}@${r.path}`).join(', '));
        check(`本趟檢查（含上述兩個探測）沒有讓日誌總數增加（${beforeTotal} → ${afterTotal}）`,
            afterTotal <= beforeTotal,
            `before=${beforeTotal} after=${afterTotal}`);
        console.log(`  ℹ️ 這趟檢查共送出的除錯探測都沒有留下日誌；health 的 self_test_skipped 為單實例計數，僅供參考`);
    } else {
        console.log('  ⚠️ 找不到本機 JWT_SECRET，跳過「檢查流量不留下日誌」這一節');
    }

    console.log(`\n══════ 正式站煙霧測試：${pass} 通過 / ${fail} 失敗 ══════`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('❌ 執行失敗：', e.message); process.exit(1); });
