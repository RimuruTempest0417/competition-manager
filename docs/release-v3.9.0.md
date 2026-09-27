# v3.9.0 — 回顧報告、系列賽總積分、報名表自訂欄位（附 ZAP 報告處置）

發佈日期：2026-09-27

---

## 一、為什麼做這三件事

比賽辦完之後，主辦手上其實什麼都沒有：報名人數要自己數、誰有來要翻名單、
「這張海報到底有沒有效」完全不知道。而報名表固定只有姓名＋備註，
連「衣服尺寸」「是否吃素」都得靠 Line 一個一個問。

這一版把「賽後」與「賽前」兩端補起來：

| 功能 | 解決的問題 |
|---|---|
| 📊 **賽事回顧報告** | 賽事結束後一鍵看到：報名／到場率／成績頒獎台／分享成效 |
| 🏆 **系列賽總積分** | 同一個系列好幾場，自動把名次換成積分累加排名 |
| 📝 **報名表自訂欄位** | 主辦自己定義要收什麼資料（文字／數字／下拉／勾選／日期） |

設計原則（延續全專案）：**純手寫、無前端外部套件、CSP 維持嚴格**
（`script-src 'self'`／`style-src 'self'`）；圖表是手寫 SVG。

---

## 二、賽事回顧報告

- 賽事**開打或結束後**，卡片上出現「📊 回顧報告」（沒有 QR、不用登入也能看）。
- 內容：報名總數／正取／候補／待審核、**到場率圓環**（手寫 SVG）、
  成績頒獎台（🥇🥈🥉）、屬於系列時給一個「看總積分」入口。
- **分享成效只給管理員看**（那是宣傳內部資訊）；其他人看到的是公開欄位。
- 端點：`GET /api/competitions/:id/review`（公開；帶管理員身分時才回分享成效）。
- 「📋 複製文字摘要」：主辦可以直接貼到群組公告。

**到場率算不出來時就說算不出來**：沒有正取（沒有分母）→ 回 `null`，
畫面顯示「還沒有人簽到，所以算不出到場率」，不硬掰一個 0%。

---

## 三、系列賽總積分

- 系列＝既有的週期性賽事（根賽事 ＋ `recurrence_parent_id` 指過來的子場次），**不新增資料結構**。
- 積分規則放在系列根賽事：`series_points = { points: [10,8,6,5,…], count_best: 0 }`。
  預設第 1～8 名 = 10／8／6／5／4／3／2／1 分。
- **名次超出積分表 → 0 分**（不給「安慰分數」，否則排行榜看起來人人有分）。
- `count_best > 0` → 只取最好的 N 場計分，但**每一場的出賽紀錄仍然全部列出**。
- 同分比最佳名次，再同比名字 → 排名**穩定可重現**。
- 端點：`GET /api/series/:id/standings`（從任何一場子場次查都會回到同一個系列）。
- 「看每一場的名次與得分」可以展開成完整表格。

---

## 四、報名表自訂欄位

- 主辦在賽事表單的「📝 報名表自訂欄位」新增欄位：**最多 10 個**，
  型別＝單行文字／多行文字／數字／下拉選單／勾選（是／否）／日期。
- 報名的人看到的欄位與主辦設定一致；必填沒填會**逐欄顯示紅字**（不是只彈一句錯誤）。
- 答案存進 `registrations.form_answers`，出現在**報名名單、我的報名、匯出的 CSV**。
- 驗證規則是**前後端共用同一份**（`public/js/form-fields.js`）：
  前端只是先擋，後端才是權威（前端可以繞過，後端不會）。
- 安全：**白名單**——沒定義的欄位就算送進來也不會被存；
  超長內容一律截斷（多行 500 字／單行 200 字）；下拉只能挑選項裡的值。
- **★既有欄位的 key 不會因為改標籤而改變**（不然已經報名的人填過的答案會全部對不上）。
  這一條是瀏覽器檢查抓出來的，已固化成斷言。

---

## 五、ZAP 報告（`2026-09-27-ZAP-Report--2.html`）處置

報告的告警是「我方站點 1 個中風險、9 個資訊提示、0 高風險、0 低風險」。

| 告警 | 風險 | 判定與處置 |
|---|---|---|
| **跨域配置错误**（`GET /js/guide.js` 回應帶 `Access-Control-Allow-Origin: *`） | 中 | **不是我們的伺服器加的**：實測該回應是 `Server: Vercel` ＋ `X-Vercel-Cache: HIT`，也就是**平台對公開靜態檔的預設 CDN 行為**。我們的 API 已實測：帶 `Origin: https://evil.example` 時**完全不回** `Access-Control-Allow-Origin`（只反射自家來源、且帶 `Vary: Origin`）。本版仍加了一組 `vercel.json` 規則（`/js/*`、`/css/*`）明示自家來源 ＋ `Cross-Origin-Resource-Policy: same-origin`，並在部署後讀回確認。 |
| Strict-Transport-Security 未設定 | 低 | **我們本來就有**：`vercel.json`（所有路徑）＋ Express 中間件都送 `max-age=31536000; includeSubDomains`。報告那兩條是掃到 `update.googleapis.com`（Chrome 自己的更新服務），不屬於本站。 |
| Information Disclosure - Information in Browser localStorage | 提示 | **本版修正**：原本把整個 `currentUser` 物件寫進 localStorage，現在只寫白名單欄位 `{ id, username, role }`（前端也只用到這三個）。舊資料讀出時一樣過白名單，下次寫入自動縮小。 |
| Re-examine Cache-control Directives | 提示 | API 早已是 `Cache-Control: no-store`（實測確認）；靜態資產是 `public, max-age=0, must-revalidate`＝每次都回源驗證，比長快取更保守，**維持不變**。 |
| Information Disclosure - Suspicious Comments | 提示 | **判定為誤報**：被標記的是使用說明文字（例如「註冊時帳號與密碼只能用英文字母與數字」）與 DOM id（`loginPassword`），不是洩漏的註解。 |
| Tech Detected（Tailwind／Vercel／PWA／HTTP/3…） | 提示 | 技術識別，無法也不會隱藏。 |

報告檔案本身**不進版控**（`.gitignore` 已含 `*ZAP-Report*.html`）。

---

## 六、驗證

| 項目 | 結果 |
|---|---|
| `npm test` | **672 通過 / 0 失敗**（v3.8.2 為 644） |
| `npm run check:browser` | **28 支套件全綠**（新增 `v390-check.js` 23 項） |
| `npm run check:coverage` | 每一條路由都有測試或檢查涵蓋 |
| 新增守門 | `tests/route-ctx.test.js`（routes 解構的 ctx 欄位 server.js 必須提供） |
| 新測試 | `tests/form-fields.test.js`（9）、`tests/series-review.test.js`（7）、`tests/v390-api.test.js`（10） |
| 路由 | 112 → **114 條**（新增回顧報告、系列總積分） |
| 資料庫 | `migrations/2026-09-27-v3.9.0-review-series-form.sql` 已套用（三個 jsonb 欄位 ＋ 系列索引） |

### 這一版自己抓到的兩個真 bug（都固化成測試）

1. **編輯欄位後既有 key 被重新產生**：在表單改個標籤，`size` 會變成 `f` →
   已經報名的人填過的答案全部對不上。**由瀏覽器檢查抓到**（`node --test` 抓不到）。
2. **成績表整片空白**：成績表與報名名單共用同一個表格渲染函式，
   我在裡面用了只有名單那條路徑才有的變數 → `comp is not defined`。
   **由既有的 `results-check` 抓到**（證明既有檢查有在擋）。

另外修好一個守門自己的 bug：`tests/route-ctx.test.js` 一開始把檔名組成
`require('./routes/xxx.js')`（多了 `.js`），比對不到 → 整支檢查靜默跳過、
形同虛設。修好後做了 RED 驗證（故意少傳一個 ctx 欄位 → 檢查確實變紅）。
