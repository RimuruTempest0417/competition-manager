# 🏆 比賽管理系統 (Competition Manager) v2.15.0

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
- **主題手動切換 (v2.6.0)**：選單內「🌗 主題」三態切換（跟隨系統 → 淺色 → 深色），可覆寫裝置設定並記住選擇。
- **賽事分類與標籤 (v2.7.0)**：單一分類（10 種，含 emoji 與專屬色系）+ 自由標籤（最多 10 個）。列表可依分類／標籤／日期／關鍵字聯合篩選，分類清單由後端 `GET /api/meta` 提供單一真實來源。
- **日曆檢視模式 (v2.7.0)**：列表頁「📋 列表 / 📅 日曆」切換，月曆格線顯示每日賽事（依分類上色、跨日賽事展開到每一天、超過 3 場顯示「+N 更多」），點日期即看當天完整清單與操作按鈕。純手寫無外部套件（符合 CSP），手機版自動改為顏色圓點，檢視選擇會被記住。
- **一鍵匯入 / 匯出 CSV (v2.8.0)**：管理員選單「📥 CSV 匯入 / 匯出」——可下載匯入範本、批次匯入（Excel 另存的 CSV 或從 Excel 複製的 Tab 分隔內容，欄位順序不拘、表頭中英文皆可），或將現有賽事一次匯出備份（UTF-8 含 BOM，Excel 直接開啟不亂碼）。匯入前先預覽，重複（同名同日）自動跳過並回報列號。
- **訊息提醒 (v2.8.0)**：瀏覽器原生通知（Web Notification）。可開啟「新賽事發布通知」，並在任一張賽事卡片按「🔕 訂閱提醒」訂閱該場賽事，開賽前 24 小時內自動跳出提醒。設定與訂閱只存在該裝置的 `localStorage`，不上傳、不需登入；Android 透過 `public/sw.js`（極簡 Service Worker）顯示。
- **手動上傳海報 (v2.10.0)**：管理員以上可在發佈／編輯表單直接上傳海報（JPG／PNG／WebP），**取代自動生成的海報**；前端會先縮圖（最長邊 1600px、JPEG）再上傳，卡片顯示「🖼️ 自訂海報」徽章，分享海報視窗改顯示上傳的圖。圖片以 base64 存於資料庫並由自家端點 `GET /api/competitions/:id/poster` 提供（**不需要 Supabase Storage，也不必放寬 CSP**），回應帶 `Cache-Control` 與 `nosniff`。移除海報即改回自動生成款式。
- **推播訂閱服務 (v2.10.0)**：真正的 **Web Push**（VAPID + `web-push`）。在「🔔 通知設定」按「📲 開啟推播訂閱」後，**即使完全關閉網頁**也能收到「新賽事發布」與「開賽前 24 小時」提醒——由伺服器端 `GET /api/cron/reminders`（Vercel Cron 每日執行）推播。VAPID 金鑰由伺服器首次使用時自動產生並存於資料庫 `app_settings`，**私鑰不會出現在程式碼或前端**；同一賽事同一類型只推一次（`push_log` 去重），端點失效（404／410）自動停用該訂閱。未開啟推播時，仍保留原本的網頁開啟時本機提醒。
- **普通用戶與線上報名 (v2.9.0)**：新增 `user`（普通用戶）角色，任何人可自行註冊帳號。點「📝 報名」時若未登入會先要求登入／註冊，登入後即可報名，並在「📝 我的報名」查看與取消自己的報名。報名開放與否由**後端權威判斷**（開放報名開關、報名截止日、賽事日期、名額上限、重複報名），前端僅同步顯示。
- **組隊比賽與隊伍編排 (v2.9.0)**：發佈表單可勾選「👥 組隊比賽」並設定每隊人數上限；組隊比賽報名時必須填寫隊伍名稱。管理員以上可在卡片按「👥 報名／隊伍」開啟編排視窗：建立隊伍、把報名者編入或移動隊伍、檢視未編排名單；**刪除隊伍與移除隊員限超級管理員以上**（權限在後端驗證，前端也會依角色隱藏按鈕）。
- **報名截止與名額上限 (v2.9.0)**：賽事新增「報名截止日」與「名額上限」欄位，額滿或截止後卡片按鈕自動變成「🔒 已額滿 / 🔒 報名已截止」並停用送出，卡片同時顯示「N 人已報名」。
- **密碼雜湊儲存 (v2.9.0)**：新註冊帳號與變更密碼一律以 Node 內建 `crypto.scrypt` 加鹽雜湊後才寫入資料庫（`scrypt$<salt>$<hash>`，驗證使用 `timingSafeEqual`）；既有明碼舊帳號仍可登入，於下次變更密碼時自動升級為雜湊。

---

- **使用者管理 (v2.12.0)**：管理員以上可在「👥 使用者管理」建立帳號（**管理員可建立普通用戶／測試帳號、超級管理員可再建立管理員、網站擁有者不限**），並可依階梯重設密碼、改帳號名稱、停用／啟用與刪除**權限低於自己**的帳號；**只有網站擁有者能調整他人角色**。所有規則同時在後端與前端實作（前端選單不提供越權選項，前端被繞過時後端仍會拒絕並說明原因），並具備「不能改自己的角色、不能停用／刪除自己、不能刪除網站擁有者、系統必須保留至少一位網站擁有者」等保護。
- **錯誤日誌強化與修復 (v2.12.0)**：修正「系統出錯卻沒寫入錯誤日誌」——`logErrorToDb()` 原本不檢查 Supabase 回傳的錯誤（寫入失敗完全靜默），且 13 條錯誤路徑根本沒有呼叫它；現已全部補上並可在後台直接看到日誌系統自身的寫入失敗狀態。日誌介面新增**嚴重程度（錯誤／警告／資訊）、關鍵字搜尋、只看未處理、標記已處理、匯出 CSV、清理 N 天前**。
- **推播發送紀錄 (v2.12.0)**：管理員以上可在「📤 推播紀錄」查看每日排程實際發送的紀錄（賽事、類型、成功數量、時間）。
- **帳號安全強化 (v2.12.0)**：登入連續失敗 5 次鎖定 15 分鐘、停用帳號不得登入、記錄最後登入時間、無效權杖留下警告級紀錄（每 IP 每分鐘最多一筆）；公開端點（錯誤回報／推播）加入節流與欄位長度上限。
- **可安裝成手機 App（PWA）與 iOS 推播 (v2.11.0)**：新增 `manifest.json` 與自製 App 圖示（192／512／maskable／apple-touch-icon，以純 Python 產生、無外部套件），網站可「加入主畫面」並以獨立視窗全螢幕開啟。**iOS Safari 的推播必須由主畫面 App 開啟才支援**，因此通知設定視窗會依裝置自動顯示對應指引（加入主畫面步驟、權限被拒時的重設說明），不會只丟出一句「不支援」。
- **手機介面優化 (v2.11.0)**：以 390×844 實機尺寸逐項驗證——頂部導覽列壓縮為單行、篩選列在手機改為兩欄（搜尋框滿寬）、卡片動作按鈕觸控高度 ≥36px、彈出視窗改用 `dvh` 動態高度（網址列收合不會把按鈕推出畫面）、`env(safe-area-inset-bottom)` 保留 iPhone 手勢條空間、輸入框字級 ≥16px（避免 iOS 聚焦時自動放大）、頁面橫向溢出為 0。
- **深連結直達賽事 (v2.11.0)**：推播通知與分享連結帶 `?comp=<id>`，開啟後會自動切回列表、捲動到該賽事並高亮提示（處理完即清除查詢字串）。
- **我的報名 → 加入行事曆 (v2.11.0)**：每筆報名可下載標準 `.ics` 行程檔（含賽事名稱、時間、地點、說明與前一天提醒，採 RFC5545 跳脫與 CRLF）或一鍵開到 Google 日曆。
- **報名名單匯出 (v2.11.0)**：管理員以上可在「👥 報名／隊伍」視窗把該場報名名單（姓名、隊伍、備註、報名時間）匯出成 CSV，方便現場報到與計分。

## 🛠️ 技術棧 (Tech Stack)

### 後端 (Backend)
- **Node.js** & **Express.js**：建立輕量級 RESTful API 與 Error Handling 中間件。
- **Supabase (PostgreSQL)**：雲端關聯式資料庫，設定 RLS (Row Level Security) 權限保護。
- **JWT (jsonwebtoken)**：無狀態身份驗證，Token 有效期 12 小時。
- **CORS** & **Body-Parser**：處理跨域請求與 JSON 資料解析。

### 前端 (Frontend)
- **HTML5** & **JavaScript (ES6+)**：原生 DOM 操作、`fetch` API 攔截器與全域 Error 監聽器。
- **Tailwind CSS 2.2.19 (本地靜態檔)**：Utility-First CSS 框架，以本地 `/css/tailwind.min.css` 載入，符合嚴格 CSP `style-src 'self'`。
- **深淺色模式**：CSS 自訂變數（`--cm-*`）+ `prefers-color-scheme` 媒體查詢 + `<html data-theme>` 三態覆寫。因本地 Tailwind 靜態檔建置時 `darkMode: false`（無 `dark:` variant 可用），改於 `/css/custom.css` 以同特異度覆寫專案實際使用的顏色 class，全程不使用 inline style。主題色票集中於「用途 3」，顏色 class 覆寫只寫一次。
- **日曆檢視**：`public/js/calendar.js` 手寫月曆模組（無 FullCalendar 等外部套件，因 CSP 為 `script-src 'self'`），當天清單沿用列表卡片樣板。
- **身分與權限 (v2.9.0)**：`admin_users.role` 分為 `user`（普通用戶，僅能報名與管理自己的報名）、`admin`（可發佈/編輯/刪除賽事、檢視報名名單、編排隊伍）、`super_admin`（可永久刪除、刪除隊伍與移除隊員）、`web_owner`（最高權限）。JWT 只帶 `sub / username / role`，實際角色一律以資料庫當下內容為準（`ADMIN_ROLES` / `SUPER_ADMIN_ROLES` 白名單），因此「前端的角色字串」不具任何授權效力。
- **CSV 匯入 / 匯出 (v2.8.0)**：`public/js/csv.js` 為前後端共用的 UMD 模組，內含手寫 RFC4180 解析器（引號內逗號／換行、`""` 跳脫、CRLF、自動判斷逗號／Tab／分號）。前端負責解析上傳檔與預覽，後端負責匯出與匯入的**權威驗證**，兩邊共用同一份規則。
- **訊息提醒 (v2.8.0) → 推播訂閱 (v2.10.0)**：`public/js/notify.js` 負責權限、訂閱與提醒判斷（`dueNotifications` 為純函式，附單元測試），並於 v2.10.0 加入 Web Push 訂閱（`subscribe` / `unsubscribe` / `testPush`，金鑰向 `GET /api/push/public-key` 取得）。`public/sw.js` 處理 `install` / `activate` / `push` / `notificationclick`：`push` 事件讓通知在網頁關閉時也能顯示。
- **推播後端 (v2.10.0)**：`web-push`（僅伺服器端依賴，不影響 CSP `script-src 'self'`）；`pushCandidates()`、`pushPayloadFor()`、`competitionStartMs()` 皆為純函式並附單元測試；時區以 `SITE_UTC_OFFSET`（預設 `+08:00`）換算開賽時間。

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
- **密碼儲存**：一律 `scrypt$<salt>$<hash>`（`lib/passwords.js`），資料庫不保存明碼。舊帳號的明碼會在**登入成功時自動升級**，並可用 `scripts/hash-legacy-passwords.js` 批次處理；`/api/admin/error-logs/health` 會回報尚未升級的數量。
- **RBAC**：四級角色 `admin` / `super_admin` / `web_owner` / `test`，後端 `requireRole` 中介層把關；帳號管理另有角色階梯（`canCreateRole` / `canManageUser`），不允許提權、不能操作同級以上或自己。

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

## 🗄️ 資料庫 Migration

本專案的資料表結構變更以 `migrations/` 內的 SQL 檔為準，需**手動**在 Supabase 執行（本機與 Vercel 都會連到同一個資料庫）。

| 檔案 | 內容 | 必要性 |
|---|---|---|
| `migrations/2026-09-23-v2.7.0-competition-category-tags.sql` | 為 `competitions` 加入 `category`、`tags` 欄位與索引 | v2.7.0 起必須執行，否則無法儲存分類與標籤 |

| `migrations/2026-09-24-v2.9.0-users-registration-teams.sql` | 新增 `registrations`（報名）、`competition_teams`（隊伍）與供 v2.10.0 推播使用的 `push_subscriptions`、`push_log`；為 `competitions` 加入 `is_team_event`、`team_size`、`registration_deadline`、`max_registrations`；放寬 `admin_users.role` 以允許普通用戶 | **v2.9.0 起必須執行**，否則無法註冊帳號／報名／編排隊伍 |
| `migrations/2026-09-24-v2.10.0-poster-and-push.sql` | 新增 `competition_posters`（海報內容）與 `app_settings`（自動產生的 VAPID 金鑰）；為 `competitions` 加入 `poster_updated_at`；**並修正 v2.9.0 的 RLS 設定**（見下方說明） | **v2.10.0 起必須執行**，否則無法上傳海報與推播訂閱 |

執行方式：Supabase Dashboard → **SQL Editor** → 貼上整份檔案 → **Run**。SQL 為 idempotent（可重複執行），不會刪除任何既有資料。未執行時網站不會壞掉：報名、隊伍與海報端點會回 `503` 並附上「請先執行此 migration」的明確訊息，發佈／編輯賽事（未勾選組隊／未選海報時）照常運作。

⚠️ **關於 RLS**：本專案的 `SUPABASE_KEY` 是 **anon key**（只存在伺服器端環境變數，前端從不直接連 Supabase）。若對新資料表 `enable row level security` 卻沒有任何 policy，anon key 會**完全無法寫入**，報名與隊伍功能會失敗。因此 `2026-09-24-v2.10.0-poster-and-push.sql` 會把這些新資料表的 RLS 關閉，與既有 `competitions` / `admin_users` 的實際運作方式一致——**存取控制由後端 API 與 JWT 權限中間件負責**。若日後改用 Supabase **service_role key**（僅伺服器端），建議改為開啟 RLS 並搭配 policy，安全性更好。

> 尚未執行時，程式不會壞掉：讀取與其他欄位照常運作，但儲存帶有分類／標籤的賽事時會回傳明確訊息「資料庫尚未加入 category / tags 欄位…」，前端會直接顯示該訊息。

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
│   │   ├── calendar.js       # 月曆檢視模組（手寫，無外部套件）
│   │   ├── csv.js            # CSV 解析／產生（前後端共用 UMD 模組，手寫 RFC4180）
│   │   ├── notify.js         # 通知／提醒模組（判斷邏輯為純函式，可單元測試）
│   │   └── theme-init.js     # 主題初始化（<head> 同步執行，防止強制深色時閃爍）
│   ├── icons/                # PWA 圖示（192／512／maskable／apple-touch-icon，純 Python 產生）
│   ├── manifest.json         # PWA manifest（可「加入主畫面」；iOS 推播的必要條件）
│   ├── favicon.ico           # 網站圖示（ICO 內嵌 PNG）
│   ├── sw.js                 # Service Worker（顯示通知、接收 push 事件、點擊通知開啟指定賽事）
│   └── index.html            # 前端頁面結構
├── migrations/
│   └── *.sql                 # 資料庫結構變更（需手動於 Supabase SQL Editor 執行）
├── tests/
│   ├── csv.test.js           # CSV 解析／產生／正規化單元測試（含往返測試）
│   ├── helpers.test.js       # 後端純函式單元測試（分類/標籤正規化、migration 偵測、匯入去重）
│   ├── import-export.test.js # 匯入／匯出 API 端到端測試（內建假 Supabase）
│   ├── registration.test.js  # 報名規則純函式單元測試（開放判斷、隊伍欄位正規化、密碼雜湊）
│   ├── registration-api.test.js        # 報名／隊伍編排 API 端到端測試（授權、驗證、額滿、截止）
│   ├── registration-no-migration.test.js # 未執行 v2.9.0 migration 時：新功能停用、舊功能不受影響
│   ├── support/fake-supabase.js        # 假 Supabase（PostgREST）服務，供端到端測試完全不碰正式資料庫
│   ├── import-no-migration.test.js  # 資料庫尚未 migration 時的匯入行為
│   ├── notify.test.js        # 通知判斷邏輯與 iOS／PWA 推播能力判斷單元測試
│   ├── poster-push.test.js   # 海報格式／推播候選條件純函式單元測試
│   ├── user-management.test.js      # 角色階梯、登入鎖定、日誌節流純函式單元測試
│   ├── user-management-api.test.js  # 帳號管理與錯誤日誌 API 端到端測試（含提權阻擋）
│   ├── password-hash.test.js # 密碼雜湊、登入自動升級、批次升級腳本自我驗證測試
│   └── server.bootstrap.test.js  # 啟動階段與 JWT_SECRET fail-fast 測試
├── .env                      # 環境變數 (不進 Git)
├── .gitignore                # 忽略 node_modules 與環境變數設定
├── package.json              # 專案依賴套件設定檔
├── vercel.json               # Vercel Serverless Functions 路由設定
├── docs/
│   ├── 功能總覽與規劃.md      # 功能現況總表與後續規劃（可貼進 Google Docs）
│   └── 安全性檢查-v2.12.0.md  # 路由逐項安全性盤點、修復清單與刻意保留的限制
├── lib/
│   └── passwords.js          # 密碼雜湊（scrypt）與驗證；伺服器與升級腳本共用同一份實作
├── scripts/
│   └── hash-legacy-passwords.js # 一次性把舊帳號的明碼密碼升級為雜湊（支援 --dry-run）
├── server.js                 # Express 後端伺服器、API 路由與 Error 中間件
└── README.md                 # 專案說明文件
```

# 版本紀錄 (Changelog)

### v2.15.0 (2026-09-26) - 管理員兩步驟驗證（TOTP，純手寫不引套件）

- **問題**：管理員帳號只有密碼一道防線（密碼外洩或重複使用就等於後台門戶大開）。
- **本版做了什麼**：
  - 新增 `lib/totp.js`：依 RFC 4226／RFC 6238 手寫 HOTP／TOTP，**只用 Node 內建 crypto**，不引入任何外部套件（供應鏈風險與 CSP 都不動）。以官方測試向量驗證正確性。
  - 登入改為兩段式：密碼正確 → 發 **5 分鐘中間權杖**（`stage: '2fa'`）→ 輸入驗證器 App 的 6 位數才發正式權杖。中間權杖在 `authenticateToken` 會被直接拒絕，**不能拿去呼叫任何 API**。
  - 一次性備援碼 8 組（60 bit、排除易混淆字元 0/1/8/9/I/L/O），只存雜湊（每組獨立 salt），用過即標記；備援碼剩餘 2 組以內會記錄警告，用完時提示重新產生。
  - **防重放**：同一組驗證碼在同一個時間步只能用一次（記 `totp_last_step`）；驗證容忍 ±1 個時間步以吸收手機時鐘差。
  - 驗證碼錯誤也走登入失敗計數，所以暴力嘗試會被既有的「IP／帳號」鎖定規則擋下（實測連續錯 10 次 → 429）。
  - 停用需要「密碼 + 一組驗證碼或備援碼」；上級管理員可在「使用者管理」為下級**重設 2FA**（手機遺失的唯一補救路徑），並留下 `2FA_RESET_BY_ADMIN` 稽核紀錄。
  - 未執行 migration 時整個功能自動停用（`GET /api/auth/2fa/status` 回 `schema_ready: false`、設定端點回 503 並附上檔案路徑），**原本的登入完全不受影響**。
- **需要你做**：在 Supabase SQL Editor 執行 `migrations/2026-09-26-v2.15.0-admin-2fa.sql`（可重複執行），然後到選單「🔐 兩步驟驗證」用手機 App 綁定。備援碼只會顯示一次。
- **測試**：`npm test` **118/118**（新增 RFC 向量 7 項＋兩步驟 API 7 項）；手機尺寸真 Chrome 流程檢查 `tests/browser/twofactor-check.js` **15/15**（產生密鑰→算出 App 的碼→啟用→備援碼→登出→再登入要求第二因素→錯碼被拒→正碼登入→備援碼登入並提示剩餘組數）。

### v2.14.0 (2026-09-26) - 登入鎖定改「帳號 + IP」、錯誤日誌主動提示、錯誤日誌自動巡檢

- **登入鎖定不再能被用來阻斷他人帳號**（原以帳號為唯一鍵，任何人連續打錯密碼就能把別人的帳號鎖住）：
  - 單一來源 IP 連續失敗 **10 次／15 分鐘** → 只擋該 IP（訊息：「嘗試次數過多，請於 N 分鐘後再試」）。
  - 同一帳號失敗 **10 次且來自 2 個以上不同 IP** → 才判定為多來源攻擊並鎖定帳號；此時寫入 `login_lockout` 錯誤日誌留下證據。
  - 成功登入會同時清除該帳號與該 IP 的計數。
- **未處理錯誤日誌主動提示**：`GET /api/admin/error-logs/summary` 回傳未處理統計（不含任何金鑰或訊息內容複本），登入回應也附帶同一份統計；超級管理員以上登入即看到黃色提示橫幅（未處理錯誤數、近 24 小時新增、最新時間），導覽選單顯示 `錯誤日誌 (N)`。按「稍後再看」只會記住當下的最新時間，**有更新的錯誤才會再次提示**；全部處理完後自動消失。
- **錯誤日誌自動巡檢 → 自動產生待修復清單**（`scripts/error-log-triage.js`）：
  - 透過自家 API 讀取線上錯誤日誌（**不直連資料庫**，因此啟用 RLS 後照樣可用，也不需要在本機放任何資料庫金鑰）。
  - 依 `error_type` 分組統計次數、未處理數、近 24 小時、首末發生時間、嚴重程度與最常見路徑，自動給出分類、建議動作與優先度。
  - 比對 Roadmap 現有內容，自動標示「**新增**（待你決定優先度）／已排入 Roadmap／已處理」。
  - 自動更新 `docs/功能總覽與規劃.md` 的第九節與 `docs/錯誤日誌分析.md`；加 `--upload` 會一併同步 Google Doc。
- **瀏覽器檢查工具進 repo**：`tests/browser/lib/cdp.js`（零外部依賴的 Chrome DevTools Protocol 驅動，用 Node 內建 WebSocket）＋ `tests/browser/alert-banner-check.js`（真實 Chrome、手機尺寸，驗證提示橫幅的出現／查看日誌／稍後再看／新錯誤再提示／處理完消失，並檢查沒有前端例外）。
- **測試**：`npm test` **103/103**；瀏覽器檢查 **13/13**；正式站煙霧測試 **48/48**（新增摘要端點、登入提示欄位與用戶端錯誤分流斷言）。

### v2.13.0 (2026-09-26) - 資料庫存取安全強化（service_role 金鑰 + 啟用 RLS 的準備）

- **問題**：目前使用 anon key 且 RLS 關閉，任何取得金鑰的人都能直接讀寫全部資料表（含 `admin_users` 的密碼雜湊、`error_logs` 內容）。這是目前唯一的結構性風險。
- **本版做了什麼（程式與遷移檔就緒，切換留給下一版）**：
  - 金鑰解析改為明確優先序並抽成可測試的 `resolveSupabaseKey()`：`SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` → `SUPABASE_KEY`（僅伺服器端讀取，前端從不接觸金鑰）。
  - 啟動時若仍使用 anon key 會印出警告，提醒「啟用 RLS 前必須先換成 service_role」。
  - `GET /api/admin/error-logs/health` 新增 `db_key_type` 與 `rls_ready`，讓「能不能安全開啟 RLS」變成可觀測（只回類型，絕不回傳金鑰）。
  - 新增 `migrations/2026-09-26-v2.13.0-enable-rls.sql`：對 10 張表啟用 RLS 並撤銷 `anon` / `authenticated` 權限（`service_role` 會繞過 RLS，因此伺服器不受影響）。檔案開頭寫明**執行順序**與緊急回復（ROLLBACK）語法。
  - `scripts/hash-legacy-passwords.js` 同步改用 service_role key（啟用 RLS 後 anon key 會被擋下）。
- **為什麼切換不放在這一版**：啟用 RLS 前必須先確認 Vercel 已重新部署且伺服器讀到 service_role 金鑰，否則前台會整站讀不到資料。因此本版先交付程式與遷移檔，待你在 Vercel 與本機 `.env` 加入 `SUPABASE_SERVICE_KEY` 後，下一版才執行遷移與驗證。
- **測試**：`npm test` **97/97**（新增 `tests/supabase-key.test.js` 3 項：金鑰優先序、anon 時 `rls_ready=false`、service_role 時 `rls_ready=true` 且不含金鑰內容）。
- **新增工具（進 repo，不再放暫存目錄）**：`tests/browser/prod-smoke.js`（正式站 HTTP 煙霧測試 40+ 項，只讀不寫）、`scripts/doc-sync.py`（Google Doc 雙向同步）、`scripts/md-to-docs-html.py`。

### v2.12.2 (2026-09-25) - 修正：調整他人角色時「一點選單就跳確認、權限改不動」

- **問題（使用者實測發現）**：在「👥 使用者管理」點開某個帳號的角色下拉選單時，會立刻跳出「確定要把「某人」的角色改為 **原本的角色**？」，而且真正選好新角色後**權限沒有改變**。
- **原因**：角色下拉的事件掛在 `click` 上。`click` 在使用者「才剛點開選單、還沒挑選」時就觸發，此時 `select.value` 還是**舊角色**，所以確認框問的是原本權限；送出的是 `{"role": "<舊角色>"}`（等於沒改）。真正選取時發出的 `change` 事件則被 `click` 的重新渲染蓋掉。
- **修正**：下拉選單只處理 `change`（使用者真的選了才詢問與送出），`click` 一律忽略 `<select>`；按取消時下拉回復原本角色。
- **迴歸測試**：`cm-v212-check.js` 新增 5 項「真實操作順序」檢查——**先 `click` 選單（必須 0 個確認框）再 `change` 選新角色（恰好 1 個確認框、內容為新角色、PATCH body 確實帶新角色）**，以及取消時的回復行為。此測試已用「暫時移除修正」驗證過會轉紅，確實能抓到這個 bug（舊測試只丟 `change` 事件，所以漏掉了）。

### v2.12.1 (2026-09-25) - 密碼儲存安全強化（明碼自動升級為雜湊）

- **修正**：早期帳號的密碼在資料庫中是**明碼儲存**（`admin_users.password` 直接存使用者當初設定的原始密碼文字）。只要 Supabase 憑證外流，所有人的密碼就一次曝光，而多數人會在其他網站重複使用同一組密碼。
- **登入時自動升級**：使用者登入成功後，伺服器立即把該筆密碼改寫為 `scrypt$<salt>$<hash>`，並留下 `PASSWORD_HASH_UPGRADED` 稽核紀錄；升級失敗不影響登入本身（只寫警告日誌）。
- **一次批次升級**：新增 `scripts/hash-legacy-passwords.js`（`--dry-run` 可先檢查）處理「還沒登入過的舊帳號」，讓資料庫不再有待升級的明碼。腳本與伺服器共用 `lib/passwords.js`，**寫入前先自我驗證、寫入後複驗，全程不輸出任何密碼內容**。
- **可觀測**：`GET /api/admin/error-logs/health` 新增 `plaintext_passwords` 數量（只回數量、絕不回傳內容），後台可直接確認是否還有明碼帳號。
- **重構**：`hashPassword`／`verifyPassword`／`needsPasswordUpgrade` 抽到 `lib/passwords.js`，伺服器與腳本共用同一份實作，避免「腳本算的雜湊伺服器驗不過」而把使用者鎖在門外。
- 新增 `tests/password-hash.test.js`（4 個案例）：雜湊格式與驗證、登入自動升級、批次腳本自我驗證與複驗、健康端點只回數量。

### v2.12.0 (2026-09-25) - 使用者管理、錯誤日誌修復、漏洞總檢查

#### 新增功能
- **👥 使用者管理（管理員以上）**：建立帳號、重設密碼、改帳號名稱、停用／啟用、刪除；清單顯示角色、狀態、最後登入時間與「你自己」標記。角色階梯：管理員可建立 `user`／`test`；超級管理員可再建立 `admin`；網站擁有者不限。
- **只有網站擁有者能調整他人角色**（含共同擁有者；系統保證至少保留一位）。
- **錯誤日誌後台**：嚴重程度標記、關鍵字搜尋、只看未處理、標記已處理（記錄處理人）、匯出 CSV、清理 N 天前、日誌系統自身健康狀態。
- **📤 推播發送紀錄**：查看每日排程實際發送的推播（賽事／類型／成功數／時間）。
- **帳號安全**：登入失敗鎖定（5 次／15 分鐘）、停用帳號不得登入、最後登入時間、無效權杖警告級紀錄。

#### 修復（皆為實測發現）
- **錯誤日誌沒有自動寫入**：`logErrorToDb()` 未檢查 Supabase 回傳的 `error`（寫入失敗完全靜默），且 13 條 `catch` 路徑未呼叫日誌函式 → 全部補上，並新增 `/api/admin/error-logs/health` 讓寫入失敗可被看見。
- **任何 403 都會把使用者登出**：前端把 401 與 403 一視同仁（清 token + 重載），但 403 是權限不足的正常回應 → 後端無效權杖改回 401，前端只對 401（或明確的登入逾期訊息）登出。
- **CSV 公式注入**：`=、+、-、@` 開頭的內容會被 Excel／Google Sheets 當公式執行 → 匯出時加單引號消歧（純負數保持原樣）。
- **未登入寫入端點無節流**：錯誤回報／推播訂閱端點加入 IP 節流與欄位長度上限。
- **錯誤訊息外洩**：帳號與日誌 API 的 500 改回通用訊息（細節寫入 error_logs）。
- **API 回應不快取**：`/api/*` 加上 `Cache-Control: no-store`。

#### 資料庫
- 新增 `migrations/2026-09-25-v2.12.0-user-management.sql`：`admin_users` 加 `is_active`／`last_login_at`／`updated_at`；`error_logs` 加 `severity`／`resolved`／`resolved_at`／`resolved_by` 與索引。**未執行時伺服器自動降級**（先探測欄位），既有功能不受影響，只有停用帳號與日誌標記會提示需要 migration。

#### 測試與安全
- `npm test` **90 項全綠**（新增角色階梯、登入鎖定、帳號管理與日誌 API、CSV 注入防護）。
- headless Chrome **手機 390×844 實測 46 項全綠**。
- 產出 `docs/安全性檢查-v2.12.0.md`：44 條路由逐項盤點（授權、IDOR、mass assignment、注入、XSS、JWT、密碼、上傳、標頭）與 7 項修復、6 項刻意保留的限制。

### v2.11.1 (2026-09-24) - 安全性修正：自動推播端點未設定密鑰時必須拒絕

- **修正 — `/api/cron/reminders` 在未設定 `CRON_SECRET` 時會直接放行**：原本的邏輯是「有設密鑰才驗證，沒設就只做 10 分鐘節流」，於是**任何人都能用一個請求觸發推播工作**。現在抽出純函式 `cronAuthorization()` 並改為：**未設定 `CRON_SECRET` 時，production 一律回 503 並提示去設定環境變數**（開發環境仍允許，但保留 10 分鐘節流）；有設定時以 `crypto.timingSafeEqual` 固定時間比較，錯的權杖回 401。
- **需要動作**：在 Vercel → Settings → Environment Variables 加入 `CRON_SECRET`（可用 `openssl rand -hex 32` 產生或 Vercel 的 Generate），Vercel Cron 會自動以 `Authorization: Bearer $CRON_SECRET` 呼叫，設定後推播排程即可正常運作。
- **Testing**：`npm test` 共 **80 項**全綠（新增 3 項 `cronAuthorization` 單元測試：production 未設定密鑰必須拒絕、錯誤權杖 401、開發環境 10 分鐘節流）。

### v2.11.0 (2026-09-24) - 手機介面優化、PWA 與 iOS 推播、權限修復

- **修正 — 登出後仍可看到 CSV 匯入／匯出**：`updateUIByRole()` 原本由各角色分支各自隱藏選單項目，訪客分支漏了 `csvToolBtn`，因此「先登入管理員再登出」就會殘留管理功能（後端 `requireAdmin` 仍會擋，但 UI 不該顯示）。現在改為**單一權限表 `CM_MENU_PERMISSIONS`**（guest／user／test／admin／super_admin／web_owner 一目了然），每次更新 UI 一律先套用該表，杜絕同類漏寫；`openCsvModal()` / `csvDownloadTemplate()` / `csvExport()` / `csvPickFile()` 另加 `isAdminUser()` 防護，即使被繞過也無法使用。
- **修正 — 「我的報名」顯示 migration 訊息**：該視窗原本有一行開發期留下的靜態文字（「報名紀錄需要資料庫已執行 v2.9.0 migration…」）。已移除，改為**依實際情況顯示狀態**：載入中／沒有紀錄／登入逾期（401）／資料庫尚未完成設定（503，直接顯示後端原文）／連線失敗。
- **新功能 — 可安裝成 App（PWA）＋ iOS 推播支援**：新增 `public/manifest.json` 與自製圖示（純 Python 產生 PNG／ICO，無外部套件、不放寬 CSP）。新增 `CMNotify.pushSupportState()` 判斷裝置能力：iOS 未加入主畫面時回傳 `ios-needs-homescreen` 並顯示逐步指引（而非「不支援」）；權限被拒、Android／桌面可安裝（`beforeinstallprompt`）也各有對應提示。**iOS 16.4+ 必須加入主畫面以獨立 App 開啟才能收到 Web Push。**
- **新功能 — 手機介面優化**：以 390×844 與 360×640 實測。標題列在 360px 仍為單行（≤360px 時選單只留 ☰）、篩選列手機版改兩欄（搜尋框滿寬，省下約兩行高度）、彈窗改用 `92dvh`／`94dvh`、卡片動作鈕最小高度 36px、`html, body { overflow-x: hidden }` 與長字串換行確保**橫向溢出為 0**、輸入框 16px 避免 iOS 聚焦放大、保留 iPhone 底部安全區域。
- **新功能 — 深連結 `?comp=<id>`**：推播通知（伺服器已帶此參數）與任何分享連結點擊後會自動切到列表、捲動並以動畫高亮目標賽事，處理後清除查詢字串；另支援 `?view=myregs` / `?view=notify`（manifest 捷徑）。
- **新功能 — 行程檔（.ics）與 Google 日曆**：我的報名每筆可下載 `.ics`（RFC5545 跳脫、CRLF、含 `VALARM` 前一天提醒）或直接開 Google 日曆新增行程，純前端產生、無外部依賴。
- **新功能 — 報名名單匯出 CSV**：管理員以上在隊伍編排視窗可匯出該場報名名單（姓名／隊伍／備註／報名時間）。
- **其他**：卡片名額顯示改為「N / M 人」＋「剩 X 個名額」或「🔒 名額已滿」；彈窗高度改用 `dvh` 類別（`.cm-modal-panel`）。
- **Testing**：`npm test` 共 **77 項**全綠（新增 `pushSupportState`／`isIosDevice`／`isStandalone` 單元測試，涵蓋 iOS 分頁、加入主畫面後、Android、權限被拒與桌機不支援）；headless Chrome 以 **390×844 手機尺寸**實測 v2.11.0 **41 項**全綠（版面、權限、我的報名、.ics 內容、深連結、名額、深色模式），並通過 v2.10.0（29）、v2.9.0（50）、v2.8.0（50）、v2.7.0（48）回歸。
- **資料庫**：不需新的 migration（v2.9.0／v2.10.0 的 migration 仍為必跑）。

### v2.10.0 (2026-09-24) - 手動上傳海報、Web Push 推播訂閱

- **Feature — 管理員手動上傳海報（取代自動生成）**：
  - 發佈／編輯表單新增「🖼️ 手動上傳海報（選填）」：選圖後**前端先縮圖**（最長邊 1600px、轉 JPEG 0.85，實測 2400×1600 的圖縮成 1600×1067／約 29KB）再上傳，附即時預覽與「移除海報」。
  - 卡片顯示「🖼️ 自訂海報」徽章；**分享海報視窗改為顯示上傳的圖**（沒有自訂海報時仍用原本的 Canvas 自動生成款式），標示「此海報由發佈者手動上傳／自動生成海報」。
  - 圖片以 base64 存於 `competition_posters`，由同源端點 `GET /api/competitions/:id/poster` 提供（`Cache-Control: public, max-age=86400`、`X-Content-Type-Options: nosniff`）。**選擇資料庫而非 Supabase Storage 的原因**：現有金鑰是 anon key（無法建立 bucket），且同源提供可**維持嚴格 CSP `img-src 'self'`**，不必新增任何外部網域。
  - 驗證：只接受 JPG／PNG／WebP（**明確拒絕 SVG**，避免腳本內容）、解碼後上限 3MB（超過回 `413`）、需管理員以上、寫入稽核日誌。
- **Feature — Web Push 推播訂閱服務**：
  - 「🔔 通知設定」新增「📲 推播訂閱」區塊：開啟訂閱／關閉訂閱／傳送推播測試，並即時顯示訂閱狀態；不支援 Push 的瀏覽器會停用按鈕並說明原因。
  - 開啟後**即使完全關閉網頁**也能收到通知：`public/sw.js` 新增 `push` 事件處理，伺服器端 `GET /api/cron/reminders` 由 **Vercel Cron 每日執行**（`vercel.json` 已設定），發送「🆕 新賽事」與「⏰ 即將開賽（24 小時內）」推播。
  - **VAPID 金鑰自動管理**：優先讀環境變數，否則首次使用時由伺服器產生並存進 `app_settings`——私鑰不寫進程式碼、不進 Git、也不需要手動設定環境變數。
  - 防擾與清理：`push_log` 對「同一賽事×同一類型」去重；端點失效（HTTP 404／410）自動標記 `is_active=false`；未設定 `CRON_SECRET` 時 cron 端點限制每 10 分鐘一次（Vercel 會自動帶上 `CRON_SECRET`）。
- **修正 — v2.9.0 migration 的 RLS**：`enable row level security` 對 anon key 會造成新資料表完全無法寫入。v2.10.0 的 migration 會關閉這些資料表的 RLS（可安全地對已執行過 v2.9.0 的資料庫重複執行）。
- **依賴**：新增 `web-push`（僅伺服器端）。
- **Testing**：`npm test` 共 **74 項**全綠（新增海報／推播單元測試與 API 端到端測試，含授權、格式、大小、訂閱、去重與 cron 驗證）；headless Chrome 實測 v2.10.0 **29 項**全綠，並通過 v2.9.0（50）、v2.8.0（47）、v2.7.0（48）回歸。

### v2.9.0 (2026-09-24) - 普通用戶報名、組隊比賽與隊伍編排

- **Feature — 普通用戶（`user` 角色）與帳號註冊**：
  - 登入視窗新增「註冊新帳號」模式（帳號 3~20 個英數或底線、密碼 6~64 個英數、需二次確認），註冊成功即自動登入並取得 12 小時 JWT。
  - 選單新增「📝 我的報名」：查看自己的報名紀錄（含賽事日期/地點/隊伍/備註）並可自行取消；一般用戶看不到「發佈賽事」與管理員工具。
  - 防濫用：同一 IP 每小時最多 5 次註冊嘗試；可用環境變數 `REGISTRATION_CODE` 設定邀請碼（有設定時前端才顯示邀請碼欄位）。
- **Feature — 報名參加比賽（未登入會先被要求登入）**：
  - 每張卡片新增「📝 報名」按鈕；**訪客點擊時先開啟登入／註冊視窗**（並說明原因），登入後才能報名。
  - 報名開放與否由後端純函式 `registrationState()` 權威判斷：未開放報名、報名截止日已過、賽事已結束、名額已滿、重複報名各有明確理由（前端顯示同步規則，但一律以後端回應為準）。
  - 報名紀錄寫入 `registrations` 資料表並寫入稽核日誌；取消為軟刪除（`is_deleted`），取消後可重新報名。
  - 公開端點 `GET /api/registration-counts` 提供各場報名人數（僅聚合數字，不含個資），卡片據此顯示「👥 N 人已報名」。
- **Feature — 組隊比賽與隊伍編排**：
  - 賽事新增 `is_team_event`（組隊比賽）與 `team_size`（每隊人數上限）；組隊比賽報名時必須填寫隊伍名稱（存於 `registrations.team_name`）。
  - 管理員以上：卡片新增「👥 報名／隊伍」按鈕，開啟編排視窗可建立隊伍（`competition_teams`）、把報名者編入／移動隊伍、檢視未編排名單；編排會檢查「同一場賽事」與隊伍人數上限。
  - 超級管理員以上：可刪除隊伍（隊員自動退回未編排）與移除隊員；權限於後端 `requireAdmin` / `requireSuperAdmin` 驗證，前端亦依角色隱藏按鈕（一般用戶完全看不到管理按鈕）。
- **Feature — 報名截止與名額上限**：賽事新增 `registration_deadline` 與 `max_registrations`；額滿或截止後按鈕變為「🔒 已額滿／🔒 報名已截止」並停用送出。
- **Security — 密碼雜湊**：`crypto.scrypt` 加鹽雜湊（`scrypt$salt$hash` + `timingSafeEqual` 驗證），新註冊與變更密碼皆雜湊儲存；既有明碼帳號維持可登入，於變更密碼時自動升級。
- **資料庫**：需執行 `migrations/2026-09-24-v2.9.0-users-registration-teams.sql`（新增 `registrations`、`competition_teams`，以及供 v2.10.0 使用的 `push_subscriptions`、`push_log`，並新增賽事欄位）。**未執行時所有既有功能完全不受影響**：新端點回 503 並附上明確的 migration 指示，發佈／編輯賽事不帶新欄位時照常運作（已以獨立測試驗證）。
- **Testing**：新增 `tests/support/fake-supabase.js`（模擬 PostgREST 的假資料庫，含唯一鍵、缺表／缺欄位情境），並以真實 Express app + 真實 JWT 跑報名、隊伍、權限、雜湊登入的端到端測試（完全不碰正式資料庫）；`npm test` 共 62 項全綠，瀏覽器實測 50 項全綠。

### v2.8.0 (2026-09-23) - 訊息提醒、一鍵匯入/匯出 CSV、專案清理

- **Feature — 訊息提醒（Web Notification）**：
  - 選單新增「🔔 通知設定」：啟用／關閉通知、「新賽事發布時通知我」開關、訂閱清單管理、傳送測試通知；狀態列明確顯示瀏覽器權限狀態（未決定／已允許／被封鎖，被封鎖時提示如何重新允許）。
  - 每張賽事卡片新增「🔕 訂閱提醒 / 🔔 已訂閱」按鈕，任何人皆可使用（純本機偏好、不需登入）。已訂閱賽事在**開賽前 24 小時內**跳出一則提醒（顯示約幾小時後開始）。
  - 新增 `public/sw.js`（極簡 Service Worker）：Android Chrome 不允許 `new Notification()`，通知必須由 `registration.showNotification()` 顯示；點通知會聚焦既有分頁。
  - 防擾設計：第一次執行只建立「看過的最大 id」基準，不會把既有賽事全部當成新賽事灌通知；同一事件只通知一次（新賽事以組合 key 記住、開賽提醒以場次＋日期＋時間記住）；已通知紀錄保留 30 天後自動清理。
  - 誠實說明限制：**未串接 Web Push（VAPID）**，因此完全關閉網頁時不會收到通知；提醒在開啟頁面、切回分頁與每 5 分鐘檢查一次。設定與訂閱只存在該裝置的 `localStorage`，不上傳。
- **Feature — 一鍵匯入 / 匯出 CSV**（管理員以上）：
  - 管理員選單新增「📥 CSV 匯入 / 匯出」：⬇️ 匯出全部賽事、📄 下載匯入範本、📤 選擇 CSV 檔案，並顯示匯入說明。
  - 匯入支援 Excel 另存的 CSV（UTF-8）或直接從 Excel 複製的 Tab 分隔內容；自動判斷逗號／Tab／分號分隔，欄位順序不拘、表頭可用中文或英文、缺欄位或多餘欄位都能容忍。
  - 上傳後**先在前端預覽**（總筆數、可匯入筆數、格式錯誤筆數與原因、分隔符），確認後才送出；後端以**同一份規則**再驗證一次（前端只是體驗，後端才是權威），匯入與匯出共用 `public/js/csv.js`（UMD，手寫 RFC4180 解析器）。
  - 重複判定為「名稱＋開始日期」相同（忽略大小寫與前後空白），重複列自動跳過並回報原始列號；單次上限 500 筆。
  - 匯出檔為 UTF-8（含 BOM，Excel 開啟不亂碼）、CRLF 換行、中文表頭，並寫入 `EXPORT_COMPETITIONS` 稽核紀錄；匯入則寫入 `IMPORT_COMPETITIONS`。
  - 容錯：格式錯誤的列不會讓整批失敗——成功新增、重複跳過、錯誤列及其原因分開回報；資料庫尚未執行 v2.7.0 migration 時，匯入仍可成功（略過分類／標籤欄位並明確警告）。
  - **本版不需要新的資料庫 migration。**
- **Change — 刪除多餘程式碼與檔案**：
  - 刪除 `.kilo/`（殘留的舊版 git worktree 副本，內含 2.9 MB 重複的 `tailwind.min.css`）、`README 3.md`、`public/js/app 2.js` 等重複檔案，以及 `.DS_Store`；並以 `git worktree prune` 清掉失效的 worktree 註冊。
  - 移除未使用的程式碼：`.cal-empty` CSS 規則、`app.__test__.isProductionFlag` 匯出。
  - 補齊新程式碼用到的顏色 class 與變數（`border-amber-200`、`text-amber-600`、`hover:bg-emerald-50`、`hover:bg-emerald-200`），維持「class 皆有規則、`--cm-*` 變數三份票一致、無未使用變數」的覆蓋率檢查通過。
- **Tests**：`npm test` 由 6 個增加到 **36 個**測試（CSV 解析／正規化／往返、匯入匯出 API 端到端含假 Supabase、資料庫未 migration 情境、通知判斷邏輯）；瀏覽器實測 47 項（通知流程、CSV 介面）與 v2.7.0 回歸 48 項全數通過。

### v2.7.0 (2026-09-23) - 賽事分類與標籤系統、日曆檢視模式

- **Feature — 賽事分類與標籤**：
  - `competitions` 新增 `category`（單選，10 種含 emoji 與專屬色系）與 `tags`（`text[]`，最多 10 個、每個 24 字元）。
  - 分類清單集中定義於 `server.js` 的 `COMPETITION_CATEGORIES`，由 `GET /api/meta` 提供給前端，避免前後端各寫一份而不同步。
  - 後端正規化：分類只接受清單內的值（其餘視為未分類）；標籤接受陣列或字串（支援逗號／頓號／分號／換行分隔），自動去 `#`、去空白、去重（忽略大小寫）並限量。
  - 列表新增分類與標籤篩選器（標籤選項由既有資料歸納），可與關鍵字、日期條件聯合套用。
  - **需先執行 `migrations/2026-09-23-v2.7.0-competition-category-tags.sql`**；未執行時不會壞掉，儲存時會回傳明確的指示訊息。
- **Feature — 日曆檢視模式**：
  - 列表頁新增「📋 列表 / 📅 日曆」切換（`aria-pressed` 同步、選擇以 `cm-view` 記住）。
  - 月曆顯示每日賽事並依分類上色；**跨日賽事會展開到涵蓋的每一天**（上限 400 天防呆）；單日超過 3 場顯示「+N 更多」。
  - 點日期開啟當天清單面板，沿用列表卡片樣板（複製文字／分享海報／編輯／刪除行為完全一致）；今天與選取日期各有不同外框，可一鍵回「今天」。
  - 手機版（≤640px）自動改為顏色圓點，避免文字溢出。
  - 純手寫模組（`public/js/calendar.js`），無任何外部套件 —— CSP 為 `script-src 'self'`，不可載入 CDN。
- **Refactor**：
  - 卡片 HTML 抽成 `competitionCardHtml()`，列表與日曆共用，避免兩份樣板日後不同步。
  - 事件委派由 `#competitionList` 改綁在 `main#mainContent`，涵蓋日曆的當天清單。
  - 主題色票沿用既有 `--cm-*` 變數（未新增任何變數），分類與日曆在深淺色下自動同步。
- **Tests**：新增 `tests/helpers.test.js`（分類/標籤正規化、migration 偵測、分類清單完整性），`npm test` 共 6 項；另以 headless Chrome 實測 48 項 UI 行為。

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
