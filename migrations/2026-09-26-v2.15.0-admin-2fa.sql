-- ============================================================================
-- v2.15.0：管理員兩步驟驗證（TOTP）所需欄位
-- ----------------------------------------------------------------------------
-- 執行方式：Supabase → SQL Editor → 貼上整份執行（可重複執行，已存在的欄位會跳過）。
-- 執行前後都不需要重新部署；程式在欄位不存在時會自動回報「尚未啟用」而不會壞掉。
--
-- 欄位說明：
--   totp_secret         使用者綁定中的 TOTP 密鑰（Base32，未確認前 totp_enabled 仍為 false）
--   totp_enabled        是否已完成綁定（登入時是否要求第二因素）
--   totp_confirmed_at   完成綁定的時間
--   totp_recovery_codes 備援碼（JSON 陣列，每筆為 { salt, hash, used_at }；只存雜湊，不存明文）
--   totp_last_step      最後一次成功驗證的時間步（同一組碼不可重複使用，防重放）
--
-- 注意：資料庫已於 2026-09-25 啟用 RLS 並撤銷 anon/authenticated 權限，
--       伺服器使用 service_role（會繞過 RLS），因此本檔**不需要**任何 policy 或 grant。
-- ============================================================================

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS totp_secret text;

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS totp_confirmed_at timestamptz;

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS totp_recovery_codes jsonb;

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS totp_last_step bigint;

-- 驗證：應看到 5 個 totp_* 欄位
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'admin_users' AND column_name LIKE 'totp%'
ORDER BY column_name;

-- ----------------------------------------------------------------------------
-- ROLLBACK（緊急復原：完全不使用兩步驟驗證時才需要）
-- ----------------------------------------------------------------------------
-- ALTER TABLE public.admin_users
--     DROP COLUMN IF EXISTS totp_secret,
--     DROP COLUMN IF EXISTS totp_enabled,
--     DROP COLUMN IF EXISTS totp_confirmed_at,
--     DROP COLUMN IF EXISTS totp_recovery_codes,
--     DROP COLUMN IF EXISTS totp_last_step;
