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
    next();
});

// 中間件配置：將 CORS 限制僅套用於 /api 路由，避免靜態資源帶有跨域標頭引起安全掃描警報
app.use('/api', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. 初始化 Supabase 雲端資料庫連線
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

if (!hasSupabaseConfig) {
    console.error('❌ 錯誤：未設定 SUPABASE_URL 或 SUPABASE_KEY，請檢查 .env 檔案！');
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
   既有帳號的密碼是明碼儲存（歷史因素），這裡不強制改寫；
   新註冊／新設定的密碼一律用 scrypt 雜湊，登入時兩種格式都能驗證。 */
function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verifyPassword(stored, input) {
    if (typeof stored !== 'string' || stored === '') return false;
    if (!stored.startsWith('scrypt$')) {
        // 舊資料：明碼比對（長度不同時避免 timingSafeEqual 拋錯）
        const a = Buffer.from(stored);
        const b = Buffer.from(String(input));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const expected = Buffer.from(parts[2], 'hex');
    const candidate = crypto.scryptSync(String(input), parts[1], 64);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

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
async function logErrorToDb(req, errorType, err) {
    try {
        if (!hasSupabaseConfig) return;

        const userAgent = req.headers['user-agent'] || '';
        const reqPath = req.originalUrl || req.url || '';
        const userId = req.user ? req.user.sub : null;

        await supabase.from('error_logs').insert([
            {
                user_id: userId,
                error_type: errorType || 'backend_error',
                message: err.message || String(err),
                stack_trace: err.stack || '',
                path: reqPath,
                user_agent: userAgent,
                created_at: new Date().toISOString()
            }
        ]);
    } catch (loggingErr) {
        console.error('❌ 寫入 error_logs 失敗:', loggingErr.message);
    }
}

// 權限角色集合定義
const ADMIN_ROLES = new Set(['admin', 'super_admin', 'web_owner']);
const SUPER_ADMIN_ROLES = new Set(['super_admin', 'web_owner']);

async function findAdminById(id) {
    const { data, error } = await supabase
        .from('admin_users')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) throw error;
    return data;
}

// JWT 身份驗證中間件
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
        return res.status(401).json({ error: '未提供身份驗證令牌，存取被拒' });
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token 無效或已過期，請重新登入' });
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
            res.status(500).json({ error: '權限驗證失敗: ' + err.message });
        }
    };
}

const requireAdmin = [authenticateToken, requireRole([...ADMIN_ROLES])];
const requireSuperAdmin = [authenticateToken, requireRole([...SUPER_ADMIN_ROLES])];

// ==========================================
// 錯誤日誌 API
// ==========================================
app.post('/api/logs/error', async (req, res) => {
    try {
        const { error_type, message, stack_trace, path: errPath, screenshot } = req.body;
        const userAgent = req.headers['user-agent'] || '';

        let finalStackTrace = stack_trace || '';
        if (screenshot) {
            finalStackTrace += `\n\n[Screenshot Attached (Base64 Truncated)]: ${screenshot.substring(0, 100)}...`;
        }

        const logPayload = {
            user_id: null,
            error_type: error_type || 'frontend_error',
            message: message || 'Unknown client error',
            stack_trace: finalStackTrace,
            path: errPath || '',
            user_agent: userAgent
        };

        if (screenshot) {
            logPayload.screenshot = screenshot;
        }

        const { error } = await supabase.from('error_logs').insert([logPayload]);

        if (error) throw error;
        res.json({ success: true, message: 'Bug report saved successfully' });
    } catch (err) {
        console.error('[Error Log API Failed]:', err.message);
        res.status(500).json({ error: 'Failed to record error log' });
    }
});

app.get('/api/admin/error-logs', requireSuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('error_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;
        res.json({ success: true, logs: data });
    } catch (err) {
        await logErrorToDb(req, 'fetch_error_logs_error', err);
        console.error('[Fetch Error Logs Failed]:', err.message);
        res.status(500).json({ error: 'Failed to fetch error logs' });
    }
});

// ==========================================
// 審計日誌 API
// ==========================================
app.get('/api/audit-logs', requireSuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('audit_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        await logErrorToDb(req, 'fetch_audit_logs_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 管理員帳號維護 API
// ==========================================
app.get('/api/admin/users', requireSuperAdmin, async (req, res) => {
    try {
        const { data: admins, error } = await supabase
            .from('admin_users')
            .select('id, username, role, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(admins || []);
    } catch (err) {
        await logErrorToDb(req, 'fetch_admin_users_error', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', requireSuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const operator = req.currentUser;

    if (!username || !password) {
        return res.status(400).json({ error: '帳號與密碼為必填欄位' });
    }

    let targetRole = role || 'admin';
    if (operator.role === 'super_admin') {
        if (targetRole !== 'admin') {
            return res.status(403).json({ error: '權限不足：超級管理員只能新增普通管理員 (admin)' });
        }
    } else if (operator.role !== 'web_owner') {
        return res.status(403).json({ error: '權限不足' });
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

        const { data, error } = await supabase
            .from('admin_users')
            .insert([{ username, password: hashPassword(password), role: targetRole }])
            .select();

        if (error) throw error;

        await logAudit(operator.username, 'CREATE_ADMIN', data[0].id, `新增管理員帳號: ${username} (角色: ${targetRole})`, req.userAgent);

        res.json({ message: '管理員新增成功', id: data[0].id });
    } catch (err) {
        await logErrorToDb(req, 'create_admin_error', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/users/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        let query = supabase.from('admin_users').select('id, username, role');
        if (!isNaN(id)) {
            query = query.or(`id.eq.${id},username.eq.${id}`);
        } else {
            query = query.eq('username', id);
        }

        const { data: targetUser, error: findErr } = await query.single();
        if (findErr || !targetUser) {
            return res.status(404).json({ error: '找不到該管理員帳號' });
        }

        if (targetUser.username === operator.username || targetUser.id === operator.id) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        if (targetUser.role === 'web_owner') {
            return res.status(403).json({ error: '保護機制：無法刪除 Web Owner 帳號' });
        }

        if (operator.role === 'super_admin') {
            if (targetUser.role === 'super_admin' || targetUser.role === 'web_owner') {
                return res.status(403).json({ error: '權限不足：超級管理員不可刪除同級或高級別帳號' });
            }
        }

        const { error: delErr } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', targetUser.id);

        if (delErr) throw delErr;

        await logAudit(operator.username, 'DELETE_ADMIN', targetUser.id, `刪除帳號: ${targetUser.username} (${targetUser.role})`, req.userAgent);

        res.json({ message: '帳號刪除成功' });
    } catch (err) {
        await logErrorToDb(req, 'delete_admin_error', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 身份驗證 API (登入與修改密碼)
// ==========================================
const loginHandler = async (req, res) => {
    const { username, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        const { data: user, error } = await supabase
            .from('admin_users')
            .select('*')
            .eq('username', username)
            .maybeSingle();

        if (error || !user || !verifyPassword(user.password, password)) {
            await logAudit(username || 'UNKNOWN', 'LOGIN_FAILED', null, {
                reason: '帳號或密碼錯誤',
                ip: clientIp
            }, req.userAgent);

            return res.status(401).json({ error: '帳號或密碼錯誤' });
        }

        const token = jwt.sign(
            { sub: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        await logAudit(user.username, 'LOGIN_SUCCESS', user.id, { ip: clientIp }, req.userAgent);

        res.json({
            message: '登入成功',
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        await logErrorToDb(req, 'login_error', err);
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: '缺少訂閱識別（endpoint）' });
    try {
        const { error } = await supabase.from('push_subscriptions').update({ is_active: false }).eq('endpoint', endpoint);
        if (error) throw error;
        res.json({ message: '已關閉此裝置的推播訂閱' });
    } catch (err) {
        if (isMissingTableError(err)) return res.status(503).json({ error: PUSH_HINT });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/push/test', async (req, res) => {
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

app.get('/api/cron/reminders', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
        const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (provided !== secret) return res.status(401).json({ error: '未授權' });
    } else if (Date.now() - lastCronRun < 10 * 60 * 1000) {
        return res.status(429).json({ error: '呼叫過於頻繁（未設定 CRON_SECRET 時每 10 分鐘一次）' });
    }
    lastCronRun = Date.now();

    try {
        const result = await runPushDigest(new Date());
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
    allowRegisterAttempt,
    USERNAME_RE,
    PASSWORD_RE
};
