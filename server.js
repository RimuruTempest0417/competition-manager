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
/* v3.4.0（P4 拆模組）：跨檔案共用的可變狀態。
 * 這些原本是 server.js 裡的獨立變數；拆模組後 server.js 的函式與 routes/*.js 的路由都必須讀寫
 * **同一格**（否則會各自拿到啟動當下的快照：探測快取不共享、設定讀不到最新值），所以集中在這個物件。
 * 它宣告在 server.js 內 → 重新 require server.js（測試會清快取）就等同重置，與原本行為一致。 */
const serverState = {
    taxonomy: null, teamFields: null, registrationWindow: null,
    recurrence: null, tfa: null, waitlistNotify: null,
    registrationReview: null, waitlistOrder: null,
    webpush: null, vapid: null,
    opsStatsCache: { at: 0, days: 0, payload: null },
    lastCronRun: 0
};


async function taxonomySchemaReady() {
    if (serverState.taxonomy !== null) return serverState.taxonomy;

    try {
        const { error } = await supabase.from('competitions').select('id,category,tags').limit(1);
        serverState.taxonomy = !isMissingColumnError(error);
        if (!serverState.taxonomy) {
            console.warn('⚠️ competitions 表缺少 category / tags 欄位，分類與標籤將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        // 探測本身失敗（例如網路問題）不阻擋請求，交由實際寫入結果決定
        return true;
    }
    return serverState.taxonomy;
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

async function teamSchemaReady() {
    if (serverState.teamFields !== null) return serverState.teamFields;

    try {
        const { error } = await supabase
            .from('competitions')
            .select('id,is_team_event,team_size,registration_deadline,max_registrations')
            .limit(1);
        serverState.teamFields = !isMissingColumnError(error, ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations']);
        if (!serverState.teamFields) {
            console.warn('⚠️ competitions 表缺少組隊／報名欄位，組隊比賽與報名截止將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        return true;
    }
    return serverState.teamFields;
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

async function registrationWindowSchemaReady() {
    if (serverState.registrationWindow !== null) return serverState.registrationWindow;
    try {
        const { error } = await supabase
            .from('competitions')
            .select('id,registration_start_at,registration_end_at')
            .limit(1);
        serverState.registrationWindow = !isMissingColumnError(error, ['registration_start_at', 'registration_end_at']);
        if (!serverState.registrationWindow) {
            console.warn('⚠️ competitions 表缺少報名開始／截止欄位，報名時間將無法儲存（請執行 migrations/ 內的 SQL）');
        }
    } catch (e) {
        return true;
    }
    return serverState.registrationWindow;
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

/* ---------- v3.4.0：拆模組後需要的共用常數與狀態 ----------
 * 這些原本定義在各自區段（位置在模組掛載點之後），為了讓 routes/*.js 在掛載當下取得
 * 相同的值（並避免 TDZ），統一搬到所有路由之前。都是純初始化，沒有位置相依副作用。
 */
const AUDIT_SEARCH_WINDOW = 1000;
const RECURRENCE_HINT =
    '資料庫尚未執行 v2.24.0 migration（migrations/2026-09-26-v2.24.0-recurrence.sql）：' +
    '週期性賽事需要 competitions.recurrence／recurrence_until／recurrence_parent_id 欄位（未執行時仍可手動複製賽事）。';
const RECURRENCE_RULE_LABELS = { weekly: '每週', biweekly: '每兩週', monthly: '每月' };
const COMPETITIONS_PAGE_MAX = 100;
const REGISTRATIONS_PAGE_MAX = 200;
const PUSH_HINT = '資料庫尚未加入推播資料表（app_settings / push_subscriptions / push_log），請先執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
// v2.26.0：推播失敗明細與重送需要的欄位
const PUSH_LOG_DETAIL_HINT = '推播失敗明細與重送需要資料庫欄位，請先執行 migrations/2026-09-26-v2.26.0-push-log-detail.sql';
const pushLogDetailSchemaReady = createSchemaProbe(async () => {
    const hasFailed = await columnExists('push_log', 'failed_count');
    if (!hasFailed) return false;
    return columnExists('push_log', 'payload');
});
// 站台時區偏移：用於判斷「開賽前 24 小時」。可用 SITE_UTC_OFFSET 覆寫（例如 +08:00）。
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

/* ---------- 錯誤日誌與系統日誌 API：v3.4.0 起移到 routes/error-logs.js ---------- */
require('./routes/error-logs')(app, { ERROR_LOG_FAILURES, ERROR_LOG_RESOLVE_ALL_MAX, GENERIC_DB_ERROR, PUSH_HINT, PUSH_LOG_DETAIL_HINT, USER_MIGRATION_HINT, allowPublicWrite, columnExists, errorLogAlertSummary, hasSupabaseConfig, isMissingTableError, logAudit, logErrorToDb, parseResolveIds, pushLogDetailSchemaReady, requireAdmin, requireSuperAdmin, supabase, supabaseKeyType });


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
/* ---------- 公告中心與推播紀錄：v3.4.0 起移到 routes/announcements.js ---------- */
require('./routes/announcements')(app, { ANNOUNCEMENTS_HINT, ANNOUNCEMENT_LIST_MAX, CATEGORY_IDS, COMPETITION_CATEGORIES, GENERIC_DB_ERROR, PUSH_HINT, PUSH_LOG_DETAIL_HINT, announceCategoriesReady, announcementsSchemaReady, authenticateToken, categoryChips, countActiveUsers, isAdminRoleName, isMissingColumnError, isMissingTableError, logAudit, logErrorToDb, myAnnounceCategories, myAnnouncementReadIds, pushAnnouncement, pushLogDetailSchemaReady, requireAdmin, sendPushTo, supabase });


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
/* ---------- 場地與工作人員：v3.4.0 起移到 routes/venue-staff.js ---------- */
require('./routes/venue-staff')(app, { AUDIT_SEARCH_WINDOW, GENERIC_DB_ERROR, VENUE_STAFF_HINT, isMissingTableError, loadCompetitionStaff, logAudit, logErrorToDb, requireAdmin, staffSchemaReady, supabase });

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
    // v3.3.0（P1-6）：賽事規程 PDF 附件
    UPLOAD_DOC: '上傳賽事規程',
    DELETE_DOC: '移除賽事規程',
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

/* ---------- 稽核日誌：v3.4.0 起移到 routes/audit-logs.js ---------- */
require('./routes/audit-logs')(app, { AUDIT_ACTION_LABELS, AUDIT_EXPORT_MAX, AUDIT_MIN_RETENTION_DAYS, AUDIT_SEARCH_WINDOW, GENERIC_DB_ERROR, auditActionLabel, auditLogsToCsvRows, auditMatchesQuery, logAudit, logErrorToDb, parseAuditFilters, requireSuperAdmin, supabase });

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
/* ---------- 資料備份與還原：v3.4.0 起移到 routes/backup.js ---------- */
require('./routes/backup')(app, { BACKUP_MAX_ROWS_PER_TABLE, GENERIC_DB_ERROR, RESTORE_CONFLICT_KEYS, backupChecksum, chunkRows, countBackupRows, isMissingTableError, logAudit, logErrorToDb, requireSuperAdmin, resolveBackupTables, supabase, verifyBackupIntegrity });



/* ---------- 管理員帳號維護：v3.4.0 起移到 routes/admin-users.js ---------- */
require('./routes/admin-users')(app, { GENERIC_DB_ERROR, MANAGED_ROLES, PASSWORD_RE, ROLE_LABELS, USERNAME_RE, USER_MIGRATION_HINT, assertRoleAssignable, canCreateRole, canManageUser, columnExists, countWebOwners, findUserByKey, logAudit, logErrorToDb, requireAdmin, roleLevel, supabase });

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


const TFA_MIGRATION_HINT = '兩步驟驗證需要先執行 migrations/2026-09-26-v2.15.0-admin-2fa.sql（Supabase SQL Editor 貼上執行一次，可重複執行）';
const TFA_RECOVERY_CODE_COUNT = 8;

async function twoFactorSchemaReady() {
    if (serverState.tfa !== null) return serverState.tfa;
    serverState.tfa = true;
    for (const col of ['totp_secret', 'totp_enabled', 'totp_confirmed_at', 'totp_recovery_codes', 'totp_last_step']) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await columnExists('admin_users', col))) { serverState.tfa = false; break; }
    }
    return serverState.tfa;
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
/* ---------- 登入、密碼與兩步驟驗證：v3.4.0 起移到 routes/auth.js ---------- */
require('./routes/auth')(app, { GENERIC_DB_ERROR, JWT_SECRET, LOGIN_ACCOUNT_MAX_FAILURES, LOGIN_ACCOUNT_MIN_IPS, SUPER_ADMIN_ROLES, TFA_MIGRATION_HINT, TFA_RECOVERY_CODE_COUNT, authenticateToken, canManageUser, clearLoginFailures, columnExists, errorLogAlertSummary, findUserByKey, logAudit, logErrorToDb, loginHandler, loginLockRemaining, recordLoginFailure, requireAdmin, supabase, twoFactorSchemaReady, unusedRecoveryCodes, verifySecondFactor });

const OPS_STATS_TTL_MS = 60 * 1000;
const OPS_STATS_TREND_DAYS = 14;
const OPS_STATS_MAX_TREND_DAYS = 30;

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
/* ---------- 成績與結果：v3.4.0 起移到 routes/results.js ---------- */
require('./routes/results')(app, { ADMIN_ROLES, RESULTS_HINT, authenticateToken, decorateResult, fetchCompetition, isMissingTableError, loadApprovedRegistrations, loadResultRows, logAudit, logErrorToDb, logPushEvent, notifyUser, optionalAuth, requireAdmin, resultSchemaReady, supabase });


/* ---------- 營運儀表板與前端設定：v3.4.0 起移到 routes/stats.js ---------- */
require('./routes/stats')(app, { COMPETITIONS_PAGE_MAX, COMPETITION_CATEGORIES, MAX_TAGS, MAX_TAG_LENGTH, OPS_INDEXES, OPS_STATS_MAX_TREND_DAYS, OPS_STATS_TREND_DAYS, OPS_STATS_TTL_MS, REGISTRATIONS_PAGE_MAX, columnExists, competitionState, isMissingTableError, registrationReviewSchemaReady, requireAdmin, serverState, supabase, tableExists });

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

/* ---------- 賽事 CRUD、複製與週期性：v3.4.0 起移到 routes/competitions.js ---------- */
require('./routes/competitions')(app, { COMPETITIONS_PAGE_MAX, MIGRATION_HINT, RECURRENCE_HINT, RECURRENCE_RULE_LABELS, TEAM_HINT, buildDuplicatePayload, columnExists, competitionState, copySchemaReady, createNextOccurrence, getTrashCompetitionsHandler, hasRegistrationWindowContent, hasReviewFlagsContent, hasTaxonomyContent, hasTeamFieldsContent, isMissingColumnError, logAudit, logErrorToDb, mapUrlSchemaReady, normalizeCategory, normalizeRecurrenceRule, normalizeRegistrationWindow, normalizeReviewFlags, normalizeTags, normalizeTeamFields, recurrenceSchemaReady, registrationReviewSchemaReady, registrationWindowSchemaReady, requireAdmin, requireSuperAdmin, sanitizeInput, serverState, shouldIncludeRegistrationWindow, shouldIncludeTaxonomy, shouldIncludeTeamFields, supabase, taxonomySchemaReady, teamSchemaReady });


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


async function waitlistNotifySchemaReady() {
    if (serverState.waitlistNotify !== null) return serverState.waitlistNotify;
    serverState.waitlistNotify = await columnExists('competitions', 'waitlist_notify');
    if (!serverState.waitlistNotify) {
        console.warn('⚠️ 尚未執行 v2.22.0 migration：遞補通知開關停用（一律通知）');
    }
    return serverState.waitlistNotify;
}

/* ── v2.24.0：複製賽事與週期性賽事 ──────────────────────────────
   規則本身在 public/js/competition-state.js（前後端共用同一份），
   這裡只負責：探測欄位、組出複製用的 payload、把「下一場」寫進資料庫。 */




async function recurrenceSchemaReady() {
    if (serverState.recurrence !== null) return serverState.recurrence;
    serverState.recurrence = await columnExists('competitions', 'recurrence');
    if (!serverState.recurrence) {
        console.warn('⚠️ 尚未執行 v2.24.0 migration：週期性賽事自動建立停用（手動複製不受影響）');
    }
    return serverState.recurrence;
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
            serverState.recurrence = false;
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


/* v2.21.0：候補順位手動調整只多一個欄位（registrations.waitlist_order）。
   欄位不存在時：調整順序的端點回 503 ＋ 指引，候補順位自動退回「先報名先排」（舊行為），
   指定遞補照常可用（它不需要這個欄位）。探測結果同樣有行程內快取。 */
const WAITLIST_ORDER_HINT =
    '資料庫尚未執行 v2.21.0 migration（migrations/2026-09-26-v2.21.0-waitlist-order.sql）：' +
    '調整候補順位需要 registrations.waitlist_order 欄位（未執行時順位一律依報名時間排序）。';


async function waitlistOrderSchemaReady() {
    if (serverState.waitlistOrder !== null) return serverState.waitlistOrder;
    serverState.waitlistOrder = await columnExists('registrations', 'waitlist_order');
    if (!serverState.waitlistOrder) {
        console.warn('⚠️ 尚未執行 v2.21.0 migration：候補順位手動調整停用（順位依報名時間排序）');
    }
    return serverState.waitlistOrder;
}

/* 審核／候補功能是否可用（欄位探測結果有行程內快取，同一個行程內不會中途翻轉） */
async function registrationReviewSchemaReady() {
    if (serverState.registrationReview !== null) return serverState.registrationReview;
    const [approval, waitlist] = await Promise.all([
        columnExists('competitions', 'requires_approval'),
        columnExists('competitions', 'waitlist_enabled')
    ]);
    serverState.registrationReview = !!(approval && waitlist);
    if (!serverState.registrationReview) {
        console.warn('⚠️ 尚未執行 v2.20.0 migration：報名審核與候補功能停用（報名一律直接核准）');
    }
    return serverState.registrationReview;
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

/* ---------- 報名、審核、候補與帳號：v3.4.0 起移到 routes/registrations.js ---------- */
require('./routes/registrations')(app, { ADMIN_ROLES, GENERIC_DB_ERROR, JWT_SECRET, PASSWORD_RE, REGISTRATIONS_PAGE_MAX, REGISTRATION_HINT, REGISTRATION_REVIEW_HINT, USERNAME_RE, WAITLIST_HISTORY_MAX_WINDOW, WAITLIST_NOTIFY_HINT, WAITLIST_ORDER_HINT, allowRegisterAttempt, auditActionLabel, authenticateToken, cleanText, competitionState, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, logPushEvent, notifyOnPromote, notifyUser, registrationReviewSchemaReady, registrationSummary, requireAdmin, requireSuperAdmin, staffSchemaReady, supabase, waitlistNotifySchemaReady, waitlistOrderSchemaReady });

/* ---------- 隊伍與隊員編排：v3.4.0 起移到 routes/teams.js ---------- */
require('./routes/teams')(app, { ADMIN_ROLES, REGISTRATION_HINT, SUPER_ADMIN_ROLES, authenticateToken, cleanText, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, notifyOnPromote, registrationReviewSchemaReady, requireAdmin, requireSuperAdmin, supabase, waitlistNotifySchemaReady, waitlistOrderSchemaReady });

const POSTER_THUMB_MAX_BYTES = 250 * 1024;   // 縮圖上限（前端產生的通常 20–60KB）

const POSTER_MAX_BYTES = 3 * 1024 * 1024;             // 3MB（前端會先縮圖，通常僅數百 KB）
const POSTER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const POSTER_HINT = '資料庫尚未加入海報欄位，請先在 Supabase SQL Editor 執行 migrations/2026-09-24-v2.10.0-poster-and-push.sql';
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

/* ---------- 版本與更新紀錄：v3.4.0 起移到 routes/version.js ---------- */
require('./routes/version')(app, { versionHandler });


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

/* ---------- 推播設定：v3.4.0 起移到 routes/push-settings.js ---------- */
require('./routes/push-settings')(app, { PUSH_SETTINGS_DEFAULTS, PUSH_SETTINGS_HINT, PUSH_SETTING_LABELS, formatPushSettingValue, logAudit, logErrorToDb, normalizePushSettingsInput, readPushSettings, requireAdmin, writePushSettings });



/* ---------- 賽事海報：v3.4.0 起移到 routes/posters.js ---------- */
require('./routes/posters')(app, { POSTER_HINT, POSTER_MAX_BYTES, POSTER_THUMB_MAX_BYTES, columnExists, fetchCompetition, isMissingColumnError, isMissingTableError, logAudit, logErrorToDb, parseImageDataUrl, requireAdmin, supabase });

const DOC_MAX_BYTES = 3 * 1024 * 1024;
const DOC_LABEL_MAX = 60;
const DOC_HINT = '資料庫尚未加入規程附件資料表，請先在 Supabase SQL Editor 執行 migrations/2026-09-26-v3.3.0-docs.sql';

/* 解析上傳的規程檔：接受 data:application/pdf;base64,... 或純 base64。
   一定要真的是 PDF——只看 MIME 或副檔名不夠（改個檔名就能騙過）。 */
function parsePdfDataUrl(input) {
    if (typeof input !== 'string' || !input.trim()) return null;
    let raw = input.trim();
    let mime = 'application/pdf';
    const m = /^data:([^;,]*)(;base64)?,/.exec(raw);
    if (m) {
        mime = (m[1] || 'application/pdf').toLowerCase();
        if (!m[2]) return null;                 // 只收 base64（前端 FileReader 給的就是這個）
        raw = raw.slice(m[0].length);
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
    const buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    if (!buffer || buffer.length < 8) return null;
    if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') return null;
    if (!['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(mime)) return null;
    return { mime: 'application/pdf', buffer };
}

/* 檔名要放進標頭，只留安全字元（中文用 RFC 5987 編碼帶出去） */
function docFileName(label, id) {
    const base = String(label || '賽事規程').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, DOC_LABEL_MAX).trim() || '賽事規程';
    return { plain: `doc-${id}.pdf`, utf8: `${encodeURIComponent(base)}.pdf`, label: base };
}

// 取得規程（公開）：預設 inline（瀏覽器直接開 PDF 檢視器），?download=1 則下載
/* ---------- 賽事規程 PDF 附件：v3.4.0 起移到 routes/docs.js ---------- */
require('./routes/docs')(app, { DOC_HINT, DOC_LABEL_MAX, DOC_MAX_BYTES, docFileName, fetchCompetition, isMissingTableError, logAudit, logErrorToDb, parsePdfDataUrl, requireAdmin, supabase });

try {
    serverState.webpush = require('web-push');
} catch (e) {
    console.warn('⚠️ 未安裝 web-push，推播功能停用（npm install web-push 即可啟用）');
}


async function getVapidKeys() {
    if (serverState.vapid) return serverState.vapid;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        serverState.vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
        return serverState.vapid;
    }
    if (!serverState.webpush) return null;

    try {
        const stored = await getSetting('push_vapid_keys');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && parsed.publicKey && parsed.privateKey) {
                serverState.vapid = parsed;
                return serverState.vapid;
            }
        }
        const generated = serverState.webpush.generateVAPIDKeys();
        await setSetting('push_vapid_keys', JSON.stringify(generated));
        // 競態：若同時有另一個實例寫入，以資料庫內容為準
        const after = await getSetting('push_vapid_keys');
        serverState.vapid = after ? JSON.parse(after) : generated;
        return serverState.vapid;
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
    if (!serverState.webpush || !keys) return { ok: false, error: '伺服器未啟用推播' };
    serverState.webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
    try {
        await serverState.webpush.sendNotification(
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




/* ---------- 推播訂閱（Web Push）：v3.4.0 起移到 routes/push.js ---------- */
require('./routes/push')(app, { PUSH_HINT, allowPublicWrite, getVapidKeys, isMissingTableError, logAudit, logErrorToDb, optionalAuth, sendPushTo, serverState, supabase });

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

/* ---------- 排程提醒（cron）：v3.4.0 起移到 routes/cron.js ---------- */
require('./routes/cron')(app, { AUDIT_MIN_RETENTION_DAYS, SITE_UTC_OFFSET, cronAuthorization, digestKindsFromSettings, getSetting, isMissingTableError, isProduction, logAudit, logErrorToDb, readPushSettings, runPushDigest, runRecurringCompetitions, serverState, setSetting, shouldRunDigest, supabase });


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
/* ---------- 賽事匯出／匯入 CSV：v3.4.0 起移到 routes/competitions-csv.js ---------- */
require('./routes/competitions-csv')(app, { COMPETITION_CATEGORIES, MAX_TAGS, MAX_TAG_LENGTH, MIGRATION_HINT, isMissingColumnError, logAudit, logErrorToDb, normalizeCategory, normalizeTags, planImport, requireAdmin, serverState, supabase, taxonomySchemaReady });

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
