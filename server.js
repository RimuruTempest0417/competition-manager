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

/* ---------- v2.19.0：報名視窗（registration_start_at／registration_end_at） ----------
   這兩個欄位在 v2.9.0 的 migration 就有了，但仍照本專案慣例「先探測、沒有就不帶」，
   讓還沒跑 migration 的環境不會整條 API 掛掉（主資料照樣存得進去）。 */
let schemaHasRegistrationWindow = null;

async function registrationWindowSchemaReady() {
    if (schemaHasRegistrationWindow !== null) return schemaHasRegistrationWindow;
    try {
        const { error } = await supabase
            .from('competitions')
            .select('id,registration_start_at,registration_end_at')
            .limit(1);
        schemaHasRegistrationWindow = !isMissingColumnError(error, ['registration_start_at', 'registration_end_at']);
        if (!schemaHasRegistrationWindow) {
            console.warn('⚠️ competitions 表缺少報名開始／截止欄位，報名時間將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        return true;
    }
    return schemaHasRegistrationWindow;
}

/* 只接受可解析的時間字串（前端送帶時區位移的 ISO；日期字串也收，視為當天 23:59） */
function normalizeRegistrationWindow(body) {
    const one = (raw) => {
        if (raw === null || raw === '' || raw === undefined) return null;
        if (typeof raw !== 'string') return null;
        const s = raw.trim();
        if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
        const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:00` : s);
        return isNaN(dt.getTime()) ? null : s;
    };
    const start = one(body.registration_start_at);
    const end = one(body.registration_end_at);

    // 舊欄位 registration_deadline（只有日期）與新欄位保持同步：由後端自己算，
    // 免得前端漏帶或兩邊算出不同日期。只有在請求「明確帶了 registration_end_at」時才動它，
    // 否則舊版前端只填 registration_deadline 會被這裡清掉。
    const derived = {};
    if (Object.prototype.hasOwnProperty.call(body, 'registration_end_at')) {
        derived.registration_deadline = end ? String(end).slice(0, 10) : null;
    }

    return Object.assign({ registration_start_at: start, registration_end_at: end }, derived);
}

/* v2.20.0：報名審核／候補兩個開關（只有在請求真的有帶欄位時才更新，避免舊前端把設定清掉） */
function normalizeReviewFlags(body) {
    const b = body || {};
    return {
        requires_approval: b.requires_approval === true || b.requires_approval === 'true',
        waitlist_enabled: b.waitlist_enabled === true || b.waitlist_enabled === 'true'
    };
}

function hasReviewFlagsContent(body) {
    const b = body || {};
    return Object.prototype.hasOwnProperty.call(b, 'requires_approval')
        || Object.prototype.hasOwnProperty.call(b, 'waitlist_enabled');
}

function hasRegistrationWindowContent(fields) {
    return !!(fields.registration_start_at || fields.registration_end_at);
}

function shouldIncludeRegistrationWindow(fields, schemaState) {
    return hasRegistrationWindowContent(fields) || schemaState === true;
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

/* ---------- 賽事狀態機（v2.19.0） ----------
   規則本體在 **`public/js/competition-state.js`**（UMD，前後端共用同一份，
   所以「前端預覽說可報名」與「後端真的放行」永遠一致）。這裡只做轉接與別名。
   狀態即時由「當下時間」推導（不存資料庫、不需要排程）→ 時間一到就自動切換。
*/
const CMCompetitionState = require('./public/js/competition-state');
const CMAnnouncements = require('./public/js/announcements');   // v2.26.0：公告可見性的唯一真實來源
const CMVenue = require('./public/js/venue');                    // v2.27.0：地圖連結規則的唯一真實來源
const CMStaff = require('./public/js/staff');                    // v2.27.0：工作人員角色規則的唯一真實來源
const CMPaging = require('./public/js/paging');                  // v3.0.0：分頁規則的唯一真實來源（前後端共用）
const CMStats = require('./public/js/stats');                    // v3.0.0：營運統計與圖表幾何的唯一真實來源
const CMResults = require('./public/js/results');                // v3.1.0：成績、名次與公布檢查的唯一真實來源
const COMPETITION_STATE_LABELS = CMCompetitionState.LABELS;
const COMPETITION_STATE_TONES = CMCompetitionState.TONES;
const competitionTimeline = CMCompetitionState.timeline;
const parseTimestamp = CMCompetitionState.parseTimestamp;
// v2.24.0：週期性賽事的判斷規則（與前端同一份純函式）
const planRecurringCreation = CMCompetitionState.planRecurringCreation;

function competitionState(comp, now, options) {
    return CMCompetitionState.evaluate(comp, now, options);
}

/* 報名是否可以送出（舊介面，保持 { open, reason } 形狀；實作已統一走賽事狀態機） */
function registrationState(comp, now, registeredCount) {
    return CMCompetitionState.registrationState(comp, now, registeredCount);
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
// v2.27.0：負結果只快取 60 秒。以前「一發現沒有欄位就永遠記住」，
// 導致 migration 執行後還在服務的暖實例仍舊看不到新欄位（線上實際發生過），
// 只能等實例被回收才恢復。正結果照舊快取（欄位不會自己消失）。
const COLUMN_NEGATIVE_TTL_MS = 60000;
const columnPresence = new Map();
async function columnExists(table, column) {
    const key = `${table}.${column}`;
    const cached = columnPresence.get(key);
    if (cached === true) return true;
    if (cached && Date.now() - cached.at < COLUMN_NEGATIVE_TTL_MS) return false;
    if (!hasSupabaseConfig) return false;
    const { error } = await supabase.from(table).select(column).limit(1);
    if (!error) {
        columnPresence.set(key, true);
        return true;
    }
    if (isMissingColumnError(error, [column])) {
        columnPresence.set(key, { at: Date.now() });
        return false;
    }
    return false; // 暫時性錯誤不快取，下次再試
}

/* v3.0.0：資料表是否存在（儀表板的選用區塊用，例如 competition_staff）。
   沿用同一套快取規則：正結果長快取、負結果 60 秒，migration 跑完不必等實例回收。 */
const tablePresence = new Map();
async function tableExists(table) {
    const cached = tablePresence.get(table);
    if (cached === true) return true;
    if (cached && Date.now() - cached.at < COLUMN_NEGATIVE_TTL_MS) return false;
    if (!hasSupabaseConfig) return false;
    const { error } = await supabase.from(table).select('id').limit(1);
    if (!error) {
        tablePresence.set(table, true);
        return true;
    }
    if (isMissingTableError(error)) {
        tablePresence.set(table, { at: Date.now() });
        return false;
    }
    return false;
}

/* v2.27.0：資料表／欄位探測的一致性快取。
   正結果快取整輪；負結果只快取 60 秒 —— 理由同上：migration 剛跑完時，
   暖實例才不會一直回報「尚未啟用」。探測丟出例外（連線問題）時不快取。 */
function createSchemaProbe(probeFn, ttlMs = COLUMN_NEGATIVE_TTL_MS) {
    let ready = null;
    let checkedAt = 0;
    return async function () {
        if (ready === true) return true;
        if (ready === false && Date.now() - checkedAt < ttlMs) return false;
        const result = await probeFn();
        ready = !!result;
        checkedAt = Date.now();
        return ready;
    };
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

/* v2.17.0：批次標記錯誤日誌為已處理
   ------------------------------------------------------------
   為什麼要批次：每次發版都會跑 `npm run triage`（scripts/error-log-triage.js）讀線上日誌做分析，
   分析完那些紀錄就該「收工」——否則清單會一直累積同一批舊訊息，首頁提示橫幅也永遠亮著，
   新的問題反而被舊雜訊蓋掉。這個端點讓巡檢腳本與介面能一次把「讀過的一批」標記為已處理。

   安全設計：
     - 只接受明確的 id 清單（最多 500 個／次），或 `all_unresolved: true`（內部上限 1000 筆），
       不接受「刪除」語意、也不會動到其他紀錄。
     - 一定留稽核（RESOLVE_ERROR_LOGS，含筆數與前 20 個 id），事後追得到是誰在什麼時候清的。
     - 未執行 v2.12.0 migration（沒有 resolved 欄位）時回 503 並附檔案路徑，不會靜默失敗。
*/
const ERROR_LOG_RESOLVE_MAX = 500;
const ERROR_LOG_RESOLVE_ALL_MAX = 1000;

function parseResolveIds(input) {
    if (!Array.isArray(input)) return { ids: null, error: 'ids 必須是陣列' };
    if (input.length > ERROR_LOG_RESOLVE_MAX) {
        return { ids: null, error: `單次最多標記 ${ERROR_LOG_RESOLVE_MAX} 筆（本次 ${input.length} 筆），請分批處理` };
    }
    const ids = [];
    for (const raw of input) {
        const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
        if (!Number.isInteger(n) || n <= 0) return { ids: null, error: `id 必須是正整數（收到 ${JSON.stringify(raw)}）` };
        ids.push(n);
    }
    return { ids: [...new Set(ids)], error: null };
}

app.post('/api/admin/error-logs/resolve', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const body = req.body || {};

    try {
        if (!(await columnExists('error_logs', 'resolved'))) {
            return res.status(503).json({ error: USER_MIGRATION_HINT });
        }

        let ids = [];
        if (body.all_unresolved === true) {
            const { data, error } = await supabase
                .from('error_logs')
                .select('id')
                .eq('resolved', false)
                .limit(ERROR_LOG_RESOLVE_ALL_MAX);
            if (error) throw error;
            ids = (data || []).map((row) => row.id);
        } else {
            const parsed = parseResolveIds(body.ids);
            if (parsed.error) return res.status(400).json({ error: parsed.error });
            ids = parsed.ids;
        }

        if (ids.length === 0) {
            return res.json({ success: true, resolved: 0, message: '沒有需要標記的紀錄', resolved_by: operator.username });
        }

        const nowIso = new Date().toISOString();
        const updates = { resolved: true };
        if (await columnExists('error_logs', 'resolved_at')) updates.resolved_at = nowIso;
        if (await columnExists('error_logs', 'resolved_by')) updates.resolved_by = operator.username;

        const { data, error } = await supabase
            .from('error_logs')
            .update(updates)
            .in('id', ids)
            .select('id');
        if (error) throw error;

        const changed = (data || []).length;
        await logAudit(operator.username, 'RESOLVE_ERROR_LOGS', null, {
            requested: ids.length,
            resolved: changed,
            all_unresolved: body.all_unresolved === true,
            sample_ids: ids.slice(0, 20)
        }, req.userAgent);

        res.json({
            success: true,
            resolved: changed,
            requested: ids.length,
            resolved_at: nowIso,
            resolved_by: operator.username,
            message: `已標記 ${changed} 筆為已處理`
        });
    } catch (err) {
        await logErrorToDb(req, 'resolve_error_logs_error', err);
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
        // v2.26.0：明細欄位還沒建時，前端要誠實顯示「尚無失敗資訊與重送」
        res.json({
            success: true,
            logs: data || [],
            detail_ready: await pushLogDetailSchemaReady(),
            hint: (await pushLogDetailSchemaReady()) ? null : PUSH_LOG_DETAIL_HINT
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_push_logs_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// v2.26.0：站內公告／訊息中心
// ==========================================
//
// 為什麼「誰看得到」要共用 CMAnnouncements：前後端各寫一套遲早不一致
// （列表看得到、點進去說無權；或管理員以為只發給路跑組、結果所有人都收到）。
// 資料表：announcements（公告本體）、announcement_reads（誰讀過了）、
//         admin_users.announce_categories（使用者訂閱的公告分類）。
// 未執行 migration 時：列表回空並附 schema_ready:false＋檔名提示、發布／修改回 503，其他功能不受影響。

const ANNOUNCEMENTS_HINT = '站內公告需要資料庫資料表，請先執行 migrations/2026-09-26-v2.26.0-announcements.sql';
const ANNOUNCEMENT_LIST_MAX = 200;   // 一次最多撈幾則（置頂與最新的都會在裡面）

const announcementsSchemaReady = createSchemaProbe(async () => {
    const { error } = await supabase.from('announcements').select('id').limit(1);
    if (!error) return true;
    if (isMissingTableError(error)) return false;
    throw error;   // 暫時性錯誤（連線…）不快取，否則之後都會以為功能沒開
});

const announceCategoriesReady = createSchemaProbe(() => columnExists('admin_users', 'announce_categories'));

const isAdminRoleName = (role) => ADMIN_ROLES.has(role);
const categoryChips = (ids) => (Array.isArray(ids) ? ids : [])
    .map((cid) => {
        const found = COMPETITION_CATEGORIES.find((c) => c.id === cid);
        return found ? found.label : cid;
    })
    .join('、');

/* 我訂閱的公告分類（欄位不存在或讀不到 → 空陣列，不影響其他功能） */
async function myAnnounceCategories(userId) {
    if (!(await announceCategoriesReady())) return [];
    try {
        const { data, error } = await supabase.from('admin_users').select('announce_categories').eq('id', userId).maybeSingle();
        if (error) return [];
        const list = data && data.announce_categories;
        return Array.isArray(list) ? list.filter((c) => CATEGORY_IDS.has(c)) : [];
    } catch (err) {
        return [];
    }
}

/* 有效使用者人數（公告的「幾個人看得到」參考值；讀不到就回 null，不讓列表因此失敗） */
async function countActiveUsers() {
    const hasActive = await columnExists('admin_users', 'is_active');
    const { data, error } = await supabase.from('admin_users').select(hasActive ? 'id,is_active' : 'id');
    if (error) throw error;
    const rows = data || [];
    return hasActive ? rows.filter((u) => u.is_active !== false).length : rows.length;
}

/* 我讀過的公告 id（Set，字串；表不存在時視為都沒讀過） */
async function myAnnouncementReadIds(userId) {
    try {
        const { data, error } = await supabase.from('announcement_reads').select('announcement_id').eq('user_id', userId);
        if (error) throw error;
        return new Set((data || []).map((r) => String(r.announcement_id)));
    } catch (err) {
        if (isMissingTableError(err)) return new Set();
        throw err;
    }
}

/* 發布公告時的通知（依對象送給「看得到的人」的訂閱） */
async function pushAnnouncement(announcement) {
    if (!(await pushEventEnabled('announce'))) {
        return { sent: 0, total: 0, skipped: `站台設定已關閉「${PUSH_SETTING_LABELS.event_announce}」` };
    }
    const { data: users, error } = await supabase.from('admin_users').select('id,role,is_active,announce_categories');
    if (error) throw error;
    const targets = (users || []).filter((u) => {
        if (u.is_active === false) return false;   // 停用帳號不推
        return CMAnnouncements.matchesAudience(announcement, {
            isAdmin: isAdminRoleName(u.role),
            categories: Array.isArray(u.announce_categories) ? u.announce_categories : []
        });
    });
    if (!targets.length) return { sent: 0, total: 0, skipped: '沒有符合對象的使用者' };

    const ids = new Set(targets.map((u) => String(u.id)));
    const { data: allSubs, error: subErr } = await supabase
        .from('push_subscriptions')
        .select('id,user_id,endpoint,p256dh,auth,is_active')
        .eq('is_active', true);
    if (subErr) throw subErr;
    const subs = (allSubs || []).filter((s) => ids.has(String(s.user_id)));

    const payload = {
        kind: 'announce',
        title: `📣 ${announcement.title}`,
        body: String(announcement.body || '').slice(0, 90),
        url: `/?announce=${announcement.id}`,
        tag: `cm-announce-${announcement.id}`
    };

    let sent = 0;
    let failed = 0;
    let deactivated = 0;
    const errors = [];
    for (const sub of subs) {
        const result = await sendPushTo(sub, payload);
        if (result.ok) sent += 1;
        else if (result.gone) {
            deactivated += 1;
            await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', sub.id);
        } else {
            failed += 1;
            if (result.error) errors.push(result.error);
        }
    }

    await logPushEvent(null, 'announcement', sent, {
        failed,
        errors,
        payload,
        target_user_id: null,
        target_user_ids: Array.from(ids)
    });

    return {
        sent, failed, total: subs.length, deactivated, target_users: ids.size,
        errors: Array.from(new Set(errors)).slice(0, 5)
    };
}

/* 我的公告（所有已登入使用者；只回「我這個時間點看得到」的那些） */
app.get('/api/my/announcements', authenticateToken, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) {
            return res.json({
                success: true, announcements: [], unread_count: 0, my_categories: [],
                all_categories: COMPETITION_CATEGORIES, schema_ready: false, hint: ANNOUNCEMENTS_HINT
            });
        }
        const myCategories = await myAnnounceCategories(req.user.sub);
        const { data, error } = await supabase
            .from('announcements')
            .select('id,title,body,audience,categories,is_pinned,is_active,publish_at,expires_at,created_at,created_by')
            .eq('is_active', true)
            .order('publish_at', { ascending: false })
            .limit(ANNOUNCEMENT_LIST_MAX);
        if (error) throw error;

        const viewer = { isAdmin: isAdminRoleName(req.user.role), categories: myCategories };
        const visible = CMAnnouncements.sortForDisplay(
            CMAnnouncements.visibleFor(data || [], viewer, Date.now())
        );
        const reads = await myAnnouncementReadIds(req.user.sub);
        const items = visible.map((a) => Object.assign({}, a, {
            read: reads.has(String(a.id)),
            audience_label: CMAnnouncements.audienceLabel(a.audience)
        }));

        res.json({
            success: true,
            announcements: items,
            unread_count: CMAnnouncements.unreadCount(items, reads),
            my_categories: myCategories,
            all_categories: COMPETITION_CATEGORIES,
            schema_ready: true
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_announcements_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 標記已讀／全部已讀（冪等：重複標記不會長出重複列） */
app.post('/api/my/announcements/read-all', authenticateToken, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        if (!ids.length) return res.status(400).json({ error: '沒有要標記的公告' });
        if (ids.length > ANNOUNCEMENT_LIST_MAX) return res.status(400).json({ error: `一次最多標記 ${ANNOUNCEMENT_LIST_MAX} 則` });

        const now = new Date().toISOString();
        const rows = ids.map((announcementId) => ({ announcement_id: announcementId, user_id: req.user.sub, read_at: now }));
        const { error } = await supabase
            .from('announcement_reads')
            .upsert(rows, { onConflict: 'announcement_id,user_id' });
        if (error) throw error;
        res.json({ success: true, marked: ids.length });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'mark_announcements_read_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 我訂閱的公告分類（audience = 'category' 的公告靠這個比對） */
app.post('/api/my/announce-categories', authenticateToken, async (req, res) => {
    try {
        if (!(await announceCategoriesReady())) {
            return res.status(503).json({ error: '公告分類訂閱需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-announcements.sql' });
        }
        const raw = (req.body && req.body.categories) || [];
        if (!Array.isArray(raw)) return res.status(400).json({ error: 'categories 必須是陣列' });
        const categories = Array.from(new Set(raw.map(String).filter((c) => CATEGORY_IDS.has(c))));
        const { error } = await supabase.from('admin_users').update({ announce_categories: categories }).eq('id', req.user.sub);
        if (error) throw error;
        res.json({
            success: true, categories,
            message: categories.length
                ? `已訂閱 ${categoryChips(categories)} 的公告`
                : '已取消所有公告分類訂閱'
        });
    } catch (err) {
        if (isMissingColumnError(err, ['announce_categories'])) {
            return res.status(503).json({ error: '公告分類訂閱需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-announcements.sql' });
        }
        await logErrorToDb(req, 'save_announce_categories_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：列出全部公告（含未上架與已過期）＋每則的已讀人數 */
app.get('/api/admin/announcements', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) {
            return res.json({ success: true, announcements: [], schema_ready: false, hint: ANNOUNCEMENTS_HINT });
        }
        const { data, error } = await supabase
            .from('announcements')
            .select('*')
            .order('publish_at', { ascending: false })
            .limit(ANNOUNCEMENT_LIST_MAX);
        if (error) throw error;

        let readCounts = new Map();
        try {
            const { data: reads, error: readErr } = await supabase.from('announcement_reads').select('announcement_id');
            if (readErr) throw readErr;
            (reads || []).forEach((r) => {
                const key = String(r.announcement_id);
                readCounts.set(key, (readCounts.get(key) || 0) + 1);
            });
        } catch (readErr) {
            if (!isMissingTableError(readErr)) throw readErr;
            readCounts = new Map();
        }

        const totalUsers = await countActiveUsers().catch(() => null);
        const items = (data || []).map((a) => Object.assign({}, a, {
            audience_label: CMAnnouncements.audienceLabel(a.audience),
            read_count: readCounts.get(String(a.id)) || 0,
            is_live: CMAnnouncements.isLive(a, Date.now())
        }));
        res.json({ success: true, announcements: items, total_users: totalUsers, schema_ready: true });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'fetch_admin_announcements_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：發布公告（可同時推播） */
app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const normalized = CMAnnouncements.normalizeInput(req.body, COMPETITION_CATEGORIES.map((c) => c.id));
        if (normalized.error) return res.status(400).json({ error: normalized.error });

        const now = new Date().toISOString();
        const row = Object.assign({}, normalized.value, {
            created_by: req.currentUser.username,
            created_at: now,
            updated_at: now
        });
        const { data, error } = await supabase.from('announcements').insert([row]).select();
        if (error) throw error;
        const created = (data && data[0]) || row;

        let push = { sent: 0, skipped: '沒有勾選「同時發送推播」' };
        if (normalized.value.notify_push) {
            try {
                push = await pushAnnouncement(created);
            } catch (pushErr) {
                push = { sent: 0, error: pushErr.message };
                await logErrorToDb(req, 'announcement_push_error', pushErr);
            }
        }

        const audienceText = CMAnnouncements.audienceLabel(normalized.value.audience)
            + (normalized.value.categories.length ? `：${categoryChips(normalized.value.categories)}` : '');
        await logAudit(req.currentUser.username, 'CREATE_ANNOUNCEMENT', created.id || null,
            `發布公告「${normalized.value.title}」（對象 ${audienceText}）${normalized.value.notify_push ? `，推播成功 ${push.sent} 則` : ''}`,
            req.userAgent);

        res.json({ success: true, announcement: created, push });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'create_announcement_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

/* 管理端：修改公告（只覆蓋有帶的欄位；下架用 is_active:false，資料留著） */
app.patch('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
    try {
        if (!(await announcementsSchemaReady())) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '公告編號不對' });

        const { data: existing, error } = await supabase.from('announcements').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!existing) return res.status(404).json({ error: '找不到這則公告' });

        // 用「現有值＋這次帶的欄位」再跑一次同一份驗證，避免改一半變成壞資料
        const merged = Object.assign({}, existing, req.body || {});
        const normalized = CMAnnouncements.normalizeInput(merged, COMPETITION_CATEGORIES.map((c) => c.id));
        if (normalized.error) return res.status(400).json({ error: normalized.error });

        const patch = Object.assign({}, normalized.value, { updated_at: new Date().toISOString() });
        const changes = [];
        const fieldLabels = {
            title: '標題', body: '內容', audience: '對象', categories: '分類',
            is_pinned: '置頂', is_active: '上架', notify_push: '發布時推播',
            publish_at: '發布時間', expires_at: '結束時間'
        };
        Object.keys(fieldLabels).forEach((field) => {
            const before = existing[field];
            const after = patch[field];
            const same = Array.isArray(before) || Array.isArray(after)
                ? JSON.stringify(before || []) === JSON.stringify(after || [])
                : String(before === undefined ? '' : before) === String(after === undefined ? '' : after);
            if (same) return;
            if (field === 'audience') {
                changes.push(`${fieldLabels[field]}：${CMAnnouncements.audienceLabel(before)} → ${CMAnnouncements.audienceLabel(after)}`);
            } else if (field === 'categories') {
                changes.push(`${fieldLabels[field]}：${categoryChips(before) || '（無）'} → ${categoryChips(after) || '（無）'}`);
            } else if (field === 'is_pinned' || field === 'is_active' || field === 'notify_push') {
                changes.push(`${fieldLabels[field]}：${before ? '是' : '否'} → ${after ? '是' : '否'}`);
            } else if (field === 'body') {
                changes.push('內容已更新');
            } else {
                changes.push(`${fieldLabels[field]}：${before === null || before === undefined ? '（無）' : before} → ${after === null || after === undefined ? '（無）' : after}`);
            }
        });

        const { error: updErr } = await supabase.from('announcements').update(patch).eq('id', id);
        if (updErr) throw updErr;

        await logAudit(req.currentUser.username, 'UPDATE_ANNOUNCEMENT', id,
            changes.length ? `修改公告「${patch.title}」：${changes.join('；')}` : `修改公告「${patch.title}」（內容沒有變動）`,
            req.userAgent);

        res.json({ success: true, announcement: Object.assign({}, existing, patch), changes });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: ANNOUNCEMENTS_HINT });
        await logErrorToDb(req, 'update_announcement_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// v2.26.0：重送某一筆推播（管理員以上）
// 語意：把「當時送出去的內容」再送一次給同一批對象（單一使用者的通知只送給那個人）。
// 這是**手動**動作，因此不受「自動通知開關」影響（開關管的是系統自動發的那些）；
// 但每一筆重送都會留稽核，失敗原因也會回報。
app.post('/api/admin/push-logs/:id/resend', requireAdmin, async (req, res) => {
    try {
        if (!(await pushLogDetailSchemaReady())) return res.status(503).json({ error: PUSH_LOG_DETAIL_HINT });
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '推播紀錄編號不對' });

        const { data: row, error } = await supabase.from('push_log').select('*').eq('id', id).maybeSingle();
        if (error) {
            if (isMissingTableError(error)) return res.status(503).json({ error: PUSH_HINT });
            throw error;
        }
        if (!row) return res.status(404).json({ error: '找不到這筆推播紀錄' });
        if (!row.payload || !row.payload.title) {
            return res.status(400).json({ error: '這筆紀錄沒有可重送的內容（v2.26.0 之前的紀錄只記了筆數）' });
        }

        // 找要送的訂閱：有指定使用者就只送給他，否則送給所有有效訂閱
        const { data: allSubs, error: subErr } = await supabase
            .from('push_subscriptions')
            .select('id,user_id,endpoint,p256dh,auth,is_active')
            .eq('is_active', true);
        if (subErr) throw subErr;
        // 重送的對象：單一使用者 → 只給他；一組使用者（例如公告）→ 只給那組；都沒有 → 所有有效訂閱
        const targetIds = (Array.isArray(row.target_user_ids) && row.target_user_ids.length)
            ? new Set(row.target_user_ids.map(String))
            : ((row.target_user_id === null || row.target_user_id === undefined)
                ? null
                : new Set([String(row.target_user_id)]));
        const subs = (allSubs || []).filter((s) => !targetIds || targetIds.has(String(s.user_id)));

        let sent = 0;
        let failed = 0;
        let deactivated = 0;
        const errors = [];
        for (const sub of subs) {
            const result = await sendPushTo(sub, row.payload);
            if (result.ok) sent += 1;
            else if (result.gone) {
                deactivated += 1;
                await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', sub.id);
            } else {
                failed += 1;
                if (result.error) errors.push(result.error);
            }
        }

        const resendCount = Number(row.resend_count || 0) + 1;
        const { error: updError } = await supabase.from('push_log').update({
            resend_count: resendCount,
            resend_at: new Date().toISOString(),
            resend_sent_count: sent
        }).eq('id', id);
        if (updError) throw updError;

        const scopeText = targetIds
            ? (targetIds.size === 1 && row.target_user_id ? `限使用者 #${row.target_user_id}` : `限 ${targetIds.size} 位使用者`)
            : '所有有效訂閱';
        await logAudit(req.user.username, 'RESEND_PUSH', row.competition_id || null,
            `重送推播紀錄 #${id}（${row.kind}，${scopeText}）：成功 ${sent}、失敗 ${failed}${deactivated ? `、失效訂閱 ${deactivated}` : ''}`,
            req.userAgent);

        res.json({
            success: true,
            sent, failed, deactivated,
            total: subs.length,
            resend_count: resendCount,
            errors: Array.from(new Set(errors)).slice(0, 5)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'resend_push_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// v2.27.0：場地地圖連結＋工作人員指派（Roadmap P1-5）
// ==========================================
//
// ① 地圖連結：賽事多一個 map_url。**沒填不擋**——前端用地址自動產生 Google 地圖搜尋連結
//    （規則唯一真實來源 public/js/venue.js），所以舊資料不用補、也不會出現「有地點卻沒有地圖」。
// ② 工作人員：哪個帳號在這場賽事擔任裁判／記錄／攝影（同一場同一人一個角色，
//    改角色＝更新同一列）。角色與驗證規則走 public/js/staff.js。
// 未執行 migration 時：地圖改用地址自動產生（功能照常）、工作人員清單回 schema_ready:false＋檔名、
// 指派／移除回 503，其他功能完全不受影響。
//
// 隱私界線：GET 是公開端點（賽事工作人員本來就是公開資訊），但只回帳號名稱與角色；
// 不帶 email、不帶權限、不帶任何 token。寫入一律 requireAdmin 並留稽核。

const VENUE_STAFF_HINT = '地圖連結與工作人員指派需要資料表欄位，請先執行 migrations/2026-09-26-v2.27.0-venue-staff.sql';

const mapUrlSchemaReady = createSchemaProbe(() => columnExists('competitions', 'map_url'));
const staffSchemaReady = createSchemaProbe(async () => {
    const { error } = await supabase.from('competition_staff').select('id').limit(1);
    if (!error) return true;
    if (isMissingTableError(error)) return false;
    throw error;   // 暫時性錯誤不快取
});

/* 讀一場賽事的工作人員（附帳號名稱）。
   帳號被刪掉時照樣列出這一列、名稱顯示「（帳號已刪除）」——
   不要因為帳號不見就讓指派從畫面上消失，賽事當天會少一個人。 */
async function loadCompetitionStaff(competitionId) {
    const { data, error } = await supabase
        .from('competition_staff')
        .select('id,competition_id,user_id,role,note,assigned_by,created_at,updated_at')
        .eq('competition_id', competitionId);
    if (error) throw error;

    const ids = Array.from(new Set((data || []).map((r) => r.user_id)));
    let userById = new Map();
    if (ids.length) {
        const { data: users, error: userError } = await supabase
            .from('admin_users')
            .select('id,username,role')
            .in('id', ids);
        if (userError) throw userError;
        userById = new Map((users || []).map((u) => [String(u.id), u]));
    }

    const rows = (data || []).map((row) => {
        const user = userById.get(String(row.user_id));
        return {
            id: row.id,
            competition_id: row.competition_id,
            user_id: row.user_id,
            username: user ? user.username : null,
            role: CMStaff.normalizeRole(row.role),
            role_label: CMStaff.roleLabel(row.role),
            role_emoji: CMStaff.roleEmoji(row.role),
            note: row.note || null,
            assigned_by: row.assigned_by || null,
            created_at: row.created_at || null,
            updated_at: row.updated_at || null
        };
    });
    return CMStaff.staffSort(rows);
}

// 讀取某場賽事的工作人員（公開；只回角色與帳號名稱）
app.get('/api/competitions/:id/staff', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '賽事編號不對' });

        if (!(await staffSchemaReady())) {
            return res.json({
                success: true, staff: [], summary: CMStaff.staffSummary([]),
                roles: CMStaff.STAFF_ROLES, schema_ready: false, hint: VENUE_STAFF_HINT
            });
        }

        const staff = await loadCompetitionStaff(id);
        res.json({
            success: true, staff, summary: CMStaff.staffSummary(staff),
            roles: CMStaff.STAFF_ROLES, schema_ready: true
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'get_competition_staff_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 指派／調整工作人員（管理員以上）。同一場同一人只有一個角色：已存在就改角色。
app.post('/api/competitions/:id/staff', requireAdmin, async (req, res) => {
    try {
        if (!(await staffSchemaReady())) return res.status(503).json({ error: VENUE_STAFF_HINT });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '賽事編號不對' });

        const parsed = CMStaff.normalizeStaffInput(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        // 沒帶 note 欄位＝不要動既有備註；帶了就照帶的值（含清空）
        const noteProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'note');

        const { data: comp, error: compError } = await supabase
            .from('competitions').select('id,name').eq('id', id).maybeSingle();
        if (compError) throw compError;
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const { data: user, error: userError } = await supabase
            .from('admin_users').select('id,username,is_active').eq('id', parsed.value.user_id).maybeSingle();
        if (userError) throw userError;
        if (!user) return res.status(404).json({ error: '找不到這個帳號' });
        if (user.is_active === false) {
            return res.status(400).json({ error: `${user.username} 是停用中的帳號，不能指派為工作人員` });
        }

        const { data: existing, error: existError } = await supabase
            .from('competition_staff')
            .select('id,role,note')
            .eq('competition_id', id)
            .eq('user_id', parsed.value.user_id)
            .maybeSingle();
        if (existError) throw existError;

        const roleLabel = CMStaff.roleLabel(parsed.value.role);
        const noteText = (noteProvided ? parsed.value.note : (existing && existing.note)) || '';
        let changed = 'created';

        if (existing) {
            changed = 'updated';
            const beforeLabel = CMStaff.roleLabel(existing.role);
            const { error } = await supabase.from('competition_staff').update({
                role: parsed.value.role,
                note: noteProvided ? parsed.value.note : existing.note,
                assigned_by: req.user.username,
                updated_at: new Date().toISOString()
            }).eq('id', existing.id);
            if (error) throw error;
            await logAudit(req.user.username, 'ASSIGN_STAFF', id,
                beforeLabel === roleLabel
                    ? `更新工作人員 ${user.username}（${roleLabel}）${noteText ? `，備註：${noteText}` : ''}｜賽事：${comp.name}`
                    : `調整工作人員 ${user.username} 的角色：${beforeLabel} → ${roleLabel}｜賽事：${comp.name}`,
                req.userAgent);
        } else {
            const { error } = await supabase.from('competition_staff').insert([{
                competition_id: id,
                user_id: parsed.value.user_id,
                role: parsed.value.role,
                note: parsed.value.note,
                assigned_by: req.user.username,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
            if (error) throw error;
            await logAudit(req.user.username, 'ASSIGN_STAFF', id,
                `指派工作人員：${user.username} 為「${roleLabel}」${noteText ? `（${noteText}）` : ''}｜賽事：${comp.name}`,
                req.userAgent);
        }

        const staff = await loadCompetitionStaff(id);
        res.json({
            success: true, changed, staff,
            summary: CMStaff.staffSummary(staff), roles: CMStaff.STAFF_ROLES,
            assigned: { user_id: parsed.value.user_id, username: user.username, role: parsed.value.role, role_label: roleLabel }
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'assign_competition_staff_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 移除工作人員（管理員以上）
app.delete('/api/staff/:id', requireAdmin, async (req, res) => {
    try {
        if (!(await staffSchemaReady())) return res.status(503).json({ error: VENUE_STAFF_HINT });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '工作人員指派編號不對' });

        const { data: row, error } = await supabase
            .from('competition_staff').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ error: '找不到這筆工作人員指派' });

        // 稽核要寫「誰被移除」，所以先問一次帳號名稱（問不到就用編號）
        const { data: user } = await supabase
            .from('admin_users').select('username').eq('id', row.user_id).maybeSingle();
        const who = (user && user.username) || `帳號 #${row.user_id}`;

        const { error: delError } = await supabase.from('competition_staff').delete().eq('id', id);
        if (delError) throw delError;

        await logAudit(req.user.username, 'REMOVE_STAFF', row.competition_id,
            `移除工作人員：${who}（${CMStaff.roleLabel(row.role)}）`, req.userAgent);

        const staff = await loadCompetitionStaff(row.competition_id);
        res.json({ success: true, removed: { id, user_id: row.user_id, username: who }, staff, summary: CMStaff.staffSummary(staff), roles: CMStaff.STAFF_ROLES });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: VENUE_STAFF_HINT });
        await logErrorToDb(req, 'remove_competition_staff_error', err);
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
    REGISTER_APPROVED: '核准報名（審核）',
    REGISTER_REJECTED: '拒絕報名（審核）',
    PROMOTE_WAITLIST: '手動遞補候補',
    REORDER_WAITLIST: '調整候補順位',
    WAITLIST_NOTIFY: '調整遞補通知設定',
    DUPLICATE_COMPETITION: '複製賽事',
    SET_RECURRENCE: '設定賽事週期',
    CREATE_RECURRING_COMPETITION: '週期性賽事建立下一場',
    UPDATE_PUSH_SETTINGS: '更新推播設定',
    RESEND_PUSH: '重送推播',
    CREATE_ANNOUNCEMENT: '發布公告',
    UPDATE_ANNOUNCEMENT: '修改公告',
    ASSIGN_STAFF: '指派／調整工作人員',
    SAVE_RESULTS: '登錄成績',
    PUBLISH_RESULTS: '公布成績',
    UNPUBLISH_RESULTS: '取消公布成績',
    REMOVE_STAFF: '移除工作人員',
    AUTO_PROMOTE_WAITLIST: '自動遞補候補',
    PURGE_AUDIT_LOGS: '清理稽核日誌',
    '2FA_SETUP_STARTED': '開始設定兩步驟驗證',
    '2FA_ENABLED': '啟用兩步驟驗證',
    '2FA_DISABLED': '停用兩步驟驗證',
    '2FA_DISABLE_FAILED': '停用兩步驟驗證失敗',
    '2FA_RESET_BY_ADMIN': '管理員重設兩步驟驗證',
    '2FA_RECOVERY_CODE_USED': '使用備援碼登入',
    LOGIN_LOCKED: '登入失敗次數過多（鎖定）',
    REGISTER_USER: '使用者自助註冊',
    REMOVE_TEAM_MEMBER: '移除隊伍成員',
    UPLOAD_POSTER: '上傳海報',
    DELETE_POSTER: '刪除海報',
    EXPORT_COMPETITIONS: '匯出賽事 CSV',
    IMPORT_COMPETITIONS: '匯入賽事 CSV',
    EXPORT_BACKUP: '匯出資料備份',
    RESTORE_BACKUP: '還原資料備份',
    RESTORE_BACKUP_DRY_RUN: '檢查資料備份（只檢查、未寫入）',
    EXPORT_AUDIT_LOGS: '匯出稽核日誌 CSV',
    CLEANUP_ERROR_LOGS: '清理錯誤日誌',
    RESOLVE_ERROR_LOG: '標記錯誤日誌已處理',
    REOPEN_ERROR_LOG: '重新開啟錯誤日誌',
    RESOLVE_ERROR_LOGS: '批次標記錯誤日誌已處理',
    // v2.12.0 以前的帳號管理動作名稱（歷史紀錄要用，新程式碼請用 CREATE_USER 等）
    CREATE_ADMIN: '建立帳號（舊名稱）',
    UPDATE_ADMIN: '更新帳號（舊名稱）',
    DELETE_ADMIN: '刪除帳號（舊名稱）'
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
// 資料備份與還原（v2.18.0）
// ------------------------------------------
// 為什麼要做：這個系統唯一的資料安全網是 Supabase 自己。誤刪大量資料（例如手滑按了清理、
// 或匯入覆蓋）沒有回頭路。備份與還原就是把「回頭路」補上。
//
// 設計取捨：
//   1. 走自家 API（service_role 只在伺服器上）：本機不需要資料庫金鑰，開 RLS 後照樣可用，
//      也順便讓「誰做了備份／還原」自動進稽核日誌。
//   2. **匯出順序 = 還原順序**，且以外部鍵相依性排序（competitions 先於 registrations／posters／teams）。
//   3. 還原採「upsert（有就更新、沒有就新增）」，**不刪除任何備份中沒有的資料**：
//      刪除是不可逆的，這種事不該由「還原」順手做（要刪有資源回收桶與清理端點）。
//   4. 備份帶 checksum（tables 內容的 sha256）與每表筆數；還原時會驗證，
//      檔案被改過就拒絕（除非 --force），避免「以為還原了其實還原了半份壞資料」。
//   5. 稽核日誌與錯誤日誌**預設不備份**（量大、且已有 CSV 匯出），要用再開。
// ==========================================
const BACKUP_TABLES = ['app_settings', 'admin_users', 'competitions', 'competition_posters',
    'registrations', 'competition_teams', 'push_subscriptions', 'push_log'];
const BACKUP_LOG_TABLES = ['audit_logs', 'error_logs'];
const RESTORE_CONFLICT_KEYS = {
    app_settings: 'key',
    admin_users: 'id',
    competitions: 'id',
    competition_posters: 'competition_id',
    registrations: 'id',
    competition_teams: 'id',
    push_subscriptions: 'endpoint',
    push_log: 'id',
    audit_logs: 'id',
    error_logs: 'id'
};
const BACKUP_MAX_ROWS_PER_TABLE = 20000;
const RESTORE_CHUNK_SIZE = 200;

function resolveBackupTables({ includeLogs = false, includePosters = true, only = null } = {}) {
    const allowed = BACKUP_TABLES.concat(includeLogs ? BACKUP_LOG_TABLES : []);
    const chosen = allowed.filter((t) => (includePosters ? true : t !== 'competition_posters'));
    if (!only) return { tables: chosen, unknown: [] };
    const requested = only.filter((t) => RESTORE_CONFLICT_KEYS[t]);
    const unknown = only.filter((t) => !RESTORE_CONFLICT_KEYS[t]);
    // 只允許匯出「本來就開放的表」，避免有人拿 tables= 去撈別的資料
    return { tables: chosen.filter((t) => requested.includes(t)), unknown };
}

// 正規化後的內容檢查碼：表名排序後序列化，因此 JSON 往返（parse→stringify）不會改變結果
function canonicalTablesJson(tables) {
    const sorted = {};
    for (const key of Object.keys(tables || {}).sort()) sorted[key] = tables[key];
    return JSON.stringify(sorted);
}

function backupChecksum(tables) {
    return crypto.createHash('sha256').update(canonicalTablesJson(tables)).digest('hex');
}

// 驗證備份檔結構與完整性（純函式，方便測試）
function verifyBackupIntegrity(backup) {
    if (!backup || typeof backup !== 'object') return { ok: false, reason: '備份內容不是物件' };
    if (!backup.tables || typeof backup.tables !== 'object') return { ok: false, reason: '缺少 tables 欄位' };
    if (!backup.meta || typeof backup.meta !== 'object') return { ok: false, reason: '缺少 meta 欄位' };
    const tableNames = Object.keys(backup.tables);
    if (tableNames.length === 0) return { ok: false, reason: '備份中沒有任何資料表' };
    for (const name of tableNames) {
        if (!RESTORE_CONFLICT_KEYS[name]) return { ok: false, reason: `不認識的資料表：${name}` };
        if (!Array.isArray(backup.tables[name])) return { ok: false, reason: `${name} 的內容不是陣列` };
    }
    const expected = backup.meta.checksum;
    const actual = backupChecksum(backup.tables);
    if (expected && expected !== actual) {
        return { ok: false, reason: 'checksum 不符（檔案可能被修改過）', expected, actual };
    }
    return { ok: true, checksum: actual, tables: tableNames.length, checked: Boolean(expected) };
}

function countBackupRows(tables) {
    return Object.values(tables || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
}

function chunkRows(rows, size = RESTORE_CHUNK_SIZE) {
    const out = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}

// 備份下載（含 meta：版本、時間、每表筆數、checksum）
app.get('/api/admin/backup', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    try {
        const includeLogs = req.query.include_logs === 'true';
        const includePosters = req.query.include_posters !== 'false';
        const only = req.query.tables ? String(req.query.tables).split(',').map((s) => s.trim()).filter(Boolean) : null;
        const { tables, unknown } = resolveBackupTables({ includeLogs, includePosters, only });

        const dump = {};
        const tableMeta = {};
        const missing = [];
        const truncated = [];
        for (const name of tables) {
            // eslint-disable-next-line no-await-in-loop
            const { data, error } = await supabase.from(name).select('*').limit(BACKUP_MAX_ROWS_PER_TABLE);
            if (error) {
                if (isMissingTableError(error)) { missing.push(name); continue; }
                throw error;
            }
            dump[name] = data || [];
            tableMeta[name] = { rows: dump[name].length };
            if (dump[name].length >= BACKUP_MAX_ROWS_PER_TABLE) truncated.push(name);
        }

        const meta = {
            app: 'competition-manager',
            version: require('./package.json').version,
            generated_at: new Date().toISOString(),
            generated_by: operator.username,
            tables: tableMeta,
            total_rows: countBackupRows(dump),
            checksum: backupChecksum(dump),
            skipped: includePosters ? [] : ['competition_posters（本次未包含海報圖片）'],
            missing_tables: missing,
            truncated_tables: truncated,
            unknown_tables: unknown
        };

        await logAudit(operator.username, 'EXPORT_BACKUP', null, {
            tables: Object.keys(dump), rows: meta.total_rows, include_logs: includeLogs, include_posters: includePosters
        }, req.userAgent);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cm-backup-${meta.generated_at.replace(/[:.]/g, '-')}.json"`);
        res.json({ meta, tables: dump });
    } catch (err) {
        await logErrorToDb(req, 'export_backup_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 還原（預設只檢查：dry_run=true 不寫任何資料）
app.post('/api/admin/restore', requireSuperAdmin, async (req, res) => {
    const operator = req.currentUser;
    const body = req.body || {};
    const backup = body.backup;
    const dryRun = body.dry_run === true;
    const force = body.force === true;
    const only = Array.isArray(body.tables) && body.tables.length ? body.tables : null;

    try {
        const integrity = verifyBackupIntegrity(backup);
        if (!integrity.ok && !force) {
            return res.status(400).json({ success: false, error: `備份檔驗證失敗：${integrity.reason}`, integrity });
        }

        if (!dryRun && body.confirm !== 'RESTORE') {
            return res.status(400).json({
                success: false,
                error: '還原需要明確確認：請在請求中帶入 confirm: "RESTORE"（介面會先做一次檢查再讓你確認）'
            });
        }

        const plan = [];
        for (const name of Object.keys(RESTORE_CONFLICT_KEYS)) {
            const rows = backup.tables ? backup.tables[name] : null;
            if (!Array.isArray(rows) || rows.length === 0) continue;
            if (only && !only.includes(name)) continue;
            plan.push({ table: name, rows: rows.length, conflict_key: RESTORE_CONFLICT_KEYS[name] });
        }
        const totalRows = plan.reduce((s, p) => s + p.rows, 0);

        if (plan.length === 0) {
            return res.json({ success: true, restored: 0, plan: [], dry_run: dryRun, message: '備份中沒有可還原的資料' });
        }

        if (dryRun) {
            await logAudit(operator.username, 'RESTORE_BACKUP_DRY_RUN', null, { plan, force }, req.userAgent);
            return res.json({
                success: true, dry_run: true, plan, would_restore: totalRows,
                integrity,
                message: `檢查完成：將還原 ${plan.length} 張表、共 ${totalRows} 筆（未寫入任何資料）`
            });
        }

        const perTable = {};
        const failures = [];
        for (const item of plan) {
            const rows = backup.tables[item.table];
            let done = 0;
            for (const batch of chunkRows(rows)) {
                // eslint-disable-next-line no-await-in-loop
                const { error } = await supabase
                    .from(item.table)
                    // 注意：supabase-js 的選項名是 camelCase 的 onConflict（不是 PostgREST 的 on_conflict 參數名），
                    // 寫錯會靜默退回「以主鍵為衝突目標」，遇到主鍵≠唯一鍵的表（如 push_subscriptions）就會撞 23505。
                    .upsert(batch, { onConflict: RESTORE_CONFLICT_KEYS[item.table] });
                if (error) {
                    failures.push({ table: item.table, error: error.message || String(error) });
                    break;
                }
                done += batch.length;
            }
            perTable[item.table] = done;
        }

        const restored = Object.values(perTable).reduce((s, n) => s + n, 0);
        await logAudit(operator.username, 'RESTORE_BACKUP', null, {
            restored, per_table: perTable, failures, force, backup_meta: {
                generated_at: backup.meta && backup.meta.generated_at,
                version: backup.meta && backup.meta.version,
                total_rows: backup.meta && backup.meta.total_rows
            }
        }, req.userAgent);

        if (failures.length) {
            await logErrorToDb(req, 'restore_backup_partial_failure', new Error(
                `還原未完全成功：${failures.map((f) => f.table).join('、')}`
            ), { severity: 'error', context: { failures, perTable } });
        }

        res.json({
            success: failures.length === 0,
            restored,
            per_table: perTable,
            failures,
            integrity,
            message: failures.length
                ? `已還原 ${restored} 筆，但有 ${failures.length} 張表失敗（詳見 failures）`
                : `已還原 ${restored} 筆（有就更新、沒有就新增；未刪除任何既有資料）`
        });
    } catch (err) {
        await logErrorToDb(req, 'restore_backup_error', err);
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

        await logAudit(operator.username, 'CREATE_USER', data[0].id, {
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

        await logAudit(operator.username, 'DELETE_USER', targetUser.id, {
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

        await logAudit(operator.username, 'UPDATE_USER', target.id, {
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
// 營運儀表板 API（v3.0.0，管理員以上）
// ==========================================
// 設計取捨：
//   - 只回「聚合後的數字」：沒有任何帳號、email 或單筆報名內容（一般使用者一律 403）。
//   - 每個區塊各自 try／catch：某張表還沒建（例如 migration 還沒跑）只標記 unavailable，
//     不讓一個區塊壞掉就整個儀表板 500。
//   - 結果快取 60 秒（?fresh=1 可強制重算）：管理員在畫面上按來按去不必每次全表掃描。
//   - timings 是量出來的秒數，直接回給前端顯示（不是宣稱的效能）。
const OPS_STATS_TTL_MS = 60 * 1000;
const OPS_STATS_TREND_DAYS = 14;
const OPS_STATS_MAX_TREND_DAYS = 30;
let opsStatsCache = { at: 0, days: 0, payload: null };

// v3.0.0 隨 migration 建立的索引（PostgREST 沒有查詢 pg_indexes 的介面，
// 所以這裡列出「已隨 migration 宣告」的清單，畫面上據實標示來源）。
const OPS_INDEXES = [
    { table: 'registrations', name: 'registrations_competition_active_idx', reason: '列表／名單以賽事查報名（只含未刪除）' },
    { table: 'registrations', name: 'registrations_user_idx', reason: '「我的賽事」與單一使用者查詢' },
    { table: 'registrations', name: 'registrations_status_idx', reason: '依狀態統計與篩選（含候補）' },
    { table: 'competitions', name: 'competitions_created_idx', reason: '賽事列表與趨勢統計的時間排序' },
    { table: 'error_logs', name: 'error_logs_created_idx', reason: '錯誤趨勢與巡檢時間窗' },
    { table: 'audit_logs', name: 'audit_logs_action_target_idx', reason: '依動作與對象查稽核（匯出與追蹤）' },
    { table: 'push_log', name: 'push_log_created_idx', reason: '推播紀錄的時間排序' }
];

/* ============================================================
 * v3.1.0：成績與結果（P1-3）—— 補上賽後那一段
 * ------------------------------------------------------------
 * 流程：管理員在「🏆 成績登錄」把名次／成績填好（可以一鍵依成績自動排名）
 *      → 儲存（草稿，前台看不到）→ 公布（可同時推播通知參賽者）→ 前台看得到。
 * 規則（名次怎麼算、什麼狀態不能排名、公布前的檢查）全部在 public/js/results.js，
 * 前端、後端與測試共用同一份，不會出現「畫面上是第 2 名、API 說是第 3 名」。
 * ============================================================ */

const RESULTS_HINT =
    '成績功能需要資料表，請先在 Supabase SQL Editor 執行 migrations/2026-09-27-v3.1.0-results.sql';

/* 成績列 ＋ 顯示用欄位（名次標籤、獎牌、狀態中文）都由共用模組算 */
function decorateResult(row) {
    const status = CMResults.normalizeStatus(row.status);
    const rank = Number.isFinite(Number(row.rank)) && Number(row.rank) > 0 ? Number(row.rank) : null;
    const base = Object.assign({}, row, {
        status,
        rank,
        score_text: CMResults.normalizeScoreText(row.score_text)
    });
    return Object.assign(base, {
        status_label: CMResults.statusLabel(status),
        rank_label: CMResults.formatRank(rank),
        medal: CMResults.medalFor(rank),
        score_display: CMResults.displayScoreOrStatus(base),
        line: CMResults.resultLine(base)
    });
}

/* 一場賽事的全部成績（排序用共用模組，與前端一致） */
async function loadResultRows(competitionId) {
    const { data, error } = await supabase
        .from('competition_results')
        .select('*')
        .eq('competition_id', competitionId);
    if (error) throw error;
    return CMResults.sortResults(data || []).map(decorateResult);
}

/* 這場賽事「已核准」的報名：成績只能登錄給這些人（避免登錄到未核准或別場的報名） */
async function loadApprovedRegistrations(competitionId) {
    const { data, error } = await supabase
        .from('registrations')
        .select('id,user_id,username,team_name,status,is_deleted')
        .eq('competition_id', competitionId)
        .eq('is_deleted', false);
    if (error) throw error;
    return (data || [])
        .filter((r) => CMCompetitionState.normalizeRegStatus(r.status) === 'confirmed')
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((r) => ({
            id: r.id,
            user_id: r.user_id,
            username: r.username,
            display_name: r.team_name || r.username
        }));
}

/* migration 探測：公布欄位＋成績表都要在。負結果只快取 60 秒，
   migration 跑完一分鐘內自動恢復（不必重啟、也不必重新部署）。 */
const resultSchemaReady = createSchemaProbe(async () => {
    const [fields, table] = await Promise.all([
        columnExists('competitions', 'result_published_at'),
        tableExists('competition_results')
    ]);
    return fields && table;
});

/* 公開的成績查詢：未公布時只有管理員看得到草稿（其他人拿到「還沒公布」而不是空白） */
app.get('/api/competitions/:id/results', optionalAuth, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const isAdmin = !!(req.user && ADMIN_ROLES.has(req.user.role));
        const published = !!comp.result_published_at;
        const payload = {
            competition: { id: comp.id, name: comp.name, date: comp.date, category: comp.category },
            published,
            published_at: comp.result_published_at || null,
            published_by: comp.result_published_by || null,
            summary: comp.result_summary || null,
            results: [],
            stats: null
        };

        if (!published && !isAdmin) {
            payload.message = '成績尚未公布';
            return res.json(payload);
        }

        const rows = await loadResultRows(comp.id);
        payload.results = rows;
        payload.stats = CMResults.summarize(rows);
        payload.draft = !published;

        if (isAdmin) {
            const approved = await loadApprovedRegistrations(comp.id);
            payload.checklist = CMResults.publishChecklist(approved, rows);
            payload.approved_count = approved.length;
        }

        res.json(payload);
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'competition_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 成績登錄用的完整表單（管理員以上）：參賽名單＋已登錄成績＋統計＋公布前檢查 */
app.get('/api/competitions/:id/result-sheet', requireAdmin, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const approved = await loadApprovedRegistrations(comp.id);
        const rows = await loadResultRows(comp.id);
        const byReg = {};
        rows.forEach((r) => { byReg[String(r.registration_id)] = r; });

        // 名單為主體：每個人都有一列（已登錄的填好值），不會因為漏登錄就看不到人
        const entries = approved.map((reg) => {
            const existing = byReg[String(reg.id)];
            return {
                registration_id: reg.id,
                user_id: reg.user_id,
                username: reg.username,
                display_name: reg.display_name,
                status: existing ? existing.status : 'finished',
                score_text: existing ? existing.score_text : null,
                rank: existing ? existing.rank : null,
                note: existing ? existing.note : null,
                result_id: existing ? existing.id : null,
                existing: !!existing
            };
        });

        // 有成績但報名已不在名單裡（例如後來被取消錄取）：單獨列出來，不要默默消失
        const orphan = rows
            .filter((r) => !approved.some((reg) => String(reg.id) === String(r.registration_id)))
            .map((r) => ({
                registration_id: r.registration_id,
                display_name: r.display_name || r.username || '（已移除的報名）',
                rank: r.rank,
                score_text: r.score_text,
                status: r.status,
                result_id: r.id,
                line: r.line
            }));

        res.json({
            competition: { id: comp.id, name: comp.name, date: comp.date, category: comp.category },
            published: !!comp.result_published_at,
            published_at: comp.result_published_at || null,
            published_by: comp.result_published_by || null,
            summary: comp.result_summary || null,
            approved_count: approved.length,
            entries,
            orphan,
            stats: CMResults.summarize(rows),
            checklist: CMResults.publishChecklist(approved, rows),
            max_score_length: CMResults.SCORE_MAX,
            max_note_length: CMResults.NOTE_MAX,
            max_summary_length: CMResults.SUMMARY_MAX
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'result_sheet_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 儲存成績（管理員以上）：整批驗證通過才寫，避免「寫了一半」的成績表 */
app.put('/api/competitions/:id/results', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const incoming = Array.isArray(body.results) ? body.results : null;

    if (!incoming) return res.status(400).json({ error: '要送出的成績要放在 results 陣列裡' });
    if (incoming.length > 500) return res.status(400).json({ error: '一次最多儲存 500 筆成績' });

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const approved = await loadApprovedRegistrations(comp.id);
        const allowed = new Set(approved.map((r) => String(r.id)));

        const errors = [];
        const values = [];
        incoming.forEach((raw, i) => {
            const parsed = CMResults.normalizeResultInput(raw);
            if (parsed.error) { errors.push(`第 ${i + 1} 列：${parsed.error}`); return; }
            if (!allowed.has(String(parsed.value.registration_id))) {
                errors.push(`第 ${i + 1} 列：這筆報名不在本賽事的已核准名單中`);
                return;
            }
            const reg = approved.find((r) => String(r.id) === String(parsed.value.registration_id));
            values.push(Object.assign({}, parsed.value, {
                user_id: parsed.value.user_id || reg.user_id,
                username: parsed.value.username || reg.username,
                display_name: parsed.value.display_name || reg.display_name
            }));
        });

        // 同一個報名送兩次＝使用者填錯，直接說清楚而不是後者覆蓋前者
        const seen = new Set();
        const dup = [];
        values.forEach((v) => {
            const key = String(v.registration_id);
            if (seen.has(key)) dup.push(key);
            seen.add(key);
        });
        if (dup.length) errors.push(`同一筆報名重複送出（報名編號 ${dup.join('、')}）`);

        if (errors.length) {
            return res.status(400).json({ error: errors.join('；'), errors });
        }

        // 一鍵自動排名：規則是共用的，後端算完才寫入（不是存回去讓前端自己算）
        const ranked = body.auto_rank ? CMResults.autoRank(values, { order: body.order === 'desc' ? 'desc' : 'asc' }) : values;

        const now = new Date().toISOString();
        const records = ranked.map((v) => ({
            competition_id: comp.id,
            registration_id: v.registration_id,
            user_id: v.user_id || null,
            username: v.username || null,
            display_name: v.display_name || null,
            status: v.status,
            score_text: v.score_text,
            rank: v.rank,
            note: v.note,
            recorded_by: req.user.username,
            updated_at: now
        }));

        // 明確要求刪除的成績（送 remove_ids；沒送就一筆都不刪）
        const removeIds = (Array.isArray(body.remove_ids) ? body.remove_ids : [])
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v > 0);
        let removed = 0;
        if (removeIds.length) {
            const { error: delErr } = await supabase
                .from('competition_results')
                .delete()
                .eq('competition_id', comp.id)
                .in('id', removeIds);
            if (delErr) throw delErr;
            removed = removeIds.length;
        }

        if (records.length) {
            const { error: upErr } = await supabase
                .from('competition_results')
                .upsert(records, { onConflict: 'competition_id,registration_id' });
            if (upErr) throw upErr;
        }

        await logAudit(req.user.username, 'SAVE_RESULTS', comp.id,
            `登錄成績: ${comp.name}（儲存 ${records.length} 筆${body.auto_rank ? '，自動排名' : ''}${removed ? `，刪除 ${removed} 筆` : ''}）`,
            req.userAgent);

        const rows = await loadResultRows(comp.id);
        const checklist = CMResults.publishChecklist(approved, rows);
        res.json({
            message: removed && !records.length ? '已刪除指定的成績' : `已儲存 ${records.length} 筆成績`,
            saved: records.length,
            removed,
            auto_ranked: !!body.auto_rank,
            stats: CMResults.summarize(rows),
            checklist,
            results: rows
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'save_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 公布成績（管理員以上）：公布是對外動作，要明確帶 confirm 才做 */
app.post('/api/competitions/:id/results/publish', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
        return res.status(400).json({ error: '公布成績會讓所有訪客看到，請帶 confirm: true 再送一次' });
    }

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const rows = await loadResultRows(comp.id);
        if (!rows.length) {
            return res.status(400).json({ error: '這場賽事還沒有任何成績，請先登錄再公布' });
        }

        const summary = CMResults.normalizeSummary(body.summary) || comp.result_summary || null;
        const patch = {
            result_published_at: new Date().toISOString(),
            result_published_by: req.user.username,
            result_summary: summary
        };
        const { error } = await supabase.from('competitions').update(patch).eq('id', comp.id);
        if (error) throw error;

        const stats = CMResults.summarize(rows);
        const podium = stats.podium.map((p) => `${p.medal}${p.name}`).join('、');

        // 名次提示：沒名次的人不算錯誤，但要在稽核裡看得出來有幾位
        await logAudit(req.user.username, 'PUBLISH_RESULTS', comp.id,
            `公布成績: ${comp.name}（${rows.length} 筆，前三名 ${podium || '從缺'}）`,
            req.userAgent);

        // 通知參賽者（站台層事件開關 push_event_result 關掉就不送）
        let push = { sent: 0, failed: 0, total: 0, skipped: null, notified_users: 0 };
        if (body.notify === true) {
            const targets = rows.filter((r) => r.user_id);
            const targetIds = [];
            const errors = [];
            for (const row of targets) {
                const payload = {
                    kind: 'result',
                    title: `成績已公布：${comp.name}`,
                    body: `${comp.name} 的成績已公布${row.rank ? `：你獲得第 ${row.rank} 名` : ''}`,
                    url: '/?view=myregs',
                    tag: `cm-result-${comp.id}`
                };
                const result = await notifyUser(row.user_id, payload, { kind: 'result' });
                push.total += result.total || 0;
                push.sent += result.sent || 0;
                push.failed += result.failed || 0;
                if (result.skipped) push.skipped = result.skipped;
                // 紀錄的是「這次推播的對象」＝嘗試送達的人（與公告的推播紀錄一致）；
                // 送出成功與否看 sent／failed，不要把失敗的人從對象名單裡抹掉。
                targetIds.push(row.user_id);
                if (result.errors && result.errors.length) errors.push(...result.errors);
            }
            push.notified_users = targetIds.length;
            await logPushEvent(comp.id, 'result_published', push.sent, {
                failed: push.failed,
                errors,
                payload: { title: `成績已公布：${comp.name}`, body: '...', url: '/?view=myregs' },
                target_user_ids: targetIds
            });
        }

        res.json({
            message: `已公布 ${rows.length} 筆成績`,
            published: true,
            published_at: patch.result_published_at,
            published_by: patch.result_published_by,
            summary,
            stats,
            notified: push
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'publish_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 取消公布（管理員以上）：成績回到草稿狀態，前台立刻看不到 */
app.post('/api/competitions/:id/results/unpublish', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
        return res.status(400).json({ error: '取消公布會讓前台看不到成績，請帶 confirm: true 再送一次' });
    }

    try {
        if (!(await resultSchemaReady())) return res.status(503).json({ error: RESULTS_HINT });

        const comp = await fetchCompetition(req.params.id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });
        if (!comp.result_published_at) return res.status(400).json({ error: '這場賽事的成績目前沒有公布' });

        const { error } = await supabase.from('competitions')
            .update({ result_published_at: null, result_published_by: null })
            .eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'UNPUBLISH_RESULTS', comp.id,
            `取消公布成績: ${comp.name}（成績保留為草稿）`, req.userAgent);

        res.json({ message: '已取消公布，成績保留為草稿', published: false });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: RESULTS_HINT });
        await logErrorToDb(req, 'unpublish_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 我的成績（已登入者）：只回「已公布」的，草稿不會不小心被看到 */
app.get('/api/my/results', authenticateToken, async (req, res) => {
    try {
        if (!(await resultSchemaReady())) return res.json([]);

        const { data, error } = await supabase
            .from('competition_results')
            .select('*, competitions(id,name,date,category,result_published_at,is_deleted)')
            .eq('user_id', req.user.sub);
        if (error) throw error;

        const rows = (data || [])
            .filter((r) => r.competitions && !r.competitions.is_deleted && r.competitions.result_published_at)
            .map((r) => {
                const decorated = decorateResult(r);
                decorated.competition_name = r.competitions.name;
                decorated.competition_date = r.competitions.date;
                decorated.competition_category = r.competitions.category;
                decorated.medal = CMResults.medalFor(decorated.rank);
                return decorated;
            });

        res.json(rows);
    } catch (err) {
        if (isMissingTableError(err)) return res.json([]);
        await logErrorToDb(req, 'my_results_error', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const days = CMPaging.clampInt(req.query.days, 7, OPS_STATS_MAX_TREND_DAYS, OPS_STATS_TREND_DAYS);
    const fresh = String(req.query.fresh || '') === '1';
    const now = Date.now();

    if (!fresh && opsStatsCache.payload && opsStatsCache.days === days && (now - opsStatsCache.at) < OPS_STATS_TTL_MS) {
        return res.json(Object.assign({}, opsStatsCache.payload, { cached: true, cache_age_ms: now - opsStatsCache.at }));
    }

    const timings = {};
    const unavailable = [];
    // 小工具：量測每個區塊的耗時，並把失敗原因記下來（不讓單一區塊炸掉整個回應）
    const block = async (name, fn) => {
        const t0 = Date.now();
        try {
            return await fn();
        } catch (err) {
            unavailable.push({ section: name, reason: isMissingTableError(err) ? '資料表尚未建立（migration 未執行）' : (err.message || '查詢失敗') });
            return null;
        } finally {
            timings[name] = Date.now() - t0;
        }
    };

    const hasSeverity = await columnExists('error_logs', 'severity');
    const hasResolved = await columnExists('error_logs', 'resolved');
    const hasLastLogin = await columnExists('admin_users', 'last_login_at');
    const hasPosterThumb = await columnExists('competition_posters', 'thumb_bytes');
    const hasStaff = await tableExists('competition_staff');
    // 選用資料表不存在（migration 還沒跑）時明確列出來，
    // 讓儀表板能說明「哪個區塊沒有、為什麼」，而不是靜靜少一個數字。
    if (!hasStaff) {
        unavailable.push({ section: 'competition_staff', reason: '資料表尚未建立（migration 未執行）' });
    }
    const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ── 賽事 ──
    const comps = await block('competitions', async () => {
        const { data, error } = await supabase.from('competitions')
            .select('*')   // 賽事數量少但要推導狀態，直接取全部欄位（欄位缺失時不會讓整個查詢 400）
            .or('is_deleted.is.null,is_deleted.eq.false');
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 報名（狀態與趨勢）──
    const reviewReady = await registrationReviewSchemaReady();
    const regs = await block('registrations', async () => {
        const { data, error } = await supabase.from('registrations')
            .select(reviewReady ? 'competition_id,user_id,status,created_at' : 'competition_id,user_id,created_at')
            .eq('is_deleted', false);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 使用者（只有角色與時間，不含帳號以外的個資）──
    const users = await block('users', async () => {
        const cols = ['role', 'is_active', 'created_at'];
        if (hasLastLogin) cols.push('last_login_at');
        const { data, error } = await supabase.from('admin_users').select(cols.join(','));
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 錯誤日誌（近 30 天，趨勢與類別）──
    const errorRows = await block('errors', async () => {
        const cols = ['error_type', 'created_at', 'path'];
        if (hasSeverity) cols.push('severity');
        if (hasResolved) cols.push('resolved');
        let q = supabase.from('error_logs').select(cols.join(',')).gt('created_at', since30);
        if (hasResolved) q = q.eq('resolved', false);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(2000);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 推播紀錄 ──
    const pushRows = await block('push', async () => {
        const { data, error } = await supabase.from('push_log')
            .select('sent_count,failed_count,created_at')
            .order('created_at', { ascending: false }).limit(1000);
        if (error) throw error;
        return data || [];
    }) || [];

    // ── 海報與縮圖（縮圖省下多少流量＝最直接的效能數字）──
    const posterCols = hasPosterThumb ? 'bytes,thumb_bytes' : 'bytes';
    const posters = await block('posters', async () => {
        const { data, error } = await supabase.from('competition_posters').select(posterCols);
        if (error) throw error;
        return data || [];
    }) || [];

    const staffCount = hasStaff ? (await block('staff', async () => {
        const { data, error } = await supabase.from('competition_staff').select('id');
        if (error) throw error;
        return data || [];
    })) : null;

    // ── 聚合：賽事 ──
    const regCounts = {};
    const waitlistCounts = {};
    regs.forEach((r) => {
        const key = String(r.competition_id);
        const status = CMCompetitionState.normalizeRegStatus(r.status);
        if (status === 'waitlisted') { waitlistCounts[key] = (waitlistCounts[key] || 0) + 1; return; }
        regCounts[key] = (regCounts[key] || 0) + 1;
    });

    const stateNow = new Date(now);
    const stateCounts = {};
    comps.forEach((c) => {
        const st = competitionState(c, stateNow, {
            registeredCount: regCounts[String(c.id)] || 0,
            waitlistCount: waitlistCounts[String(c.id)] || 0
        });
        stateCounts[st.state] = (stateCounts[st.state] || 0) + 1;
    });

    const categoryTop = CMStats.topN(CMStats.countBy(comps, (c) => c.category || 'other'), 6).map((row) => {
        const def = COMPETITION_CATEGORIES.find((x) => x.id === row.key);
        return { key: row.key, label: (def && (def.label || def.name)) || row.key, count: row.count };
    });

    // ── 聚合：報名 ──
    const regByStatus = CMStats.countBy(regs, (r) => CMCompetitionState.normalizeRegStatus(r.status));
    const regTrend = CMStats.trendByDay(regs, { days, now: stateNow });

    // ── 聚合：使用者 ──
    const activeUsers = users.filter((u) => u.is_active !== false);
    const activeLast30 = hasLastLogin
        ? activeUsers.filter((u) => u.last_login_at && new Date(u.last_login_at).getTime() >= now - 30 * 24 * 60 * 60 * 1000).length
        : null;

    // ── 聚合：錯誤 ──
    const errorTrend = CMStats.trendByDay(errorRows, { days, now: stateNow });
    const errorBySeverity = CMStats.countBy(errorRows, (r) => (hasSeverity ? (r.severity || 'error') : 'error'));
    const errorTopTypes = CMStats.topN(CMStats.countBy(errorRows, (r) => r.error_type || 'unknown'), 5);

    // ── 聚合：推播 ──
    const sent = CMStats.sum(pushRows, (r) => r.sent_count);
    const failed = CMStats.sum(pushRows, (r) => r.failed_count);
    const pushTotal = sent + failed;

    // ── 聚合：海報縮圖省下的量 ──
    const posterBytes = CMStats.sum(posters, (r) => r.bytes);
    const thumbBytes = CMStats.sum(posters, (r) => (hasPosterThumb ? r.thumb_bytes : 0));
    const thumbCount = posters.filter((r) => hasPosterThumb && CMStats.sum([r], (x) => x.thumb_bytes) > 0).length;

    const payload = {
        success: true,
        generated_at: new Date(now).toISOString(),
        cached: false,
        trend_days: days,
        unavailable_sections: unavailable,
        competitions: {
            total: comps.length,
            by_state: stateCounts,
            by_category: categoryTop,
            by_category_other: Math.max(0, comps.length - CMStats.sum(categoryTop, (c) => c.count)),
            created_trend: CMStats.trendByDay(comps, { days, now: stateNow })
        },
        registrations: {
            total: regs.length,
            by_status: regByStatus,
            confirmed: regByStatus.confirmed || 0,
            pending: regByStatus.pending || 0,
            waitlisted: regByStatus.waitlisted || 0,
            trend: regTrend,
            last7d: regTrend.slice(-7).reduce((a, d) => a + d.count, 0)
        },
        users: {
            total: users.length,
            active: activeUsers.length,
            inactive: users.length - activeUsers.length,
            by_role: CMStats.countBy(users, (u) => u.role || 'user'),
            active_last_30d: activeLast30,
            last_login_available: hasLastLogin
        },
        errors: {
            open_recent_30d: errorRows.length,
            by_severity: errorBySeverity,
            top_types: errorTopTypes,
            trend: errorTrend,
            severity_available: hasSeverity
        },
        push: {
            notifications: pushRows.length,
            sent,
            failed,
            success_rate: CMStats.percent(sent, pushTotal),
            success_tone: CMStats.rateTone(CMStats.percent(sent, pushTotal))
        },
        perf: {
            posters: {
                count: posters.length,
                total_bytes: posterBytes,
                total_label: CMStats.formatBytes(posterBytes),
                thumb_count: thumbCount,
                thumb_bytes: thumbBytes,
                thumb_label: CMStats.formatBytes(thumbBytes),
                thumb_saved: Math.max(0, posterBytes - thumbBytes),
                thumb_saved_label: CMStats.formatBytes(Math.max(0, posterBytes - thumbBytes)),
                thumb_available: hasPosterThumb
            },
            staff_count: staffCount === null ? null : staffCount.length,
            paging: {
                competitions_max: COMPETITIONS_PAGE_MAX,
                registrations_max: REGISTRATIONS_PAGE_MAX,
                default_max: CMPaging.DEFAULT_MAX
            },
            indexes: OPS_INDEXES,
            timings,
            total_ms: Date.now() - now
        }
    };

    opsStatsCache = { at: now, days, payload };
    res.json(payload);
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
        // v3.0.0：分頁是 opt-in（沒帶 limit 就維持原本「一次回全部」）。
        // ?state= 是「即時推導」的狀態，資料庫無法過濾 → 有 state 篩選時只能在記憶體切片，
        // 回應會用 paged_by 標示是 db 還是 memory，讓呼叫端知道這個差別。
        const paging = CMPaging.parsePaging(req.query, { max: COMPETITIONS_PAGE_MAX });
        const wanted = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
        const pageInDb = paging.paged && wanted.length === 0;

        let compQuery = supabase
            .from('competitions')
            .select('*', pageInDb ? { count: 'exact' } : {})
            .or('is_deleted.is.null,is_deleted.eq.false')
            .order('id', { ascending: false });
        if (pageInDb) compQuery = compQuery.range(paging.offset, paging.offset + paging.limit - 1);

        const { data: competitions, error: compErr, count: compTotal } = await compQuery;

        if (compErr) throw compErr;
        if (!competitions || competitions.length === 0) {
            if (!paging.paged) return res.json([]);
            return res.json(CMPaging.pagedResponse([], {
                limit: paging.limit, offset: paging.offset,
                total: (typeof compTotal === 'number' ? compTotal : 0),
                pagedBy: pageInDb ? 'db' : 'memory'
            }));
        }

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

        // v2.19.0：賽事狀態由後端即時推導（報名中／尚未開始／報名已截止／進行中／已結束），前端只負責顯示。
        // 人數上限需要實際報名數 → 一次查回來自己累加（與 /api/registration-counts 同一套規則）。
        // v2.20.0：「佔名額」＝已核准＋待審核（候補不算），所以這裡要一起讀 status
        const reviewReady = await registrationReviewSchemaReady();
        // v3.0.0：分頁時只撈「這一頁賽事」的報名（原本會把整張 registrations 掃回來），
        // 這是列表端點最貴的一步，成本因此從 O(全部報名) 變成 O(本頁賽事)。
        let regQuery = supabase
            .from('registrations')
            .select(reviewReady ? 'competition_id,status' : 'competition_id')
            .eq('is_deleted', false);
        if (pageInDb) regQuery = regQuery.in('competition_id', compIds);
        const { data: activeRegs } = await regQuery;

        const regCounts = {};
        const waitlistCounts = {};
        (activeRegs || []).forEach((r) => {
            const key = String(r.competition_id);
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            if (status === 'waitlisted') {
                waitlistCounts[key] = (waitlistCounts[key] || 0) + 1;
                return;   // 候補不佔名額
            }
            regCounts[key] = (regCounts[key] || 0) + 1;
        });

        const now = new Date();
        const withState = competitions.map(c => {
            const pubName = publisherMap[String(c.id)] || null;
            const st = competitionState(c, now, {
                registeredCount: regCounts[String(c.id)] || 0,
                waitlistCount: waitlistCounts[String(c.id)] || 0
            });
            return {
                ...c,
                // v2.27.0：地圖連結（自訂優先；沒填就用地址自動產生，所以舊賽事也馬上有地圖可按）
                map_url: CMVenue.mapUrlFor(c),
                map_url_custom: CMVenue.normalizeMapUrl(c.map_url) || '',
                // v3.0.0：列表用縮圖（沒有縮圖時前端會自動退回原圖，舊海報不用回填）
                poster_thumb_url: c.poster_updated_at
                    ? `/api/competitions/${c.id}/poster?variant=thumb&v=${Date.parse(c.poster_updated_at) || 0}`
                    : null,
                map_url_auto: CMVenue.isAutoMapUrl(c),
                publisher_name: pubName,
                publisher_role: pubName ? (userRoleMap[pubName] || 'admin') : null,
                state: st.state,
                state_label: st.label,
                state_tone: st.tone,
                can_register: st.can_register,
                registration_reason: st.reason,
                state_detail: st.detail,
                is_full: st.full,
                registered_count: st.registered_count,
                waitlist_count: waitlistCounts[String(c.id)] || 0,
                is_waitlist: !!st.waitlist,
                needs_approval: !!st.needs_approval
            };
        });

        // ?state=registration_open,ongoing 只回這些狀態（前端分頁籤與外部整合都用這個）
        const filtered = wanted.length ? withState.filter(c => wanted.includes(c.state)) : withState;

        if (!paging.paged) return res.json(filtered);

        // pageInDb 時資料庫已經切好這一頁（filtered 就是本頁），不能再切一次
        const sliced = pageInDb ? filtered : CMPaging.pageSlice(filtered, paging);
        const total = pageInDb ? (typeof compTotal === 'number' ? compTotal : filtered.length) : filtered.length;
        res.json(CMPaging.pagedResponse(sliced, {
            limit: paging.limit, offset: paging.offset, total,
            pagedBy: pageInDb ? 'db' : 'memory'
        }));
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

    // v2.19.0：報名開始／截止時間（時間到會自動切換狀態）
    const windowFields = normalizeRegistrationWindow(req.body);
    const includeWindow = shouldIncludeRegistrationWindow(windowFields, schemaHasRegistrationWindow);
    const schemaWindowReady = await registrationWindowSchemaReady();

    // v2.20.0：報名需審核／額滿可候補（尚未 migration 時不帶，功能自動停用）
    const reviewFields = normalizeReviewFlags(req.body);
    const schemaReviewReady = await registrationReviewSchemaReady();
    const includeReviewFields = schemaReviewReady && hasReviewFlagsContent(req.body);

    // v2.27.0：場地地圖連結。沒填＝用地址自動產生（前端 CMVenue 負責），所以舊資料不用補；
    // 填了但格式不對要明確回報，不要靜默丟掉——使用者會以為存進去了。
    const mapProvided = !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'map_url'));
    const mapRaw = (mapProvided && req.body.map_url !== undefined && req.body.map_url !== null)
        ? String(req.body.map_url).trim() : '';
    const mapUrl = CMVenue.normalizeMapUrl(mapRaw);
    if (mapRaw && !mapUrl) {
        return res.status(400).json({ error: '地圖連結格式不對：要 http／https 開頭的網址（想讓地圖指向某個地址，填在「地點」欄位就會自動產生連結）' });
    }
    const includeMap = await mapUrlSchemaReady();

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
            // 欄位不存在時不帶（回傳 window_saved:false 讓前端誠實告知），時間欄位不該拖垮整筆儲存
            ...(includeWindow && schemaWindowReady ? windowFields : {}),
            ...(includeReviewFields ? reviewFields : {}),
            // 有帶欄位就照帶的值存（空＝沒有自訂連結，前端改用地址自動產生）；沒帶＝不碰
            ...(includeMap && mapProvided ? { map_url: mapUrl || null } : {}),
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

        // 有填報名時間或地圖連結、但資料庫沒有欄位時要誠實告知（不要讓使用者以為存進去了）
        const saveWarnings = [];
        const windowLost = hasRegistrationWindowContent(windowFields) && !schemaWindowReady;
        const mapLost = !!mapRaw && !includeMap;
        if (windowLost) saveWarnings.push('資料庫缺少報名開始／截止欄位，時間未儲存（請執行 migrations/ 內的 SQL）');
        if (mapLost) saveWarnings.push('資料庫缺少地圖連結欄位，地圖連結未儲存（請執行 migrations/2026-09-26-v2.27.0-venue-staff.sql）');
        res.json(saveWarnings.length
            ? Object.assign({}, newComp, {
                ...(windowLost ? { registration_window_saved: false } : {}),
                ...(mapLost ? { map_url_saved: false } : {}),
                warning: saveWarnings.join('；')
            })
            : newComp);
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

// v2.24.0：複製賽事（設定照抄；報名、隊伍、海報都不搬）
app.post('/api/competitions/:id/duplicate', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const src = rows && rows[0];
        if (!src) return res.status(404).json({ error: '找不到這筆賽事' });

        const schema = await copySchemaReady();
        const baseName = String(src.name || '').trim() || '未命名賽事';
        // 名稱一律加「（複製）」；原本就已經是複製品的話不會變成「（複製）（複製）」
        const copyName = (baseName.replace(/（複製）$/, '') + '（複製）').slice(0, 190);
        const payload = buildDuplicatePayload(src, copyName, schema, { series: false });

        const { data: created, error: insErr } = await supabase.from('competitions').insert([payload]).select();
        if (insErr) throw insErr;
        const row = created[0];
        await logAudit(
            operator.username,
            'DUPLICATE_COMPETITION',
            row.id,
            `複製賽事：${baseName} → ${copyName}（日期 ${row.date || '未填'}；報名與隊伍不搬）`,
            req.userAgent
        );
        res.status(201).json(Object.assign({}, row, {
            copied_from: src.id,
            copied_from_name: baseName,
            copied_fields: Object.keys(schema).filter((k) => schema[k])
        }));
    } catch (err) {
        if (isMissingColumnError(err, ['category', 'tags', 'is_team_event', 'team_size', 'max_registrations', 'registration_deadline'])) {
            return res.status(503).json({ error: '資料庫欄位不足，請先執行 migrations/ 內的 SQL' });
        }
        await logErrorToDb(req, 'duplicate_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

// v2.24.0：設定／取消賽事週期（自動建立下一場的開關）
app.post('/api/competitions/:id/recurrence', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    if (!(await recurrenceSchemaReady())) return res.status(503).json({ error: RECURRENCE_HINT });

    const body = req.body || {};
    const rule = body.recurrence ? normalizeRecurrenceRule(body.recurrence) : null;
    if (body.recurrence && !rule) {
        return res.status(400).json({ error: '週期只能是每週（weekly）、每兩週（biweekly）或每月（monthly）' });
    }
    const untilRaw = body.recurrence_until ? String(body.recurrence_until).trim().slice(0, 10) : null;
    if (untilRaw && !/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) {
        return res.status(400).json({ error: '週期結束日格式要像 2026-12-31' });
    }

    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const comp = rows && rows[0];
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const compDate = String(comp.date || '').slice(0, 10);
        if (rule && untilRaw && /^\d{4}-\d{2}-\d{2}$/.test(compDate) && untilRaw < compDate) {
            return res.status(400).json({ error: '週期結束日不能早於賽事日期' });
        }

        const { data: updated, error: upErr } = await supabase
            .from('competitions')
            .update({ recurrence: rule, recurrence_until: rule ? untilRaw : null })
            .eq('id', id)
            .select();
        if (upErr) throw upErr;
        const row = (updated && updated[0]) || comp;

        // 週期是「整個系列」的設定：同一系列的其他場次一起同步，
        // 否則每一場各記一份週期，之後改其中一場會出現兩種說法。
        const rootId = String(comp.recurrence_parent_id || comp.id);
        let synced = 0;
        const { data: allRows } = await supabase.from('competitions').select('*');
        const members = (allRows || []).filter((c) => !c.is_deleted && (
            String(c.id) === rootId || String(c.recurrence_parent_id || '') === rootId
        ));
        for (const member of members) {
            if (String(member.id) === String(id)) continue;
            const { error: memberErr } = await supabase
                .from('competitions')
                .update({ recurrence: rule, recurrence_until: rule ? untilRaw : null })
                .eq('id', member.id);
            if (!memberErr) synced++;
        }

        await logAudit(
            operator.username,
            'SET_RECURRENCE',
            id,
            (rule
                ? `設定週期：${RECURRENCE_RULE_LABELS[rule]}${untilRaw ? `（到 ${untilRaw} 為止）` : '（一直重複）'}`
                : '取消週期設定') + (members.length > 1 ? `（系列共 ${members.length} 場同步）` : ''),
            req.userAgent
        );
        res.json(Object.assign({}, row, {
            recurrence_label: rule ? RECURRENCE_RULE_LABELS[rule] : null,
            series_synced: synced
        }));
    } catch (err) {
        if (isMissingColumnError(err, ['recurrence', 'recurrence_until'])) {
            recurrenceSchemaCache = false;
            return res.status(503).json({ error: RECURRENCE_HINT });
        }
        await logErrorToDb(req, 'set_recurrence_error', err);
        res.status(500).json({ error: err.message });
    }
});

// v2.24.0：立刻建立下一場（與每日 cron 共用同一份判斷；不需要等排程）
app.post('/api/competitions/:id/recurrence/next', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (!(await recurrenceSchemaReady())) return res.status(503).json({ error: RECURRENCE_HINT });
    try {
        const { data: rows, error } = await supabase.from('competitions').select('*').eq('id', id);
        if (error) throw error;
        const comp = rows && rows[0];
        if (!comp) return res.status(404).json({ error: '找不到這筆賽事' });

        const result = await createNextOccurrence(comp, req.currentUser, req.userAgent);
        if (!result.created) {
            // 409：不是錯誤，是「現在還不需要建立」——把原因照實回給介面顯示
            return res.status(409).json({ error: result.reason || '現在還不需要建立下一場', date: result.date, overdue: !!result.overdue });
        }
        res.status(201).json(Object.assign({}, result.competition, { created_from: id, next_date: result.date }));
    } catch (err) {
        if (isMissingColumnError(err, ['recurrence', 'recurrence_until', 'recurrence_parent_id'])) {
            recurrenceSchemaCache = false;
            return res.status(503).json({ error: RECURRENCE_HINT });
        }
        await logErrorToDb(req, 'create_recurring_competition_error', err);
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

    // v2.19.0：報名開始／截止時間（時間到會自動切換狀態）
    const windowFields = normalizeRegistrationWindow(req.body);
    const includeWindow = shouldIncludeRegistrationWindow(windowFields, schemaHasRegistrationWindow);
    const schemaWindowReady = await registrationWindowSchemaReady();

    // v2.20.0：報名需審核／額滿可候補（尚未 migration 時不帶，功能自動停用）
    const reviewFields = normalizeReviewFlags(req.body);
    const schemaReviewReady = await registrationReviewSchemaReady();
    const includeReviewFields = schemaReviewReady && hasReviewFlagsContent(req.body);

    // v2.27.0：場地地圖連結。沒填＝用地址自動產生（前端 CMVenue 負責），所以舊資料不用補；
    // 填了但格式不對要明確回報，不要靜默丟掉——使用者會以為存進去了。
    const mapProvided = !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'map_url'));
    const mapRaw = (mapProvided && req.body.map_url !== undefined && req.body.map_url !== null)
        ? String(req.body.map_url).trim() : '';
    const mapUrl = CMVenue.normalizeMapUrl(mapRaw);
    if (mapRaw && !mapUrl) {
        return res.status(400).json({ error: '地圖連結格式不對：要 http／https 開頭的網址（想讓地圖指向某個地址，填在「地點」欄位就會自動產生連結）' });
    }
    const includeMap = await mapUrlSchemaReady();

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
            ...(includeWindow && schemaWindowReady ? windowFields : {}),
            ...(includeReviewFields ? reviewFields : {}),
            ...(includeMap && mapProvided ? { map_url: mapUrl || null } : {})
        };

        const { data, error } = await supabase
            .from('competitions')
            .update(payload)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: '找不到該賽事' });

        await logAudit(operator.username, 'UPDATE_COMPETITION', id,
            `更新賽事內容: ${name}${mapRaw ? `（地圖連結：${mapUrl}）` : ''}`, req.userAgent);

        const updateWarnings = [];
        const windowLost = hasRegistrationWindowContent(windowFields) && !schemaWindowReady;
        const mapLost = !!mapRaw && !includeMap;
        if (windowLost) updateWarnings.push('資料庫缺少報名開始／截止欄位，時間未儲存（請執行 migrations/ 內的 SQL）');
        if (mapLost) updateWarnings.push('資料庫缺少地圖連結欄位，地圖連結未儲存（請執行 migrations/2026-09-26-v2.27.0-venue-staff.sql）');
        res.json(updateWarnings.length
            ? Object.assign({}, data[0], {
                ...(windowLost ? { registration_window_saved: false } : {}),
                ...(mapLost ? { map_url_saved: false } : {}),
                warning: updateWarnings.join('；')
            })
            : data[0]);
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

/* ---------- v2.20.0：報名審核與候補 ----------
   規則本身在 public/js/competition-state.js（前後端共用），這裡只負責資料庫讀寫。
   名額定義：佔名額 = 已核准（confirmed）＋ 待審核（pending）；候補（waitlisted）不佔名額。
   -------------------------------------------------- */
const REGISTRATION_REVIEW_HINT =
    '資料庫尚未執行 v2.20.0 migration（migrations/2026-09-26-v2.20.0-registration-review.sql）：' +
    '報名審核與候補需要 competitions.requires_approval／waitlist_enabled 與 registrations 的審核欄位。';

/* v2.22.0：遞補通知開關也只多一個欄位（competitions.waitlist_notify）。 */
/* 候補異動紀錄一次最多往回抓幾筆（避免有人用 offset 無限翻） */
const WAITLIST_HISTORY_MAX_WINDOW = 500;

const WAITLIST_NOTIFY_HINT =
    '資料庫尚未執行 v2.22.0 migration（migrations/2026-09-26-v2.22.0-waitlist-notify.sql）：' +
    '遞補通知開關需要 competitions.waitlist_notify 欄位（未執行時一律視為「通知＝開啟」）。';

let waitlistNotifySchemaCache = null;

async function waitlistNotifySchemaReady() {
    if (waitlistNotifySchemaCache !== null) return waitlistNotifySchemaCache;
    waitlistNotifySchemaCache = await columnExists('competitions', 'waitlist_notify');
    if (!waitlistNotifySchemaCache) {
        console.warn('⚠️ 尚未執行 v2.22.0 migration：遞補通知開關停用（一律通知）');
    }
    return waitlistNotifySchemaCache;
}

/* ── v2.24.0：複製賽事與週期性賽事 ──────────────────────────────
   規則本身在 public/js/competition-state.js（前後端共用同一份），
   這裡只負責：探測欄位、組出複製用的 payload、把「下一場」寫進資料庫。 */

const RECURRENCE_HINT =
    '資料庫尚未執行 v2.24.0 migration（migrations/2026-09-26-v2.24.0-recurrence.sql）：' +
    '週期性賽事需要 competitions.recurrence／recurrence_until／recurrence_parent_id 欄位（未執行時仍可手動複製賽事）。';

const RECURRENCE_RULE_LABELS = { weekly: '每週', biweekly: '每兩週', monthly: '每月' };

let recurrenceSchemaCache = null;

async function recurrenceSchemaReady() {
    if (recurrenceSchemaCache !== null) return recurrenceSchemaCache;
    recurrenceSchemaCache = await columnExists('competitions', 'recurrence');
    if (!recurrenceSchemaCache) {
        console.warn('⚠️ 尚未執行 v2.24.0 migration：週期性賽事自動建立停用（手動複製不受影響）');
    }
    return recurrenceSchemaCache;
}

function normalizeRecurrenceRule(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    return RECURRENCE_RULE_LABELS[v] ? v : null;
}

/* 各欄位是否存在（複製時「不存在就不要帶」，免得整筆新增失敗） */
async function copySchemaReady() {
    const [taxonomy, teamFields, window, review, notify, recurrence, map] = await Promise.all([
        taxonomySchemaReady(),
        teamSchemaReady(),
        registrationWindowSchemaReady(),
        registrationReviewSchemaReady(),
        waitlistNotifySchemaReady(),
        recurrenceSchemaReady(),
        mapUrlSchemaReady()
    ]);
    return { taxonomy, teamFields, window, review, notify, recurrence, map };
}

/* 複製賽事要搬哪些欄位？
   設定照搬（地點／時間／分類／隊伍設定／報名窗／審核與候補／通知開關），
   進度不搬（報名、隊伍、海報檔都不帶）。
   options.series = true 時連週期設定一起帶（自動建立下一場用）；
   手動複製則不帶（複製品視為獨立的一場，不會被 cron 當成系列的一員）。 */
function buildDuplicatePayload(source, name, schema, options) {
    const s = schema || {};
    const opts = options || {};
    const payload = {
        name,
        location: source.location || '',
        date: source.date || '',
        time: source.time || '',
        end_date: source.end_date || null,
        end_time: source.end_time || null,
        description: source.description || '',
        is_registration_open: !!source.is_registration_open,
        is_deleted: false,
        created_at: new Date().toISOString()
    };
    if (s.taxonomy) {
        payload.category = source.category == null ? null : source.category;
        payload.tags = source.tags == null ? null : source.tags;
    }
    if (s.teamFields) {
        payload.is_team_event = !!source.is_team_event;
        payload.team_size = source.team_size == null ? null : source.team_size;
        payload.registration_deadline = source.registration_deadline == null ? null : source.registration_deadline;
        payload.max_registrations = source.max_registrations == null ? null : source.max_registrations;
    }
    if (s.window) {
        payload.registration_start_at = source.registration_start_at == null ? null : source.registration_start_at;
        payload.registration_end_at = source.registration_end_at == null ? null : source.registration_end_at;
    }
    if (s.review) {
        payload.requires_approval = !!source.requires_approval;
        payload.waitlist_enabled = !!source.waitlist_enabled;
    }
    if (s.notify) {
        payload.waitlist_notify = source.waitlist_notify !== false;
    }
    if (s.map) {
        // v2.27.0：複製品沿用同一場地的地圖連結（沒填就讓前端用地址自動產生）
        payload.map_url = CMVenue.normalizeMapUrl(source.map_url) || null;
    }
    if (s.recurrence && opts.series) {
        payload.recurrence = normalizeRecurrenceRule(source.recurrence);
        payload.recurrence_until = source.recurrence_until == null ? null : source.recurrence_until;
    }
    return payload;
}

/* 把時間欄位往後挪 N 天（只動日期部分，時間與時區寫法原樣保留） */
function shiftDateField(value, days) {
    const raw = String(value == null ? '' : value);
    if (!raw) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})([\s\S]*)$/.exec(raw);
    if (!m) return raw;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (isNaN(dt.getTime())) return raw;
    dt.setUTCDate(dt.getUTCDate() + days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}${m[4]}`;
}

function daysBetween(fromDate, toDate) {
    const one = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDate || '').slice(0, 10));
    const two = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toDate || '').slice(0, 10));
    if (!one || !two) return null;
    const a = Date.UTC(Number(one[1]), Number(one[2]) - 1, Number(one[3]));
    const b = Date.UTC(Number(two[1]), Number(two[2]) - 1, Number(two[3]));
    return Math.round((b - a) / 86400000);
}

/* 建立系列的下一場（每日 cron 與介面「立即建立下一場」共用同一條路）
   回 { created, date, reason, overdue, competition } */
async function createNextOccurrence(seriesComp, operator, userAgent) {
    if (!(await recurrenceSchemaReady())) {
        return { created: false, date: null, reason: RECURRENCE_HINT, overdue: false, competition: null };
    }
    // 路徑參數是字串、資料庫 id 是數字：一律用字串比對，否則系列成員會認不出彼此
    const rootId = String(seriesComp.recurrence_parent_id || seriesComp.id);
    const { data: rows, error } = await supabase
        .from('competitions')
        .select('*');   // 這裡刻意全欄位取回再自己篩（欄位投影在不同 Supabase 版本行為不一）
    if (error) throw error;
    const all = (rows || []).filter((c) => !c.is_deleted);
    const seriesRows = all.filter((c) => String(c.id) === rootId || String(c.recurrence_parent_id || '') === rootId);
    // 以系列中「日期最新」的那一場當範本：手動改過的最新設定才會延續
    const latest = seriesRows.reduce((best, c) => (!best || String(c.date || '') > String(best.date || '') ? c : best), null);
    const source = seriesRows.find((c) => String(c.id) === String(seriesComp.id)) || seriesComp;
    const template = latest && String(latest.date || '') >= String(source.date || '') ? latest : source;
    const plan = planRecurringCreation(template, seriesRows.map((c) => c.date), new Date());
    if (!plan.create) {
        return { created: false, date: plan.date, reason: plan.reason, overdue: !!plan.overdue, competition: null };
    }

    const schema = await copySchemaReady();
    // 範本要完整的欄位，這裡再讀一次那一列
    const { data: fullRows, error: fullErr } = await supabase.from('competitions').select('*').eq('id', template.id);
    if (fullErr) throw fullErr;
    const full = (fullRows && fullRows[0]) || template;
    const name = String(full.name || '').replace(/（複製）$/, '').slice(0, 190) || '未命名賽事';
    const payload = buildDuplicatePayload(full, name, schema, { series: true });
    payload.date = plan.date;
    // 寫入時盡量給數字（欄位是 integer）；給不出數字才原樣帶
    const rootNum = Number(rootId);
    payload.recurrence_parent_id = Number.isFinite(rootNum) && rootId !== '' ? rootNum : rootId;

    // 日期往後挪幾天，報名窗與截止日一起挪，免得新場次的報名時間還停在舊日期
    const delta = daysBetween(full.date, plan.date);
    if (schema.window && delta) {
        payload.registration_start_at = shiftDateField(full.registration_start_at, delta);
        payload.registration_end_at = shiftDateField(full.registration_end_at, delta);
        if (schema.teamFields) payload.registration_deadline = shiftDateField(full.registration_deadline, delta);
    }

    const { data: created, error: insErr } = await supabase.from('competitions').insert([payload]).select();
    if (insErr) throw insErr;
    const row = created[0];
    await logAudit(
        (operator && operator.username) || 'system',
        'CREATE_RECURRING_COMPETITION',
        row.id,
        `週期性賽事建立下一場：${row.name}（${plan.date}；週期 ${RECURRENCE_RULE_LABELS[full.recurrence] || '未設定'}）`,
        userAgent
    );
    return { created: true, date: plan.date, reason: '', overdue: false, competition: row };
}

/* 每日 cron 用：每個系列看一次，該建就建 */
async function runRecurringCompetitions() {
    if (!(await recurrenceSchemaReady())) return { checked: 0, created: 0, skipped: 0, schema: 'missing' };
    const { data: rows, error } = await supabase
        .from('competitions')
        .select('*');
    if (error) {
        if (isMissingColumnError(error, ['recurrence', 'recurrence_until', 'recurrence_parent_id'])) {
            recurrenceSchemaCache = false;
            return { checked: 0, created: 0, skipped: 0, schema: 'missing' };
        }
        throw error;
    }
    const series = new Map();
    for (const row of (rows || []).filter((c) => !c.is_deleted && c.recurrence)) {
        const rootId = String(row.recurrence_parent_id || row.id);
        const cur = series.get(rootId);
        if (!cur || String(row.date || '') > String(cur.date || '')) series.set(rootId, row);
    }
    let created = 0;
    let skipped = 0;
    for (const latest of series.values()) {
        const result = await createNextOccurrence(latest, { username: 'system' }, 'cron');
        if (result.created) created++;
        else skipped++;
    }
    return { checked: series.size, created, skipped };
}

/* 這個賽事遞補時要不要通知？（欄位不存在 → 通知；NULL → 通知） */
function notifyOnPromote(comp) {
    return !comp || comp.waitlist_notify !== false;
}

let registrationReviewSchemaCache = null;

/* v2.21.0：候補順位手動調整只多一個欄位（registrations.waitlist_order）。
   欄位不存在時：調整順序的端點回 503 ＋ 指引，候補順位自動退回「先報名先排」（舊行為），
   指定遞補照常可用（它不需要這個欄位）。探測結果同樣有行程內快取。 */
const WAITLIST_ORDER_HINT =
    '資料庫尚未執行 v2.21.0 migration（migrations/2026-09-26-v2.21.0-waitlist-order.sql）：' +
    '調整候補順位需要 registrations.waitlist_order 欄位（未執行時順位一律依報名時間排序）。';

let waitlistOrderSchemaCache = null;

async function waitlistOrderSchemaReady() {
    if (waitlistOrderSchemaCache !== null) return waitlistOrderSchemaCache;
    waitlistOrderSchemaCache = await columnExists('registrations', 'waitlist_order');
    if (!waitlistOrderSchemaCache) {
        console.warn('⚠️ 尚未執行 v2.21.0 migration：候補順位手動調整停用（順位依報名時間排序）');
    }
    return waitlistOrderSchemaCache;
}

/* 審核／候補功能是否可用（欄位探測結果有行程內快取，同一個行程內不會中途翻轉） */
async function registrationReviewSchemaReady() {
    if (registrationReviewSchemaCache !== null) return registrationReviewSchemaCache;
    const [approval, waitlist] = await Promise.all([
        columnExists('competitions', 'requires_approval'),
        columnExists('competitions', 'waitlist_enabled')
    ]);
    registrationReviewSchemaCache = !!(approval && waitlist);
    if (!registrationReviewSchemaCache) {
        console.warn('⚠️ 尚未執行 v2.20.0 migration：報名審核與候補功能停用（報名一律直接核准）');
    }
    return registrationReviewSchemaCache;
}

/* 一場賽事的報名列與狀態統計（審核、候補、名額全部靠這一份） */
async function registrationSummary(competitionId) {
    const orderReady = await waitlistOrderSchemaReady();
    const cols = 'id,user_id,username,team_id,team_name,note,status,is_deleted,created_at'
        + (orderReady ? ',waitlist_order' : '');
    const { data, error } = await supabase
        .from('registrations')
        .select(cols)
        .eq('competition_id', competitionId)
        .eq('is_deleted', false)
        .order('id', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    const counts = CMCompetitionState.countByStatus(rows);
    return { rows, counts };
}

/* 佔名額的人數（＝狀態機判斷「額滿」用的數字） */
async function countRegistrations(competitionId) {
    const { counts } = await registrationSummary(competitionId);
    return counts.slots;
}

/* 針對單一使用者的推播（審核結果、候補遞補）。
   沒有訂閱／沒有金鑰都不是錯誤：回 { sent: 0 } 讓呼叫端照常完成動作。 */
async function notifyUser(userId, payload, options) {
    if (userId === null || userId === undefined) return { sent: 0, total: 0 };
    // v2.25.0：站台層的事件開關（每賽事的「遞補通知」是第二層，兩層都開才會推）
    // 事件種類可以放在第三個參數，也可以直接寫在 payload 裡（呼叫端兩種寫法都支援）
    const opts = options || {};
    const kind = opts.kind || (payload && payload.kind);
    if (kind && !(await pushEventEnabled(kind))) {
        return { sent: 0, total: 0, skipped: `站台設定已關閉「${PUSH_SETTING_LABELS[`event_${kind}`] || kind}」` };
    }
    try {
        const { data, error } = await supabase
            .from('push_subscriptions')
            .select('id,endpoint,p256dh,auth')
            .eq('user_id', userId)
            .eq('is_active', true);
        if (error) throw error;
        const subs = data || [];
        let sent = 0;
        let gone = 0;
        let failed = 0;
        const errors = [];   // v2.26.0：把失敗原因帶回去，寫進 push_log 供看板顯示與重送
        for (const sub of subs) {
            const result = await sendPushTo(sub, payload);
            if (result.ok) sent += 1;
            else if (result.gone) {
                gone += 1;
                await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', sub.id);
            } else {
                failed += 1;
                if (result.error) errors.push(result.error);
            }
        }
        return { sent, total: subs.length, gone, failed, errors };
    } catch (err) {
        if (isMissingTableError(err)) return { sent: 0, total: 0, skipped: 'no_table' };
        console.warn('推播通知失敗（不影響主要動作）：', err.message);
        return { sent: 0, total: 0, error: err.message };
    }
}

/* 推播事件紀錄（跟每日提醒共用 push_log；這張表不存在時安靜略過） */
async function logPushEvent(competitionId, kind, sentCount, extra) {
    // v2.26.0：多記「失敗幾筆、為什麼失敗、送了什麼內容、給誰」——重送要靠這些資訊。
    // 欄位還沒建（未執行 migration）時照舊只寫筆數，紀錄不會因此漏掉。
    try {
        const row = {
            competition_id: competitionId === undefined ? null : competitionId,
            kind,
            sent_count: sentCount || 0,
            sent_at: new Date().toISOString()
        };
        const detail = await pushLogDetailSchemaReady();
        const info = extra || {};
        if (detail) {
            row.failed_count = Number(info.failed || 0);
            const errors = Array.isArray(info.errors) ? info.errors.filter(Boolean) : [];
            row.error_detail = errors.length ? errors.join('；').slice(0, 500) : null;
            row.payload = info.payload || null;
            row.target_user_id = info.target_user_id === undefined ? null : info.target_user_id;
            row.target_user_ids = Array.isArray(info.target_user_ids) ? info.target_user_ids : null;
        }
        const { error } = await supabase.from('push_log').insert([row]);
        if (error) throw error;
    } catch (err) {
        if (!isMissingTableError(err)) console.warn('push_log 寫入失敗：', err.message);
    }
}

// 各賽事報名人數（公開的彙總資訊，未執行 migration 時回空物件）
app.get('/api/registration-counts', async (req, res) => {
    try {
        // v2.20.0：公開端點只回「佔名額的人數」與「候補人數」這種聚合數字，不含任何個人資訊
        const reviewReady = await registrationReviewSchemaReady();
        const { data, error } = await supabase
            .from('registrations')
            .select(reviewReady ? 'competition_id,status' : 'competition_id')
            .eq('is_deleted', false);
        if (error) throw error;

        const counts = {};
        const waitlist = {};
        (data || []).forEach((r) => {
            const key = String(r.competition_id);
            if (reviewReady && CMCompetitionState.normalizeRegStatus(r.status) === 'waitlisted') {
                waitlist[key] = (waitlist[key] || 0) + 1;
                return;
            }
            counts[key] = (counts[key] || 0) + 1;
        });

        // v2.27.0：工作人員人數（卡片徽章用）。同樣只有聚合數字，不含誰是誰。
        let staffCounts = {};
        try {
            if (await staffSchemaReady()) {
                const { data: staffRows, error: staffErr } = await supabase
                    .from('competition_staff')
                    .select('competition_id');
                if (staffErr) throw staffErr;
                (staffRows || []).forEach((r) => {
                    const key = String(r.competition_id);
                    staffCounts[key] = (staffCounts[key] || 0) + 1;
                });
            }
        } catch (staffErr) {
            // 工作人員人數拿不到不該讓報名人數整包失敗（前端只是少一個徽章）
            staffCounts = {};
        }

        res.json({ counts, waitlist, staff: staffCounts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
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
/* 登出（v2.19.0）：前端本來只清掉本機權杖，所以稽核日誌裡「登出」永遠是空的。
   現在前端會先打這個端點留一筆紀錄再清權杖（失敗也不影響登出）。 */
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        // 注意：`authenticateToken` 只設定 `req.user`（權杖內容）；`req.currentUser` 是
        // requireAdmin／requireSuperAdmin 另外查資料庫才補上的，這條路由沒有那些中介層。
        await logAudit(req.user.username, 'LOGOUT', req.user.sub, {
            role: req.user.role
        }, req.userAgent);
        res.json({ success: true });
    } catch (err) {
        // 稽核寫不進去不該讓使用者登不掉（前端無論如何都會清掉本機權杖）
        await logErrorToDb(req, 'logout_audit_error', err, { severity: 'warn' });
        res.json({ success: true, audit_logged: false });
    }
});

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

        const rows = (data || []).filter((r) => r.competitions && !r.competitions.is_deleted);

        // v2.20.0：附上狀態中文與「候補第幾位」（同一場賽事的候補一起排順位）
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const queues = {};
        if (reviewReady) {
            const compIds = Array.from(new Set(rows.map((r) => String(r.competition_id))));
            for (const cid of compIds) {
                const { data: all } = await supabase
                    .from('registrations')
                    .select(`id,user_id,status,created_at,is_deleted${orderReady ? ',waitlist_order' : ''}`)
                    .eq('competition_id', cid)
                    .eq('is_deleted', false);
                queues[cid] = CMCompetitionState.waitlistQueue(all || []).map((r) => String(r.id));
            }
        }

        res.json(rows.map((r) => {
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            const idx = (queues[String(r.competition_id)] || []).indexOf(String(r.id));
            return Object.assign({}, r, {
                status,
                status_label: CMCompetitionState.REG_STATUS_LABELS[status],
                waitlist_position: idx >= 0 ? idx + 1 : null,
                can_cancel: status !== 'rejected'
            });
        }));
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

        const { counts } = await registrationSummary(competitionId);
        const state = competitionState(comp, new Date(), { registeredCount: counts.slots, waitlistCount: counts.waitlisted });
        if (!state.can_register) return res.status(400).json({ error: state.reason });

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

        // v2.20.0：需審核 → 待審核；額滿且開放候補 → 候補；否則直接核准
        // （尚未執行 migration 時退回 v2.9.0 行為：一律直接核准，網站照常運作）
        const reviewReady = await registrationReviewSchemaReady();
        const decision = reviewReady
            ? CMCompetitionState.decideRegistration(comp, counts)
            : { status: 'confirmed', waitlist_position: null, reason: '' };
        if (!decision.status) return res.status(400).json({ error: decision.reason });

        const { data, error } = await supabase
            .from('registrations')
            .insert([{
                competition_id: comp.id,
                user_id: operator.sub,
                username: operator.username,
                team_name: teamName || null,
                note: cleanText(body.note, 200) || null,
                status: decision.status,
                is_deleted: false,
                created_at: new Date().toISOString()
            }])
            .select();
        if (error) throw error;

        const statusNote = decision.status === 'pending' ? '（待審核）'
            : decision.status === 'waitlisted' ? `（候補第 ${decision.waitlist_position} 位）` : '';
        await logAudit(operator.username, 'REGISTER_COMPETITION', comp.id,
            `報名賽事: ${comp.name}${teamName ? '（隊伍：' + teamName + '）' : ''}${statusNote}`, req.userAgent);

        const message = decision.status === 'pending' ? '已送出報名，等待主辦單位審核'
            : decision.status === 'waitlisted' ? `已排入候補（第 ${decision.waitlist_position} 位）`
                : '報名成功';

        res.json({
            message,
            status: decision.status,
            status_label: CMCompetitionState.REG_STATUS_LABELS[decision.status],
            waitlist_position: decision.waitlist_position,
            needs_approval: decision.status === 'pending',
            registration: data[0],
            registrations: counts.slots + (decision.status === 'waitlisted' ? 0 : 1)
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        if ((err && err.code) === '23505') return res.status(409).json({ error: '你已經報名過此賽事了' });
        await logErrorToDb(req, 'register_competition_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 審核一筆報名（管理員以上）：approve → 已核准；reject → 未錄取（附拒絕原因） */
app.post('/api/registrations/:id/review', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const action = String((req.body && req.body.action) || '').toLowerCase();
    const note = cleanText((req.body && req.body.note) || '', 200);

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以審核報名' });
    }
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action 只接受 approve（核准）或 reject（拒絕）' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const { data: reg, error } = await supabase.from('registrations').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到此報名紀錄' });

        const comp = await fetchCompetition(reg.competition_id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { counts } = await registrationSummary(reg.competition_id);
        const current = CMCompetitionState.normalizeRegStatus(reg.status);

        if (action === 'approve') {
            const max = parseInt(comp.max_registrations, 10) || 0;
            // 自己目前佔的名額要扣掉，否則「核准最後一個名額」會被誤判成名額已滿
            const others = counts.slots - (current === 'pending' || current === 'confirmed' ? 1 : 0);
            if (max > 0 && others >= max) {
                return res.status(400).json({ error: `名額已滿（${max} 人）：請先處理候補或拒絕其他報名，再核准這一筆` });
            }
        }

        const nextStatus = action === 'approve' ? 'confirmed' : 'rejected';
        const patchFields = {
            status: nextStatus,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: note || null
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', id);
        if (updErr) throw updErr;

        // 稽核動作一律寫字面值（tests/audit-actions.test.js 會擋「用變數拼出來的動作」，否則篩選會漏掉）
        if (action === 'approve') {
            await logAudit(req.user.username, 'REGISTER_APPROVED', comp.id,
                `核准報名: ${reg.username}（原狀態 ${CMCompetitionState.REG_STATUS_LABELS[current]}）${note ? '｜備註：' + note : ''}`,
                req.userAgent);
        } else {
            await logAudit(req.user.username, 'REGISTER_REJECTED', comp.id,
                `拒絕報名: ${reg.username}（原狀態 ${CMCompetitionState.REG_STATUS_LABELS[current]}）${note ? '｜備註：' + note : ''}`,
                req.userAgent);
        }

        const reviewPayload = {
            kind: 'review',
            title: action === 'approve' ? '報名已核准' : '報名結果通知',
            body: action === 'approve'
                ? `${comp.name}：你的報名已通過審核`
                : `${comp.name}：很抱歉，你的報名未錄取${note ? `（${note}）` : ''}`,
            url: '/?view=myregs',
            tag: `cm-reg-review-${reg.id}`
        };
        const push = await notifyUser(reg.user_id, reviewPayload, { kind: 'review' });
        await logPushEvent(comp.id, 'review_result', push.sent, {
            failed: push.failed, errors: push.errors, payload: reviewPayload, target_user_id: reg.user_id
        });

        res.json({
            message: action === 'approve' ? '已核准這筆報名' : '已拒絕這筆報名',
            registration: Object.assign({}, reg, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
            notified: push.sent
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'review_registration_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* 手動遞補下一位候補（管理員以上）：自動遞補失效時（例如當下沒名額、後來才空出來）的補救手段 */
app.post('/api/competitions/:id/registrations/promote', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以遞補候補' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { rows, counts } = await registrationSummary(competitionId);
        const next = CMCompetitionState.nextWaitlist(rows);
        if (!next) return res.status(400).json({ error: '目前沒有候補名單' });

        // v2.21.0：名額守門改用共用純函式（與「指定遞補」同一份判斷，兩邊不可能走鐘）
        const plan = CMCompetitionState.planPromotion(comp, rows, next.id);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        const nextStatus = plan.status;
        const patchFields = {
            status: nextStatus,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: '候補遞補'
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', next.id);
        if (updErr) throw updErr;

        // v2.22.0：賽事可關閉「遞補就通知」（關掉時遞補照常成立，只是不推播，稽核寫明原因）
        const notify = notifyOnPromote(comp);
        await logAudit(req.user.username, 'PROMOTE_WAITLIST', comp.id,
            `手動遞補候補: ${next.username}（第 ${plan.position} 順位 → ${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}）${notify ? '' : '｜未通知（依賽事設定）'}`, req.userAgent);

        const promotePayload = {
            kind: 'promote',
            title: '候補遞補通知',
            body: `${comp.name}：你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}`,
            url: '/?view=myregs',
            tag: `cm-reg-promote-${next.id}`
        };
        const push = notify ? await notifyUser(next.user_id, promotePayload, { kind: 'promote' }) : { sent: 0 };
        if (notify) {
            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                failed: push.failed, errors: push.errors, payload: promotePayload, target_user_id: next.user_id
            });
        }

        res.json({
            message: notify ? `已遞補 ${next.username}` : `已遞補 ${next.username}（依賽事設定未通知）`,
            registration: Object.assign({}, next, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
            notified: push.sent,
            notify_disabled: !notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'promote_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});


/* v2.21.0：指定遞補（不照順位）——管理員可以挑候補名單裡的任何一位先遞補。
   為什麼要有：實務上候補第一名可能聯絡不到、或根本不是需要的組別，硬要「照順位」反而卡住。
   「名額已滿不能遞補」的判斷走共用純函式 planPromotion()，與「遞補下一位」同一份規則。 */
app.post('/api/registrations/:id/promote', authenticateToken, async (req, res) => {
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以遞補候補' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });

        const { data: reg, error: findErr } = await supabase
            .from('registrations')
            .select('id,competition_id,user_id,username,status,is_deleted')
            .eq('id', req.params.id)
            .maybeSingle();
        if (findErr) throw findErr;
        if (!reg || reg.is_deleted) return res.status(404).json({ error: '找不到這筆報名' });

        const comp = await fetchCompetition(reg.competition_id);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const { rows } = await registrationSummary(reg.competition_id);
        const plan = CMCompetitionState.planPromotion(comp, rows, reg.id);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        const patchFields = {
            status: plan.status,
            reviewed_at: new Date().toISOString(),
            reviewed_by: req.user.username,
            review_note: `指定遞補（原第 ${plan.position} 順位）`
        };
        const { error: updErr } = await supabase.from('registrations').update(patchFields).eq('id', reg.id);
        if (updErr) throw updErr;

        const notify = notifyOnPromote(comp);
        await logAudit(req.user.username, 'PROMOTE_WAITLIST', comp.id,
            `指定遞補候補: ${reg.username}（第 ${plan.position} 順位 → ${CMCompetitionState.REG_STATUS_LABELS[plan.status]}，未照順位）${notify ? '' : '｜未通知（依賽事設定）'}`,
            req.userAgent);

        const promotePayload = {
            kind: 'promote',
            title: '候補遞補通知',
            body: `${comp.name}：你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[plan.status]}`,
            url: '/?view=myregs',
            tag: `cm-reg-promote-${reg.id}`
        };
        const push = notify ? await notifyUser(reg.user_id, promotePayload, { kind: 'promote' }) : { sent: 0 };
        if (notify) {
            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                failed: push.failed, errors: push.errors, payload: promotePayload, target_user_id: reg.user_id
            });
        }

        res.json({
            message: notify
                ? `已遞補 ${reg.username}（原第 ${plan.position} 順位）`
                : `已遞補 ${reg.username}（原第 ${plan.position} 順位，依賽事設定未通知）`,
            registration: Object.assign({}, reg, patchFields),
            status_label: CMCompetitionState.REG_STATUS_LABELS[plan.status],
            notified: push.sent,
            notify_disabled: !notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'promote_specific_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});

/* v2.21.0：調整候補順位（管理員手動排序）。
   前端送「完整的 id 順序」；少一筆、多一筆或重複都會整批拒絕（planWaitlistOrder），
   避免有人剛好同時被遞補／取消時，寫出「少數人被默默擠到後面」的半套結果。 */
app.post('/api/competitions/:id/waitlist/reorder', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;

    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以調整候補順位' });
    }

    try {
        if (!(await registrationReviewSchemaReady())) return res.status(503).json({ error: REGISTRATION_REVIEW_HINT });
        if (!(await waitlistOrderSchemaReady())) return res.status(503).json({ error: WAITLIST_ORDER_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
        if (!order || !order.length) return res.status(400).json({ error: '請提供完整的候補順序（order 陣列）' });

        const { rows } = await registrationSummary(competitionId);
        const plan = CMCompetitionState.planWaitlistOrder(rows, order);
        if (!plan.ok) return res.status(400).json({ error: plan.reason });

        for (const update of plan.updates) {
            const { error } = await supabase.from('registrations').update({ waitlist_order: update.waitlist_order }).eq('id', update.id);
            if (error) throw error;
        }

        const label = (id) => (rows.find((r) => String(r.id) === String(id)) || {}).username || `#${id}`;
        const names = plan.updates.map((u, i) => `${i + 1}.${label(u.id)}`);
        const shown = names.length > 8 ? `${names.slice(0, 8).join('、')}…等 ${names.length} 人` : names.join('、');

        await logAudit(req.user.username, 'REORDER_WAITLIST', comp.id,
            `調整候補順位（${plan.updates.length} 人）: ${shown}`, req.userAgent);

        // 回傳更新後的候補名單（前端不必再查一次，也順便讓它看到後端算出來的順位）
        const { rows: after } = await registrationSummary(competitionId);
        const queue = CMCompetitionState.waitlistQueue(after);
        res.json({
            message: `已更新候補順位（${plan.updates.length} 人）`,
            waitlist: queue.map((r, i) => Object.assign({}, r, { waitlist_position: i + 1 }))
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'reorder_waitlist_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 調整「遞補時要不要通知」（v2.22.0，管理員以上）
app.post('/api/competitions/:id/waitlist/notify', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以調整遞補通知設定' });
    }

    try {
        if (!(await waitlistNotifySchemaReady())) return res.status(503).json({ error: WAITLIST_NOTIFY_HINT });

        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        if (typeof (req.body && req.body.notify) !== 'boolean') {
            return res.status(400).json({ error: '請提供 notify（true＝遞補時通知，false＝不通知）' });
        }
        const notify = req.body.notify;
        const before = notifyOnPromote(comp);
        if (before === notify) {
            return res.json({ message: notify ? '遞補通知已是開啟' : '遞補通知已是關閉', notify });
        }

        const { error } = await supabase.from('competitions').update({ waitlist_notify: notify }).eq('id', comp.id);
        if (error) throw error;

        await logAudit(req.user.username, 'WAITLIST_NOTIFY', comp.id,
            `遞補通知設定：${before ? '開啟' : '關閉'} → ${notify ? '開啟' : '關閉'}${notify ? '' : '（遞補仍會生效，只是不推播）'}`,
            req.userAgent);

        res.json({
            message: notify ? '已開啟：之後遞補候補會推播通知對方' : '已關閉：之後遞補候補不會推播通知（遞補仍然生效）',
            notify
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'update_waitlist_notify_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 候補相關的異動紀錄（v2.22.0，管理員以上）：從稽核日誌撈這場合適的紀錄，組成時間軸
app.get('/api/competitions/:id/waitlist/history', authenticateToken, async (req, res) => {
    const competitionId = req.params.id;
    if (!ADMIN_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: '權限不足：只有管理員以上可以查看候補異動紀錄' });
    }

    try {
        const comp = await fetchCompetition(competitionId);
        if (!comp) return res.status(404).json({ error: '找不到該賽事' });

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        // 只認「跟候補有關」的動作：調整順位、手動遞補、自動遞補、審核、通知設定、取消報名
        const actions = ['REORDER_WAITLIST', 'PROMOTE_WAITLIST', 'AUTO_PROMOTE_WAITLIST', 'WAITLIST_NOTIFY',
            'REGISTER_APPROVED', 'REGISTER_REJECTED', 'CANCEL_REGISTRATION'];

        // v2.23.0：可以往回翻（offset）。一律從最新抓到「這一頁結尾 + 1」再自己切頁：
        // 正式站 PostgREST 會依 range 回傳、測試替身則回全部，這樣寫兩種環境行為一致
        // （與 /api/audit-logs 同一個理由）。抓超過上限就請管理員去稽核日誌頁篩選。
        const windowSize = Math.min(offset + limit + 1, WAITLIST_HISTORY_MAX_WINDOW);
        const { data, error } = await supabase
            .from('audit_logs')
            .select('*')
            .eq('target_id', comp.id)
            .in('action', actions)
            .order('created_at', { ascending: false })
            .range(0, windowSize - 1);
        if (error) throw error;

        const win = (data || []).slice(0, windowSize);
        const logs = win.slice(offset, offset + limit).map((l) => ({
            id: l.id,
            at: l.created_at,
            action: l.action,
            action_label: auditActionLabel(l.action),
            user: l.user_id,
            details: l.details || ''
        }));
        // 還有更早的嗎？抓滿整個窗口還多出下一筆才算有
        const more = win.length > offset + limit;
        const capped = windowSize >= WAITLIST_HISTORY_MAX_WINDOW && win.length >= windowSize;

        res.json({
            competition_id: comp.id,
            name: comp.name,
            returned: logs.length,
            limit,
            offset,
            has_more: more && !capped,
            capped,
            window_size: windowSize,
            actions: actions.map((a) => ({ value: a, label: auditActionLabel(a) })),
            logs
        });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: REGISTRATION_HINT });
        await logErrorToDb(req, 'fetch_waitlist_history_error', err);
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

        // v2.20.0：讓出名額時自動遞補第一位候補（僅限「原本佔名額」的報名，且此賽事開放候補）
        let promoted = null;
        try {
            const reviewReady = await registrationReviewSchemaReady();
            const cancelledStatus = CMCompetitionState.normalizeRegStatus(reg.status);
            if (reviewReady && cancelledStatus !== 'waitlisted' && cancelledStatus !== 'rejected') {
                const comp = await fetchCompetition(reg.competition_id);
                if (comp && CMCompetitionState.reviewFlags(comp).waitlistEnabled) {
                    const { rows, counts } = await registrationSummary(reg.competition_id);
                    const next = CMCompetitionState.nextWaitlist(rows, reg.id);
                    const max = parseInt(comp.max_registrations, 10) || 0;
                    if (next && (max === 0 || counts.slots < max)) {
                        const nextStatus = CMCompetitionState.promotionStatus(comp);
                        const patchFields = {
                            status: nextStatus,
                            reviewed_at: new Date().toISOString(),
                            reviewed_by: req.user.username,
                            review_note: '候補自動遞補'
                        };
                        const { error: pErr } = await supabase.from('registrations').update(patchFields).eq('id', next.id);
                        if (pErr) throw pErr;

                        // v2.22.0：自動遞補也遵守賽事的「遞補通知」設定
                        const autoNotify = notifyOnPromote(comp);
                        await logAudit(req.user.username, 'AUTO_PROMOTE_WAITLIST', reg.competition_id,
                            `自動遞補候補: ${next.username}（第 1 順位 → ${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}，因 ${reg.username} 取消報名）${autoNotify ? '' : '｜未通知（依賽事設定）'}`,
                            req.userAgent);

                        const autoPayload = {
                            kind: 'promote',
                            title: '候補遞補通知',
                            body: `${comp.name}：有人取消報名，你已從候補遞補為${CMCompetitionState.REG_STATUS_LABELS[nextStatus]}`,
                            url: '/?view=myregs',
                            tag: `cm-reg-promote-${next.id}`
                        };
                        const push = autoNotify ? await notifyUser(next.user_id, autoPayload, { kind: 'promote' }) : { sent: 0 };
                        if (autoNotify) {
                            await logPushEvent(comp.id, 'waitlist_promoted', push.sent, {
                                failed: push.failed, errors: push.errors, payload: autoPayload, target_user_id: next.user_id
                            });
                        }

                        promoted = {
                            id: next.id,
                            username: next.username,
                            status: nextStatus,
                            status_label: CMCompetitionState.REG_STATUS_LABELS[nextStatus],
                            notified: push.sent,
                            notify_disabled: !autoNotify
                        };
                    }
                }
            }
        } catch (promoteErr) {
            // 遞補失敗不可以讓「取消報名」跟著失敗（取消已經生效了）
            await logErrorToDb(req, 'auto_promote_waitlist_error', promoteErr);
        }

        res.json({ message: '已取消報名', promoted });
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
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const isAdmin = ADMIN_ROLES.has(req.user.role);
        const baseCols = 'id,competition_id,user_id,username,team_id,team_name,note,status,created_at';

        // v3.0.0：分頁（opt-in，沒帶 limit 就維持原本行為）。
        // 有 ?status= 時，狀態是「正規化之後」才比對（舊資料可能不合標準值），資料庫層無法可靠過濾，
        // 所以那種情況改用記憶體切片，並用 page.paged_by 標示（讓呼叫端知道差別）。
        const paging = CMPaging.parsePaging(req.query, { max: REGISTRATIONS_PAGE_MAX });
        const wantedStatus = String(req.query.status || '').split(',').map((s) => s.trim()).filter(Boolean);
        const pageInDb = paging.paged && isAdmin && wantedStatus.length === 0;

        let regQuery = supabase
            .from('registrations')
            .select(reviewReady ? `${baseCols},reviewed_at,reviewed_by,review_note${orderReady ? ',waitlist_order' : ''}` : baseCols)
            .eq('competition_id', competitionId)
            .eq('is_deleted', false)
            .order('id', { ascending: true });
        if (pageInDb) regQuery = regQuery.range(paging.offset, paging.offset + paging.limit - 1);

        const { data, error } = await regQuery;
        if (error) throw error;

        const withLabels = (list) => list.map((r) => Object.assign({}, r, {
            status: CMCompetitionState.normalizeRegStatus(r.status),
            status_label: CMCompetitionState.REG_STATUS_LABELS[CMCompetitionState.normalizeRegStatus(r.status)]
        }));

        let rows = data || [];
        if (!isAdmin) rows = rows.filter((r) => String(r.user_id) === String(req.user.sub));
        rows = withLabels(rows);

        // 候補順位與各狀態統計都需要「整場名單」。分頁時另外用輕量查詢取回
        // （只選計算需要的欄位，不把整份名單的內容撈回來）。
        let roster = rows;
        let queueIds = null;
        if (paging.paged && isAdmin) {
            const { data: rosterRows } = await supabase
                .from('registrations')
                .select(orderReady ? 'id,created_at,status,waitlist_order' : 'id,created_at,status')
                .eq('competition_id', competitionId)
                .eq('is_deleted', false)
                .order('id', { ascending: true });
            roster = withLabels(rosterRows || []);
        }

        // 候補順位（先報名先排；只有管理員需要看到整份名單的順位）
        if (isAdmin) {
            const queue = CMCompetitionState.waitlistQueue(roster);
            queueIds = queue.map((r) => r.id);
            const position = {};
            queue.forEach((r, i) => { position[String(r.id)] = i + 1; });
            rows = rows.map((r) => Object.assign({}, r, {
                waitlist_position: position[String(r.id)] || null
            }));
        }

        const counts = CMCompetitionState.countByStatus(roster);

        if (!paging.paged) {
            const result = wantedStatus.length ? rows.filter((r) => wantedStatus.includes(r.status)) : rows;
            return res.json({
                registrations: result,
                total: result.length,
                counts,
                waitlist_queue: isAdmin ? queueIds : undefined,
                schema_ready: reviewReady
            });
        }

        // 分頁：total 是「符合篩選條件的全部筆數」，registrations 只回這一頁
        const fullList = wantedStatus.length ? roster.filter((r) => wantedStatus.includes(r.status)) : roster;
        const sliced = pageInDb ? rows : CMPaging.pageSlice(fullList, paging);
        res.json({
            registrations: sliced,
            total: fullList.length,
            counts,
            waitlist_queue: isAdmin ? queueIds : undefined,
            schema_ready: reviewReady,
            page: CMPaging.pagedResponse(sliced, {
                limit: paging.limit, offset: paging.offset, total: fullList.length,
                pagedBy: pageInDb ? 'db' : 'memory'
            })
        });
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
        const reviewReady = await registrationReviewSchemaReady();
        const orderReady = reviewReady ? await waitlistOrderSchemaReady() : false;
        const notifyReady = reviewReady ? await waitlistNotifySchemaReady() : false;
        // 只有欄位存在時才多查一次（未執行 migration 時不多打一次資料庫）
        const notifyRow = notifyReady ? await fetchCompetition(competitionId) : null;
        const [teamsRes, regsRes] = await Promise.all([
            supabase.from('competition_teams').select('*').eq('competition_id', competitionId).eq('is_deleted', false).order('id', { ascending: true }),
            supabase.from('registrations')
                .select(reviewReady
                    ? `id,username,user_id,team_id,team_name,status,created_at${orderReady ? ',waitlist_order' : ''}`
                    : 'id,username,user_id,team_id,team_name')
                .eq('competition_id', competitionId)
                .eq('is_deleted', false)
                .order('id', { ascending: true })
        ]);
        if (teamsRes.error) throw teamsRes.error;
        if (regsRes.error) throw regsRes.error;

        const regs = (regsRes.data || []).map((r) => {
            const status = CMCompetitionState.normalizeRegStatus(r.status);
            return Object.assign({}, r, {
                status,
                status_label: CMCompetitionState.REG_STATUS_LABELS[status]
            });
        });
        // 只有「已核准」的人算在隊伍名單裡（待審核／候補還不確定能不能參賽，不該先編隊）
        const approved = regs.filter((r) => r.status === 'confirmed');
        const teams = (teamsRes.data || []).map((t) => Object.assign({}, t, {
            members: approved.filter((r) => String(r.team_id) === String(t.id))
        }));

        const queue = CMCompetitionState.waitlistQueue(regs);
        const pending = regs.filter((r) => r.status === 'pending');
        const waitlisted = queue.map((r, i) => Object.assign({}, r, { waitlist_position: i + 1 }));

        res.json({
            teams,
            unassigned: approved.filter((r) => !r.team_id),
            // v2.20.0：審核／候補用的清單（管理員才看得到內容，但一般用戶本來就打不到這個端點）
            pending,
            waitlisted,
            counts: CMCompetitionState.countByStatus(regs),
            schema_ready: reviewReady,
            // v2.21.0：候補順位可不可以手動調整（有欄位才行；沒欄位時前端不顯示上下移按鈕）
            canReorderWaitlist: orderReady,
            // v2.22.0：遞補通知開關（未執行 migration 時 notify_schema_ready=false、一律視為開啟）
            notify_schema_ready: notifyReady,
            notify_on_promote: notifyOnPromote(notifyRow),
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

        // v2.20.0：只有「已核准」的報名可以編進隊伍（待審核／候補還沒確定能不能參賽）
        const regStatus = CMCompetitionState.normalizeRegStatus(reg.status);
        if (regStatus !== 'confirmed') {
            return res.status(400).json({
                error: `只能編排「已核准」的報名（${reg.username} 目前是「${CMCompetitionState.REG_STATUS_LABELS[regStatus]}」）`
            });
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
// v3.0.0：列表單次上限（存在＝避免一次要求太多筆把資料庫打爆；預設請求不切片）
const POSTER_THUMB_MAX_BYTES = 250 * 1024;   // 縮圖上限（前端產生的通常 20–60KB）
const COMPETITIONS_PAGE_MAX = 100;
const REGISTRATIONS_PAGE_MAX = 200;

const POSTER_MAX_BYTES = 3 * 1024 * 1024;             // 3MB（前端會先縮圖，通常僅數百 KB）
const POSTER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const POSTER_HINT = '資料庫尚未加入海報欄位，請先在 Supabase SQL Editor 執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
const PUSH_HINT = '資料庫尚未加入推播資料表（app_settings / push_subscriptions / push_log），請先執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
// v2.26.0：推播失敗明細與重送需要的欄位
const PUSH_LOG_DETAIL_HINT = '推播失敗明細與重送需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-push-log-detail.sql';
const pushLogDetailSchemaReady = createSchemaProbe(async () => {
    const hasFailed = await columnExists('push_log', 'failed_count');
    if (!hasFailed) return false;
    return columnExists('push_log', 'payload');
});
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
// v2.25.0：可用 options.kinds 只挑要發的種類（站台設定可以個別關掉）
function pushCandidates(competitions, options) {
    const opts = options || {};
    const wants = Array.isArray(opts.kinds) ? opts.kinds : ['reminder', 'new'];
    const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now) || Date.now();
    const windowMs = opts.windowMs || 24 * 3600 * 1000;
    const lastRunMs = opts.lastRunMs || 0;
    const done = opts.done || new Set();
    const out = [];

    (competitions || []).forEach((item) => {
        if (!item || item.is_deleted) return;
        const key = (kind) => `${item.id}:${kind}`;

        const start = competitionStartMs(item, opts.offset);
        if (wants.includes('reminder') && start !== null && start >= nowMs && start - nowMs <= windowMs && !done.has(key('reminder'))) {
            out.push({ kind: 'reminder', competition: item, startMs: start });
        }
        const createdMs = item.created_at ? Date.parse(item.created_at) : null;
        if (wants.includes('new') && createdMs && lastRunMs && createdMs > lastRunMs && !done.has(key('new'))) {
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

// ---------- 版本資訊 ----------
// v2.25.0：頁面上的版本字串一律由這裡取，避免又多一處手動更新的版本號忘了改
// （頁面副標曾經停在 v2.18.0 好幾版，就是因為它寫死在 HTML 裡）
const APP_VERSION = (() => {
    try {
        return require('./package.json').version;
    } catch (err) {
        return 'unknown';
    }
})();

const versionHandler = (req, res) => {
    res.json({ version: APP_VERSION });
};

app.get('/api/version', versionHandler);

// ---------- v2.25.0：推播設定（時間與事件）----------
//
// 存在既有的 app_settings 鍵值表裡（不新增資料表、不需要 migration）。
// 讀不到（例如資料庫少這張表）時一律用預設值，絕不讓推播整個壞掉。

const PUSH_SETTINGS_DEFAULTS = {
    push_digest_enabled: true,        // 每日摘要總開關
    push_digest_time: '09:00',        // 每日摘要發送時間（澳門時間 UTC+8）
    push_digest_kind_new: true,       // 摘要：新發佈的賽事
    push_digest_kind_reminder: true,  // 摘要：即將開賽提醒（24 小時內）
    push_event_review: true,          // 即時：報名審核結果（核准／拒絕）
    push_event_promote: true,         // 即時：候補遞補（含手動、指定、自動）
    push_event_announce: true,        // 即時：站內公告發布時（v2.26.0）
    push_event_result: true           // 即時：賽事成績公布時（v3.1.0）
};

const PUSH_EVENT_SETTING_KEYS = {
    review: 'push_event_review',
    promote: 'push_event_promote',
    announce: 'push_event_announce',  // v2.26.0：公告發布通知
    result: 'push_event_result'       // v3.1.0：成績公布通知
};

const PUSH_SETTINGS_HINT =
    '推播設定需要資料庫的 app_settings 表（讀不到時會用預設值繼續運作）。';

/* 字串（設定表的 value）→ 布林；只有明確的 false 才算關閉 */
function pushSettingBool(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fallback;
}

const isClockTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));

/* 把 app_settings 讀回來的原始值整理成好用的設定物件 */
function pushSettingsFromRows(rows) {
    const raw = rows || {};
    return {
        digest_enabled: pushSettingBool(raw.push_digest_enabled, PUSH_SETTINGS_DEFAULTS.push_digest_enabled),
        digest_time: isClockTime(raw.push_digest_time) ? String(raw.push_digest_time) : PUSH_SETTINGS_DEFAULTS.push_digest_time,
        digest_kind_new: pushSettingBool(raw.push_digest_kind_new, PUSH_SETTINGS_DEFAULTS.push_digest_kind_new),
        digest_kind_reminder: pushSettingBool(raw.push_digest_kind_reminder, PUSH_SETTINGS_DEFAULTS.push_digest_kind_reminder),
        event_review: pushSettingBool(raw.push_event_review, PUSH_SETTINGS_DEFAULTS.push_event_review),
        event_promote: pushSettingBool(raw.push_event_promote, PUSH_SETTINGS_DEFAULTS.push_event_promote),
        event_announce: pushSettingBool(raw.push_event_announce, PUSH_SETTINGS_DEFAULTS.push_event_announce),
        event_result: pushSettingBool(raw.push_event_result, PUSH_SETTINGS_DEFAULTS.push_event_result)
    };
}

/* 驗證前端送來的設定；有錯就回 { error }，不偷偷改掉使用者的輸入 */
function normalizePushSettingsInput(body, current) {
    // 基準值一律用「整理過」的預設值＋目前設定（欄位名才一致），
    // 否則沒帶到的欄位會變成 undefined 而被當成新值寫回去
    const base = Object.assign({}, pushSettingsFromRows({}), current || {});
    const b = body || {};
    const out = Object.assign({}, base);
    const boolFields = ['digest_enabled', 'digest_kind_new', 'digest_kind_reminder', 'event_review', 'event_promote', 'event_announce', 'event_result'];
    for (const field of boolFields) {
        if (b[field] === undefined) continue;
        if (typeof b[field] !== 'boolean') return { error: `「${field}」只能是 true 或 false` };
        out[field] = b[field];
    }
    if (b.digest_time !== undefined) {
        if (!isClockTime(b.digest_time)) return { error: '發送時間格式要像 09:00 或 21:30' };
        out.digest_time = String(b.digest_time);
    }
    return { settings: out };
}

/* 現在在網站時區（預設 +08:00）是幾點、哪一天 */
function pushLocalParts(nowMs, offset) {
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(String(offset || SITE_UTC_OFFSET));
    const deltaMinutes = match
        ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
        : 8 * 60;
    const local = new Date(Number(nowMs) + deltaMinutes * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
        time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
    };
}

/* 現在該不該發每日摘要？（純函式）
   排程不是每分鐘都在跑，所以用「補送」語意：時間過了就發，但一天只發一次；
   設定的時間落在兩次排程之間時，由下一次排程補上。 */
function shouldRunDigest(options) {
    const opts = options || {};
    const parts = pushLocalParts(opts.nowMs === undefined ? Date.now() : opts.nowMs, opts.offset);
    if (!opts.enabled) return { run: false, reason: '每日摘要已關閉', date: parts.date, time: parts.time };
    if (opts.lastDigestDate && String(opts.lastDigestDate).slice(0, 10) === parts.date) {
        return { run: false, reason: '今天已經發送過', date: parts.date, time: parts.time };
    }
    const scheduled = isClockTime(opts.scheduledTime) ? String(opts.scheduledTime) : PUSH_SETTINGS_DEFAULTS.push_digest_time;
    if (parts.time < scheduled) {
        return { run: false, reason: `還沒到發送時間（設定 ${scheduled}，現在 ${parts.time}）`, date: parts.date, time: parts.time };
    }
    return { run: true, reason: '', date: parts.date, time: parts.time };
}

/* 摘要要發哪幾種事件（都關掉就沒有東西可發） */
function digestKindsFromSettings(settings) {
    const kinds = [];
    if (settings.digest_kind_reminder) kinds.push('reminder');
    if (settings.digest_kind_new) kinds.push('new');
    return kinds;
}

/* 讀取推播設定；讀不到就回預設值並標記 ready=false（讓介面誠實說明） */
async function readPushSettings() {
    const keys = Object.keys(PUSH_SETTINGS_DEFAULTS);
    try {
        const values = await Promise.all(keys.map((key) => getSetting(key)));
        const raw = {};
        keys.forEach((key, index) => { raw[key] = values[index]; });
        return { settings: pushSettingsFromRows(raw), ready: true, error: null };
    } catch (err) {
        // 用「整理過」的預設值（欄位名與正常路徑一致），否則摘要會被誤判成關閉
        return { settings: pushSettingsFromRows({}), ready: false, error: err.message };
    }
}

async function writePushSettings(settings) {
    // 逐一明確對應，避免鍵名拼錯（設定表的 key ↔ 介面欄位）
    const map = {
        push_digest_enabled: settings.digest_enabled,
        push_digest_time: settings.digest_time,
        push_digest_kind_new: settings.digest_kind_new,
        push_digest_kind_reminder: settings.digest_kind_reminder,
        push_event_review: settings.event_review,
        push_event_promote: settings.event_promote,
        push_event_announce: settings.event_announce,
        push_event_result: settings.event_result
    };
    for (const key of Object.keys(map)) {
        await setSetting(key, map[key] === true ? 'true' : map[key] === false ? 'false' : String(map[key]));
    }
}

/* 這一種即時事件現在要不要推播？（讀不到設定時一律視為要，行為不變） */
async function pushEventEnabled(kind) {
    const key = PUSH_EVENT_SETTING_KEYS[kind];
    if (!key) return true;
    try {
        const value = await getSetting(key);
        return pushSettingBool(value, true);
    } catch (err) {
        return true;
    }
}

// 管理員以上：讀取／更新推播設定
app.get('/api/push/settings', requireAdmin, async (req, res) => {
    const { settings, ready } = await readPushSettings();
    res.json({ settings, schema_ready: ready, hint: ready ? null : PUSH_SETTINGS_HINT });
});

app.post('/api/push/settings', requireAdmin, async (req, res) => {
    const current = await readPushSettings();
    const normalized = normalizePushSettingsInput(req.body, current.settings);
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    try {
        await writePushSettings(normalized.settings);
    } catch (err) {
        await logErrorToDb(req, 'save_push_settings_error', err);
        return res.status(503).json({ error: PUSH_SETTINGS_HINT });
    }

    const changes = [];
    for (const key of Object.keys(PUSH_SETTINGS_DEFAULTS)) {
        const field = {
            push_digest_enabled: 'digest_enabled',
            push_digest_time: 'digest_time',
            push_digest_kind_new: 'digest_kind_new',
            push_digest_kind_reminder: 'digest_kind_reminder',
            push_event_review: 'event_review',
            push_event_promote: 'event_promote',
            push_event_announce: 'event_announce',
            push_event_result: 'event_result'
        }[key];
        if (String(current.settings[field]) !== String(normalized.settings[field])) {
            changes.push(`${PUSH_SETTING_LABELS[field]}：${formatPushSettingValue(field, current.settings[field])} → ${formatPushSettingValue(field, normalized.settings[field])}`);
        }
    }

    await logAudit(req.currentUser.username, 'UPDATE_PUSH_SETTINGS', null,
        changes.length ? `更新推播設定：${changes.join('；')}` : '更新推播設定（沒有變更）', req.userAgent);

    res.json({ success: true, settings: normalized.settings, changes });
});

const PUSH_SETTING_LABELS = {
    digest_enabled: '每日摘要',
    digest_time: '發送時間',
    digest_kind_new: '摘要含新賽事',
    digest_kind_reminder: '摘要含開賽提醒',
    event_review: '報名審核結果通知',
    event_promote: '候補遞補通知',
    event_announce: '站內公告通知',  // v2.26.0
    event_result: '成績公布通知'     // v3.1.0
};

const formatPushSettingValue = (field, value) => (typeof value === 'boolean'
    ? (value ? '開啟' : '關閉')
    : String(value));

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

        // v3.0.0：縮圖（可選）。前端上傳時用 canvas 產生，列表與預覽改載縮圖；
        // 讀不到 thumb_* 欄位（尚未跑 migration）就照舊只存原圖，功能不受影響。
        const thumbParsed = parseImageDataUrl(req.body && req.body.thumbDataUrl);
        // 不論這次有沒有帶縮圖都要知道欄位在不在：沒帶的時候要能「清掉舊縮圖」，
        // 否則換了海報會留著上一張的縮圖（列表就會顯示錯的圖）。
        const thumbReady = await columnExists('competition_posters', 'thumb_data');
        const thumbTooBig = !!(thumbParsed && thumbParsed.buffer.length > POSTER_THUMB_MAX_BYTES);
        const useThumb = !!(thumbParsed && thumbReady && !thumbTooBig);

        const now = new Date().toISOString();
        const posterRow = {
            competition_id: comp.id,
            mime: parsed.mime,
            bytes: parsed.buffer.length,
            data: parsed.buffer.toString('base64'),
            uploaded_by: req.currentUser ? req.currentUser.username : null,
            updated_at: now
        };
        if (useThumb) {
            posterRow.thumb_mime = thumbParsed.mime;
            posterRow.thumb_bytes = thumbParsed.buffer.length;
            posterRow.thumb_data = thumbParsed.buffer.toString('base64');
        } else if (thumbReady) {
            // 這次沒帶縮圖（或超過上限）→ 明確清掉舊縮圖，避免「新海報配舊縮圖」
            posterRow.thumb_mime = null;
            posterRow.thumb_bytes = null;
            posterRow.thumb_data = null;
        }

        const { error: upErr } = await supabase.from('competition_posters').upsert([posterRow], { onConflict: 'competition_id' });
        if (upErr) throw upErr;

        const { error: colErr } = await supabase.from('competitions').update({ poster_updated_at: now }).eq('id', comp.id);
        if (colErr) throw colErr;

        await logAudit(req.user.username, 'UPLOAD_POSTER', comp.id,
            `上傳自訂海報（${Math.round(parsed.buffer.length / 1024)}KB${useThumb ? `，縮圖 ${Math.round(thumbParsed.buffer.length / 1024)}KB` : ''}）`, req.userAgent);
        res.json({
            message: '海報已更新，分享與卡片都會改用手動上傳的海報',
            posterUrl: `/api/competitions/${comp.id}/poster?v=${Date.parse(now)}`,
            thumbUrl: useThumb ? `/api/competitions/${comp.id}/poster?variant=thumb&v=${Date.parse(now)}` : null,
            bytes: parsed.buffer.length,
            thumb_bytes: useThumb ? thumbParsed.buffer.length : null,
            thumb_saved: useThumb ? (parsed.buffer.length - thumbParsed.buffer.length) : null,
            thumb_note: (thumbParsed && thumbTooBig) ? `縮圖超過 ${Math.round(POSTER_THUMB_MAX_BYTES / 1024)}KB，已改存原圖` : null
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
        // v3.0.0：?variant=thumb 只回縮圖。沒有縮圖（舊海報，或還沒跑 migration）就退回原圖，
        // 呼叫端不必自己判斷有沒有縮圖（回應會用 X-Poster-Variant 標示實際回的是哪一種）。
        const wantsThumb = String(req.query.variant || '') === 'thumb';
        const thumbColsReady = wantsThumb ? await columnExists('competition_posters', 'thumb_data') : false;

        const { data, error } = await supabase
            .from('competition_posters')
            .select(thumbColsReady ? 'mime,data,thumb_mime,thumb_data' : 'mime,data')
            .eq('competition_id', req.params.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.data) return res.status(404).json({ error: '此賽事沒有自訂海報' });

        if (wantsThumb) {
            const thumbBase64 = thumbColsReady ? data.thumb_data : null;
            if (thumbBase64) {
                const thumbBuffer = Buffer.from(thumbBase64, 'base64');
                res.set('Content-Type', data.thumb_mime || 'image/jpeg');
                res.set('Content-Length', String(thumbBuffer.length));
                res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
                res.set('X-Content-Type-Options', 'nosniff');
                res.set('X-Poster-Variant', 'thumb');
                return res.send(thumbBuffer);
            }
            res.set('X-Poster-Variant', 'full-fallback');
        }

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
        // v2.19.0：實際有送出（或嘗試送出）就要留稽核紀錄——只記訂閱 id 與結果，不記 endpoint（隱私）
        await logAudit((req.user && req.user.username) || 'guest', 'SEND_PUSH', data.id, {
            source: 'test', ok: !!result.ok, error: result.ok ? null : String(result.error || '').slice(0, 120)
        }, req.userAgent);
        res.json({ ok: result.ok, message: result.ok ? '測試通知已送出（請看系統通知）' : `送出失敗：${result.error}` });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        await logErrorToDb(req, 'push_test_error', err);
        res.status(500).json({ error: err.message });
    }
});

// 定時推播核心：找出「即將開賽（24 小時內）」與「上次執行後新發布」的賽事，
// 對所有有效訂閱發送，並以 push_log 去重（同一賽事同一類型只送一次）。
async function runPushDigest(now, options) {
    const opts = options || {};
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
        offset: SITE_UTC_OFFSET,
        kinds: opts.kinds
    });

    const result = { candidates: candidates.length, sent: 0, failed: 0, deactivated: 0, subscriptions: subs.length, details: [] };

    for (const candidate of candidates) {
        const payload = pushPayloadFor(candidate, nowDate.getTime());
        let sentCount = 0;
        const errors = [];

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
                if (sent.error) errors.push(sent.error);
            }
        }

        // v2.26.0：改用 logPushEvent（會帶失敗明細與可重送的內容）；沒有欄位時自動退回只記筆數
        await logPushEvent(candidate.competition.id, candidate.kind, sentCount, {
            failed: errors.length, errors, payload, target_user_id: null
        });

        result.sent += sentCount;
        result.details.push({ id: candidate.competition.id, kind: candidate.kind, sent: sentCount, failed: errors.length });
    }

    await setSetting('push_last_run', nowDate.toISOString());
    return result;
}

// Vercel Cron 會以 CRON_SECRET 作為 Bearer 權杖呼叫此端點。
// v2.25.0：vercel.json 設了兩個時段（01:00 與 13:00 UTC＝澳門 09:00 與 21:00），
// 「推播設定」的發送時間落在兩者之間時，由下一次排程補送（一天只發一次）。
// （Vercel 免費方案的 cron 限制是每天一次、最多兩個，所以用兩個固定時段＋補送語意）
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
        // v2.25.0：先看「現在該不該發每日摘要」（時間可設定；一天只發一次；時間過了會補送）
        const pushSettings = await readPushSettings();
        const kinds = digestKindsFromSettings(pushSettings.settings);
        let lastDigestDate = null;
        try {
            lastDigestDate = await getSetting('push_last_digest_date');
        } catch (err) {
            lastDigestDate = null;   // 讀不到就當作今天還沒發（最壞情況是多發一次，不會漏發）
        }
        const gate = shouldRunDigest({
            enabled: pushSettings.settings.digest_enabled,
            scheduledTime: pushSettings.settings.digest_time,
            lastDigestDate,
            nowMs: Date.now(),
            offset: SITE_UTC_OFFSET
        });
        const digestInfo = {
            ran: false,
            reason: gate.reason,
            scheduled: pushSettings.settings.digest_time,
            local_date: gate.date,
            local_time: gate.time,
            kinds
        };

        let result;
        if (!gate.run) {
            result = { sent: 0, subscriptions: 0, candidates: 0, details: [] };
        } else if (kinds.length === 0) {
            digestInfo.reason = '摘要的事件都關掉了（新賽事／開賽提醒）';
            result = { sent: 0, subscriptions: 0, candidates: 0, details: [] };
        } else {
            try {
                result = await runPushDigest(new Date(), { kinds });
                digestInfo.ran = true;
            } catch (digestErr) {
                // 推播這一段失敗（例如憑證或資料表問題）不該讓整個排程回 503：
                // 稽核清理與週期性賽事都還要跑，失敗原因照實回報在 digest.reason
                result = { sent: 0, subscriptions: 0, candidates: 0, details: [], reason: digestErr.message };
                digestInfo.reason = `推播暫時無法發送：${digestErr.message}`;
                await logErrorToDb(req, 'cron_push_digest_error', digestErr).catch(() => {});
            }
            // v2.19.0：批次推播「有真的送出」才留紀錄（sent=0 不留，避免每天一筆空紀錄）
            if (result && result.sent > 0) {
                await logAudit('system', 'SEND_PUSH', null, {
                    source: 'cron', sent: result.sent, subscriptions: result.subscriptions, details: result.details
                }, 'cron');
            }
            // 今天發過了（不論送出去幾則）——一天只發一次，不會因為排程多跑幾次就重複發
            // 記錄失敗不該讓整個排程回 503（設定表可能沒建好）：最壞情況是當天再發一次
            try {
                await setSetting('push_last_digest_date', gate.date);
                digestInfo.marked = true;
            } catch (markErr) {
                digestInfo.marked = false;
                console.warn('⚠️ 無法記錄每日摘要日期（app_settings）：', markErr.message);
            }
        }
        result.digest = digestInfo;
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
        // v2.24.0：每日排程順便看「有沒有哪個系列該開下一場了」（沒設定週期的賽事完全不影響）
        result.recurring = await runRecurringCompetitions();
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
    versionHandler,
    pushSettingsFromRows,
    normalizePushSettingsInput,
    shouldRunDigest,
    pushLocalParts,
    digestKindsFromSettings,
    pushSettingBool,
    APP_VERSION,
    verifyBackupIntegrity,
    backupChecksum,
    resolveBackupTables,
    chunkRows,
    parseResolveIds,
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
    AUDIT_ACTION_LABELS,
    // v2.19.0：賽事狀態機
    competitionState,
    competitionTimeline,
    parseTimestamp,
    COMPETITION_STATE_LABELS,
    COMPETITION_STATE_TONES,
    // v2.9.0
    normalizeTeamFields,
    // v2.19.0：報名視窗
    normalizeRegistrationWindow,
    hasRegistrationWindowContent,
    shouldIncludeRegistrationWindow,
    hasTeamFieldsContent,
    shouldIncludeTeamFields,
    // v2.20.0：報名審核與候補
    normalizeReviewFlags,
    hasReviewFlagsContent,
    registrationReviewSchemaReady,
    registrationSummary,
    decideRegistration: CMCompetitionState.decideRegistration,
    countByStatus: CMCompetitionState.countByStatus,
    nextWaitlist: CMCompetitionState.nextWaitlist,
    promotionStatus: CMCompetitionState.promotionStatus,
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
