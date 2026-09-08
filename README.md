# 🏆 比賽管理系統 (Competition Manager)

一個輕量、簡潔且具備完整 CRUD 功能的比賽資訊管理 Web 應用程式。本專案為學習網頁開發與全棧基礎所建置，採用 Node.js (Express) 後端架構搭配 SQLite 資料庫，前端使用 HTML5 與 Tailwind CSS 構建響應式介面。

---

## ✨ 專案特色與功能

- **比賽發佈 (Create)**：支援新增比賽名稱、地點、日期、時間及詳細備註。
  - **彈性欄位設計**：僅「比賽名稱」為必填，其餘（地點、日期、時間、備註）皆為選填。
  - **24 小時制時間輸入**：時間欄位支援自由手動輸入，並具備前端格式驗證 (`HH:mm`)。
- **動態列表與卡片顯示 (Read)**：從後端 API 動態載入所有比賽卡片。
- **一鍵刪除 (Delete)**：提供直覺的刪除按鈕，可隨時清理無效或已結束的賽事資訊。
- **即時搜尋與篩選 (Filter & Search)**：
  - **關鍵字搜尋**：支援針對「比賽名稱」、「地點」與「備註」進行即時比對。
  - **日期過濾器**：可透過日期選擇器快速篩選指定日期的賽事。
  - **一鍵重置**：提供「清除篩選」按鈕恢復完整列表。

---

## 🛠️ 技術棧 (Tech Stack)

### 後端 (Backend)
- **Node.js** & **Express.js**：建立輕量級 RESTful API 服務。
- **SQLite3**：輕量化關聯式資料庫，方便本機開發與測試。
- **CORS** & **Body-Parser**：處理跨域請求與 JSON 資料解析。

### 前端 (Frontend)
- **HTML5** & **JavaScript (ES6+)**：原生的 DOM 操作與 `fetch` API 串接。
- **Tailwind CSS (CDN)**：現代化 Utility-First CSS 框架，打造響應式與質感 UI。

### 開發與版本控制 (Dev & Tools)
- **macOS** & **VS Code**
- **Git** & **GitHub**

---

## 📂 資料夾結構 (Project Structure)

```text
competition-manager/
├── public/
│   └── index.html      # 前端主要介面與 DOM/Fetch 邏輯
├── .gitignore          # 忽略 node_modules 與資料庫檔
├── package.json        # 專案依賴套件設定檔
├── server.js           # Express 後端伺服器與 SQLite API 路由
└── README.md           # 專案說明文件
