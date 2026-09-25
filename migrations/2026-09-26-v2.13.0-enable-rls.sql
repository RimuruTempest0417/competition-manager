-- ============================================================================
-- v2.13.0：啟用 RLS，讓資料庫只接受「伺服器端 service_role」存取
-- ----------------------------------------------------------------------------
-- 為什麼要做：目前使用 anon key 且 RLS 關閉，任何取得 anon key 的人都能直接
--             讀寫全部資料表（包含 admin_users 的密碼雜湊、error_logs 內容）。
--
-- ⚠️ 執行順序（務必照做，順序錯了前台會整站讀不到資料）
--   1) 先在 Vercel → Settings → Environment Variables 加入
--        SUPABASE_SERVICE_KEY = <Supabase 專案的 service_role key>
--      （本機 competition-manager/.env 也加同一行；此檔已 gitignore，不會進 Git）
--      名稱用 SUPABASE_SERVICE_ROLE_KEY 也可以，兩者都支援。
--   2) 重新部署（Redeploy），並確認：
--        GET /api/admin/error-logs/health  →  "db_key_type": "service_role"、"rls_ready": true
--      若還顯示 "anon"，代表伺服器還沒讀到新金鑰，此時**不要**執行本檔。
--   3) 才在 Supabase SQL Editor 執行本檔案。
--   4) 驗證：
--        - 用 anon key 讀 admin_users / competitions 應被拒絕（403 或空結果）
--        - 前台列表、報名、使用者管理、錯誤日誌皆正常
--        - GET /api/admin/error-logs/health 的 plaintext_passwords 仍可讀
--
-- 原理：service_role 會「繞過」RLS，所以伺服器完全不受影響；
--       anon / authenticated 因為沒有任何 policy、且被撤銷權限，將無法存取任何資料。
--       （本專案前端從不直連資料庫，所有存取都經由伺服器，因此不需要為 anon 建 policy。）
--
-- 回復方式（緊急）：見檔尾 ROLLBACK 區塊，貼上執行即可還原。
-- 本檔可重複執行（idempotent）。
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'admin_users', 'app_settings', 'audit_logs', 'competition_posters',
        'competition_teams', 'competitions', 'error_logs', 'push_log',
        'push_subscriptions', 'registrations'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
            RAISE NOTICE 'RLS 已啟用並撤銷 anon/authenticated：%', t;
        ELSE
            RAISE NOTICE '跳過（資料表不存在）：%', t;
        END IF;
    END LOOP;
END $$;

-- 徹底切斷 anon / authenticated 的存取管道（沒有 schema USAGE 就無法透過 PostgREST 查任何表）
REVOKE USAGE ON SCHEMA public FROM anon;
REVOKE USAGE ON SCHEMA public FROM authenticated;

-- 驗證：應看到 10 張表的 rowsecurity 都是 true
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ----------------------------------------------------------------------------
-- ROLLBACK（緊急復原：讓 anon key 可以再存取。只在出問題時使用）
-- ----------------------------------------------------------------------------
-- GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
-- DO $$
-- DECLARE t text;
-- BEGIN
--     FOREACH t IN ARRAY ARRAY['admin_users','app_settings','audit_logs','competition_posters',
--                              'competition_teams','competitions','error_logs','push_log',
--                              'push_subscriptions','registrations'] LOOP
--         EXECUTE format('ALTER TABLE IF EXISTS public.%I DISABLE ROW LEVEL SECURITY', t);
--     END LOOP;
-- END $$;
