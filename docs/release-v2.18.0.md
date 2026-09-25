# v2.18.0 — 資料備份與還原

**發佈日期**：2026-09-26｜**類型**：P0 安全與基礎（Roadmap P0-6）

## 為什麼要做

在這一版之前，資料的安全網只有 Supabase 自己。真的手滑（按到「🧹 清理」、匯入覆蓋、誤刪賽事）沒有任何回頭路——而系統已經有 9 場賽事、8 個帳號、3 筆報名在線上跑。備份是**唯一能在事後挽救的操作**，所以補上匯出與還原，並且把「還原」設計成不會造成二次災難的形狀。

## 新增

### 端點（僅超級管理員／網站擁有者）

| 端點 | 說明 |
| --- | --- |
| `GET /api/admin/backup` | 匯出全部核心表成 JSON。`?include_logs=true` 加日誌、`?include_posters=false` 略過海報圖片、`?tables=a,b` 只匯出指定表 |
| `POST /api/admin/restore` | 還原。`{ backup, dry_run, confirm, force, tables }` |

備份檔結構：

```json
{
  "meta": {
    "app": "competition-manager", "version": "2.18.0",
    "generated_at": "2026-09-25T15:02:22.510Z", "generated_by": "rimuru",
    "tables": { "competitions": { "rows": 9 }, "...": { "rows": 0 } },
    "total_rows": 29, "skipped": ["audit_logs", "error_logs"],
    "checksum": "064bc4cc…724a51"
  },
  "tables": { "competitions": [ { … } ], "...": [] }
}
```

- **預設不含日誌**（`audit_logs`／`error_logs` 會讓檔案無故膨脹，而且已有 CSV 匯出）。
- **checksum**：sha256 覆蓋整份 tables，還原前必驗；不符預設拒絕。

### 指令（本機）

```bash
npm run backup                                  # 匯出到 backups/，自動保留最近 20 份
npm run backup -- --include-logs --keep 50
npm run restore -- --file backups/xxx.json --dry-run    # 只檢查
npm run restore -- --file backups/xxx.json              # 真的還原
npm run restore -- --file backups/xxx.json --tables=competitions,registrations
```

- `backups/` 已加入 `.gitignore`：備份含帳號雜湊與報名個資，**絕不可進版控**。
- 走自家 API（不需資料庫金鑰，服務開啟 RLS 後照樣可用），操作自動留稽核。

### 介面

選單「💾 備份與還原」（僅 super_admin／web_owner 可見）：勾選是否含海報圖片／日誌後即可下載；還原區上傳備份檔後**必須先按「🔍 先檢查」**，畫面列出每張表將還原幾筆，檢查通過才會啟用「♻️ 確認還原」。

## 設計取捨（重點）

| 決定 | 理由 |
| --- | --- |
| 還原＝**upsert，永不刪除** | 還原的動機是「救回被誤刪的」，如果用「清空再寫回」，反而會把備份之後新增的資料殺掉。要刪資料請用介面既有的清理功能。 |
| 強制 dry-run ＋ 明確 `confirm` | 還原是大量寫入且不可逆。檢查階段不寫任何資料，讓使用者先看到「將寫入哪些表、幾筆」。 |
| checksum 不符預設拒絕 | 半路被改過的備份檔可能把壞資料寫進正式庫；`force` 才可覆寫。 |
| 部分失敗誠實回報 | 逐表回報 `per_table` 與 `failures`，並寫入錯誤日誌。寧可說「3 張表成功、1 張失敗」，不假裝全部成功。 |
| 衝突鍵逐表指定 | `app_settings` 是 `key`、`push_subscriptions` 是 `endpoint`，其餘是 `id`。這裡踩過一個坑：supabase-js 的選項名是 camelCase 的 `onConflict`，寫成 `on_conflict` 會**靜默**退回「以主鍵為衝突目標」，遇到主鍵 ≠ 唯一鍵的表就會撞 23505。程式碼已註解提醒。 |
| **不啟用自動排程** | 依使用者指示「取消自動排程」。備份是手動一鍵；要定期自動備份（可上傳 Google Drive）可再安排。 |

## 驗證

- `npm test`：**156 項全綠**（新增 `tests/backup-api.test.js` 12 項 ＋ `tests/backup-restore-failure.test.js` 1 項）。關鍵斷言：dry-run 不可改動任何資料、備份中沒有的資料不可被刪除、upsert 帶對 `on_conflict`、checksum 不符／缺 meta／空 tables／未知表一律 400、沒有 `confirm` 不可還原、部分失敗回 `success:false` 並寫錯誤日誌。
- `npm run check:browser`：**85 項全綠**（新增 `backup-check.js` 22 項，真實 Chrome 手機尺寸）：開窗、實際攔下 Blob 檢查 JSON 與 checksum、取消勾選後不含海報、檢查階段資料庫無變化、檢查後才可按還原、還原真的生效且**舊資料沒被刪**、被改過的備份被拒、權限表正確、無前端例外。
- **線上實跑**（production）：
  - `npm run backup` → 29 筆／8 張表（app_settings 2、admin_users 8、competitions 9、posters 0、registrations 3、teams 3、push_subscriptions 3、push_log 1），檔案 17.4 KB，checksum `064bc4cc…`。
  - `npm run restore -- --dry-run` → checksum 驗證通過、7 張表 29 筆待還原、**未寫入任何資料**。
  - 稽核日誌確認：`EXPORT_BACKUP`、`RESTORE_BACKUP_DRY_RUN`（含完整 plan）各一筆。
- `npm run check:prod`：54 項全綠。

## 已知限制

- **無自動排程**：目前備份是手動執行。若需要「每天自動備份並上傳 Google Drive」，可以再排（本機已有 Google 授權）。
- 備份是「當下快照」：資料庫在還原後若又被寫入，那些新資料不會被這份備份覆蓋（upsert 語意），也可能與還原內容衝突——建議在離峰時間還原。
- 大型海報（base64）會讓備份檔變大：單一請求上限為 10 MB（`express.json` 限制），必要時用 `?include_posters=false`。
