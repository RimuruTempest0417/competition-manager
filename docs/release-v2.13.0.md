## v2.13.0 — 資料庫存取安全強化（service_role 金鑰支援 + 啟用 RLS 的準備）

### 問題

目前使用 **anon key 且 RLS 關閉**，任何取得金鑰的人都能直接讀寫資料庫全部內容（包含 `admin_users` 的密碼雜湊、`error_logs` 的訊息）。這是目前唯一的結構性風險，也是 Roadmap 的 P0-1。

### 本版內容（程式與遷移檔就緒，實際切換留待下一版）

- 金鑰解析抽成可測試的 `resolveSupabaseKey()`，優先序：`SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` → `SUPABASE_KEY`（只由伺服器讀取；前端從不接觸金鑰）。
- 啟動時若仍使用 anon key 會印出警告，明確提醒「啟用 RLS 前必須先換成 service_role」。
- `GET /api/admin/error-logs/health` 新增 `db_key_type` 與 `rls_ready`，讓「能不能安全開啟 RLS」變成可觀測（只回類型，絕不回傳金鑰）。
- 新增 `migrations/2026-09-26-v2.13.0-enable-rls.sql`：對 10 張表啟用 RLS 並撤銷 `anon` / `authenticated` 權限（`service_role` 會繞過 RLS，伺服器完全不受影響）。檔頭寫明**執行順序**，檔尾附緊急 ROLLBACK 語法，可重複執行。
- `scripts/hash-legacy-passwords.js` 同步改用 service_role key。

### 為什麼切換不放在這一版

啟用 RLS 前必須先確認 Vercel 已重新部署且伺服器真的讀到 service_role 金鑰，否則前台會整站讀不到資料。所以本版先交付程式與遷移檔，待你把金鑰加好，下一版才執行遷移與驗證。

### 需要你做的兩件事

1. **Vercel** → Settings → Environment Variables → 新增 `SUPABASE_SERVICE_KEY`（值＝Supabase 專案的 service_role key）→ **Redeploy**
2. 本機 `competition-manager/.env` 也加同一行（該檔已 gitignore）

⚠️ 請**不要**把金鑰貼在對話裡；自己貼進這兩個地方即可。若它曾在對話、截圖或雲端筆記出現過，請先在 Supabase → Settings → API 按 **Rotate** 換新的。

### 測試

`npm test` **97/97**（新增 `tests/supabase-key.test.js` 3 項：金鑰優先序、anon 時 `rls_ready=false`、service_role 時 `rls_ready=true` 且回應不含金鑰內容）。另新增 `tests/browser/prod-smoke.js`（正式站 HTTP 煙霧測試，只讀不寫）與 `scripts/doc-sync.py`、`scripts/md-to-docs-html.py`，全部進 repo 以免再被暫存目錄的 24 小時清理刪除。
