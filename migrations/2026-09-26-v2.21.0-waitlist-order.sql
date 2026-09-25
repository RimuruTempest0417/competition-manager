-- v2.21.0：候補順位手動調整（管理員可指定遞補某人、調整候補順序）
--
-- 為什麼需要：
--   v2.20.0 的候補一律「先報名先排」（依 registrations.created_at），但實務上主辦常常需要
--   把某個人往前排（例如已繳費、同隊友）或指定遞補特定對象（例如候補第一名的電話打不通）。
--   靠改 created_at 硬幹會破壞真實的報名時間，所以另外開一個「管理員排定的順位」欄位。
--
-- 規則（程式在 public/js/competition-state.js 的 waitlistQueue，前後端共用）：
--   1. 兩筆都手動排過 → 照 waitlist_order（小的在前）
--   2. 只有一筆排過 → 排過的在前面（新報名的人一律排到最後，不會插隊）
--   3. 都沒有 → 先報名先排（created_at，其次 id）
--
-- 本檔可重複執行（全部 IF NOT EXISTS）。
-- **未執行時**：調整順序的端點回 503 ＋ 指引，候補順位自動退回「先報名先排」，
-- 指定遞補仍可用（不需要這個欄位），其餘功能完全不受影響。

alter table registrations add column if not exists waitlist_order integer;

comment on column registrations.waitlist_order is
    'v2.21.0 候補順位（管理員手動調整；1 開始。null = 依 created_at 先報名先排）';

-- 候補排序查詢用（沒有這個索引也能跑，只是資料量大時排序較慢）
create index if not exists registrations_waitlist_order_idx
    on registrations (competition_id, waitlist_order);

-- 說明：本專案所有存取都經後端 API（service_role 繞過 RLS），因此不需要任何 policy 或 grant。
-- 若之後要把「手動排定的順位」重設回自動排序，執行：
--   update registrations set waitlist_order = null where waitlist_order is not null;
-- （這是資料操作，執行前建議先跑 npm run backup 留一份快照）
