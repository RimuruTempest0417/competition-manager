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
```

---

## 📝 版本紀錄 (Changelog)

- **v1.8.0** - 視覺質感升級！新增動態賽事狀態標籤 (Status Badges)，系統會自動比對當前日期與比賽日期，即時標示「即將開賽」、「今日開賽」與「已結束」狀態。
- **v1.7.0** - 賽事動態編輯與資料庫對接修復！新增比賽卡片「編輯」功能與 Modal 彈窗介面，支援 `PUT /api/competitions/:id` 即時同步更新；同步修復後端 Supabase 驗證邏輯對接至正確的 `admin_users` 資料表。
- **v1.6.0** - 重大安全與架構升級！實現三層權限控制 (RBAC)，劃分「超級管理員 (Super Admin)」、「普通管理員 (Admin)」與「公開訪客 (User)」，並新增管理員帳號動態管理面板與登入驗證機制。
- **v1.5.0** - 新增雙層存取權限控制 (RBAC)！劃分「管理員模式 (Admin)」與「普通用戶唯讀模式 (User)」，提升系統安全性。
- **v1.4.1** - Bug Fix：修復前端 API 請求路徑，解決 Safari 與行動裝置無法發佈/讀取賽事資料的問題。
- **v1.4.0** - 雲端資料庫架構重構！將本地 SQLite 遷移至 Supabase (PostgreSQL)，實現雲端資料永久保存與 Render 部署整合。
- **v1.3.0** - 新增時間格式手動輸入功能（支援 24 小時制 `HH:mm` 正則驗證）。
- **v1.2.0** - 前端新增即時關鍵字搜尋與指定日期篩選功能。
- **v1.1.0** - 調整欄位屬性（地點、日期與時間改為選填），並新增一鍵刪除比賽功能。
- **v1.0.0** - 初始版本發佈！完成基礎 CRUD 架構、SQLite 資料庫整合與 GitHub 版本控制同步。
