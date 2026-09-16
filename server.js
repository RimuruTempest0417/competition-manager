require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

// 中間件配置
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. 初始化 Supabase 雲端資料庫連線
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ 錯誤：未設定 SUPABASE_URL 或 SUPABASE_KEY，請檢查 .env 檔案！');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 全域中間件：解析 Header 中的 User ID 與 Role
app.use((req, res, next) => {
    const rawUserId = req.headers['x-user-id'];
    req.userId = rawUserId ? decodeURIComponent(rawUserId) : 'Guest';
    req.userAgent = req.headers['user-agent'] || ''; // 擷取 User-Agent
    next();
});

// Helper: 處理空字串，將未填寫的選填欄位轉為 null
function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    return str === '' ? null : str;
}

// 📜 統一 Supabase 審計日誌 (audit_logs 表格) 寫入輔助函式
async function logAudit(userId, action, targetId = null, details = null, userAgent = '') {
    try {
        const payload = {
            user_id: userId || 'unknown_user',
            action: action,
            target_id: targetId,
            details: typeof details === 'object' ? JSON.stringify(details) : details,
            user_agent: userAgent, // 修正：使用區域傳入的 userAgent 變數
            created_at: new Date().toISOString()
        };

        const { error } = await supabase.from('audit_logs').insert([payload]);
        if (error) console.error('❌ Supabase Log 寫入失敗:', error.message);
    } catch (err) {
        console.error('❌ Log 系統例外錯誤:', err.message);
    }
}

// 權限階層定義
const ROLE_LEVELS = {
    web_owner: 3,
    super_admin: 2,
    admin: 1,
    guest: 0
};

// 中間件：要求至少為 Super Admin (super_admin 或 web_owner)
async function requireSuperAdmin(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: '未提供使用者識別碼' });

    try {
        let query = supabase.from('admin_users').select('*');
        if (!isNaN(userId)) {
            query = query.or(`id.eq.${userId},username.eq.${userId}`);
        } else {
            query = query.eq('username', userId);
        }

        const { data: user, error } = await query.single();
        if (error || !user || ROLE_LEVELS[user.role] < ROLE_LEVELS.super_admin) {
            return res.status(403).json({ error: '權限不足，需要超級管理員以上權限' });
        }

        req.currentUser = user;
        next();
    } catch (err) {
        res.status(500).json({ error: '權限驗證失敗: ' + err.message });
    }
}

// ==========================================
// 1. 前端主動上報 Error / Bug API (支援截圖上傳)
// ==========================================
app.post('/api/logs/error', async (req, res) => {
    try {
        const { error_type, message, stack_trace, path, screenshot } = req.body;
        const rawUserId = req.headers['x-user-id'];
        const userAgent = req.headers['user-agent'] || '';

        // 若無 numeric ID 或是手動回報，保留 rawUserId 或轉為 null 保持安全寫入
        const isNumeric = /^\d+$/.test(rawUserId);
        const userId = isNumeric ? parseInt(rawUserId, 10) : null;

        let finalStackTrace = stack_trace || '';
        if (screenshot) {
            finalStackTrace += `\n\n[Screenshot Attached (Base64 Truncated)]: ${screenshot.substring(0, 100)}...`;
        }

        const logPayload = {
            user_id: userId,
            error_type: error_type || 'frontend_error',
            message: message || 'Unknown client error',
            stack_trace: finalStackTrace,
            path: path || '',
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

// ==========================================
// 2. 超級管理員專用：讀取 Error Logs API
// ==========================================
app.get('/api/admin/error-logs', async (req, res) => {
    try {
        // RBAC 權限檢查：驗證 Request Headers 的使用者角色
        const userRole = req.headers['x-user-role'];
        if (userRole !== 'super_admin' && userRole !== 'web_owner') {
            return res.status(403).json({ error: 'Access denied: Super Admin or Web Owner only' });
        }

        const { data, error } = await supabase
            .from('error_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;
        res.json({ success: true, logs: data });
    } catch (err) {
        console.error('[Fetch Error Logs Failed]:', err.message);
        res.status(500).json({ error: 'Failed to fetch error logs' });
    }
});

// ----------------------------------------------------
// 管理員 API
// ----------------------------------------------------

// 1. 取得所有管理員清單
app.get('/api/admin/users', requireSuperAdmin, async (req, res) => {
    try {
        const { data: admins, error } = await supabase
            .from('admin_users')
            .select('id, username, role, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(admins || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 新增管理員帳號
app.post('/api/admin/users', requireSuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const operator = req.currentUser;

    if (!username || !password) {
        return res.status(400).json({ error: '帳號與密碼為必填欄位' });
    }

    // 🔒 權限防護：super_admin 只能新增普通 admin
    let targetRole = role || 'admin';
    if (operator.role === 'super_admin') {
        if (targetRole !== 'admin') {
            return res.status(403).json({ error: '權限不足：超級管理員只能新增普通管理員 (admin)' });
        }
    } else if (operator.role !== 'web_owner') {
        return res.status(403).json({ error: '權限不足' });
    }

    try {
        // 檢查帳號是否已存在
        const { data: existingUser } = await supabase
            .from('admin_users')
            .select('id')
            .eq('username', username)
            .single();

        if (existingUser) {
            return res.status(400).json({ error: '此帳號名稱已存在' });
        }

        const { data, error } = await supabase
            .from('admin_users')
            .insert([{ username, password, role: targetRole }])
            .select();

        if (error) throw error;

        // 寫入操作日誌
        await logAudit(operator.username, 'CREATE_ADMIN', data[0].id, `新增管理員帳號: ${username} (角色: ${targetRole})`, req.userAgent);

        res.json({ message: '管理員新增成功', id: data[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 刪除管理員帳號
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

        // 防呆 1：無法刪除自己
        if (targetUser.username === operator.username || targetUser.id === operator.id) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        // 防呆 2：Web Owner 絕對不可被刪除
        if (targetUser.role === 'web_owner') {
            return res.status(403).json({ error: '保護機制：無法刪除 Web Owner 帳號' });
        }

        // 防呆 3：super_admin 不能刪除其他 super_admin，只能刪除普通 admin
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

        // 寫入操作日誌
        await logAudit(operator.username, 'DELETE_ADMIN', targetUser.id, `刪除帳號: ${targetUser.username} (${targetUser.role})`, req.userAgent);

        res.json({ message: '帳號刪除成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔐 管理員登入驗證 API
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const { data: user, error } = await supabase
        .from('admin_users')
        .select('*')
        .eq('username', username)
        .single();

    if (error || !user || user.password !== password) {
        await logAudit(username || 'UNKNOWN', 'LOGIN_FAILED', null, {
            reason: '帳號或密碼錯誤',
            ip: clientIp
        }, req.userAgent);

        return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    await logAudit(user.username, 'LOGIN_SUCCESS', null, {
        role: user.role,
        ip: clientIp
    }, req.userAgent);

    res.json({
        message: '登入成功',
        user: { id: user.id, username: user.username, role: user.role }
    });
});

// ----------------------------------------------------
// 比賽賽事 API
// ----------------------------------------------------

// 📋 取得所有未刪除比賽
app.get('/api/competitions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competitions')
            .select('*')
            .eq('is_deleted', false)
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error('❌ 讀取比賽失敗:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 🗑️ 讀取回收桶列表 API (開放 super_admin, web_owner 與 admin 讀取)
app.get('/api/competitions/deleted', async (req, res) => {
    try {
        const userRole = req.headers['x-user-role'];
        if (userRole !== 'web_owner' && userRole !== 'super_admin' && userRole !== 'admin') {
            return res.status(403).json({ error: 'Access denied: Admin access required' });
        }

        const { data, error } = await supabase
            .from('competitions')
            .select('*')
            .eq('is_deleted', true)
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 別名相容：/api/competitions/trash (提供 RESTful 風格端點)
app.get('/api/competitions/trash', async (req, res) => {
    req.url = '/api/competitions/deleted';
    app._router.handle(req, res);
});

// ➕ 發佈新比賽
app.post('/api/competitions', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.userId || 'Unknown';
    const { name, location, date, time, end_date, end_time, description, is_registration_open } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    try {
        const { data, error } = await supabase
            .from('competitions')
            .insert([
                {
                    name: name.trim(),
                    location: sanitizeInput(location),
                    date: sanitizeInput(date),
                    time: sanitizeInput(time),
                    end_date: sanitizeInput(end_date),
                    end_time: sanitizeInput(end_time),
                    description: sanitizeInput(description),
                    is_registration_open: !!is_registration_open,
                    is_deleted: false
                }
            ])
            .select();

        if (error) throw error;

        const newCompetition = data[0];
        await logAudit(userId, 'CREATE_COMPETITION', newCompetition.id, { name, date, end_date }, req.userAgent);

        res.status(201).json({ id: newCompetition.id, message: '賽事發佈成功' });
    } catch (err) {
        console.error('❌ 新增比賽失敗:', err.message);
        res.status(500).json({ error: 'Supabase 資料庫寫入失敗: ' + err.message });
    }
});

// ✏️ 修改比賽
app.put('/api/competitions/:id', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.userId || 'Unknown';
    const { id } = req.params;
    const { name, location, date, time, end_date, end_time, description, is_registration_open } = req.body;

    try {
        const { error } = await supabase
            .from('competitions')
            .update({
                name: name.trim(),
                location: sanitizeInput(location),
                date: sanitizeInput(date),
                time: sanitizeInput(time),
                end_date: sanitizeInput(end_date),
                end_time: sanitizeInput(end_time),
                description: sanitizeInput(description),
                is_registration_open: !!is_registration_open
            })
            .eq('id', id);

        if (error) throw error;

        await logAudit(userId, 'UPDATE_COMPETITION', id, { name, date, end_date }, req.userAgent);
        res.json({ message: '更新成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 刪除比賽 (軟刪除)
app.delete('/api/competitions/:id', async (req, res) => {
    const { id } = req.params;
    const operator = req.headers['x-user-id'] || req.userId || 'Unknown';

    try {
        const { data: competition, error: findErr } = await supabase
            .from('competitions')
            .select('name')
            .eq('id', id)
            .single();

        if (findErr || !competition) {
            return res.status(404).json({ error: '找不到該筆比賽資料' });
        }

        const { error: updateErr } = await supabase
            .from('competitions')
            .update({ is_deleted: true })
            .eq('id', id);

        if (updateErr) throw updateErr;

        await logAudit(operator, 'DELETE_COMPETITION', id, `刪除比賽: ${competition.name} (ID: ${id})`, req.userAgent);

        res.json({ message: '比賽已移至回收桶' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 從回收桶復原比賽 (允許 super_admin, web_owner 與 admin 執行)
const restoreCompetitionHandler = async (req, res) => {
    const { id } = req.params;
    const userRole = req.headers['x-user-role'];
    const operator = req.headers['x-user-id'] || req.userId || 'Unknown';

    if (userRole !== 'web_owner' && userRole !== 'super_admin' && userRole !== 'admin') {
        return res.status(403).json({ error: 'Access denied: Admin access required' });
    }

    try {
        const { data: competition, error: findErr } = await supabase
            .from('competitions')
            .select('name')
            .eq('id', id)
            .single();

        if (findErr || !competition) {
            return res.status(404).json({ error: '找不到該筆比賽資料' });
        }

        const { error: updateErr } = await supabase
            .from('competitions')
            .update({ is_deleted: false })
            .eq('id', id);

        if (updateErr) throw updateErr;

        await logAudit(operator, 'RESTORE_COMPETITION', id, `復原比賽: ${competition.name} (ID: ${id})`, req.userAgent);

        res.json({ message: '比賽已成功復原' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

app.put('/api/competitions/:id/restore', restoreCompetitionHandler);
app.post('/api/competitions/:id/restore', restoreCompetitionHandler);

// 硬刪除 (Hard Delete) - 從資料庫徹底抹除
app.delete('/api/competitions/:id/hard-delete', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const { error: deleteErr } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (deleteErr) throw deleteErr;

        await logAudit(operator.username, 'HARD_DELETE_COMPETITION', id, `永久刪除賽事 ID: ${id}`, req.userAgent);

        return res.json({ success: true, message: '已成功永久刪除賽事' });
    } catch (err) {
        console.error('Hard Delete Error:', err);
        return res.status(500).json({ error: '伺服器錯誤: ' + err.message });
    }
});

// ==========================================
// 🔑 使用者修改個人密碼 API
// ==========================================
app.put('/api/auth/change-password', async (req, res) => {
    const userId = req.headers['x-user-id'];
    const { oldPassword, newPassword } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!userId) {
        return res.status(401).json({ error: '請先登入系統' });
    }

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: '請提供舊密碼與新密碼' });
    }

    // 🔒 格式校驗：只能包含英文與數字 (Alpha-numeric only)
    const alphaNumericRegex = /^[a-zA-Z0-9]+$/;
    if (!alphaNumericRegex.test(newPassword)) {
        return res.status(400).json({ error: '新密碼格式不符，僅允許使用英文字母 (A-Z, a-z) 與數字 (0-9)' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: '新密碼長度至少需要 6 個字元' });
    }

    try {
        // 1. 查詢該使用者資訊
        let query = supabase.from('admin_users').select('*');
        if (!isNaN(userId)) {
            query = query.or(`id.eq.${userId},username.eq.${userId}`);
        } else {
            query = query.eq('username', userId);
        }

        const { data: user, error: userErr } = await query.single();
        if (userErr || !user) {
            return res.status(404).json({ error: '找不到該使用者帳號' });
        }

        // 2. 校驗舊密碼是否正確
        if (user.password !== oldPassword) {
            return res.status(400).json({ error: '舊密碼輸入錯誤' });
        }

        // 3. 更新密碼
        const { error: updateErr } = await supabase
            .from('admin_users')
            .update({ password: newPassword })
            .eq('id', user.id);

        if (updateErr) throw updateErr;

        // 4. 寫入審計日誌 (與 LOGIN_SUCCESS 格式一致)
        await logAudit(
            user.username,
            'CHANGE_PASSWORD',
            null,
            {
                role: user.role,
                ip: clientIp
            },
            req.userAgent
        );

        res.json({ success: true, message: '密碼已成功修改，請重新登入或妥善保管新密碼' });
    } catch (err) {
        console.error('❌ 修改密碼失敗:', err.message);
        res.status(500).json({ error: '伺服器內部錯誤: ' + err.message });
    }
});

// 📜 讀取審計日誌 API (僅限 Super Admin 及 Web Owner)
app.get('/api/audit-logs', requireSuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('audit_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error('Fetch audit_logs error:', error.message);
            return res.status(500).json({ error: error.message });
        }

        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: '伺服器錯誤: ' + err.message });
    }
});

// ==========================================
// 3. 後端全域 Express Error Handler 中間件
// 注意：必須放在所有 app.use() 與 API 路由的最下方！
// ==========================================
app.use(async (err, req, res, next) => {
    console.error('[Global Server Error]:', err);

    const rawUserId = req.headers ? req.headers['x-user-id'] : null;
    const isNumeric = /^\d+$/.test(rawUserId);
    const userId = isNumeric ? parseInt(rawUserId, 10) : null;
    const userAgent = req.headers ? req.headers['user-agent'] : '';

    // 自動紀錄後端未預期崩潰/異常至 Supabase
    try {
        await supabase.from('error_logs').insert([
            {
                user_id: userId,
                error_type: 'backend_error',
                message: err.message || 'Internal Server Error',
                stack_trace: err.stack || '',
                path: req.originalUrl || req.url,
                user_agent: userAgent
            }
        ]);
    } catch (loggingErr) {
        console.error('[Failed to write backend error to DB]:', loggingErr.message);
    }

    // 回傳標準化 500 JSON 響應
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: err.message
    });
});

// 本地開發監聽
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server connected to Supabase & listening on http://localhost:${PORT}`);
    });
}

// 匯出 Express App 適配 Vercel Serverless Functions
module.exports = app;