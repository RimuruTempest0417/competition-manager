require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 請填入你的 Supabase URL 與 Anon Key
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 驗證管理員權限中間件
async function verifyAnyAdmin(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: '未提供使用者識別碼' });

    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('id, username, role')
            .eq('id', userId)
            .single();

        if (error || !data) return res.status(403).json({ error: '權限不足或使用者不存在' });
        req.adminUser = data;
        next();
    } catch (err) {
        res.status(500).json({ error: '伺服器驗證錯誤' });
    }
}

// 驗證超級管理員權限中間件
async function verifySuperAdmin(req, res, next) {
    await verifyAnyAdmin(req, res, () => {
        if (req.adminUser.role !== 'super_admin') {
            return res.status(403).json({ error: '需要超級管理員權限' });
        }
        next();
    });
}

// 1. 登入 API
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' });

    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('id, username, role, password')
            .eq('username', username)
            .single();

        if (error || !data || data.password !== password) {
            return res.status(401).json({ error: '帳號或密碼錯誤' });
        }

        const { password: _, ...userWithoutPassword } = data;
        res.json({ success: true, user: userWithoutPassword });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 取得所有比賽清單
app.get('/api/competitions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('competitions')
            .select('*')
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. 新增比賽 (管理員權限)
// POST /api/competitions - 發佈新比賽
app.post('/api/competitions', async (req, res) => {
    const { name, location, date, time, description, is_registration_open } = req.body;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .insert([
                {
                    name,
                    location: location || '',
                    date: date || null,
                    time: time || '',
                    description: description || '',
                    is_registration_open: !!is_registration_open
                }
            ])
            .select();

        if (error) {
            console.error('Supabase 新增失敗：', error.message);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});


// PUT /api/competitions/:id - 更新比賽資料
app.put('/api/competitions/:id', async (req, res) => {
    const { id } = req.params;
    const { name, location, date, time, description, is_registration_open } = req.body;

    try {
        const { data, error } = await supabase
            .from('competitions')
            .update({
                name,
                location: location || '',
                date: date || null,
                time: time || '',
                description: description || '',
                is_registration_open: !!is_registration_open // 轉為布林值 true/false
            })
            .eq('id', id)
            .select();

        if (error) {
            console.error('Supabase 更新失敗：', error.message);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, data });
    } catch (err) {
        console.error('伺服器異常：', err);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// 5. 刪除比賽 (管理員權限)
app.delete('/api/competitions/:id', verifyAnyAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const { error } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: '比賽已刪除' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. 取得所有管理員清單 (超級管理員專屬)
app.get('/api/admins', verifySuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_users')
            .select('id, username, role');

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. 新增管理員 (超級管理員專屬)
app.post('/api/admins', verifySuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: '請提供帳號與密碼' });

    try {
        const { data, error } = await supabase
            .from('admin_users')
            .insert([{ username, password, role: role || 'admin' }])
            .select('id, username, role');

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. 刪除管理員 (超級管理員專屬)
app.delete('/api/admins/:id', verifySuperAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const { error } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: '管理員帳號已刪除' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器運行於 http://localhost:${PORT}`);
});
