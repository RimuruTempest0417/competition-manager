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
    for (const rel of ['public/js/app.js', 'public/js/csv.js', 'public/js/notify.js', 'public/css/custom.css', 'public/sw.js', 'public/index.html']) {
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
        const logsBody = await logs.json().catch(() => ({}));
        check(`網站擁有者可讀錯誤日誌（HTTP ${logs.status}）`, logs.status === 200);
        check('錯誤日誌回傳日誌清單與 schema 資訊',
            logs.status === 200 && (Array.isArray(logsBody.logs) || 'schema' in logsBody),
            Object.keys(logsBody).join(',') || '(空)');
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

    console.log(`\n══════ 正式站煙霧測試：${pass} 通過 / ${fail} 失敗 ══════`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('❌ 執行失敗：', e.message); process.exit(1); });
