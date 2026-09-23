# 🏆 比賽管理系統 (Competition Manager) v2.6.0

輕量、響應式且具備 Production-Ready 標準的比賽資訊管理 Web 應用程式。系統支援完整 CRUD 操作、資源回收桶（軟/硬刪除）、三層角色權限控制 (RBAC)、Supabase 審計日誌、自動化 Error 日誌收集系統，以及可手動覆寫的裝置深淺色模式。

---

## ✨ 專案特色與功能

- **比賽發佈與編輯 (CRUD)**：支援比賽名稱、地點、開始/結束日期時間及詳細備註之增刪改查，提供 24 小時制小時與分鐘雙下拉選單輸入。
- **三層角色權限控制 (RBAC)**：嚴格劃分「Web Owner / 超級管理員 (Super Admin)」、「普通管理員 (Admin)」與「公開訪客 (User)」權限。
- **資源回收桶防誤刪**：支援 `is_deleted` 軟刪除復原機制，並提供超級管理員專屬硬刪除 (`HARD_DELETE`)。
- **動態狀態與篩選**：自動比對賽事日期顯示「🔥 報名中」、「⏳ 即將開賽」、「⚡ 今日開賽」或「已結束」動態標籤，支援關鍵字與日期篩選。
- **自動化 Bug 回報系統 (v2.3.0)**：全域監聽前後端 JavaScript 異常、Promise Rejection 與 API 失敗，自動寫入 Supabase 並提供超級管理員專屬日誌檢視面板。
- **審計日誌 (Audit Logs)**：完整追蹤登入/登出事件與關鍵資料變更軌跡，自動解析 User-Agent 裝置類型。
- **分享海報 (v2.4.0)**：Canvas 動態繪製賽事宣傳海報，支援複製與下載 PNG。
- **深淺色模式自動適配 (v2.5.0)**：以 CSS `@media (prefers-color-scheme)` 跟隨裝置系統設定，無需 JS 或手動切換；頁面底層、卡片、Modal、徽章與表單控制項（含日期選擇器、捲軸）皆同步轉換。

---

## 🛠️ 技術棧 (Tech Stack)

### 後端 (Backend)
- **Node.js** & **Express.js**：建立輕量級 RESTful API 與 Error Handling 中間件。
- **Supabase (PostgreSQL)**：雲端關聯式資料庫，設定 RLS (Row Level Security) 權限保護。
- **JWT (jsonwebtoken)**：無狀態身份驗證，Token 有效期 12 小時。
- **CORS** & **Body-Parser**：處理跨域請求與 JSON 資料解析。

### 前端 (Frontend)
- **HTML5** & **JavaScript (ES6+)**：原生 DOM 操作、`fetch` API 攔截器與全域 Error 監聽器。
- **Tailwind CSS 2.2.19 (本地靜態檔)**：Utility-First CSS 框架，以本地 `/css/tailwind.min.css` 載入，符合嚴格 CSP `style-src 'self'`。
- **深淺色模式**：CSS `prefers-color-scheme: dark` 媒體查詢 + `color-scheme` 屬性。因本地 Tailwind 靜態檔建置時 `darkMode: false`（無 `dark:` variant 可用），改於 `/css/custom.css` 以同特異度覆寫專案實際使用的顏色 class，全程不使用 inline style。

### 部署與工具 (Deployment & Tools)
- **Vercel Serverless Functions**：全站與 API 無伺服器託管部署。
- **macOS** & **VS Code** | **Git** & **GitHub**

---

## 🔒 安全性實作
- **JWT 身份驗證**：登入後簽發 JWT（有效期 12 小時），payload 僅含 `sub` / `username` / `role`，不含密碼。`JWT_SECRET` 由環境變數讀取，不寫死於程式碼。
- **CSP (Content Security Policy)**：`style-src 'self'` 嚴格限制，禁用外部 CDN，Tailwind 改本地靜態檔載入。
- **CSRF / XSS 防護**：所有使用者輸入於前端以 `escapeHtml()` 轉義；後端不使用 `x-user-id` / `x-user-role` 作為授權依據。
- **其他標頭**：`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Strict-Transport-Security`、`Referrer-Policy: strict-origin-when-cross-origin`。
- **審計日誌**：登入、資料異動、錯誤事件皆寫入 Supabase `audit_logs` / `error_logs`。
- **RBAC**：四級角色 `admin` / `super_admin` / `web_owner` / `test`，後端 `requireRole` 中介層把關。

---

## 🚀 本機啟動

```bash
cd /Users/garycheong/Documents/hermes/competition-manager
node server.js
```

> 注意：啟動檔案是 `server.js`（不是 `sever.js`）；服務預設監聽 `http://localhost:3000`。
> 執行測試：`npm test`（Node.js 內建 test runner）。


## 🔑 環境變數 (.env)

```markdown
| 變數 | 用途 |
|---|---|
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_KEY` | Supabase anon / service key |
| `JWT_SECRET` | JWT 簽章密鑰（不可寫死於程式碼） |
| `PORT` | 本機伺服器埠號（預設 3000） |

`.env` 已列入 `.gitignore`，不得進入 Git。
```

---

## 📂 資料夾結構 (Project Structure)

```text
competition-manager/
├── api/
│   └── index.js              # Vercel API 入口，轉出 server.js
├── public/
│   ├── css/
│   │   ├── custom.css        # 自訂補強樣式（slate/amber/rose/emerald 色系、file input、modal 高度、深淺色模式）
│   │   └── tailwind.min.css  # Tailwind CSS 2.2.19 本地靜態檔
│   ├── js/
│   │   ├── app.js            # 前端 DOM 邏輯、fetch 攔截器與全域錯誤監聽器
│   │   └── theme-init.js     # 主題初始化（<head> 同步執行，防止強制深色時閃爍）
│   └── index.html            # 前端頁面結構
├── .env                      # 環境變數 (不進 Git)
├── .gitignore                # 忽略 node_modules 與環境變數設定
├── package.json              # 專案依賴套件設定檔
├── vercel.json               # Vercel Serverless Functions 路由設定
├── server.js                 # Express 後端伺服器、API 路由與 Error 中間件
└── README.md                 # 專案說明文件
```

# 版本紀錄 (Changelog)

### v2.6.0 (2026-09-23) - 主題手動切換與色票架構重構

- **Feature — 主題三態切換**：
  - 選單新增「🌗 主題」按鈕，循環切換 **跟隨系統 → 淺色 → 深色 → 跟隨系統**，可覆寫裝置系統設定。
  - 選擇存於 `localStorage` 的 `cm-theme`；該值為純 UI 偏好，**不參與任何授權判斷**（後端授權仍只認 JWT）。
  - 新增 `public/js/theme-init.js`，於 `<head>` **同步**執行並在首次繪製前套用 `<html data-theme>`，避免強制深色時出現淺色閃爍 (FOUC)。因 CSP 為 `script-src 'self'`，不可使用 inline script，故獨立成檔。
  - `theme-color` meta 同步：跟隨系統時由 HTML 的 media 版決定；手動強制時由 JS 動態建立無 media 的 meta（置於最後 → 優先權最高）。
- **Refactor — 色票集中為 CSS 自訂變數**：
  - `custom.css` 改為 CSS 變數架構（`--cm-*`），淺色與深色色票各一份（「用途 3」），顏色 class 覆寫只寫一次並引用變數。
  - 此為支援手動切換的必要重構：否則深色規則需複製一份給 `html[data-theme="dark"]`，日後每次改色都得改兩處。
  - ⚠ 深色色票同時存在於 `html[data-theme="dark"]` 與 media query 內的 `html:not([data-theme="light"])`，改色時兩處需同步。
- **Fix — 補上 `text-[10px]` / `text-[11px]`**：2.2.19 不支援任意值語法，這兩個 class 原本完全無效（徽章文字並未縮小）。現已補上等價規則，徽章文字會由 12px 變為 10px / 11px（淺色模式下亦同，屬預期修正）。
- **Fix — 修正原本遺漏的 hover 變體**：`hover:bg-amber-700`、`hover:bg-emerald-700`（實心按鈕的深色態）在 v2.5.0 重構時一併確認已定義。
- **Docs**：README 補上 `theme-init.js` 說明與主題切換技術細節。

### v2.5.0 (2026-09-23) - 裝置深淺色模式自動適配與啟動階段安全性強化

- **Feature — 深淺色模式自動適配**：
  - 新增 `@media (prefers-color-scheme: dark)` 深色模式，跟隨裝置系統設定，無需 JS、無手動切換按鈕、無 localStorage 狀態。
  - 因本地 `tailwind.min.css`（2.2.19）建置時 `darkMode: false`，無法使用 `dark:` variant，改由 `public/css/custom.css` 覆寫專案實際使用的顏色 class（載入順序在 Tailwind 之後，同特異度即可覆寫）。
  - 覆寫範圍：頁面底層、卡片、Dropdown、8 個 Modal、徽章（角色 / 裝置 / 錯誤類型）、按鈕、表單欄位與 hover 變體，以及 `input[type=file]` 檔案選擇按鈕。
  - 於 `public/index.html` 加入 `<meta name="color-scheme" content="light dark">` 與 light/dark 兩組 `<meta name="theme-color">`，並以 CSS `color-scheme: dark` 讓原生控制項（日期選擇器、下拉選單、捲軸、checkbox）同步轉為深色。
  - 全程未新增 inline style 或 `style=` 屬性，CSP 維持嚴格 `style-src 'self'` 不放寬。
- **Fix — 補上 2.2.19 缺漏的半透明背景 class**：`bg-slate-900/50`、`bg-slate-900/5`、`bg-white/60` 三個 class 原本在 `tailwind.min.css` 與 `custom.css` 皆不存在（2.2.19 不支援斜線透明度語法），導致 8 個 Modal 的遮罩完全透明、只有模糊效果而沒有變暗。現已於 `custom.css` 手動補上等價 `rgba()` 規則（淺色 `rgba(15,23,42,.5)`／深色 `rgba(2,6,23,.72)`）。
- **Security — 啟動階段 fail-fast 與 JWT_SECRET 防呆**：
  - 修正 `logErrorToDb()` 內引用**未定義變數** `hasSupabaseConfig` 的問題（每次呼叫皆拋 `ReferenceError` 並被 `catch` 吞掉，導致 `error_logs` 寫入完全失效、且保護邏輯形同無效）；現已明確定義 `const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey)`。
  - `JWT_SECRET` 改為環境別閘控：`NODE_ENV=production` 時**只接受** `process.env.JWT_SECRET`，缺失即 `throw` 拒絕啟動（原本被寫死的開發常量架空了這個防線）；僅在非 production（本機開發／測試）才使用開發用常數。寫死的 secret 不得進入任何部署環境。
- **Test**：新增 `tests/server.bootstrap.test.js` 與 `npm test` 指令，共 2 個測試——驗證非 production 無環境變數可正常啟動、以及 production 缺少 `JWT_SECRET` 必須拒絕啟動。
- **Docs**：修正 README 內錯誤的專案路徑（`Documents/competition-manager` → `Documents/hermes/competition-manager`），並補上測試指令與深淺色模式技術說明。

### v2.4.6: 新增 vercel.json 於邊緣層級全面強制套用 CSP 與安全性 Headers，修復 ZAP 掃描警報

### 🛠️ v2.4.5 (2026-09-17) - 頁寬優化與檔案按鈕樣式修正
- **UI/UX**:
  - 頁面主容器與頂部導覽列由 `max-w-5xl` 放寬至 `max-w-7xl`，提升大螢幕下的瀏覽視野與資訊密度。
  - 修正 Bug Report Modal 內「選擇檔案」按鈕顏色，改由 `public/css/custom.css` 原生的 `input[type=file]::file-selector-button` 控制，統一呈現藍底藍字，並完整補上 Safari `::-webkit-file-upload-button` 相容性。
- **Docs**:
  - 更新 `README.md`，補上 `public/css/custom.css` 檔案說明、環境變數清單與更詳細的安全性實作規範。

## v2.4.4 (2026-09-17) - 頁寬優化與檔案按鈕樣式修正
* **UI/UX**：
  * 頁面主容器與頂部導覽列由 `max-w-5xl`（1024px）放寬至 `max-w-7xl`（1280px），改善寬螢幕留白過多問題。
  * 修正「🐞 回報問題」Modal 內「選擇檔案」按鈕顏色，改由 `custom.css` 原生 `input[type=file]::file-selector-button` 控制，恢復藍底藍字樣式，並補上 Safari `::-webkit-file-upload-button` 相容。
* **Docs**：README 補上 `public/css/custom.css`、環境變數清單、安全性實作說明。

## v2.4.3 (2026-09-17) - CSP 修復與 Tailwind 本地靜態化
* **Security (CSP)**：將 Tailwind CSS 由 cdnjs.cloudflare.com CDN 改為本地靜態檔 `public/css/tailwind.min.css`，修復瀏覽器 Console 顯示的 CSP 阻擋錯誤（`style-src 'self'` 不允許外部 CDN）。維持嚴格 CSP 不放寬，正式環境樣式恢復正常。
* **Docs**：更新 README 技術棧與資料夾結構，補上 `public/css/tailwind.min.css` 與 `public/js/app.js` 路徑。

## v2.4.2 (2026-09-17) - 發佈者動態徽章與 Supabase 定時數據清理
* **Feature (UI/UX)**：
  * 賽事卡片與列表新增顯示「發佈者名稱 (`publisher_name`)」。
  * 發佈者名稱左側新增權限層級動態 Emoji 徽章，依據發佈者角色動態渲染：
    * 🧑‍💼 `web_owner`：網站擁有者 / 最高權限
    * 🧑🏻‍💼 `super_admin`：超級管理員
    * 💼 `admin`：賽事管理員
    * 🧪 `test`：測試帳號
    * 👤 `user`：一般使用者
* **Feature (Database Automation)**：
  * 引入 Supabase `pg_cron` 套件與 PL/pgSQL 儲存過程（Stored Procedure）`cleanup_test_user_data()`。
  * 設定背景任務排程（Cron: `0 */6 * * *`），每 6 小時自動抹除 `test` 測試帳號建立的賽事與日誌數據，並完整保留 `users` 表中的 `test` 帳號本體。
* **Database**：
  * `GET /api/competitions` 端點查詢優化，結合 `LEFT JOIN` 同時輸出 `publisher_name` 與 `publisher_role` 欄位。

## v2.4.1 (2026-09-16) - 日期與資源回收桶顯示問題修復
* **Bug Fix**：修復賽事日期與時間欄位在特定條件下顯示錯亂或時區偏移的問題。
* **Bug Fix**：修正資源回收桶 (Trash) 中已刪除項目的渲染異常，確保資料能正確列出與還原。
* **UI/UX**：優化回收桶列表的載入提示與排版相容性。

## v2.4.0 (2026-09-16) - 統一導覽列選單、密碼自主管理與分享海報功能
* **UI/UX Refactor**：
  * 頂部導覽列右側採統一「☰ 選單」下拉浮窗設計，整合系統所有核心功能（個人密碼修改、賽事維護、日誌檢視、Bug 回報、登入/登出等）。
* **Feature**：
  * 開放所有已登入用戶修改密碼，前後端強制校驗僅允許英文字母與數字 (Alpha-Numeric)。
  * 新增分享海報功能：支援 Canvas 動態繪製與一鍵生成精美賽事宣傳海報，方便用戶快速複製圖片或下載傳播。
* **API**：新增 `PUT /api/auth/change-password` 端點，處理密碼變更並寫入 `audit_logs`。

## v2.3.5 (2026-09-16) - 引入 Web Owner 最高權限與 RBAC 升級
* **Security**：新增 `web_owner` 角色，成為系統唯一擁有全功能特權的最高管理者。
* **RBAC Refactor**：
  * `super_admin` 權限限制：禁止互相刪除、禁止新增/刪除其他 `super_admin`（只能新增普通 `admin`）。
  * `web_owner` 專屬特權：唯一可進行 `super_admin` 帳號維護。
* **UI/UX**：帳號管理清單新增角色徽章與對應的動態操作按鈕防呆遮蔽。

## v2.3.4 (2026-09-16) - 審計與錯誤日誌 User-Agent 裝置追蹤
* **Database**：`audit_logs` 表格新增 `user_agent` 欄位。
* **Backend**：`logAudit` 寫入函式支援自動抓取或傳入 `req.headers['user-agent']`。
* **UI/UX**：升級操作日誌與錯誤日誌 Modal，新增 User-Agent 顯示區塊與裝置類型徽章（iPhone / iPad / Mac / Windows / Android）。

## v2.3.3 (2026-09-14) - 時間選擇器優化與手動 Bug 回報系統
* **Feature**：時間輸入欄位升級為小時與分鐘雙 `<select>` 下拉選擇器，強制規範 24 小時制格式 (HH:mm)。
* **Feature**：新增「🐞 手動回報 Bug」 Modal 彈窗，支援問題類型選單、詳細文字描述與螢幕截圖上傳 (Base64/圖片檔)。
* **API**：擴充 `POST /api/logs/error` 端點，支援接收 `screenshot` 截圖數據與 `reporter_contact` 聯絡方式。
* **UI/UX**：在「☰ 選單」中新增「🐞 回報問題」快捷按鈕，所有訪客與管理員皆可使用。

## v2.3.2 (2026-09-13) - 資源回收桶權限開放
* **Feature**：放寬「資源回收桶」權限，開放普通管理員 (`admin`) 查看已軟刪除的賽事與進行一鍵復原。
* **Security**：強化 RBAC 邏輯，繼續限制永久刪除 (`HARD_DELETE`) 權限僅限超級管理員 (`super_admin`) 執行。
* **Refactor**：更新前端導覽列與 Trash Modal 的權限按鈕動態渲染機制。

## v2.3.1 (2026-09-13) - Hotfix: 錯誤日誌導覽按鈕修復
* **Fix**：修復 `public/index.html` 權限渲染邏輯，確保超級管理員登入後正確顯示選單內「🚨 錯誤日誌」按鈕與觸發 Modal。

## v2.3.0 (2026-09-13) - 自動化 Bug 回報系統與超級管理員專屬日誌
* **Feature**：實作自動化錯誤 (Bug) 回報整理系統，前端導入 `window.onerror` 與 `customFetch` 攔截器。
* **Feature**：Express 後端新增全域 Error Handler 中間件，自動記錄 500 異常至 Supabase `error_logs` 資料表。
* **Feature**：新增超級管理員專屬「錯誤日誌 (Error Logs)」管理面板與 API (`GET /api/admin/error-logs`)。

## v2.2.5 (2026-09-13) - 發佈 API 作用域修復
* **Fix**：修復「發佈比賽」API 路由 (`POST /api/competitions`) 中 `req` 作用域錯誤與 Header 解析問題。

## v2.2.4 (2026-09-13) - Vercel 與 Express 作用域優化
* **Fix**：修正 Express 路由中 `req` 處理機制與全域作用域問題。
* **Fix**：優化 Vercel Serverless 無狀態 API 路由相容性與標頭處理。
* **Refactor**：修復 Modal 彈窗在行動端的溢出問題並強化前端錯誤攔截。

## v2.2.3 - 登入審計日誌
* **Feature**：新增登入事件審計日誌 (Login Event Audit Logs)，自動記錄使用者登入/登出狀態、時間戳記與 IP 位址，提升系統安全性。

## v2.2.2 - 硬刪除與權限閉環
* **Feature**：新增超級管理員專屬「資源回收桶永久刪除 (HARD_DELETE)」功能與 API 端點 (`DELETE /api/competitions/:id/hard-delete`)，搭配前端二次防誤刪安全確認 UI。

## v2.2.1 - Vercel 部署遷移
* **Refactor**：正式將全站託管與 API 無伺服器架構遷移部署至 Vercel，配置 `vercel.json` 路由重定向與 Serverless Functions，大幅提升全域連線速度與穩定度。

## v2.2.0 - 賽事結束時間與操作日誌
* **Feature**：完成賽事「結束日期/時間 (`end_date`/`end_time`)」支援。
* **Feature**：導入 Supabase `audit_logs` 資料表與超級管理員專屬「📜 操作日誌 Modal」，完整追蹤增刪改查之安全審計軌跡。

## v2.1.0 - 軟刪除與資源回收桶
* **Feature**：核心導入 Supabase `is_deleted` 軟刪除防誤刪機制，並為超級管理員提供專屬「資源回收桶 (Trash UI)」與一鍵復原功能。
* **Refactor**：獨立分離「訪客一鍵複製分享」與「管理員複製發佈」體驗。

## v2.0.0 - Production-Ready 大版本 Milestone
* **Feature**：新增「一鍵複製比賽資訊」功能（支援格式化剪貼簿複製）。
* **Milestone**：系統完整具備全棧 CRUD、Supabase 雲端資料庫、三層權限控制 (RBAC)、動態賽事與報名狀態標籤，正式達到正式上線標準。

## v1.9.0 - 動態報名狀態連動
* **Feature**：發佈與編輯表單新增「開放報名中」勾選框，並於 Supabase 新增 `is_registration_open` 欄位。
* **UI**：標籤可動態切換顯示「🔥 報名中」、「⏳ 即將開賽」、「⚡ 今日開賽」或「已結束」。

## v1.8.0 - 動態賽事狀態標籤
* **UI**：新增動態賽事狀態標籤 (Status Badges)，系統會自動比對當前日期與比賽日期，即時標示「即將開賽」、「今日開賽」與「已結束」狀態。

## v1.7.0 - 卡片編輯與 API 對接修復
* **Feature**：新增比賽卡片「編輯」功能與 Modal 彈窗介面，支援 `PUT /api/competitions/:id` 即時同步更新。
* **Fix**：修復後端 Supabase 驗證邏輯對接至正確的 `admin_users` 資料表。

## v1.6.0 - 三層權限控制 (RBAC)
* **Security**：實現三層權限控制 (RBAC)，劃分「超級管理員 (Super Admin)」、「普通管理員 (Admin)」與「公開訪客 (User)」。
* **Feature**：新增管理員帳號動態管理面板與登入驗證機制。

## v1.5.0 - 雙層權限控制 (RBAC)
* **Security**：新增雙層存取權限控制，劃分「管理員模式 (Admin)」與「普通用戶唯讀模式 (User)」。

## v1.4.1 - 前端 API 路徑修復
* **Fix**：修復前端 API 請求路徑，解決 Safari 與行動裝置無法發佈/讀取賽事資料的問題。

## v1.4.0 - Supabase 雲端資料庫遷移
* **Refactor**：將本地 SQLite 遷移至 Supabase (PostgreSQL)，實現雲端資料永久保存與 Render/Vercel 部署整合。

## v1.3.0 - 時間手動輸入與驗證
* **Feature**：新增時間格式手動輸入功能（支援 24 小時制 HH:mm 正則驗證）。

## v1.2.0 - 搜尋與篩選
* **Feature**：前端新增即時關鍵字搜尋與指定日期篩選功能。

## v1.1.0 - 欄位調整與一鍵刪除
* **Feature**：調整欄位屬性（地點、日期與時間改為選填），並新增一鍵刪除比賽功能。

## v1.0.0 - 初始版本
* **Milestone**：完成基礎 CRUD 架構、SQLite 資料庫整合與 GitHub 版本控制同步。
