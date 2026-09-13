require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. 初始化 Supabase 雲端資料庫連線
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ 錯誤：未設定 SUPABASE_URL 或 SUPABASE_KEY，請檢查 .env 檔案！');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper: 處理空字串，將未填寫的選填欄位轉為 null
function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    return str === '' ? null : str;
}

// 📜 Audit Log 審計日誌寫入輔助函式
async function logAuditAction(userId, action, competitionId = null, details = {}) {
    try {
        const { error } = await supabase
            .from('audit_logs')
            .insert([
                {
                    user_id: userId || 'UNKNOWN',
                    action: action,
                    competition_id: competitionId,
                    details: details,
                    created_at: new Date().toISOString()
                }
            ]);

        if (error) {
            console.error('⚠️ Audit Log 寫入失敗:', error.message);
        }
    } catch (err) {
        console.error('⚠️ Audit Log 執行例外:', err);
    }
}

// Helper: 寫入 Supabase 審計日誌 (audit_logs 表格)
async function logAudit(userId, action, targetId = null, details = null) {
    try {
        const { error } = await supabase.from('audit_logs').insert([
            {
                user_id: userId || 'unknown_user',
                action: action,
                target_id: targetId,
                details: typeof details === 'object' ? JSON.stringify(details) : details
            }
        ]);
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
        await logAudit(operator, 'CREATE_ADMIN', data[0].id, `新增管理員帳號: ${username} (角色: ${role || 'admin'})`);

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

        // 防呆：不能刪除自己
        if (targetUser.username === operator) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        const { error: delErr } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', targetUser.id);

        if (delErr) throw delErr;

        // 寫入操作日誌
        await logAudit(operator, 'DELETE_ADMIN', targetUser.id, `刪除管理員帳號: ${targetUser.username} (ID: ${targetUser.id})`);

        res.json({ message: '帳號刪除成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔐 管理員登入驗證 API
// 範例：管理員登入驗證端點
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // 1. 查詢管理員帳號與驗證密碼
    const { data: user, error } = await supabase
        .from('admin_users')
        .select('*')
        .eq('username', username)
        .single();

    // 驗證失敗情況（帳號不存在或密碼不符）
    if (error || !user || user.password !== password) {
        // ❌ 紀錄登入失敗日誌 (v2.2.3)
        await logAuditAction(username || 'UNKNOWN', 'LOGIN_FAILED', null, {
            reason: '帳號或密碼錯誤',
            ip: clientIp
        });

        return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    // ✅ 紀錄登入成功日誌 (v2.2.3)
    await logAuditAction(user.username, 'LOGIN_SUCCESS', null, {
        role: user.role,
        ip: clientIp
    });

    res.json({
        message: '登入成功',
        user: { id: user.id, username: user.username, role: user.role }
    });
});

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

// ➕ 發佈新比賽
app.post('/api/competitions', async (req, res) => {
    const userId = req.headers['x-user-id'];
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
        await logAudit(userId, 'CREATE_COMPETITION', newCompetition.id, { name, date, end_date });

        res.status(201).json({ id: newCompetition.id, message: '賽事發佈成功' });
    } catch (err) {
        console.error('❌ 新增比賽失敗:', err.message);
        res.status(500).json({ error: 'Supabase 資料庫寫入失敗: ' + err.message });
    }
});

// ✏️ 修改比賽
app.put('/api/competitions/:id', async (req, res) => {
    const userId = req.headers['x-user-id'];
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

        await logAudit(userId, 'UPDATE_COMPETITION', id, { name, date, end_date });
        res.json({ message: '更新成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 刪除比賽 (軟刪除)
app.delete('/api/competitions/:id', async (req, res) => {
    const { id } = req.params;
    const operator = req.headers['x-user-id'] || 'Unknown';

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

        await logAudit(operator, 'DELETE_COMPETITION', id, `刪除比賽: ${competition.name} (ID: ${id})`);

        res.json({ message: '比賽已移至回收桶' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ⚠️ 專屬超級管理員：硬刪除 (Hard Delete) - 從資料庫徹底抹除
app.delete('/api/competitions/:id/hard-delete', async (req, res) => {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];

    if (!userId) {
        return res.status(401).json({ error: '未提供身份驗證 Header (x-user-id)' });
    }

    try {
        // 1. 建立動態查詢：判斷 userId 是數字 (id) 還是字串 (username)
        let query = supabase.from('admin_users').select('*');

        const isNumeric = /^\d+$/.test(userId);
        if (isNumeric) {
            // 如果 Header 傳來的是純數字 ID
            query = query.eq('id', parseInt(userId, 10));
        } else {
            // 如果 Header 傳來的是字串帳號 (例如: "rimuru")
            query = query.eq('username', userId);
        }

        const { data: admin, error: adminErr } = await query.maybeSingle();

        if (adminErr || !admin) {
            console.error('權限檢查失敗:', adminErr);
            return res.status(403).json({ error: '找不到對應的管理員帳號' });
        }

        // 2. 檢查角色權限
        if (admin.role !== 'super_admin') {
            return res.status(403).json({ error: '權限不足：僅限超級管理員執行永久刪除' });
        }

        // 3. 執行硬刪除 (Hard Delete)
        const { error: deleteErr } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (deleteErr) throw deleteErr;

        // 4. 寫入 Audit Log
        await supabase.from('audit_logs').insert([
            {
                user_id: admin.username || userId,
                action: 'HARD_DELETE_COMPETITION',
                details: `永久刪除賽事 ID: ${id}`
            }
        ]);

        return res.json({ success: true, message: '已成功永久刪除賽事' });

    } catch (err) {
        console.error('Hard Delete Error:', err);
        return res.status(500).json({ error: '伺服器錯誤: ' + err.message });
    }
});

// 從回收桶復原比賽
app.put('/api/competitions/:id/restore', async (req, res) => {
    const { id } = req.params;
    const operator = req.headers['x-user-id'] || 'Unknown';

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

        await logAudit(operator, 'RESTORE_COMPETITION', id, `復原比賽: ${competition.name} (ID: ${id})`);

        res.json({ message: '比賽已成功復原' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 📜 讀取審計日誌 API
// 取得操作日誌列表 (僅限超級管理員)
app.get('/api/audit-logs', requireSuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('audit_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50); // 預設拉取最新 50 筆

        if (error) {
            console.error(' Fetch audit_logs error:', error.message);
            return res.status(500).json({ error: error.message });
        }

        // 修正此處：將原先的 logs 改為 data
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: '伺服器錯誤: ' + err.message });
    }
});

// 🗑️ 讀取回收桶列表 API
app.get('/api/competitions/deleted', async (req, res) => {
    try {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server connected to Supabase & listening on http://localhost:${PORT}`);
});
