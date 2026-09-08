const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware 設定
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // 靜態網頁檔案目錄

// 初始化 SQLite 資料庫檔案
const db = new sqlite3.Database('./competitions.db', (err) => {
    if (err) console.error('資料庫連接失敗:', err.message);
    else console.log('已成功連接至 SQLite 資料庫');
});

// 建立資料表
db.run(`
  CREATE TABLE IF NOT EXISTS competitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT
  )
`);

// API 1: 取得所有比賽清單
app.get('/api/competitions', (req, res) => {
    db.all('SELECT * FROM competitions ORDER BY date ASC, time ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API 2: 發佈新比賽
app.post('/api/competitions', (req, res) => {
    const { name, date, time, location, description } = req.body;

    if (!name || !date || !time || !location) {
        return res.status(400).json({ error: '請填寫所有必填欄位！' });
    }

    const sql = `INSERT INTO competitions (name, date, time, location, description) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [name, date, time, location, description || ''], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: '比賽發佈成功！' });
    });
});

// API 3: 刪除比賽 (新增此段)
app.delete('/api/competitions/:id', (req, res) => {
    const { id } = req.params;
    const sql = 'DELETE FROM competitions WHERE id = ?';

    db.run(sql, id, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '找不到該比賽資料' });
        res.json({ message: '比賽已成功刪除！' });
    });
});

// 啟動伺服器
app.listen(PORT, () => {
    console.log(`伺服器運行中：http://localhost:${PORT}`);
});
