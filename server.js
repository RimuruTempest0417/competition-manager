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

// 中間件：檢查是否為超級管理員 (Super Admin)
async function requireSuperAdmin(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(401).json({ error: '未提供使用者識別碼' });
    }

    try {
        let query = supabase.from('admin_users').select('*');

        // 判斷 userId 是否為整數，若為整數則允許以 id 查詢，否則以 username 查詢
        if (!isNaN(userId)) {
            query = query.or(`id.eq.${userId},username.eq.${userId}`);
        } else {
            query = query.eq('username', userId);
        }

        const { data: user, error } = await query.single();

        if (error || !user || user.role !== 'super_admin') {
            return res.status(403).json({ error: '權限不足，僅限超級管理員操作' });
        }

        req.currentUser = user; // 綁定目前的請求者資訊
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
        if (userRole !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied: Super Admin only' });
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
app.get('/api/admins', requireSuperAdmin, async (req, res) => {
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
app.post('/api/admins', requireSuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const operator = req.currentUser.username;

    if (!username || !password) {
        return res.status(400).json({ error: '帳號與密碼為必填欄位' });
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
            .insert([{ username, password, role: role || 'admin' }])
            .select();

        if (error) throw error;

        // 寫入操作日誌
        await logAudit(operator, 'CREATE_ADMIN', data[0].id, `新增管理員帳號: ${username} (角色: ${role || 'admin'})`, req.userAgent);

        res.json({ message: '管理員新增成功', id: data[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 刪除管理員帳號
app.delete('/api/admins/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser.username;

    try {
        let query = supabase.from('admin_users').select('id, username');
        if (!isNaN(id)) {
            query = query.or(`id.eq.${id},username.eq.${id}`);
        } else {
            query = query.eq('username', id);
        }

        const { data: targetUser, error: findErr } = await query.single();
        if (findErr || !targetUser) {
            return res.status(404).json({ error: '找不到該管理員帳號' });
        }

        // 防呆：無法刪除自己
        if (targetUser.username === operator) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        const { error: delErr } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', targetUser.id);

        if (delErr) throw delErr;

        // 寫入操作日誌
        await logAudit(operator, 'DELETE_ADMIN', targetUser.id, `刪除管理員帳號: ${targetUser.username} (ID: ${targetUser.id})`, req.userAgent);

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

// 🗑️ 讀取回收桶列表 API (開放 super_admin 與 admin 讀取)
app.get('/api/competitions/deleted', async (req, res) => {
    try {
        const userRole = req.headers['x-user-role'];
        if (userRole !== 'super_admin' && userRole !== 'admin') {
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

// 從回收桶復原比賽 (允許 super_admin 與 admin 執行)
const restoreCompetitionHandler = async (req, res) => {
    const { id } = req.params;
    const userRole = req.headers['x-user-role'];
    const operator = req.headers['x-user-id'] || req.userId || 'Unknown';

    if (userRole !== 'super_admin' && userRole !== 'admin') {
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

// ⚠️ 專屬超級管理員：硬刪除 (Hard Delete) - 從資料庫徹底抹除
app.delete('/api/competitions/:id/hard-delete', async (req, res) => {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];

    if (!userId) {
        return res.status(401).json({ error: '未提供身份驗證 Header (x-user-id)' });
    }

    try {
        let query = supabase.from('admin_users').select('*');

        const isNumeric = /^\d+$/.test(userId);
        if (isNumeric) {
            query = query.eq('id', parseInt(userId, 10));
        } else {
            query = query.eq('username', userId);
        }

        const { data: admin, error: adminErr } = await query.maybeSingle();

        if (adminErr || !admin) {
            return res.status(403).json({ error: '找不到對應的管理員帳號' });
        }

        if (admin.role !== 'super_admin') {
            return res.status(403).json({ error: '權限不足：僅限超級管理員執行永久刪除' });
        }

        const { error: deleteErr } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (deleteErr) throw deleteErr;

        await logAudit(admin.username || userId, 'HARD_DELETE_COMPETITION', id, `永久刪除賽事 ID: ${id}`, req.userAgent);

        return res.json({ success: true, message: '已成功永久刪除賽事' });

    } catch (err) {
        console.error('Hard Delete Error:', err);
        return res.status(500).json({ error: '伺服器錯誤: ' + err.message });
    }
});

// 📜 讀取審計日誌 API (僅限超級管理員)
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
