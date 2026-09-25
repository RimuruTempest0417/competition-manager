# v2.17.0 — 每次更新自動「讀取錯誤日誌 → 標記已處理」

發佈日期：2026-09-26

## 一、為什麼要做

v2.14.0 的巡檢只做到「讀」：每次發版把線上錯誤日誌抓下來分析、產生待修復清單——但**讀完沒有收尾**。
結果是清單一直累積同一批舊訊息、首頁提示橫幅永遠亮著，**新的問題反而被舊雜訊蓋掉**。

這一版把流程補完：巡檢 = 讀取 → 分析 → **把剛讀到的那批標記為已處理**。

## 二、做了什麼

| 項目 | 說明 |
|---|---|
| 批次標記端點 | `POST /api/admin/error-logs/resolve`：接受明確的 `ids`（單次最多 500 筆）或 `all_unresolved: true`（內部上限 1000 筆） |
| 巡檢整合 | `npm run triage` 讀取 → 分析 → 標記一氣呵成；超過 500 筆會自動分批 |
| 只看不動 | `npm run triage:report`（＝`--no-resolve --dry-run`）只產報告、不改任何資料 |
| 介面按鈕 | 錯誤日誌視窗新增「🏷️ 全部標記已處理」，完成後橫幅與選單計數立即更新 |
| 公開紀錄 | 第九節會寫「本輪已標記 N 筆」；稽核留 `RESOLVE_ERROR_LOGS`（誰、何時、幾筆、前 20 個 id） |
| 降級 | 未執行 v2.12.0 migration（沒有 `resolved` 欄位）時回 503 並附檔案路徑，**不改動任何資料** |

三個刻意的設計：

1. **標記不等於刪除**。紀錄仍在資料庫，取消勾選「只看未處理」就看得到全部；要真的刪得走「🧹 清理」。
2. **批次也只做「明示的那一批」**。`ids` 一定要是明確清單（去重、非正整數直接 400），避免「一個不小心清光全部」。
3. **標記失敗不中斷巡檢**。報告照常產出（報告本身就是那批紀錄的永久存檔），警告寫在輸出，下一輪會再試。

## 三、實際在正式站跑一次的結果

```
🐞 錯誤日誌巡檢：https://competition-manager-hazel.vercel.app
   取得 6 筆紀錄、4 種錯誤類型、未處理 4 筆（本頁）
   ⚪ malformed_json_body：3 次 → 用戶端請求錯誤（v2.14.0 已分流為 4xx）
   ⚪ auth_invalid_token：1 次 → 權杖無效／過期
🏷️  已標記 4 筆為已處理（resolved_by=rimuru，分 1 批）
```

標記後讀回驗證：

- `GET /api/admin/error-logs/summary` → `unresolved_total: 0`、`may_need_attention: false`（首頁橫幅熄滅）
- `GET /api/admin/error-logs?resolved=false` → 0 筆
- `GET /api/audit-logs?action=RESOLVE_ERROR_LOGS` → 1 筆：`{"requested":4,"resolved":4,"sample_ids":[102,101,100,99]}`

## 四、驗證數據（全部實跑）

| 項目 | 結果 |
|---|---|
| `npm test` | **143 / 143**（新增批次標記 API 7 項、migration 降級 1 項、巡檢標記 4 項） |
| `npm run check:browser`（真實 Chrome、手機尺寸） | **63 / 63**（提示橫幅 13＋兩步驟驗證 15＋稽核日誌 22＋錯誤日誌標記 13） |
| `npm run check:prod` | **54 / 54**（正式站 HTTP 煙霧 48＋訪客視角 6） |
| 線上版本 | v2.17.0 |

「標記已處理」的瀏覽器檢查實際做了：3 筆未處理（2 錯誤＋1 警告）→ 登入橫幅顯示「有 2 筆未處理」＋選單計數 →
開啟日誌視窗（摘要「未處理 3 筆」）→ 一鍵標記（先跳確認）→ 三筆都變「✓ 已處理」且**紀錄仍在** →
關閉視窗橫幅熄滅、計數消失 → 資料庫確認 `resolved_by`／`resolved_at` 與稽核紀錄。

## 五、檔案異動

- 新增：`tests/error-log-resolve-api.test.js`、`tests/error-log-resolve-no-migration.test.js`、`tests/browser/error-log-resolve-check.js`
- 修改：`server.js`（批次標記端點＋`parseResolveIds`）、`scripts/error-log-triage.js`（巡檢後標記、`collectResolvableIds`／`chunk`／`resolveErrorLogs`、報告記錄筆數）、
  `public/index.html`＋`public/js/app.js`（「🏷️ 全部標記已處理」按鈕與流程）、`package.json`（`triage`／`triage:report`、`check:browser` 納入新檢查、版本 2.17.0）、
  `tests/support/fake-supabase.js`（支援 PostgREST `in.(a,b,c)`，並在檔頭標明不支援 limit／offset 與 count）、`tests/error-triage.test.js`、`README.md`、`docs/功能總覽與規劃.md`
