# v2.14.0 — 登入鎖定改「帳號 + IP」、錯誤日誌主動提示、錯誤日誌自動巡檢

發佈日期：2026-09-26

## 一、登入鎖定不再能被用來阻斷他人帳號（安全性）

原本的失敗計數只以「帳號」為鍵：任何人都可以對你的帳號連續打錯密碼，把你鎖在門外（DoS）。
v2.14.0 改為雙重計數：

- **來源 IP**：連續失敗 10 次／15 分鐘 → 只擋這個 IP（訊息：「嘗試次數過多，請於 N 分鐘後再試」）。
- **帳號**：失敗 10 次**且來自 2 個以上不同 IP** → 才判定為多來源攻擊並鎖定帳號，同時寫入 `login_lockout` 錯誤日誌留下證據。
- 單一 IP 打錯 5 次（舊門檻）不再鎖帳號；成功登入會同時清除該帳號與該 IP 的計數。

## 二、未處理錯誤日誌主動提示（不用再自己翻後台）

- 新增 `GET /api/admin/error-logs/summary`：回傳未處理統計（僅數字與時間，不含任何日誌訊息或金鑰）。
- 登入回應附帶同一份統計；**超級管理員以上**登入後即顯示黃色提示橫幅：未處理錯誤數、近 24 小時新增、最新發生時間。
- 導覽選單顯示 `🚨 錯誤日誌 (N)` 計數；橫幅可按「查看日誌」直接開啟日誌視窗。
- 「稍後再看」只記住當下的最新時間，**有更新的錯誤才會再次提示**；全部處理完後自動消失。
- 一般管理員不會收到提示（他們沒有權限開啟日誌，避免顯示點不動的提示）。

## 三、錯誤日誌自動巡檢 → 自動產生待修復清單（新工具）

`scripts/error-log-triage.js`：

- 透過**自家 API** 讀取線上錯誤日誌（不直連資料庫），因此啟用 RLS 後照樣可用，本機也不需要放任何資料庫金鑰。
- 自動分組統計：次數、未處理數、近 24 小時、首次／最後發生、嚴重程度、最常見路徑、範例訊息。
- 自動分類並給出建議動作與優先度；比對 Roadmap 現有內容，標示「**新增**（待你決定）／已排入 Roadmap／已處理」。
- 自動更新 `docs/功能總覽與規劃.md` 第九節與 `docs/錯誤日誌分析.md`；`--upload` 會一併同步 Google Doc。

**第一次跑就抓到真問題**：`unhandled_server_error` 的內容是 `Unexpected token 'b', "{"username": broken" is not valid JSON`
—— 有人（掃描器或前端 bug）送出壞掉的 JSON，被當成「伺服器錯誤」記下來。本版一併修正：請求本身的問題
（JSON 格式錯誤、body 過大）改回 **400 / 413** 並以 **警告級** 記錄（`malformed_json_body`／`request_body_too_large`），
只有真正的程式例外才記成 `unhandled_server_error`，讓錯誤日誌不再被稀釋。

## 四、瀏覽器檢查工具進 repo（零外部依賴）

- `tests/browser/lib/cdp.js`：以 Node 內建 WebSocket 直接驅動 Chrome DevTools Protocol，
  不引入 puppeteer / playwright，也不放寬任何 CSP。
- `tests/browser/alert-banner-check.js`：真實 Chrome、手機尺寸（414×896）驗證提示橫幅的完整生命週期
  （出現 → 查看日誌 → 稍後再看 → 重新載入不再提示 → 有新錯誤再提示 → 全部處理完消失），並檢查沒有未捕捉的前端例外。

## 測試與驗證

| 項目 | 結果 |
|---|---|
| 單元／API 測試 `npm test` | **104 / 104 通過** |
| 瀏覽器檢查（真實 Chrome 手機尺寸） | **13 / 13 通過** |
| 正式站煙霧測試 `tests/browser/prod-smoke.js` | **49 / 49 通過** |
| 正式站版本 | v2.14.0 |

## 檔案異動

- 新增：`scripts/error-log-triage.js`、`tests/browser/lib/cdp.js`、`tests/browser/alert-banner-check.js`、`tests/error-triage.test.js`、`docs/錯誤日誌分析.md`
- 修改：`server.js`（登入鎖定雙計數、統計輔助函式與端點、登入回應 alerts、全域錯誤處理 4xx 分流）、`public/index.html`（提示橫幅容器）、`public/js/app.js`（橫幅邏輯、選單計數、移除被覆蓋的舊版角色選單函式）、`tests/user-management*.test.js`、`tests/browser/prod-smoke.js`、`docs/功能總覽與規劃.md`、`README.md`、`package.json`
- 尚待執行（需要你在 Supabase SQL Editor 跑一次）：`migrations/2026-09-26-v2.13.0-enable-rls.sql`（開啟 RLS）
