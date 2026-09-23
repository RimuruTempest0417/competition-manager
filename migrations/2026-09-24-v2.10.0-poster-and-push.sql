-- ============================================================
-- v2.10.0 migration：手動上傳海報（資料庫儲存）與 Web Push 推播訂閱
-- 執行方式：Supabase → SQL Editor → 貼上本檔全部內容 → Run
-- 特性：全部 IF NOT EXISTS / IF EXISTS，可重複執行；不會刪除任何既有資料。
--
-- ⚠️ 本檔最後一段是「修正 v2.9.0 migration 的 RLS 設定」：
--    本專案的 SUPABASE_KEY 是 anon key（由後端單獨持有，前端不會接觸），
--    若對新資料表 enable row level security 卻沒有任何 policy，
--    anon key 會「完全無法寫入」→ 報名與隊伍功能會失敗。
--    因此本檔會把這些資料表的 RLS 關閉，與既有 competitions / admin_users 的
--    實際運作方式一致（存取控制由後端 API + JWT 權限中間件負責）。
--    如果你已經執行過 v2.9.0 migration，這一段同樣會修正它。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 賽事海報：只記「有沒有上傳 / 何時更新」
--    實際圖片存在 competition_posters，避免賽事列表 API 帶出大檔案。
-- ------------------------------------------------------------
alter table competitions add column if not exists poster_updated_at timestamptz;

comment on column competitions.poster_updated_at is
    '手動上傳海報的最後更新時間；非 null 代表此賽事有自訂海報（GET /api/competitions/:id/poster）';

-- ------------------------------------------------------------
-- 2) 海報內容（base64 儲存，以自家端點提供，維持 CSP img-src ''self''）
-- ------------------------------------------------------------
create table if not exists competition_posters (
    competition_id bigint primary key references competitions(id) on delete cascade,
    mime           text        not null default 'image/jpeg',
    bytes          integer     not null default 0,
    data           text        not null,          -- base64（不含 data: 前綴）
    uploaded_by    text,
    updated_at     timestamptz not null default now()
);

comment on table competition_posters is
    '賽事自訂海報（管理員手動上傳，取代自動生成海報）。單筆上限 3MB，前端會先縮圖再上傳。';

-- ------------------------------------------------------------
-- 3) 應用設定（單一 key/value）：
--    推播所需的 VAPID 金鑰由伺服器首次使用時自動產生並存於此，
--    因此不必把私鑰寫進程式碼，也不必手動設定環境變數。
-- ------------------------------------------------------------
create table if not exists app_settings (
    key        text primary key,
    value      text not null,
    updated_at timestamptz not null default now()
);

comment on table app_settings is
    '應用層設定（例如 push_vapid_keys）。伺服器會自動建立需要的項目。';

-- ------------------------------------------------------------
-- 4) 修正 v2.9.0：關閉新資料表的 RLS（anon key 在 RLS 且無 policy 下無法寫入）
--    實測：RLS 開啟且無 policy 時，寫入會回 42501
--    「new row violates row-level security policy」，註冊／報名／隊伍全部失敗。
-- ------------------------------------------------------------
alter table if exists registrations         disable row level security;
alter table if exists competition_teams     disable row level security;
alter table if exists push_subscriptions    disable row level security;
alter table if exists push_log              disable row level security;
alter table if exists competition_posters   disable row level security;
alter table if exists app_settings          disable row level security;

-- ------------------------------------------------------------
-- 5) 明確授權（雙重保險：即使資料表的預設權限不同，anon 也能讀寫）
--    本專案的 anon key 只存在伺服器端環境變數，前端從不直接連 Supabase；
--    存取控制由後端 API（JWT + 權限中間件）負責。
-- ------------------------------------------------------------
grant usage on schema public to anon;
grant select, insert, update, delete on registrations        to anon, service_role;
grant select, insert, update, delete on competition_teams    to anon, service_role;
grant select, insert, update, delete on push_subscriptions   to anon, service_role;
grant select, insert, update, delete on push_log             to anon, service_role;
grant select, insert, update, delete on competition_posters  to anon, service_role;
grant select, insert, update, delete on app_settings         to anon, service_role;
grant usage, select on all sequences in schema public to anon, service_role;

-- ------------------------------------------------------------
-- 6) 檢查（可選）：執行後應看到 6 張新表與 rowsecurity = false
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5) 檢查（可選）：執行後應看到 6 張新表存在
-- ------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('registrations','competition_teams','push_subscriptions','push_log','competition_posters','app_settings');
