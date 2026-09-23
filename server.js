require('dotenv').config();
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

function isMissingColumnError(err) {
    const code = (err && err.code) || '';
    const msg = (err && err.message) || '';
    return (
        code === 'PGRST204' ||
        code === '42703' ||
        /column .*\.(category|tags).* does not exist/i.test(msg) ||
        /Could not find the '(category|tags)' column/i.test(msg)
    );
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
            .insert([{ username, password, role: targetRole }])
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

        if (error || !user || user.password !== password) {
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

        if (findErr || !user || user.password !== oldPassword) {
            return res.status(400).json({ error: '舊密碼不正確' });
        }

        const { error: updateErr } = await supabase
            .from('admin_users')
            .update({ password: newPassword })
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
        if (isMissingColumnError(err)) {
            schemaHasTaxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
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
            ...(includeTaxonomy ? taxonomy : {})
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
        if (isMissingColumnError(err)) {
            schemaHasTaxonomy = false;
            return res.status(503).json({ error: MIGRATION_HINT });
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
    planImport
};
