require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
// 更安全、不留預設密碼的寫法：
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
    console.warn('⚠️ 警告：未設定 ADMIN_PASSWORD 環境變數！管理員功能將無法使用。');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'x-admin-password'] }));
app.use(express.json());
app.use(express.static('public'));

// 管理員身份驗證 Middleware
const verifyAdmin = (req, res, next) => {
    const adminPassword = req.headers['x-admin-password'];
    if (adminPassword === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(403).json({ error: '權限不足！請先登入管理員帳號。' });
    }
};

// 1. 管理員驗證 API (前端登入用)
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, message: '管理員驗證成功' });
    } else {
        res.status(401).json({ success: false, message: '密碼錯誤' });
    }
});

// 2. 取得所有比賽資料 (公開 GET - 所有用戶均可存取)
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

// 3. 新增比賽資料 (需要管理員權限)
app.post('/api/competitions', verifyAdmin, async (req, res) => {
    const { name, location, date, time, description } = req.body;
    if (!name) return res.status(400).json({ error: '比賽名稱為必填項目' });

    try {
        const { data, error } = await supabase
            .from('competitions')
            .insert([{ name, location, date, time, description }])
            .select();

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. 刪除比賽資料 (需要管理員權限)
app.delete('/api/competitions/:id', verifyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('competitions')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ message: '成功刪除比賽資料' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
