-- ==========================================
-- v3.0.0：後台營運儀表板與效能
-- ==========================================
-- 這一支只做兩件事，都不改動既有資料的意義：
--   1. 海報縮圖欄位（列表與表單預覽改載縮圖，分享／列印仍然用原圖）
--   2. 常用查詢路徑的索引（列表分頁與統計聚合）
--
-- 可以重複執行：全部都是 IF NOT EXISTS。
-- 執行後不需要重新部署，也不需要重啟（伺服器端對欄位的探測有 60 秒快取）。
--
-- 事前檢查（可選）：
--   select count(*) from public.competition_posters;                      -- 有多少張海報
--   select sum(bytes) from public.competition_posters;                     -- 目前佔用多少
-- 事後確認（可選）：
--   select indexname from pg_indexes where schemaname = 'public' order by 1;
--
-- 注意：縮圖是「新增上傳時」由瀏覽器（canvas）產生，舊海報不會自動補縮圖，
--       讀取時會自動退回原圖，所以沒有縮圖也完全正常，不需要回填。

-- ---------- 1. 海報縮圖 ----------
-- 前端上傳海報時會同時送一張縮圖（最寬 480px 的 JPEG），列表與表單預覽改載縮圖。
alter table public.competition_posters add column if not exists thumb_mime  text;
alter table public.competition_posters add column if not exists thumb_bytes integer;
alter table public.competition_posters add column if not exists thumb_data  text;

comment on column public.competition_posters.thumb_data is
    '列表／預覽用的縮圖（base64）。沒有值時 GET /api/competitions/:id/poster?variant=thumb 會退回原圖。';

-- ---------- 2. 索引 ----------
-- 為什麼是這幾個：列表分頁與儀表板統計都落在這幾條路徑上。
-- 單筆賽事的報名人數（列表卡片、名單、統計）是最常用的查詢：
create index if not exists registrations_competition_active_idx
    on public.registrations (competition_id) where is_deleted = false;

-- 「我的報名／我的賽事」與候補相關查詢：
create index if not exists registrations_user_idx
    on public.registrations (user_id) where is_deleted = false;

-- 依狀態統計（已核准／待審核／候補）與審核清單：
create index if not exists registrations_status_idx
    on public.registrations (status);

-- 賽事列表排序與「近期發佈」統計：
create index if not exists competitions_created_idx
    on public.competitions (created_at desc);

-- 錯誤日誌：趨勢圖與巡檢的時間窗（每次巡檢都會用到）：
create index if not exists error_logs_created_idx
    on public.error_logs (created_at desc);

-- 稽核日誌：依動作與對象查（例如「這誰發佈的」與匯出）：
create index if not exists audit_logs_action_target_idx
    on public.audit_logs (action, target_id);
create index if not exists audit_logs_created_idx
    on public.audit_logs (created_at desc);

-- 推播紀錄的時間排序（推播看板）——注意：這張表的時間欄位是 sent_at，不是 created_at：
create index if not exists push_log_sent_idx
    on public.push_log (sent_at desc);

-- 公告已讀（未讀徽章每次載入都會查）——表可能還沒建，所以用 DO 區塊保護：
do $$
begin
    if to_regclass('public.announcement_reads') is not null then
        execute 'create index if not exists announcement_reads_user_idx on public.announcement_reads (user_id)';
    end if;
    if to_regclass('public.competition_staff') is not null then
        execute 'create index if not exists competition_staff_competition_idx on public.competition_staff (competition_id)';
    end if;
end $$;

-- 完成
