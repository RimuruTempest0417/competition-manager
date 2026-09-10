require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 Supabase 客戶端
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. 取得所有比賽資料 (GET)
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

// 2. 新增比賽資料 (POST)
app.post('/api/competitions', async (req, res) => {
    const { name, location, date, time, description } = req.body;

    if (!name) {
        return res.status(400).json({ error: '比賽名稱為必填項目' });
    }

    try {
        const { data, error } = await supabase
            .from('competitions')
            .insert([{ name, location, date, time, description }])
            .select();

        if (error) {
            console.error('Supabase 寫入錯誤：', error); // 👈 印出詳細 SQL/Supabase 報錯
            throw error;
        }
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 3. 刪除比賽資料 (DELETE)
app.delete('/api/competitions/:id', async (req, res) => {
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