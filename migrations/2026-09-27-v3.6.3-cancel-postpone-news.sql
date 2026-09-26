-- v3.6.3：賽事取消／延期標記 ＋ 卡片「最新消息」
--
-- 為什麼需要（Roadmap 8.8⑥）：澳門颱風延期是常態，目前狀態完全由日期推導——
-- 只能改時間（事後看不出「延期過」），也不能標「取消」。臨時變更只能靠推播，
-- 而推播要訂閱，沒訂閱的人什麼都看不到。
--
-- 設計原則（依 Roadmap 的決策）：**保留原訂時間不覆蓋**，另外記延期後的新時間，
-- 這樣事後追查「原本訂在幾號、後來延到幾號」才看得出。
--
--   cancelled_at    ：取消時間（null＝未取消）
--   cancel_reason   ：取消原因（給大家看的那句）
--   postponed_date  ：延期後的新日期（null＝未延期）
--   postponed_time  ：延期後的新時間（HH:MM，可留空沿用原本時間）
--   news            ：卡片與詳情要顯示的「最新消息」（臨時集合時間變更等）
--   news_updated_at ：最新消息更新時間（卡片顯示「x 分鐘前更新」）
--
-- 可重複執行：全部使用 if not exists。

alter table competitions add column if not exists cancelled_at timestamptz;
alter table competitions add column if not exists cancel_reason text;
alter table competitions add column if not exists postponed_date date;
alter table competitions add column if not exists postponed_time text;
alter table competitions add column if not exists news text;
alter table competitions add column if not exists news_updated_at timestamptz;

comment on column competitions.cancelled_at is '賽事取消時間（null＝未取消）';
comment on column competitions.cancel_reason is '取消原因（顯示在卡片與詳情）';
comment on column competitions.postponed_date is '延期後的新日期（原訂時間仍保留在 date／time）';
comment on column competitions.postponed_time is '延期後的新時間（HH:MM，可空）';
comment on column competitions.news is '最新消息（卡片與詳情直接顯示，不需要訂閱推播）';
comment on column competitions.news_updated_at is '最新消息更新時間';

-- 卡片列表要快速判斷「有沒有取消／延期／最新消息」，且未刪除的資料最常查
create index if not exists idx_competitions_notices
    on competitions (cancelled_at, postponed_date)
    where is_deleted = false;
