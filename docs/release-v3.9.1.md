# v3.9.1 — 系列賽「超表＝0 分」修正、掃碼提示競態修正、示範系列賽、ZAP 第三份報告處置

發佈日期：2026-09-27

## 一、這次修的三件事（都是實際會遇到的）

### 1. 系列賽：超表（未完賽／未出賽／取消資格）＝0 分，而且要留在榜上

**問題**：`GET /api/series/:id/standings` 只要某場成績沒有名次（`rank` 為空）就**整筆濾掉**。
後果是「有報名、有出賽、但未完賽」的選手在系列排行裡**完全看不到**，家長會直接來問「我孩子明明有跑」。

**修法**：成績狀態的判斷只有一份（`public/js/results.js` 新增 `isNonFinish()`／`NON_FINISH_STATUSES`），
端點改成「有名次的照算；沒有名次但狀態是 `dnf`／`dns`／`dsq` 的也要留下來，計 0 分」。
排行榜每一場的明細會顯示「未完賽 +0」而不是空白；`count_best`（只取最好 N 場）仍然只挑得分高的那幾場。

**順帶修掉一個顯示錯誤**：`Number(null)` 是 0，原本會讓超表的人變成「第 0 名」；
現在名次一定要是**正的整數**才算有名次。

### 2. 掃碼報到：慢回來的相機失敗會蓋掉正確的提示

**問題**（在整套瀏覽器檢查裡連兩版偶發紅燈，追下去才發現是真 bug）：
管理員按「📷 掃碼報到」→ 相機還在要權限 → 使用者等不及、改成自己輸入報到碼（或這台裝置其實沒有掃碼功能）→
**那次「慢的失敗」回來時把提示覆寫成「拿不到相機權限」**，畫面顯示的訊息與現況不符。

**修法**（`public/js/app.js`）：每次啟動掃碼發一個序號，停止或重新啟動就作廢前一次；
等到的鏡頭如果已經過期要**關掉**（不留著開），失敗回來時如果已經不是那一次、或裝置其實不支援掃碼，就不要再改提示。

**驗證**：`tests/browser/checkin-qr-check.js` 新增「慢的相機失敗不可以蓋掉後來的畫面」三段斷言，
並把相機換成**檢查自己控制的假相機**（可設延遲、一定失敗）——不再依賴無頭瀏覽器的相機權限狀態（那正是偶發紅燈的來源）。
RED 驗證：把 `app.js` 還原成 v3.9.0 的寫法 → 斷言轉紅且訊息與線上偶發的完全相同。

### 3. 示範系列賽（可一鍵建立／移除）

新增 `scripts/demo-series.mjs`：用**自家 API**（不直連資料庫）建立一個明確標示「【示範】」的兩場系列賽、
報名、成績（含一位未完賽）與公布，最後**自己讀回排行印出來**。驗完 `--remove` 一次清掉。

```bash
node scripts/demo-series.mjs            # 建立（已存在會拒絕，除非 --force）
node scripts/demo-series.mjs --remove   # 移除所有「【示範】…」的賽事
```

## 二、ZAP 報告（2026-09-27 第三份，使用者提供）處置

這份報告的掃描結果與前一份不同（含 Chrome 自己的流量：`update.googleapis.com`、`content-autofill.googleapis.com`），
13 個實例裡只有 3 類與本站有關：

| 告警 | 風險 | 實例 | 判讀與處置 |
|---|---|---|---|
| 跨域配置错误 | 中 | `GET /manifest.json`（`Access-Control-Allow-Origin: *`） | **是真的、已修**：`/js`、`/css` 有我們的規則，但**根目錄的靜態檔**（`manifest.json`、`sw.js`、`favicon.ico`、`icons/*`）拿到的是 Vercel CDN 預設的 `*` → 讀得到的東西任何網站都能讀。`vercel.json` 新增規則把這些檔的 ACAO 收成自家來源，並加 `Cross-Origin-Resource-Policy: same-origin` |
| Strict-Transport-Security Header Not Set | 低 | `content-autofill.googleapis.com` | **不是本站**（Chrome 的服務）；本站實測有 `max-age=31536000; includeSubDomains` |
| Suspicious Comments | 提示 | `GET /js/competition-state.js` | **命中我自己寫的註解**（`\bUSERNAME\b`）。已把註解裡的 `username` 改掉（`results.js`、`app.js` 一起），程式碼不動 |
| Information in Browser localStorage | 提示 | `GET /` | 是通知偏好 `cm-notify`（沒有憑證；權杖在 HttpOnly cookie）。維持現狀 |
| Re-examine Cache-control Directives | 提示 | `GET /`（`public, max-age=0`） | 首頁是單頁應用的殼，改成 `no-cache, no-store, must-revalidate`（避免共享快取留存） |
| Retrieved from Cache、Tech Detected（HSTS／HTTP/3／OpenGSE／PWA／Tailwind／Vercel） | 提示 | — | 技術指紋與 CDN 快取，不是問題 |

## 三、測試結果

| 項目 | 結果 |
|---|---|
| `npm test` | **678 通過 / 0 失敗**（v3.9.0 為 672；新增 `tests/non-finish-status.test.js` 3 項、`series-review.test.js` +2、`v390-api.test.js` +1） |
| `npm run check:coverage` | 每一條路由都至少被一個測試提到 |
| `npm run check:browser` | 28 支套件、**968 項 0 失敗**（`checkin-qr-check.js` 28 → **32 項**；`v390-check.js` 23 → **25 項**） |
| `npm run check:prod` | 正式站 HTTP 煙霧 **109** ＋訪客視角 **12** ＋線上樣式 **16** ＋彈窗尺寸 **41**，全 0 失敗 |
| 路由 | 快照不變（**114 條**，這次沒有新增端點） |

**RED 驗證**：系列賽的超表規則（拿掉 `isNonFinish` 判斷 → 對應測試轉紅）、掃碼競態（還原 v3.9.0 的 catch → 斷言轉紅）。

## 四、檔案異動

- `public/js/results.js`、`public/js/competition-state.js`、`public/js/review.js`、`public/js/app.js`
- `routes/competitions.js`（系列排行的成績過濾）、`vercel.json`（靜態檔標頭、首頁不快取）
- `scripts/demo-series.mjs`（新）、`tests/non-finish-status.test.js`（新）、`tests/series-review.test.js`、`tests/v390-api.test.js`、`tests/browser/checkin-qr-check.js`、`tests/browser/v390-check.js`

**無 migration、無新增端點、CSP 不變、無新增前端套件。**
