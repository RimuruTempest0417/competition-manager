-- ============================================================
-- v2.12.0：帳號管理（admin_users）與錯誤日誌（error_logs）強化
-- 2026-09-25
--
-- 特性：
--   1. 全部使用 ADD COLUMN IF NOT EXISTS + DEFAULT，可安全重複執行。
--   2. 未執行本 migration 時，伺服器會自動降級（先探測欄位、沒有就不帶），
--      既有功能不受影響；只是「停用帳號」「最後登入時間」「日誌標記已處理」
--      等新功能會回 503 並提示需要本檔案。
--   3. 沿用本專案慣例：SUPABASE_KEY 是 anon key，因此關閉 RLS 並補上 GRANT
--      （開啟 RLS 又沒有 policy 會讓寫入全部失敗，錯誤碼 42501）。
-- ============================================================

-- ---------- 1. admin_users：帳號管理欄位 ----------
alter table admin_users add column if not exists is_active boolean not null default true;
alter table admin_users add column if not exists last_login_at timestamptz;
alter table admin_users add column if not exists updated_at timestamptz;

-- 既有帳號一律視為啟用
update admin_users set is_active = true where is_active is null;

create index if not exists admin_users_role_idx on admin_users (role);
create index if not exists admin_users_username_idx on admin_users (username);

-- ---------- 2. error_logs：嚴重程度與處理狀態 ----------
alter table error_logs add column if not exists severity text not null default 'error';
alter table error_logs add column if not exists resolved boolean not null default false;
alter table error_logs add column if not exists resolved_at timestamptz;
alter table error_logs add column if not exists resolved_by text;

-- 既有日誌：預設為 error / 未處理
update error_logs set severity = 'error' where severity is null;
update error_logs set resolved = false where resolved is null;

create index if not exists error_logs_created_at_idx on error_logs (created_at desc);
create index if not exists error_logs_severity_idx on error_logs (severity);
create index if not exists error_logs_resolved_idx on error_logs (resolved);

-- ---------- 3. 權限（anon key 專案，關閉 RLS 並補 GRANT） ----------
alter table admin_users disable row level security;
alter table error_logs disable row level security;

grant select, insert, update, delete on admin_users to anon, authenticated;
grant select, insert, update, delete on error_logs to anon, authenticated;

-- ---------- 4. 驗證 ----------
-- select username, role, is_active, last_login_at from admin_users order by id;
-- select severity, resolved, count(*) from error_logs group by 1, 2;
