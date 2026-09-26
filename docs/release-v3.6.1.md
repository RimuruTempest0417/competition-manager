# v3.6.1 — 錯誤日誌：截圖上限、列表瘦身、截圖改為按下才下載

發佈日：2026-09-27（Roadmap 8.6 ④）

## 問題（兩個，都跟「未登入可寫」有關）

| # | 問題 | 實際風險 |
|---|---|---|
| ① | `POST /api/logs/error` 未登入就能寫，而 `screenshot` 是**整包原封不動存進資料庫**（只有 `stack_trace` 裡那 100 字是截斷過的） | 全域 body 上限是 **10mb**、這個端點每分鐘允許 30 次 → 匿名者一次可寫進約 10MB，一小時約 18GB 等級的寫入量；而且沒有任何格式檢查（愛存什麼就存什麼） |
| ② | `GET /api/admin/error-logs` 用 `select('*')` 把 base64 **整包拉回來**，前端再 render 成 `<img>` | 列表一次 200 筆，只要裡面有幾張截圖，回應就是數 MB，後台開啟錯誤日誌會明顯變慢 |

## 修法

1. **這個端點單獨的小 body 上限（512kb）**：`server.js` 在全域 `express.json({limit:'10mb'})` **之前**為 `/api/logs/error` 掛上 512kb 的 JSON／urlencoded 解析器（body-parser 先解析者勝，所以順序不能顛倒）。海報／規程上傳需要的 10mb 額度不受影響。
2. **只接受真正的圖片且在上限內**：必須是 `data:image/(png|jpeg|webp|gif);base64,` 開頭、base64 字元集正確、長度 ≤ **400,000 字元**（約 300KB 圖檔）。
   - 不合法或過大 → **丟掉圖片，但錯誤照樣記下來**（錯誤日誌的用途是「知道有錯」，不能因為截圖不合格就整筆消失），並在 `stack_trace` 留下原因（`[Screenshot Dropped: 圖片過大（… 上限 400000）]`／`不是合法的 data:image 資料`），前端據此不顯示檢視按鈕。
   - 合法 → 存檔並在 `stack_trace` 留下 `[Screenshot Attached ...]` 標記（維持原本行為）。
3. **列表瘦身**：改成明確列出欄位（**不含 `screenshot`**），並回傳 `has_screenshot`（由 `stack_trace` 的標記算出）告訴前端「這筆有沒有圖」。
4. **截圖改為按下才下載**：新增 `GET /api/admin/error-logs/:id/screenshot`（**只有超級管理員以上**，一般使用者與 admin 都 403），前端把原本內嵌的 `<img>` 換成「🖼️ 檢視截圖」按鈕，按下去才抓那一筆並在彈窗顯示。

## 實測數據（皆實跑）

| 項目 | 修正前 | 修正後 |
|---|---|---|
| 列表回應大小（資料庫裡有一筆 400KB 截圖） | **400,974 位元組** | **936 位元組** |
| 列表 DOM 內嵌圖片數 | 1 張（整包 base64 進 DOM） | **0 張** |
| 匿名可送的 body 上限 | 10mb | **512kb**（超過回 413，並留一筆警告級 `request_body_too_large` 紀錄） |
| 截圖格式／大小檢查 | 無 | 必須是 `data:image/...;base64,` 且 ≤ 400,000 字元；不合格只丟圖片、照記錯誤 |
| 誰能看截圖 | 任何看得到列表的人（含 admin） | **只有 super_admin／web_owner** |

## 順手修／過程中學到的

- **假 Supabase 新增 `select` 欄位投影**（`tests/support/fake-supabase.js`）：它原本只檢查「欄位不存在」而**回傳整列**，比真實 PostgREST 寬鬆——「列表不該帶 screenshot」這種斷言因此驗不出來。現在會照着 `select(...)` 投影，測試才跟正式行為一致（這也讓下面那一項被抓到）。
- **RED 驗證的還原覆蓋掉修正**：驗證「列表改回 `select('*')` 會轉紅」時，還原步驟把我**先前修好的那一行**一起蓋回去了；單元測試當時還是綠的（因為投影讓它讀不到 screenshot 欄位），是**瀏覽器檢查量到列表回應 400,974 位元組**才把它抓出來。教訓：RED 實驗後不能只比對「與快照一致」，要重新 grep 關鍵行並重跑會量實際輸出大小的檢查。

## 測試

| 項目 | 結果 |
|---|---|
| 新增 `tests/error-log-limits.test.js` | 截圖存／丟、413、列表欄位與大小、截圖端點權限（401／403／404／400）與內容 |
| 新增 `tests/browser/error-log-screenshot-check.js` | **21 項**：列表回應實際大小、按鈕只出現在真的有圖那筆、按下才請求一次、圖片真的顯示、手機不溢出、無前端例外 |
| RED 驗證 | ①改回 `select('*')` → 轉紅；②拿掉截圖格式檢查 → 轉紅；還原後綠燈 |
| 完整套件 | `npm test` 全綠；瀏覽器檢查 **22 支套件**全綠 |

## 檔案

- 新增：`tests/error-log-limits.test.js`、`tests/browser/error-log-screenshot-check.js`
- 修改：`routes/error-logs.js`（驗證、上限、列表瘦身、截圖端點）、`server.js`（該路徑 512kb body 上限）、
  `public/js/app.js`（按鈕與截圖彈窗）、`public/index.html`（截圖彈窗）、`tests/support/fake-supabase.js`（欄位投影）、
  `tests/fixtures/route-inventory.json`（路由 101→104：新端點＋2 層中介層）、`package.json`
- **未動**：資料庫結構（沒有 migration）、CSP、`/api/logs/error` 的節流規則、`.env`、任何套件
