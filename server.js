require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'x-user-id', 'x-user-role'] }));
app.use(express.json());
app.use(express.static('public'));

// ------------------- 中間件 (Middleware) ------------------- //

// 驗證是否為任何管理員 (Super Admin 或 Admin 均可)
const verifyAnyAdmin = async (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: '請先登入！' });

    const { data: user, error } = await supabase.from('admin_users').select('*').eq('id', userId).single();
    if (error || !user) return res.status(403).json({ error: '無效的管理員身份！' });

    req.currentUser = user;
    next();
};

// 驗證是否為「超級管理員」
const verifySuperAdmin = async (req, res, next) => {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: '請先登入！' });

    const { data: user, error } = await supabase.from('admin_users').select('*').eq('id', userId).single();
    if (error || !user || user.role !== 'super_admin') {
        return res.status(403).json({ error: '權限不足！只有超級管理員可以操作帳號。' });
    }

    req.currentUser = user;
    next();
};

// ------------------- 登入 API ------------------- //

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' });

    const { data: user, error } = await supabase
        .from('admin_users')
        .select('id, username, role')
        .eq('username', username)
        .eq('password', password)
        .single();

    if (error || !user) {
        return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    res.json({ success: true, user });
});

// ------------------- 帳號管理 API (超級管理員專屬) ------------------- //

// 取得所有管理員列表
app.get('/api/admins', verifySuperAdmin, async (req, res) => {
    const { data, error } = await supabase.from('admin_users').select('id, username, role, created_at').order('id', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 新增普通管理員
app.post('/api/admins', verifySuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: '帳號與密碼為必填' });

    const { data, error } = await supabase
        .from('admin_users')
        .insert([{ username, password, role: role || 'admin' }])
        .select('id, username, role, created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 刪除管理員帳號 (不能刪除自己)
app.delete('/api/admins/:id', verifySuperAdmin, async (req, res) => {
    const targetId = req.params.id;
    if (parseInt(targetId) === req.currentUser.id) {
        return res.status(400).json({ error: '不能刪除自己的帳號！' });
    }

    const { error } = await supabase.from('admin_users').delete().eq('id', targetId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: '成功刪除管理員帳號' });
});

// ------------------- 比賽資料 API ------------------- //

// 讀取比賽 (公開 GET)
app.get('/api/competitions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('competitions').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 新增比賽 (任何管理員)
app.post('/api/competitions', verifyAnyAdmin, async (req, res) => {
    const { name, location, date, time, description } = req.body;
    if (!name) return res.status(400).json({ error: '比賽名稱為必填項目' });

    try {
        const { data, error } = await supabase.from('competitions').insert([{ name, location, date, time, description }]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 刪除比賽 (任何管理員)
app.delete('/api/competitions/:id', verifyAnyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase.from('competitions').delete().eq('id', id);
        if (error) throw error;
        res.json({ message: '成功刪除比賽資料' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
