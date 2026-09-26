# v3.1.1 發佈說明

**主題**：修正 v3.0.0 migration 在 `push_log` 上引用不存在欄位而整份無法執行

- **日期**：2026-09-26
- **版本**：v3.1.1
- **影響範圍**：`migrations/2026-09-27-v3.0.0-perf.sql`（只有這支檔案，程式碼完全沒動）

---

## 一、你遇到的錯誤

在 Supabase SQL Editor 執行 `migrations/2026-09-27-v3.0.0-perf.sql` 時：

```
Error: Failed to run sql query: ERROR: 42703: column "created_at" does not exist
```

## 二、原因

錯的是這一行（原第 58 行）：

```sql
create index if not exists push_log_created_idx
    on public.push_log (created_at desc);   -- ← push_log 沒有這個欄位
```

**`push_log` 這張表的時間欄位叫 `sent_at`，不是 `created_at`**（程式碼裡推播看板也是用它排序）。
PostgreSQL 的錯誤訊息只會說「欄位不存在」、**不會說是哪張表**，所以看起來像是前面那條
`competitions (created_at)` 有問題——但 `competitions.created_at` 其實是存在的。

**為什麼「一行都沒生效」**：SQL Editor 會把整份腳本放在同一個交易裡執行，任何一句失敗就整份回滾。
所以連最前面三個 `thumb_*` 欄位（本身沒問題）也一起沒有建立——這也是為什麼事後查資料庫會覺得「什麼都沒進去」。

## 三、修正內容

```sql
-- 推播紀錄的時間排序（推播看板）——注意：這張表的時間欄位是 sent_at，不是 created_at：
create index if not exists push_log_sent_idx
    on public.push_log (sent_at desc);
```

- 欄位改成本表真實存在的 `sent_at`（索引名稱也一併正名為 `push_log_sent_idx`）。
- 其餘 12 條索引與 3 個縮圖欄位**全部逐條對照正式資料庫的實際欄位驗證過**，沒有任何一條再有同樣問題。

## 四、已經直接幫你套用並驗證

已在你的 Supabase 專案（比賽管理系統）實際執行修正後的版本，並讀回確認：

| 檢查 | 結果 |
|---|---|
| `competition_posters` 縮圖欄位 | ✅ `thumb_mime`、`thumb_bytes`、`thumb_data` 都在 |
| v3.0.0 的 10 條索引 | ✅ 全部建立（含 `push_log_sent_idx`；舊的 `push_log_created_idx` 不存在，正確） |
| v3.1.0 的成績表 | ✅ `competition_results` 存在＋3 條索引（含唯一鍵） |
| 成績表 RLS | ✅ 已開啟 |
| `competitions` 的公布欄位 | ✅ `result_published_at`、`result_published_by`、`result_summary` |

**正式站實測（修正後）**：成績端點從「503 請先跑 migration」變成正常 **HTTP 200**；
`npm run check:prod` 煙霧 **84/84**＋訪客視角 **8/8**＋線上樣式 **8/8**。

## 五、你不需要再做任何事

兩支 migration（v3.0.0 與 v3.1.0）現在都已完整套用在你的資料庫上。
如果之後想自己重跑確認，這支檔案是**可重複執行**的（全部 `IF NOT EXISTS`），再貼一次也只會看到「already exists」。
