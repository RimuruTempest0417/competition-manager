# v3.4.0 — P4：`server.js` 拆模組

**一句話**：把一支 6,979 行的 `server.js` 拆成 **19 個路由模組**，`server.js` 剩 **2,551 行**（−63%），
**對外行為完全不變**（路由數量、順序、權限、回應全部一樣，用測試釘住）。

## 為什麼要做

`server.js` 從 v2.x 一路長到近 7,000 行：改一個功能要在同一支檔案裡上下游動，衝突、看漏、複製貼上出錯的風險都高。
這次只做「搬家」——**不改邏輯、不改行為**——所以風險要用證據壓到最低。

## 怎麼拆的

| 之前 | 之後 |
|---|---|
| `server.js` 6,979 行、88 個路由全擠在一起 | `server.js` **2,551 行**（連線、共用函式、中間件、組裝）＋ `routes/` **19 個模組** |

19 個模組（依原本的路由順序掛載，順序是刻意的）：

`error-logs`、`announcements`、`venue-staff`、`audit-logs`、`backup`、`admin-users`、`auth`、`results`、`stats`、`competitions`、`registrations`、`teams`、`version`、`push-settings`、`posters`、`docs`、`push`、`cron`、`competitions-csv`

**組裝方式**（避免圓形 require、避免拿到未初始化的變數）：

```js
/* ---------- 賽事規程 PDF 附件：v3.4.0 起移到 routes/docs.js ---------- */
require('./routes/docs')(app, { DOC_MAX_BYTES, DOC_HINT, ..., supabase });
```

模組內部：

```js
module.exports = function registerDocsRoutes(app, ctx) {
    const { DOC_MAX_BYTES, DOC_HINT, ..., supabase } = ctx;   // 依賴清單就寫在這裡，一眼看得出這支模組需要什麼
    app.get('/api/competitions/:id/doc', async (req, res) => { ... });   // 內容原封不動
};
```

- **掛載點＝該模組最後一條路由的位置** → 那個區段裡宣告的常數都已就緒，且模組之間的路由順序不變。
- **共用狀態集中**：原本散在各處的 12 個 `let` 可變變數（schema 探測快取、`opsStatsCache`、`lastCronRun`、`webpush`…）
  改成同一個 `serverState` 物件。原因很實際：模組是用「掛載當下」的值去用這些變數，若各自一份，
  探測快取就不共享、設定會讀到舊值。集中成一個物件後，server.js 與模組讀寫的是**同一格**，行為與拆之前相同。
- **兩個行內相對路徑**（`require('./package.json')`）在 `routes/` 底下要補一層 → 已改成 `../package.json`。

## 怎麼證明「行為沒變」

| 證據 | 內容 |
|---|---|
| **新增路由清單守門測試** | `tests/route-inventory.test.js`：把 93 條路由＋7 層中間件的**數量與順序**凍結成快照（`tests/fixtures/route-inventory.json`），拆模組後逐項比對——順序一變就可能被前面的 catch-all 攔走，而且**不會報錯**，所以這條最關鍵 |
| 單元／API 測試 | `npm test` **581 通過 / 0 失敗**（1 項因測試環境時間跨午夜而略過，非程式問題） |
| 真實瀏覽器 | `npm run check:browser` **618 項**（20 支，含線上版面實算） |
| 正式站 | 發佈後 `npm run check:prod`（煙霧＋訪客視角＋線上樣式） |

快照的用法：重構時它必須**保持不變**（不變才代表等價）；真的新增／移除路由時，才用
`node scripts/route-inventory.js --write` 更新，並在 commit 訊息說明原因。

## 順手修掉的兩個既有測試缺陷（不是這次改壞的）

1. `tests/push-settings-api.test.js`：`shouldRunDigest` 用 `"HH:MM"` 字串比較（同一天內正確），
   深夜跑測試時「3 小時後」會跨到隔天，測試前提不成立 → 改成**明確略過並說明原因**（白天照常驗證）。
   （已在 v3.3.0 的程式碼上重現同樣失敗，確認與這次重構無關。）
2. `tests/push-log-detail-api.test.js`：候選賽事寫死「今天 23:00」，深夜跑時已成過去 → 改成「1 小時後開賽」，
   並先清掉「今天已發送摘要」的旗標 → 這條測試現在**與執行時間無關**。

## 檔案

- 新增：`routes/`（19 檔）、`tests/route-inventory.test.js`、`tests/fixtures/route-inventory.json`、`scripts/route-inventory.js`
- 修改：`server.js`（6,979 → 2,551 行）、`tests/audit-actions.test.js`（掃描範圍改為 `server.js` ＋ `routes/*.js`）、
  兩個測試的上述修正
- 檢查工具：`tests/browser/lib/cdp.js` 的截圖功能預設**不寫任何檔案**（要親眼看畫面才需 `CM_KEEP_SCREENSHOTS=1`）
- **沒有**任何資料庫變更、沒有 CSP 變更、沒有前端變更
