-- ============================================================
-- competition-manager v2.7.0：賽事分類與標籤
-- 執行方式：Supabase Dashboard → SQL Editor → 貼上整份 → Run
-- 本檔為 idempotent（可重複執行）。
-- ============================================================

-- 單一分類。值域由後端 server.js 的 COMPETITION_CATEGORIES 定義，
-- 不在此加 CHECK 限制，避免日後新增分類還要再改資料庫。
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS category text;

-- 多個標籤（Postgres 原生陣列），最多 10 個、每個最多 24 字元（後端正規化）。
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS competitions_category_idx ON public.competitions (category);
CREATE INDEX IF NOT EXISTS competitions_tags_idx ON public.competitions USING gin (tags);

COMMENT ON COLUMN public.competitions.category IS '賽事分類 id，對應 server.js 的 COMPETITION_CATEGORIES';
COMMENT ON COLUMN public.competitions.tags IS '賽事標籤陣列（不含 # 前綴），最多 10 個';

-- 驗證：兩個欄位都應存在
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'competitions'
  AND column_name IN ('category', 'tags')
ORDER BY column_name;
