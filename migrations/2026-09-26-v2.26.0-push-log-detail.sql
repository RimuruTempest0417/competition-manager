-- v2.26.0：推播失敗可視與重送
--
-- 目的：push_log 原本只記 sent_count，失敗時完全看不出原因、也無法重送。
-- 這一版補上「失敗了幾筆、為什麼失敗、原本送什麼內容、要送給誰」，才能在看板上重送。
--
-- 可重複執行（全部 IF NOT EXISTS）。未執行時：推播紀錄照常可看，只是沒有失敗資訊與重送按鈕，
-- 端點會回 503 並告訴你要跑這個檔（見 server.js 的 pushLogDetailSchemaReady()）。

alter table public.push_log add column if not exists failed_count integer;
alter table public.push_log add column if not exists error_detail text;
alter table public.push_log add column if not exists payload jsonb;
alter table public.push_log add column if not exists target_user_id bigint;
alter table public.push_log add column if not exists target_user_ids bigint[];   -- 一組對象（例如公告發給符合條件的使用者）
alter table public.push_log add column if not exists resend_count integer;
alter table public.push_log add column if not exists resend_at timestamptz;
alter table public.push_log add column if not exists resend_sent_count integer;

-- 看板要列出「最近有失敗的紀錄」，加一個部分索引讓這個查詢不必全表掃描
create index if not exists push_log_failed_idx
    on public.push_log (sent_at desc)
    where failed_count is not null and failed_count > 0;

-- 重送需要知道「這筆是發給哪個使用者」，依此索引找訂閱
create index if not exists push_log_target_user_idx
    on public.push_log (target_user_id)
    where target_user_id is not null;
