require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

app.disable('x-powered-by');

// 🔒 完美強化安全 Header 設定：移除所有 unsafe-inline 與 CDN 外部腳本依賴，徹底防禦 XSS 與樣式注入攻擊
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; form-action 'self';"
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // v2.12.0：API 回應一律不快取（避免代理或 CDN 快取到含個資／權限內容的回應）
    if (req.path && req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

// 中間件配置：將 CORS 限制僅套用於 /api 路由，避免靜態資源帶有跨域標頭引起安全掃描警報
app.use('/api', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. 初始化 Supabase 雲端資料庫連線
// v2.13.0：金鑰優先序 —— service_role（可繞過 RLS，僅限伺服器端）→ 舊的 SUPABASE_KEY（anon）。
// 前端從不直連資料庫，Service Role Key 也絕不可出現在 public/ 或任何前端檔案中。
// 可用名稱：SUPABASE_SERVICE_ROLE_KEY（Supabase 官方命名）、SUPABASE_SERVICE_KEY（本專案慣用簡稱）。
function resolveSupabaseKey(env) {
    const e = env || {};
    return e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_SERVICE_KEY || e.SUPABASE_KEY || '';
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = resolveSupabaseKey(process.env);
const supabaseKeyType = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    ? 'service_role'
    : (process.env.SUPABASE_KEY ? 'anon' : 'none');

const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

if (!hasSupabaseConfig) {
    console.error('❌ 錯誤：未設定 SUPABASE_URL 或 SUPABASE_KEY，請檢查 .env 檔案！');
} else if (supabaseKeyType === 'anon') {
    // 開啟 RLS 之後 anon key 會被完全擋下，屆時一定要先換成 service_role key
    console.warn('⚠️ 目前使用 anon key 連線資料庫。若之後啟用 RLS（migrations/2026-09-26-v2.13.0-enable-rls.sql），' +
        '請先在環境變數加入 SUPABASE_SERVICE_KEY（或 SUPABASE_SERVICE_ROLE_KEY）並重新部署，否則所有資料操作都會失敗。');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder-key');

// 🔐 JWT_SECRET 一律從 process.env 讀取。production 環境 fail-fast，嚴禁任何寫死的備援值；
// 僅在非 production（本機開發 / 測試 bootstrap）時才允許使用開發用常數。
const isProduction = process.env.NODE_ENV === 'production';
const envJwtSecret = (process.env.JWT_SECRET || '').trim();

const JWT_SECRET = envJwtSecret || (isProduction ? '' : 'development-local-secret-change-me');

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required for secure authentication');
}

// 全域中間件：解析 User-Agent 供日誌記錄
app.use((req, res, next) => {
    req.userAgent = req.headers['user-agent'] || '';
    next();
});

// Helper: 處理空字串，將未填寫的選填欄位轉為 null
function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    return str === '' ? null : str;
}

// 與 sanitizeInput 相同，但保證回傳字串（長度限制用）：
// sanitizeInput 對空值回 null，直接 .slice() 會拋 TypeError。
function cleanText(val, maxLength) {
    const str = sanitizeInput(val);
    if (str === null) return '';
    return maxLength ? str.slice(0, maxLength) : str;
}

// ==========================================
// 🏷️ 賽事分類（單選，固定清單）與標籤（多選，自由輸入）
// 這裡是唯一真實來源：前端透過 GET /api/meta 取得，避免兩邊各寫一份而不同步。
// color 對應 custom.css 的 .cat-chip-<color>（沿用既有 --cm-* 變數，深淺色都適用）。
// ==========================================
const COMPETITION_CATEGORIES = [
    { id: 'ball', label: '球類運動', emoji: '🏀', color: 'blue' },
    { id: 'racket', label: '球拍運動', emoji: '🏸', color: 'indigo' },
    { id: 'track', label: '田徑路跑', emoji: '🏃', color: 'emerald' },
    { id: 'aquatic', label: '水上運動', emoji: '🏊', color: 'blue' },
    { id: 'martial', label: '技擊武術', emoji: '🥋', color: 'red' },
    { id: 'mind', label: '棋藝益智', emoji: '♟️', color: 'purple' },
    { id: 'esports', label: '電子競技', emoji: '🎮', color: 'rose' },
    { id: 'art', label: '藝文競賽', emoji: '🎨', color: 'amber' },
    { id: 'academic', label: '學科競賽', emoji: '📚', color: 'emerald' },
    { id: 'other', label: '其他', emoji: '🏅', color: 'slate' },
];

const CATEGORY_IDS = new Set(COMPETITION_CATEGORIES.map((c) => c.id));
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 24;

// 分類：只接受清單內的值，其餘一律視為未分類（null），避免任意字串進資料庫
function normalizeCategory(val) {
    const s = sanitizeInput(val);
    if (!s) return null;
    return CATEGORY_IDS.has(s) ? s : null;
}

// 標籤：接受陣列或字串（逗號/頓號/分號/換行分隔），去空白、去 #、去重（忽略大小寫）、限量
function normalizeTags(val) {
    let list = [];
    if (Array.isArray(val)) {
        list = val;
    } else if (typeof val === 'string') {
        list = val.split(/[,，、;；\n\t]+/);
    }

    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const t = String(raw === undefined || raw === null ? '' : raw)
            .trim()
            .replace(/^#+/, '')
            .slice(0, MAX_TAG_LENGTH);
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

// 資料庫欄位還不存在時（尚未執行 migration），Supabase 會回 PGRST204 / 42703。
// 這種情況要回可行動的訊息，而不是讓使用者看到不明所以的 500。
const MIGRATION_HINT =
    '資料庫尚未加入 category / tags 欄位，請先在 Supabase SQL Editor 執行 migrations/2026-09-23-v2.7.0-competition-category-tags.sql';

// 快取「資料庫是否已有 category / tags 欄位」。null = 尚未探測。
// 目的是讓 v2.7.0 在尚未執行 migration 的資料庫上仍與 v2.6.0 行為相同：
// 沒有要寫分類/標籤時就不帶這兩個欄位，因此編輯既有賽事照常可用。
let schemaHasTaxonomy = null;

async function taxonomySchemaReady() {
    if (schemaHasTaxonomy !== null) return schemaHasTaxonomy;

    try {
        const { error } = await supabase.from('competitions').select('id,category,tags').limit(1);
        schemaHasTaxonomy = !isMissingColumnError(error);
        if (!schemaHasTaxonomy) {
            console.warn('⚠️ competitions 表缺少 category / tags 欄位，分類與標籤將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        // 探測本身失敗（例如網路問題）不阻擋請求，交由實際寫入結果決定
        return true;
    }
    return schemaHasTaxonomy;
}

function hasTaxonomyContent(taxonomy) {
    return taxonomy.category !== null || taxonomy.tags.length > 0;
}

// 決定寫入時是否帶上 category / tags：
// - 有內容 → 一定帶（呼叫端已先確認欄位存在）
// - 無內容且欄位已知存在 → 帶空值（讓使用者能清空分類/標籤）
// - 無內容且欄位未知或不存在 → 不帶，維持 migration 前的舊版行為，
//   否則使用者在還沒執行 migration 時連「編輯既有賽事」都會失敗。
function shouldIncludeTaxonomy(taxonomy, schemaState) {
    return hasTaxonomyContent(taxonomy) || schemaState === true;
}

function isMissingColumnError(err, columns) {
    const code = (err && err.code) || '';
    const msg = (err && err.message) || '';
    const cols = (columns && columns.length ? columns : ['category', 'tags']);

    // 訊息有明確指出欄位名稱時以欄位為準，
    // 這樣才能分辨是 v2.7.0 還是 v2.9.0 的 migration 沒跑（兩者提示訊息不同）。
    const named = msg.match(/column [\w.]*?\.?(\w+) does not exist/i) || msg.match(/Could not find the '(\w+)' column/i);
    if (named) return cols.includes(named[1]);

    // 只有錯誤碼（無法判斷欄位）時：PGRST204 / 42703 都代表欄位不存在
    return code === 'PGRST204' || code === '42703';
}

/* ==========================================================
   v2.9.0：普通用戶、報名與組隊比賽
   ========================================================== */

const TEAM_HINT =
    '資料庫尚未加入組隊／報名欄位，請先在 Supabase SQL Editor 執行 migrations/2026-09-24-v2.9.0-users-registration-teams.sql';
const REGISTRATION_HINT =
    '資料庫尚未建立報名資料表（registrations），請先在 Supabase SQL Editor 執行 migrations/2026-09-24-v2.9.0-users-registration-teams.sql';

// 快取「資料庫是否已有 v2.9.0 的組隊欄位」
let schemaHasTeamFields = null;

async function teamSchemaReady() {
    if (schemaHasTeamFields !== null) return schemaHasTeamFields;

    try {
        const { error } = await supabase
            .from('competitions')
            .select('id,is_team_event,team_size,registration_deadline,max_registrations')
            .limit(1);
        schemaHasTeamFields = !isMissingColumnError(error, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations']);
        if (!schemaHasTeamFields) {
            console.warn('⚠️ competitions 表缺少組隊／報名欄位，組隊比賽與報名截止將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        return true;
    }
    return schemaHasTeamFields;
}

function normalizeTeamFields(body) {
    const toInt = (v, max) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.min(n, max);
    };
    const deadline = typeof body.registration_deadline === 'string' ? body.registration_deadline.trim().slice(0, 10) : '';
    return {
        is_team_event: !!body.is_team_event,
        team_size: toInt(body.team_size, 99),
        max_registrations: toInt(body.max_registrations, 9999),
        registration_deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null
    };
}

function hasTeamFieldsContent(fields) {
    return !!(fields.is_team_event || fields.team_size > 0 || fields.max_registrations > 0 || fields.registration_deadline);
}

// 與 category/tags 相同策略：沒有內容且欄位未知 → 不帶，維持舊版行為
function shouldIncludeTeamFields(fields, schemaState) {
    return hasTeamFieldsContent(fields) || schemaState === true;
}

function isMissingTableError(err) {
    const code = (err && err.code) || '';
    const msg = (err && err.message) || '';
    return code === '42P01' || /relation .* does not exist/i.test(msg) || /Could not find the table/i.test(msg);
}

// 本地時區的 YYYY-MM-DD
function toDateString(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* 報名是否開放（純函式，方便單元測試）
   回傳 { open, reason }；reason 直接顯示給使用者。 */
function registrationState(comp, now, registeredCount) {
    if (!comp) return { open: false, reason: '找不到該賽事' };
    if (comp.is_deleted) return { open: false, reason: '此賽事已下架' };
    if (!comp.is_registration_open) return { open: false, reason: '此賽事目前未開放報名' };

    const today = toDateString(now || new Date());

    if (comp.registration_deadline && today > String(comp.registration_deadline).slice(0, 10)) {
        return { open: false, reason: `報名已於 ${String(comp.registration_deadline).slice(0, 10)} 截止` };
    }
    if (comp.date && today > String(comp.date).slice(0, 10)) {
        return { open: false, reason: '此賽事已結束' };
    }
    const max = parseInt(comp.max_registrations, 10) || 0;
    if (max > 0 && (parseInt(registeredCount, 10) || 0) >= max) {
        return { open: false, reason: `報名人數已達上限（${max} 人）` };
    }
    return { open: true, reason: '' };
}

/* ---------- 密碼雜湊 ----------
   實作抽到 lib/passwords.js，與 scripts/hash-legacy-passwords.js 共用同一份程式碼，
   確保「升級腳本算出來的雜湊」與「伺服器驗證邏輯」永遠一致。
   既有帳號的密碼若是明碼（歷史因素），登入成功時會自動升級。 */
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('./lib/passwords');
// v2.15.0：兩步驟驗證（TOTP）—— 純手寫實作，只用 Node 內建 crypto，無外部套件
const {
    generateSecret, verifyTotp, otpauthUri,
    generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode
} = require('./lib/totp');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_RE = /^[a-zA-Z0-9]{6,64}$/;

// 註冊節流：同一 IP 每小時最多 5 次（記憶體計數，重啟即歸零，足以擋掉腳本濫用）
const registerAttempts = new Map();

function allowRegisterAttempt(ip, now = Date.now(), limit = 5, windowMs = 3600000) {
    const key = String(ip || 'unknown');
    const hits = (registerAttempts.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        registerAttempts.set(key, hits);
        return false;
    }
    hits.push(now);
    registerAttempts.set(key, hits);
    return true;
}

// 📜 統一 Supabase 審計日誌 (audit_logs 表格) 寫入輔助函式
async function logAudit(userId, action, targetId = null, details = null, userAgent = '') {
    try {
        const payload = {
            user_id: userId || 'unknown_user',
            action: action,
            target_id: targetId ? String(targetId) : null,
            details: typeof details === 'object' ? JSON.stringify(details) : details,
            user_agent: userAgent,
            created_at: new Date().toISOString()
        };

        const { error } = await supabase.from('audit_logs').insert([payload]);
        if (error) console.error('❌ Supabase Log 寫入失敗:', error.message);
    } catch (err) {
        console.error('❌ Log 系統例外錯誤:', err.message);
    }
}

// 🚨 統一 Supabase 錯誤日誌 (error_logs 表格) 寫入輔助函式
// v2.12.0：改為會檢查 Supabase 回傳的 error（舊版只 await 不看結果，寫入失敗完全靜默），
// 並把自身的失敗收進記憶體環狀緩衝，可由 /api/admin/error-logs/health 檢查。
const ERROR_LOG_FAILURES = [];
function noteErrorLogFailure(errorType, message) {
    ERROR_LOG_FAILURES.push({ at: new Date().toISOString(), error_type: errorType, error: message });
    if (ERROR_LOG_FAILURES.length > 20) ERROR_LOG_FAILURES.shift();
}

async function logErrorToDb(req, errorType, err, options = {}) {
    try {
        if (!hasSupabaseConfig) return;

        const severity = options.severity || 'error';
        const userAgent = (req && req.headers && req.headers['user-agent']) || '';
        const reqPath = (req && (req.originalUrl || req.url)) || '';
        const userId = req && req.user ? req.user.sub : null;

        let stackTrace = (err && err.stack) || '';
        if (options.context) {
            stackTrace = `${stackTrace}\n\n[context] ${JSON.stringify(options.context)}`.trim();
        }

        const payload = {
            user_id: userId,
            error_type: errorType || 'backend_error',
            message: (err && err.message) ? err.message : String(err),
            stack_trace: stackTrace,
            path: reqPath,
            user_agent: userAgent,
            created_at: new Date().toISOString()
        };

        if (await columnExists('error_logs', 'severity')) payload.severity = severity;

        const { error } = await supabase.from('error_logs').insert([payload]);
        if (error) throw error; // ⬅️ 關鍵修正：不要再吞掉寫入失敗
    } catch (loggingErr) {
        noteErrorLogFailure(errorType || 'backend_error', loggingErr.message);
        console.error('❌ 寫入 error_logs 失敗:', errorType, '—', loggingErr.message);
    }
}

/* ---------- 登入失敗鎖定（v2.14.0：帳號 + IP 雙重計數） ----------
   舊版只以「帳號」為鍵：任何人只要對某個帳號連續打錯密碼，就能把該帳號鎖住（阻斷攻擊）。
   新版：
     - 以 IP 為主：同一 IP 失敗 10 次 / 15 分鐘 → 鎖該 IP（正常打錯密碼的人很快會停）
     - 以帳號為輔：同一帳號失敗 10 次「且來自 2 個以上不同 IP」才視為遭到攻擊 → 鎖帳號
   記憶體計數：serverless 多實例各自計算、重啟歸零，足以阻擋單一來源的暴力破解。 */
const loginFailures = new Map();          // key: `ip:<ip>` 或 `u:<username小寫>`，值為 [{t, ip}]
const LOGIN_MAX_FAILURES = 5;             // 保留（舊測試／文件引用的門檻值）
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX_FAILURES = 10;
const LOGIN_ACCOUNT_MAX_FAILURES = 10;
const LOGIN_ACCOUNT_MIN_IPS = 2;

function loginFailureEntries(key, now) {
    const hits = (loginFailures.get(key) || []).filter((e) => now - e.t < LOGIN_LOCK_MS);
    loginFailures.set(key, hits);
    return hits;
}

const ipKeyOf = (ip) => `ip:${String(ip || 'unknown')}`;
const userKeyOf = (username) => `u:${String(username || '').toLowerCase()}`;

// 回傳 { remaining, scope, distinctIps }；remaining 為 0 表示未鎖定
function loginLockRemaining(username, ip, now = Date.now()) {
    const ipHits = loginFailureEntries(ipKeyOf(ip), now);
    if (ipHits.length >= LOGIN_IP_MAX_FAILURES) {
        return { remaining: LOGIN_LOCK_MS - (now - ipHits[0].t), scope: 'ip', distinctIps: 1 };
    }
    const userHits = loginFailureEntries(userKeyOf(username), now);
    const distinctIps = new Set(userHits.map((e) => e.ip)).size;
    if (userHits.length >= LOGIN_ACCOUNT_MAX_FAILURES && distinctIps >= LOGIN_ACCOUNT_MIN_IPS) {
        return { remaining: LOGIN_LOCK_MS - (now - userHits[0].t), scope: 'account', distinctIps };
    }
    return { remaining: 0, scope: null, distinctIps };
}

// 同時累計「該 IP」與「該帳號」的失敗次數；回傳該帳號累計次數與來源 IP 數
function recordLoginFailure(username, ip, now = Date.now()) {
    const src = String(ip || 'unknown');
    const userHits = loginFailureEntries(userKeyOf(username), now);
    userHits.push({ t: now, ip: src });
    loginFailures.set(userKeyOf(username), userHits);

    const ipHits = loginFailureEntries(ipKeyOf(ip), now);
    ipHits.push({ t: now, ip: src });
    loginFailures.set(ipKeyOf(ip), ipHits);

    if (loginFailures.size > 1000) {
        [...loginFailures.keys()].slice(0, 200).forEach((k) => loginFailures.delete(k));
    }
    return { count: userHits.length, distinctIps: new Set(userHits.map((e) => e.ip)).size };
}

// 登入成功：清掉該帳號的紀錄；若有帶 IP 也清掉該 IP 的紀錄
function clearLoginFailures(username, ip) {
    loginFailures.delete(userKeyOf(username));
    if (ip) loginFailures.delete(ipKeyOf(ip));
}

// v2.12.0：公開（未登入）寫入端點的節流，避免匿名請求灌爆資料庫或濫發推播
const publicWriteHits = new Map();
function allowPublicWrite(ip, bucket, limit = 30, windowMs = 60000, now = Date.now()) {
    const key = `${bucket}:${String(ip || 'unknown')}`;
    const hits = (publicWriteHits.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        publicWriteHits.set(key, hits);
        return false;
    }
    hits.push(now);
    publicWriteHits.set(key, hits);
    if (publicWriteHits.size > 2000) {
        [...publicWriteHits.keys()].slice(0, 500).forEach((k) => publicWriteHits.delete(k));
    }
    return true;
}

// 對外錯誤訊息統一樣板（DB 細節只寫進錯誤日誌，不回傳給使用者）
const GENERIC_DB_ERROR = '伺服器暫時無法處理請求，請稍後再試；若持續發生請通知管理員（已記錄於系統錯誤日誌）';

// 無效權杖日誌節流（同一 IP 每分鐘最多一筆，避免掃描器灌爆資料庫）
const authFailureLogged = new Map();
function shouldLogAuthFailure(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    const last = authFailureLogged.get(key) || 0;
    if (now - last < 60000) return false;
    authFailureLogged.set(key, now);
    if (authFailureLogged.size > 500) {
        [...authFailureLogged.keys()].slice(0, 200).forEach((k) => authFailureLogged.delete(k));
    }
    return true;
}

// 權限角色集合定義
const ADMIN_ROLES = new Set(['admin', 'super_admin', 'web_owner']);
const SUPER_ADMIN_ROLES = new Set(['super_admin', 'web_owner']);

// ==========================================
// v2.12.0 角色階梯與帳號管理規則（單一來源，前後端共用邏輯）
// ==========================================
const ROLE_LEVELS = { user: 1, test: 1, admin: 2, super_admin: 3, web_owner: 4 };
const ROLE_LABELS = {
    user: '普通用戶',
    test: '測試帳號',
    admin: '管理員',
    super_admin: '超級管理員',
    web_owner: '網站擁有者'
};
const MANAGED_ROLES = Object.keys(ROLE_LEVELS);

function roleLevel(role) {
    return ROLE_LEVELS[role] || 0;
}

// 可建立／指派的角色：權限必須高於目標角色；Web Owner 另可建立同級（共同擁有者）
function canCreateRole(actorRole, targetRole) {
    const actor = roleLevel(actorRole);
    const target = roleLevel(targetRole);
    if (actor < 2 || target === 0) return false;
    if (actor === 4 && target === 4) return true;
    return target < actor;
}

// 可管理（改密碼／改名／停用／刪除）：權限必須嚴格高於目標，且不能動自己
function canManageUser(actor, targetUser) {
    if (!actor || !targetUser) return false;
    if (String(actor.id) === String(targetUser.id)) return false;
    return roleLevel(actor.role) > roleLevel(targetUser.role);
}

function assertRoleAssignable(actorRole, targetRole) {
    if (!MANAGED_ROLES.includes(targetRole)) return `未知的角色：${targetRole}`;
    if (!canCreateRole(actorRole, targetRole)) {
        return `權限不足：${ROLE_LABELS[actorRole] || actorRole} 無法建立或指派「${ROLE_LABELS[targetRole] || targetRole}」`;
    }
    return null;
}

// v2.12.0：未執行 migration 時自動降級（先探測欄位，沒有就不帶）
const columnPresence = new Map();
async function columnExists(table, column) {
    const key = `${table}.${column}`;
    if (columnPresence.has(key)) return columnPresence.get(key);
    if (!hasSupabaseConfig) return false;
    const { error } = await supabase.from(table).select(column).limit(1);
    if (!error) {
        columnPresence.set(key, true);
        return true;
    }
    if (isMissingColumnError(error, [column])) {
        columnPresence.set(key, false);
        return false;
    }
    return false; // 暫時性錯誤不快取，下次再試
}

async function findAdminById(id) {
    const { data, error } = await supabase
        .from('admin_users')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) throw error;
    return data;
}

// 以 id 或帳號名稱查詢帳號（v2.12.0 帳號管理用）
async function findUserByKey(idOrName) {
    const key = String(idOrName || '');

    // 數字優先視為 id；找不到時再退回帳號名稱（相容舊版以帳號名稱操作的前端）
    if (/^\d+$/.test(key)) {
        const { data, error } = await supabase
            .from('admin_users')
            .select('*')
            .eq('id', key)
            .maybeSingle();
        if (error) throw error;
        if (data) return data;
    }

    const { data, error } = await supabase
        .from('admin_users')
        .select('*')
        .eq('username', key)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// 還剩幾位網站擁有者（排除指定帳號），用於「至少保留一位」保護
async function countWebOwners(excludeId = null) {
    let query = supabase.from('admin_users').select('id, role').eq('role', 'web_owner');
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).filter((u) => excludeId === null || String(u.id) !== String(excludeId)).length;
}

const USER_MIGRATION_HINT =
    '此功能需要資料庫執行 v2.12.0 migration（migrations/2026-09-25-v2.12.0-user-management.sql）；請聯絡網站擁有者。';

// JWT 身份驗證中間件
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
        return res.status(401).json({ error: '未提供身份驗證令牌，存取被拒' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        // v2.15.0：兩步驟驗證的中間權杖（stage: '2fa'）只是「密碼對了嗎」的憑證，
        // 絕不可當成正式登入權杖使用，否則第二因素就形同虛設。
        if (payload && payload.stage) {
            return res.status(401).json({ error: '登入尚未完成（還需要兩步驟驗證碼），請重新登入' });
        }
        req.user = payload;
        next();
    } catch (err) {
        // v2.12.0：無效／過期權杖也要留下紀錄（每 IP 每分鐘最多一筆，避免掃描器灌爆資料庫）
        if (shouldLogAuthFailure(req.ip)) {
            logErrorToDb(req, 'auth_invalid_token', err, {
                severity: 'warn',
                context: { reason: 'Token 驗證失敗', ua: (req.headers['user-agent'] || '').slice(0, 120) }
            }).catch(() => {});
        }
        // v2.12.0：改用 401（未認證）而非 403，讓前端能分辨「登入逾期」與「權限不足」
        return res.status(401).json({ error: 'Token 無效或已過期，請重新登入' });
    }
}

// RBAC 權限驗證中間件
function requireRole(allowedRoles) {
    return async (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: '權限不足，拒絕存取' });
        }

        try {
            const user = await findAdminById(req.user.sub);
            if (!user || user.username !== req.user.username || user.role !== req.user.role) {
                return res.status(403).json({ error: '帳號權限已變更，請重新登入' });
            }

            req.currentUser = user;
            next();
        } catch (err) {
            await logErrorToDb(req, 'auth_error', err);
            res.status(500).json({ error: GENERIC_DB_ERROR });
        }
    };
}

const requireAdmin = [authenticateToken, requireRole([...ADMIN_ROLES])];
const requireSuperAdmin = [authenticateToken, requireRole([...SUPER_ADMIN_ROLES])];

// ==========================================
// 錯誤日誌 API
// ==========================================

/* v2.14.0：未處理錯誤日誌的統計（登入回應與 /api/admin/error-logs/summary 共用）
   只統計數量與時間，不回傳訊息內容，因此不涉及敏感資料。 */
const ERROR_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
async function errorLogAlertSummary() {
    const empty = { unresolved_total: 0, unresolved_errors: 0, last_24h: 0, latest_at: null, may_need_attention: false, schema: { severity: false, resolved: false } };
    if (!hasSupabaseConfig) return empty;
    try {
        const hasSeverity = await columnExists('error_logs', 'severity');
        const hasResolved = await columnExists('error_logs', 'resolved');
        let query = supabase.from('error_logs').select('id, severity, created_at, resolved', { count: 'exact' });
        if (hasResolved) query = query.eq('resolved', false);
        const { data, error, count } = await query.order('created_at', { ascending: false }).limit(500);
        if (error) throw error;

        const rows = data || [];
        const since = Date.now() - ERROR_ALERT_WINDOW_MS;
        const errors = rows.filter((r) => (hasSeverity ? (r.severity || 'error') : 'error') === 'error');
        return {
            unresolved_total: (count === null || count === undefined) ? rows.length : count,
            unresolved_errors: errors.length,
            last_24h: rows.filter((r) => {
                const t = new Date(r.created_at).getTime();
                return Number.isFinite(t) && t >= since;
            }).length,
            latest_at: rows.length ? rows[0].created_at : null,
            may_need_attention: errors.length > 0,
            schema: { severity: hasSeverity, resolved: hasResolved }
        };
    } catch (err) {
        console.error('⚠️ 讀取錯誤日誌統計失敗:', err.message);
        return empty;
    }
}

app.post('/api/logs/error', async (req, res) => {
    // v2.12.0：未登入就能寫入，必須節流並限制欄位長度（避免匿名灌爆資料庫）
    if (!allowPublicWrite(req.ip, 'logs-error', 30, 60000)) {
        return res.status(429).json({ error: '錯誤回報過於頻繁，請稍後再試' });
    }

    try {
        const { error_type, message, stack_trace, path: errPath, screenshot } = req.body || {};
        const userAgent = req.headers['user-agent'] || '';

        let finalStackTrace = stack_trace || '';
        if (screenshot) {
            finalStackTrace += `\n\n[Screenshot Attached (Base64 Truncated)]: ${screenshot.substring(0, 100)}...`;
        }

        const trim = (v, n) => (v === undefined || v === null ? '' : String(v).slice(0, n));

        const logPayload = {
            user_id: null,
            error_type: trim(error_type, 60) || 'frontend_error',
            message: trim(message, 1000) || 'Unknown client error',
            stack_trace: finalStackTrace.slice(0, 4000),
            path: trim(errPath, 300),
            user_agent: trim(userAgent, 400)
        };

        if (screenshot) {
            logPayload.screenshot = screenshot;
        }

        const { error } = await supabase.from('error_logs').insert([logPayload]);

        if (error) throw error;
        res.json({ success: true, message: 'Bug report saved successfully' });
    } catch (err) {
        // v2.12.0：連「寫日誌」本身的失敗也要留下痕跡（原本只有 console.error，雲端看不到）
        await logErrorToDb(req, 'client_error_log_failed', err, {
            severity: 'warn',
            context: { reason: '前端錯誤回報寫入失敗' }
        });
        res.status(500).json({ error: 'Failed to record error log' });
    }
});

app.get('/api/admin/error-logs', requireSuperAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const hasSeverity = await columnExists('error_logs', 'severity');
        const hasResolved = await columnExists('error_logs', 'resolved');

        let query = supabase.from('error_logs').select('*', { count: 'exact' });

        if (req.query.type) query = query.eq('error_type', String(req.query.type).slice(0, 60));
        if (req.query.severity && hasSeverity) query = query.eq('severity', String(req.query.severity).slice(0, 20));
        if (req.query.resolved === 'true' && hasResolved) query = query.eq('resolved', true);
        if (req.query.resolved === 'false' && hasResolved) query = query.eq('resolved', false);
        if (req.query.q) {
            // 去掉 PostgREST 的 or() 語法字元，避免查詢字串被注入
            const q = String(req.query.q).replace(/[%,()*]/g, ' ').trim().slice(0, 80);
            if (q) query = query.or(`message.ilike.%${q}%,error_type.ilike.%${q}%,path.ilike.%${q}%`);
        }

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const logs = (data || []).map((l) => ({
            ...l,
            severity: l.severity || 'error',
            resolved: l.resolved === true
        }));
        const unresolvedInPage = logs.filter((l) => !l.resolved).length;

        res.json({
            success: true,
            logs,
            total: count === null || count === undefined ? logs.length : count,
            limit,
            offset,
            unresolved_in_page: unresolvedInPage,
            schema: { severity: hasSeverity, resolved: hasResolved }
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_error_logs_error', err);
        console.error('[Fetch Error Logs Failed]:', err.message);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 錯誤日誌系統自身的狀態（寫入失敗時可在後台直接看到，不再只有 console）
app.get('/api/admin/error-logs/health', requireSuperAdmin, async (req, res) => {
    // v2.12.1：順便統計還有幾個帳號的密碼是舊的明碼格式（只回數量，絕不回傳任何密碼內容）
    let plaintextPasswords = null;
    try {
        const { data, error } = await supabase.from('admin_users').select('id, password');
        if (!error) plaintextPasswords = (data || []).filter(u => needsPasswordUpgrade(u.password)).length;
    } catch (e) { /* 統計失敗不影響健康檢查 */ }

    res.json({
        success: true,
        supabase_configured: hasSupabaseConfig,
        db_key_type: supabaseKeyType,
        rls_ready: supabaseKeyType === 'service_role',
        recent_write_failures: ERROR_LOG_FAILURES.slice(-10).reverse(),
        failure_count: ERROR_LOG_FAILURES.length,
        schema: {
            severity: await columnExists('error_logs', 'severity'),
            resolved: await columnExists('error_logs', 'resolved')
        },
        plaintext_passwords: plaintextPasswords
    });
});

// v2.14.0：未處理錯誤日誌的統計（前端據此顯示提示橫幅／選單數量）
app.get('/api/admin/error-logs/summary', requireSuperAdmin, async (req, res) => {
    const summary = await errorLogAlertSummary();
    res.json(Object.assign({ success: true }, summary));
});

// 標記錯誤日誌為已處理／未處理
app.patch('/api/admin/error-logs/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    const resolved = req.body && (req.body.resolved === true || req.body.resolved === 'true');

    try {
        if (!(await columnExists('error_logs', 'resolved'))) {
            return res.status(503).json({ error: USER_MIGRATION_HINT });
        }

        const updates = { resolved };
        if (await columnExists('error_logs', 'resolved_at')) updates.resolved_at = resolved ? new Date().toISOString() : null;
        if (await columnExists('error_logs', 'resolved_by')) updates.resolved_by = resolved ? operator.username : null;

        const { error } = await supabase.from('error_logs').update(updates).eq('id', id);
        if (error) throw error;

        await logAudit(operator.username, resolved ? 'RESOLVE_ERROR_LOG' : 'REOPEN_ERROR_LOG', id, `標記錯誤日誌 #${id}`, req.userAgent);
        res.json({ success: true, message: resolved ? '已標記為已處理' : '已標記為未處理', resolved });
    } catch (err) {
        await logErrorToDb(req, 'resolve_error_log_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 清理舊的錯誤日誌（預設 30 天前）
app.post('/api/admin/error-logs/cleanup', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const days = Math.min(Math.max(parseInt(req.body && req.body.days, 10) || 30, 1), 3650);

    try {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const { data, error } = await supabase
            .from('error_logs')
            .delete()
            .lt('created_at', cutoff)
            .select('id');

        if (error) throw error;

        const removed = (data || []).length;
        await logAudit(operator.username, 'CLEANUP_ERROR_LOGS', null, `清理 ${days} 天前的錯誤日誌：刪除 ${removed} 筆`, req.userAgent);
        res.json({ success: true, removed, days, message: `已清理 ${removed} 筆超過 ${days} 天的日誌` });
    } catch (err) {
        await logErrorToDb(req, 'cleanup_error_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 推播發送紀錄（管理員以上可檢視）
app.get('/api/admin/push-logs', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const { data, error } = await supabase
            .from('push_log')
            .select('*')
            .order('sent_at', { ascending: false })
            .limit(limit);

        if (error) {
            if (isMissingTableError(error)) return res.status(503).json({ error: PUSH_HINT });
            throw error;
        }
        res.json({ success: true, logs: data || [] });
    } catch (err) {
        await logErrorToDb(req, 'fetch_push_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 審計日誌 API
// ==========================================
// ==========================================
// 稽核日誌（v2.16.0：篩選、分頁、CSV 匯出、保留天數清理）
// ------------------------------------------
// 為什麼要強化：稽核紀錄一直有在寫，但以前只能看最近 100 筆、不能篩選也不能匯出，
// 出事後要追「某個人某段時間做了什麼」幾乎不可能。
//
// 設計取捨：
//   - 時間區間用 `gt.created_at` / `lt.created_at`（字串比較對 ISO 時間正確），
//     這樣假 Supabase 也能完整測到，不必依賴 gte/lte。
//   - 關鍵字搜尋（q）在伺服器端以「最近 AUDIT_SEARCH_WINDOW 筆」為範圍做 JS 篩選：
//     PostgREST 的 or() 在測試替身不支援，且稽核量不大，用固定視窗確定性最好（畫面上會標示範圍）。
//   - 總數用 count: 'exact'（正式站拿得到）；拿不到時退回「至少 N 筆、可能還有更多」的誠實說法。
// ==========================================
const AUDIT_SEARCH_WINDOW = 1000;
const AUDIT_EXPORT_MAX = 5000;
const AUDIT_MIN_RETENTION_DAYS = 30;

// 已知動作的中文名稱（目的是讓下拉選單好讀；未知動作一律原樣顯示，新動作不用改程式）
const AUDIT_ACTION_LABELS = {
    LOGIN_SUCCESS: '登入成功',
    LOGIN_FAILED: '登入失敗',
    LOGIN_DENIED_INACTIVE: '已停用帳號嘗試登入',
    LOGIN_2FA_CHALLENGE: '登入要求兩步驟驗證',
    LOGIN_2FA_FAILED: '兩步驟驗證失敗',
    LOGOUT: '登出',
    CHANGE_PASSWORD: '修改密碼',
    PASSWORD_HASH_UPGRADED: '密碼升級為雜湊',
    CREATE_COMPETITION: '建立賽事',
    UPDATE_COMPETITION: '更新賽事',
    DELETE_COMPETITION: '刪除賽事（可還原）',
    PERMANENT_DELETE_COMPETITION: '永久刪除賽事',
    RESTORE_COMPETITION: '還原賽事',
    CREATE_USER: '建立帳號',
    UPDATE_USER: '更新帳號',
    DELETE_USER: '刪除帳號',
    CREATE_TEAM: '建立隊伍',
    UPDATE_TEAM: '更新隊伍',
    DELETE_TEAM: '刪除隊伍',
    ASSIGN_TEAM_MEMBER: '編排隊伍成員',
    REGISTER_COMPETITION: '報名賽事',
    CANCEL_REGISTRATION: '取消報名',
    SEND_PUSH: '發送推播',
    PURGE_AUDIT_LOGS: '清理稽核日誌',
    '2FA_SETUP_STARTED': '開始設定兩步驟驗證',
    '2FA_ENABLED': '啟用兩步驟驗證',
    '2FA_DISABLED': '停用兩步驟驗證',
    '2FA_RESET_BY_ADMIN': '管理員重設兩步驟驗證',
    '2FA_RECOVERY_CODE_USED': '使用備援碼登入'
};

const auditActionLabel = (action) => AUDIT_ACTION_LABELS[action] || action || '（未知）';

// 純函式：把查詢字串整理成安全的篩選條件（可單元測試，不碰資料庫）
function parseAuditFilters(query = {}) {
    const clampInt = (value, min, max, dflt) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(Math.max(n, min), max);
    };
    const asIso = (value) => {
        if (!value) return null;
        const raw = String(value).trim();
        if (!raw) return null;
        // 接受 YYYY-MM-DD（當天 00:00）或完整 ISO；其他一律忽略
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
        const parsed = new Date(dateOnly ? `${raw}T00:00:00.000Z` : raw);
        if (Number.isNaN(parsed.getTime())) return null;
        return parsed.toISOString();
    };
    return {
        limit: clampInt(query.limit, 1, 500, 100),
        offset: clampInt(query.offset, 0, 1_000_000, 0),
        q: String(query.q || '').trim().slice(0, 120),
        username: String(query.username || '').trim().slice(0, 64),
        action: String(query.action || '').trim().slice(0, 64),
        from: asIso(query.from),
        to: asIso(query.to)
    };
}

// 關鍵字比對（純函式）：同時比對使用者、動作、目標與詳情
function auditMatchesQuery(log, q) {
    if (!q) return true;
    const needle = String(q).toLowerCase();
    return ['user_id', 'action', 'target_id', 'details']
        .some((field) => String(log?.[field] ?? '').toLowerCase().includes(needle));
}

function auditLogsToCsvRows(logs) {
    const rows = [['時間', '使用者', '動作', '動作說明', '目標', '詳情', '來源 IP／裝置']];
    for (const log of logs || []) {
        let details = '';
        if (log.details !== null && log.details !== undefined) {
            details = typeof log.details === 'object' ? JSON.stringify(log.details) : String(log.details);
        }
        rows.push([
            log.created_at ? new Date(log.created_at).toISOString() : '',
            log.user_id || '',
            log.action || '',
            auditActionLabel(log.action),
            log.target_id || '',
            details,
            log.user_agent || ''
        ]);
    }
    return rows;
}

app.get('/api/audit-logs', requireSuperAdmin, async (req, res) => {
    try {
        const f = parseAuditFilters(req.query);

        let query = supabase.from('audit_logs').select('*', { count: 'exact' });
        if (f.username) query = query.eq('user_id', f.username);
        if (f.action) query = query.eq('action', f.action);
        if (f.from) query = query.gt('created_at', f.from);
        if (f.to) query = query.lt('created_at', f.to);

        // 一律從第 0 筆取到「本頁結尾 + 1」再自己在 JS 切頁：
        // 正式站 PostgREST 會依 range 回傳、測試替身則回全部，這樣寫兩種環境行為完全一致，
        // has_more 與分頁才不會因為環境不同而算錯（有人問過為什麼不直接用 range(offset, …)——就是這個原因）。
        const useSearch = Boolean(f.q);
        const windowSize = useSearch
            ? AUDIT_SEARCH_WINDOW
            : Math.min(f.offset + f.limit + 1, AUDIT_EXPORT_MAX);

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(0, windowSize - 1);

        if (error) throw error;

        const window = (data || []).slice(0, windowSize);
        const filtered = useSearch ? window.filter((log) => auditMatchesQuery(log, f.q)) : window;
        const page = filtered.slice(f.offset, f.offset + f.limit);
        const hasMore = filtered.length > f.offset + f.limit;

        // 下拉選單用的動作清單：已知動作 + 這次結果中出現的未知動作
        const seen = new Set(window.map((l) => l.action).filter(Boolean));
        const actions = Object.keys(AUDIT_ACTION_LABELS)
            .concat([...seen].filter((a) => !AUDIT_ACTION_LABELS[a]))
            .sort()
            .map((value) => ({ value, label: auditActionLabel(value) }));

        res.json({
            success: true,
            logs: page,
            returned: page.length,
            limit: f.limit,
            offset: f.offset,
            has_more: hasMore,
            total: count === null || count === undefined ? null : count,
            search_window: useSearch ? AUDIT_SEARCH_WINDOW : null,
            search_matches: useSearch ? filtered.length : null,
            filters: f,
            actions
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// CSV 匯出（套用同一組篩選；表格公式注入防護由 CMCSV.stringify 負責）
app.get('/api/audit-logs/export', requireSuperAdmin, async (req, res) => {
    try {
        const f = parseAuditFilters(Object.assign({}, req.query, { limit: AUDIT_EXPORT_MAX, offset: 0 }));

        let query = supabase.from('audit_logs').select('*');
        if (f.username) query = query.eq('user_id', f.username);
        if (f.action) query = query.eq('action', f.action);
        if (f.from) query = query.gt('created_at', f.from);
        if (f.to) query = query.lt('created_at', f.to);

        const fetchLimit = f.q ? AUDIT_SEARCH_WINDOW : AUDIT_EXPORT_MAX;
        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(0, fetchLimit - 1);
        if (error) throw error;

        const filtered = (data || []).filter((log) => auditMatchesQuery(log, f.q)).slice(0, AUDIT_EXPORT_MAX);
        const csv = CMCSV.stringify(auditLogsToCsvRows(filtered), { bom: true });

        await logAudit(req.currentUser.username, 'EXPORT_AUDIT_LOGS', null, {
            count: filtered.length,
            filters: { q: f.q || null, username: f.username || null, action: f.action || null, from: f.from, to: f.to }
        }, req.userAgent);

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.csv"`);
        res.send(csv);
    } catch (err) {
        await logErrorToDb(req, 'export_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 保留天數清理（需要 super_admin／web_owner；dry_run 可先預覽筆數）
app.post('/api/audit-logs/cleanup', requireSuperAdmin, async (req, res) => {
    try {
        const requested = Number.parseInt(req.body?.days, 10);
        const days = Number.isFinite(requested) ? requested : 365;
        if (days < AUDIT_MIN_RETENTION_DAYS) {
            return res.status(400).json({
                error: `為了安全，保留天數不得少於 ${AUDIT_MIN_RETENTION_DAYS} 天（避免一時手誤刪掉所有稽核紀錄）`
            });
        }

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        if (req.body?.dry_run === true) {
            const { data, error } = await supabase.from('audit_logs').select('id').lt('created_at', cutoff);
            if (error) throw error;
            return res.json({ success: true, dry_run: true, would_delete: (data || []).length, cutoff, days });
        }

        const { data, error } = await supabase
            .from('audit_logs')
            .delete({ count: 'exact' })
            .lt('created_at', cutoff)
            .select('id');   // 要 select 才會回傳被刪除的列，才知道刪了幾筆
        if (error) throw error;

        const deleted = Array.isArray(data) ? data.length : 0;
        await logAudit(req.currentUser.username, 'PURGE_AUDIT_LOGS', null, { days, cutoff, deleted }, req.userAgent);
        // 要 await：不然回應送出時這筆警告可能還沒落地，事後就查不到了
        await logErrorToDb(req, 'audit_logs_purged', new Error(
            `稽核日誌清理：刪除 ${deleted} 筆早於 ${cutoff} 的紀錄（保留 ${days} 天）`), {
            severity: 'warn', context: { days, deleted }
        });

        res.json({ success: true, deleted, cutoff, days });
    } catch (err) {
        await logErrorToDb(req, 'cleanup_audit_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 管理員帳號維護 API
// ==========================================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const actor = req.currentUser;
        const cols = ['id', 'username', 'role', 'created_at'];
        if (await columnExists('admin_users', 'is_active')) cols.push('is_active');
        if (await columnExists('admin_users', 'last_login_at')) cols.push('last_login_at');
        if (await columnExists('admin_users', 'updated_at')) cols.push('updated_at');
        if (await columnExists('admin_users', 'totp_enabled')) cols.push('totp_enabled');   // v2.15.0

        const { data: admins, error } = await supabase
            .from('admin_users')
            .select(cols.join(','))
            .order('created_at', { ascending: true });

        if (error) throw error;

        // v2.15.0：列表帶出兩步驟驗證狀態（未執行 migration 時為 undefined，前端據此隱藏）
        const twoFactorSchema = await columnExists('admin_users', 'totp_enabled');

        const users = (admins || []).map((u) => ({
            id: u.id,
            username: u.username,
            role: u.role,
            two_factor_enabled: twoFactorSchema ? u.totp_enabled === true : undefined,
            role_label: ROLE_LABELS[u.role] || u.role,
            created_at: u.created_at || null,
            is_active: u.is_active === undefined ? true : u.is_active !== false,
            last_login_at: u.last_login_at || null,
            is_self: String(actor.id) === String(u.id),
            can_manage: canManageUser(actor, u),
            can_change_role: actor.role === 'web_owner' && String(actor.id) !== String(u.id),
            assignable_roles: MANAGED_ROLES.filter((r) => canCreateRole(actor.role, r))
        }));

        res.json({
            success: true,
            users,
            roles: ROLE_LABELS,
            my_role: actor.role,
            my_role_label: ROLE_LABELS[actor.role] || actor.role,
            my_level: roleLevel(actor.role),
            can_edit_roles: actor.role === 'web_owner',
            can_create: MANAGED_ROLES.filter((r) => canCreateRole(actor.role, r)),
            schema_ready: await columnExists('admin_users', 'is_active')
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_admin_users_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const operator = req.currentUser;

    if (!username || !password) {
        return res.status(400).json({ error: '帳號與密碼為必填欄位' });
    }

    if (!USERNAME_RE.test(String(username))) {
        return res.status(400).json({ error: '帳號格式錯誤：僅允許 3～20 個英文字母、數字或底線' });
    }

    if (!PASSWORD_RE.test(String(password))) {
        return res.status(400).json({ error: '密碼格式錯誤：僅允許 6～64 個英文字母或數字' });
    }

    // v2.12.0：管理員可建立普通用戶／測試帳號；超級管理員可再建立管理員；Web Owner 可建立任何角色
    const targetRole = role || 'user';
    const roleErr = assertRoleAssignable(operator.role, targetRole);
    if (roleErr) {
        return res.status(403).json({ error: roleErr });
    }

    try {
        const { data: existingUser } = await supabase
            .from('admin_users')
            .select('id')
            .eq('username', username)
            .maybeSingle();

        if (existingUser) {
            return res.status(400).json({ error: '此帳號名稱已存在' });
        }

        const payload = { username, password: hashPassword(password), role: targetRole };
        if (await columnExists('admin_users', 'is_active')) payload.is_active = true;
        if (await columnExists('admin_users', 'updated_at')) payload.updated_at = new Date().toISOString();

        const { data, error } = await supabase
            .from('admin_users')
            .insert([payload])
            .select('id, username, role');

        if (error) throw error;

        await logAudit(operator.username, 'CREATE_ADMIN', data[0].id, {
            action: '建立帳號',
            actor_role: operator.role,
            new_user: username,
            new_role: targetRole
        }, req.userAgent);

        res.json({ message: `帳號 ${username} 建立成功（${ROLE_LABELS[targetRole] || targetRole}）`, id: data[0].id, username, role: targetRole });
    } catch (err) {
        await logErrorToDb(req, 'create_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const targetUser = await findUserByKey(id);
        if (!targetUser) {
            return res.status(404).json({ error: '找不到該帳號' });
        }

        if (String(targetUser.id) === String(operator.id) || targetUser.username === operator.username) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        if (targetUser.role === 'web_owner') {
            return res.status(403).json({ error: '保護機制：無法刪除網站擁有者帳號' });
        }

        // v2.12.0：一律依角色階梯（權限必須高於目標），管理員只能刪除普通用戶／測試帳號
        if (!canManageUser(operator, targetUser)) {
            return res.status(403).json({ error: '權限不足：不可刪除同級或更高權限的帳號' });
        }

        const { error: delErr } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', targetUser.id);

        if (delErr) throw delErr;

        await logAudit(operator.username, 'DELETE_ADMIN', targetUser.id, {
            action: '刪除帳號',
            actor_role: operator.role,
            deleted_user: targetUser.username,
            deleted_role: targetUser.role
        }, req.userAgent);

        res.json({ message: `帳號 ${targetUser.username} 已刪除` });
    } catch (err) {
        await logErrorToDb(req, 'delete_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// v2.12.0：修改帳號（角色調整僅限 Web Owner；密碼／帳號名／停用依角色階梯）
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    const { role, password, username, is_active } = req.body || {};

    try {
        const target = await findUserByKey(id);
        if (!target) {
            return res.status(404).json({ error: '找不到該帳號' });
        }

        const isSelf = String(target.id) === String(operator.id) || target.username === operator.username;
        const updates = {};
        const changes = [];

        // (1) 角色調整：只有網站擁有者可以調整他人角色
        if (role !== undefined && role !== target.role) {
            if (operator.role !== 'web_owner') {
                return res.status(403).json({ error: '權限不足：只有網站擁有者可以調整他人角色' });
            }
            if (isSelf) {
                return res.status(400).json({ error: '無法修改自己的角色' });
            }
            if (!MANAGED_ROLES.includes(role)) {
                return res.status(400).json({ error: '未知的角色：' + role });
            }
            if (target.role === 'web_owner' && (await countWebOwners(target.id)) < 1) {
                return res.status(400).json({ error: '保護機制：系統必須保留至少一位網站擁有者' });
            }
            updates.role = role;
            changes.push(`角色 ${ROLE_LABELS[target.role] || target.role} → ${ROLE_LABELS[role] || role}`);
        }

        // (2) 重設密碼
        if (password !== undefined && password !== '') {
            if (!canManageUser(operator, target)) {
                return res.status(403).json({ error: '權限不足：只能重設權限低於你的帳號密碼（自己的密碼請用「修改密碼」）' });
            }
            if (!PASSWORD_RE.test(String(password))) {
                return res.status(400).json({ error: '密碼格式錯誤：僅允許 6～64 個英文字母或數字' });
            }
            updates.password = hashPassword(String(password));
            changes.push('重設密碼');
        }

        // (3) 修改帳號名稱
        if (username !== undefined && username !== '' && username !== target.username) {
            if (!canManageUser(operator, target)) {
                return res.status(403).json({ error: '權限不足：只能修改權限低於你的帳號名稱' });
            }
            if (!USERNAME_RE.test(String(username))) {
                return res.status(400).json({ error: '帳號格式錯誤：僅允許 3～20 個英文字母、數字或底線' });
            }
            const { data: dup } = await supabase
                .from('admin_users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            if (dup && String(dup.id) !== String(target.id)) {
                return res.status(400).json({ error: '此帳號名稱已存在' });
            }
            updates.username = String(username);
            changes.push(`帳號名稱 ${target.username} → ${username}`);
        }

        // (4) 停用／啟用帳號
        if (is_active !== undefined) {
            const wantActive = is_active === true || is_active === 'true';
            if (wantActive !== (target.is_active !== false)) {
                if (isSelf) {
                    return res.status(400).json({ error: '無法停用目前正在使用的帳號' });
                }
                if (!canManageUser(operator, target)) {
                    return res.status(403).json({ error: '權限不足：只能停用權限低於你的帳號' });
                }
                if (target.role === 'web_owner' && !wantActive && (await countWebOwners(target.id)) < 1) {
                    return res.status(400).json({ error: '保護機制：系統必須保留至少一位網站擁有者' });
                }
                if (!(await columnExists('admin_users', 'is_active'))) {
                    return res.status(503).json({ error: USER_MIGRATION_HINT });
                }
                updates.is_active = wantActive;
                changes.push(wantActive ? '啟用帳號' : '停用帳號');
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: '沒有需要變更的內容' });
        }

        if (await columnExists('admin_users', 'updated_at')) {
            updates.updated_at = new Date().toISOString();
        }

        const { error: updateErr } = await supabase
            .from('admin_users')
            .update(updates)
            .eq('id', target.id);

        if (updateErr) throw updateErr;

        await logAudit(operator.username, 'UPDATE_ADMIN', target.id, {
            action: '修改帳號',
            actor_role: operator.role,
            target_user: target.username,
            changes
        }, req.userAgent);

        const roleChanged = updates.role !== undefined;
        res.json({
            message: `已更新帳號 ${updates.username || target.username}：${changes.join('、')}`,
            changes,
            role_changed: roleChanged,
            password_changed: updates.password !== undefined
        });
    } catch (err) {
        await logErrorToDb(req, 'update_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 身份驗證 API (登入與修改密碼)
// ==========================================
const loginHandler = async (req, res) => {
    const { username, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!username || !password) {
        return res.status(400).json({ error: '請輸入帳號與密碼' });
    }

    // v2.14.0：登入失敗鎖定（帳號 + IP 雙重計數）
    const lock = loginLockRemaining(username, clientIp);
    if (lock.remaining > 0) {
        await logAudit(username, 'LOGIN_LOCKED', null,
            { ip: clientIp, scope: lock.scope, remaining_sec: Math.ceil(lock.remaining / 1000) }, req.userAgent);
        const minutes = Math.max(1, Math.ceil(lock.remaining / 60000));
        return res.status(429).json({
            error: lock.scope === 'account'
                ? `此帳號因多次登入失敗暫時鎖定，請於 ${minutes} 分鐘後再試`
                : `嘗試次數過多，請於 ${minutes} 分鐘後再試`
        });
    }

    try {
        const { data: user, error } = await supabase
            .from('admin_users')
            .select('*')
            .eq('username', username)
            .maybeSingle();

        if (error || !user || !verifyPassword(user.password, password)) {
            const { count, distinctIps } = recordLoginFailure(username, clientIp);
            await logAudit(username || 'UNKNOWN', 'LOGIN_FAILED', null, {
                reason: '帳號或密碼錯誤',
                ip: clientIp,
                attempts: count,
                distinct_ips: distinctIps
            }, req.userAgent);

            // 只有「同一帳號被多個來源 IP 連續嘗試」才記錄為可能的攻擊（單一 IP 打錯密碼不需要驚動管理員）
            if (count >= LOGIN_ACCOUNT_MAX_FAILURES && distinctIps >= LOGIN_ACCOUNT_MIN_IPS) {
                logErrorToDb(req, 'login_lockout', new Error(
                    `帳號「${username}」連續登入失敗 ${count} 次，且來自 ${distinctIps} 個不同 IP，已暫時鎖定 15 分鐘`), {
                    severity: 'warn',
                    context: { ip: clientIp, distinct_ips: distinctIps }
                }).catch(() => {});
            } else if (count >= LOGIN_IP_MAX_FAILURES) {
                logErrorToDb(req, 'login_ip_throttled', new Error(
                    `來源 IP 連續登入失敗 ${count} 次，已暫時阻擋 15 分鐘`), {
                    severity: 'warn',
                    context: { ip: clientIp }
                }).catch(() => {});
            }

            return res.status(401).json({ error: '帳號或密碼錯誤' });
        }

        // v2.12.0：停用帳號不得登入（未執行 migration 時 is_active 為 undefined，視為啟用）
        if (user.is_active === false) {
            await logAudit(user.username, 'LOGIN_DENIED_INACTIVE', user.id, { ip: clientIp }, req.userAgent);
            return res.status(403).json({ error: '此帳號已停用，請聯繫管理員' });
        }

        clearLoginFailures(username, clientIp);

        // v2.12.1：明碼密碼的帳號在登入成功時自動升級成 scrypt 雜湊（失敗不影響登入）
        let passwordUpgraded = false;
        if (needsPasswordUpgrade(user.password)) {
            try {
                const { error: upErr } = await supabase
                    .from('admin_users')
                    .update({ password: hashPassword(String(password)) })
                    .eq('id', user.id);
                if (upErr) throw upErr;
                passwordUpgraded = true;
                await logAudit(user.username, 'PASSWORD_HASH_UPGRADED', user.id, { ip: clientIp }, req.userAgent);
            } catch (upErr) {
                console.error('⚠️ 密碼雜湊升級失敗:', upErr.message);
                logErrorToDb(req, 'password_hash_upgrade_error', upErr, { severity: 'warn', context: { user: user.username } }).catch(() => {});
            }
        }

        // v2.15.0：已啟用兩步驟驗證的帳號，這一步先不發正式權杖（改發 5 分鐘的中間權杖）
        if (await twoFactorSchemaReady() && user.totp_enabled === true) {
            const challengeToken = jwt.sign(
                { sub: user.id, username: user.username, role: user.role, stage: '2fa' },
                JWT_SECRET,
                { expiresIn: '5m' }
            );
            await logAudit(user.username, 'LOGIN_2FA_CHALLENGE', user.id, { ip: clientIp }, req.userAgent);
            return res.json({
                message: '請輸入兩步驟驗證碼',
                requires_2fa: true,
                challenge_token: challengeToken,
                username: user.username
            });
        }

        const token = jwt.sign(
            { sub: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await logAudit(user.username, 'LOGIN_SUCCESS', user.id, { ip: clientIp }, req.userAgent);

        // v2.12.0：記錄最後登入時間（未執行 migration 時自動略過，不影響登入）
        if (await columnExists('admin_users', 'last_login_at')) {
            supabase
                .from('admin_users')
                .update({ last_login_at: new Date().toISOString() })
                .eq('id', user.id)
                .then(() => {}, () => {});
        }

        // v2.14.0：能看錯誤日誌的角色，登入時附上「未處理錯誤」統計，前端可直接顯示提示
        let alerts = null;
        if (SUPER_ADMIN_ROLES.has(user.role)) {
            alerts = await errorLogAlertSummary();
        }

        res.json({
            message: '登入成功',
            token,
            user: { id: user.id, username: user.username, role: user.role },
            alerts
        });
    } catch (err) {
        await logErrorToDb(req, 'login_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
};

app.post('/api/auth/login', loginHandler);
app.post('/api/admin/login', loginHandler);

app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const { sub: userId, username } = req.user;

    if (!newPassword || !/^[a-zA-Z0-9]+$/.test(newPassword)) {
        return res.status(400).json({ error: '新密碼格式錯誤：僅允許英文字母與數字' });
    }

    try {
        const { data: user, error: findErr } = await supabase
            .from('admin_users')
            .select('*')
            .eq('id', userId)
            .single();

        if (findErr || !user || !verifyPassword(user.password, oldPassword)) {
            return res.status(400).json({ error: '舊密碼不正確' });
        }

        const { error: updateErr } = await supabase
            .from('admin_users')
            .update({ password: hashPassword(newPassword) })
            .eq('id', userId);

        if (updateErr) throw updateErr;

        await logAudit(username, 'CHANGE_PASSWORD', userId, '使用者修改個人密碼成功', req.userAgent);

        res.json({ message: '密碼修改成功' });
    } catch (err) {
        await logErrorToDb(req, 'change_password_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 兩步驟驗證（TOTP，v2.15.0）
// ------------------------------------------
// 設計重點：
//   - 密鑰與備援碼都只存在資料庫，回應中只出現「一次」（備援碼）或「綁定中」（密鑰）。
//   - 登入流程分兩段：密碼正確 → 發 5 分鐘中間權杖（stage: '2fa'）→ 通過驗證才發正式權杖。
//     中間權杖在 authenticateToken 會被直接拒絕，不會被當成登入成功。
//   - 驗證碼同一個時間步只能用一次（totp_last_step），避免被錄下重放。
//   - 驗證失敗也走登入失敗計數（recordLoginFailure），所以暴力嘗試會被 IP／帳號鎖定規則擋下。
//   - 未執行 migration 時（欄位不存在）整個功能自動停用並回報 503 + 指示，不影響原有登入。
// ==========================================
const TFA_MIGRATION_HINT = '兩步驟驗證需要先執行 migrations/2026-09-26-v2.15.0-admin-2fa.sql（Supabase SQL Editor 貼上執行一次，可重複執行）';
const TFA_RECOVERY_CODE_COUNT = 8;

let tfaSchemaCache = null;
async function twoFactorSchemaReady() {
    if (tfaSchemaCache !== null) return tfaSchemaCache;
    tfaSchemaCache = true;
    for (const col of ['totp_secret', 'totp_enabled', 'totp_confirmed_at', 'totp_recovery_codes', 'totp_last_step']) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await columnExists('admin_users', col))) { tfaSchemaCache = false; break; }
    }
    return tfaSchemaCache;
}

const unusedRecoveryCodes = (user) => (Array.isArray(user?.totp_recovery_codes) ? user.totp_recovery_codes : [])
    .filter((entry) => entry && !entry.used_at);

// 驗證「TOTP 碼或備援碼」。回傳 { ok, method, counter, updatedCodes, reason }
async function verifySecondFactor(user, rawCode) {
    const code = String(rawCode || '').trim();
    const totpCheck = verifyTotp(user.totp_secret || '', code, { lastUsedCounter: user.totp_last_step ?? null });
    if (totpCheck.valid) {
        return { ok: true, method: 'totp', counter: totpCheck.counter, updatedCodes: null, reason: null };
    }

    const entries = Array.isArray(user.totp_recovery_codes) ? user.totp_recovery_codes : [];
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry || entry.used_at) continue;
        if (verifyRecoveryCode(code, entry)) {
            const updated = entries.slice();
            updated[i] = Object.assign({}, entry, { used_at: new Date().toISOString() });
            return { ok: true, method: 'recovery_code', counter: null, updatedCodes: updated, reason: null };
        }
    }

    return { ok: false, method: null, counter: totpCheck.counter, updatedCodes: null, reason: totpCheck.reason };
}

// 綁定狀態（前端據此決定要不要顯示設定入口）
app.get('/api/auth/2fa/status', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.json({ success: true, schema_ready: false, enabled: false, remaining_recovery_codes: 0 });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        res.json({
            success: true,
            schema_ready: true,
            enabled: user.totp_enabled === true,
            confirmed_at: user.totp_confirmed_at || null,
            pending: Boolean(user.totp_secret) && user.totp_enabled !== true,
            remaining_recovery_codes: unusedRecoveryCodes(user).length
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_status_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 步驟 1：產生密鑰（此時尚未啟用）
app.post('/api/auth/2fa/setup', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled === true) {
            return res.status(400).json({ error: '此帳號已啟用兩步驟驗證，如需重新綁定請先停用' });
        }

        const secret = generateSecret();
        const { error } = await supabase
            .from('admin_users')
            .update({ totp_secret: secret, totp_enabled: false, totp_last_step: null })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_SETUP_STARTED', user.id, {}, req.userAgent);
        res.json({
            success: true,
            secret,
            otpauth_uri: otpauthUri({ secret, account: user.username }),
            account: user.username,
            digits: 6,
            period: 30,
            hint: '在驗證器 App（Google／Microsoft Authenticator 等）選「手動輸入金鑰」，貼上這串密鑰，再輸入 App 顯示的 6 位數完成綁定。'
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_setup_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 步驟 2：輸入驗證器顯示的碼 → 正式啟用，並回傳一次性備援碼
app.post('/api/auth/2fa/enable', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled === true) {
            return res.status(400).json({ error: '此帳號已啟用兩步驟驗證' });
        }
        if (!user.totp_secret) {
            return res.status(400).json({ error: '請先產生密鑰（重新整理後再試一次）' });
        }

        const check = verifyTotp(user.totp_secret, req.body?.code, { lastUsedCounter: user.totp_last_step ?? null });
        if (!check.valid) {
            return res.status(400).json({
                error: check.reason === 'replayed' ? '這組驗證碼已經用過，請等下一組' : '驗證碼不正確，請確認手機時間是否正確後再試'
            });
        }

        const codes = generateRecoveryCodes(TFA_RECOVERY_CODE_COUNT);
        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: true,
                totp_confirmed_at: new Date().toISOString(),
                totp_recovery_codes: codes.map((c) => hashRecoveryCode(c)),
                totp_last_step: check.counter
            })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_ENABLED', user.id, {}, req.userAgent);
        res.json({
            success: true,
            recovery_codes: codes,
            warning: '這些備援碼只會顯示這一次。請立刻抄下來（或存進密碼管理器），手機遺失時要用它登入。每組只能用一次。'
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_enable_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 停用（需要密碼 + 一組驗證碼或備援碼）
app.post('/api/auth/2fa/disable', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled !== true) {
            return res.status(400).json({ error: '此帳號尚未啟用兩步驟驗證' });
        }
        if (!verifyPassword(user.password, req.body?.password || '')) {
            await logAudit(user.username, '2FA_DISABLE_FAILED', user.id, { reason: '密碼錯誤' }, req.userAgent);
            return res.status(401).json({ error: '密碼錯誤' });
        }

        const check = await verifySecondFactor(user, req.body?.code);
        if (!check.ok) {
            await logAudit(user.username, '2FA_DISABLE_FAILED', user.id, { reason: '驗證碼錯誤' }, req.userAgent);
            return res.status(401).json({ error: '驗證碼或備援碼錯誤' });
        }

        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: false, totp_secret: null, totp_confirmed_at: null,
                totp_recovery_codes: null, totp_last_step: null
            })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_DISABLED', user.id, { method: check.method }, req.userAgent);
        logErrorToDb(req, 'twofactor_disabled', new Error(`帳號「${user.username}」已停用兩步驟驗證`), {
            severity: 'warn', context: { method: check.method }
        }).catch(() => {});
        res.json({ success: true, message: '已停用兩步驟驗證，之後登入只需密碼。' });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_disable_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 登入第二段：帶中間權杖 + 驗證碼（或備援碼）換取正式權杖
app.post('/api/auth/login/2fa', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }

        let payload;
        try {
            payload = jwt.verify(String(req.body?.challenge_token || ''), JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: '登入流程已過期，請重新輸入帳號密碼' });
        }
        if (!payload || payload.stage !== '2fa') {
            return res.status(401).json({ error: '這個連結不是有效的登入流程，請重新登入' });
        }

        const lock = loginLockRemaining(payload.username, clientIp);
        if (lock.remaining > 0) {
            return res.status(429).json({ error: '嘗試次數過多，請稍後再試', retry_after_seconds: Math.ceil(lock.remaining / 1000) });
        }

        const user = await findUserByKey(payload.sub);
        if (!user) return res.status(401).json({ error: '登入流程已失效，請重新登入' });
        if (user.is_active === false) {
            await logAudit(user.username, 'LOGIN_DENIED_INACTIVE', user.id, { ip: clientIp }, req.userAgent);
            return res.status(403).json({ error: '此帳號已停用，請聯繫管理員' });
        }
        if (user.totp_enabled !== true) {
            return res.status(400).json({ error: '此帳號已停用兩步驟驗證，請重新登入' });
        }

        const check = await verifySecondFactor(user, req.body?.code);
        if (!check.ok) {
            const { count, distinctIps } = recordLoginFailure(user.username, clientIp);
            await logAudit(user.username, 'LOGIN_2FA_FAILED', user.id, { ip: clientIp, attempts: count }, req.userAgent);
            if (count >= LOGIN_ACCOUNT_MAX_FAILURES && distinctIps >= LOGIN_ACCOUNT_MIN_IPS) {
                logErrorToDb(req, 'login_lockout', new Error(
                    `帳號「${user.username}」兩步驟驗證連續失敗 ${count} 次，且來自 ${distinctIps} 個不同 IP，已暫時鎖定 15 分鐘`), {
                    severity: 'warn', context: { ip: clientIp }
                }).catch(() => {});
            }
            return res.status(401).json({
                error: check.reason === 'replayed' ? '這組驗證碼已經用過，請等下一組' : '驗證碼或備援碼錯誤'
            });
        }

        const updates = {};
        if (check.method === 'totp') updates.totp_last_step = check.counter;
        if (check.method === 'recovery_code') updates.totp_recovery_codes = check.updatedCodes;
        if (await columnExists('admin_users', 'last_login_at')) updates.last_login_at = new Date().toISOString();
        const { error: upErr } = await supabase.from('admin_users').update(updates).eq('id', user.id);
        if (upErr) throw upErr;

        clearLoginFailures(user.username, clientIp);

        let remaining = unusedRecoveryCodes(user).length;
        if (check.method === 'recovery_code') {
            remaining = (check.updatedCodes || []).filter((e) => e && !e.used_at).length;
            await logAudit(user.username, '2FA_RECOVERY_CODE_USED', user.id, { remaining }, req.userAgent);
            logErrorToDb(req, 'twofactor_recovery_code_used', new Error(
                `帳號「${user.username}」使用備援碼登入（剩餘 ${remaining} 組）`), {
                severity: remaining <= 2 ? 'warn' : 'info', context: { remaining }
            }).catch(() => {});
        }

        const token = jwt.sign(
            { sub: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '12h' }
        );
        await logAudit(user.username, 'LOGIN_SUCCESS', user.id, { ip: clientIp, method: `2fa:${check.method}` }, req.userAgent);

        let alerts = null;
        if (SUPER_ADMIN_ROLES.has(user.role)) alerts = await errorLogAlertSummary();

        res.json({
            message: '登入成功',
            token,
            used_recovery_code: check.method === 'recovery_code',
            remaining_recovery_codes: remaining,
            user: { id: user.id, username: user.username, role: user.role },
            alerts
        });
    } catch (err) {
        await logErrorToDb(req, 'login_2fa_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 管理端救援：上級可為下級重設兩步驟驗證（手機遺失時的唯一補救路徑）
app.post('/api/admin/users/:id/reset-2fa', requireAdmin, async (req, res) => {
    const operator = req.currentUser;
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const target = await findUserByKey(req.params.id);
        if (!target) return res.status(404).json({ error: '找不到該帳號' });

        // canManageUser 回傳 boolean（必須嚴格高於對方且不能是自己）
        if (!canManageUser(operator, target)) {
            return res.status(403).json({ error: '權限不足：只能重設權限低於你的帳號的兩步驟驗證' });
        }

        if (target.totp_enabled !== true) {
            return res.status(400).json({ error: '該帳號並未啟用兩步驟驗證' });
        }

        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: false, totp_secret: null, totp_confirmed_at: null,
                totp_recovery_codes: null, totp_last_step: null
            })
            .eq('id', target.id);
        if (error) throw error;

        await logAudit(operator.username, '2FA_RESET_BY_ADMIN', target.id, { target: target.username }, req.userAgent);
        logErrorToDb(req, 'twofactor_reset_by_admin', new Error(
            `管理員「${operator.username}」重設了「${target.username}」的兩步驟驗證`), {
            severity: 'warn', context: { operator: operator.username, target: target.username }
        }).catch(() => {});

        res.json({ success: true, message: `已重設「${target.username}」的兩步驟驗證，請對方盡快重新綁定。` });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_reset_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 前端共用設定 API
// ==========================================
// 分類清單定義在後端（server.js），前端一律由此取得，避免兩邊各寫一份而不同步。
app.get('/api/meta', (req, res) => {
    res.json({
        categories: COMPETITION_CATEGORIES,
        maxTags: MAX_TAGS,
        maxTagLength: MAX_TAG_LENGTH,
        version: require('./package.json').version
    });
});

// ==========================================
// 比賽賽事 API (CRUD)
// ==========================================

// 取得比賽列表 (透過 audit_logs 計算發佈者資訊)
app.get('/api/competitions', async (req, res) => {
    try {
        const { data: competitions, error: compErr } = await supabase
            .from('competitions')
            .select('*')
            .or('is_deleted.is.null,is_deleted.eq.false')
            .order('id', { ascending: false });

        if (compErr) throw compErr;
        if (!competitions || competitions.length === 0) return res.json([]);

        const compIds = competitions.map(c => String(c.id));

        const { data: createLogs } = await supabase
            .from('audit_logs')
            .select('target_id, user_id')
            .eq('action', 'CREATE_COMPETITION')
            .in('target_id', compIds);

        const publisherMap = {};
        const usernames = new Set();
        if (createLogs) {
            createLogs.forEach(log => {
                publisherMap[log.target_id] = log.user_id;
                if (log.user_id) usernames.add(log.user_id);
            });
        }

        const userRoleMap = {};
        if (usernames.size > 0) {
            const { data: adminUsers } = await supabase
                .from('admin_users')
                .select('username, role')
                .in('username', Array.from(usernames));

            if (adminUsers) {
                adminUsers.forEach(u => {
                    userRoleMap[u.username] = u.role;
                });
            }
        }

        const result = competitions.map(c => {
            const pubName = publisherMap[String(c.id)] || null;
            return {
                ...c,
                publisher_name: pubName,
                publisher_role: pubName ? (userRoleMap[pubName] || 'admin') : null
            };
        });

        res.json(result);
    } catch (err) {
        await logErrorToDb(req, 'get_competitions_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 讀取回收桶 Handler (改用 'id' 排序，避免 deleted_at 欄位不存在報錯)
const getTrashCompetitionsHandler = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competitions')
            .select('*')
            .eq('is_deleted', true)
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        await logErrorToDb(req, 'get_trash_error', err);
        res.status(500).json({ error: err.message });
    }
};

app.get('/api/competitions/trash', requireAdmin, getTrashCompetitionsHandler);
app.get('/api/competitions/deleted', requireAdmin, getTrashCompetitionsHandler);

// 新增比賽
app.post('/api/competitions', requireAdmin, async (req, res) => {
    const { name, location, date, time, end_date, end_time, description, is_registration_open, category, tags } = req.body;
    const operator = req.currentUser;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    const taxonomy = { category: normalizeCategory(category), tags: normalizeTags(tags) };
    const wantsTaxonomy = hasTaxonomyContent(taxonomy);

    if (wantsTaxonomy && !(await taxonomySchemaReady())) {
        return res.status(503).json({ error: MIGRATION_HINT });
    }
    const includeTaxonomy = shouldIncludeTaxonomy(taxonomy, schemaHasTaxonomy);

    const teamFields = normalizeTeamFields(req.body);
    if (hasTeamFieldsContent(teamFields) && !(await teamSchemaReady())) {
        return res.status(503).json({ error: TEAM_HINT });
    }
    const includeTeamFields = shouldIncludeTeamFields(teamFields, schemaHasTeamFields);

    try {
        const payload = {
            name: name.trim(),
            location: sanitizeInput(location),
            date: sanitizeInput(date),
            time: sanitizeInput(time),
            end_date: sanitizeInput(end_date),
            end_time: sanitizeInput(end_time),
            description: sanitizeInput(description),
            is_registration_open: !!is_registration_open,
            ...(includeTaxonomy ? taxonomy : {}),
            ...(includeTeamFields ? teamFields : {}),
            is_deleted: false,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('competitions')
            .insert([payload])
            .select();

        if (error) throw error;

        const newComp = data[0];
        await logAudit(operator.username, 'CREATE_COMPETITION', newComp.id, `發佈賽事: ${newComp.name}`, req.userAgent);

        res.json(newComp);
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags'])) {
            schemaHasTaxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
        }
        if (isMissingColumnError(err, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations'])) {
            schemaHasTeamFields = false;
            return res.status(503).json({ error: TEAM_HINT });
        }
        await logErrorToDb(req, 'create_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 編輯比賽
app.put('/api/competitions/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, location, date, time, end_date, end_time, description, is_registration_open, category, tags } = req.body;
    const operator = req.currentUser;

    if (!name || name.trim() === '') {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    const taxonomy = { category: normalizeCategory(category), tags: normalizeTags(tags) };
    const wantsTaxonomy = hasTaxonomyContent(taxonomy);

    if (wantsTaxonomy && !(await taxonomySchemaReady())) {
        return res.status(503).json({ error: MIGRATION_HINT });
    }
    const includeTaxonomy = shouldIncludeTaxonomy(taxonomy, schemaHasTaxonomy);

    const teamFields = normalizeTeamFields(req.body);
    if (hasTeamFieldsContent(teamFields) && !(await teamSchemaReady())) {
        return res.status(503).json({ error: TEAM_HINT });
    }
    const includeTeamFields = shouldIncludeTeamFields(teamFields, schemaHasTeamFields);

    try {
        const payload = {
            name: name.trim(),
            location: sanitizeInput(location),
            date: sanitizeInput(date),
            time: sanitizeInput(time),
            end_date: sanitizeInput(end_date),
            end_time: sanitizeInput(end_time),
            description: sanitizeInput(description),
            is_registration_open: !!is_registration_open,
            ...(includeTaxonomy ? taxonomy : {}),
            ...(includeTeamFields ? teamFields : {})
        };

        const { data, error } = await supabase
            .from('competitions')
            .update(payload)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到該賽事' });

        await logAudit(operator.username, 'UPDATE_COMPETITION', id, `更新賽事內容: ${name}`, req.userAgent);

        res.json(data[0]);
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags'])) {
            schemaHasTaxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
        }
        if (isMissingColumnError(err, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations'])) {
            schemaHasTeamFields = false;
            return res.status(503).json({ error: TEAM_HINT });
        }
        await logErrorToDb(req, 'update_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 軟刪除比賽
app.delete('/api/competitions/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .update({ is_deleted: true })
            .eq('id', id)
            .select();

        if (error) throw error;

        await logAudit(operator.username, 'DELETE_COMPETITION', id, `移至回收桶: ${data[0]?.name || id}`, req.userAgent);

        res.json({ message: '已移至回收桶' });
    } catch (err) {
        await logErrorToDb(req, 'soft_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 還原比賽
app.put('/api/competitions/:id/restore', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .update({ is_deleted: false })
            .eq('id', id)
            .select();

        if (error) throw error;

        await logAudit(operator.username, 'RESTORE_COMPETITION', id, `還原賽事: ${data[0]?.name || id}`, req.userAgent);

        res.json({ message: '賽事已成功還原' });
    } catch (err) {
        await logErrorToDb(req, 'restore_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 硬刪除比賽
app.delete('/api/competitions/:id/hard-delete', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { error } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await logAudit(operator.username, 'PERMANENT_DELETE_COMPETITION', id, `永久刪除賽事 ID: ${id}`, req.userAgent);

        res.json({ message: '賽事已永久刪除' });
    } catch (err) {
        await logErrorToDb(req, 'hard_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 📥 CSV 匯入 / 匯出 API (v2.8.0)
// 前端負責解析使用者上傳的檔案，這裡做權威驗證後才寫入資料庫。
// ==========================================

// ==========================================
// v2.9.0：普通用戶報名與隊伍編排 API
// ==========================================

async function fetchCompetition(id) {
    const { data, error } = await supabase.from('competitions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
}

async function countRegistrations(competitionId) {
    const { data, error } = await supabase
        .from('registrations')
        .select('id')
        .eq('competition_id', competitionId)
        .eq('is_deleted', false);
    if (error) throw error;
    return (data || []).length;
}

// 各賽事報名人數（公開的彙總資訊，未執行 migration 時回空物件）
app.get('/api/registration-counts', async (req, res) => {
    try {
        const { data, error } = await supabase.from('registrations').select('competition_id').eq('is_deleted', false);
        if (error) throw error;

        const counts = {};
        (data || []).forEach((r) => {
            const key = String(r.competition_id);
            counts[key] = (counts[key] || 0) + 1;
        });

        res.json({ counts, total: (data || []).length });
    } catch (err) {
        // 前端仍可優雅降級，但後台要看得到（原本完全靜默）
        await logErrorToDb(req, 'registration_counts_error', err, { severity: 'warn' });
        res.json({ counts: {}, total: 0, unavailable: true });
    }
});

// 公開設定（前端據此決定是否顯示註冊邀請碼欄位）
app.get('/api/public-config', (req, res) => {
    res.json({ requireRegistrationCode: !!process.env.REGISTRATION_CODE });
});

// 註冊普通用戶（註冊後直接登入）
app.post('/api/auth/register', async (req, res) => {
    const { username, password, registration_code } = req.body || {};
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!USERNAME_RE.test(String(username || ''))) {
        return res.status(400).json({ error: '帳號格式錯誤：請用 3~20 個英文字母、數字或底線' });
    }
    if (!PASSWORD_RE.test(String(password || ''))) {
        return res.status(400).json({ error: '密碼格式錯誤：請用 6~64 個英文字母或數字' });
    }
    if (process.env.REGISTRATION_CODE && String(registration_code || '') !== process.env.REGISTRATION_CODE) {
        return res.status(400).json({ error: '註冊邀請碼錯誤' });
    }
    if (!allowRegisterAttempt(clientIp)) {
        return res.status(429).json({ error: '註冊嘗試過於頻繁，請稍後再試（同一網路每小時最多 5 次）' });
    }

    try {
        const { data: existed, error: findErr } = await supabase
            .from('admin_users')
            .select('id')
            .eq('username', username)
            .maybeSingle();
        if (findErr) throw findErr;
        if (existed) return res.status(409).json({ error: '此帳號已被使用' });

        const { data, error } = await supabase
            .from('admin_users')
            .insert([{ username, password: hashPassword(password), role: 'user' }])
            .select();
        if (error) throw error;

        const user = data[0];
        const token = jwt.sign({ sub: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '12h' });

        await logAudit(user.username, 'REGISTER_USER', user.id, '註冊普通用戶帳號', req.userAgent);

        res.json({ message: '註冊成功', token, user: { id: user.id, username: user.username, role: 'user' } });
    } catch (err) {
        if ((err && err.code) === '23514') {
            return res.status(503).json({ error: '資料庫尚未允許「普通用戶」角色，請先執行 migrations/2026-09-24-v2.9.0-users-registration-teams.sql' });
        }
        await logErrorToDb(req, 'register_user_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 目前登入者
app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({ user: { id: req.user.sub, username: req.user.username, role: req.user.role } });
});

// 我的報名（含賽事資訊）
app.get('/api/my/registrations', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('registrations')
            .select('*, competitions(id,name,date,time,location,category,is_team_event,is_deleted)')
            .eq('user_id', req.user.sub)
            .eq('is_deleted', false)
            .order('id', { ascending: false });
        if (error) throw error;

        res.json((data || []).filter((r) => r.competitions && !r.competitions.is_deleted));
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'my_registrations_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 報名參加比賽（任何已登入帳號，包含普通用戶）
app.post('/api/competitions/:id/register', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    const body = req.body || {};
    const operator = req.user;

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const count = await countRegistrations(competitionId);
        const state = registrationState(comp, new Date(), count);
        if (!state.open) return res.status(400).json({ error: state.reason });

        const { data: existing, error: exErr } = await supabase
            .from('registrations')
            .select('id')
            .eq('competition_id', competitionId)
            .eq('user_id', operator.sub)
            .eq('is_deleted', false)
            .maybeSingle();
        if (exErr) throw exErr;
        if (existing) return res.status(409).json({ error: '你已經報名過此賽事了' });

        const teamName = cleanText(body.team_name, 40);
        if (comp.is_team_event && !teamName) {
            return res.status(400).json({ error: '此為組隊比賽，請填寫隊伍名稱' });
        }

        const { data, error } = await supabase
            .from('registrations')
            .insert([{
                competition_id: comp.id,
                user_id: operator.sub,
                username: operator.username,
                team_name: teamName || null,
                note: cleanText(body.note, 200) || null,
                status: 'confirmed',
                is_deleted: false,
                created_at: new Date().toISOString()
            }])
            .select();
        if (error) throw error;

        await logAudit(operator.username, 'REGISTER_COMPETITION', comp.id,
            `報名賽事: ${comp.name}${teamName ? '（隊伍：' + teamName + '）' : ''}`, req.userAgent);

        res.json({ message: '報名成功', registration: data[0], registrations: count + 1 });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        if ((err && err.code) === '23505') return res.status(409).json({ error: '你已經報名過此賽事了' });
        await logErrorToDb(req, 'register_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 取消報名（本人或管理員以上）
app.delete('/api/registrations/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到此報名紀錄' });

        const isOwner = String(reg.user_id) === String(req.user.sub) || reg.username === req.user.username;
        if (!isOwner && !ADMIN_ROLES.has(req.user.role)) {
            return res.status(403).json({ error: '權限不足：只能取消自己的報名' });
        }

        const { error: updErr } = await supabase
            .from('registrations')
            .update({ is_deleted: true, team_id: null })
            .eq('id', id);
        if (updErr) throw updErr;

        await logAudit(req.user.username, 'CANCEL_REGISTRATION', reg.competition_id,
            `取消報名: ${reg.username}（${isOwner ? '本人' : '管理員代為取消'}）`, req.userAgent);

        res.json({ message: '已取消報名' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'cancel_registration_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 報名名單：管理員以上看全部（含隊伍），一般用戶只看自己的
app.get('/api/competitions/:id/registrations', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    try {
        let query = supabase
            .from('registrations')
            .select('id,competition_id,user_id,username,team_id,team_name,note,status,created_at')
            .eq('competition_id', competitionId)
            .eq('is_deleted', false)
            .order('id', { ascending: true });

        if (!ADMIN_ROLES.has(req.user.role)) query = query.eq('user_id', req.user.sub);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ registrations: data || [], total: (data || []).length });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'list_registrations_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 隊伍一覽（登入即可檢視，方便參賽者確認自己的隊伍）
app.get('/api/competitions/:id/teams', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    try {
        const [teamsRes, regsRes] = await Promise.all([
            supabase.from('competition_teams').select('*').eq('competition_id', competitionId).eq('is_deleted', false).order('id', { ascending: true }),
            supabase.from('registrations').select('id,username,user_id,team_id,team_name').eq('competition_id', competitionId).eq('is_deleted', false).order('id', { ascending: true })
        ]);
        if (teamsRes.error) throw teamsRes.error;
        if (regsRes.error) throw regsRes.error;

        const regs = regsRes.data || [];
        const teams = (teamsRes.data || []).map((t) => Object.assign({}, t, {
            members: regs.filter((r) => String(r.team_id) === String(t.id))
        }));

        res.json({
            teams,
            unassigned: regs.filter((r) => !r.team_id),
            totalRegistrations: regs.length,
            canArrange: ADMIN_ROLES.has(req.user.role),
            canDelete: SUPER_ADMIN_ROLES.has(req.user.role)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'list_teams_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 建立隊伍（管理員以上）
app.post('/api/competitions/:id/teams', requireAdmin, async (req, res) => {
    const competitionId = req.params.id;
    const body = req.body || {};
    const name = cleanText(body.name, 40);
    const operator = req.currentUser;

    if (!name) return res.status(400).json({ error: '請輸入隊伍名稱' });

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { data: dup, error: dupErr } = await supabase
            .from('competition_teams')
            .select('id')
            .eq('competition_id', competitionId)
            .eq('name', name)
            .eq('is_deleted', false)
            .maybeSingle();
        if (dupErr) throw dupErr;
        if (dup) return res.status(409).json({ error: '此賽事已有同名隊伍' });

        const { data, error } = await supabase
            .from('competition_teams')
            .insert([{
                competition_id: comp.id,
                name,
                note: cleanText(body.note, 200) || null,
                created_by: operator.username,
                is_deleted: false,
                created_at: new Date().toISOString()
            }])
            .select();
        if (error) throw error;

        await logAudit(operator.username, 'CREATE_TEAM', comp.id, `建立隊伍: ${name}`, req.userAgent);
        res.json({ message: '隊伍已建立', team: data[0] });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'create_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 修改隊伍名稱／備註（管理員以上）
app.put('/api/teams/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const operator = req.currentUser;

    try {
        const payload = {};
        if (body.name !== undefined) {
            const name = cleanText(body.name, 40);
            if (!name) return res.status(400).json({ error: '隊伍名稱不可為空' });
            payload.name = name;
        }
        if (body.note !== undefined) payload.note = cleanText(body.note, 200) || null;
        if (Object.keys(payload).length === 0) return res.status(400).json({ error: '沒有要更新的欄位' });

        const { data, error } = await supabase.from('competition_teams').update(payload).eq('id', id).select();
        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到該隊伍' });

        await logAudit(operator.username, 'UPDATE_TEAM', id, `更新隊伍: ${data[0].name}`, req.userAgent);
        res.json({ message: '隊伍已更新', team: data[0] });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'update_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 刪除隊伍（超級管理員以上）：隊員會自動移出隊伍、報名紀錄保留
app.delete('/api/teams/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { data: team, error } = await supabase.from('competition_teams').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!team || team.is_deleted) return res.status(404).json({ error: '找不到該隊伍' });

        const { error: detachErr } = await supabase.from('registrations').update({ team_id: null }).eq('team_id', id);
        if (detachErr) throw detachErr;

        const { error: delErr } = await supabase.from('competition_teams').update({ is_deleted: true }).eq('id', id);
        if (delErr) throw delErr;

        await logAudit(operator.username, 'DELETE_TEAM', team.competition_id, `刪除隊伍: ${team.name}`, req.userAgent);
        res.json({ message: '隊伍已刪除' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'delete_team_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 編排：把報名者加入隊伍（管理員以上）
app.post('/api/teams/:id/members', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const registrationId = req.body && req.body.registrationId;
    const operator = req.currentUser;

    if (!registrationId) return res.status(400).json({ error: '缺少 registrationId' });

    try {
        const [teamRes, regRes] = await Promise.all([
            supabase.from('competition_teams').select('*').eq('id', id).maybeSingle(),
            supabase.from('registrations').select('*').eq('id', registrationId).maybeSingle()
        ]);
        if (teamRes.error) throw teamRes.error;
        if (regRes.error) throw regRes.error;

        const team = teamRes.data;
        const reg = regRes.data;
        if (!team || team.is_deleted) return res.status(404).json({ error: '找不到該隊伍' });
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到該報名紀錄' });
        if (String(reg.competition_id) !== String(team.competition_id)) {
            return res.status(400).json({ error: '報名紀錄與隊伍不屬於同一場賽事' });
        }

        const comp = await fetchCompetition(team.competition_id);
        const teamSize = parseInt(comp && comp.team_size, 10) || 0;
        if (teamSize > 0) {
            const { data: current, error: cntErr } = await supabase
                .from('registrations')
                .select('id')
                .eq('team_id', team.id)
                .eq('is_deleted', false);
            if (cntErr) throw cntErr;
            const others = (current || []).filter((r) => String(r.id) !== String(reg.id)).length;
            if (others >= teamSize) return res.status(400).json({ error: `此隊伍已達人數上限（${teamSize} 人）` });
        }

        const { error: updErr } = await supabase.from('registrations').update({ team_id: team.id }).eq('id', reg.id);
        if (updErr) throw updErr;

        await logAudit(operator.username, 'ASSIGN_TEAM_MEMBER', team.competition_id,
            `編排 ${reg.username} 至隊伍「${team.name}」`, req.userAgent);

        res.json({ message: `已將 ${reg.username} 編入「${team.name}」` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'assign_team_member_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 移除隊員（超級管理員以上）
app.delete('/api/teams/:id/members/:registrationId', requireSuperAdmin, async (req, res) => {
    const { id, registrationId } = req.params;
    const operator = req.currentUser;

    try {
        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', registrationId).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到該報名紀錄' });
        if (String(reg.team_id) !== String(id)) return res.status(400).json({ error: '此報名者不在該隊伍中' });

        const { error: updErr } = await supabase.from('registrations').update({ team_id: null }).eq('id', registrationId);
        if (updErr) throw updErr;

        await logAudit(operator.username, 'REMOVE_TEAM_MEMBER', reg.competition_id,
            `將 ${reg.username} 移出隊伍`, req.userAgent);

        res.json({ message: `已將 ${reg.username} 移出隊伍` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'remove_team_member_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// v2.10.0：賽事海報（手動上傳，取代自動生成）與 Web Push 推播訂閱
// ==========================================
const POSTER_MAX_BYTES = 3 * 1024 * 1024;             // 3MB（前端會先縮圖，通常僅數百 KB）
const POSTER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const POSTER_HINT = '資料庫尚未加入海報欄位，請先在 Supabase SQL Editor 執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
const PUSH_HINT = '資料庫尚未加入推播資料表（app_settings / push_subscriptions / push_log），請先執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
// 站台時區偏移：用於判斷「開賽前 24 小時」。可用 SITE_UTC_OFFSET 覆寫（例如 +08:00）。
const SITE_UTC_OFFSET = process.env.SITE_UTC_OFFSET || '+08:00';

// ---------- 小工具（純函式，可單元測試）----------

// 解析 data URL → { mime, buffer }；格式不符或非允許的圖片類型回 null
function parseImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    if (!POSTER_MIME.has(mime)) return null;
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length) return null;
    return { mime: mime, buffer: buffer };
}

// 賽事開賽時間（毫秒）。日期缺失回 null；時間缺失以 00:00 計。
function competitionStartMs(item, offset) {
    if (!item || !item.date) return null;
    const date = String(item.date).slice(0, 10);
    const rawTime = item.time ? String(item.time).slice(0, 5) : '00:00';
    const time = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : '00:00';
    const ms = Date.parse(`${date}T${time}:00${offset || SITE_UTC_OFFSET}`);
    return Number.isNaN(ms) ? null : ms;
}

// 需要推播的項目（純函式）：開賽前 24 小時內＝reminder；上次執行後新發布＝new
function pushCandidates(competitions, options) {
    const opts = options || {};
    const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now) || Date.now();
    const windowMs = opts.windowMs || 24 * 3600 * 1000;
    const lastRunMs = opts.lastRunMs || 0;
    const done = opts.done || new Set();
    const out = [];

    (competitions || []).forEach((item) => {
        if (!item || item.is_deleted) return;
        const key = (kind) => `${item.id}:${kind}`;

        const start = competitionStartMs(item, opts.offset);
        if (start !== null && start >= nowMs && start - nowMs <= windowMs && !done.has(key('reminder'))) {
            out.push({ kind: 'reminder', competition: item, startMs: start });
        }
        const createdMs = item.created_at ? Date.parse(item.created_at) : null;
        if (createdMs && lastRunMs && createdMs > lastRunMs && !done.has(key('new'))) {
            out.push({ kind: 'new', competition: item, startMs: start });
        }
    });

    return out;
}

function pushPayloadFor(candidate, nowMs) {
    const item = candidate.competition || {};
    const when = [item.date, item.time].filter(Boolean).join(' ');
    const where = item.location ? `（${item.location}）` : '';
    if (candidate.kind === 'reminder') {
        const hours = Math.max(0, Math.round(((candidate.startMs || nowMs) - nowMs) / 3600000));
        return {
            title: `⏰ 即將開賽：${item.name || '賽事'}`,
            body: `${when}${where} — 約 ${hours} 小時後開始`,
            url: '/?comp=' + item.id,
            tag: `cm-reminder-${item.id}`
        };
    }
    return {
        title: `🆕 新賽事：${item.name || '賽事'}`,
        body: `${when}${where}${item.is_team_event ? ' — 👥 組隊比賽' : ''}`,
        url: '/?comp=' + item.id,
        tag: `cm-new-${item.id}`
    };
}

// ---------- 資料庫小工具（fetchCompetition 已於 v2.9.0 區塊定義）----------
async function getSetting(key) {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    return data ? data.value : null;
}

async function setSetting(key, value) {
    const { error } = await supabase.from('app_settings').upsert(
        [{ key: key, value: String(value), updated_at: new Date().toISOString() }],
        { onConflict: 'key' }
    );
    if (error) throw error;
}

// ---------- 賽事海報 ----------

// 上傳／更新海報（管理員以上）。圖片以 base64 存於資料庫，由自家端點提供，
// 因此不需要 Supabase Storage，也不必放寬 CSP 的 img-src。
app.post('/api/competitions/:id/poster', requireAdmin, async (req, res) => {
    const parsed = parseImageDataUrl(req.body && req.body.dataUrl);
    if (!parsed) return res.status(400).json({ error: '海報格式錯誤：請上傳 JPG、PNG 或 WebP 圖片' });
    if (parsed.buffer.length > POSTER_MAX_BYTES) {
        const mb = Math.round((parsed.buffer.length / 1024 / 1024) * 10) / 10;
        return res.status(413).json({ error: `海報檔案過大（${mb}MB），上限 3MB` });
    }

    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const now = new Date().toISOString();
        const { error: upErr } = await supabase.from('competition_posters').upsert([{
            competition_id: comp.id,
            mime: parsed.mime,
            bytes: parsed.buffer.length,
            data: parsed.buffer.toString('base64'),
            uploaded_by: req.currentUser ? req.currentUser.username : null,
            updated_at: now
        }], { onConflict: 'competition_id' });
        if (upErr) throw upErr;

        const { error: colErr } = await supabase.from('competitions').update({ poster_updated_at: now }).eq('id', comp.id);
        if (colErr) throw colErr;

        await logAudit(req.user.username, 'UPLOAD_POSTER', comp.id, `上傳自訂海報（${Math.round(parsed.buffer.length / 1024)}KB）`, req.userAgent);
        res.json({
            message: '海報已更新，分享與卡片都會改用手動上傳的海報',
            posterUrl: `/api/competitions/${comp.id}/poster?v=${Date.parse(now)}`,
            bytes: parsed.buffer.length
        });
    } catch (err) {
        if (isMissingTableError(err) || isMissingColumnError(err, ['poster_updated_at'])) {
            return res.status(503).json({ error: POSTER_HINT });
        }
        await logErrorToDb(req, 'poster_upload_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 移除海報（管理員以上）→ 回到自動生成海報
app.delete('/api/competitions/:id/poster', requireAdmin, async (req, res) => {
    try {
        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { error: delErr } = await supabase.from('competition_posters').delete().eq('competition_id', comp.id);
        if (delErr) throw delErr;
        const { error: colErr } = await supabase.from('competitions').update({ poster_updated_at: null }).eq('id', comp.id);
        if (colErr) throw colErr;

        await logAudit(req.user.username, 'DELETE_POSTER', comp.id, '移除自訂海報（改回自動生成）', req.userAgent);
        res.json({ message: '已移除自訂海報，分享將改回自動生成的海報' });
    } catch (err) {
        if (isMissingTableError(err) || isMissingColumnError(err, ['poster_updated_at'])) {
            return res.status(503).json({ error: POSTER_HINT });
        }
        await logErrorToDb(req, 'poster_delete_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 取得海報（公開）：同源提供，維持 CSP img-src 'self'，完全不需外部網域
app.get('/api/competitions/:id/poster', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competition_posters')
            .select('mime,data')
            .eq('competition_id', req.params.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.data) return res.status(404).json({ error: '此賽事沒有自訂海報' });

        const buffer = Buffer.from(data.data, 'base64');
        res.set('Content-Type', data.mime || 'image/jpeg');
        res.set('Content-Length', String(buffer.length));
        res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(buffer);
    } catch (err) {
        res.status(404).json({ error: '此賽事沒有自訂海報' });
    }
});

// ---------- Web Push（推播訂閱服務）----------
// 伺服器端使用 web-push 套件（僅後端，不影響 CSP script-src 'self'）。
// VAPID 金鑰：優先讀環境變數；否則首次使用時自動產生並存進 app_settings，
// 因此私鑰不會出現在程式碼或對話中，也不需要手動設定環境變數。
let webpush = null;
try {
    webpush = require('web-push');
} catch (e) {
    console.warn('⚠️ 未安裝 web-push，推播功能停用（npm install web-push 即可啟用）');
}

let cachedVapid = null;

async function getVapidKeys() {
    if (cachedVapid) return cachedVapid;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        cachedVapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
        return cachedVapid;
    }
    if (!webpush) return null;

    try {
        const stored = await getSetting('push_vapid_keys');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && parsed.publicKey && parsed.privateKey) {
                cachedVapid = parsed;
                return cachedVapid;
            }
        }
        const generated = webpush.generateVAPIDKeys();
        await setSetting('push_vapid_keys', JSON.stringify(generated));
        // 競態：若同時有另一個實例寫入，以資料庫內容為準
        const after = await getSetting('push_vapid_keys');
        cachedVapid = after ? JSON.parse(after) : generated;
        return cachedVapid;
    } catch (err) {
        return null;
    }
}

// 有帶 token 就解析（不強制登入）：訪客也能訂閱推播
function optionalAuth(req, res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            req.user = jwt.verify(header.slice(7), JWT_SECRET);
        } catch (e) { /* 訪客身份繼續 */ }
    }
    next();
}

async function sendPushTo(subscription, payload) {
    const keys = await getVapidKeys();
    if (!webpush || !keys) return { ok: false, error: '伺服器未啟用推播' };
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
    try {
        await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            JSON.stringify(payload),
            { TTL: 86400 }
        );
        return { ok: true };
    } catch (err) {
        const status = err && err.statusCode;
        return {
            ok: false,
            gone: status === 404 || status === 410,
            error: `HTTP ${status || '?'}${err && err.body ? ' ' + String(err.body).slice(0, 100) : ''}`
        };
    }
}

app.get('/api/push/public-key', async (req, res) => {
    if (!webpush) return res.status(503).json({ error: '伺服器未啟用推播（缺少 web-push 套件）' });
    const keys = await getVapidKeys();
    if (!keys) return res.status(503).json({ error: PUSH_HINT });
    res.json({ publicKey: keys.publicKey });
});

app.post('/api/push/subscribe', optionalAuth, async (req, res) => {
    const sub = (req.body && req.body.subscription) || {};
    const keys = sub.keys || {};
    if (!sub.endpoint || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ error: '訂閱資料不完整' });
    }
    try {
        const { error } = await supabase.from('push_subscriptions').upsert([{
            endpoint: sub.endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            user_id: req.user ? req.user.sub : null,
            username: req.user ? req.user.username : null,
            user_agent: (req.headers['user-agent'] || '').slice(0, 300),
            is_active: true,
            last_seen_at: new Date().toISOString()
        }], { onConflict: 'endpoint' });
        if (error) throw error;
        res.json({ message: '已開啟瀏覽器推播訂閱' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_subscribe_error', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/push/unsubscribe', async (req, res) => {
    if (!allowPublicWrite(req.ip, 'push-unsub', 30, 60000)) {
        return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: '缺少訂閱識別（endpoint）' });
    try {
        const { error } = await supabase.from('push_subscriptions').update({ is_active: false }).eq('endpoint', endpoint);
        if (error) throw error;
        res.json({ message: '已關閉此裝置的推播訂閱' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_unsubscribe_error', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/push/test', async (req, res) => {
    // v2.12.0：送出推播的端點較敏感，限制每分鐘 10 次
    if (!allowPublicWrite(req.ip, 'push-test', 10, 60000)) {
        return res.status(429).json({ error: '測試推播過於頻繁，請稍後再試' });
    }

    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: '缺少訂閱識別（endpoint）' });
    if (!webpush) return res.status(503).json({ error: '伺服器未啟用推播（缺少 web-push 套件）' });
    try {
        const { data, error } = await supabase.from('push_subscriptions').select('*').eq('endpoint', endpoint).maybeSingle();
        if (error) throw error;
        if (!data || !data.is_active) return res.status(404).json({ error: '找不到有效的訂閱紀錄' });

        const result = await sendPushTo(data, {
            title: '🔔 測試通知',
            body: '推播訂閱成功！之後即使關閉網頁，也能收到新賽事與開賽提醒。',
            url: '/',
            tag: 'cm-push-test'
        });
        if (result.gone) {
            await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', data.id);
        }
        res.json({ ok: result.ok, message: result.ok ? '測試通知已送出（請看系統通知）' : `送出失敗：${result.error}` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_test_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 定時推播核心：找出「即將開賽（24 小時內）」與「上次執行後新發布」的賽事，
// 對所有有效訂閱發送，並以 push_log 去重（同一賽事同一類型只送一次）。
async function runPushDigest(now) {
    const nowDate = now instanceof Date ? now : new Date();
    const keys = await getVapidKeys();
    if (!keys) throw new Error(PUSH_HINT);

    const { data: subs, error: subErr } = await supabase.from('push_subscriptions').select('*').eq('is_active', true);
    if (subErr) throw subErr;
    if (!subs || subs.length === 0) return { sent: 0, subscriptions: 0, reason: '目前沒有任何有效訂閱' };

    const { data: comps, error: compErr } = await supabase
        .from('competitions')
        .select('*')
        .or('is_deleted.is.null,is_deleted.eq.false');
    if (compErr) throw compErr;

    const { data: logs, error: logErr } = await supabase.from('push_log').select('competition_id,kind');
    if (logErr) throw logErr;
    const done = new Set((logs || []).map((l) => `${l.competition_id}:${l.kind}`));

    const lastRunRaw = await getSetting('push_last_run');
    const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : 0;

    const candidates = pushCandidates(comps || [], {
        now: nowDate,
        done: done,
        lastRunMs: Number.isNaN(lastRunMs) ? 0 : lastRunMs,
        offset: SITE_UTC_OFFSET
    });

    const result = { candidates: candidates.length, sent: 0, failed: 0, deactivated: 0, subscriptions: subs.length, details: [] };

    for (const candidate of candidates) {
        const payload = pushPayloadFor(candidate, nowDate.getTime());
        let sentCount = 0;

        for (const sub of subs) {
            if (!sub.is_active) continue;
            const sent = await sendPushTo(sub, payload);
            if (sent.ok) sentCount += 1;
            else if (sent.gone) {
                await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', sub.id);
                sub.is_active = false;
                result.deactivated += 1;
            } else {
                result.failed += 1;
            }
        }

        await supabase.from('push_log').insert([{
            competition_id: candidate.competition.id,
            kind: candidate.kind,
            sent_count: sentCount,
            sent_at: nowDate.toISOString()
        }]);

        result.sent += sentCount;
        result.details.push({ id: candidate.competition.id, kind: candidate.kind, sent: sentCount });
    }

    await setSetting('push_last_run', nowDate.toISOString());
    return result;
}

// Vercel Cron 會以 CRON_SECRET 作為 Bearer 權杖呼叫此端點（vercel.json 已設定每日一次）。
// 未設定 CRON_SECRET 時，為避免被有心人反覆觸發，限制每 10 分鐘一次。
let lastCronRun = 0;

// 固定時間比較，避免以回應時間推測密鑰
function safeStringEqual(a, b) {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
}

// cron 端點授權判斷（純函式，方便單元測試）
// 重要：未設定 CRON_SECRET 時在 production 必須「拒絕」而不是放行，
// 否則任何人只要對 /api/cron/reminders 發一個請求就能觸發推播工作。
function cronAuthorization({ secret, providedHeader, isProductionEnv, lastRunMs, nowMs }) {
    const provided = String(providedHeader || '').replace(/^Bearer\s+/i, '');
    if (!secret) {
        if (isProductionEnv) {
            return {
                ok: false,
                status: 503,
                error: '未設定 CRON_SECRET，已停用自動推播端點。請在部署環境（Vercel → Settings → Environment Variables）加入 CRON_SECRET 後重新部署。'
            };
        }
        if (lastRunMs && nowMs - lastRunMs < 10 * 60 * 1000) {
            return { ok: false, status: 429, error: '呼叫過於頻繁（未設定 CRON_SECRET 時每 10 分鐘一次）' };
        }
        return { ok: true };
    }
    if (!safeStringEqual(provided, secret)) return { ok: false, status: 401, error: '未授權' };
    return { ok: true };
}

app.get('/api/cron/reminders', async (req, res) => {
    const auth = cronAuthorization({
        secret: process.env.CRON_SECRET,
        providedHeader: req.headers.authorization,
        isProductionEnv: isProduction,
        lastRunMs: lastCronRun,
        nowMs: Date.now()
    });
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    lastCronRun = Date.now();

    try {
        const result = await runPushDigest(new Date());
        // v2.16.0：稽核日誌保留天數清理（**預設不啟用**：只有設了 AUDIT_RETENTION_DAYS 才會刪東西）
        result.audit_purged = null;   // 欄位固定存在，未啟用時明確回 null
        const retention = Number.parseInt(process.env.AUDIT_RETENTION_DAYS, 10);
        if (Number.isFinite(retention) && retention >= AUDIT_MIN_RETENTION_DAYS) {
            const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000).toISOString();
            const { data: purged, error: purgeError } = await supabase
                .from('audit_logs')
                .delete({ count: 'exact' })
                .lt('created_at', cutoff)
                .select('id');
            if (purgeError) {
                await logErrorToDb(req, 'cron_audit_retention_error', purgeError);
                result.audit_purged = null;
            } else {
                result.audit_purged = Array.isArray(purged) ? purged.length : 0;
                if (result.audit_purged > 0) {
                    await logAudit('system', 'PURGE_AUDIT_LOGS', null, { days: retention, cutoff, deleted: result.audit_purged, source: 'cron' }, 'cron');
                }
            }
        }
        res.json(Object.assign({ ok: true, ranAt: new Date().toISOString() }, result));
    } catch (err) {
        if (isMissingTableError(err) || /migration/.test(err.message || '')) {
            return res.status(503).json({ error: err.message });
        }
        await logErrorToDb(req, 'push_cron_error', err);
        res.status(500).json({ error: err.message });
    }
});

const CMCSV = require('./public/js/csv.js');

// 純函式：以「名稱 + 開始日期」判斷重複，回傳要新增與要跳過的清單（方便單元測試）
function planImport(existingCompetitions, incoming) {
    const keyOf = (r) => `${String((r && r.name) || '').trim().toLowerCase()}|${(r && r.date) || ''}`;
    const seen = new Set((existingCompetitions || []).map(keyOf));
    const toInsert = [];
    const skipped = [];

    (incoming || []).forEach((row, index) => {
        const key = keyOf(row);
        if (seen.has(key)) {
            skipped.push({ index: index + 1, name: row.name, reason: '重複：已有同名且同日期的賽事' });
            return;
        }
        seen.add(key);
        toInsert.push(row);
    });

    return { toInsert, skipped };
}

// 匯出：全部未刪除的賽事（UTF-8 BOM，Excel 直接開啟不亂碼）
app.get('/api/competitions/export.csv', requireAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competitions')
            .select('*')
            .or('is_deleted.is.null,is_deleted.eq.false')
            .order('id', { ascending: true });

        if (error) throw error;

        const { rows } = CMCSV.toExportRows(data || [], COMPETITION_CATEGORIES);
        const today = new Date().toISOString().slice(0, 10);

        await logAudit(req.currentUser.username, 'EXPORT_COMPETITIONS', null,
            `匯出 ${(data || []).length} 筆賽事為 CSV`, req.userAgent);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="competitions-${today}.csv"`);
        res.send(CMCSV.stringify(rows, { bom: true }));
    } catch (err) {
        await logErrorToDb(req, 'export_competitions_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 匯入：接受前端解析後的 JSON 陣列
app.post('/api/competitions/import', requireAdmin, async (req, res) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    const operator = req.currentUser;

    if (!rows) return res.status(400).json({ error: '缺少 rows 陣列' });
    if (rows.length === 0) return res.status(400).json({ error: '沒有可匯入的資料' });
    if (rows.length > CMCSV.MAX_IMPORT_ROWS) {
        return res.status(400).json({
            error: `單次最多匯入 ${CMCSV.MAX_IMPORT_ROWS} 筆（本次 ${rows.length} 筆），請分批匯入`
        });
    }

    try {
        const failed = [];
        const failed_warnings = [];
        const valid = [];

        rows.forEach((raw, i) => {
            const result = CMCSV.normalizeRecord(raw, {
                categories: COMPETITION_CATEGORIES,
                maxTags: MAX_TAGS,
                maxTagLength: MAX_TAG_LENGTH
            });

            if (!result.ok) {
                failed.push({ index: i + 1, name: (raw && raw.name) || '', reason: result.errors.join('；') });
                return;
            }
            (result.warnings || []).forEach((w) => failed_warnings.push(`第 ${i + 1} 筆：${w}`));
            valid.push(result.value);
        });

        if (valid.length === 0) {
            return res.status(400).json({
                error: '沒有任何可匯入的資料（全部未通過驗證）',
                created: 0, total: rows.length, skipped: [], failed, warnings: failed_warnings
            });
        }

        const { data: existing, error: fetchErr } = await supabase
            .from('competitions')
            .select('name,date')
            .or('is_deleted.is.null,is_deleted.eq.false');

        if (fetchErr) throw fetchErr;

        const { toInsert, skipped } = planImport(existing || [], valid);

        // 欄位尚未建立時仍可匯入，只是不寫入分類/標籤（並在回應中明確告知）
        const includeTaxonomy = await taxonomySchemaReady();
        const warnings = failed_warnings.slice();
        if (!includeTaxonomy) warnings.push(MIGRATION_HINT);

        const payload = toInsert.map((row) => {
            const base = {
                name: row.name,
                location: row.location,
                date: row.date,
                time: row.time,
                end_date: row.end_date,
                end_time: row.end_time,
                description: row.description,
                is_registration_open: !!row.is_registration_open,
                is_deleted: false,
                created_at: new Date().toISOString()
            };
            if (includeTaxonomy) {
                base.category = normalizeCategory(row.category);
                base.tags = normalizeTags(row.tags);
            }
            return base;
        });

        let created = 0;
        const CHUNK = 200;
        for (let i = 0; i < payload.length; i += CHUNK) {
            const chunk = payload.slice(i, i + CHUNK);
            const { data: inserted, error: insErr } = await supabase
                .from('competitions')
                .insert(chunk)
                .select('id');

            if (insErr) throw insErr;
            created += (inserted || []).length;
        }

        await logAudit(operator.username, 'IMPORT_COMPETITIONS', null,
            `匯入 CSV：成功 ${created} 筆、重複跳過 ${skipped.length} 筆、驗證失敗 ${failed.length} 筆`, req.userAgent);

        res.json({
            success: true,
            total: rows.length,
            created,
            skipped,
            failed,
            warnings
        });
    } catch (err) {
        if (isMissingColumnError(err)) {
            schemaHasTaxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
        }
        await logErrorToDb(req, 'import_competitions_error', err);
        res.status(500).json({ error: '匯入失敗：' + err.message });
    }
});

// 客製化 404 路由中間件 (防止 ZAP 掃描誤抓預設 Cannot GET 訊息)
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Resource Not Found' });
});

// 全域 Error Handler (寫入 Supabase 日誌，僅回傳安全 JSON 訊息)
app.use(async (err, req, res, next) => {
    // v2.14.0：用戶端送來的請求本身有問題（JSON 格式錯誤、body 過大）不該記成「伺服器錯誤」。
    // 這些是攻擊探測或前端 bug 的訊號，回 4xx 並以警告級記錄，才不會稀釋真正的錯誤日誌
    // （本項是「錯誤日誌自動巡檢」跑出來的第一個發現：malformed JSON 被記成 unhandled_server_error）。
    const isBodyParseError = err && (err.type === 'entity.parse.failed'
        || (err instanceof SyntaxError && err.status === 400 && 'body' in err));
    const isBodyTooLarge = err && (err.type === 'entity.too.large' || err.status === 413);

    if (isBodyParseError || isBodyTooLarge) {
        const status = isBodyTooLarge ? 413 : 400;
        const errorType = isBodyTooLarge ? 'request_body_too_large' : 'malformed_json_body';
        const message = isBodyTooLarge
            ? '送出的內容超過大小限制，請縮小後再試。'
            : '送出的資料格式錯誤（不是有效的 JSON），請確認後再試。';
        console.warn(`[Client Request Error] ${errorType} ${req.method} ${req.originalUrl || req.url}`);
        await logErrorToDb(req, errorType, err, { severity: 'warn' });
        return res.status(status).json({ success: false, error: message });
    }

    console.error('[Global Server Error]:', err);
    await logErrorToDb(req, 'unhandled_server_error', err);

    res.status(500).json({
        success: false,
        error: 'An unexpected internal server error occurred.'
    });
});

// Express App 監聽
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;

// 供單元測試使用的內部函式（Vercel 只取 app 本身，掛額外屬性不影響部署）。
// 測試時請設 NODE_ENV=production，這樣 require 本檔才不會真的 app.listen 佔用 port。
app.__test__ = {
    parseAuditFilters,
    auditMatchesQuery,
    auditLogsToCsvRows,
    COMPETITION_CATEGORIES,
    normalizeCategory,
    normalizeTags,
    isMissingColumnError,
    hasTaxonomyContent,
    shouldIncludeTaxonomy,
    planImport,
    // v2.9.0
    normalizeTeamFields,
    hasTeamFieldsContent,
    shouldIncludeTeamFields,
    registrationState,
    parseImageDataUrl,
    competitionStartMs,
    pushCandidates,
    pushPayloadFor,
    POSTER_MAX_BYTES,
    isMissingTableError,
    toDateString,
    hashPassword,
    verifyPassword,
    needsPasswordUpgrade,
    resolveSupabaseKey,
    errorLogAlertSummary,
    twoFactorSchemaReady,
    verifySecondFactor,
    allowRegisterAttempt,
    USERNAME_RE,
    PASSWORD_RE,
    // v2.11.1：cron 端點授權（未設定 CRON_SECRET 時 production 必須拒絕）
    cronAuthorization,
    safeStringEqual,
    // v2.12.0：角色階梯、帳號管理與錯誤日誌強化
    ROLE_LEVELS,
    ROLE_LABELS,
    MANAGED_ROLES,
    roleLevel,
    canCreateRole,
    canManageUser,
    assertRoleAssignable,
    loginLockRemaining,
    recordLoginFailure,
    clearLoginFailures,
    LOGIN_IP_MAX_FAILURES,
    LOGIN_ACCOUNT_MAX_FAILURES,
    shouldLogAuthFailure,
    LOGIN_MAX_FAILURES,
    LOGIN_LOCK_MS,
    ERROR_LOG_FAILURES,
    noteErrorLogFailure
};
