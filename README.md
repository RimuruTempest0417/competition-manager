# 🏆 比賽管理系統 (Competition Manager) v2.3.0

輕量、響應式且具備 Production-Ready 標準的比賽資訊管理 Web 應用程式[span_1](start_span)[span_1](end_span)。系統支援完整 CRUD 操作、資源回收桶（軟/硬刪除）、三層角色權限控制 (RBAC)、Supabase 審計日誌與自動化 Error 日誌收集系統[span_2](start_span)[span_2](end_span)。

---

## ✨ 專案特色與功能

- **比賽發佈與編輯 (CRUD)**：支援比賽名稱、地點、開始/結束日期時間及詳細備註之增刪改查，具備 24 小時制時間輸入驗證 (`HH:mm`)[span_3](start_span)[span_3](end_span)。
- **三層角色權限控制 (RBAC)**：嚴格劃分「超級管理員 (Super Admin)」、「普通管理員 (Admin)」與「公開訪客 (User)」權限[span_4](start_span)[span_4](end_span)。
- **資源回收桶防誤刪**：支援 `is_deleted` 軟刪除復原機制，並提供超級管理員專屬硬刪除 (`HARD_DELETE`)[span_5](start_span)[span_5](end_span)。
- **動態狀態與篩選**：自動比對賽事日期顯示「🔥 報名中」、「⏳ 即將開賽」、「⚡ 今日開賽」或「已結束」動態標籤，支援關鍵字與日期篩選[span_6](start_span)[span_6](end_span)。
- **自動化 Bug 回報系統 (v2.3.0)**：全域監聽前後端 JavaScript 異常、Promise Rejection 與 API 失敗，自動寫入 Supabase 並提供超級管理員專屬日誌檢視面板。
- **審計日誌 (Audit Logs)**：完整追蹤登入/登出事件與關鍵資料變更軌跡[span_7](start_span)[span_7](end_span)。

---

## 🛠️ 技術棧 (Tech Stack)

### 後端 (Backend)
- **Node.js** & **Express.js**：建立輕量級 RESTful API 與 Error Handling 中間件[span_8](start_span)[span_8](end_span)。
- **Supabase (PostgreSQL)**：雲端關聯式資料庫，設定 RLS (Row Level Security) 權限保護[span_9](start_span)[span_9](end_span)。
- **CORS** & **Body-Parser**：處理跨域請求與 JSON 資料解析[span_10](start_span)[span_10](end_span)。

### 前端 (Frontend)
- **HTML5** & **JavaScript (ES6+)**：原生 DOM 操作、`fetch` API 攔截器與全域 Error 監聽器[span_11](start_span)[span_11](end_span)。
- **Tailwind CSS (CDN)**：現代化 Utility-First CSS 框架，打造響應式與質感 UI[span_12](start_span)[span_12](end_span)。

### 部署與工具 (Deployment & Tools)
- **Vercel Serverless Functions**：全站與 API 無伺服器託管部署[span_13](start_span)[span_13](end_span)。
- **macOS** & **VS Code** | **Git** & **GitHub**[span_14](start_span)[span_14](end_span)

---

## 📂 資料夾結構 (Project Structure)

```text
competition-manager/
├── public/
│   └── index.html      # 前端介面、DOM 邏輯與全域錯誤攔截器
├── .gitignore          # 忽略 node_modules 與環境變數設定
├── package.json        # 專案依賴套件設定檔
├── vercel.json         # Vercel Serverless Functions 路由設定
├── server.js           # Express 後端伺服器、API 路由與 Error 中間件
└── README.md           # 專案說明文件

---

## 🔖 版本紀錄 (Changelog)

### 🚀 v2.3.0 (2026-09-13) - 自動化 Bug 回報系統與超級管理員專屬日誌
- **Feature**: 實作自動化錯誤 (Bug) 回報整理系統，前端導入 `window.onerror` 與 `customFetch` 攔截器。
- **Feature**: Express 後端新增全域 Error Handler 中間件，自動記錄 500 異常至 Supabase `error_logs` 資料表。
- **Feature**: 新增超級管理員專屬「錯誤日誌 (Error Logs)」管理面板與 API (`GET /api/admin/error-logs`)。

### 🐛 v2.2.5 (2026-09-13) - 發佈 API 作用域修復
- **Fix**: 修復「發佈比賽」API 路由 (`POST /api/competitions`) 中 `req` 作用域錯誤與 Header 解析問題[span_0](start_span)[span_0](end_span)。

### 🐛 v2.2.4 (2026-09-13) - Vercel 與 Express 作用域優化
- **Fix**: 修正 Express 路由中 `req` 處理機制與全域作用域問題[span_1](start_span)[span_1](end_span)。
- **Fix**: 優化 Vercel Serverless 無狀態 API 路由相容性與標頭處理[span_2](start_span)[span_2](end_span)。
- **Refactor**: 修復 Modal 彈窗在行動端的溢出問題並強化前端錯誤攔截[span_3](start_span)[span_3](end_span)。

### 🔒 v2.2.3 - 登入審計日誌
- **Feature**: 新增登入事件審計日誌 (Login Event Audit Logs)，自動記錄使用者登入/登出狀態、時間戳記與 IP 位址，提升系統安全性[span_4](start_span)[span_4](end_span)。

### 🗑️ v2.2.2 - 硬刪除與權限閉環
- **Feature**: 新增超級管理員專屬「資源回收桶永久刪除 (`HARD_DELETE`)」功能與 API 端點 (`DELETE /api/competitions/:id/hard-delete`)，搭配前端二次防誤刪安全確認 UI[span_5](start_span)[span_5](end_span)。

### ☁️ v2.2.1 - Vercel 部署遷移
- **Refactor**: 正式將全站託管與 API 無伺服器架構遷移部署至 Vercel，配置 `vercel.json` 路由重定向與 Serverless Functions，大幅提升全域連線速度與穩定度[span_6](start_span)[span_6](end_span)。

### 📜 v2.2.0 - 賽事結束時間與操作日誌
- **Feature**: 完成賽事「結束日期/時間 (`end_date`/`end_time`)」支援[span_7](start_span)[span_7](end_span)。
- **Feature**: 導入 Supabase `audit_logs` 資料表與超級管理員專屬「📜 操作日誌 Modal」，完整追蹤增刪改查之安全審計軌跡[span_8](start_span)[span_8](end_span)。

### ♻️ v2.1.0 - 軟刪除與資源回收桶
- **Feature**: 核心導入 Supabase `is_deleted` 軟刪除防誤刪機制，並為超級管理員提供專屬「資源回收桶 (Trash UI)」與一鍵復原功能[span_9](start_span)[span_9](end_span)。
- **Refactor**: 獨立分離「訪客一鍵複製分享」與「管理員複製發佈」體驗[span_10](start_span)[span_10](end_span)。

### 🎉 v2.0.0 - Production-Ready 大版本 Milestone
- **Feature**: 新增「一鍵複製比賽資訊」功能（支援格式化剪貼簿複製）[span_11](start_span)[span_11](end_span)。
- **Milestone**: 系統完整具備全棧 CRUD、Supabase 雲端資料庫、三層權限控制 (RBAC)、動態賽事與報名狀態標籤，正式達到正式上線標準[span_12](start_span)[span_12](end_span)。

### 🏷️ v1.9.0 - 動態報名狀態連動
- **Feature**: 發佈與編輯表單新增「開放報名中」勾選框，並於 Supabase 新增 `is_registration_open` 欄位[span_13](start_span)[span_13](end_span)。
- **UI**: 標籤可動態切換顯示「🔥 報名中」、「⏳ 即將開賽」、「⚡ 今日開賽」或「已結束」[span_14](start_span)[span_14](end_span)。

### 🏷️ v1.8.0 - 動態賽事狀態標籤
- **UI**: 新增動態賽事狀態標籤 (Status Badges)，系統會自動比對當前日期與比賽日期，即時標示「即將開賽」、「今日開賽」與「已結束」狀態[span_15](start_span)[span_15](end_span)。

### ✏️ v1.7.0 - 卡片編輯與 API 對接修復
- **Feature**: 新增比賽卡片「編輯」功能與 Modal 彈窗介面，支援 `PUT /api/competitions/:id` 即時同步更新[span_16](start_span)[span_16](end_span)。
- **Fix**: 修復後端 Supabase 驗證邏輯對接至正確的 `admin_users` 資料表[span_17](start_span)[span_17](end_span)。

### 🛡️ v1.6.0 - 三層權限控制 (RBAC)
- **Security**: 實現三層權限控制 (RBAC)，劃分「超級管理員 (Super Admin)」、「普通管理員 (Admin)」與「公開訪客 (User)」[span_18](start_span)[span_18](end_span)。
- **Feature**: 新增管理員帳號動態管理面板與登入驗證機制[span_19](start_span)[span_19](end_span)。

### 🛡️ v1.5.0 - 雙層權限控制 (RBAC)
- **Security**: 新增雙層存取權限控制，劃分「管理員模式 (Admin)」與「普通用戶唯讀模式 (User)」[span_20](start_span)[span_20](end_span)。

### 🐛 v1.4.1 - 前端 API 路徑修復
- **Fix**: 修復前端 API 請求路徑，解決 Safari 與行動裝置無法發佈/讀取賽事資料的問題[span_21](start_span)[span_21](end_span)。

### ☁️ v1.4.0 - Supabase 雲端資料庫遷移
- **Refactor**: 將本地 SQLite 遷移至 Supabase (PostgreSQL)，實現雲端資料永久保存與 Render/Vercel 部署整合[span_22](start_span)[span_22](end_span)。

### ⏱️ v1.3.0 - 時間手動輸入與驗證
- **Feature**: 新增時間格式手動輸入功能（支援 24 小時制 `HH:mm` 正則驗證）[span_23](start_span)[span_23](end_span)。

### 🔍 v1.2.0 - 搜尋與篩選
- **Feature**: 前端新增即時關鍵字搜尋與指定日期篩選功能[span_24](start_span)[span_24](end_span)。

### 🗑️ v1.1.0 - 欄位調整與一鍵刪除
- **Feature**: 調整欄位屬性（地點、日期與時間改為選填），並新增一鍵刪除比賽功能[span_25](start_span)[span_25](end_span)。

### 🚀 v1.0.0 - 初始版本
- **Milestone**: 完成基礎 CRUD 架構、SQLite 資料庫整合與 GitHub 版本控制同步[span_26](start_span)[span_26](end_span)。
