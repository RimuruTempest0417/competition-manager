-- v3.8.2：分享來源追蹤（哪張海報／哪種分享方式真的帶來人）＋候補遞補的站內標記
--
-- 1) registrations.source          ：這筆報名是從哪個分享來源進來的（poster／qr／link／text）
-- 2) registrations.promoted_at     ：候補遞補成立的時間（推播之外的站內依據：沒訂閱推播的人也看得見）
-- 3) share_visits（新表）           ：分享連結被打開的次數，一列一次
--    ★不用 jsonb 計數器：讀-改-寫在 serverless 多實例下會掉數字（v3.5.3 的教訓）
--
-- 全部可重複執行（add column if not exists／create table if not exists／create index if not exists）。

alter table registrations add column if not exists source text;
alter table registrations add column if not exists promoted_at timestamptz;

create table if not exists share_visits (
    id             bigserial primary key,
    competition_id bigint not null,
    source         text not null,
    created_at     timestamptz not null default now()
);

-- 後台查「各來源帶來幾次瀏覽」與清理舊資料都走這個索引
create index if not exists share_visits_comp_source_created_idx
    on share_visits (competition_id, source, created_at desc);

-- 各來源帶來幾筆報名：依賽事 + 來源統計
create index if not exists registrations_comp_source_idx
    on registrations (competition_id, source)
    where source is not null;
