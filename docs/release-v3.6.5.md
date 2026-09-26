# v3.6.5 — QR 掃碼報到

> Roadmap 8.7⑤ 的第二階段。v3.6.2 讓現場報到「在名單上點一下」可行；
> 這版讓排隊更快：選手出示 QR，或把 8 碼報到碼唸給工作人員。

## 這版做了什麼

**選手（我的報名）**：正取的每一筆報名多一個「📷 報到碼 / QR（現場出示）」按鈕 → 彈窗顯示
**8 碼報到碼**與一張 **QR**（內容 `CM1:XXXXXXXX`）。候補沒有報到碼（還沒拿到資格）。

**管理員（現場報到）**：多一列「📷 掃碼報到 ｜ 或輸入 8 碼報到碼 ｜ 簽到」

| 方式 | 怎麼用 |
|---|---|
| 掃碼 | 按「📷 掃碼報到」→ 鏡頭對準選手的 QR → 自動完成（不用按快門） |
| 手打 | 輸入 8 碼後按「簽到」或 Enter（**小寫、空白、連字號都容錯**） |
| 名單 | 照舊在名單上點「簽到」（三種方式都會留稽核） |

回報會說清楚結果：「player-qr 已簽到（掃碼盃）」、「已經簽到過了（時間，由誰簽）」、
「找不到報到碼 ZZZZ9999 對應的報名紀錄」、「只有『正取』可以簽到（目前是候補）：請先核准或遞補」。

## 兩個誠實的技術限制（都很重要）

1. **iPhone／iPad 的瀏覽器沒有掃碼 API**。`BarcodeDetector` 只有 Android 與桌面版 Chrome 有；
   iOS 上所有瀏覽器都用 WebKit，沒有這個 API。所以：
   - 「輸入 8 碼報到碼」**不是備援，是另一條主要路徑**；
   - 沒有掃碼能力的裝置按下按鈕時**直接說明要用輸入**，不會開一個永遠掃不到東西的畫面；
   - 這一條路由瀏覽器檢查**模擬 iPhone**（把 `BarcodeDetector` 拿掉）實際驗過。
2. **報到碼不可猜**。掃報名編號會被猜到（任何人都能幫別人簽到），所以另發 8 碼、
   字母表去掉容易看錯的 I／L／O／0／1、同賽事內唯一、要用才產生（既有資料不批次改寫）。

## 手寫的 QR 產生器（`public/js/qr.js`）

專案不放前端外部套件、CSP 是 `script-src 'self'`，所以自己寫。刻意只做夠用的範圍：
byte mode、錯誤修正等級 M、版本 1–3（都是**單一 RS 區塊**，不需交錯）、輸出 SVG。

**怎麼證明它真的能掃**（自己驗自己不算驗）：
- ① 結構：定位圖樣、計時列、暗模組、邊長（`tests/qr.test.js`）
- ② 反向讀回：測試裡**另外寫一份**照規範的讀取器，把資料位元流讀回來還原文字
- ③ **真正解碼**：把矩陣畫成 PNG，交給 **macOS Vision**（`scripts/qr-decode.swift`）解
  ——解出來的內容必須一模一樣（ASCII 與中文各一組）

★ 第 ③ 層立刻抓到一個真 bug：**格式資訊的位元順序寫反**（規範是最高位先擺）。
前兩層因為用同一套錯誤假設而「驗過」，只有第三方解碼器能發現——當時畫面上完全看不出問題，
真的拿去現場才會發現掃不到。

## 介面調整：掃碼區預設收合

第一版把「掃碼／輸入報到碼」那一列直接攤開，結果把下面的名單往下推——候補排序的拖曳是靠事件座標
（`elementFromPoint`）找要放下的那一列，名單被推出彈窗的可視範圍後拖曳就靜默失效。改成
**按「📷 掃碼／輸入」才展開**（預設不佔高度），並修正候補檢查：**拖曳前先 `scrollIntoView`**
（真實使用者本來就會先看到那一列，測試原本只是在賭版面剛好）。

## 變更檔案

- `migrations/2026-09-27-v3.6.5-checkin-code.sql`（已套用）：`registrations.checkin_code` ＋
  同賽事內唯一索引（`where checkin_code is not null`，可重複執行）。
- `routes/registrations.js`：報到碼產生器（撞碼重試、lazy 產生）、
  `POST /api/registrations/attendance-by-code`、`/api/my/registrations` 帶出報到碼。
- `server.js`：`CHECKIN_HINT`、`checkinSchemaReady`。
- `public/js/qr.js`（新）：手寫 QR 產生器。
- `public/index.html`／`public/js/app.js`：掃碼列、報到碼彈窗、QR 顯示、BarcodeDetector 掃描迴圈。
- `public/js/guide.js`：現場報到段落改寫（三種方式＋iPhone 限制）。
- `scripts/qr-decode.swift`（新，開發用）：Vision 解碼器。
- `tests/qr.test.js`、`tests/checkin-code.test.js`、`tests/browser/checkin-qr-check.js`（新）。
- `tests/guide.test.js`、`tests/browser/guide-check.js`：翻轉斷言（v3.6.2 曾驗「不可以提到 QR」，
  現在改驗「要寫出掃碼與手打兩條路」）。
- `tests/browser/waitlist-extra-check.js`：拖曳前先捲動到看得見的位置（修掉「靠版面剛好才過」的假守門）。

## 驗證

| 檢查 | 結果 |
|---|---|
| `npm test` | **610 通過 / 0 失敗**（新增 `qr.test.js` 4 段、`checkin-code.test.js` 7 段） |
| QR 真實解碼 | macOS Vision 解得出來（ASCII ＋ 中文各一組），逐位元一致 |
| 瀏覽器檢查 | 新增 `checkin-qr-check.js` **28 項**（含模擬 iPhone 的降級路徑、選手端 QR 渲染、重複掃描、候補擋下） |
| 路由覆蓋 | **99／99** |
| 正式站 `check:prod` | 全綠；線上為 v3.6.5 |
| 錯誤日誌 | 發版前後筆數不變 |

## 未做

- QR 掃碼**只在有 BarcodeDetector 的裝置**能用（見上面限制）；沒有為 iOS 額外引入解碼函式庫
  （那會破壞「無前端外部套件」與 CSP 的既有原則）。
- 報到碼沒有做「換一組」按鈕（碼外洩時的補救）：目前只能由管理員直接改資料庫。
